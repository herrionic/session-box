import type { ContainerResources } from "@sessionbox/protocol";

import { join } from "node:path";
import type { AuthConfig } from "./auth/config.ts";
import { loadAuthConfig } from "./auth/config.ts";

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
  databaseFile: string;
  webDist?: string;
  /** Raw SESSIONBOX_MASTER_KEY value; parsed and validated where it is used. */
  masterKey?: string;
  docker: DockerRuntimeConfig;
  auth: AuthConfig;
  lifecycle: {
    /** How often the auto-stop policy is evaluated. */
    intervalMs: number;
  };
}

/**
 * Reads configuration from the environment. Defaults target the published
 * container deployment (Docker socket mounted, container network attached).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const runtime = (env.SESSIONBOX_RUNTIME ?? "docker").trim();
  if (runtime !== "docker") {
    throw new Error(
      `SESSIONBOX_RUNTIME="${runtime}" is not supported: only "docker" is implemented in the MVP`,
    );
  }

  const webDist = env.SESSIONBOX_WEB_DIST?.trim();
  const masterKey = env.SESSIONBOX_MASTER_KEY?.trim();
  const dataDir = env.SESSIONBOX_DATA_DIR?.trim() || "./data";

  return {
    host: env.SESSIONBOX_HOST?.trim() || "0.0.0.0",
    port: parsePositiveInteger(env.SESSIONBOX_PORT, "SESSIONBOX_PORT") ?? 8787,
    runtime,
    logLevel: env.SESSIONBOX_LOG_LEVEL?.trim() || "info",
    dataDir,
    databaseFile: env.SESSIONBOX_DATABASE_FILE?.trim() || join(dataDir, "sessionbox.db"),
    ...(webDist ? { webDist } : {}),
    ...(masterKey ? { masterKey } : {}),
    auth: {
      ...loadAuthConfig(env.SESSIONBOX_CLIENTS),
      admin: {
        username: env.SESSIONBOX_ADMIN_USERNAME?.trim() || "admin",
        ...(env.SESSIONBOX_ADMIN_PASSWORD?.trim()
          ? { password: env.SESSIONBOX_ADMIN_PASSWORD.trim() }
          : {}),
      },
    },
    lifecycle: {
      intervalMs: parsePositiveInteger(env.SESSIONBOX_LIFECYCLE_INTERVAL_MS, "SESSIONBOX_LIFECYCLE_INTERVAL_MS") ?? 15_000,
    },
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
