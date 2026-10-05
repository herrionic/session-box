import { SessionBoxError } from "../errors.ts";

const MASTER_KEY_BYTES = 32;

/**
 * Parses SESSIONBOX_MASTER_KEY (base64, 32 bytes). Returns undefined when the
 * key is not configured; throws when it is configured but malformed.
 *
 * Generate one with:  openssl rand -base64 32
 *                 or:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
export function parseMasterKey(raw: string | undefined): Buffer | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;

  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `SESSIONBOX_MASTER_KEY must be base64-encoded 32 bytes (got ${key.length} bytes)`,
    );
  }
  return key;
}

export function requireMasterKey(key: Buffer | undefined): Buffer {
  if (key === undefined) {
    throw new SessionBoxError(
      "INTERNAL_ERROR",
      "SESSIONBOX_MASTER_KEY is not configured; refusing to store container credentials",
    );
  }
  return key;
}
