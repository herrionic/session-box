import { PassThrough, type Duplex } from "node:stream";
import type {
  RuntimeCreateSpec,
  RuntimeContainer,
  ContainerRuntime,
} from "../../src/runtime/types.ts";
import { RuntimeError, RuntimeNotFoundError } from "../../src/runtime/types.ts";

interface FakeContainer {
  containerId: string;
  status: "running" | "stopped";
  startedAt?: string;
}

/**
 * In-memory `ContainerRuntime` test double. It proves the runtime seam is
 * implementable without Docker and lets the whole container service and HTTP
 * layer be tested on the development machine.
 */
export class FakeRuntime implements ContainerRuntime {
  readonly runtimeId = "fake";
  readonly containers = new Map<string, FakeContainer>();
  readonly images = new Set<string>();
  readonly createCalls: RuntimeCreateSpec[] = [];

  failNextCreate = false;
  failNextStart = false;
  failNextRemove = false;

  async ensureImage(image: string): Promise<void> {
    this.images.add(image);
  }

  async create(spec: RuntimeCreateSpec): Promise<RuntimeContainer> {
    this.createCalls.push(spec);
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new RuntimeError("create failed");
    }

    const ref = `fake_${spec.containerId}`;
    this.containers.set(ref, { containerId: spec.containerId, status: "stopped" });
    return { ref, containerId: spec.containerId, status: "stopped" };
  }

  async start(ref: string): Promise<void> {
    if (this.failNextStart) {
      this.failNextStart = false;
      throw new RuntimeError("start failed");
    }
    const container = this.require(ref);
    container.status = "running";
    container.startedAt = new Date().toISOString();
  }

  async stop(ref: string): Promise<void> {
    this.require(ref).status = "stopped";
  }

  async restart(ref: string): Promise<void> {
    const container = this.require(ref);
    container.status = "running";
    container.startedAt = new Date().toISOString();
  }

  async remove(ref: string): Promise<void> {
    if (this.failNextRemove) {
      this.failNextRemove = false;
      throw new RuntimeError("remove failed");
    }
    this.containers.delete(ref);
  }

  async inspect(ref: string): Promise<RuntimeContainer | undefined> {
    const container = this.containers.get(ref);
    return container ? toContainer(ref, container) : undefined;
  }

  async list(): Promise<RuntimeContainer[]> {
    return [...this.containers.entries()].map(([ref, container]) => toContainer(ref, container));
  }

  async logs(): Promise<string> {
    return "fake logs";
  }

  async openPortStream(): Promise<Duplex> {
    return new PassThrough();
  }

  private require(ref: string): FakeContainer {
    const container = this.containers.get(ref);
    if (!container) throw new RuntimeNotFoundError();
    return container;
  }
}

function toContainer(ref: string, container: FakeContainer): RuntimeContainer {
  return {
    ref,
    containerId: container.containerId,
    status: container.status,
    ...(container.startedAt !== undefined ? { startedAt: container.startedAt } : {}),
  };
}
