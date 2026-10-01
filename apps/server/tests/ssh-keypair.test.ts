import { utils } from "ssh2";
import { describe, expect, it } from "vitest";
import { generateSshKeyPair } from "../src/ssh/keypair.ts";

describe("generateSshKeyPair", () => {
  it("emits an OpenSSH private key that ssh2 can parse", () => {
    const pair = generateSshKeyPair();

    expect(pair.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");

    const parsed = utils.parseKey(pair.privateKey);
    expect(parsed).not.toBeInstanceOf(Error);
    expect(Array.isArray(parsed)).toBe(false);
  });

  it("derives the same public key that is injected into the sandbox", () => {
    const pair = generateSshKeyPair();
    const parsed = utils.parseKey(pair.privateKey);

    if (parsed instanceof Error || Array.isArray(parsed)) {
      throw new Error("generated private key could not be parsed");
    }

    const publicLineBlob = Buffer.from(pair.publicKey.split(" ")[1] ?? "", "base64");
    expect(parsed.getPublicSSH().equals(publicLineBlob)).toBe(true);
    expect(pair.publicKey.startsWith("ssh-ed25519 ")).toBe(true);
  });

  it("generates a fresh pair every time", () => {
    const first = generateSshKeyPair();
    const second = generateSshKeyPair();
    expect(first.privateKey).not.toBe(second.privateKey);
    expect(first.publicKey).not.toBe(second.publicKey);
  });
});
