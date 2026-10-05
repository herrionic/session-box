import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("file manager HTTP API", () => {
  let app: SessionBoxApp;
  let containerId: string;

  beforeEach(async () => {
    const runtime = new FakeRuntime();
    const logger = createTestLogger();
    const ssh = new FakeSshSessionFactory();
    const service = new ContainerService({
      runtime,
      repository: new InMemoryContainerRepository(),
      credentials: new InMemoryCredentialStore(Buffer.alloc(32, 5)),
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

    app = await buildApp({
      config: testConfig,
      logger,
      runtime,
      service,
      files,
      gateway: new AgentGateway(service, logger),
    });

    const created = await app.inject({ method: "POST", url: "/api/containers", payload: {} });
    containerId = (created.json() as { id: string }).id;
  });

  afterEach(async () => {
    await app.close();
  });

  it("runs the full file manager lifecycle", async () => {
    const mkdir = await app.inject({
      method: "POST",
      url: `/api/containers/${containerId}/files`,
      payload: { path: "/workspace/docs", type: "directory" },
    });
    expect(mkdir.statusCode).toBe(201);
    expect(mkdir.json()).toMatchObject({ type: "directory", path: "/workspace/docs" });

    const write = await app.inject({
      method: "PUT",
      url: `/api/containers/${containerId}/files/content`,
      payload: { path: "/workspace/docs/a.txt", content: "hello world" },
    });
    expect(write.statusCode).toBe(200);
    expect(write.json()).toMatchObject({ content: "hello world", size: 11 });

    const read = await app.inject({
      method: "GET",
      url: `/api/containers/${containerId}/files/content?path=/workspace/docs/a.txt`,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().content).toBe("hello world");

    const list = await app.inject({
      method: "GET",
      url: `/api/containers/${containerId}/files?path=/workspace/docs`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().entries).toHaveLength(1);

    const download = await app.inject({
      method: "GET",
      url: `/api/containers/${containerId}/files/download?path=/workspace/docs/a.txt`,
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("hello world");
    expect(download.headers["content-disposition"]).toContain("a.txt");

    const upload = await app.inject({
      method: "POST",
      url: `/api/containers/${containerId}/files/upload?path=/workspace/docs/b.bin`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from([1, 2, 3, 4]),
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json()).toMatchObject({ size: 4 });

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/containers/${containerId}/files?path=/workspace/docs&recursive=true`,
    });
    expect(remove.statusCode).toBe(204);

    const after = await app.inject({
      method: "GET",
      url: `/api/containers/${containerId}/files?path=/workspace`,
    });
    expect(after.json().entries).toEqual([]);
  });

  it("rejects traversal attempts", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/containers/${containerId}/files?path=/etc`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("rejects uploads without an octet-stream body", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/containers/${containerId}/files/upload?path=/workspace/x.bin`,
      payload: { not: "binary" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("requires a running container", async () => {
    await app.inject({ method: "POST", url: `/api/containers/${containerId}/stop` });

    const response = await app.inject({
      method: "GET",
      url: `/api/containers/${containerId}/files?path=/workspace`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONTAINER_NOT_RUNNING");
  });
});
