import { InMemorySecretRepository, type SecretRepository } from "../storage/secret-repository.ts";
import { requireMasterKey } from "./master-key.ts";
import { open, seal } from "./sealing.ts";

/**
 * Credential persistence boundary. Private keys never leave the server and are
 * never returned through the API (PROJECT.md §14). The store encrypts before
 * handing blobs to the repository; a SQLite repository persists the same
 * sealed strings across restarts.
 */
export interface CredentialStore {
  save(sandboxId: string, name: string, plaintext: string): Promise<void>;
  read(sandboxId: string, name: string): Promise<string | undefined>;
  remove(sandboxId: string, name: string): Promise<void>;
  removeAll(sandboxId: string): Promise<void>;
}

export class EncryptedCredentialStore implements CredentialStore {
  constructor(
    private readonly masterKey: Buffer | undefined,
    private readonly secrets: SecretRepository,
  ) {}

  async save(sandboxId: string, name: string, plaintext: string): Promise<void> {
    const sealed = seal(plaintext, requireMasterKey(this.masterKey));
    await this.secrets.save(entryKey(sandboxId, name), sealed);
  }

  async read(sandboxId: string, name: string): Promise<string | undefined> {
    const sealed = await this.secrets.get(entryKey(sandboxId, name));
    if (sealed === undefined) return undefined;
    return open(sealed, requireMasterKey(this.masterKey));
  }

  async remove(sandboxId: string, name: string): Promise<void> {
    await this.secrets.delete(entryKey(sandboxId, name));
  }

  async removeAll(sandboxId: string): Promise<void> {
    await this.secrets.deleteByPrefix(`${sandboxId}:`);
  }
}

/** Encrypted store over an in-memory secret repository (tests, local runs). */
export class InMemoryCredentialStore extends EncryptedCredentialStore {
  constructor(masterKey: Buffer | undefined) {
    super(masterKey, new InMemorySecretRepository());
  }
}

function entryKey(sandboxId: string, name: string): string {
  return `${sandboxId}:${name}`;
}
