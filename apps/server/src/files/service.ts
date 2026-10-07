import { isUtf8 } from "node:buffer";
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
import { normalizeContainerPath } from "../ssh/paths.ts";
import { toPublicSshError } from "../ssh/public-errors.ts";
import type { SshSession } from "../ssh/session.ts";
import type { ContainerService } from "../container/service.ts";

export interface ContainerFilesServiceOptions {
  containers: ContainerService;
  maxTextFileBytes?: number;
  maxUploadBytes?: number;
  logger: Logger;
}

/**
 * File-manager operations over SFTP. Paths are absolute container paths: the
 * container is the isolation boundary, so nothing is confined to the
 * workspace (same for the agent protocol). Relative paths and NUL bytes are
 * still rejected.
 */
export class ContainerFilesService {
  private readonly containers: ContainerService;
  private readonly maxTextFileBytes: number;
  private readonly maxUploadBytes: number;
  private readonly logger: Logger;

  constructor(options: ContainerFilesServiceOptions) {
    this.containers = options.containers;
    this.maxTextFileBytes = options.maxTextFileBytes ?? FILE_LIMITS.maxTextFileBytes;
    this.maxUploadBytes = options.maxUploadBytes ?? FILE_LIMITS.maxUploadBytes;
    this.logger = options.logger;
  }

  async list(containerId: string, path: string): Promise<FileListResponse> {
    const target = this.resolve(path);
    return await this.run(containerId, async (session) => {
      const entries = await session.list(target);
      return { path: target, entries };
    });
  }

  async readText(containerId: string, path: string): Promise<FileContent> {
    const target = this.resolve(path);
    return await this.run(containerId, async (session) => {
      const entry = await session.stat(target);
      assertRegularFile(entry);
      if (entry.size > this.maxTextFileBytes) {
        throw new SessionBoxError(
          "FS_TOO_LARGE",
          `file exceeds the ${this.maxTextFileBytes} byte text limit; download it instead`,
        );
      }

      const content = await session.readFile(target);
      if (!isUtf8(content) || content.includes(0)) {
        throw new SessionBoxError(
          "FS_NOT_TEXT",
          "file is not valid UTF-8 text; download it instead",
        );
      }
      return {
        path: target,
        content: content.toString("utf8"),
        size: entry.size,
        modifiedAt: entry.modifiedAt,
        version: entry.version,
        offset: 0,
        length: content.length,
        eof: true,
      };
    });
  }

  async writeText(containerId: string, request: WriteFileRequest): Promise<FileContent> {
    const target = this.resolve(request.path);
    const bytes = Buffer.byteLength(request.content, "utf8");
    if (bytes > this.maxTextFileBytes) {
      throw new SessionBoxError(
        "FS_TOO_LARGE",
        `content exceeds the ${this.maxTextFileBytes} byte text limit`,
      );
    }

    return await this.run(containerId, async (session) => {
      await session.writeFileAtomic(target, request.content);
      const entry = await session.stat(target);
      return {
        path: target,
        content: request.content,
        size: entry.size,
        modifiedAt: entry.modifiedAt,
        version: entry.version,
        offset: 0,
        length: bytes,
        eof: true,
      };
    });
  }

  async create(containerId: string, request: CreateFileRequest): Promise<FileEntry> {
    const target = this.resolve(request.path);
    return await this.run(containerId, async (session) => {
      if (request.type === "directory") {
        await session.mkdir(target, { recursive: true });
      } else {
        await session.writeFileAtomic(target, "");
      }
      const entry = await session.stat(target);
      return entry;
    });
  }

  async remove(containerId: string, path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const target = this.resolve(path);
    if (target === "/") {
      throw new SessionBoxError("INVALID_REQUEST", "the container root cannot be deleted");
    }
    await this.run(containerId, (session) => session.remove(target, options));
  }

  async upload(containerId: string, path: string, content: Buffer): Promise<FileEntry> {
    if (content.length > this.maxUploadBytes) {
      throw new SessionBoxError(
        "FS_TOO_LARGE",
        `upload exceeds the ${this.maxUploadBytes} byte limit`,
      );
    }

    const target = this.resolve(path);
    return await this.run(containerId, async (session) => {
      await session.writeFileAtomic(target, content);
      return await session.stat(target);
    });
  }

  async download(
    containerId: string,
    path: string,
  ): Promise<{ entry: FileEntry; content: Buffer }> {
    const target = this.resolve(path);
    return await this.run(containerId, async (session) => {
      const entry = await session.stat(target);
      assertRegularFile(entry);
      if (entry.size > this.maxUploadBytes) {
        throw new SessionBoxError(
          "FS_TOO_LARGE",
          `file exceeds the ${this.maxUploadBytes} byte download limit`,
        );
      }
      const content = await session.readFile(target);
      return {
        entry,
        content,
      };
    });
  }

  private resolve(path: string): string {
    return normalizeContainerPath(path);
  }

  private async run<T>(
    containerId: string,
    operation: (session: SshSession) => Promise<T>,
  ): Promise<T> {
    try {
      const result = await this.containers.withSshSession(containerId, operation);
      await this.containers.touch(containerId);
      return result;
    } catch (error) {
      throw toPublicSshError(error, this.logger, "file.operation.failed");
    }
  }
}

function assertRegularFile(entry: { type: string }): void {
  if (entry.type === "directory") {
    throw new SessionBoxError("FS_IS_DIRECTORY", "the path is a directory");
  }
  if (entry.type !== "file") {
    throw new SessionBoxError("FS_NOT_REGULAR_FILE", "only regular files are supported here");
  }
}
