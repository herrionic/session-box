import path from "node:path";
import { posix } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { FileSystem, FsError, FsTargetKey, FsVersion } from "@deepseek-ai/dsh-fs";
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsErrorCode,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from "@deepseek-ai/dsh-fs";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import { SessionBoxClientError, type ContainerRuntime } from "@sessionbox/client";
import { fromContainerPath, toContainerPath } from "@sessionbox/shared";
import type { SessionBoxRuntimeProvider } from "./connection.ts";

export interface FileSystemServiceConfig {
  connection: () => SessionBoxRuntimeProvider;
}

/**
 * `ctx.fs` over the SessionBox agent protocol. Targets are container paths; the
 * display path stays the host path the model used so tool output matches the
 * session cwd. Text operations are supported; binary reads are not (the agent
 * protocol moves text), and watching is inherited from the base class.
 */
export class SessionBoxFileSystem extends FileSystem {
  private readonly connection: () => SessionBoxRuntimeProvider;
  private readonly hostCwd: string;
  private readonly workspaceRoot: string;

  constructor(ctx: Context, config: FileSystemServiceConfig & { hostCwd: string; workspaceRoot: string }) {
    super(ctx);
    this.connection = config.connection;
    this.hostCwd = config.hostCwd;
    this.workspaceRoot = config.workspaceRoot;
  }

  override async resolve(
    filePath: string,
    opts?: { cwd?: string; signal?: AbortSignal },
  ): Promise<FsTarget> {
    opts?.signal?.throwIfAborted();
    const hostCwd = opts?.cwd ?? this.hostCwd;
    const hostPath = path.isAbsolute(filePath) ? filePath : path.resolve(hostCwd, filePath);
    const containerPath = toContainerPath(hostPath, hostCwd, this.workspaceRoot);
    return { targetKey: FsTargetKey(containerPath), displayPath: hostPath };
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey);
  }

  override fileUrl(target: FsTarget): string {
    // Container paths are POSIX; pathToFileURL would read "/workspace/x" as a
    // drive-relative path on Windows hosts.
    return new URL(`file://${this.processPath(target)}`).href;
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const relative = posix.relative(this.processPath(parent), this.processPath(child));
    return relative === "" || (!relative.startsWith("../") && relative !== ".." && !posix.isAbsolute(relative));
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    signal?.throwIfAborted();
    const runtime = await this.runtime();
    try {
      const entry = await runtime.statFile(this.processPath(target));
      return { version: versionOf(entry), type: mapType(entry.type), size: entry.size };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw toFsError(error);
    }
  }

  override async lstat(
    filePath: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    signal?.throwIfAborted();
    const hostCwd = opts?.cwd ?? this.hostCwd;
    const hostPath = path.isAbsolute(filePath) ? filePath : path.resolve(hostCwd, filePath);
    const containerPath = toContainerPath(hostPath, hostCwd, this.workspaceRoot);
    const runtime = await this.runtime();

    try {
      const entry = await runtime.statFile(containerPath);
      return { version: versionOf(entry), type: entry.type, size: entry.size };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw toFsError(error);
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const runtime = await this.runtime();
    try {
      return (await runtime.readFile(this.processPath(target))).content;
    } catch (error) {
      throw toFsError(error);
    }
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const text = await this.readText(target, signal);
    return (async function* () {
      signal?.throwIfAborted();
      yield text;
    })();
  }

  override async readBytes(
    _target: FsTarget,
    _signal: AbortSignal | undefined,
    _maxBytes: number,
  ): Promise<Uint8Array> {
    throw new FsError(
      "binary reads are not supported by the SessionBox filesystem backend yet",
      "FS_IO_ERROR",
    );
  }

  override async readByteRange(
    _target: FsTarget,
    _range: { offset: number; length: number },
    _signal?: AbortSignal,
  ): Promise<Uint8Array> {
    throw new FsError(
      "binary reads are not supported by the SessionBox filesystem backend yet",
      "FS_IO_ERROR",
    );
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    signal?.throwIfAborted();
    const runtime = await this.runtime();
    const directory = this.processPath(target);

    try {
      const listing = await runtime.listFiles(directory);
      return listing.entries.map((entry) => ({
        name: entry.name,
        type: mapType(entry.type),
        target: {
          targetKey: FsTargetKey(entry.path),
          displayPath: fromContainerPath(entry.path, this.hostCwd, this.workspaceRoot) ?? entry.path,
        },
        version: versionOf(entry),
        size: entry.size,
      }));
    } catch (error) {
      throw toFsError(error);
    }
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    _sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    signal?.throwIfAborted();
    const runtime = await this.runtime();
    const containerPath = this.processPath(target);

    const before = await readOptional(runtime, containerPath);
    const exists = before !== null;

    if (expected?.kind === "createIfAbsent" && exists) {
      throw new FsError("file already exists and the write required absence", "FS_NOT_OBSERVED");
    }
    if (expected?.kind === "replaceIfVersion") {
      if (!exists) {
        throw new FsError("file does not exist and the write required a version", "FS_STALE_VERSION");
      }
      const current = await runtime.statFile(containerPath);
      if (versionOf(current) !== expected.version) {
        throw new FsError("file changed since the version was observed", "FS_STALE_VERSION");
      }
    }

    try {
      await runtime.writeFile(containerPath, content);
    } catch (error) {
      throw toFsError(error);
    }

    const info = await runtime.statFile(containerPath);
    return {
      operation: exists ? "update" : "create",
      version: versionOf(info),
      before,
      after: content,
    };
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    _sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    signal?.throwIfAborted();
    const runtime = await this.runtime();
    const containerPath = this.processPath(target);

    if (edit.oldString === "") {
      throw new FsError("oldString must not be empty", "FS_IO_ERROR");
    }

    const before = await readOptional(runtime, containerPath);
    if (before === null) {
      throw new FsError("file does not exist", "FS_NOT_FOUND");
    }

    if (expected !== undefined) {
      const current = await runtime.statFile(containerPath);
      if (versionOf(current) !== expected.version) {
        throw new FsError("file changed since the version was observed", "FS_STALE_VERSION");
      }
    }

    const occurrences = countOccurrences(before, edit.oldString);
    if (occurrences === 0) {
      throw new FsError("oldString was not found in the file", "FS_EDIT_NOT_FOUND");
    }
    if (occurrences > 1 && !edit.replaceAll) {
      throw new FsError("oldString matches more than once; set replaceAll", "FS_AMBIGUOUS_EDIT");
    }

    const after = edit.replaceAll
      ? before.split(edit.oldString).join(edit.newString)
      : before.replace(edit.oldString, edit.newString);

    try {
      await runtime.writeFile(containerPath, after);
    } catch (error) {
      throw toFsError(error);
    }

    const info = await runtime.statFile(containerPath);
    return { version: versionOf(info), before, after };
  }

  private async runtime(): Promise<ContainerRuntime> {
    return (await this.connection().connect()).runtime;
  }
}

export default SessionBoxFileSystem;

function mapType(type: "file" | "directory" | "symlink" | "other"): "file" | "directory" | "other" {
  return type === "symlink" ? "other" : type;
}

function versionOf(entry: { modifiedAt: number; size: number }): FsVersion {
  return FsVersion(`${entry.modifiedAt}:${entry.size}`);
}

async function readOptional(runtime: ContainerRuntime, containerPath: string): Promise<string | null> {
  try {
    return (await runtime.readFile(containerPath)).content;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw toFsError(error);
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof SessionBoxClientError && error.code === "NOT_FOUND";
}

function toFsError(error: unknown): FsError {
  if (error instanceof FsError) return error;

  if (error instanceof SessionBoxClientError && error.code === "NOT_FOUND") {
    return new FsError(error.message, "FS_NOT_FOUND", { cause: error });
  }

  return new FsError(
    error instanceof Error ? error.message : String(error),
    "FS_IO_ERROR" satisfies FsErrorCode,
    { cause: error },
  );
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
