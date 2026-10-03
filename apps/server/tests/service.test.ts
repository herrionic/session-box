import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/credentials/store.ts";
import { SessionBoxError } from "../src/errors.ts";
import { InMemorySandboxRepository } from "../src/sandbox/repository.ts";
import { SandboxService } from "../src/sandbox/service.ts";
import { toPublicSandbox } from "../src/sandbox/types.ts";
import { SSH_PRIVATE_KEY_CREDENTIAL } from "../src/ssh/keypair.ts";
import { SshSessionManager } from "../src/ssh/manager.ts";
import { FakeRuntime } from "./helpers/fake-runtime.ts";
import { FakeSshSessionFactory } from "./helpers/fake-ssh.ts";
import { createTestLogger } from "./helpers/test-logger.ts";

const TEST_MASTER_KEY = Buffer.alloc(32, 7);

function createFixture(options: { masterKey?: Buffer | null } = {}): {
  runtime: FakeRuntime;
  repository: InMemorySandboxRepository;
  credentials: InMemoryCredentialStore;
  ssh: FakeSshSessionFactory;
  service: SandboxService;
} {
  const masterKey =
    options.masterKey === undefined ? TEST_MASTER_KEY : (options.masterKey ?? undefined);

  const runtime = new FakeRuntime();
  const repository = new InMemorySandboxRepository();
  const credentials = new InMemoryCredentialStore(masterKey);
  const logger = createTestLogger();
  const ssh = new FakeSshSessionFactory();
  const service = new SandboxService({
    runtime,
    repository,
    credentials,
    ssh,
    sessions: new SshSessionManager(ssh, logger),
    logger,
    baseImage: "sessionbox/base:test",
    workspace: "/workspace",
    sshReadyTimeoutMs: 50,
    sshRetryIntervalMs: 1,
    sleep: async () => {},
  });

  return { runtime, repository, credentials, ssh, service };
}

describe("SandboxService.create", () => {
  it("creates a running sandbox with defaults", async () => {
    const { service, runtime } = createFixture();

    const record = await service.create({});

    expect(record.status).toBe("running");
    expect(record.image).toBe("sessionbox/base:test");
    expect(record.runtime).toBe("fake");
    expect(record.workspace).toBe("/workspace");
    expect(record.name).toMatch(/^sandbox-[0-9a-z]{6}$/);
    expect(record.lifecycle).toEqual({ autoStop: false, deleteAfterStop: false });
    expect(record.runtimeRef).toBe(`fake_${record.id}`);
    expect(runtime.containers.get(record.runtimeRef!)?.status).toBe("running");
    expect(runtime.createCalls[0]?.sandboxId).toBe(record.id);
  });

  it("stores an encrypted private key and injects only the public key", async () => {
    const { service, runtime, credentials } = createFixture();

    const record = await service.create({});

    const publicKey = runtime.createCalls[0]?.env?.SESSIONBOX_AUTHORIZED_KEY;
    expect(publicKey).toMatch(/^ssh-ed25519 /);

    const stored = await credentials.read(record.id, SSH_PRIVATE_KEY_CREDENTIAL);
    expect(stored).toContain("PRIVATE KEY");
    expect(stored).not.toBe(publicKey);
  });

  it("honours requested name, image, resources and lifecycle", async () => {
    const { service } = createFixture();

    const record = await service.create({
      name: "agent-workspace",
      image: "custom/base:1",
      resources: { cpuLimit: 2, memoryLimitMb: 2048 },
      lifecycle: { autoStop: true, idleTimeoutSeconds: 300 },
    });

    expect(record.name).toBe("agent-workspace");
    expect(record.image).toBe("custom/base:1");
    expect(record.resources).toEqual({ cpuLimit: 2, memoryLimitMb: 2048 });
    expect(record.lifecycle).toEqual({
      autoStop: true,
      idleTimeoutSeconds: 300,
      deleteAfterStop: false,
    });
  });

  it("marks the sandbox failed when the runtime cannot create it", async () => {
    const { service, runtime } = createFixture();
    runtime.failNextCreate = true;

    await expect(service.create({})).rejects.toMatchObject({ code: "SANDBOX_CREATE_FAILED" });

    const records = await service.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("failed");
    expect(records[0]?.runtimeRef).toBeUndefined();
  });

  it("keeps the runtime handle when the container starts but fails", async () => {
    const { service, runtime } = createFixture();
    runtime.failNextStart = true;

    await expect(service.create({})).rejects.toMatchObject({ code: "SANDBOX_CREATE_FAILED" });

    const records = await service.list();
    expect(records[0]?.status).toBe("failed");
    expect(records[0]?.runtimeRef).toBe(`fake_${records[0]?.id}`);
  });

  it("fails the sandbox when SSH never becomes ready", async () => {
    const { service, ssh } = createFixture();
    ssh.alwaysFail = true;

    await expect(service.create({})).rejects.toMatchObject({ code: "SANDBOX_CREATE_FAILED" });

    const records = await service.list();
    expect(records[0]?.status).toBe("failed");
    expect(ssh.requests.length).toBeGreaterThan(0);
  });

  it("surfaces missing master keys as a configuration error", async () => {
    const { service } = createFixture({ masterKey: null });

    await expect(service.create({})).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
});

describe("SandboxService lifecycle", () => {
  it("stops, starts and restarts a sandbox", async () => {
    const { service, runtime } = createFixture();
    const record = await service.create({});
    const ref = record.runtimeRef;

    const stopped = await service.stop(record.id);
    expect(stopped.status).toBe("stopped");
    expect(runtime.containers.get(ref!)?.status).toBe("stopped");

    const started = await service.start(record.id);
    expect(started.status).toBe("running");
    expect(started.stoppedAt).toBeUndefined();

    const restarted = await service.restart(record.id);
    expect(restarted.status).toBe("running");
  });

  it("rejects operations that are invalid for the current status", async () => {
    const { service } = createFixture();
    const record = await service.create({});

    await expect(service.start(record.id)).rejects.toMatchObject({ code: "INVALID_STATE" });

    // restart is allowed while running
    const restarted = await service.restart(record.id);
    expect(restarted.status).toBe("running");

    await service.stop(record.id);
    await expect(service.stop(record.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("rejects unknown sandbox ids", async () => {
    const { service } = createFixture();
    await expect(service.get("sbx_missing")).rejects.toBeInstanceOf(SessionBoxError);
    await expect(service.stop("sbx_missing")).rejects.toMatchObject({ code: "SANDBOX_NOT_FOUND" });
  });

  it("serializes concurrent operations on the same sandbox", async () => {
    const { service } = createFixture();
    const record = await service.create({});
    await service.stop(record.id);

    const results = await Promise.allSettled([service.start(record.id), service.start(record.id)]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const reason = (rejected[0] as PromiseRejectedResult).reason as SessionBoxError;
    expect(reason.code).toBe("INVALID_STATE");
  });

  it("deletes the sandbox record and its container", async () => {
    const { service, runtime } = createFixture();
    const record = await service.create({});
    const ref = record.runtimeRef;

    await service.remove(record.id);

    expect(runtime.containers.has(ref!)).toBe(false);
    await expect(service.get(record.id)).rejects.toMatchObject({ code: "SANDBOX_NOT_FOUND" });
  });

  it("removes stored credentials when a sandbox is deleted", async () => {
    const { service, credentials } = createFixture();
    const record = await service.create({});
    expect(await credentials.read(record.id, SSH_PRIVATE_KEY_CREDENTIAL)).toBeDefined();

    await service.remove(record.id);

    expect(await credentials.read(record.id, SSH_PRIVATE_KEY_CREDENTIAL)).toBeUndefined();
  });

  it("keeps the record and surfaces a runtime error when deletion fails", async () => {
    const { service, runtime } = createFixture();
    const record = await service.create({});
    runtime.failNextRemove = true;

    await expect(service.remove(record.id)).rejects.toMatchObject({ code: "RUNTIME_ERROR" });

    const after = await service.get(record.id);
    expect(after.status).toBe("failed");
  });

  it("returns runtime logs", async () => {
    const { service } = createFixture();
    const record = await service.create({});
    await expect(service.logs(record.id)).resolves.toBe("fake logs");
  });
});

describe("SandboxService settings", () => {
  it("renames a sandbox and patches lifecycle policy", async () => {
    const { service } = createFixture();
    const record = await service.create({});

    const updated = await service.updateSettings(record.id, {
      name: "renamed",
      lifecycle: { idleTimeoutSeconds: 600, autoStop: true },
    });

    expect(updated.name).toBe("renamed");
    expect(updated.lifecycle).toEqual({
      autoStop: true,
      idleTimeoutSeconds: 600,
      deleteAfterStop: false,
    });
  });

  it("clears a timeout with null", async () => {
    const { service } = createFixture();
    const record = await service.create({ lifecycle: { idleTimeoutSeconds: 60 } });

    const cleared = await service.updateSettings(record.id, {
      lifecycle: { idleTimeoutSeconds: null },
    });

    expect(cleared.lifecycle.idleTimeoutSeconds).toBeUndefined();
  });
});

describe("SandboxService.reconcile", () => {
  it("syncs status changes made outside the server", async () => {
    const { service, runtime } = createFixture();
    const record = await service.create({});

    runtime.containers.get(record.runtimeRef!)!.status = "stopped";
    await service.reconcile();

    expect((await service.get(record.id)).status).toBe("stopped");
  });

  it("marks sandboxes whose container disappeared as failed", async () => {
    const { service, runtime } = createFixture();
    const record = await service.create({});

    runtime.containers.delete(record.runtimeRef!);
    await service.reconcile();

    expect((await service.get(record.id)).status).toBe("failed");
  });

  it("does nothing when there are no persisted sandboxes", async () => {
    const { service } = createFixture();
    await expect(service.reconcile()).resolves.toBeUndefined();
  });
});

describe("public projection", () => {
  it("never exposes the runtime handle", async () => {
    const { service } = createFixture();
    const record = await service.create({});
    const publicSandbox = toPublicSandbox(record);

    expect(publicSandbox).not.toHaveProperty("runtimeRef");
    expect(Object.keys(publicSandbox).sort()).toEqual(
      [
        "activeConnections",
        "createdAt",
        "id",
        "image",
        "lifecycle",
        "name",
        "resources",
        "runtime",
        "startedAt",
        "status",
        "workspace",
      ].sort(),
    );
  });
});
