import type { ServerConfig } from "../config.ts";
import type { Logger } from "../logging.ts";
import { DockerRuntime } from "./docker/docker-runtime.ts";
import type { SandboxRuntime } from "./types.ts";

/**
 * The single place where a runtime implementation is chosen. Adding a future
 * runtime (containerd, Kubernetes, WSLc) means adding one adapter under
 * `runtime/<id>/` and one branch here — nothing else in the server changes.
 */
export function createRuntime(config: ServerConfig, logger: Logger): SandboxRuntime {
  if (config.runtime === "docker") {
    return new DockerRuntime({
      socketPath: config.docker.socketPath,
      networkName: config.docker.networkName,
      logger,
    });
  }

  throw new Error(`unsupported runtime: ${String(config.runtime)}`);
}

export * from "./types.ts";
