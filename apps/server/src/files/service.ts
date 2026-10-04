import {
  FILE_LIMITS,
  type CreateFileRequest,
  type FileContent,
  type FileEntry,
  type FileListResponse,
  type WriteFileRequest,
} from "@sessionbox/protocol";
import { SessionBoxError } from "../errors.ts";
import type { Logger } from "../logging.ts";
import { normalizeSandboxPath, resolveWithinWorkspace } from "../ssh/paths.ts";
import { toPublicSshError } from "../ssh/public-errors.ts";
import type { SshSession } from "../ssh/session.ts";
import type { SandboxService } from "../sandbox/service.ts";

export interface SandboxFilesServiceOptions {
  sandboxes: SandboxService;
  /** File-manager root; every path is confined to it (default `/workspace`). */
  workspace: string;
  maxTextFileBytes?: number;
  maxUploadBytes?: number;
  logger: Logger;
}

/**
 * File-manager operations over SFTP. All paths are validated against the
 * workspace root before any SSH call; the client never supplies a raw remote
 * path (PROJECT.md §27, §42).
 */
export class SandboxFilesService {
  private readonly sandboxes: SandboxService;
  private readonly workspaceRoot: string;
  private readonly maxTextFileBytes: number;
  private readonly maxUploadBytes: number;
  private readonly logger: Logger;

  constructor(options: SandboxFilesServiceOptions) {
    this.sandboxes = options.sandboxes;
    this.workspaceRoot = normalizeSandboxPath(options.workspace);
    this.maxTextFileBytes = options.maxTextFileBytes ?? FILE_LIMITS.maxTextFileBytes;
    this.maxUploadBytes = options.maxUploadBytes ?? FILE_LIMITS.maxUploadBytes;
    this.logger = options.logger;
  }

  async list(sandboxId: string, path: string): Promise<FileListResponse> {
    const target = this.resolve(path);
    return await this.run(sandboxId, async (session) => {
      const entries = await session.list(target);
      return { path: target, entries: entries.map((entry) => toFileEntry(entry)) };
    });
  }

  async readText(sandboxId: string, path: string): Promise<FileContent> {
    const target = this.resolve(path);
    return await this.run(sandboxId, async (session) => {
      const entry = await session.stat(target);
      if (entry.type !== "file") {
        throw new SessionBoxError("INVALID_REQUEST", "only regular files can be viewed as text");
      }
      if (entry.size > this.maxTextFileBytes) {
        throw new SessionBoxError(
          "INVALID_REQUEST",
          `file exceeds the ${this.maxTextFileBytes} byte text limit; download it instead`,
        );
      }

      const content = await session.readFile(target);
      return {
        path: target,
        content: content.toString("utf8"),
        size: entry.size,
        modifiedAt: entry.modifiedAt,
      };
    });
  }

  async writeText(sandboxId: string, request: WriteFileRequest): Promise<FileContent> {
    const target = this.resolve(request.path);
    const bytes = Buffer.byteLength(request.content, "utf8");
    if (bytes > this.maxTextFileBytes) {
      throw new SessionBoxError(
        "INVALID_REQUEST",
        `content exceeds the ${this.maxTextFileBytes} byte text limit`,
      );
    }

    return await this.run(sandboxId, async (session) => {
      await session.writeFile(target, request.content);
      const entry = await session.stat(target);
      return {
        path: target,
        content: request.content,
        size: entry.size,
        modifiedAt: entry.modifiedAt,
      };
    });
  }

  async create(sandboxId: string, request: CreateFileRequest): Promise<FileEntry> {
    const target = this.resolve(request.path);
    return await this.run(sandboxId, async (session) => {
      if (request.type === "directory") {
        await session.mkdir(target, { recursive: true });
      } else {
        await session.writeFile(target, "");
      }
      return toFileEntry(await session.stat(target));
    });
  }

  async remove(sandboxId: string, path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const target = this.resolve(path);
    if (target === this.workspaceRoot) {
      throw new SessionBoxError("INVALID_REQUEST", "the workspace root cannot be deleted");
    }
    await this.run(sandboxId, (session) => session.remove(target, options));
  }

  async upload(sandboxId: string, path: string, content: Buffer): Promise<FileEntry> {
    if (content.length > this.maxUploadBytes) {
      throw new SessionBoxError(
        "INVALID_REQUEST",
        `upload exceeds the ${this.maxUploadBytes} byte limit`,
      );
    }

    const target = this.resolve(path);
    return await this.run(sandboxId, async (session) => {
      await session.writeFile(target, content);
      return toFileEntry(await session.stat(target));
    });
  }

  async download(
    sandboxId: string,
    path: string,
  ): Promise<{ entry: FileEntry; content: Buffer }> {
    const target = this.resolve(path);
    return await this.run(sandboxId, async (session) => {
      const entry = await session.stat(target);
      if (entry.type !== "file") {
        throw new SessionBoxError("INVALID_REQUEST", "only regular files can be downloaded");
      }
      if (entry.size > this.maxUploadBytes) {
        throw new SessionBoxError(
          "INVALID_REQUEST",
          `file exceeds the ${this.maxUploadBytes} byte download limit`,
        );
      }
      return { entry: toFileEntry(entry), content: await session.readFile(target) };
    });
  }

  private resolve(path: string): string {
    return resolveWithinWorkspace(path, this.workspaceRoot);
  }

  private async run<T>(
    sandboxId: string,
    operation: (session: SshSession) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.sandboxes.withSshSession(sandboxId, operation);
    } catch (error) {
      throw toPublicSshError(error, this.logger, "file.operation.failed");
    }
  }
}

function toFileEntry(entry: FileEntry): FileEntry {
  return {
    name: entry.name,
    path: entry.path,
    type: entry.type,
    size: entry.size,
    mode: entry.mode,
    modifiedAt: entry.modifiedAt,
  };
}
