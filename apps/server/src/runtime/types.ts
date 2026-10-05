import type { Duplex } from "node:stream";
import type { ContainerResources } from "@sessionbox/protocol";

/**
 * The thin seam between SessionBox and a container runtime.
 *
 * Only adapters under `src/runtime/<id>/` may import runtime SDKs (dockerode,
 * containerd clients, ...). Every other module — container service, HTTP layer,
 * SSH bridge, web terminal — depends on this interface only, so a future
 * runtime can be added without touching the core. Nothing in this interface
 * is Docker-specific.
 */
export interface RuntimeCreateSpec {
  containerId: string;
  name: string;
  image: string;
  workspace: string;
  resources: ContainerResources;
  env?: Record<string, string>;
  /** Extra shared networks to attach; the default network is always attached. */
  networks?: string[];
}

export type RuntimeContainerStatus = "running" | "stopped";

export interface RuntimeContainer {
  /** Opaque runtime handle (e.g. container id). Never exposed publicly. */
  ref: string;
  /** SessionBox container id read back from runtime metadata, when available. */
  containerId?: string;
  status: RuntimeContainerStatus;
  startedAt?: string;
  /** Metadata used when reconciling (adopting containers that lost their record). */
  name?: string;
  image?: string;
  createdAt?: string;
  /** Names of the networks this container is attached to. */
  networks?: string[];
}

/** A runtime-managed network (e.g. a Docker user-defined bridge). */
export interface RuntimeNetwork {
  name: string;
  createdAt?: string;
  /** Refs of the containers attached to this network. */
  containerRefs: string[];
}

export interface ContainerRuntime {
  readonly runtimeId: string;

  /** Makes sure the image is available locally (pull/build as needed). */
  ensureImage(image: string): Promise<void>;

  create(spec: RuntimeCreateSpec): Promise<RuntimeContainer>;
  start(ref: string): Promise<void>;
  stop(ref: string, timeoutSeconds?: number): Promise<void>;
  restart(ref: string, timeoutSeconds?: number): Promise<void>;
  remove(ref: string, options?: { force?: boolean }): Promise<void>;

  inspect(ref: string): Promise<RuntimeContainer | undefined>;
  /** Lists managed containers, e.g. for restart reconciliation. */
  list(): Promise<RuntimeContainer[]>;
  logs(ref: string, options?: { tailLines?: number }): Promise<string>;

  // ---- networks (shared connectivity between containers) -----------------
  /** Creates a managed network; creating an existing one is a no-op. */
  createNetwork(name: string): Promise<void>;
  deleteNetwork(name: string): Promise<void>;
  /** Lists managed networks (the default network is not included). */
  listNetworks(): Promise<RuntimeNetwork[]>;
  connectToNetwork(ref: string, name: string, aliases?: string[]): Promise<void>;
  disconnectFromNetwork(ref: string, name: string): Promise<void>;

  /**
   * Opens a raw duplex TCP stream to a port inside a running container.
   * The SSH/SFTP/terminal layer consumes this stream and never learns how the
   * runtime makes the container reachable (container IP today; port-forward or
   * exec bridge for future runtimes).
   */
  openPortStream(ref: string, port: number): Promise<Duplex>;
}

export class RuntimeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "RuntimeError";
  }
}

export class RuntimeNotFoundError extends RuntimeError {
  constructor(
    message = "container does not exist in the container runtime",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RuntimeNotFoundError";
  }
}
