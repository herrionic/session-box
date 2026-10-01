import type { SandboxRecord } from "./types.ts";

/**
 * Persistence boundary. The MVP boots with the in-memory implementation;
 * SQLite lands in Day 6 behind the same interface (PROJECT.md §33).
 */
export interface SandboxRepository {
  save(record: SandboxRecord): Promise<void>;
  get(id: string): Promise<SandboxRecord | undefined>;
  list(): Promise<SandboxRecord[]>;
  delete(id: string): Promise<void>;
}

export class InMemorySandboxRepository implements SandboxRepository {
  private readonly records = new Map<string, SandboxRecord>();

  async save(record: SandboxRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  async get(id: string): Promise<SandboxRecord | undefined> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async list(): Promise<SandboxRecord[]> {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }
}
