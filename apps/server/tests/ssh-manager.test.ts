import { describe, expect, it, vi } from "vitest";
import { SshSessionManager } from "../src/ssh/manager.ts";
import { SshError } from "../src/ssh/session.ts";
import { FakeSshSessionFactory } from "./helpers/fake-ssh.ts";
import { createTestLogger } from "./helpers/test-logger.ts";

const request = { sandboxId: "sbx_1", runtimeRef: "ref_1" };

describe("SshSessionManager", () => {
  it("caches one session per sandbox", async () => {
    const factory = new FakeSshSessionFactory();
    const createSpy = vi.spyOn(factory, "create");
    const manager = new SshSessionManager(factory, createTestLogger());

    const first = await manager.get(request);
    const second = await manager.get(request);

    expect(first).toBe(second);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("does not cache failed connections", async () => {
    const factory = new FakeSshSessionFactory();
    factory.failuresBeforeSuccess = 1;
    const manager = new SshSessionManager(factory, createTestLogger());

    await expect(manager.get(request)).rejects.toBeInstanceOf(SshError);
    await expect(manager.get(request)).resolves.toBeDefined();
    expect(factory.requests).toHaveLength(2);
  });

  it("drops the session when an operation fails with an SSH error", async () => {
    const factory = new FakeSshSessionFactory();
    const manager = new SshSessionManager(factory, createTestLogger());

    await expect(
      manager.withSession(request, async () => {
        throw new SshError("broken pipe");
      }),
    ).rejects.toBeInstanceOf(SshError);

    expect(factory.session.closed).toBe(true);

    const session = await manager.withSession(request, async (value) => value);
    expect(session).toBe(factory.session);
    expect(factory.requests).toHaveLength(2);
  });

  it("release closes and forgets the session", async () => {
    const factory = new FakeSshSessionFactory();
    const manager = new SshSessionManager(factory, createTestLogger());

    await manager.get(request);
    await manager.release("sbx_1");

    expect(factory.session.closed).toBe(true);

    await manager.get(request);
    expect(factory.requests).toHaveLength(2);
  });
});
