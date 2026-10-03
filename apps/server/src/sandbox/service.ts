import {
  resolveLifecyclePolicy,
  type CreateSandboxRequest,
  type LifecyclePolicy,
  type LifecyclePolicyPatch,
  type SandboxStatus,
  type UpdateSandboxSettingsRequest,
} from "@sessionbox/protocol";
import { newSandboxId, nowIso } from "@sessionbox/shared";
import type { CredentialStore } from "../credentials/store.ts";
import { SessionBoxError } from "../errors.ts";
import type { Logger } from "../logging.ts";
import { RuntimeNotFoundError, type SandboxRuntime } from "../runtime/types.ts";
import { generateSshKeyPair, SSH_PRIVATE_KEY_CREDENTIAL } from "../ssh/keypair.ts";
import type { SshSessionManager } from "../ssh/manager.ts";
import { waitForSsh } from "../ssh/readiness.ts";
import type { SshSession, SshSessionFactory } from "../ssh/session.ts";
import type { SandboxRepository } from "./repository.ts";
import { assertOperationAllowed } from "./state.ts";
import type { SandboxRecord } from "./types.ts";

export interface SandboxServiceOptions {
  runtime: SandboxRuntime;
  repository: SandboxRepository;
  credentials: CredentialStore;
  ssh: SshSessionFactory;
  sessions: SshSessionManager;
  logger: Logger;
  baseImage: string;
  workspace: string;
  /** How long to wait for sshd inside a new sandbox before failing. */
  sshReadyTimeoutMs?: number;
  sshRetryIntervalMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Owns sandbox lifecycle and state transitions. Depends only on the
 * `SandboxRuntime` seam, never on a concrete runtime SDK.
 */
export class SandboxService {
  private readonly runtime: SandboxRuntime;
  private readonly repository: SandboxRepository;
  private readonly credentials: CredentialStore;
  private readonly ssh: SshSessionFactory;
  private readonly sessions: SshSessionManager;
  private readonly logger: Logger;
  private readonly baseImage: string;
  private readonly workspace: string;
  private readonly sshReadyTimeoutMs: number;
  private readonly sshRetryIntervalMs: number;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  /** Per-sandbox operation chains: serializes concurrent state changes. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(options: SandboxServiceOptions) {
    this.runtime = options.runtime;
    this.repository = options.repository;
    this.credentials = options.credentials;
    this.ssh = options.ssh;
    this.sessions = options.sessions;
    this.logger = options.logger;
    this.baseImage = options.baseImage;
    this.workspace = options.workspace;
    this.sshReadyTimeoutMs = options.sshReadyTimeoutMs ?? 30_000;
    this.sshRetryIntervalMs = options.sshRetryIntervalMs ?? 500;
    this.sleep = options.sleep;
  }

  async create(request: CreateSandboxRequest): Promise<SandboxRecord> {
    const id = newSandboxId();
    const record: SandboxRecord = {
      id,
      name: request.name ?? defaultName(id),
      image: request.image ?? this.baseImage,
      runtime: this.runtime.runtimeId,
      status: "creating",
      workspace: this.workspace,
      resources: request.resources ?? {},
      lifecycle: resolveLifecyclePolicy(request.lifecycle),
      createdAt: nowIso(),
      activeConnections: 0,
    };

    await this.repository.save(record);
    this.logger.info({ event: "sandbox.create.requested", sandboxId: id }, "sandbox creation requested");

    try {
      await this.runtime.ensureImage(record.image);

      // One ephemeral SSH keypair per sandbox: the private key stays encrypted
      // in the credential store, only the public key is injected into the
      // container (PROJECT.md §14).
      const keyPair = generateSshKeyPair();
      await this.credentials.save(id, SSH_PRIVATE_KEY_CREDENTIAL, keyPair.privateKey);

      const created = await this.runtime.create({
        sandboxId: id,
        name: record.name,
        image: record.image,
        workspace: record.workspace,
        resources: record.resources,
        env: { SESSIONBOX_AUTHORIZED_KEY: keyPair.publicKey },
      });
      record.runtimeRef = created.ref;

      await this.runtime.start(created.ref);
      await waitForSsh({
        factory: this.ssh,
        sandboxId: id,
        runtimeRef: created.ref,
        timeoutMs: this.sshReadyTimeoutMs,
        intervalMs: this.sshRetryIntervalMs,
        ...(this.sleep !== undefined ? { sleep: this.sleep } : {}),
      });

      record.status = "running";
      record.startedAt = nowIso();
      await this.repository.save(record);

      this.logger.info({ event: "sandbox.created", sandboxId: id }, "sandbox created");
      return record;
    } catch (error) {
      record.status = "failed";
      await this.repository.save(record);
      this.logger.error(
        { event: "sandbox.failed", sandboxId: id, err: errorMessage(error) },
        "sandbox creation failed",
      );
      // Configuration errors (for example a missing master key) must not be
      // disguised as runtime failures.
      if (error instanceof SessionBoxError && error.code === "INTERNAL_ERROR") throw error;
      throw new SessionBoxError(
        "SANDBOX_CREATE_FAILED",
        "failed to create the sandbox; see server logs",
        { cause: error },
      );
    }
  }

  async list(): Promise<SandboxRecord[]> {
    return this.repository.list();
  }

  async get(id: string): Promise<SandboxRecord> {
    return this.require(id);
  }

  async start(id: string): Promise<SandboxRecord> {
    return this.withLock(id, async () => {
      const record = await this.require(id);
      assertOperationAllowed("start", record.status);

      const ref = this.requireRef(record);
      try {
        await this.runtime.start(ref);
      } catch (error) {
        throw this.toPublicRuntimeError(error, "start the sandbox");
      }

      record.status = "running";
      record.startedAt = nowIso();
      record.stoppedAt = undefined;
      await this.repository.save(record);
      await this.sessions.release(id);

      this.logger.info({ event: "sandbox.started", sandboxId: id }, "sandbox started");
      return record;
    });
  }

  async stop(id: string): Promise<SandboxRecord> {
    return this.withLock(id, async () => {
      const record = await this.require(id);
      assertOperationAllowed("stop", record.status);

      const ref = this.requireRef(record);
      try {
        await this.runtime.stop(ref);
      } catch (error) {
        throw this.toPublicRuntimeError(error, "stop the sandbox");
      }

      record.status = "stopped";
      record.stoppedAt = nowIso();
      await this.repository.save(record);
      await this.sessions.release(id);

      this.logger.info({ event: "sandbox.stopped", sandboxId: id }, "sandbox stopped");
      return record;
    });
  }

  async restart(id: string): Promise<SandboxRecord> {
    return this.withLock(id, async () => {
      const record = await this.require(id);
      assertOperationAllowed("restart", record.status);

      const ref = this.requireRef(record);
      try {
        await this.runtime.restart(ref);
      } catch (error) {
        throw this.toPublicRuntimeError(error, "restart the sandbox");
      }

      record.status = "running";
      record.startedAt = nowIso();
      record.stoppedAt = undefined;
      await this.repository.save(record);
      await this.sessions.release(id);

      this.logger.info({ event: "sandbox.restarted", sandboxId: id }, "sandbox restarted");
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
          throw this.toPublicRuntimeError(error, "delete the sandbox");
        }
      }

      await this.credentials.removeAll(id);
      await this.repository.delete(id);
      this.logger.info({ event: "sandbox.deleted", sandboxId: id }, "sandbox deleted");
    });
  }

  async updateSettings(
    id: string,
    patch: UpdateSandboxSettingsRequest,
  ): Promise<SandboxRecord> {
    return this.withLock(id, async () => {
      const record = await this.require(id);

      if (patch.name !== undefined) record.name = patch.name;
      if (patch.lifecycle !== undefined) {
        record.lifecycle = applyLifecyclePatch(record.lifecycle, patch.lifecycle);
      }

      await this.repository.save(record);
      this.logger.info({ event: "sandbox.settings.updated", sandboxId: id }, "sandbox settings updated");
      return record;
    });
  }

  async logs(id: string, options: { tailLines?: number } = {}): Promise<string> {
    const record = await this.require(id);
    const ref = this.requireRef(record);
    try {
      return await this.runtime.logs(ref, options);
    } catch (error) {
      throw this.toPublicRuntimeError(error, "read the sandbox logs");
    }
  }

  /**
   * Opens (or reuses) an SSH session for a running sandbox. Shared by the file
   * manager, the web terminal and (later) the agent gateway.
   */
  async withSshSession<T>(id: string, operation: (session: SshSession) => Promise<T>): Promise<T> {
    const record = await this.require(id);
    if (record.status !== "running") {
      throw new SessionBoxError(
        "SANDBOX_NOT_RUNNING",
        `sandbox is ${record.status}; start it first`,
      );
    }
    const ref = this.requireRef(record);
    return this.sessions.withSession({ sandboxId: id, runtimeRef: ref }, operation);
  }

  /**
   * Returns the cached SSH session for a running sandbox. The web terminal
   * holds its own shell channel on this session.
   */
  async openSshSession(id: string): Promise<SshSession> {
    const record = await this.require(id);
    if (record.status !== "running") {
      throw new SessionBoxError(
        "SANDBOX_NOT_RUNNING",
        `sandbox is ${record.status}; start it first`,
      );
    }
    const ref = this.requireRef(record);
    return this.sessions.get({ sandboxId: id, runtimeRef: ref });
  }

  /** Releases every cached SSH session (used on server shutdown). */
  async close(): Promise<void> {
    await this.sessions.releaseAll();
  }

  /**
   * Reconciles persisted state with the runtime after a server restart
   * (PROJECT.md §33). Containers that disappeared are marked `failed`;
   * containers that were started/stopped externally are synced.
   */
  async reconcile(): Promise<void> {
    const records = await this.repository.list();
    if (records.length === 0) return;

    const runtimeSandboxes = await this.runtime.list();
    const bySandboxId = new Map(
      runtimeSandboxes
        .filter((sandbox) => sandbox.sandboxId !== undefined)
        .map((sandbox) => [sandbox.sandboxId as string, sandbox]),
    );

    for (const record of records) {
      if (record.runtimeRef === undefined) continue;

      const actual = bySandboxId.get(record.id);
      if (actual === undefined) {
        if (record.status !== "failed") {
          record.status = "failed";
          await this.repository.save(record);
          await this.sessions.release(record.id);
          this.logger.warn(
            { event: "sandbox.reconcile.missing", sandboxId: record.id },
            "sandbox container disappeared from the runtime",
          );
        }
        continue;
      }

      const status: SandboxStatus = actual.status === "running" ? "running" : "stopped";
      if (record.status !== status) {
        record.status = status;
        if (actual.startedAt !== undefined) record.startedAt = actual.startedAt;
        await this.repository.save(record);
        if (status === "stopped") await this.sessions.release(record.id);
        this.logger.info(
          { event: "sandbox.reconcile.status", sandboxId: record.id, status },
          "sandbox status reconciled from the runtime",
        );
      }
    }
  }

  private async require(id: string): Promise<SandboxRecord> {
    const record = await this.repository.get(id);
    if (record === undefined) {
      throw new SessionBoxError("SANDBOX_NOT_FOUND", `sandbox ${id} was not found`);
    }
    return record;
  }

  private requireRef(record: SandboxRecord): string {
    if (record.runtimeRef === undefined) {
      throw new SessionBoxError(
        "RUNTIME_ERROR",
        "sandbox has no runtime handle (creation may have failed)",
      );
    }
    return record.runtimeRef;
  }

  private toPublicRuntimeError(error: unknown, action: string): SessionBoxError {
    const message = `failed to ${action}; see server logs`;
    this.logger.error(
      { event: "sandbox.operation.failed", action, err: errorMessage(error) },
      message,
    );

    if (error instanceof RuntimeNotFoundError) {
      return new SessionBoxError("SANDBOX_NOT_FOUND", "sandbox was not found in the container runtime", {
        cause: error,
      });
    }
    return new SessionBoxError("RUNTIME_ERROR", message, { cause: error });
  }

  /**
   * Serializes operations per sandbox so concurrent start/stop/delete calls
   * cannot interleave (PROJECT.md §38). Operations on different sandboxes run
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
  return `sandbox-${id.slice(4, 10).toLowerCase()}`;
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
