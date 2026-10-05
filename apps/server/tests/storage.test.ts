import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { EncryptedCredentialStore } from "../src/credentials/store.ts";
import { ContainerService } from "../src/container/service.ts";
import { SSH_PRIVATE_KEY_CREDENTIAL } from "../src/ssh/keypair.ts";
import { SshSessionManager } from "../src/ssh/manager.ts";
import { openDatabase, SCHEMA_VERSION } from "../src/storage/database.ts";
import { SqliteContainerRepository } from "../src/storage/container-repository.ts";
import { SqliteSecretRepository } from "../src/storage/secret-repository.ts";
import { FakeRuntime } from "./helpers/fake-runtime.ts";
import { FakeSshSessionFactory } from "./helpers/fake-ssh.ts";
import { createTestLogger } from "./helpers/test-logger.ts";

const TEST_KEY = Buffer.alloc(32, 23);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

async function tempDatabaseFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sessionbox-db-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return join(dir, "sessionbox.db");
}

interface ServiceInstance {
  service: ContainerService;
  credentials: EncryptedCredentialStore;
  close: () => void;
}

function createService(runtime: FakeRuntime, databaseFile: string): ServiceInstance {
  const logger = createTestLogger();
  const ssh = new FakeSshSessionFactory();
  const database = openDatabase(databaseFile);
  const credentials = new EncryptedCredentialStore(TEST_KEY, new SqliteSecretRepository(database));
  const service = new ContainerService({
    runtime,
    repository: new SqliteContainerRepository(database),
    credentials,
    ssh,
    sessions: new SshSessionManager(ssh, logger),
    logger,
    baseImage: "sessionbox/base:test",
    workspace: "/workspace",
    sshReadyTimeoutMs: 50,
    sshRetryIntervalMs: 1,
    sleep: async () => {},
  });

  return { service, credentials, close: () => database.close() };
}

describe("SQLite persistence", () => {
  it("reports schema version 2 and opens idempotently", async () => {
    expect(SCHEMA_VERSION).toBe(3);

    const file = await tempDatabaseFile();
    const first = openDatabase(file);
    first.close();
    const second = openDatabase(file);
    second.close();
  });

  it("migrates a v1 database: the legacy table is renamed to containers", async () => {
    const file = await tempDatabaseFile();
    const raw = new DatabaseSync(file);
    raw.exec(`
      CREATE TABLE sandboxes (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, image TEXT NOT NULL, runtime TEXT NOT NULL,
        status TEXT NOT NULL, workspace TEXT NOT NULL, resources TEXT NOT NULL,
        lifecycle TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, stopped_at TEXT,
        last_activity_at TEXT, active_connections INTEGER NOT NULL DEFAULT 0, runtime_ref TEXT
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_version', '1');
      INSERT INTO sandboxes VALUES (
        'sbx_legacy', 'legacy', 'img', 'docker', 'stopped', '/workspace',
        '{}', '{"autoStop":false,"deleteAfterStop":false}', '2026-01-01T00:00:00.000Z',
        NULL, NULL, NULL, 0, NULL
      );
    `);
    raw.close();

    const migrated = openDatabase(file);
    const rows = migrated.prepare("SELECT id, name FROM containers").all() as Array<{
      id: string;
      name: string;
    }>;
    expect(rows).toEqual([{ id: "sbx_legacy", name: "legacy" }]);

    const version = migrated
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(version.value).toBe("3");
    migrated.close();
  });

  it("keeps containers manageable across a server restart", async () => {
    const runtime = new FakeRuntime();
    const file = await tempDatabaseFile();

    const before = createService(runtime, file);
    const kept = await before.service.create({ name: "kept" });
    const lost = await before.service.create({ name: "lost" });
    const keyBefore = await before.credentials.read(kept.id, SSH_PRIVATE_KEY_CREDENTIAL);
    expect(keyBefore).toBeDefined();
    before.close();

    // The "lost" container disappeared while the server was down.
    runtime.containers.delete(lost.runtimeRef ?? "");

    const after = createService(runtime, file);
    await after.service.reconcile();

    const records = await after.service.list();
    expect(records).toHaveLength(2);
    expect(records.find((record) => record.id === kept.id)?.status).toBe("running");
    expect(records.find((record) => record.id === lost.id)?.status).toBe("failed");

    // The encrypted private key survived the restart.
    expect(await after.credentials.read(kept.id, SSH_PRIVATE_KEY_CREDENTIAL)).toBe(keyBefore);

    // And the container is still manageable.
    await after.service.stop(kept.id);
    expect((await after.service.get(kept.id)).status).toBe("stopped");
    await after.service.start(kept.id);
    expect((await after.service.get(kept.id)).status).toBe("running");

    after.close();
  });

  it("adopts managed containers that have no persisted record", async () => {
    const runtime = new FakeRuntime();
    const file = await tempDatabaseFile();

    const empty = createService(runtime, file);
    empty.close();

    runtime.containers.set("ref_orphan", { containerId: "ctr_orphan", status: "running", networks: [] });

    const after = createService(runtime, file);
    await after.service.reconcile();

    const records = await after.service.list();
    expect(records.map((record) => record.id)).toEqual(["ctr_orphan"]);
    expect(records[0]).toMatchObject({ status: "running", runtimeRef: "ref_orphan" });

    after.close();
  });

  it("resets stale connection counters on restart", async () => {
    const runtime = new FakeRuntime();
    const file = await tempDatabaseFile();

    const before = createService(runtime, file);
    const record = await before.service.create({});
    await before.service.acquire(record.id);
    await before.service.acquire(record.id);
    expect((await before.service.get(record.id)).activeConnections).toBe(2);
    before.close();

    const after = createService(runtime, file);
    await after.service.reconcile();

    expect((await after.service.get(record.id)).activeConnections).toBe(0);
    after.close();
  });
});
