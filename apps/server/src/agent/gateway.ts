import type {
  AgentRequest,
  AgentResponse,
  FileEntry,
} from "@sessionbox/protocol";
import { SessionBoxError } from "../errors.ts";
import type { Logger } from "../logging.ts";
import type { SandboxService } from "../sandbox/service.ts";
import { normalizeSandboxPath } from "../ssh/paths.ts";
import { toPublicSshError } from "../ssh/public-errors.ts";

/** Largest file the agent protocol will move in one message. */
const MAX_TRANSFER_BYTES = 8 * 1024 * 1024;

/**
 * Executes agent protocol requests against a sandbox. Agent operations work
 * on absolute paths inside the sandbox (unlike the human file manager, which
 * is confined to the workspace); the SSH user's permissions are the boundary.
 */
export class AgentGateway {
  constructor(
    private readonly sandboxes: SandboxService,
    private readonly logger: Logger,
  ) {}

  async handle(request: AgentRequest): Promise<AgentResponse> {
    try {
      switch (request.type) {
        case "exec":
          return await this.exec(request);
        case "file.read":
          return await this.readFile(request);
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

  private async exec(request: Extract<AgentRequest, { type: "exec" }>): Promise<AgentResponse> {
    const result = await this.sandboxes.withSshSession(request.sandboxId, (session) =>
      session.exec(request.command, {
        ...(request.cwd !== undefined ? { cwd: normalizeSandboxPath(request.cwd) } : {}),
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
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
    const path = normalizeSandboxPath(request.path);

    const file = await this.sandboxes.withSshSession(request.sandboxId, async (session) => {
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
        content: content.toString("utf8"),
        size: entry.size,
        modifiedAt: entry.modifiedAt,
      };
    });

    return { requestId: request.requestId, type: "file.read.result", file };
  }

  private async writeFile(
    request: Extract<AgentRequest, { type: "file.write" }>,
  ): Promise<AgentResponse> {
    const path = normalizeSandboxPath(request.path);
    const bytes = Buffer.byteLength(request.content, "utf8");
    if (bytes > MAX_TRANSFER_BYTES) {
      throw new SessionBoxError(
        "INVALID_REQUEST",
        `content exceeds the ${MAX_TRANSFER_BYTES} byte protocol limit`,
      );
    }

    const file = await this.sandboxes.withSshSession(request.sandboxId, async (session) => {
      await session.writeFile(path, request.content);
      const entry = await session.stat(path);
      return { path, size: entry.size, modifiedAt: entry.modifiedAt };
    });

    return { requestId: request.requestId, type: "file.write.result", file };
  }

  private async listFiles(
    request: Extract<AgentRequest, { type: "file.list" }>,
  ): Promise<AgentResponse> {
    const path = normalizeSandboxPath(request.path);

    const entries: FileEntry[] = await this.sandboxes.withSshSession(
      request.sandboxId,
      (session) => session.list(path),
    );

    return { requestId: request.requestId, type: "file.list.result", path, entries };
  }

  private async statFile(
    request: Extract<AgentRequest, { type: "file.stat" }>,
  ): Promise<AgentResponse> {
    const path = normalizeSandboxPath(request.path);

    const entry = await this.sandboxes.withSshSession(request.sandboxId, (session) =>
      session.stat(path),
    );

    return { requestId: request.requestId, type: "file.stat.result", entry };
  }

  private async mkdir(
    request: Extract<AgentRequest, { type: "file.mkdir" }>,
  ): Promise<AgentResponse> {
    const path = normalizeSandboxPath(request.path);

    await this.sandboxes.withSshSession(request.sandboxId, (session) =>
      session.mkdir(path, request.recursive === true ? { recursive: true } : {}),
    );

    return { requestId: request.requestId, type: "file.mkdir.result", path };
  }

  private async remove(
    request: Extract<AgentRequest, { type: "file.remove" }>,
  ): Promise<AgentResponse> {
    const path = normalizeSandboxPath(request.path);

    await this.sandboxes.withSshSession(request.sandboxId, (session) =>
      session.remove(path, request.recursive === true ? { recursive: true } : {}),
    );

    return { requestId: request.requestId, type: "file.remove.result", path };
  }
}
