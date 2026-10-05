import { describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/credentials/store.ts";
import { generateSshKeyPair, SSH_PRIVATE_KEY_CREDENTIAL } from "../src/ssh/keypair.ts";
import { SshError } from "../src/ssh/session.ts";
import { Ssh2SessionFactory } from "../src/ssh/ssh2-session.ts";
import { FakeRuntime } from "./helpers/fake-runtime.ts";
import { createTestLogger } from "./helpers/test-logger.ts";

const TEST_MASTER_KEY = Buffer.alloc(32, 9);

function createFactory(credentials: InMemoryCredentialStore) {
  const runtime = new FakeRuntime();
  const openPortStream = vi.spyOn(runtime, "openPortStream");
  const factory = new Ssh2SessionFactory({
    runtime,
    credentials,
    logger: createTestLogger(),
    connectTimeoutMs: 50,
  });
  return { factory, openPortStream };
}

describe("Ssh2SessionFactory", () => {
  it("fails without touching the runtime when no credential is stored", async () => {
    const { factory, openPortStream } = createFactory(new InMemoryCredentialStore(TEST_MASTER_KEY));

    await expect(
      factory.create({ containerId: "ctr_1", runtimeRef: "fake_ctr_1" }),
    ).rejects.toBeInstanceOf(SshError);

    expect(openPortStream).not.toHaveBeenCalled();
  });

  it("opens the runtime transport when a credential is stored", async () => {
    const credentials = new InMemoryCredentialStore(TEST_MASTER_KEY);
    await credentials.save("ctr_1", SSH_PRIVATE_KEY_CREDENTIAL, generateSshKeyPair().privateKey);

    const { factory, openPortStream } = createFactory(credentials);

    // The fake transport is not an SSH server, so the handshake fails; what
    // matters here is that the factory asked the runtime for the stream.
    await expect(
      factory.create({ containerId: "ctr_1", runtimeRef: "fake_ctr_1" }),
    ).rejects.toBeInstanceOf(SshError);

    expect(openPortStream).toHaveBeenCalledWith("fake_ctr_1", 22);
  });
});
