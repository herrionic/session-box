import net from "node:net";
import os from "node:os";
import type { Duplex } from "node:stream";
import Docker from "dockerode";
import type { Logger } from "../../logging.ts";
import { RuntimeError, RuntimeNotFoundError } from "../types.ts";
import type {
  RuntimeCreateSpec,
  RuntimeContainer,
  RuntimeNetwork,
  ContainerRuntime,
} from "../types.ts";
import { SERVER_VERSION } from "../../version.ts";

const MANAGED_LABEL = "sessionbox.managed";
const PRIVATE_NETWORK_LABEL = "sessionbox.private";
const CONTAINER_ID_LABEL = "sessionbox.container-id";
/** Containers created before the sandbox→container rename carry this label. */
const LEGACY_CONTAINER_ID_LABEL = "sessionbox.sandbox-id";
const CONTAINER_NAME_LABEL = "sessionbox.name";
const VERSION_LABEL = "sessionbox.version";
const DEFAULT_PIDS_LIMIT = 512;

/**
 * sshd runs as root inside the container and drops to the non-root "agent" user
 * for each session. These are the only capabilities it needs; everything else
 * is dropped.
 *
 * FOWNER: chmod the injected authorized_keys after chowning it to agent.
 * AUDIT_WRITE: sshd writes /proc/self/loginuid during session setup; without
 * it the session is torn down right after authentication (no PTY).
 */
const CONTAINER_CAPABILITIES = [
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
 * `ContainerRuntime`.
 */
export class DockerRuntime implements ContainerRuntime {
  readonly runtimeId = "docker";

  private readonly docker: Docker;
  private readonly options: DockerRuntimeOptions;
  private preparePromise: Promise<void> | undefined;

  constructor(options: DockerRuntimeOptions) {
    this.options = options;
    // A request timeout keeps one stalled Docker call from wedging every
    // later operation (terminal opens, lifecycle changes, reconciliation).
    this.docker = new Docker({ socketPath: options.socketPath, timeout: 30_000 });
  }

  async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch (error) {
      if (dockerStatusCode(error) !== 404) {
        throw this.wrap(error, "inspect container image");
      }
    }

    this.options.logger.info(
      { event: "container.image.pull", image },
      "container image missing locally, pulling it",
    );

    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, {}, (pullError, stream) => {
        if (pullError) {
          reject(this.wrap(pullError, "pull container image"));
          return;
        }
        if (!stream) {
          reject(new RuntimeError("container runtime returned no pull stream"));
          return;
        }
        this.docker.modem.followProgress(stream, (finishError) => {
          if (finishError) {
            reject(this.wrap(finishError, "pull container image"));
            return;
          }
          resolve();
        });
      });
    });
  }

  async create(spec: RuntimeCreateSpec): Promise<RuntimeContainer> {
    await this.prepare();

    try {
      const networks = spec.networks ?? [];
      const primaryNetwork = networks[0] ?? this.options.networkName;

      const container = await this.docker.createContainer({
        name: containerNameFor(spec.containerId),
        Image: spec.image,
        WorkingDir: spec.workspace,
        Env: toEnvArray(spec.env),
        Labels: {
          [MANAGED_LABEL]: "true",
          [CONTAINER_ID_LABEL]: spec.containerId,
          [CONTAINER_NAME_LABEL]: spec.name,
          [VERSION_LABEL]: SERVER_VERSION,
        },
        HostConfig: {
          // Containers never join the default bridge and never publish ports;
          // the server reaches them over the container's own networks only.
          NetworkMode: primaryNetwork,
          Privileged: false,
          CapDrop: ["ALL"],
          CapAdd: CONTAINER_CAPABILITIES,
          // No `no-new-privileges`: the setuid sudo binary must be able to
          // elevate so agents can install system packages (ADR-0003). The
          // capability set above, the missing socket and the missing host
          // mounts keep container-root bounded.
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

      // The server must reach every container network for SSH.
      await this.ensureSelfAttachedTo(primaryNetwork);
      for (const networkName of networks.slice(1)) {
        await this.connectToNetwork(container.id, networkName, [spec.name]);
      }

      return { ref: container.id, containerId: spec.containerId, status: "stopped" };
    } catch (error) {
      throw this.wrap(error, `create container ${spec.containerId}`);
    }
  }

  async start(ref: string): Promise<void> {
    try {
      await this.docker.getContainer(ref).start();
    } catch (error) {
      if (dockerStatusCode(error) === 304) return; // already running
      throw this.wrap(error, "start container");
    }
  }

  async stop(ref: string, timeoutSeconds = 10): Promise<void> {
    try {
      await this.docker.getContainer(ref).stop({ t: timeoutSeconds });
    } catch (error) {
      if (dockerStatusCode(error) === 304) return; // already stopped
      throw this.wrap(error, "stop container");
    }
  }

  async restart(ref: string, timeoutSeconds = 10): Promise<void> {
    try {
      await this.docker.getContainer(ref).restart({ t: timeoutSeconds });
    } catch (error) {
      if (dockerStatusCode(error) === 304) return;
      throw this.wrap(error, "restart container");
    }
  }

  async remove(ref: string, options: { force?: boolean } = {}): Promise<void> {
    try {
      await this.docker
        .getContainer(ref)
        .remove({ force: options.force ?? true, v: true });
    } catch (error) {
      if (dockerStatusCode(error) === 404) return; // already gone
      throw this.wrap(error, "remove container");
    }
  }

  async inspect(ref: string): Promise<RuntimeContainer | undefined> {
    let info: Docker.ContainerInspectInfo;
    try {
      info = await this.docker.getContainer(ref).inspect();
    } catch (error) {
      if (dockerStatusCode(error) === 404) return undefined;
      throw this.wrap(error, "inspect container");
    }
    return toRuntimeContainer(info);
  }

  async list(): Promise<RuntimeContainer[]> {
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: { label: [`${MANAGED_LABEL}=true`] },
      });
      return containers.map((container) => ({
        ref: container.Id,
        containerId: container.Labels?.[CONTAINER_ID_LABEL] ?? container.Labels?.[LEGACY_CONTAINER_ID_LABEL],
        name: container.Labels?.[CONTAINER_NAME_LABEL] ?? stripContainerPrefix(container.Names?.[0]),
        image: container.Image,
        createdAt: new Date(container.Created * 1000).toISOString(),
        status: container.State === "running" ? "running" : "stopped",
        networks: Object.keys(container.NetworkSettings?.Networks ?? {}),
      }));
    } catch (error) {
      throw this.wrap(error, "list containers");
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
      throw this.wrap(error, "read container logs");
    }
  }

  async openPortStream(ref: string, port: number): Promise<Duplex> {
    const container = await this.inspectContainerRaw(ref);
    const candidates = Object.values(container.NetworkSettings?.Networks ?? {})
      .map((network) => network.IPAddress)
      .filter((ip): ip is string => ip !== undefined && ip !== "");

    if (candidates.length === 0) {
      throw new RuntimeError("container is not attached to any network");
    }

    // The server is attached to every container network; try them in order
    // (a stale network can be first after manual changes).
    let lastError: unknown;
    for (const ip of candidates) {
      try {
        return await connectTcp(ip, port);
      } catch (error) {
        lastError = error;
      }
    }
    throw new RuntimeError("failed to open a connection into the container", { cause: lastError });
  }

  // ---- networks ----------------------------------------------------------

  async createNetwork(name: string, options: { private?: boolean } = {}): Promise<void> {
    try {
      await this.docker.createNetwork({
        Name: name,
        Driver: "bridge",
        Labels: {
          [MANAGED_LABEL]: "true",
          ...(options.private === true ? { [PRIVATE_NETWORK_LABEL]: "true" } : {}),
        },
      });
    } catch (error) {
      if (dockerStatusCode(error) === 409) return; // already exists
      throw this.wrap(error, `create network ${name}`);
    }
  }

  async deleteNetwork(name: string): Promise<void> {
    // The server attaches itself to private networks; detach first or Docker
    // refuses to remove a network with active endpoints.
    await this.detachSelfFrom(name);

    try {
      await this.docker.getNetwork(name).remove();
    } catch (error) {
      if (dockerStatusCode(error) === 404) return; // already gone
      throw this.wrap(error, `delete network ${name}`);
    }
  }

  async listNetworks(): Promise<RuntimeNetwork[]> {
    try {
      // The network *list* endpoint does not report attached containers, so
      // derive the attachments from the managed containers' network names.
      const [networks, containers] = await Promise.all([
        this.docker.listNetworks({ filters: { label: [`${MANAGED_LABEL}=true`] } }),
        this.docker.listContainers({ all: true, filters: { label: [`${MANAGED_LABEL}=true`] } }),
      ]);
      return networks
        .filter(
          (network) =>
            network.Name !== this.options.networkName &&
            network.Labels?.[PRIVATE_NETWORK_LABEL] !== "true",
        )
        .map((network) => ({
          name: network.Name,
          ...(network.Created !== undefined ? { createdAt: network.Created } : {}),
          containerRefs: containers
            .filter(
              (container) =>
                container.NetworkSettings?.Networks?.[network.Name] !== undefined,
            )
            .map((container) => container.Id),
        }));
    } catch (error) {
      throw this.wrap(error, "list networks");
    }
  }

  async connectToNetwork(ref: string, name: string, aliases?: string[]): Promise<void> {
    try {
      await this.docker.getNetwork(name).connect({
        Container: ref,
        ...(aliases !== undefined && aliases.length > 0
          ? { EndpointConfig: { Aliases: aliases } }
          : {}),
      });
    } catch (error) {
      if (errorMessage(error).includes("already exists")) return; // idempotent
      throw this.wrap(error, `attach container to network ${name}`);
    }
  }

  async disconnectFromNetwork(ref: string, name: string): Promise<void> {
    try {
      await this.docker.getNetwork(name).disconnect({ Container: ref, Force: true });
    } catch (error) {
      if (dockerStatusCode(error) === 404) return; // network gone
      if (errorMessage(error).includes("is not connected")) return;
      throw this.wrap(error, `detach container from network ${name}`);
    }
  }

  /**
   * Idempotent runtime preparation, memoized until it fails: ensures the
   * managed network exists and that the server container itself is attached
   * to it (needed to reach container IPs when deployed as a container).
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
    await this.ensureSelfAttachedTo(this.options.networkName);
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
      { event: "container.network.created", network: this.options.networkName },
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

  /** Detaches the server container from a network (best effort). */
  private async detachSelfFrom(networkName: string): Promise<void> {
    const hostname = os.hostname();
    if (!/^[0-9a-f]{12,64}$/.test(hostname)) return;

    try {
      await this.docker.getNetwork(networkName).disconnect({ Container: hostname, Force: true });
    } catch {
      // Not attached, not containerised, or the network is gone: nothing to do.
    }
  }

  private async ensureSelfAttachedTo(networkName: string): Promise<void> {
    const hostname = os.hostname();
    // Inside a container the hostname is the (short) container id.
    if (!/^[0-9a-f]{12,64}$/.test(hostname)) return;

    try {
      const self = await this.docker.getContainer(hostname).inspect();
      const attached = Object.keys(self.NetworkSettings?.Networks ?? {}).includes(networkName);
      if (attached) return;

      this.options.logger.info(
        { event: "container.network.self_attach", network: networkName },
        "attaching server container to a container network",
      );
      await this.docker.getNetwork(networkName).connect({ Container: hostname });
    } catch (error) {
      // Running outside Docker (development) is expected to land here.
      this.options.logger.warn(
        {
          event: "container.network.self_attach_failed",
          network: networkName,
          err: errorMessage(error),
        },
        "could not attach the server container to the network",
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
      throw this.wrap(error, "inspect container");
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

function containerNameFor(containerId: string): string {
  return `sessionbox-${containerId}`;
}

/** TCP connect with a short timeout so stale candidates fail fast. */
function connectTcp(ip: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: ip, port });
    socket.setNoDelay(true);
    socket.setTimeout(2_000, () => {
      socket.destroy(new Error("connection attempt timed out"));
    });
    socket.once("connect", () => {
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.once("error", (error) => {
      reject(error);
    });
  });
}

function toEnvArray(env: Record<string, string> | undefined): string[] | undefined {
  if (!env) return undefined;
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

function toRuntimeContainer(info: Docker.ContainerInspectInfo): RuntimeContainer {
  const startedAtRaw = info.State?.StartedAt;
  const startedAt =
    startedAtRaw && !startedAtRaw.startsWith("0001-") ? startedAtRaw : undefined;
  const createdAtRaw = info.Created;
  const createdAt = createdAtRaw ? new Date(createdAtRaw).toISOString() : undefined;
  const networks = Object.keys(info.NetworkSettings?.Networks ?? {});

  return {
    ref: info.Id,
    containerId: info.Config?.Labels?.[CONTAINER_ID_LABEL] ?? info.Config?.Labels?.[LEGACY_CONTAINER_ID_LABEL],
    name: info.Config?.Labels?.[CONTAINER_NAME_LABEL] ?? stripContainerPrefix(info.Name),
    image: info.Config?.Image,
    status: info.State?.Running ? "running" : "stopped",
    ...(startedAt ? { startedAt } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(networks.length > 0 ? { networks } : {}),
  };
}

function stripContainerPrefix(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  return name.replace(/^\/+/, "").replace(/^sessionbox-/, "");
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
