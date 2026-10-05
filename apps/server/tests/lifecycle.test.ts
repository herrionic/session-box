import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/credentials/store.ts";
import { LifecycleService } from "../src/lifecycle/service.ts";
import { InMemorySandboxRepository } from "../src/sandbox/repository.ts";
import { SandboxService } from "../src/sandbox/service.ts";
import { SshSessionManager } from "../src/ssh/manager.ts";
import { FakeRuntime } from "./helpers/fake-runtime.ts";
import { FakeSshSessionFactory } from "./helpers/fake-ssh.ts";
import { createTestLogger } from "./helpers/test-logger.ts";

function createFixture(): {
  service: SandboxService;
  runtime: FakeRuntime;
  lifecycle: LifecycleService;
  setNow: (value: number) => void;
} {
  const runtime = new FakeRuntime();
  const logger = createTestLogger();
  const ssh = new FakeSshSessionFactory();

  let now = Date.now();

  const service = new SandboxService({
    runtime,
    repository: new InMemorySandboxRepository(),
    credentials: new InMemoryCredentialStore(Buffer.alloc(32, 21)),
    ssh,
    sessions: new SshSessionManager(ssh, logger),
    logger,
    baseImage: "sessionbox/base:test",
    workspace: "/workspace",
    sshReadyTimeoutMs: 50,
    sshRetryIntervalMs: 1,
    sleep: async () => {},
    now: () => now,
  });

  const lifecycle = new LifecycleService({
    sandboxes: service,
    logger,
    now: () => now,
  });

  return {
    service,
    runtime,
    lifecycle,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("LifecycleService", () => {
  it("auto-stops an idle sandbox after the idle timeout", async () => {
    const { service, runtime, lifecycle, setNow } = createFixture();
    const record = await service.create({
      lifecycle: { autoStop: true, idleTimeoutSeconds: 60 },
    });

    setNow(Date.now() + 61_000);
    await lifecycle.runOnce();

    expect((await service.get(record.id)).status).toBe("stopped");
    expect(runtime.containers.get(record.runtimeRef!)?.status).toBe("stopped");
  });

  it("keeps a sandbox alive while a connection is active", async () => {
    const { service, lifecycle, setNow } = createFixture();
    const record = await service.create({
      lifecycle: { autoStop: true, idleTimeoutSeconds: 60 },
    });

    await service.acquire(record.id);
    setNow(Date.now() + 3600_000);
    await lifecycle.runOnce();

    expect((await service.get(record.id)).status).toBe("running");
  });

  it("auto-stops a sandbox that exceeded its maximum lifetime", async () => {
    const { service, lifecycle, setNow } = createFixture();
    const record = await service.create({
      lifecycle: { autoStop: true, maxLifetimeSeconds: 30 },
    });

    setNow(Date.now() + 31_000);
    await lifecycle.runOnce();

    expect((await service.get(record.id)).status).toBe("stopped");
  });

  it("deletes the sandbox after stopping when configured", async () => {
    const { service, runtime, lifecycle, setNow } = createFixture();
    const record = await service.create({
      lifecycle: { autoStop: true, idleTimeoutSeconds: 10, deleteAfterStop: true },
    });
    const ref = record.runtimeRef;

    setNow(Date.now() + 11_000);
    await lifecycle.runOnce();

    await expect(service.get(record.id)).rejects.toMatchObject({ code: "SANDBOX_NOT_FOUND" });
    expect(runtime.containers.has(ref!)).toBe(false);
  });

  it("does nothing when auto-stop is disabled", async () => {
    const { service, lifecycle, setNow } = createFixture();
    const record = await service.create({
      lifecycle: { autoStop: false, idleTimeoutSeconds: 1 },
    });

    setNow(Date.now() + 3600_000);
    await lifecycle.runOnce();

    expect((await service.get(record.id)).status).toBe("running");
  });

  it("records activity so idle detection restarts", async () => {
    const { service, lifecycle, setNow } = createFixture();
    const record = await service.create({
      lifecycle: { autoStop: true, idleTimeoutSeconds: 60 },
    });

    setNow(Date.now() + 30_000);
    await service.touch(record.id);

    setNow(Date.now() + 61_000);
    await lifecycle.runOnce();
    expect((await service.get(record.id)).status).toBe("running");

    setNow(Date.now() + 122_000);
    await lifecycle.runOnce();
    expect((await service.get(record.id)).status).toBe("stopped");
  });
});
