import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SessionBoxError } from "../errors.ts";
import type { Logger } from "../logging.ts";

const MASTER_KEY_BYTES = 32;

/**
 * Parses SESSIONBOX_MASTER_KEY (base64, 32 bytes). Returns undefined when the
 * key is not configured; throws when it is configured but malformed.
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

export interface MasterKeyOptions {
  /** Raw SESSIONBOX_MASTER_KEY value; wins over the key file when set. */
  raw?: string;
  /** Where the generated key is persisted (inside the data directory). */
  file: string;
  logger: Logger;
}

/**
 * Resolves the master key without any manual setup: environment variable
 * first, then the key file, and a freshly generated key (persisted with 0600)
 * on first start. This is what makes `docker compose up -d` work out of the
 * box; the setup wizard only asks for the owner account.
 */
export function loadOrCreateMasterKey(options: MasterKeyOptions): Buffer {
  const fromEnvironment = parseMasterKey(options.raw);
  if (fromEnvironment !== undefined) return fromEnvironment;

  try {
    const stored = readFileSync(options.file, "utf8").trim();
    const key = parseMasterKey(stored);
    if (key !== undefined) return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const key = randomBytes(MASTER_KEY_BYTES);
  mkdirSync(path.dirname(options.file), { recursive: true });
  writeFileSync(options.file, `${key.toString("base64")}\n`, { mode: 0o600 });
  options.logger.info(
    { event: "server.master_key.generated", file: options.file },
    "generated a master key; keep it together with the data directory",
  );
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
