import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentGateway } from "../src/agent/gateway.ts";
import { loadAuthConfig } from "../src/auth/config.ts";
import { authenticate, hasPermission, requirePermission } from "../src/auth/principals.ts";
import type { ServerConfig } from "../src/config.ts";
import { InMemoryCredentialStore } from "../src/credentials/store.ts";
import { SandboxFilesService } from "../src/files/service.ts";
import { buildApp } from "../src/http/app.ts";
import type { SessionBoxApp } from "../src/http/types.ts";
import { InMemorySandboxRepository } from "../src/sandbox/repository.ts";
import { SandboxService } from "../src/sandbox/service.ts";
import { SshSessionManager } from "../src/ssh/manager.ts";
import { FakeRuntime } from "./helpers/fake-runtime.ts";
import { FakeSshSessionFactory } from "./helpers/fake-ssh.ts";
import { createTestLogger } from "./helpers/test-logger.ts";

const authConfig = loadAuthConfig(
  JSON.stringify([
    { id: "dsh", token: "dsh-token", permissions: ["sandbox:read"] },
    { id: "admin", token: "admin-token", permissions: ["*"] },
  ]),
);

const testConfig: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  runtime: "docker",
  logLevel: "silent",
  dataDir: "./data",
  databaseFile: ":memory:",
  auth: authConfig,
  lifecycle: { intervalMs: 1000 },
  docker: {
    socketPath: "/var/run/docker.sock",
    networkName: "sessionbox",
    baseImage: "sessionbox/base:test",
    workspace: "/workspace",
  },
};

describe("auth config and principals", () => {
  it("resolves tokens to principals", () => {
    const principal = authenticate(authConfig, "dsh-token");
    expect(principal).toEqual({
      id: "dsh",
      type: "plugin",
      permissions: ["sandbox:read"],
    });
    expect(authenticate(authConfig, "nope")).toBeUndefined();
    expect(authenticate(authConfig, undefined)).toBeUndefined();
  });

  it("checks permissions including the wildcard", () => {
    const reader = authenticate(authConfig, "dsh-token");
    const admin = authenticate(authConfig, "admin-token");

    expect(reader && hasPermission(reader, "sandbox:read")).toBe(true);
    expect(reader && hasPermission(reader, "sandbox:delete")).toBe(false);
    expect(admin && hasPermission(admin, "sandbox:delete")).toBe(true);
    expect(() => requirePermission(undefined, "sandbox:read")).toThrow(/authentication/);
    expect(() => requirePermission(reader, "sandbox:delete")).toThrow(/permission/);
  });
});

describe("HTTP authentication", () => {
  let app: SessionBoxApp;

  beforeEach(async () => {
    const runtime = new FakeRuntime();
    const logger = createTestLogger();
    const ssh = new FakeSshSessionFactory();
    const service = new SandboxService({
      runtime,
      repository: new InMemorySandboxRepository(),
      credentials: new InMemoryCredentialStore(Buffer.alloc(32, 19)),
      ssh,
      sessions: new SshSessionManager(ssh, logger),
      logger,
      baseImage: testConfig.docker.baseImage,
      workspace: testConfig.docker.workspace,
      sshReadyTimeoutMs: 50,
      sshRetryIntervalMs: 1,
      sleep: async () => {},
    });
    const files = new SandboxFilesService({
      sandboxes: service,
      workspace: testConfig.docker.workspace,
      logger,
    });
    const gateway = new AgentGateway(service, logger);

    app = await buildApp({ config: testConfig, logger, runtime, service, files, gateway });
  });

  afterEach(async () => {
    await app.close();
  });

  it("rejects requests without a token", async () => {
    const response = await app.inject({ method: "GET", url: "/api/sandboxes" });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("rejects unknown tokens", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/sandboxes",
      headers: { authorization: "Bearer wrong" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("accepts a valid bearer token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/sandboxes",
      headers: { authorization: "Bearer dsh-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("accepts a token in the query string for WebSocket-style clients", async () => {
    const response = await app.inject({ method: "GET", url: "/api/sandboxes?token=dsh-token" });

    expect(response.statusCode).toBe(200);
  });

  it("strips the query token before strict route schemas run", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/sandboxes/sbx_missing/files?path=%2Fworkspace&token=dsh-token",
    });

    // The sandbox does not exist → 404; a strict-schema failure would be 400.
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("SANDBOX_NOT_FOUND");
  });

  it("keeps the health probe open", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
  });

  it("enforces permissions", async () => {
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/sandboxes",
      headers: { authorization: "Bearer dsh-token" },
      payload: {},
    });

    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("FORBIDDEN");

    const allowed = await app.inject({
      method: "POST",
      url: "/api/sandboxes",
      headers: { authorization: "Bearer admin-token" },
      payload: {},
    });
    expect(allowed.statusCode).toBe(201);
  });
});
