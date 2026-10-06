import { posix } from "node:path";
import type { SshFileEntry, SshFileType } from "./session.ts";

/**
 * `find -printf` is the metadata source for list/stat: it reports the inode,
 * nanosecond timestamps and ctime that SFTP v3 attributes do not carry.
 * `-H` follows command-line symlinks only, so directory entries keep lstat
 * semantics while the listed path itself may be a symlink. `%m` is included
 * because the public model needs the permission bits.
 */
const PRINT_FORMAT = "%f\\0%y\\0%m\\0%i\\0%s\\0%T@\\0%C@\\0%l\\0";

export function buildListCommand(dir: string): string {
  return `find -H ${shellQuote(dir)} -mindepth 1 -maxdepth 1 -printf ${shellQuote(PRINT_FORMAT)}`;
}

export function buildStatCommand(path: string, follow: boolean): string {
  return `find ${follow ? "-H " : ""}${shellQuote(path)} -maxdepth 0 -printf ${shellQuote(PRINT_FORMAT)}`;
}

export interface ParsedFindEntry {
  name: string;
  type: SshFileType;
  mode: number;
  size: number;
  modifiedAt: number;
  version: string;
  linkTarget?: string;
}

/**
 * Parses `find -printf` output (eight NUL-separated fields per entry).
 * Malformed records are skipped rather than failing the whole listing.
 */
export function parseFindOutput(stdout: string): ParsedFindEntry[] {
  const fields = stdout.split("\0");
  const entries: ParsedFindEntry[] = [];

  for (let index = 0; index + 7 < fields.length; index += 8) {
    const name = fields[index] ?? "";
    if (name === "") continue;
    const parsed = buildEntry(
      name,
      fields[index + 1] ?? "",
      fields[index + 2] ?? "",
      fields[index + 3] ?? "",
      fields[index + 4] ?? "",
      fields[index + 5] ?? "",
      fields[index + 6] ?? "",
      fields[index + 7] ?? "",
    );
    if (parsed !== null) entries.push(parsed);
  }

  return entries;
}

export function toSshEntries(parsed: ParsedFindEntry[], basePath: string): SshFileEntry[] {
  return parsed.map((entry) => toSshEntry(entry, posix.join(basePath, entry.name)));
}

export function toSshEntry(parsed: ParsedFindEntry, path: string): SshFileEntry {
  return {
    name: posix.basename(path),
    path,
    type: parsed.type,
    size: parsed.size,
    mode: parsed.mode,
    modifiedAt: parsed.modifiedAt,
    version: parsed.version,
    ...(parsed.linkTarget !== undefined ? { linkTarget: parsed.linkTarget } : {}),
  };
}

function buildEntry(
  name: string,
  typeChar: string,
  modeText: string,
  inode: string,
  sizeText: string,
  mtime: string,
  ctime: string,
  link: string,
): ParsedFindEntry | null {
  if (!isDigits(inode) || !isDigits(sizeText)) return null;
  const mtimeNs = toNanoseconds(mtime);
  const ctimeNs = toNanoseconds(ctime);
  if (mtimeNs === null || ctimeNs === null) return null;

  const size = Number.parseInt(sizeText, 10);
  if (!Number.isSafeInteger(size)) return null;

  const permissions = Number.parseInt(modeText, 8);
  return {
    name,
    type: fileTypeOf(typeChar),
    mode: typeBits(typeChar) | (Number.isNaN(permissions) ? 0 : permissions),
    size,
    modifiedAt: Number.parseInt(mtime.split(".")[0] ?? "", 10) * 1000,
    version: `${inode}:${size}:${mtimeNs}:${ctimeNs}`,
    ...(typeChar === "l" && link !== "" ? { linkTarget: link } : {}),
  };
}

function fileTypeOf(typeChar: string): SshFileType {
  if (typeChar === "f") return "file";
  if (typeChar === "d") return "directory";
  if (typeChar === "l") return "symlink";
  return "other";
}

/** POSIX file-type bits, so `mode` keeps the shape SFTP's `st_mode` had. */
function typeBits(typeChar: string): number {
  switch (typeChar) {
    case "f":
      return 0o100000;
    case "d":
      return 0o040000;
    case "l":
      return 0o120000;
    case "b":
      return 0o060000;
    case "c":
      return 0o020000;
    case "p":
      return 0o010000;
    case "s":
      return 0o140000;
    default:
      return 0;
  }
}

/** "1791255099.7955081820" → "1791255099795508182" (nanoseconds). */
function toNanoseconds(value: string): string | null {
  const [seconds = "", fraction = ""] = value.split(".");
  if (!isDigits(seconds) || (fraction !== "" && !isDigits(fraction))) return null;
  return `${seconds}${fraction.padEnd(9, "0").slice(0, 9)}`;
}

function isDigits(value: string): boolean {
  return /^\d+$/.test(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
