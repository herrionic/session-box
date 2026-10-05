import { PassThrough, type Duplex } from "node:stream";
import type {
  RuntimeCreateSpec,
  RuntimeContainer,
  RuntimeNetwork,
  ContainerRuntime,
} from "../../src/runtime/types.ts";
import { RuntimeError, RuntimeNotFoundError } from "../../src/runtime/types.ts";

interface FakeContainer {
  containerId: string;
  status: "running" | "stopped";
  startedAt?: string;
  networks: string[];
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
  /** Network name → attached container refs. */
  readonly networks = new Map<string, Set<string>>();

  failNextCreate = false;
  failNextStart = false;
  failNextRemove = false;

  constructor(private readonly defaultNetwork = "sessionbox") {}

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
    const networks = [this.defaultNetwork, ...(spec.networks ?? [])];
    this.containers.set(ref, {
      containerId: spec.containerId,
      status: "stopped",
      networks,
    });
    for (const network of spec.networks ?? []) {
      const refs = this.networks.get(network);
      if (refs === undefined) throw new RuntimeNotFoundError(`network ${network} does not exist`);
      refs.add(ref);
    }
    return { ref, containerId: spec.containerId, status: "stopped", networks };
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

  async createNetwork(name: string): Promise<void> {
    if (!this.networks.has(name)) this.networks.set(name, new Set());
  }

  async deleteNetwork(name: string): Promise<void> {
    this.networks.delete(name);
  }

  async listNetworks(): Promise<RuntimeNetwork[]> {
    return [...this.networks.entries()].map(([name, refs]) => ({
      name,
      containerRefs: [...refs],
    }));
  }

  async connectToNetwork(ref: string, name: string): Promise<void> {
    const refs = this.networks.get(name);
    if (refs === undefined) throw new RuntimeNotFoundError(`network ${name} does not exist`);
    refs.add(ref);

    const container = this.require(ref);
    if (!container.networks.includes(name)) container.networks.push(name);
  }

  async disconnectFromNetwork(ref: string, name: string): Promise<void> {
    this.networks.get(name)?.delete(ref);
    const container = this.containers.get(ref);
    if (container !== undefined) {
      container.networks = container.networks.filter((candidate) => candidate !== name);
    }
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
    networks: [...container.networks],
  };
}
