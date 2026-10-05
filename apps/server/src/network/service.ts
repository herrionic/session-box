import type { Network } from "@sessionbox/protocol";
import type { ContainerRepository } from "../container/repository.ts";
import { SessionBoxError } from "../errors.ts";
import type { Logger } from "../logging.ts";
import type { ContainerRuntime } from "../runtime/types.ts";

export interface NetworkServiceOptions {
  runtime: ContainerRuntime;
  repository: ContainerRepository;
  /** The default network every container joins; reserved and not deletable. */
  defaultNetwork: string;
  logger: Logger;
}

/**
 * Networks as a resource (PROJECT.md §10 model, extended): user-defined shared
 * networks that containers can additionally join. Every container always joins
 * the default network, which keeps the server able to reach it and makes
 * cross-session connectivity work out of the box; extra networks group
 * containers explicitly and provide stable DNS aliases.
 */
export class NetworkService {
  private readonly runtime: ContainerRuntime;
  private readonly repository: ContainerRepository;
  private readonly defaultNetwork: string;
  private readonly logger: Logger;

  constructor(options: NetworkServiceOptions) {
    this.runtime = options.runtime;
    this.repository = options.repository;
    this.defaultNetwork = options.defaultNetwork;
    this.logger = options.logger;
  }

  /** The default network first, then every user-defined managed network. */
  async list(): Promise<Network[]> {
    const [runtimeNetworks, records] = await Promise.all([
      this.runtime.listNetworks(),
      this.repository.list(),
    ]);

    const idByRef = new Map(
      records
        .filter((record) => record.runtimeRef !== undefined)
        .map((record) => [record.runtimeRef as string, record.id]),
    );

    const defaultNetwork: Network = {
      name: this.defaultNetwork,
      containers: records
        .filter((record) => record.networks.includes(this.defaultNetwork))
        .map((record) => record.id),
      managed: false,
    };

    const userNetworks: Network[] = runtimeNetworks.map((network) => ({
      name: network.name,
      ...(network.createdAt !== undefined ? { createdAt: network.createdAt } : {}),
      containers: network.containerRefs
        .map((ref) => idByRef.get(ref))
        .filter((id): id is string => id !== undefined),
      managed: true,
    }));

    return [defaultNetwork, ...userNetworks];
  }

  async create(name: string): Promise<Network> {
    if (name === this.defaultNetwork) {
      throw new SessionBoxError("INVALID_REQUEST", `"${name}" is reserved for the default network`);
    }

    await this.runtime.createNetwork(name);
    this.logger.info({ event: "network.created", network: name }, "network created");
    return { name, containers: [], managed: true };
  }

  /** Deletes an empty network; attached containers must be detached first. */
  async remove(name: string): Promise<void> {
    if (name === this.defaultNetwork) {
      throw new SessionBoxError("INVALID_REQUEST", "the default network cannot be deleted");
    }

    const networks = await this.runtime.listNetworks();
    const network = networks.find((candidate) => candidate.name === name);
    if (network === undefined) {
      throw new SessionBoxError("NOT_FOUND", `network ${name} was not found`);
    }
    if (network.containerRefs.length > 0) {
      throw new SessionBoxError(
        "INVALID_STATE",
        "network still has containers attached; detach them first",
      );
    }

    await this.runtime.deleteNetwork(name);
    this.logger.info({ event: "network.deleted", network: name }, "network deleted");
  }
}
