import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("HTTP API", () => {
  let app: SessionBoxApp;
  let runtime: FakeRuntime;
  let files: ContainerFilesService;

  beforeEach(async () => {
    runtime = new FakeRuntime();
    const logger = createTestLogger();
    const ssh = new FakeSshSessionFactory();
    const service = new ContainerService({
      runtime,
      repository: new InMemoryContainerRepository(),
      credentials: new InMemoryCredentialStore(Buffer.alloc(32, 1)),
      ssh,
      sessions: new SshSessionManager(ssh, logger),
      logger,
      baseImage: testConfig.docker.baseImage,
      workspace: testConfig.docker.workspace,
      sshReadyTimeoutMs: 50,
      sshRetryIntervalMs: 1,
      sleep: async () => {},
    });
    files = new ContainerFilesService({
      containers: service,
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
  });

  afterEach(async () => {
    await app.close();
  });

  it("reports health", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      runtime: "fake",
    });
  });

  it("runs the full container lifecycle over HTTP", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/containers",
      payload: { name: "demo", resources: { memoryLimitMb: 512 } },
    });
    expect(created.statusCode).toBe(201);

    const container = created.json() as { id: string; status: string };
    expect(container.status).toBe("running");

    const list = await app.inject({ method: "GET", url: "/api/containers" });
    expect(list.json()).toHaveLength(1);

    const fetched = await app.inject({ method: "GET", url: `/api/containers/${container.id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).not.toHaveProperty("runtimeRef");

    const stopped = await app.inject({
      method: "POST",
      url: `/api/containers/${container.id}/stop`,
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ status: "stopped" });

    const started = await app.inject({
      method: "POST",
      url: `/api/containers/${container.id}/start`,
    });
    expect(started.json()).toMatchObject({ status: "running" });

    const restarted = await app.inject({
      method: "POST",
      url: `/api/containers/${container.id}/restart`,
    });
    expect(restarted.json()).toMatchObject({ status: "running" });

    const logs = await app.inject({ method: "GET", url: `/api/containers/${container.id}/logs` });
    expect(logs.json()).toEqual({ logs: "fake logs" });

    const removed = await app.inject({ method: "DELETE", url: `/api/containers/${container.id}` });
    expect(removed.statusCode).toBe(204);

    const empty = await app.inject({ method: "GET", url: "/api/containers" });
    expect(empty.json()).toHaveLength(0);
  });

  it("patches container settings", async () => {
    const created = await app.inject({ method: "POST", url: "/api/containers", payload: {} });
    const container = created.json() as { id: string };

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/containers/${container.id}/settings`,
      payload: { name: "renamed", lifecycle: { autoStop: true, idleTimeoutSeconds: 300 } },
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      name: "renamed",
      lifecycle: { autoStop: true, idleTimeoutSeconds: 300 },
    });
  });

  it("rejects invalid bodies with a stable error code", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/containers",
      payload: { unknownField: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("maps malformed JSON to INVALID_REQUEST instead of an internal error", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/containers",
      headers: { "content-type": "application/json" },
      payload: "{ not json",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("rejects invalid state transitions", async () => {
    const created = await app.inject({ method: "POST", url: "/api/containers", payload: {} });
    const container = created.json() as { id: string };

    const response = await app.inject({
      method: "POST",
      url: `/api/containers/${container.id}/start`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("INVALID_STATE");
  });

  it("returns CONTAINER_NOT_FOUND for unknown containers", async () => {
    const response = await app.inject({ method: "GET", url: "/api/containers/ctr_missing" });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("CONTAINER_NOT_FOUND");
  });

  it("returns a stable error for unknown routes", async () => {
    const response = await app.inject({ method: "GET", url: "/api/nope" });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });
});

describe("HTTP API with static web assets", () => {
  let app: SessionBoxApp;
  let webDir: string;

  beforeEach(async () => {
    webDir = mkdtempSync(join(tmpdir(), "sessionbox-web-"));
    writeFileSync(join(webDir, "index.html"), "<!doctype html><title>SessionBox</title>");

    const runtime = new FakeRuntime();
    const logger = createTestLogger();
    const ssh = new FakeSshSessionFactory();
    const service = new ContainerService({
      runtime,
      repository: new InMemoryContainerRepository(),
      credentials: new InMemoryCredentialStore(Buffer.alloc(32, 1)),
      ssh,
      sessions: new SshSessionManager(ssh, logger),
      logger,
      baseImage: testConfig.docker.baseImage,
      workspace: testConfig.docker.workspace,
      sshReadyTimeoutMs: 50,
      sshRetryIntervalMs: 1,
      sleep: async () => {},
    });

    app = await buildApp({
      config: { ...testConfig, webDist: webDir },
      logger,
      runtime,
      service,
      files: new ContainerFilesService({
        containers: service,
        logger,
      }),
      gateway: new AgentGateway(service, logger),
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(webDir, { recursive: true, force: true });
  });

  it("serves the SPA and keeps the custom error envelope", async () => {
    const spa = await app.inject({ method: "GET", url: "/some/client/route" });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain("SessionBox");

    const missing = await app.inject({ method: "GET", url: "/api/containers/ctr_missing" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("CONTAINER_NOT_FOUND");

    const malformed = await app.inject({
      method: "POST",
      url: "/api/containers",
      headers: { "content-type": "application/json" },
      payload: "{ not json",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe("INVALID_REQUEST");
  });
});
