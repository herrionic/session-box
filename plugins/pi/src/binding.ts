import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SessionBoxClient, SessionBoxClientError } from "@sessionbox/client";

export interface BindingRecord {
  containerId: string;
  updatedAt: string;
}

export type BindingStore = Record<string, BindingRecord>;

export interface ResolveContainerOptions {
  client: SessionBoxClient;
  sessionId: string;
  bindingsFile: string;
  containerName: string;
  pinnedContainerId?: string;
  now?: () => string;
}

/**
 * Resolves the container bound to a Pi session: reuse the stored binding when
 * the container still exists, otherwise create one. The binding survives Pi
 * restarts so a resumed session keeps its workspace.
 */
export async function resolveContainerId(options: ResolveContainerOptions): Promise<string> {
  if (options.pinnedContainerId !== undefined) {
    await options.client.getContainer(options.pinnedContainerId);
    return options.pinnedContainerId;
  }

  const store = await readBindings(options.bindingsFile);
  const existing = store[options.sessionId];

  if (existing !== undefined) {
    if (await containerExists(options.client, existing.containerId)) {
      return existing.containerId;
    }
    delete store[options.sessionId];
  }

  const container = await options.client.createContainer({ name: options.containerName });
  const now = options.now ?? (() => new Date().toISOString());
  store[options.sessionId] = { containerId: container.id, updatedAt: now() };
  await writeBindings(options.bindingsFile, store);
  return container.id;
}

export async function readBindings(file: string): Promise<BindingStore> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isBindingStore(parsed) ? parsed : {};
  } catch {
    // Missing or unreadable binding files start empty; a broken file must not
    // prevent a session from getting a container.
    return {};
  }
}

export async function writeBindings(file: string, store: BindingStore): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2), "utf8");
  await rename(temporary, file);
}

async function containerExists(client: SessionBoxClient, containerId: string): Promise<boolean> {
  try {
    await client.getContainer(containerId);
    return true;
  } catch (error) {
    if (error instanceof SessionBoxClientError && error.code === "CONTAINER_NOT_FOUND") {
      return false;
    }
    throw error;
  }
}

function isBindingStore(value: unknown): value is BindingStore {
  if (typeof value !== "object" || value === null) return false;

  return Object.values(value).every((record) => {
    if (typeof record !== "object" || record === null) return false;
    const candidate = record as { containerId?: unknown; updatedAt?: unknown };
    return typeof candidate.containerId === "string" && typeof candidate.updatedAt === "string";
  });
}
