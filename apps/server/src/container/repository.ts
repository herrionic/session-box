import type { ContainerRecord } from "./types.ts";

/**
 * Persistence boundary. The MVP boots with the in-memory implementation;
 * SQLite lands in Day 6 behind the same interface.
 */
export interface ContainerRepository {
  save(record: ContainerRecord): Promise<void>;
  get(id: string): Promise<ContainerRecord | undefined>;
  list(): Promise<ContainerRecord[]>;
  delete(id: string): Promise<void>;
}

export class InMemoryContainerRepository implements ContainerRepository {
  private readonly records = new Map<string, ContainerRecord>();

  async save(record: ContainerRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  async get(id: string): Promise<ContainerRecord | undefined> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async list(): Promise<ContainerRecord[]> {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }
}
