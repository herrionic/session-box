import type { SandboxResources } from "@sessionbox/protocol";

export interface DockerRuntimeConfig {
  socketPath: string;
  networkName: string;
  baseImage: string;
  workspace: string;
}

export interface ServerConfig {
  host: string;
  port: number;
  runtime: "docker";
  logLevel: string;
  dataDir: string;
  webDist?: string;
  docker: DockerRuntimeConfig;
}

/**
 * Reads configuration from the environment. Defaults target the published
 * container deployment (Docker socket mounted, sandbox network attached).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const runtime = (env.SESSIONBOX_RUNTIME ?? "docker").trim();
  if (runtime !== "docker") {
    throw new Error(
      `SESSIONBOX_RUNTIME="${runtime}" is not supported: only "docker" is implemented in the MVP`,
    );
  }

  const webDist = env.SESSIONBOX_WEB_DIST?.trim();

  return {
    host: env.SESSIONBOX_HOST?.trim() || "0.0.0.0",
    port: parsePositiveInteger(env.SESSIONBOX_PORT, "SESSIONBOX_PORT") ?? 8787,
    runtime,
    logLevel: env.SESSIONBOX_LOG_LEVEL?.trim() || "info",
    dataDir: env.SESSIONBOX_DATA_DIR?.trim() || "./data",
    ...(webDist ? { webDist } : {}),
    docker: {
      socketPath: env.SESSIONBOX_DOCKER_SOCKET?.trim() || "/var/run/docker.sock",
      networkName: env.SESSIONBOX_DOCKER_NETWORK?.trim() || "sessionbox",
      baseImage: env.SESSIONBOX_BASE_IMAGE?.trim() || "sessionbox/base:latest",
      workspace: env.SESSIONBOX_WORKSPACE?.trim() || "/workspace",
    },
  };
}

function parsePositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
