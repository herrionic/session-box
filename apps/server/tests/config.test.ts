import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("applies defaults for the container deployment", () => {
    const config = loadConfig({});

    expect(config).toMatchObject({
      host: "0.0.0.0",
      port: 8787,
      runtime: "docker",
      logLevel: "info",
      dataDir: "./data",
      docker: {
        socketPath: "/var/run/docker.sock",
        networkName: "sessionbox",
        baseImage: "sessionbox/base:latest",
        workspace: "/workspace",
      },
      auth: { clients: [] },
      lifecycle: { intervalMs: 15_000 },
    });
    expect(config.databaseFile).toBe(join("./data", "sessionbox.db"));
  });

  it("parses configured clients", () => {
    const config = loadConfig({
      SESSIONBOX_CLIENTS: JSON.stringify([
        { id: "dsh", token: "dsh-token", permissions: ["container:read"] },
      ]),
    });

    expect(config.auth.clients).toEqual([
      { id: "dsh", token: "dsh-token", permissions: ["container:read"] },
    ]);
  });

  it("rejects malformed client configuration", () => {
    expect(() => loadConfig({ SESSIONBOX_CLIENTS: "not json" })).toThrow(/valid JSON/);
    expect(() => loadConfig({ SESSIONBOX_CLIENTS: "{}" })).toThrow(/must be a JSON array/);
    expect(() => loadConfig({ SESSIONBOX_CLIENTS: '[{"id":"x"}]' })).toThrow(/token/);
  });

  it("reads overrides from the environment", () => {
    const config = loadConfig({
      SESSIONBOX_HOST: "127.0.0.1",
      SESSIONBOX_PORT: "9000",
      SESSIONBOX_LOG_LEVEL: "debug",
      SESSIONBOX_DATA_DIR: "/data",
      SESSIONBOX_WEB_DIST: "/app/public",
      SESSIONBOX_DOCKER_SOCKET: "/run/docker.sock",
      SESSIONBOX_DOCKER_NETWORK: "custom",
      SESSIONBOX_BASE_IMAGE: "custom/base:1",
      SESSIONBOX_WORKSPACE: "/work",
    });

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(9000);
    expect(config.dataDir).toBe("/data");
    expect(config.webDist).toBe("/app/public");
    expect(config.docker.socketPath).toBe("/run/docker.sock");
    expect(config.docker.networkName).toBe("custom");
    expect(config.docker.baseImage).toBe("custom/base:1");
    expect(config.docker.workspace).toBe("/work");
  });

  it("reads the master key when it is configured", () => {
    const config = loadConfig({ SESSIONBOX_MASTER_KEY: "c2VjcmV0" });
    expect(config.masterKey).toBe("c2VjcmV0");
  });

  it("rejects runtimes that are not implemented yet", () => {
    expect(() => loadConfig({ SESSIONBOX_RUNTIME: "kubernetes" })).toThrow(/not supported/);
  });

  it("rejects invalid ports", () => {
    expect(() => loadConfig({ SESSIONBOX_PORT: "abc" })).toThrow(/SESSIONBOX_PORT/);
    expect(() => loadConfig({ SESSIONBOX_PORT: "-1" })).toThrow(/SESSIONBOX_PORT/);
  });
});
