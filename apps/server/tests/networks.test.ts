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
      privateNetworkCleanupDelayMs: 0,
      sshReadyTimeoutMs: 50,
      sshRetryIntervalMs: 1,
      sleep: async () => {},
    });
    const files = new ContainerFilesService({
      containers: service,
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

  it("lists shared networks and creates them", async () => {
    const initial = await app.inject({ method: "GET", url: "/api/networks" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual([]);

    const created = await app.inject({
      method: "POST",
      url: "/api/networks",
      payload: { name: "team-a" },
    });
    expect(created.statusCode).toBe(201);

    const listed = await app.inject({ method: "GET", url: "/api/networks" });
    expect(listed.json().map((network: { name: string }) => network.name)).toEqual(["team-a"]);
  });

  it("reserves the management network name", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/networks",
      payload: { name: "sessionbox" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("gives every container a private network and joins shared ones", async () => {
    await app.inject({ method: "POST", url: "/api/networks", payload: { name: "team-a" } });

    const created = await app.inject({
      method: "POST",
      url: "/api/containers",
      payload: { name: "worker", networks: ["team-a"] },
    });
    expect(created.statusCode).toBe(201);
    const container = created.json();

    // The private network comes first and is what isolates containers.
    expect(container.networks[0]).toMatch(/^net-ctr_/);
    expect(container.networks).toContain("team-a");
    expect(container.networks).not.toContain("sessionbox");

    const listed = await app.inject({ method: "GET", url: "/api/networks" });
    const teamA = listed.json().find((network: { name: string }) => network.name === "team-a");
    expect(teamA.containers).toEqual([container.id]);
  });

  it("isolates containers by default: different private networks", async () => {
    const first = (await app.inject({ method: "POST", url: "/api/containers", payload: {} })).json();
    const second = (await app.inject({ method: "POST", url: "/api/containers", payload: {} })).json();

    expect(first.networks[0]).not.toBe(second.networks[0]);
    // Neither container shares a network with the other.
    expect(first.networks.some((name: string) => second.networks.includes(name))).toBe(false);
  });

  it("attaches and detaches a container from a shared network", async () => {
    await app.inject({ method: "POST", url: "/api/networks", payload: { name: "team-a" } });
    const created = await app.inject({ method: "POST", url: "/api/containers", payload: {} });
    const id = created.json().id as string;

    const attached = await app.inject({
      method: "POST",
      url: `/api/containers/${id}/networks/team-a`,
    });
    expect(attached.statusCode).toBe(200);
    expect(attached.json().networks).toContain("team-a");

    const detached = await app.inject({
      method: "DELETE",
      url: `/api/containers/${id}/networks/team-a`,
    });
    expect(detached.statusCode).toBe(200);
    expect(detached.json().networks).not.toContain("team-a");
  });

  it("refuses to attach an unknown or private network", async () => {
    const first = (await app.inject({ method: "POST", url: "/api/containers", payload: {} })).json();
    const second = (await app.inject({ method: "POST", url: "/api/containers", payload: {} })).json();
    const privateName = first.networks[0] as string;

    const unknown = await app.inject({
      method: "POST",
      url: `/api/containers/${second.id}/networks/nope`,
    });
    expect(unknown.statusCode).toBe(404);

    // Another container cannot join a private network.
    const privateAttach = await app.inject({
      method: "POST",
      url: `/api/containers/${second.id}/networks/${privateName}`,
    });
    expect(privateAttach.statusCode).toBe(404);
  });

  it("locks the private network on the container", async () => {
    const created = (await app.inject({ method: "POST", url: "/api/containers", payload: {} })).json();
    const privateName = created.networks[0] as string;

    const response = await app.inject({
      method: "DELETE",
      url: `/api/containers/${created.id}/networks/${privateName}`,
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

    const containers = (await app.inject({ method: "GET", url: "/api/containers" })).json() as Array<{
      id: string;
    }>;
    for (const container of containers) {
      await app.inject({ method: "DELETE", url: `/api/containers/${container.id}/networks/team-a` });
    }

    const deleted = await app.inject({ method: "DELETE", url: "/api/networks/team-a" });
    expect(deleted.statusCode).toBe(204);
  });

  it("drops the private network when the container is deleted", async () => {
    const created = (await app.inject({ method: "POST", url: "/api/containers", payload: {} })).json();
    const privateName = created.networks[0] as string;
    expect(runtime.networks.has(privateName)).toBe(true);

    await app.inject({ method: "DELETE", url: `/api/containers/${created.id}` });

    // The cleanup is deferred so the delete response is not dropped by the
    // network-sandbox rebuild (see ContainerService.remove).
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.networks.has(privateName)).toBe(false);
  });
});
