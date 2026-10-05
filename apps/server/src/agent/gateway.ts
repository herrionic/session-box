import { isUtf8 } from "node:buffer";
import type {
  AgentRequest,
  AgentResponse,
  FileEntry,
} from "@sessionbox/protocol";
import { SessionBoxError } from "../errors.ts";
import type { Logger } from "../logging.ts";
import type { ContainerService } from "../container/service.ts";
import { normalizeContainerPath } from "../ssh/paths.ts";
import { toPublicSshError } from "../ssh/public-errors.ts";

/** Largest file the agent protocol will move in one message. */
const MAX_TRANSFER_BYTES = 8 * 1024 * 1024;

/**
 * Executes agent protocol requests against a container. Operations work on
 * absolute paths inside the container; the container is the isolation
 * boundary, so paths are not confined to the workspace (same for the human
 * file manager). The SSH user's permissions are the only limit.
 */
export class AgentGateway {
  constructor(
    private readonly containers: ContainerService,
    private readonly logger: Logger,
  ) {}

  async handle(
    request: AgentRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentResponse> {
    try {
      switch (request.type) {
        case "exec":
          return await this.exec(request, options.signal);
        case "exec.cancel":
          // Cancellation is connection-scoped and handled by the WebSocket route.
          throw new SessionBoxError(
            "INVALID_REQUEST",
            "exec.cancel is handled at the connection level",
          );
        case "file.read":
          return await this.readFile(request);
        case "file.readBytes":
          return await this.readBytes(request);
        case "file.write":
          return await this.writeFile(request);
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
    signal?: AbortSignal,
  ): Promise<AgentResponse> {
    const result = await this.containers.withSshSession(request.containerId, (session) =>
      session.exec(request.command, {
        ...(request.cwd !== undefined ? { cwd: normalizeContainerPath(request.cwd) } : {}),
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(signal !== undefined ? { signal } : {}),
      }),
    );

    return {
      requestId: request.requestId,
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

    const file = await this.containers.withSshSession(request.containerId, async (session) => {
      const entry = await session.stat(path);
      if (entry.type !== "file") {
        throw new SessionBoxError("INVALID_REQUEST", "only regular files can be read");
      }
      if (entry.size > MAX_TRANSFER_BYTES) {
        throw new SessionBoxError(
          "INVALID_REQUEST",
          `file exceeds the ${MAX_TRANSFER_BYTES} byte protocol limit`,
        );
      }
      const content = await session.readFile(path);
      if (!isUtf8(content) || content.includes(0)) {
        throw new SessionBoxError(
          "FS_NOT_TEXT",
          "file is not valid UTF-8 text; use file.readBytes for binary content",
        );
      }
      return {
        path,
        content: content.toString("utf8"),
        size: entry.size,
        modifiedAt: entry.modifiedAt,
      };
    });

    return { requestId: request.requestId, type: "file.read.result", file };
  }

  private async readBytes(
    request: Extract<AgentRequest, { type: "file.readBytes" }>,
  ): Promise<AgentResponse> {
    const path = normalizeContainerPath(request.path);

    const file = await this.containers.withSshSession(request.containerId, async (session) => {
      const entry = await session.stat(path);
      if (entry.type !== "file") {
        throw new SessionBoxError("INVALID_REQUEST", "only regular files can be read");
      }
      if (entry.size > MAX_TRANSFER_BYTES) {
        throw new SessionBoxError(
          "INVALID_REQUEST",
          `file exceeds the ${MAX_TRANSFER_BYTES} byte protocol limit`,
        );
      }
      const content = await session.readFile(path);
      return {
        path,
        contentBase64: content.toString("base64"),
        size: entry.size,
        modifiedAt: entry.modifiedAt,
      };
    });

    return { requestId: request.requestId, type: "file.readBytes.result", file };
  }

  private async writeFile(
    request: Extract<AgentRequest, { type: "file.write" }>,
  ): Promise<AgentResponse> {
    const path = normalizeContainerPath(request.path);
    const bytes = Buffer.byteLength(request.content, "utf8");
    if (bytes > MAX_TRANSFER_BYTES) {
      throw new SessionBoxError(
        "INVALID_REQUEST",
        `content exceeds the ${MAX_TRANSFER_BYTES} byte protocol limit`,
      );
    }

    const file = await this.containers.withSshSession(request.containerId, async (session) => {
      await session.writeFile(path, request.content);
      const entry = await session.stat(path);
      return { path, size: entry.size, modifiedAt: entry.modifiedAt };
    });

    return { requestId: request.requestId, type: "file.write.result", file };
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
      session.stat(path),
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
