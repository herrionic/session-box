import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SessionBoxClient, SessionBoxClientError } from "@sessionbox/client";

export interface BindingRecord {
  sandboxId: string;
  updatedAt: string;
}

export type BindingStore = Record<string, BindingRecord>;

export interface ResolveSandboxOptions {
  client: SessionBoxClient;
  sessionId: string;
  bindingsFile: string;
  sandboxName: string;
  pinnedSandboxId?: string;
  now?: () => string;
}

/**
 * Resolves the sandbox bound to a Pi session: reuse the stored binding when
 * the sandbox still exists, otherwise create one. The binding survives Pi
 * restarts so a resumed session keeps its workspace (PROJECT.md §29, §43.3).
 */
export async function resolveSandboxId(options: ResolveSandboxOptions): Promise<string> {
  if (options.pinnedSandboxId !== undefined) {
    await options.client.getSandbox(options.pinnedSandboxId);
    return options.pinnedSandboxId;
  }

  const store = await readBindings(options.bindingsFile);
  const existing = store[options.sessionId];

  if (existing !== undefined) {
    if (await sandboxExists(options.client, existing.sandboxId)) {
      return existing.sandboxId;
    }
    delete store[options.sessionId];
  }

  const sandbox = await options.client.createSandbox({ name: options.sandboxName });
  const now = options.now ?? (() => new Date().toISOString());
  store[options.sessionId] = { sandboxId: sandbox.id, updatedAt: now() };
  await writeBindings(options.bindingsFile, store);
  return sandbox.id;
}

export async function readBindings(file: string): Promise<BindingStore> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isBindingStore(parsed) ? parsed : {};
  } catch {
    // Missing or unreadable binding files start empty; a broken file must not
    // prevent a session from getting a sandbox.
    return {};
  }
}

export async function writeBindings(file: string, store: BindingStore): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2), "utf8");
  await rename(temporary, file);
}

async function sandboxExists(client: SessionBoxClient, sandboxId: string): Promise<boolean> {
  try {
    await client.getSandbox(sandboxId);
    return true;
  } catch (error) {
    if (error instanceof SessionBoxClientError && error.code === "SANDBOX_NOT_FOUND") {
      return false;
    }
    throw error;
  }
}

function isBindingStore(value: unknown): value is BindingStore {
  if (typeof value !== "object" || value === null) return false;

  return Object.values(value).every((record) => {
    if (typeof record !== "object" || record === null) return false;
    const candidate = record as { sandboxId?: unknown; updatedAt?: unknown };
    return typeof candidate.sandboxId === "string" && typeof candidate.updatedAt === "string";
  });
}
