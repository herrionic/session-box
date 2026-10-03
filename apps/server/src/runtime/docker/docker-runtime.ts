import net from "node:net";
import os from "node:os";
import type { Duplex } from "node:stream";
import Docker from "dockerode";
import type { Logger } from "../../logging.ts";
import { RuntimeError, RuntimeNotFoundError } from "../types.ts";
import type { RuntimeCreateSpec, RuntimeSandbox, SandboxRuntime } from "../types.ts";
import { SERVER_VERSION } from "../../version.ts";

const MANAGED_LABEL = "sessionbox.managed";
const SANDBOX_ID_LABEL = "sessionbox.sandbox-id";
const VERSION_LABEL = "sessionbox.version";
const DEFAULT_PIDS_LIMIT = 512;

/**
 * sshd runs as root inside the sandbox and drops to the non-root "agent" user
 * for each session. These are the only capabilities it needs; everything else
 * is dropped (PROJECT.md §21).
 *
 * FOWNER: chmod the injected authorized_keys after chowning it to agent.
 * AUDIT_WRITE: sshd writes /proc/self/loginuid during session setup; without
 * it the session is torn down right after authentication (no PTY).
 */
const SANDBOX_CAPABILITIES = [
  "AUDIT_WRITE",
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "KILL",
  "NET_BIND_SERVICE",
  "SETGID",
  "SETUID",
  "SYS_CHROOT",
];

export interface DockerRuntimeOptions {
  socketPath: string;
  networkName: string;
  logger: Logger;
}

/**
 * The only module allowed to import dockerode. Everything Docker-specific
 * (labels, security flags, bridge network, container IPs, log multiplexing)
 * stays inside this adapter; the rest of the server only sees
 * `SandboxRuntime`.
 */
export class DockerRuntime implements SandboxRuntime {
  readonly runtimeId = "docker";

  private readonly docker: Docker;
  private readonly options: DockerRuntimeOptions;
  private preparePromise: Promise<void> | undefined;

  constructor(options: DockerRuntimeOptions) {
    this.options = options;
    this.docker = new Docker({ socketPath: options.socketPath });
  }

  async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch (error) {
      if (dockerStatusCode(error) !== 404) {
        throw this.wrap(error, "inspect sandbox image");
      }
    }

    this.options.logger.info(
      { event: "sandbox.image.pull", image },
      "sandbox image missing locally, pulling it",
    );

    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, {}, (pullError, stream) => {
        if (pullError) {
          reject(this.wrap(pullError, "pull sandbox image"));
          return;
        }
        if (!stream) {
          reject(new RuntimeError("container runtime returned no pull stream"));
          return;
        }
        this.docker.modem.followProgress(stream, (finishError) => {
          if (finishError) {
            reject(this.wrap(finishError, "pull sandbox image"));
            return;
          }
          resolve();
        });
      });
    });
  }

  async create(spec: RuntimeCreateSpec): Promise<RuntimeSandbox> {
    await this.prepare();

    try {
      const container = await this.docker.createContainer({
        name: containerNameFor(spec.sandboxId),
        Image: spec.image,
        WorkingDir: spec.workspace,
        Env: toEnvArray(spec.env),
        Labels: {
          [MANAGED_LABEL]: "true",
          [SANDBOX_ID_LABEL]: spec.sandboxId,
          [VERSION_LABEL]: SERVER_VERSION,
        },
        HostConfig: {
          // Sandboxes never join the default bridge and never publish ports;
          // the server reaches them over this dedicated network only.
          NetworkMode: this.options.networkName,
          Privileged: false,
          CapDrop: ["ALL"],
          CapAdd: SANDBOX_CAPABILITIES,
          SecurityOpt: ["no-new-privileges"],
          PidsLimit: spec.resources.pidsLimit ?? DEFAULT_PIDS_LIMIT,
          RestartPolicy: { Name: "no" },
          AutoRemove: false,
          ...(spec.resources.memoryLimitMb !== undefined
            ? { Memory: spec.resources.memoryLimitMb * 1024 * 1024 }
            : {}),
          ...(spec.resources.cpuLimit !== undefined
            ? { NanoCpus: Math.round(spec.resources.cpuLimit * 1_000_000_000) }
            : {}),
        },
      });

      return { ref: container.id, sandboxId: spec.sandboxId, status: "stopped" };
    } catch (error) {
      throw this.wrap(error, `create sandbox ${spec.sandboxId}`);
    }
  }

  async start(ref: string): Promise<void> {
    try {
      await this.docker.getContainer(ref).start();
    } catch (error) {
      if (dockerStatusCode(error) === 304) return; // already running
      throw this.wrap(error, "start sandbox");
    }
  }

  async stop(ref: string, timeoutSeconds = 10): Promise<void> {
    try {
      await this.docker.getContainer(ref).stop({ t: timeoutSeconds });
    } catch (error) {
      if (dockerStatusCode(error) === 304) return; // already stopped
      throw this.wrap(error, "stop sandbox");
    }
  }

  async restart(ref: string, timeoutSeconds = 10): Promise<void> {
    try {
      await this.docker.getContainer(ref).restart({ t: timeoutSeconds });
    } catch (error) {
      if (dockerStatusCode(error) === 304) return;
      throw this.wrap(error, "restart sandbox");
    }
  }

  async remove(ref: string, options: { force?: boolean } = {}): Promise<void> {
    try {
      await this.docker
        .getContainer(ref)
        .remove({ force: options.force ?? true, v: true });
    } catch (error) {
      if (dockerStatusCode(error) === 404) return; // already gone
      throw this.wrap(error, "remove sandbox");
    }
  }

  async inspect(ref: string): Promise<RuntimeSandbox | undefined> {
    let info: Docker.ContainerInspectInfo;
    try {
      info = await this.docker.getContainer(ref).inspect();
    } catch (error) {
      if (dockerStatusCode(error) === 404) return undefined;
      throw this.wrap(error, "inspect sandbox");
    }
    return toRuntimeSandbox(info);
  }

  async list(): Promise<RuntimeSandbox[]> {
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: { label: [`${MANAGED_LABEL}=true`] },
      });
      return containers.map((container) => ({
        ref: container.Id,
        sandboxId: container.Labels?.[SANDBOX_ID_LABEL],
        status: container.State === "running" ? "running" : "stopped",
      }));
    } catch (error) {
      throw this.wrap(error, "list sandboxes");
    }
  }

  async logs(ref: string, options: { tailLines?: number } = {}): Promise<string> {
    try {
      const buffer = await this.docker.getContainer(ref).logs({
        stdout: true,
        stderr: true,
        tail: options.tailLines ?? 200,
        timestamps: false,
      });
      return demuxDockerLogs(buffer);
    } catch (error) {
      throw this.wrap(error, "read sandbox logs");
    }
  }

  async openPortStream(ref: string, port: number): Promise<Duplex> {
    const sandbox = await this.inspectContainerRaw(ref);
    const network = sandbox.NetworkSettings?.Networks?.[this.options.networkName];
    const ip = network?.IPAddress;
    if (!ip) {
      throw new RuntimeError(
        `sandbox is not attached to the managed network "${this.options.networkName}"`,
      );
    }

    return await new Promise<Duplex>((resolve, reject) => {
      const socket = net.connect({ host: ip, port });
      socket.setNoDelay(true);
      socket.once("connect", () => resolve(socket));
      socket.once("error", (error) => {
        reject(new RuntimeError("failed to open a connection into the sandbox", { cause: error }));
      });
    });
  }

  /**
   * Idempotent runtime preparation, memoized until it fails: ensures the
   * managed network exists and that the server container itself is attached
   * to it (needed to reach sandbox IPs when deployed as a container).
   */
  private prepare(): Promise<void> {
    if (!this.preparePromise) {
      this.preparePromise = this.doPrepare().catch((error: unknown) => {
        this.preparePromise = undefined;
        throw error;
      });
    }
    return this.preparePromise;
  }

  private async doPrepare(): Promise<void> {
    await this.ensureNetwork();
    await this.ensureSelfAttached();
  }

  private async ensureNetwork(): Promise<void> {
    try {
      await this.docker.getNetwork(this.options.networkName).inspect();
      return;
    } catch (error) {
      if (dockerStatusCode(error) !== 404) {
        throw this.wrap(error, "inspect managed network");
      }
    }

    this.options.logger.info(
      { event: "sandbox.network.created", network: this.options.networkName },
      "creating managed docker network",
    );
    try {
      await this.docker.createNetwork({
        Name: this.options.networkName,
        Driver: "bridge",
        Labels: { [MANAGED_LABEL]: "true" },
      });
    } catch (error) {
      throw this.wrap(error, "create managed network");
    }
  }

  private async ensureSelfAttached(): Promise<void> {
    const hostname = os.hostname();
    // Inside a container the hostname is the (short) container id.
    if (!/^[0-9a-f]{12,64}$/.test(hostname)) return;

    try {
      const self = await this.docker.getContainer(hostname).inspect();
      const attached = Object.keys(self.NetworkSettings?.Networks ?? {}).includes(
        this.options.networkName,
      );
      if (attached) return;

      this.options.logger.info(
        { event: "sandbox.network.self_attach", network: this.options.networkName },
        "attaching server container to managed network",
      );
      await this.docker.getNetwork(this.options.networkName).connect({ Container: hostname });
    } catch (error) {
      // Running outside Docker (development) is expected to land here.
      this.options.logger.warn(
        {
          event: "sandbox.network.self_attach_failed",
          network: this.options.networkName,
          err: errorMessage(error),
        },
        "could not attach the server container to the managed network",
      );
    }
  }

  private async inspectContainerRaw(ref: string): Promise<Docker.ContainerInspectInfo> {
    try {
      return await this.docker.getContainer(ref).inspect();
    } catch (error) {
      if (dockerStatusCode(error) === 404) {
        throw new RuntimeNotFoundError(undefined, { cause: error });
      }
      throw this.wrap(error, "inspect sandbox");
    }
  }

  private wrap(error: unknown, context: string): RuntimeError {
    if (error instanceof RuntimeError) return error;
    if (dockerStatusCode(error) === 404) {
      return new RuntimeNotFoundError(`runtime object not found during ${context}`, {
        cause: error,
      });
    }
    return new RuntimeError(`container runtime operation failed during ${context}`, {
      cause: error,
    });
  }
}

function containerNameFor(sandboxId: string): string {
  return `sessionbox-${sandboxId}`;
}

function toEnvArray(env: Record<string, string> | undefined): string[] | undefined {
  if (!env) return undefined;
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

function toRuntimeSandbox(info: Docker.ContainerInspectInfo): RuntimeSandbox {
  const startedAtRaw = info.State?.StartedAt;
  const startedAt =
    startedAtRaw && !startedAtRaw.startsWith("0001-") ? startedAtRaw : undefined;

  return {
    ref: info.Id,
    sandboxId: info.Config?.Labels?.[SANDBOX_ID_LABEL],
    status: info.State?.Running ? "running" : "stopped",
    ...(startedAt ? { startedAt } : {}),
  };
}

function dockerStatusCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number") return statusCode;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Docker multiplexes stdout/stderr as 8-byte framed chunks when TTY is off.
 * If the buffer is not framed (TTY mode or a plain message) it is returned
 * as-is.
 */
function demuxDockerLogs(buffer: Buffer): string {
  const chunks: string[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    if (streamType === undefined || streamType > 2) break;
    const size = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + size > buffer.length) break;
    chunks.push(buffer.subarray(offset + 8, offset + 8 + size).toString("utf8"));
    offset += 8 + size;
  }

  if (offset === 0) return buffer.toString("utf8");
  if (offset < buffer.length) chunks.push(buffer.subarray(offset).toString("utf8"));
  return chunks.join("");
}
