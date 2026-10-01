import type { Duplex } from "node:stream";
import type { SandboxResources } from "@sessionbox/protocol";

/**
 * The thin seam between SessionBox and a container runtime.
 *
 * Only adapters under `src/runtime/<id>/` may import runtime SDKs (dockerode,
 * containerd clients, ...). Every other module — sandbox service, HTTP layer,
 * SSH bridge, web terminal — depends on this interface only, so a future
 * runtime can be added without touching the core. Nothing in this interface
 * is Docker-specific.
 */
export interface RuntimeCreateSpec {
  sandboxId: string;
  name: string;
  image: string;
  workspace: string;
  resources: SandboxResources;
  env?: Record<string, string>;
}

export type RuntimeSandboxStatus = "running" | "stopped";

export interface RuntimeSandbox {
  /** Opaque runtime handle (e.g. container id). Never exposed publicly. */
  ref: string;
  /** SessionBox sandbox id read back from runtime metadata, when available. */
  sandboxId?: string;
  status: RuntimeSandboxStatus;
  startedAt?: string;
}

export interface SandboxRuntime {
  readonly runtimeId: string;

  /** Makes sure the image is available locally (pull/build as needed). */
  ensureImage(image: string): Promise<void>;

  create(spec: RuntimeCreateSpec): Promise<RuntimeSandbox>;
  start(ref: string): Promise<void>;
  stop(ref: string, timeoutSeconds?: number): Promise<void>;
  restart(ref: string, timeoutSeconds?: number): Promise<void>;
  remove(ref: string, options?: { force?: boolean }): Promise<void>;

  inspect(ref: string): Promise<RuntimeSandbox | undefined>;
  /** Lists managed sandboxes, e.g. for restart reconciliation. */
  list(): Promise<RuntimeSandbox[]>;
  logs(ref: string, options?: { tailLines?: number }): Promise<string>;

  /**
   * Opens a raw duplex TCP stream to a port inside a running sandbox.
   * The SSH/SFTP/terminal layer consumes this stream and never learns how the
   * runtime makes the sandbox reachable (container IP today; port-forward or
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
    message = "sandbox does not exist in the container runtime",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RuntimeNotFoundError";
  }
}
