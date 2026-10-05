import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Monotonic schema version; bump with every structural migration. */
export const SCHEMA_VERSION = 1;

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

  if (current < 1) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS sandboxes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        image TEXT NOT NULL,
        runtime TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace TEXT NOT NULL,
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

  writeSchemaVersion(database, SCHEMA_VERSION);
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
