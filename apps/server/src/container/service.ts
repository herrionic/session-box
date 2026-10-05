import {
  resolveLifecyclePolicy,
  type CreateContainerRequest,
  type LifecyclePolicy,
  type LifecyclePolicyPatch,
  type ContainerResources,
  type ContainerStatus,
  type UpdateContainerSettingsRequest,
} from "@sessionbox/protocol";
import { newContainerId, nowIso } from "@sessionbox/shared";
import type { CredentialStore } from "../credentials/store.ts";
import { SessionBoxError } from "../errors.ts";
import type { Logger } from "../logging.ts";
import { RuntimeNotFoundError, type RuntimeContainer, type ContainerRuntime } from "../runtime/types.ts";
import { generateSshKeyPair, SSH_PRIVATE_KEY_CREDENTIAL } from "../ssh/keypair.ts";
import type { SshSessionManager } from "../ssh/manager.ts";
import { waitForSsh } from "../ssh/readiness.ts";
import type { SshSession, SshSessionFactory } from "../ssh/session.ts";
import type { ContainerRepository } from "./repository.ts";
import { assertOperationAllowed } from "./state.ts";
import type { ContainerRecord } from "./types.ts";

export interface ContainerServiceOptions {
  runtime: ContainerRuntime;
  repository: ContainerRepository;
  credentials: CredentialStore;
  ssh: SshSessionFactory;
  sessions: SshSessionManager;
  logger: Logger;
  baseImage: string;
  workspace: string;
  /** Default network every container joins (also the server's management network). */
  networkName?: string;
  /** How long to wait for sshd inside a new container before failing. */
  sshReadyTimeoutMs?: number;
  sshRetryIntervalMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock used for record timestamps; injectable for tests. */
  now?: () => number;
  /**
   * Delay before the per-container private network is removed, so the delete
   * response leaves the server before its network sandbox is rebuilt.
   */
  privateNetworkCleanupDelayMs?: number;
}

/** Default limits so every container is bounded even when none are requested. */
const DEFAULT_RESOURCES: ContainerResources = {
  cpuLimit: 1,
  memoryLimitMb: 1024,
  pidsLimit: 512,
};

/**
 * Owns container lifecycle and state transitions. Depends only on the
 * `ContainerRuntime` seam, never on a concrete runtime SDK.
 */
export class ContainerService {
  private readonly runtime: ContainerRuntime;
  private readonly repository: ContainerRepository;
  private readonly credentials: CredentialStore;
  private readonly ssh: SshSessionFactory;
  private readonly sessions: SshSessionManager;
  private readonly logger: Logger;
  private readonly baseImage: string;
  private readonly workspace: string;
  private readonly networkName: string;
  private readonly sshReadyTimeoutMs: number;
  private readonly sshRetryIntervalMs: number;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  private readonly now: () => number;
  private readonly privateNetworkCleanupDelayMs: number;
  /** Per-container operation chains: serializes concurrent state changes. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(options: ContainerServiceOptions) {
    this.runtime = options.runtime;
    this.repository = options.repository;
    this.credentials = options.credentials;
    this.ssh = options.ssh;
    this.sessions = options.sessions;
    this.logger = options.logger;
    this.baseImage = options.baseImage;
    this.workspace = options.workspace;
    this.networkName = options.networkName ?? "sessionbox";
    this.sshReadyTimeoutMs = options.sshReadyTimeoutMs ?? 30_000;
    this.sshRetryIntervalMs = options.sshRetryIntervalMs ?? 500;
    this.sleep = options.sleep;
    this.now = options.now ?? Date.now;
    this.privateNetworkCleanupDelayMs = options.privateNetworkCleanupDelayMs ?? 1_000;
  }

  async create(request: CreateContainerRequest): Promise<ContainerRecord> {
    const id = newContainerId();
    const privateNetwork = privateNetworkName(id);
    const extraNetworks = request.networks ?? [];
    const record: ContainerRecord = {
      id,
      name: request.name ?? defaultName(id),
      image: request.image ?? this.baseImage,
      runtime: this.runtime.runtimeId,
      status: "creating",
      workspace: this.workspace,
      networks: [privateNetwork, ...extraNetworks],
      resources: { ...DEFAULT_RESOURCES, ...request.resources },
      lifecycle: resolveLifecyclePolicy(request.lifecycle),
      createdAt: nowIso(this.now()),
      activeConnections: 0,
    };

    await this.repository.save(record);
    this.logger.info({ event: "container.create.requested", containerId: id }, "container creation requested");

    try {
      await this.runtime.ensureImage(record.image);

      // Every container gets its own private network: containers on different
      // networks cannot reach each other. Shared networks are opt-in and are
      // what enables cross-session connectivity.
      await this.runtime.createNetwork(privateNetwork, { private: true });

      // One ephemeral SSH keypair per container: the private key stays encrypted
      // in the credential store, only the public key is injected into the
      // container (PROJECT.md §14).
      const keyPair = generateSshKeyPair();
      await this.credentials.save(id, SSH_PRIVATE_KEY_CREDENTIAL, keyPair.privateKey);

      const created = await this.runtime.create({
        containerId: id,
        name: record.name,
        image: record.image,
        workspace: record.workspace,
        resources: record.resources,
        env: { SESSIONBOX_AUTHORIZED_KEY: keyPair.publicKey },
        networks: [privateNetwork, ...extraNetworks],
      });
      record.runtimeRef = created.ref;

      await this.runtime.start(created.ref);
      await waitForSsh({
        factory: this.ssh,
        containerId: id,
        runtimeRef: created.ref,
        timeoutMs: this.sshReadyTimeoutMs,
        intervalMs: this.sshRetryIntervalMs,
        ...(this.sleep !== undefined ? { sleep: this.sleep } : {}),
      });

      record.status = "running";
      record.startedAt = nowIso(this.now());
      await this.repository.save(record);

      this.logger.info({ event: "container.created", containerId: id }, "container created");
      return record;
    } catch (error) {
      // Best effort: drop the private network when the container never made it.
      await this.runtime.deleteNetwork(privateNetwork).catch(() => undefined);

      record.status = "failed";
      await this.repository.save(record);
      this.logger.error(
        { event: "container.failed", containerId: id, err: errorMessage(error) },
        "container creation failed",
      );
      // Configuration errors (for example a missing master key) must not be
      // disguised as runtime failures.
      if (error instanceof SessionBoxError && error.code === "INTERNAL_ERROR") throw error;
      throw new SessionBoxError(
        "CONTAINER_CREATE_FAILED",
        "failed to create the container; see server logs",
        { cause: error },
      );
    }
  }

  async list(): Promise<ContainerRecord[]> {
    return this.repository.list();
  }

  async get(id: string): Promise<ContainerRecord> {
    return this.require(id);
  }

  async start(id: string): Promise<ContainerRecord> {
    return this.withLock(id, async () => {
      const record = await this.require(id);
      assertOperationAllowed("start", record.status);

      const ref = this.requireRef(record);
      try {
        await this.runtime.start(ref);
      } catch (error) {
        throw this.toPublicRuntimeError(error, "start the container");
      }

      record.status = "running";
      record.startedAt = nowIso(this.now());
      record.stoppedAt = undefined;
      await this.repository.save(record);
      await this.sessions.release(id);

      this.logger.info({ event: "container.started", containerId: id }, "container started");
      return record;
    });
  }

  async stop(id: string): Promise<ContainerRecord> {
    return this.withLock(id, async () => {
      const record = await this.require(id);
      assertOperationAllowed("stop", record.status);

      const ref = this.requireRef(record);
      try {
        await this.runtime.stop(ref);
      } catch (error) {
        throw this.toPublicRuntimeError(error, "stop the container");
      }

      record.status = "stopped";
      record.stoppedAt = nowIso(this.now());
      await this.repository.save(record);
      await this.sessions.release(id);

      this.logger.info({ event: "container.stopped", containerId: id }, "container stopped");
      return record;
    });
  }

  async restart(id: string): Promise<ContainerRecord> {
    return this.withLock(id, async () => {
      const record = await this.require(id);
      assertOperationAllowed("restart", record.status);

      const ref = this.requireRef(record);
      try {
        await this.runtime.restart(ref);
      } catch (error) {
        throw this.toPublicRuntimeError(error, "restart the container");
      }

      record.status = "running";
      record.startedAt = nowIso(this.now());
      record.stoppedAt = undefined;
      await this.repository.save(record);
      await this.sessions.release(id);

      this.logger.info({ event: "container.restarted", containerId: id }, "container restarted");
      return record;
    });
  }

  async remove(id: string): Promise<void> {
    return this.withLock(id, async () => {
      const record = await this.require(id);
      assertOperationAllowed("delete", record.status);

      record.status = "deleting";
      await this.repository.save(record);
      await this.sessions.release(id);

      if (record.runtimeRef !== undefined) {
        try {
          await this.runtime.remove(record.runtimeRef, { force: true });
        } catch (error) {
          record.status = "failed";
          await this.repository.save(record);
          throw this.toPublicRuntimeError(error, "delete the container");
        }
      }

      // The server must detach itself before Docker lets the private network
      // go, but a disconnect mid-request rebuilds this container's network
      // sandbox and can drop the in-flight HTTP response. Defer the cleanup
      // so the delete response reaches the client first.
      const privateNetwork = privateNetworkName(id);
      const cleanupTimer = setTimeout(() => {
        void this.runtime.deleteNetwork(privateNetwork).catch(() => undefined);
      }, this.privateNetworkCleanupDelayMs);
      cleanupTimer.unref();

      await this.credentials.removeAll(id);
      await this.repository.delete(id);
      this.logger.info({ event: "container.deleted", containerId: id }, "container deleted");
    });
  }

  async updateSettings(
    id: string,
    patch: UpdateContainerSettingsRequest,
  ): Promise<ContainerRecord> {
    return this.withLock(id, async () => {
      const record = await this.require(id);

      if (patch.name !== undefined) record.name = patch.name;
      if (patch.lifecycle !== undefined) {
        record.lifecycle = applyLifecyclePatch(record.lifecycle, patch.lifecycle);
      }

      await this.repository.save(record);
      this.logger.info({ event: "container.settings.updated", containerId: id }, "container settings updated");
      return record;
    });
  }

  async logs(id: string, options: { tailLines?: number } = {}): Promise<string> {
    const record = await this.require(id);
    const ref = this.requireRef(record);
    try {
      return await this.runtime.logs(ref, options);
    } catch (error) {
      throw this.toPublicRuntimeError(error, "read the container logs");
    }
  }

  /**
   * Opens (or reuses) an SSH session for a running container. Shared by the file
   * manager, the web terminal and (later) the agent gateway.
   */
  async withSshSession<T>(id: string, operation: (session: SshSession) => Promise<T>): Promise<T> {
    const record = await this.require(id);
    if (record.status !== "running") {
      throw new SessionBoxError(
        "CONTAINER_NOT_RUNNING",
        `container is ${record.status}; start it first`,
      );
    }
    const ref = this.requireRef(record);
    return this.sessions.withSession({ containerId: id, runtimeRef: ref }, operation);
  }

  /**
   * Returns the cached SSH session for a running container. The web terminal
   * holds its own shell channel on this session.
   */
  async openSshSession(id: string): Promise<SshSession> {
    const record = await this.require(id);
    if (record.status !== "running") {
      throw new SessionBoxError(
        "CONTAINER_NOT_RUNNING",
        `container is ${record.status}; start it first`,
      );
    }
    const ref = this.requireRef(record);
    return this.sessions.get({ containerId: id, runtimeRef: ref });
  }

  /** Releases every cached SSH session (used on server shutdown). */
  async close(): Promise<void> {
    await this.sessions.releaseAll();
  }

  /** Records activity for idle detection (best effort). */
  async touch(id: string): Promise<void> {
    const record = await this.repository.get(id);
    if (record === undefined) return;

    record.lastActivityAt = nowIso(this.now());
    await this.repository.save(record);
  }

  /** Marks one more live connection (agent socket, web terminal). */
  async acquire(id: string): Promise<void> {
    const record = await this.repository.get(id);
    if (record === undefined) return;

    record.activeConnections += 1;
    record.lastActivityAt = nowIso(this.now());
    await this.repository.save(record);
  }

  async release(id: string): Promise<void> {
    const record = await this.repository.get(id);
    if (record === undefined) return;

    record.activeConnections = Math.max(0, record.activeConnections - 1);
    record.lastActivityAt = nowIso(this.now());
    await this.repository.save(record);
  }

  /** Attaches a container to a shared network (idempotent). */
  async attachNetwork(id: string, network: string): Promise<ContainerRecord> {
    const record = await this.require(id);
    if (record.networks.includes(network)) return record;
    if (record.runtimeRef === undefined) {
      throw new SessionBoxError("INVALID_STATE", "container has no runtime handle yet");
    }

    // Only shared networks can be attached; private ones belong to a container.
    const shared = await this.runtime.listNetworks();
    if (!shared.some((candidate) => candidate.name === network)) {
      throw new SessionBoxError("NOT_FOUND", `network ${network} was not found`);
    }

    try {
      await this.runtime.connectToNetwork(record.runtimeRef, network, [record.name]);
    } catch {
      throw new SessionBoxError("RUNTIME_ERROR", "could not attach the container to the network");
    }

    record.networks = [...record.networks, network];
    await this.repository.save(record);
    // Attaching a network can disrupt existing TCP connections inside the
    // container; drop the cached SSH session so the next operation reconnects.
    await this.sessions.release(id);
    this.logger.info(
      { event: "container.network.attached", containerId: id, network },
      "container attached to network",
    );
    return record;
  }

  /** Detaches a container from a shared network; private/default are locked. */
  async detachNetwork(id: string, network: string): Promise<ContainerRecord> {
    const record = await this.require(id);
    if (network === this.networkName || network === privateNetworkName(record.id)) {
      throw new SessionBoxError("INVALID_REQUEST", "this network cannot be detached");
    }
    if (!record.networks.includes(network)) return record;

    if (record.runtimeRef !== undefined) {
      try {
        await this.runtime.disconnectFromNetwork(record.runtimeRef, network);
      } catch {
        throw new SessionBoxError("RUNTIME_ERROR", "could not detach the container from the network");
      }
    }

    record.networks = record.networks.filter((name) => name !== network);
    await this.repository.save(record);
    await this.sessions.release(id);
    this.logger.info(
      { event: "container.network.detached", containerId: id, network },
      "container detached from network",
    );
    return record;
  }

  /**
   * Reconciles persisted state with the runtime after a server restart
   * (PROJECT.md §33). Containers that disappeared are marked `failed`;
   * containers that were started/stopped externally are synced.
   */
  async reconcile(): Promise<void> {
    const records = await this.repository.list();
    // The runtime must always be listed: it is also the adoption source for
    // managed containers that lost their record.
    const runtimeContainers = await this.runtime.list();

    // No connection survives a restart; stale counters would block auto-stop.
    for (const record of records) {
      if (record.activeConnections !== 0) {
        record.activeConnections = 0;
        await this.repository.save(record);
      }
    }

    const byContainerId = new Map(
      runtimeContainers
        .filter((container) => container.containerId !== undefined)
        .map((container) => [container.containerId as string, container]),
    );

    for (const record of records) {
      if (record.runtimeRef === undefined) continue;

      const actual = byContainerId.get(record.id);
      if (actual === undefined) {
        if (record.status !== "failed") {
          record.status = "failed";
          await this.repository.save(record);
          await this.sessions.release(record.id);
          this.logger.warn(
            { event: "container.reconcile.missing", containerId: record.id },
            "container container disappeared from the runtime",
          );
        }
        continue;
      }

      const status: ContainerStatus = actual.status === "running" ? "running" : "stopped";
      const networks = actual.networks ?? record.networks;
      if (record.status !== status || !sameStringSet(record.networks, networks)) {
        record.status = status;
        record.networks = networks;
        if (actual.startedAt !== undefined) record.startedAt = actual.startedAt;
        await this.repository.save(record);
        if (status === "stopped") await this.sessions.release(record.id);
        this.logger.info(
          { event: "container.reconcile.status", containerId: record.id, status },
          "container status reconciled from the runtime",
        );
      }
    }

    await this.adoptOrphans(records, runtimeContainers);
  }

  /**
   * Managed runtime objects without a record (lost database) are adopted so
   * they stay manageable. Their SSH credentials are gone with the database,
   * so agent connections to adopted containers fail until they are recreated.
   */
  private async adoptOrphans(
    records: ContainerRecord[],
    runtimeContainers: RuntimeContainer[],
  ): Promise<void> {
    const known = new Set(records.map((record) => record.id));

    for (const container of runtimeContainers) {
      const containerId = container.containerId;
      if (containerId === undefined || known.has(containerId)) continue;

      const record: ContainerRecord = {
        id: containerId,
        name: container.name ?? containerId,
        image: container.image ?? this.baseImage,
        runtime: this.runtime.runtimeId,
        status: container.status === "running" ? "running" : "stopped",
        workspace: this.workspace,
        networks: container.networks ?? [this.networkName],
        resources: {},
        lifecycle: { autoStop: false, deleteAfterStop: false },
        createdAt: container.createdAt ?? nowIso(this.now()),
        activeConnections: 0,
        runtimeRef: container.ref,
      };

      await this.repository.save(record);
      this.logger.warn(
        { event: "container.reconcile.adopted", containerId, runtimeRef: container.ref },
        "adopted a managed container that had no persisted record",
      );
    }
  }

  private async require(id: string): Promise<ContainerRecord> {
    const record = await this.repository.get(id);
    if (record === undefined) {
      throw new SessionBoxError("CONTAINER_NOT_FOUND", `container ${id} was not found`);
    }
    return record;
  }

  private requireRef(record: ContainerRecord): string {
    if (record.runtimeRef === undefined) {
      throw new SessionBoxError(
        "RUNTIME_ERROR",
        "container has no runtime handle (creation may have failed)",
      );
    }
    return record.runtimeRef;
  }

  private toPublicRuntimeError(error: unknown, action: string): SessionBoxError {
    const message = `failed to ${action}; see server logs`;
    this.logger.error(
      { event: "container.operation.failed", action, err: errorMessage(error) },
      message,
    );

    if (error instanceof RuntimeNotFoundError) {
      return new SessionBoxError("CONTAINER_NOT_FOUND", "container was not found in the container runtime", {
        cause: error,
      });
    }
    return new SessionBoxError("RUNTIME_ERROR", message, { cause: error });
  }

  /**
   * Serializes operations per container so concurrent start/stop/delete calls
   * cannot interleave (PROJECT.md §38). Operations on different containers run
   * concurrently.
   */
  private withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(id) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );

    this.chains.set(id, tail);
    void tail.then(() => {
      if (this.chains.get(id) === tail) this.chains.delete(id);
    });

    return run;
  }
}

function defaultName(id: string): string {
  return `container-${id.slice(4, 10).toLowerCase()}`;
}

/** Per-container network name; private networks are hidden from the API. */
function privateNetworkName(id: string): string {
  return `net-${id}`;
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function applyLifecyclePatch(
  base: LifecyclePolicy,
  patch: LifecyclePolicyPatch,
): LifecyclePolicy {
  const next: LifecyclePolicy = { ...base };

  if (patch.autoStop !== undefined) next.autoStop = patch.autoStop;
  if (patch.deleteAfterStop !== undefined) next.deleteAfterStop = patch.deleteAfterStop;

  for (const key of ["idleTimeoutSeconds", "maxLifetimeSeconds"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }

  return next;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
