import {
  AGENT_PROTOCOL_VERSION,
  AgentResponseSchema,
  AgentWelcomeSchema,
  type AgentRequest,
  type AgentResponse,
  type ExecResult,
  type FileContent,
  type FileEntry,
  type FileListResponse,
  type FileMetadata,
} from "@sessionbox/protocol";
import { newRequestId } from "@sessionbox/shared";
import { SessionBoxClientError } from "./errors.ts";
import {
  READY_STATE_OPEN,
  type WebSocketFactory,
  type WebSocketLike,
} from "./websocket.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RequestPayload = DistributiveOmit<AgentRequest, "requestId" | "containerId">;

export interface ContainerRuntimeOptions {
  containerId: string;
  url: string;
  webSocketFactory: WebSocketFactory;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (response: AgentResponse) => void;
  reject: (error: SessionBoxClientError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * A live connection to one container through the SessionBox agent protocol.
 * The harness adapter uses this instead of touching SSH, files or Docker.
 */
export class ContainerRuntime {
  private readonly containerId: string;
  private readonly url: string;
  private readonly webSocketFactory: WebSocketFactory;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  private socket: WebSocketLike | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private handshake: { resolve: () => void; reject: (error: SessionBoxClientError) => void } | null =
    null;

  constructor(options: ContainerRuntimeOptions) {
    this.containerId = options.containerId;
    this.url = options.url;
    this.webSocketFactory = options.webSocketFactory;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async connect(): Promise<void> {
    if (this.socket !== null) return;

    const socket = this.webSocketFactory(this.url);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(
          new SessionBoxClientError("OPERATION_TIMEOUT", "timed out opening the agent connection"),
        );
      }, this.connectTimeoutMs);

      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new SessionBoxClientError("SSH_UNAVAILABLE", "agent connection failed"));
      });
    });

    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("close", () => this.onClose());

    const welcome = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handshake = null;
        reject(new SessionBoxClientError("OPERATION_TIMEOUT", "agent handshake timed out"));
      }, this.connectTimeoutMs);
      this.handshake = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });

    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: AGENT_PROTOCOL_VERSION,
        client: "sessionbox-client",
      }),
    );

    await welcome;
  }

  async exec(
    command: string,
    options: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    const response = await this.request({
      type: "exec",
      command,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (response.type !== "exec.result") {
      throw unexpected(response.type);
    }
    return { exitCode: response.exitCode, stdout: response.stdout, stderr: response.stderr };
  }

  async readFile(path: string): Promise<FileContent> {
    const response = await this.request({ type: "file.read", path });
    if (response.type !== "file.read.result") throw unexpected(response.type);
    return response.file;
  }

  async writeFile(path: string, content: string): Promise<FileMetadata> {
    const response = await this.request({ type: "file.write", path, content });
    if (response.type !== "file.write.result") throw unexpected(response.type);
    return response.file;
  }

  async listFiles(path: string): Promise<FileListResponse> {
    const response = await this.request({ type: "file.list", path });
    if (response.type !== "file.list.result") throw unexpected(response.type);
    return { path: response.path, entries: response.entries };
  }

  async statFile(path: string): Promise<FileEntry> {
    const response = await this.request({ type: "file.stat", path });
    if (response.type !== "file.stat.result") throw unexpected(response.type);
    return response.entry;
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const response = await this.request({
      type: "file.mkdir",
      path,
      ...(options.recursive !== undefined ? { recursive: options.recursive } : {}),
    });
    if (response.type !== "file.mkdir.result") throw unexpected(response.type);
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const response = await this.request({
      type: "file.remove",
      path,
      ...(options.recursive !== undefined ? { recursive: options.recursive } : {}),
    });
    if (response.type !== "file.remove.result") throw unexpected(response.type);
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.rejectPending(new SessionBoxClientError("INVALID_STATE", "runtime was closed"));
    if (socket !== null) socket.close();
  }

  private async request(payload: RequestPayload): Promise<AgentResponse> {
    const socket = this.socket;
    if (socket === null || socket.readyState !== READY_STATE_OPEN) {
      throw new SessionBoxClientError("INVALID_STATE", "agent connection is not open");
    }

    const requestId = newRequestId();

    return await new Promise<AgentResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new SessionBoxClientError("OPERATION_TIMEOUT", "agent request timed out"));
      }, this.requestTimeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });

      try {
        socket.send(JSON.stringify({ ...payload, requestId, containerId: this.containerId }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(
          new SessionBoxClientError(
            "SSH_UNAVAILABLE",
            `failed to send request: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  private onMessage(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return;
    }

    const welcome = AgentWelcomeSchema.safeParse(parsed);
    if (welcome.success && this.handshake !== null) {
      const handshake = this.handshake;
      this.handshake = null;
      handshake.resolve();
      return;
    }

    const response = AgentResponseSchema.safeParse(parsed);
    if (!response.success) return;

    const message = response.data;
    const pending = this.pending.get(message.requestId ?? "");
    if (pending === undefined) return;

    this.pending.delete(message.requestId ?? "");
    clearTimeout(pending.timer);

    if (message.type === "error") {
      pending.reject(new SessionBoxClientError(message.code, message.message));
      return;
    }
    pending.resolve(message);
  }

  private onClose(): void {
    this.socket = null;
    if (this.handshake !== null) {
      const handshake = this.handshake;
      this.handshake = null;
      handshake.reject(new SessionBoxClientError("SSH_UNAVAILABLE", "agent connection closed"));
    }
    this.rejectPending(new SessionBoxClientError("SSH_UNAVAILABLE", "agent connection closed"));
  }

  private rejectPending(error: SessionBoxClientError): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }
}

function unexpected(type: string): SessionBoxClientError {
  return new SessionBoxClientError("INTERNAL_ERROR", `unexpected response type "${type}"`);
}
