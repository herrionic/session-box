import { createHash } from "node:crypto";
import type { FileEntry } from "@sessionbox/protocol";
import type { SshFileEntry, SshSession } from "./session.ts";

/**
 * Version = MD5 of the resource itself, so every surface (read, write, stat,
 * list) reports the same value for the same state:
 *
 * - regular file: the content
 * - symlink: the link target
 * - directory / special file: a stat descriptor (no content exists)
 *
 * MD5 is chosen for speed: versions are recomputed on every listing.
 */
export async function versionOf(session: SshSession, entry: SshFileEntry): Promise<string> {
  if (entry.type === "file") {
    return md5(await session.readFile(entry.path));
  }
  if (entry.type === "symlink") {
    return md5(entry.linkTarget ?? entry.path);
  }
  return md5(`${entry.type}:${entry.size}:${entry.modifiedAt}:${entry.mode}`);
}

export function md5(content: Buffer | string): string {
  return createHash("md5").update(content).digest("hex");
}

/** Maps an SSH entry plus its version to the public file model. */
export function toPublicEntry(entry: SshFileEntry, version: string): FileEntry {
  return {
    name: entry.name,
    path: entry.path,
    type: entry.type,
    size: entry.size,
    mode: entry.mode,
    modifiedAt: entry.modifiedAt,
    version,
    ...(entry.linkTarget !== undefined ? { linkTarget: entry.linkTarget } : {}),
  };
}
