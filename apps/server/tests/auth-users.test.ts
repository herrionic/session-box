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

describe("single-owner user system", () => {
  let app: SessionBoxApp;
  let database: DatabaseSync;

  beforeEach(async () => {
    const runtime = new FakeRuntime();
    const logger = createTestLogger();
    const ssh = new FakeSshSessionFactory();
    database = openDatabase(":memory:");

    const auth = new AuthService({
      users: new SqliteUserRepository(database),
      sessions: new SqliteSessionRepository(database),
      tokens: new SqliteApiTokenRepository(database),
      logger,
    });
    await auth.ensureOwner("admin", "correct-horse");

    const service = new ContainerService({
      runtime,
      repository: new InMemoryContainerRepository(),
      credentials: new InMemoryCredentialStore(Buffer.alloc(32, 31)),
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

  async function login(password = "correct-horse", username = "admin"): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username, password },
    });
    expect(response.statusCode).toBe(200);
    const cookie = String(response.headers["set-cookie"]);
    expect(cookie).toContain("sessionbox_session=");
    return cookie.split(";")[0] ?? "";
  }

  it("enforces authentication once the owner exists", async () => {
    const response = await app.inject({ method: "GET", url: "/api/containers" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("serves non-API paths without a session (only the API is authenticated)", async () => {
    const response = await app.inject({ method: "GET", url: "/" });
    // No static build is configured in tests: the route is absent, not unauthorized.
    expect(response.statusCode).toBe(404);
  });

  it("logs in, reads the profile and updates the display name", async () => {
    const cookie = await login();

    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ username: "admin", displayName: "admin" });

    const renamed = await app.inject({
      method: "PATCH",
      url: "/api/auth/me",
      headers: { cookie },
      payload: { displayName: "Herry" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().user.displayName).toBe("Herry");
  });

  it("changes the login username and keeps the session valid", async () => {
    const cookie = await login();

    const renamed = await app.inject({
      method: "PATCH",
      url: "/api/auth/me",
      headers: { cookie },
      payload: { username: "  owner  " },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().user).toMatchObject({ username: "owner", displayName: "admin" });

    // Sessions are bound to the user, so the current cookie keeps working.
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe("owner");

    // The old name no longer signs in; the new one does.
    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "correct-horse" },
    });
    expect(oldLogin.statusCode).toBe(401);
    await login("correct-horse", "owner");
  });

  it("rejects an empty username or an empty patch", async () => {
    const cookie = await login();

    const blank = await app.inject({
      method: "PATCH",
      url: "/api/auth/me",
      headers: { cookie },
      payload: { username: "   " },
    });
    expect(blank.statusCode).toBe(400);

    const empty = await app.inject({
      method: "PATCH",
      url: "/api/auth/me",
      headers: { cookie },
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
  });

  it("rejects a wrong password", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "wrong" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("changes the password and invalidates the old one", async () => {
    const cookie = await login();

    const changed = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { cookie },
      payload: { currentPassword: "correct-horse", newPassword: "battery-staple" },
    });
    expect(changed.statusCode).toBe(200);

    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "correct-horse" },
    });
    expect(oldLogin.statusCode).toBe(401);

    await login("battery-staple");
  });

  it("rejects a wrong current password", async () => {
    const cookie = await login();

    const changed = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { cookie },
      payload: { currentPassword: "nope", newPassword: "battery-staple" },
    });
    expect(changed.statusCode).toBe(400);
    expect(changed.json().error.code).toBe("INVALID_REQUEST");
  });

  it("creates an API token that authenticates plugins", async () => {
    const cookie = await login();

    const created = await app.inject({
      method: "POST",
      url: "/api/auth/tokens",
      headers: { cookie },
      payload: { name: "dsh" },
    });
    expect(created.statusCode).toBe(201);
    const token = created.json().token as string;
    expect(token.startsWith("sbt_")).toBe(true);

    const authorized = await app.inject({
      method: "GET",
      url: "/api/containers",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authorized.statusCode).toBe(200);

    const listed = await app.inject({ method: "GET", url: "/api/auth/tokens", headers: { cookie } });
    expect(listed.json().tokens).toHaveLength(1);
    expect(listed.json().tokens[0].name).toBe("dsh");
    expect(listed.json().tokens[0].prefix).toBe(token.slice(0, 12));

    const id = listed.json().tokens[0].id as string;
    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/auth/tokens/${id}`,
      headers: { cookie },
    });
    expect(revoked.statusCode).toBe(204);

    const afterRevoke = await app.inject({
      method: "GET",
      url: "/api/containers",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(afterRevoke.statusCode).toBe(401);
  });

  it("keeps the health probe public", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
  });
});
