import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentGateway } from "../src/agent/gateway.ts";
import { AuthService } from "../src/auth/service.ts";
import type { ServerConfig } from "../src/config.ts";
import { InMemoryCredentialStore } from "../src/credentials/store.ts";
import { ContainerFilesService } from "../src/files/service.ts";
import { buildApp } from "../src/http/app.ts";
import type { SessionBoxApp } from "../src/http/types.ts";
import { InMemoryContainerRepository } from "../src/container/repository.ts";
import { ContainerService } from "../src/container/service.ts";
import { SshSessionManager } from "../src/ssh/manager.ts";
import { openDatabase } from "../src/storage/database.ts";
import {
  SqliteApiTokenRepository,
  SqliteSessionRepository,
  SqliteUserRepository,
} from "../src/storage/user-repository.ts";
import { FakeRuntime } from "./helpers/fake-runtime.ts";
import { FakeSshSessionFactory } from "./helpers/fake-ssh.ts";
import { createTestLogger } from "./helpers/test-logger.ts";

const testConfig: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  runtime: "docker",
  logLevel: "silent",
  dataDir: "./data",
  databaseFile: ":memory:",
  auth: { clients: [] },
  lifecycle: { intervalMs: 1000 },
  docker: {
    socketPath: "/var/run/docker.sock",
    networkName: "sessionbox",
    baseImage: "sessionbox/base:test",
    workspace: "/workspace",
  },
};

describe("first-run setup wizard", () => {
  let app: SessionBoxApp;
  let database: DatabaseSync;

  beforeEach(async () => {
    const runtime = new FakeRuntime();
    const logger = createTestLogger();
    const ssh = new FakeSshSessionFactory();
    database = openDatabase(":memory:");

    // Fresh instance: the auth service is wired but has no owner yet.
    const auth = new AuthService({
      users: new SqliteUserRepository(database),
      sessions: new SqliteSessionRepository(database),
      tokens: new SqliteApiTokenRepository(database),
      logger,
    });

    const service = new ContainerService({
      runtime,
      repository: new InMemoryContainerRepository(),
      credentials: new InMemoryCredentialStore(Buffer.alloc(32, 51)),
      ssh,
      sessions: new SshSessionManager(ssh, logger),
      logger,
      baseImage: testConfig.docker.baseImage,
      workspace: testConfig.docker.workspace,
      privateNetworkCleanupDelayMs: 0,
      sshReadyTimeoutMs: 50,
      sshRetryIntervalMs: 1,
      sleep: async () => {},
    });
    const files = new ContainerFilesService({
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
      auth,
    });
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  it("reports needsSetup and keeps the API locked", async () => {
    const status = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ needsSetup: true });

    const locked = await app.inject({ method: "GET", url: "/api/containers" });
    expect(locked.statusCode).toBe(401);
  });

  it("creates the owner, signs in and closes the wizard", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { username: "owner", displayName: "Herry", password: "battery-staple" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().user).toMatchObject({ username: "owner", displayName: "Herry" });

    const cookie = String(created.headers["set-cookie"]).split(";")[0] ?? "";
    expect(cookie).toContain("sessionbox_session=");

    const status = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(status.json()).toEqual({ needsSetup: false });

    const authorized = await app.inject({
      method: "GET",
      url: "/api/containers",
      headers: { cookie },
    });
    expect(authorized.statusCode).toBe(200);
  });

  it("refuses to run setup twice", async () => {
    await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { username: "owner", password: "battery-staple" },
    });

    const again = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { username: "other", password: "battery-staple" },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("INVALID_STATE");
  });

  it("validates the setup payload", async () => {
    const short = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { username: "x", password: "short" },
    });
    expect(short.statusCode).toBe(400);
  });
});
