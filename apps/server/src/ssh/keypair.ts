import { generateKeyPairSync, randomBytes } from "node:crypto";

/** Credential-store entry name for the per-container SSH private key. */
export const SSH_PRIVATE_KEY_CREDENTIAL = "ssh-private-key";

export interface SshKeyPair {
  /** OpenSSH-format private key, stored encrypted and never exposed. */
  privateKey: string;
  /** OpenSSH public key line, injected into the container authorized_keys. */
  publicKey: string;
}

const SSH_ED25519 = Buffer.from("ssh-ed25519", "utf8");
const OPENSSH_MAGIC = Buffer.from("openssh-key-v1\0", "utf8");
const PRIVATE_KEY_LABEL = "OPENSSH PRIVATE KEY";
const BLOCK_SIZE = 8;

/**
 * One ephemeral ed25519 keypair per container.
 *
 * Node generates the key material (standard, testable), then the private key
 * is encoded into the OpenSSH private key format because ssh2 only accepts
 * that format, and the public key is encoded into the OpenSSH wire format for
 * `authorized_keys`. No external ssh-keygen binary is involved.
 */
export function generateSshKeyPair(): SshKeyPair {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });

  if (jwk.d === undefined || jwk.x === undefined) {
    throw new Error("ed25519 key export did not contain the expected JWK fields");
  }

  const seed = Buffer.from(jwk.d, "base64url");
  const publicRaw = Buffer.from(jwk.x, "base64url");

  return {
    privateKey: encodeOpenSshPrivateKey(seed, publicRaw),
    publicKey: encodeOpenSshPublicKey(publicRaw),
  };
}

export function encodeOpenSshPublicKey(publicRaw: Buffer): string {
  const blob = Buffer.concat([sshString(SSH_ED25519), sshString(publicRaw)]);
  return `ssh-ed25519 ${blob.toString("base64")}`;
}

function encodeOpenSshPrivateKey(seed: Buffer, publicRaw: Buffer): string {
  const publicBlob = Buffer.concat([sshString(SSH_ED25519), sshString(publicRaw)]);
  const checkInt = randomBytes(4).readUInt32BE(0);

  const privateSection = Buffer.concat([
    sshUint32(checkInt),
    sshUint32(checkInt),
    sshString(SSH_ED25519),
    sshString(publicRaw),
    // ed25519 private key material is seed || public key (64 bytes).
    sshString(Buffer.concat([seed, publicRaw])),
    sshString(""),
  ]);

  const padded = Buffer.concat([privateSection, paddingFor(privateSection.length)]);

  const blob = Buffer.concat([
    OPENSSH_MAGIC,
    sshString("none"), // ciphername
    sshString("none"), // kdfname
    sshString(""), // kdfoptions
    sshUint32(1), // number of keys
    sshString(publicBlob),
    sshString(padded),
  ]);

  return toPem(PRIVATE_KEY_LABEL, blob);
}

function paddingFor(length: number): Buffer {
  const padLength = BLOCK_SIZE - (length % BLOCK_SIZE);
  const padding = Buffer.alloc(padLength);
  for (let index = 0; index < padLength; index += 1) {
    padding[index] = index + 1;
  }
  return padding;
}

function sshUint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return Buffer.concat([sshUint32(bytes.length), bytes]);
}

function toPem(label: string, der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,70}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
