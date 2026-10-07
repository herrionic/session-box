import { InMemorySecretRepository, type SecretRepository } from "../storage/secret-repository.ts";
import { requireMasterKey } from "./master-key.ts";
import { open, seal } from "./sealing.ts";

/**
 * Credential persistence boundary. Private keys never leave the server and are
 * never returned through the API. The store encrypts before
 * handing blobs to the repository; a SQLite repository persists the same
 * sealed strings across restarts.
 */
export interface CredentialStore {
  save(containerId: string, name: string, plaintext: string): Promise<void>;
  read(containerId: string, name: string): Promise<string | undefined>;
  remove(containerId: string, name: string): Promise<void>;
  removeAll(containerId: string): Promise<void>;
}

export class EncryptedCredentialStore implements CredentialStore {
  constructor(
    private readonly masterKey: Buffer | undefined,
    private readonly secrets: SecretRepository,
  ) {}

  async save(containerId: string, name: string, plaintext: string): Promise<void> {
    const sealed = seal(plaintext, requireMasterKey(this.masterKey));
    await this.secrets.save(entryKey(containerId, name), sealed);
  }

  async read(containerId: string, name: string): Promise<string | undefined> {
    const sealed = await this.secrets.get(entryKey(containerId, name));
    if (sealed === undefined) return undefined;
    return open(sealed, requireMasterKey(this.masterKey));
  }

  async remove(containerId: string, name: string): Promise<void> {
    await this.secrets.delete(entryKey(containerId, name));
  }

  async removeAll(containerId: string): Promise<void> {
    await this.secrets.deleteByPrefix(`${containerId}:`);
  }
}

/** Encrypted store over an in-memory secret repository (tests, local runs). */
export class InMemoryCredentialStore extends EncryptedCredentialStore {
  constructor(masterKey: Buffer | undefined) {
    super(masterKey, new InMemorySecretRepository());
  }
}

function entryKey(containerId: string, name: string): string {
  return `${containerId}:${name}`;
}
