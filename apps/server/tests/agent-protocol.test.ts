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
    workspace: testConfig.docker.workspace,
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

    // A disconnect is temporary access ending, not container ownership (PROJECT §39).
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
});
