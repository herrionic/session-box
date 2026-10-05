import type { DatabaseSync } from "node:sqlite";
import type { SandboxRecord } from "../sandbox/types.ts";
import type { SandboxRepository } from "../sandbox/repository.ts";

interface SandboxRow {
  id: string;
  name: string;
  image: string;
  runtime: string;
  status: string;
  workspace: string;
  resources: string;
  lifecycle: string;
  created_at: string;
  started_at: string | null;
  stopped_at: string | null;
  last_activity_at: string | null;
  active_connections: number;
  runtime_ref: string | null;
}

/** SQLite-backed sandbox records (PROJECT.md §33). */
export class SqliteSandboxRepository implements SandboxRepository {
  constructor(private readonly database: DatabaseSync) {}

  async save(record: SandboxRecord): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO sandboxes (
           id, name, image, runtime, status, workspace, resources, lifecycle,
           created_at, started_at, stopped_at, last_activity_at, active_connections, runtime_ref
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           image = excluded.image,
           runtime = excluded.runtime,
           status = excluded.status,
           workspace = excluded.workspace,
           resources = excluded.resources,
           lifecycle = excluded.lifecycle,
           created_at = excluded.created_at,
           started_at = excluded.started_at,
           stopped_at = excluded.stopped_at,
           last_activity_at = excluded.last_activity_at,
           active_connections = excluded.active_connections,
           runtime_ref = excluded.runtime_ref`,
      )
      .run(
        record.id,
        record.name,
        record.image,
        record.runtime,
        record.status,
        record.workspace,
        JSON.stringify(record.resources),
        JSON.stringify(record.lifecycle),
        record.createdAt,
        record.startedAt ?? null,
        record.stoppedAt ?? null,
        record.lastActivityAt ?? null,
        record.activeConnections,
        record.runtimeRef ?? null,
      );
  }

  async get(id: string): Promise<SandboxRecord | undefined> {
    const row = this.database.prepare("SELECT * FROM sandboxes WHERE id = ?").get(id) as
      | SandboxRow
      | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  async list(): Promise<SandboxRecord[]> {
    const rows = this.database
      .prepare("SELECT * FROM sandboxes ORDER BY created_at ASC")
      .all() as unknown as SandboxRow[];
    return rows.map(toRecord);
  }

  async delete(id: string): Promise<void> {
    this.database.prepare("DELETE FROM sandboxes WHERE id = ?").run(id);
  }
}

function toRecord(row: SandboxRow): SandboxRecord {
  return {
    id: row.id,
    name: row.name,
    image: row.image,
    runtime: row.runtime,
    status: row.status as SandboxRecord["status"],
    workspace: row.workspace,
    resources: JSON.parse(row.resources) as SandboxRecord["resources"],
    lifecycle: JSON.parse(row.lifecycle) as SandboxRecord["lifecycle"],
    createdAt: row.created_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.stopped_at !== null ? { stoppedAt: row.stopped_at } : {}),
    ...(row.last_activity_at !== null ? { lastActivityAt: row.last_activity_at } : {}),
    activeConnections: row.active_connections,
    ...(row.runtime_ref !== null ? { runtimeRef: row.runtime_ref } : {}),
  };
}
