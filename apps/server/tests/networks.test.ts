import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentGateway } from "../src/agent/gateway.ts";
import type { ServerConfig } from "../src/config.ts";
import { InMemoryCredentialStore } from "../src/credentials/store.ts";
import { ContainerFilesService } from "../src/files/service.ts";
import { buildApp } from "../src/http/app.ts";
import type { SessionBoxApp } from "../src/http/types.ts";
import { NetworkService } from "../src/network/service.ts";
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

describe("network resource", () => {
  let app: SessionBoxApp;
  let runtime: FakeRuntime;
  let repository: InMemoryContainerRepository;

  beforeEach(async () => {
    runtime = new FakeRuntime();
    const logger = createTestLogger();
    const ssh = new FakeSshSessionFactory();
    repository = new InMemoryContainerRepository();
    const service = new ContainerService({
      runtime,
      repository,
      credentials: new InMemoryCredentialStore(Buffer.alloc(32, 41)),
      ssh,
      sessions: new SshSessionManager(ssh, logger),
      logger,
      baseImage: testConfig.docker.baseImage,
      workspace: testConfig.docker.workspace,
      networkName: testConfig.docker.networkName,
      sshReadyTimeoutMs: 50,
      sshRetryIntervalMs: 1,
      sleep: async () => {},
    });
    const files = new ContainerFilesService({
      containers: service,
      workspace: testConfig.docker.workspace,
      logger,
    });
    const networks = new NetworkService({
      runtime,
      repository,
      defaultNetwork: testConfig.docker.networkName,
      logger,
    });

    app = await buildApp({
      config: testConfig,
      logger,
      runtime,
      service,
      files,
      gateway: new AgentGateway(service, logger),
      networks,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("lists the default network first and creates user networks", async () => {
    const initial = await app.inject({ method: "GET", url: "/api/networks" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual([{ name: "sessionbox", containers: [], managed: false }]);

    const created = await app.inject({
      method: "POST",
      url: "/api/networks",
      payload: { name: "team-a" },
    });
    expect(created.statusCode).toBe(201);

    const listed = await app.inject({ method: "GET", url: "/api/networks" });
    expect(listed.json().map((network: { name: string }) => network.name)).toEqual([
      "sessionbox",
      "team-a",
    ]);
  });

  it("reserves the default network name", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/networks",
      payload: { name: "sessionbox" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("attaches containers at create time and reports networks on the model", async () => {
    await app.inject({ method: "POST", url: "/api/networks", payload: { name: "team-a" } });

    const created = await app.inject({
      method: "POST",
      url: "/api/containers",
      payload: { name: "worker", networks: ["team-a"] },
    });
    expect(created.statusCode).toBe(201);
    const container = created.json();
    expect(container.networks).toEqual(["sessionbox", "team-a"]);

    const listed = await app.inject({ method: "GET", url: "/api/networks" });
    const teamA = listed.json().find((network: { name: string }) => network.name === "team-a");
    expect(teamA.containers).toEqual([container.id]);
    const defaultNetwork = listed.json().find(
      (network: { name: string }) => network.name === "sessionbox",
    );
    expect(defaultNetwork.containers).toEqual([container.id]);
  });

  it("attaches and detaches a running container", async () => {
    await app.inject({ method: "POST", url: "/api/networks", payload: { name: "team-a" } });
    const created = await app.inject({ method: "POST", url: "/api/containers", payload: {} });
    const id = created.json().id as string;

    const attached = await app.inject({
      method: "POST",
      url: `/api/containers/${id}/networks/team-a`,
    });
    expect(attached.statusCode).toBe(200);
    expect(attached.json().networks).toEqual(["sessionbox", "team-a"]);

    const detached = await app.inject({
      method: "DELETE",
      url: `/api/containers/${id}/networks/team-a`,
    });
    expect(detached.statusCode).toBe(200);
    expect(detached.json().networks).toEqual(["sessionbox"]);
  });

  it("locks the default network on the container", async () => {
    const created = await app.inject({ method: "POST", url: "/api/containers", payload: {} });
    const id = created.json().id as string;

    const response = await app.inject({
      method: "DELETE",
      url: `/api/containers/${id}/networks/sessionbox`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("refuses to delete a network that still has containers", async () => {
    await app.inject({ method: "POST", url: "/api/networks", payload: { name: "team-a" } });
    await app.inject({
      method: "POST",
      url: "/api/containers",
      payload: { networks: ["team-a"] },
    });

    const refused = await app.inject({ method: "DELETE", url: "/api/networks/team-a" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("INVALID_STATE");

    // Detach everything, then deletion works.
    const containers = (await app.inject({ method: "GET", url: "/api/containers" })).json() as Array<{
      id: string;
    }>;
    for (const container of containers) {
      await app.inject({ method: "DELETE", url: `/api/containers/${container.id}/networks/team-a` });
    }

    const deleted = await app.inject({ method: "DELETE", url: "/api/networks/team-a" });
    expect(deleted.statusCode).toBe(204);
  });

  it("refuses to delete the default network", async () => {
    const response = await app.inject({ method: "DELETE", url: "/api/networks/sessionbox" });
    expect(response.statusCode).toBe(400);
  });
});
