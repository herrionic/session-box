import { requireMasterKey } from "./master-key.ts";
import { open, seal } from "./sealing.ts";

/**
 * Credential persistence boundary. The MVP keeps sealed blobs in memory;
 * SQLite (Day 6) will persist the same sealed strings behind this interface.
 *
 * Private keys never leave the server and are never returned through the API
 * (PROJECT.md §14).
 */
export interface CredentialStore {
  save(sandboxId: string, name: string, plaintext: string): Promise<void>;
  read(sandboxId: string, name: string): Promise<string | undefined>;
  remove(sandboxId: string, name: string): Promise<void>;
  removeAll(sandboxId: string): Promise<void>;
}

export class InMemoryCredentialStore implements CredentialStore {
  private readonly blobs = new Map<string, string>();

  constructor(private readonly masterKey: Buffer | undefined) {}

  async save(sandboxId: string, name: string, plaintext: string): Promise<void> {
    this.blobs.set(entryKey(sandboxId, name), seal(plaintext, requireMasterKey(this.masterKey)));
  }

  async read(sandboxId: string, name: string): Promise<string | undefined> {
    const blob = this.blobs.get(entryKey(sandboxId, name));
    if (blob === undefined) return undefined;
    return open(blob, requireMasterKey(this.masterKey));
  }

  async remove(sandboxId: string, name: string): Promise<void> {
    this.blobs.delete(entryKey(sandboxId, name));
  }

  async removeAll(sandboxId: string): Promise<void> {
    const prefix = `${sandboxId}:`;
    for (const key of [...this.blobs.keys()]) {
      if (key.startsWith(prefix)) this.blobs.delete(key);
    }
  }
}

function entryKey(sandboxId: string, name: string): string {
  return `${sandboxId}:${name}`;
}
