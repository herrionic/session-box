import { afterEach, describe, expect, it } from "vitest";
import { SessionBoxClient } from "@sessionbox/client";
import WebSocket from "ws";
import { AgentGateway } from "../src/agent/gateway.ts";
import type { ServerConfig } from "../src/config.ts";
import { InMemoryCredentialStore } from "../src/credentials/store.ts";
import { ContainerFilesService } from "../src/files/service.ts";
import { buildApp } from "../src/http/app.ts";
import type { SessionBoxApp } from "../src/http/types.ts";
import { InMemoryContainerRepository } from "../src/container/repository.ts";
import { ContainerService } from "../src/container/service.ts";
import { SshSessionManager } from "../src/ssh/manager.ts";
import { FakeRuntime } from "./helpers/fake-runtime.ts";
import { FakeSshSessionFactory } from "./helpers/fake-ssh.ts";
import { createTestLogger } from "./helpers/test-logger.ts";

const testConfig: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  runtime: "docker",
  logLevel: "silent",
  dataDir: "./data",
  docker: {
    socketPath: "/var/run/docker.sock",
    networkName: "sessionbox",
    baseImage: "sessionbox/base:test",
    workspace: "/workspace",
  },
  databaseFile: ":memory:",
  auth: { clients: [] },
  lifecycle: { intervalMs: 1000 },
};

interface Fixture {
  app: SessionBoxApp;
  client: SessionBoxClient;
  port: number;
  ssh: FakeSshSessionFactory;
}

async function createFixture(): Promise<Fixture> {
  const runtime = new FakeRuntime();
  const logger = createTestLogger();
  const ssh = new FakeSshSessionFactory({ perContainer: true });
  const service = new ContainerService({
    runtime,
    repository: new InMemoryContainerRepository(),
    credentials: new InMemoryCredentialStore(Buffer.alloc(32, 11)),
    ssh,
    sessions: new SshSessionManager(ssh, logger),
    logger,
    baseImage: testConfig.docker.baseImage,
    workspace: testConfig.docker.workspace,
    sshReadyTimeoutMs: 50,
    sshRetryIntervalMs: 1,
    sleep: async () => {},
  });
  const files = new ContainerFilesService({
    containers: service,
    logger,
  });
  const gateway = new AgentGateway(service, logger);

  const app = await buildApp({ config: testConfig, logger, runtime, service, files, gateway });
  await app.listen({ host: "127.0.0.1", port: 0 });

  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    app,
    client: new SessionBoxClient({ baseUrl: `http://127.0.0.1:${port}` }),
    port,
    ssh,
  };
}

interface RawClient {
  socket: WebSocket;
  next: () => Promise<Record<string, unknown>>;
}

/** Raw agent connection for protocol-level tests (buffers early messages). */
function rawConnect(url: string): Promise<RawClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const queue: Record<string, unknown>[] = [];
    const waiters: Array<(value: Record<string, unknown>) => void> = [];

    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(message);
      else queue.push(message);
    });

    socket.once("open", () => {
      resolve({
        socket,
        next: () =>
          new Promise((resolveNext) => {
            const queued = queue.shift();
            if (queued !== undefined) resolveNext(queued);
            else waiters.push(resolveNext);
          }),
      });
    });
    socket.once("error", reject);
  });
}

/** Polls until the predicate holds (fake sessions settle on later ticks). */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("agent protocol (simulated harness sessions)", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      await cleanup?.();
    }
  });

  it("keeps two simulated sessions isolated and survives disconnects", async () => {
    const { app, client, ssh } = await createFixture();
    cleanups.push(() => app.close());

    const sessionA = await client.createContainer({ name: "session-a" });
    const sessionB = await client.createContainer({ name: "session-b" });

    const runtimeA = await client.connect(sessionA.id);
    const runtimeB = await client.connect(sessionB.id);

    await runtimeA.writeFile("/workspace/who.txt", "AAA");
    expect((await runtimeA.readFile("/workspace/who.txt")).content).toBe("AAA");

    // Session B must not see session A's workspace.
    await expect(runtimeB.readFile("/workspace/who.txt")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    // The fake SSH session scripts command results; this exercises the exec plumbing.
    ssh.sessionFor(sessionA.id).execResults.push({ exitCode: 0, stdout: "AAA\n", stderr: "" });
    const exec = await runtimeA.exec("cat /workspace/who.txt");
    expect(exec.exitCode).toBe(0);
    expect(exec.stdout).toBe("AAA\n");

    await runtimeA.close();
    await runtimeB.close();

    // A disconnect is temporary access ending, not container ownership (PROJECT 搂39).
    expect((await client.getContainer(sessionA.id)).status).toBe("running");
    expect((await client.getContainer(sessionB.id)).status).toBe("running");
  });

  it("reconnects a session to the same container and workspace", async () => {
    const { app, client } = await createFixture();
    cleanups.push(() => app.close());

    const container = await client.createContainer({ name: "session-c" });

    const first = await client.connect(container.id);
    await first.writeFile("/workspace/keep.txt", "persisted");
    await first.close();

    const second = await client.connect(container.id);
    expect((await second.readFile("/workspace/keep.txt")).content).toBe("persisted");
    await second.close();
  });

  it("supports the full file primitive set", async () => {
    const { app, client } = await createFixture();
    cleanups.push(() => app.close());

    const container = await client.createContainer({});
    const runtime = await client.connect(container.id);

    await runtime.mkdir("/workspace/deep/nested", { recursive: true });
    await runtime.writeFile("/workspace/deep/nested/file.txt", "hello");
    const entry = await runtime.statFile("/workspace/deep/nested/file.txt");
    expect(entry).toMatchObject({ type: "file", size: 5 });

    const listing = await runtime.listFiles("/workspace/deep/nested");
    expect(listing.entries.map((value) => value.name)).toEqual(["file.txt"]);

    await runtime.remove("/workspace/deep", { recursive: true });
    await expect(runtime.statFile("/workspace/deep")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    await runtime.close();
  });

  it("rejects relative paths and unknown containers", async () => {
    const { app, client } = await createFixture();
    cleanups.push(() => app.close());

    const container = await client.createContainer({});
    const runtime = await client.connect(container.id);

    await expect(runtime.readFile("relative.txt")).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(runtime.exec("pwd", { cwd: "relative" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });

    const missing = await client.connect("ctr_missing");
    await expect(missing.exec("true")).rejects.toMatchObject({ code: "CONTAINER_NOT_FOUND" });

    await runtime.close();
    await missing.close();
  });

  it("requires a running container", async () => {
    const { app, client } = await createFixture();
    cleanups.push(() => app.close());

    const container = await client.createContainer({});
    await client.stopContainer(container.id);

    const runtime = await client.connect(container.id);
    await expect(runtime.exec("true")).rejects.toMatchObject({ code: "CONTAINER_NOT_RUNNING" });
    await runtime.close();
  });

  it("rejects unsupported protocol versions", async () => {
    const { app, port } = await createFixture();
    cleanups.push(() => app.close());

    const raw = await rawConnect(`ws://127.0.0.1:${port}/api/ws/agent`);
    cleanups.push(async () => {
      raw.socket.close();
    });

    raw.socket.send(JSON.stringify({ type: "hello", protocolVersion: 99 }));

    const message = await raw.next();
    expect(message.type).toBe("error");
    expect(message.code).toBe("INVALID_REQUEST");
    expect(String(message.message)).toContain("unsupported protocol version");
  });

  it("rejects malformed messages after the handshake", async () => {
    const { app, port } = await createFixture();
    cleanups.push(() => app.close());

    const raw = await rawConnect(`ws://127.0.0.1:${port}/api/ws/agent`);
    cleanups.push(async () => {
      raw.socket.close();
    });

    raw.socket.send(JSON.stringify({ type: "hello", protocolVersion: 2 }));
    expect(await raw.next()).toMatchObject({ type: "welcome", protocolVersion: 2 });

    raw.socket.send("not json");
    expect(await raw.next()).toMatchObject({ type: "error", code: "INVALID_REQUEST" });

    raw.socket.send(JSON.stringify({ type: "exec", requestId: "r1", containerId: "ctr_x" }));
    const malformed = await raw.next();
    expect(malformed).toMatchObject({ type: "error", code: "INVALID_REQUEST", requestId: "r1" });
  });

  it("rejects binary content in file.read and serves it via file.readBytes", async () => {
    const { app, client, ssh } = await createFixture();
    cleanups.push(() => app.close());

    const container = await client.createContainer({});
    const runtime = await client.connect(container.id);
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x80]);
    ssh.sessionFor(container.id).ensureFile("/workspace/blob.bin", bytes);

    await expect(runtime.readFile("/workspace/blob.bin")).rejects.toMatchObject({
      code: "FS_NOT_TEXT",
    });

    const file = await runtime.readBytes("/workspace/blob.bin");
    expect(Buffer.from(file.contentBase64, "base64").equals(bytes)).toBe(true);
    expect(file.size).toBe(bytes.length);

    await runtime.close();
  });

  it("cancels an in-flight exec and answers both requests", async () => {
    const { app, client, ssh } = await createFixture();
    cleanups.push(() => app.close());

    const container = await client.createContainer({});
    const runtime = await client.connect(container.id);
    const fake = ssh.sessionFor(container.id);
    fake.holdExecs = true;

    const controller = new AbortController();
    const pending = runtime.exec("sleep 999", { signal: controller.signal });
    await waitFor(() => fake.pendingExecs.length === 1);

    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
    expect(fake.pendingExecs[0]?.options?.signal?.aborted).toBe(true);

    await runtime.close();
  });

  it("rejects exec.cancel for unknown or finished requests", async () => {
    const { app, client, port } = await createFixture();
    cleanups.push(() => app.close());

    const container = await client.createContainer({});
    const raw = await rawConnect(`ws://127.0.0.1:${port}/api/ws/agent`);
    cleanups.push(async () => {
      raw.socket.close();
    });

    raw.socket.send(JSON.stringify({ type: "hello", protocolVersion: 2 }));
    expect(await raw.next()).toMatchObject({ type: "welcome" });

    raw.socket.send(
      JSON.stringify({
        type: "exec.cancel",
        requestId: "c1",
        containerId: container.id,
        targetRequestId: "missing",
      }),
    );
    expect(await raw.next()).toMatchObject({
      type: "error",
      code: "INVALID_REQUEST",
      requestId: "c1",
    });

    raw.socket.send(
      JSON.stringify({ type: "exec", requestId: "e1", containerId: container.id, command: "true" }),
    );
    expect(await raw.next()).toMatchObject({ type: "exec.result", requestId: "e1" });

    raw.socket.send(
      JSON.stringify({
        type: "exec.cancel",
        requestId: "c2",
        containerId: container.id,
        targetRequestId: "e1",
      }),
    );
    expect(await raw.next()).toMatchObject({
      type: "error",
      code: "INVALID_REQUEST",
      requestId: "c2",
    });
  });

  it("answers every concurrent request exactly once", async () => {
    const { app, client, port } = await createFixture();
    cleanups.push(() => app.close());

    const container = await client.createContainer({});
    const raw = await rawConnect(`ws://127.0.0.1:${port}/api/ws/agent`);
    cleanups.push(async () => {
      raw.socket.close();
    });

    raw.socket.send(JSON.stringify({ type: "hello", protocolVersion: 2 }));
    expect(await raw.next()).toMatchObject({ type: "welcome" });

    const total = 200;
    for (let index = 0; index < total; index += 1) {
      raw.socket.send(
        JSON.stringify({
          type: "file.stat",
          requestId: `r${index}`,
          containerId: container.id,
          path: "/workspace",
        }),
      );
    }

    const answered = new Set<string>();
    for (let index = 0; index < total; index += 1) {
      const message = await raw.next();
      expect(message.type).toBe("file.stat.result");
      answered.add(String(message.requestId));
    }
    expect(answered.size).toBe(total);
  });

  it("answers OPERATION_TIMEOUT when an exec exceeds its deadline", async () => {
    const { app, client, ssh } = await createFixture();
    cleanups.push(() => app.close());

    const container = await client.createContainer({});
    const runtime = await client.connect(container.id);
    const fake = ssh.sessionFor(container.id);
    fake.holdExecs = true;

    await expect(runtime.exec("sleep 999", { timeoutMs: 50 })).rejects.toMatchObject({
      code: "OPERATION_TIMEOUT",
    });
    expect(fake.pendingExecs[0]?.options?.signal?.aborted).toBe(true);

    await runtime.close();
  });

  it("tracks file versions and rejects stale writes", async () => {
    const { app, client } = await createFixture();
    cleanups.push(() => app.close());

    const container = await client.createContainer({});
    const runtime = await client.connect(container.id);

    const first = await runtime.writeFile("/workspace/a.txt", "one");
    const read = await runtime.readFile("/workspace/a.txt");
    expect(read.version).toBe(first.version);

    const second = await runtime.writeFile("/workspace/a.txt", "two");
    expect(second.version).not.toBe(first.version);

    await expect(
      runtime.writeFile("/workspace/a.txt", "three", { expected: { version: first.version } }),
    ).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      details: { current: second.version },
    });

    const third = await runtime.writeFile("/workspace/a.txt", "three", {
      expected: { version: second.version },
    });
    expect(third.version).not.toBe(second.version);

    await runtime.close();
  });

  it("reports one consistent version from read, list and stat", async () => {
    const { app, client } = await createFixture();
    cleanups.push(() => app.close());

    const container = await client.createContainer({});
    const runtime = await client.connect(container.id);

    const written = await runtime.writeFile("/workspace/consistent.txt", "same bytes");
    const read = await runtime.readFile("/workspace/consistent.txt");
    const stat = await runtime.statFile("/workspace/consistent.txt");
    const listing = await runtime.listFiles("/workspace");
    const listed = listing.entries.find((entry) => entry.name === "consistent.txt");

    expect(read.version).toBe(written.version);
    expect(stat.version).toBe(written.version);
    expect(listed?.version).toBe(written.version);

    await runtime.close();
  });

  it("lists and stats entries whose content cannot be read", async () => {
    const { app, client, ssh } = await createFixture();
    cleanups.push(() => app.close());

    const container = await client.createContainer({});
    const runtime = await client.connect(container.id);
    const fake = ssh.sessionFor(container.id);
    fake.ensureFile("/workspace/root-owned.conf", "secret");
    fake.failReadsFor.add("/workspace/root-owned.conf");

    // Listing and stat are metadata-only: an unreadable file never blocks them.
    const listing = await runtime.listFiles("/workspace");
    const listed = listing.entries.find((entry) => entry.name === "root-owned.conf");
    expect(listed).toMatchObject({ type: "file", size: 6 });
    expect(listed?.version).toBeTruthy();

    const stat = await runtime.statFile("/workspace/root-owned.conf");
    expect(stat).toMatchObject({ type: "file", size: 6 });
    expect(stat.version).toBe(listed?.version);

    // Reading the content still fails with the typed permission error.
    await expect(runtime.readFile("/workspace/root-owned.conf")).rejects.toMatchObject({
      code: "FS_PERMISSION_DENIED",
    });

    await runtime.close();
  });

  it("supports lstat semantics and symlink targets", async () => {
    const { app, client, ssh } = await createFixture();
    cleanups.push(() => app.close());

    const container = await client.createContainer({});
    const runtime = await client.connect(container.id);
    const fake = ssh.sessionFor(container.id);
    fake.ensureFile("/workspace/real.txt", "data");
    fake.ensureSymlink("/workspace/link.txt", "/workspace/real.txt");
    fake.ensureSymlink("/workspace/dangling", "/workspace/missing");

    const followed = await runtime.statFile("/workspace/link.txt");
    expect(followed.type).toBe("file");

    const link = await runtime.statFile("/workspace/link.txt", { follow: false });
    expect(link.type).toBe("symlink");
    expect(link.linkTarget).toBe("/workspace/real.txt");

    // A dangling symlink fails when followed but is visible without following.
    await expect(runtime.statFile("/workspace/dangling")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await runtime.statFile("/workspace/dangling", { follow: false })).type).toBe("symlink");

    await runtime.close();
  });

  it("reads byte ranges and reports offsets", async () => {
    const { app, client, ssh } = await createFixture();
    cleanups.push(() => app.close());

    const container = await client.createContainer({});
    const runtime = await client.connect(container.id);
    ssh.sessionFor(container.id).ensureFile("/workspace/big.txt", "abcdefghij");

    const full = await runtime.readFile("/workspace/big.txt");
    expect(full).toMatchObject({ offset: 0, length: 10, eof: true, content: "abcdefghij" });

    const part = await runtime.readFile("/workspace/big.txt", { offset: 2, length: 4 });
    expect(part).toMatchObject({
      offset: 2,
      length: 4,
      eof: false,
      content: "cdef",
      size: 10,
    });

    const tail = await runtime.readFile("/workspace/big.txt", { offset: 8 });
    expect(tail).toMatchObject({ offset: 8, length: 2, eof: true, content: "ij" });

    const beyond = await runtime.readFile("/workspace/big.txt", { offset: 20 });
    expect(beyond).toMatchObject({ offset: 20, length: 0, eof: true, content: "" });

    await runtime.close();
  });

  it("classifies filesystem failures with typed codes", async () => {
    const { app, client, ssh } = await createFixture();
    cleanups.push(() => app.close());

    const container = await client.createContainer({});
    const runtime = await client.connect(container.id);
    const fake = ssh.sessionFor(container.id);
    fake.ensureDirectory("/workspace/dir");
    fake.ensureFile("/workspace/huge.bin", Buffer.alloc(8 * 1024 * 1024 + 1, 65));

    await expect(runtime.readFile("/workspace/dir")).rejects.toMatchObject({
      code: "FS_IS_DIRECTORY",
    });
    await expect(runtime.readFile("/workspace/missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(runtime.readFile("/workspace/huge.bin")).rejects.toMatchObject({
      code: "FS_TOO_LARGE",
    });
    await expect(runtime.readBytes("/workspace/huge.bin")).rejects.toMatchObject({
      code: "FS_TOO_LARGE",
    });

    fake.ensureFile("/workspace/small.bin", "0123456789");
    await expect(
      runtime.readBytes("/workspace/small.bin", { maxBytes: 5 }),
    ).rejects.toMatchObject({ code: "FS_TOO_LARGE" });
    expect((await runtime.readBytes("/workspace/small.bin", { maxBytes: 20 })).size).toBe(10);

    await runtime.close();
  });

  it("streams exec output as preview frames and keeps the full result", async () => {
    const { app, client, ssh } = await createFixture();
    cleanups.push(() => app.close());

    const container = await client.createContainer({});
    const runtime = await client.connect(container.id);
    ssh.sessionFor(container.id).execResults.push({
      exitCode: 0,
      stdout: "hello\n",
      stderr: "warn\n",
    });

    const chunks: Array<{ stream: string; data: string }> = [];
    const result = await runtime.exec("echo hello", { onOutput: (event) => chunks.push(event) });

    expect(chunks).toEqual([
      { stream: "stdout", data: "hello\n" },
      { stream: "stderr", data: "warn\n" },
    ]);
    expect(result).toMatchObject({ exitCode: 0, stdout: "hello\n", stderr: "warn\n" });

    await runtime.close();
  });

  it("opens a PTY and exchanges input/output over the agent connection", async () => {
    const { app, client, ssh } = await createFixture();
    cleanups.push(() => app.close());

    const container = await client.createContainer({});
    const runtime = await client.connect(container.id);
    const fake = ssh.sessionFor(container.id);

    const output: string[] = [];
    let exited: number | null | undefined;
    const terminal = await runtime.openTerminal({
      cols: 100,
      rows: 30,
      onOutput: (data) => output.push(data),
      onExit: (code) => {
        exited = code;
      },
    });
    expect(terminal.id).toMatch(/^term_/);
    expect(fake.shells).toHaveLength(1);
    expect(fake.shells[0]?.cols).toBe(100);

    terminal.write("echo hi\r");
    terminal.resize(120, 40);
    await waitFor(() => fake.shells[0]?.writes.length === 1);
    expect(fake.shells[0]?.writes).toEqual(["echo hi\r"]);
    expect(fake.shells[0]?.cols).toBe(120);

    fake.shells[0]?.emit("hi\r\n");
    await waitFor(() => output.length === 1);
    expect(output).toEqual(["hi\r\n"]);

    fake.shells[0]?.exit(0);
    await waitFor(() => exited !== undefined);
    expect(exited).toBe(0);

    // Explicit close is one-way: the shell is closed and no exit event follows.
    const second = await runtime.openTerminal({});
    second.close();
    await waitFor(() => fake.shells[1]?.closed === true);
    expect(fake.shells[1]?.closed).toBe(true);

    await runtime.close();
  });

  it("renames, chmods and creates symlinks", async () => {
    const { app, client, ssh } = await createFixture();
    cleanups.push(() => app.close());

    const container = await client.createContainer({});
    const runtime = await client.connect(container.id);
    const fake = ssh.sessionFor(container.id);

    await runtime.writeFile("/workspace/old.txt", "content");
    await runtime.rename("/workspace/old.txt", "/workspace/new.txt");
    await expect(runtime.statFile("/workspace/old.txt")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await runtime.readFile("/workspace/new.txt")).content).toBe("content");

    await runtime.chmod("/workspace/new.txt", 0o600);
    expect(fake.nodes.get("/workspace/new.txt")?.mode).toBe(0o600);

    await runtime.symlink("/workspace/link", "/workspace/new.txt");
    expect((await runtime.statFile("/workspace/link", { follow: false })).type).toBe("symlink");

    await expect(
      runtime.rename("/workspace/new.txt", "/workspace/link", { overwrite: false }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    await runtime.close();
  });
});
