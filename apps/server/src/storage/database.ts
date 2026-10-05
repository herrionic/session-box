import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Monotonic schema version; bump with every structural migration. */
export const SCHEMA_VERSION = 3;

/**
 * Opens the SessionBox database and applies migrations. Node's built-in
 * SQLite keeps the MVP free of native build dependencies.
 */
export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") {
    mkdirSync(path.dirname(file), { recursive: true });
  }

  const database = new DatabaseSync(file);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  migrate(database);
  return database;
}

function migrate(database: DatabaseSync): void {
  const current = readSchemaVersion(database);

  if (current === 0) {
    createContainerTables(database);
    createUserTables(database);
    writeSchemaVersion(database, SCHEMA_VERSION);
    return;
  }

  if (current < 2) {
    // v1 stored containers in a table named "sandboxes"; the rename happened
    // before the first public release, so a single ALTER is enough.
    if (tableExists(database, "sandboxes") && !tableExists(database, "containers")) {
      database.exec("ALTER TABLE sandboxes RENAME TO containers");
    }
    createUserTables(database);
  }

  if (current < 3) {
    // v2 predates the network resource: containers only knew the default
    // network, so an empty list is the correct backfill.
    if (
      tableExists(database, "containers") &&
      !columnExists(database, "containers", "networks")
    ) {
      database.exec("ALTER TABLE containers ADD COLUMN networks TEXT NOT NULL DEFAULT '[]'");
    }
  }

  writeSchemaVersion(database, SCHEMA_VERSION);
}

function createContainerTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS containers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      image TEXT NOT NULL,
      runtime TEXT NOT NULL,
      status TEXT NOT NULL,
      workspace TEXT NOT NULL,
      networks TEXT NOT NULL DEFAULT '[]',
      resources TEXT NOT NULL,
      lifecycle TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      stopped_at TEXT,
      last_activity_at TEXT,
      active_connections INTEGER NOT NULL DEFAULT 0,
      runtime_ref TEXT
    );

    CREATE TABLE IF NOT EXISTS secrets (
      key TEXT PRIMARY KEY,
      sealed TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function createUserTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
  `);
}

function tableExists(database: DatabaseSync, name: string): boolean {
  return (
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

function columnExists(database: DatabaseSync, table: string, column: string): boolean {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function readSchemaVersion(database: DatabaseSync): number {
  const table = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  if (table === undefined) return 0;

  const row = database
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value?: string } | undefined;

  if (row?.value === undefined) return 0;
  const parsed = Number(row.value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function writeSchemaVersion(database: DatabaseSync, version: number): void {
  database
    .prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(String(version));
}
