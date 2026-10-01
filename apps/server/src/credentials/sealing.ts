import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { SessionBoxError } from "../errors.ts";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

/**
 * Seals a secret with AES-256-GCM. The returned string carries everything
 * needed to open it except the master key: version.iv.tag.ciphertext
 * (all binary parts base64url encoded).
 */
export function seal(plaintext: string, masterKey: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function open(sealed: string, masterKey: Buffer): string {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SessionBoxError("INTERNAL_ERROR", "credential blob has an unsupported format");
  }

  const [, ivPart, tagPart, dataPart] = parts;
  if (ivPart === undefined || tagPart === undefined || dataPart === undefined) {
    throw new SessionBoxError("INTERNAL_ERROR", "credential blob is malformed");
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, masterKey, Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw new SessionBoxError(
      "INTERNAL_ERROR",
      "credential could not be decrypted (wrong master key or corrupted data)",
      { cause: error },
    );
  }
}
