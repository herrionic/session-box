import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AgentGateway } from "../src/agent/gateway.ts";
import { loadAuthConfig } from "../src/auth/config.ts";
import type { ServerConfig } from "../src/config.ts";
import { InMemoryCredentialStore } from "../src/credentials/store.ts";
import { ContainerFilesService } from "../src/files/service.ts";
import { buildApp } from "../src/http/app.ts";
import type { SessionBoxApp } from "../src/http/types.ts";
import { InMemoryContainerRepository } from "../src/container/repository.ts";
import { ContainerService } from "../src/container/service.ts";
import { SshSessionManager } from "../src/ssh/manager.ts";
import { FakeRuntime } from "./helpers/fake-runtime.ts";
import { FakeSshSessionFactory, type FakeShell } from "./helpers/fake-ssh.ts";
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

async function createFixture(options: { authClients?: string } = {}): Promise<{
  app: SessionBoxApp;
  port: number;
  containerId: string;
  shell: () => FakeShell | undefined;
}> {
  const runtime = new FakeRuntime();
  const logger = createTestLogger();
  const ssh = new FakeSshSessionFactory();
  const service = new ContainerService({
    runtime,
    repository: new InMemoryContainerRepository(),
    credentials: new InMemoryCredentialStore(Buffer.alloc(32, 7)),
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

  const config: ServerConfig = {
    ...testConfig,
    auth: loadAuthConfig(options.authClients),
  };
  const app = await buildApp({
    config,
    logger,
    runtime,
    service,
    files,
    gateway: new AgentGateway(service, logger),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });

  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const container = await service.create({});

  return { app, port, containerId: container.id, shell: () => ssh.session.shells[0] };
}

interface TestSocket {
  socket: WebSocket;
  next: () => Promise<Record<string, unknown>>;
}

/** Buffers incoming messages so no early message can be missed. */
function connect(url: string): Promise<TestSocket> {
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

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("terminal WebSocket", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      await cleanup?.();
    }
  });

  it("bridges input, output, resize and exit", async () => {
    const { app, port, containerId, shell } = await createFixture();
    cleanups.push(() => app.close());

    const client = await connect(
      `ws://127.0.0.1:${port}/api/ws/terminal/${containerId}?cols=120&rows=30`,
    );
    cleanups.push(async () => {
      client.socket.close();
    });

    expect(await client.next()).toEqual({ type: "ready", containerId });
    expect(shell()?.cols).toBe(120);
    expect(shell()?.rows).toBe(30);

    client.socket.send(JSON.stringify({ type: "input", data: "uname -a\n" }));
    await waitFor(() => (shell()?.writes.length ?? 0) === 1);
    expect(shell()?.writes[0]).toBe("uname -a\n");

    client.socket.send(JSON.stringify({ type: "resize", cols: 100, rows: 40 }));
    await waitFor(() => shell()?.cols === 100 && shell()?.rows === 40);

    shell()?.emit("Linux container\n");
    expect(await client.next()).toEqual({ type: "output", data: "Linux container\n" });

    shell()?.exit(0);
    expect(await client.next()).toEqual({ type: "exit", code: 0 });

    await waitFor(() => shell()?.closed === true);
  });

  it("accepts the bearer token as a query parameter when auth is enabled", async () => {
    const { app, port, containerId } = await createFixture({
      authClients: JSON.stringify([{ id: "ui", token: "ui-token", permissions: ["*"] }]),
    });
    cleanups.push(() => app.close());

    const client = await connect(
      `ws://127.0.0.1:${port}/api/ws/terminal/${containerId}?token=ui-token&cols=90&rows=20`,
    );
    cleanups.push(async () => {
      client.socket.close();
    });

    expect(await client.next()).toEqual({ type: "ready", containerId });
  });

  it("reports unknown containers with a stable error", async () => {
    const { app, port } = await createFixture();
    cleanups.push(() => app.close());

    const client = await connect(`ws://127.0.0.1:${port}/api/ws/terminal/ctr_missing`);
    cleanups.push(async () => {
      client.socket.close();
    });

    const message = await client.next();
    expect(message.type).toBe("error");
    expect(message.code).toBe("CONTAINER_NOT_FOUND");
  });

  it("rejects malformed client messages", async () => {
    const { app, port, containerId } = await createFixture();
    cleanups.push(() => app.close());

    const client = await connect(`ws://127.0.0.1:${port}/api/ws/terminal/${containerId}`);
    cleanups.push(async () => {
      client.socket.close();
    });

    await client.next(); // ready
    client.socket.send("not json at all");

    expect(await client.next()).toEqual({
      type: "error",
      code: "INVALID_REQUEST",
      message: "malformed terminal message",
    });
  });
});
