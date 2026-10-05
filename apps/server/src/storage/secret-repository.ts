import type { DatabaseSync } from "node:sqlite";

/**
 * Persistence boundary for sealed credential blobs. The store layer owns
 * encryption; repositories only ever see ciphertext (PROJECT.md §15).
 */
export interface SecretRepository {
  save(key: string, sealed: string): Promise<void>;
  get(key: string): Promise<string | undefined>;
  delete(key: string): Promise<void>;
  deleteByPrefix(prefix: string): Promise<void>;
}

export class InMemorySecretRepository implements SecretRepository {
  private readonly blobs = new Map<string, string>();

  async save(key: string, sealed: string): Promise<void> {
    this.blobs.set(key, sealed);
  }

  async get(key: string): Promise<string | undefined> {
    return this.blobs.get(key);
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    for (const key of [...this.blobs.keys()]) {
      if (key.startsWith(prefix)) this.blobs.delete(key);
    }
  }
}

export class SqliteSecretRepository implements SecretRepository {
  constructor(private readonly database: DatabaseSync) {}

  async save(key: string, sealed: string): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO secrets (key, sealed, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at`,
      )
      .run(key, sealed, new Date().toISOString());
  }

  async get(key: string): Promise<string | undefined> {
    const row = this.database.prepare("SELECT sealed FROM secrets WHERE key = ?").get(key) as
      | { sealed: string }
      | undefined;
    return row?.sealed;
  }

  async delete(key: string): Promise<void> {
    this.database.prepare("DELETE FROM secrets WHERE key = ?").run(key);
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    this.database.prepare("DELETE FROM secrets WHERE key LIKE ? ESCAPE '\\'").run(`${escapeLike(prefix)}%`);
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
