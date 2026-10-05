import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import type { AgentRequest, AgentResponse, FileEntry } from "@sessionbox/protocol";
import { SessionBoxError } from "../errors.ts";
import type { Logger } from "../logging.ts";
import type { ContainerService } from "../container/service.ts";
import { normalizeContainerPath } from "../ssh/paths.ts";
import { toPublicSshError } from "../ssh/public-errors.ts";
import { SshNotFoundError, type SshFileEntry, type SshSession } from "../ssh/session.ts";

/** Largest file the agent protocol will move in one message. */
const MAX_TRANSFER_BYTES = 8 * 1024 * 1024;
/** Above this size a version guard falls back to the cheap (mtime:size) form. */
const MAX_HASH_BYTES = 64 * 1024 * 1024;
const VERSION_DIGEST_LENGTH = 16;

/** Default per-deployment caps; `main.ts` passes the configured values. */
const DEFAULT_MAX_COMMAND_BYTES = 1024 * 1024;
const DEFAULT_MAX_EXEC_TIMEOUT_MS = 30 * 60_000;

export interface AgentGatewayOptions {
  maxCommandBytes?: number;
  maxExecTimeoutMs?: number;
}

/** Non-terminal preview frames emitted while an exec runs. */
export type AgentStreamEvent = Extract<AgentResponse, { type: "exec.stdout" | "exec.stderr" }>;

export interface AgentHandleOptions {
  signal?: AbortSignal;
  /** Preview frames for a running exec (the terminal result carries everything). */
  onStream?: (event: AgentStreamEvent) => void;
}

/**
 * Executes agent protocol requests against a container. Operations work on
 * absolute paths inside the container; the container is the isolation
 * boundary, so paths are not confined to the workspace (same for the human
 * file manager). The SSH user's permissions are the only limit.
 */
export class AgentGateway {
  private readonly containers: ContainerService;
  private readonly logger: Logger;
  private readonly maxCommandBytes: number;
  private readonly maxExecTimeoutMs: number;

  constructor(containers: ContainerService, logger: Logger, options: AgentGatewayOptions = {}) {
    this.containers = containers;
    this.logger = logger;
    this.maxCommandBytes = options.maxCommandBytes ?? DEFAULT_MAX_COMMAND_BYTES;
    this.maxExecTimeoutMs = options.maxExecTimeoutMs ?? DEFAULT_MAX_EXEC_TIMEOUT_MS;
  }

  async handle(request: AgentRequest, options: AgentHandleOptions = {}): Promise<AgentResponse> {
    try {
      switch (request.type) {
        case "exec":
          return await this.exec(request, options);
        case "exec.cancel":
        case "terminal.open":
        case "terminal.input":
        case "terminal.resize":
        case "terminal.close":
          // Connection-scoped; the WebSocket route handles them before dispatch.
          throw new SessionBoxError(
            "INVALID_REQUEST",
            `${request.type} is handled at the connection level`,
          );
        case "file.read":
          return await this.readFile(request);
        case "file.readBytes":
          return await this.readBytes(request);
        case "file.write":
          return await this.writeFile(request);
        case "file.rename":
          return await this.rename(request);
        case "file.chmod":
          return await this.chmod(request);
        case "file.symlink":
          return await this.symlink(request);
        case "file.list":
          return await this.listFiles(request);
        case "file.stat":
          return await this.statFile(request);
        case "file.mkdir":
          return await this.mkdir(request);
        case "file.remove":
          return await this.remove(request);
      }
    } catch (error) {
      throw toPublicSshError(error, this.logger, `agent.${request.type}.failed`);
    }
  }

  private async exec(
    request: Extract<AgentRequest, { type: "exec" }>,
    options: AgentHandleOptions,
  ): Promise<AgentResponse> {
    if (Buffer.byteLength(request.command, "utf8") > this.maxCommandBytes) {
      throw new SessionBoxError(
        "INVALID_REQUEST",
        `command exceeds the ${this.maxCommandBytes} byte limit`,
      );
    }
    if (request.timeoutMs !== undefined && request.timeoutMs > this.maxExecTimeoutMs) {
      throw new SessionBoxError(
        "INVALID_REQUEST",
        `timeoutMs exceeds the ${this.maxExecTimeoutMs} ms limit`,
      );
    }

    const requestId = request.requestId;
    const onStream = options.onStream;
    const result = await this.containers.withSshSession(request.containerId, (session) =>
      session.exec(request.command, {
        ...(request.cwd !== undefined ? { cwd: normalizeContainerPath(request.cwd) } : {}),
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(onStream !== undefined
          ? {
              onStdout: (data: string) => onStream({ type: "exec.stdout", requestId, data }),
              onStderr: (data: string) => onStream({ type: "exec.stderr", requestId, data }),
            }
          : {}),
      }),
    );

    return {
      requestId,
      type: "exec.result",
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  private async readFile(
    request: Extract<AgentRequest, { type: "file.read" }>,
  ): Promise<AgentResponse> {
    const path = normalizeContainerPath(request.path);
    const requestedOffset = request.offset ?? 0;
    const requestedLength = request.length;

    const file = await this.containers.withSshSession(request.containerId, async (session) => {
      const entry = await session.stat(path);
      assertRegularFile(entry);

      const fullRead = requestedOffset === 0 && requestedLength === undefined;
      if (fullRead) {
        if (entry.size > MAX_TRANSFER_BYTES) throw tooLarge();
        const content = await session.readFile(path);
        if (!isTextChunk(content, true)) throw notText();
        return contentResult(path, entry, content, 0, true, richVersion(entry, content));
      }

      if (requestedOffset >= entry.size) {
        return contentResult(path, entry, Buffer.alloc(0), requestedOffset, true, entry.version);
      }

      const maxLength = requestedLength ?? entry.size - requestedOffset;
      const effective = Math.min(maxLength, MAX_TRANSFER_BYTES, entry.size - requestedOffset);
      const content = await session.readFileRange(path, requestedOffset, effective);
      const eof = requestedOffset + content.length >= entry.size;
      if (!isTextChunk(content, requestedOffset === 0 && eof)) throw notText();
      // A range is only part of the file, so its version stays the cheap form.
      return contentResult(path, entry, content, requestedOffset, eof, entry.version);
    });

    return { requestId: request.requestId, type: "file.read.result", file };
  }

  private async readBytes(
    request: Extract<AgentRequest, { type: "file.readBytes" }>,
  ): Promise<AgentResponse> {
    const path = normalizeContainerPath(request.path);

    const file = await this.containers.withSshSession(request.containerId, async (session) => {
      const entry = await session.stat(path);
      assertRegularFile(entry);
      const limit = Math.min(request.maxBytes ?? MAX_TRANSFER_BYTES, MAX_TRANSFER_BYTES);
      if (entry.size > limit) throw tooLarge();

      const content = await session.readFile(path);
      return {
        path,
        contentBase64: content.toString("base64"),
        size: entry.size,
        modifiedAt: entry.modifiedAt,
        version: richVersion(entry, content),
      };
    });

    return { requestId: request.requestId, type: "file.readBytes.result", file };
  }

  private async writeFile(
    request: Extract<AgentRequest, { type: "file.write" }>,
  ): Promise<AgentResponse> {
    const path = normalizeContainerPath(request.path);
    const bytes = Buffer.byteLength(request.content, "utf8");
    if (bytes > MAX_TRANSFER_BYTES) throw tooLarge("content");
    const contentBytes = Buffer.from(request.content, "utf8");

    const file = await this.containers.withSshSession(request.containerId, async (session) => {
      if (request.expected !== undefined) {
        const current = await currentVersion(session, path, request.expected.version);
        if (current !== request.expected.version) {
          throw new SessionBoxError("VERSION_CONFLICT", "the file changed since it was observed", {
            details: { current },
          });
        }
      }

      await session.writeFileAtomic(path, request.content);
      const entry = await session.stat(path);
      return {
        path,
        size: entry.size,
        modifiedAt: entry.modifiedAt,
        version: richVersion(entry, contentBytes),
      };
    });

    return { requestId: request.requestId, type: "file.write.result", file };
  }

  private async rename(
    request: Extract<AgentRequest, { type: "file.rename" }>,
  ): Promise<AgentResponse> {
    const from = normalizeContainerPath(request.from);
    const to = normalizeContainerPath(request.to);

    await this.containers.withSshSession(request.containerId, async (session) => {
      if (request.overwrite === false) {
        const existing = await session.stat(to).catch((error: unknown) => {
          if (error instanceof SshNotFoundError) return undefined;
          throw error;
        });
        if (existing !== undefined) {
          throw new SessionBoxError("INVALID_REQUEST", "the destination already exists");
        }
      }
      await session.rename(from, to);
    });

    return { requestId: request.requestId, type: "file.rename.result", from, to };
  }

  private async chmod(
    request: Extract<AgentRequest, { type: "file.chmod" }>,
  ): Promise<AgentResponse> {
    const path = normalizeContainerPath(request.path);
    await this.containers.withSshSession(request.containerId, (session) =>
      session.chmod(path, request.mode),
    );
    return { requestId: request.requestId, type: "file.chmod.result", path, mode: request.mode };
  }

  private async symlink(
    request: Extract<AgentRequest, { type: "file.symlink" }>,
  ): Promise<AgentResponse> {
    const path = normalizeContainerPath(request.path);
    const target = normalizeContainerPath(request.target);
    await this.containers.withSshSession(request.containerId, (session) =>
      session.symlink(path, target),
    );
    return { requestId: request.requestId, type: "file.symlink.result", path, target };
  }

  private async listFiles(
    request: Extract<AgentRequest, { type: "file.list" }>,
  ): Promise<AgentResponse> {
    const path = normalizeContainerPath(request.path);

    const entries: FileEntry[] = await this.containers.withSshSession(
      request.containerId,
      (session) => session.list(path),
    );

    return { requestId: request.requestId, type: "file.list.result", path, entries };
  }

  private async statFile(
    request: Extract<AgentRequest, { type: "file.stat" }>,
  ): Promise<AgentResponse> {
    const path = normalizeContainerPath(request.path);

    const entry = await this.containers.withSshSession(request.containerId, (session) =>
      session.stat(path, request.follow === false ? { follow: false } : {}),
    );

    return { requestId: request.requestId, type: "file.stat.result", entry };
  }

  private async mkdir(
    request: Extract<AgentRequest, { type: "file.mkdir" }>,
  ): Promise<AgentResponse> {
    const path = normalizeContainerPath(request.path);

    await this.containers.withSshSession(request.containerId, (session) =>
      session.mkdir(path, request.recursive === true ? { recursive: true } : {}),
    );

    return { requestId: request.requestId, type: "file.mkdir.result", path };
  }

  private async remove(
    request: Extract<AgentRequest, { type: "file.remove" }>,
  ): Promise<AgentResponse> {
    const path = normalizeContainerPath(request.path);

    await this.containers.withSshSession(request.containerId, (session) =>
      session.remove(path, request.recursive === true ? { recursive: true } : {}),
    );

    return { requestId: request.requestId, type: "file.remove.result", path };
  }
}

function assertRegularFile(entry: SshFileEntry): void {
  if (entry.type === "directory") {
    throw new SessionBoxError("FS_IS_DIRECTORY", "the path is a directory");
  }
  if (entry.type !== "file") {
    throw new SessionBoxError("FS_NOT_REGULAR_FILE", "only regular files can be read");
  }
}

function contentResult(
  path: string,
  entry: SshFileEntry,
  content: Buffer,
  offset: number,
  eof: boolean,
  version: string,
): {
  path: string;
  content: string;
  size: number;
  modifiedAt: number;
  version: string;
  offset: number;
  length: number;
  eof: boolean;
} {
  return {
    path,
    content: content.toString("utf8"),
    size: entry.size,
    modifiedAt: entry.modifiedAt,
    version,
    offset,
    length: content.length,
    eof,
  };
}

/**
 * Current version of `path`, in the same shape as `expected`:
 * a digest version (`mtime:size:digest`) reads the file, the cheap form
 * (`mtime:size`) only stats it.
 */
async function currentVersion(
  session: SshSession,
  path: string,
  expected: string,
): Promise<string | null> {
  const entry = await session.stat(path).catch((error: unknown) => {
    if (error instanceof SshNotFoundError) return undefined;
    throw error;
  });
  if (entry === undefined) return null;

  if (!isRichVersion(expected) || entry.type !== "file" || entry.size > MAX_HASH_BYTES) {
    return entry.version;
  }
  const content = await session.readFile(path);
  return richVersion(entry, content);
}

/** `mtime:size:digest` — returned whenever the content is in hand. */
function richVersion(entry: { modifiedAt: number; size: number }, content: Buffer): string {
  return `${entry.modifiedAt}:${entry.size}:${contentDigest(content)}`;
}

function contentDigest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, VERSION_DIGEST_LENGTH);
}

function isRichVersion(version: string): boolean {
  return version.split(":").length >= 3;
}

/**
 * Text check. Full reads must be valid UTF-8 end to end; a ranged read may
 * split a multi-byte sequence at its tail, so the last few bytes are exempt
 * (NUL bytes always fail).
 */
function isTextChunk(chunk: Buffer, wholeFile: boolean): boolean {
  if (chunk.includes(0)) return false;
  if (wholeFile) return isUtf8(chunk);
  const slack = Math.min(3, chunk.length);
  return isUtf8(chunk.subarray(0, chunk.length - slack));
}

function tooLarge(what = "file"): SessionBoxError {
  return new SessionBoxError(
    "FS_TOO_LARGE",
    `the ${what} exceeds the ${MAX_TRANSFER_BYTES} byte protocol limit`,
  );
}

function notText(): SessionBoxError {
  return new SessionBoxError(
    "FS_NOT_TEXT",
    "file is not valid UTF-8 text; use file.readBytes for binary content",
  );
}
