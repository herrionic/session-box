import { describe, expect, it } from "vitest";
import { waitForSsh } from "../src/ssh/readiness.ts";
import { FakeSshSessionFactory } from "./helpers/fake-ssh.ts";

const noSleep = async (): Promise<void> => {};

describe("waitForSsh", () => {
  it("resolves once a session can be established", async () => {
    const factory = new FakeSshSessionFactory();
    factory.failuresBeforeSuccess = 2;

    await waitForSsh({
      factory,
      containerId: "ctr_1",
      runtimeRef: "fake_ctr_1",
      timeoutMs: 5_000,
      intervalMs: 1,
      sleep: noSleep,
    });

    expect(factory.requests).toHaveLength(3);
    expect(factory.requests[0]).toEqual({ containerId: "ctr_1", runtimeRef: "fake_ctr_1" });
  });

  it("fails with SSH_UNAVAILABLE when the container never becomes ready", async () => {
    const factory = new FakeSshSessionFactory();
    factory.alwaysFail = true;

    await expect(
      waitForSsh({
        factory,
        containerId: "ctr_1",
        runtimeRef: "fake_ctr_1",
        timeoutMs: 0,
        intervalMs: 1,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ code: "SSH_UNAVAILABLE" });
  });
});
