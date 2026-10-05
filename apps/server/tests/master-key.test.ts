import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateMasterKey, parseMasterKey } from "../src/credentials/master-key.ts";
import { createTestLogger } from "./helpers/test-logger.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sessionbox-key-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return dir;
}

describe("master key resolution", () => {
  it("prefers the environment variable", async () => {
    const dir = await tempDir();
    const raw = Buffer.alloc(32, 7).toString("base64");

    const key = loadOrCreateMasterKey({
      raw,
      file: join(dir, "master.key"),
      logger: createTestLogger(),
    });

    expect(key).toEqual(Buffer.alloc(32, 7));
  });

  it("generates and persists a key on first start, then reuses it", async () => {
    const dir = await tempDir();
    const file = join(dir, "master.key");

    const first = loadOrCreateMasterKey({ file, logger: createTestLogger() });
    expect(first.length).toBe(32);

    const stored = (await readFile(file, "utf8")).trim();
    expect(parseMasterKey(stored)).toEqual(first);

    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }

    const second = loadOrCreateMasterKey({ file, logger: createTestLogger() });
    expect(second).toEqual(first);
  });

  it("rejects a malformed environment value", async () => {
    const dir = await tempDir();
    expect(() =>
      loadOrCreateMasterKey({
        raw: "not-a-valid-key",
        file: join(dir, "master.key"),
        logger: createTestLogger(),
      }),
    ).toThrow(/32 bytes/);
  });
});
