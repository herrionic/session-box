import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseMasterKey, requireMasterKey } from "../src/credentials/master-key.ts";
import { open, seal } from "../src/credentials/sealing.ts";
import { InMemoryCredentialStore } from "../src/credentials/store.ts";
import { SessionBoxError } from "../src/errors.ts";

const masterKey = randomBytes(32);
const otherKey = randomBytes(32);
const validBase64Key = randomBytes(32).toString("base64");

describe("master key", () => {
  it("parses a base64 32-byte key", () => {
    const key = parseMasterKey(validBase64Key);
    expect(key?.length).toBe(32);
  });

  it("returns undefined when not configured", () => {
    expect(parseMasterKey(undefined)).toBeUndefined();
    expect(parseMasterKey("   ")).toBeUndefined();
  });

  it("rejects keys of the wrong length", () => {
    expect(() => parseMasterKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });

  it("requireMasterKey fails closed", () => {
    expect(() => requireMasterKey(undefined)).toThrow(SessionBoxError);
  });
});

describe("sealing", () => {
  it("round-trips plaintext", () => {
    const sealed = seal("ssh-private-key-content", masterKey);
    expect(open(sealed, masterKey)).toBe("ssh-private-key-content");
  });

  it("uses a random IV per seal", () => {
    expect(seal("same", masterKey)).not.toBe(seal("same", masterKey));
  });

  it("fails with the wrong key", () => {
    const sealed = seal("secret", masterKey);
    expect(() => open(sealed, otherKey)).toThrow(/could not be decrypted/);
  });

  it("fails on tampered ciphertext", () => {
    const sealed = seal("secret", masterKey);
    const parts = sealed.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.${Buffer.from("tampered").toString("base64url")}`;
    expect(() => open(tampered, masterKey)).toThrow(SessionBoxError);
  });

  it("rejects malformed blobs", () => {
    expect(() => open("not-a-blob", masterKey)).toThrow(/unsupported format/);
    expect(() => open("v1.a.b", masterKey)).toThrow(/unsupported format/);
  });
});

describe("credential store", () => {
  it("stores encrypted entries and reads them back", async () => {
    const store = new InMemoryCredentialStore(masterKey);

    await store.save("sbx_1", "ssh-private-key", "PRIVATE");
    await store.save("sbx_2", "ssh-private-key", "OTHER");

    expect(await store.read("sbx_1", "ssh-private-key")).toBe("PRIVATE");
    expect(await store.read("sbx_2", "ssh-private-key")).toBe("OTHER");
    expect(await store.read("sbx_1", "missing")).toBeUndefined();
  });

  it("removes entries", async () => {
    const store = new InMemoryCredentialStore(masterKey);
    await store.save("sbx_1", "a", "1");
    await store.save("sbx_1", "b", "2");
    await store.save("sbx_2", "a", "3");

    await store.remove("sbx_1", "a");
    expect(await store.read("sbx_1", "a")).toBeUndefined();
    expect(await store.read("sbx_1", "b")).toBe("2");

    await store.removeAll("sbx_1");
    expect(await store.read("sbx_1", "b")).toBeUndefined();
    expect(await store.read("sbx_2", "a")).toBe("3");
  });

  it("refuses to store credentials without a master key", async () => {
    const store = new InMemoryCredentialStore(undefined);
    await expect(store.save("sbx_1", "ssh-private-key", "PRIVATE")).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });
});
