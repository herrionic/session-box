import type { DatabaseSync } from "node:sqlite";
import type { ContainerRecord } from "../container/types.ts";
import type { ContainerRepository } from "../container/repository.ts";

interface ContainerRow {
  id: string;
  name: string;
  image: string;
  runtime: string;
  status: string;
  workspace: string;
  networks: string;
  resources: string;
  lifecycle: string;
  created_at: string;
  started_at: string | null;
  stopped_at: string | null;
  last_activity_at: string | null;
  active_connections: number;
  runtime_ref: string | null;
}

/** SQLite-backed container records. */
export class SqliteContainerRepository implements ContainerRepository {
  constructor(private readonly database: DatabaseSync) {}

  async save(record: ContainerRecord): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO containers (
           id, name, image, runtime, status, workspace, networks, resources, lifecycle,
           created_at, started_at, stopped_at, last_activity_at, active_connections, runtime_ref
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           image = excluded.image,
           runtime = excluded.runtime,
           status = excluded.status,
           workspace = excluded.workspace,
           networks = excluded.networks,
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
        JSON.stringify(record.networks),
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

  async get(id: string): Promise<ContainerRecord | undefined> {
    const row = this.database.prepare("SELECT * FROM containers WHERE id = ?").get(id) as
      | ContainerRow
      | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  async list(): Promise<ContainerRecord[]> {
    const rows = this.database
      .prepare("SELECT * FROM containers ORDER BY created_at ASC")
      .all() as unknown as ContainerRow[];
    return rows.map(toRecord);
  }

  async delete(id: string): Promise<void> {
    this.database.prepare("DELETE FROM containers WHERE id = ?").run(id);
  }
}

function toRecord(row: ContainerRow): ContainerRecord {
  return {
    id: row.id,
    name: row.name,
    image: row.image,
    runtime: row.runtime,
    status: row.status as ContainerRecord["status"],
    workspace: row.workspace,
    networks: JSON.parse(row.networks) as string[],
    resources: JSON.parse(row.resources) as ContainerRecord["resources"],
    lifecycle: JSON.parse(row.lifecycle) as ContainerRecord["lifecycle"],
    createdAt: row.created_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.stopped_at !== null ? { stoppedAt: row.stopped_at } : {}),
    ...(row.last_activity_at !== null ? { lastActivityAt: row.last_activity_at } : {}),
    activeConnections: row.active_connections,
    ...(row.runtime_ref !== null ? { runtimeRef: row.runtime_ref } : {}),
  };
}
