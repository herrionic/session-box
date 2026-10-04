import type {
  CreateSandboxRequest,
  ErrorResponse,
  HealthResponse,
  Sandbox,
  UpdateSandboxSettingsRequest,
} from "@sessionbox/protocol";
import { SessionBoxClientError } from "./errors.ts";
import { SandboxRuntime } from "./runtime.ts";
import { defaultWebSocketFactory, type WebSocketFactory } from "./websocket.ts";

export interface SessionBoxClientOptions {
  /** Server base URL, e.g. http://127.0.0.1:8787 */
  baseUrl: string;
  /** Bearer token for plugin authentication (enforced from Day 6). */
  token?: string;
  /** Injectable for tests and non-standard runtimes. */
  fetchImpl?: typeof fetch;
  webSocketFactory?: WebSocketFactory;
  requestTimeoutMs?: number;
}

/**
 * Shared client for harness adapters (PROJECT.md §31). Harness-specific code
 * stays outside; this class only speaks the public SessionBox API.
 */
export class SessionBoxClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketFactory: WebSocketFactory;
  private readonly requestTimeoutMs: number;

  constructor(options: SessionBoxClientOptions) {
    const baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (baseUrl === "") {
      throw new SessionBoxClientError("INVALID_REQUEST", "baseUrl must not be empty");
    }
    this.baseUrl = baseUrl;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async health(): Promise<HealthResponse> {
    return await this.request("/api/health");
  }

  async listSandboxes(): Promise<Sandbox[]> {
    return await this.request("/api/sandboxes");
  }

  async createSandbox(input: CreateSandboxRequest = {}): Promise<Sandbox> {
    return await this.request("/api/sandboxes", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async getSandbox(id: string): Promise<Sandbox> {
    return await this.request(`/api/sandboxes/${encodeURIComponent(id)}`);
  }

  async startSandbox(id: string): Promise<Sandbox> {
    return await this.request(`/api/sandboxes/${encodeURIComponent(id)}/start`, { method: "POST" });
  }

  async stopSandbox(id: string): Promise<Sandbox> {
    return await this.request(`/api/sandboxes/${encodeURIComponent(id)}/stop`, { method: "POST" });
  }

  async restartSandbox(id: string): Promise<Sandbox> {
    return await this.request(`/api/sandboxes/${encodeURIComponent(id)}/restart`, {
      method: "POST",
    });
  }

  async deleteSandbox(id: string): Promise<void> {
    await this.request(`/api/sandboxes/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async updateSandboxSettings(id: string, patch: UpdateSandboxSettingsRequest): Promise<Sandbox> {
    return await this.request(`/api/sandboxes/${encodeURIComponent(id)}/settings`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  /** Opens an agent-protocol connection to a sandbox. */
  async connect(sandboxId: string): Promise<SandboxRuntime> {
    const runtime = new SandboxRuntime({
      sandboxId,
      url: this.agentUrl(),
      webSocketFactory: this.webSocketFactory,
      requestTimeoutMs: this.requestTimeoutMs,
    });
    await runtime.connect();
    return runtime;
  }

  private agentUrl(): string {
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/api/ws/agent";
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      ...(init?.headers as Record<string, string> | undefined),
    };
    if (init?.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (this.token !== undefined) {
      headers.authorization = `Bearer ${this.token}`;
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (response.status === 204) {
      return undefined as T;
    }

    const body: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const error = (body as ErrorResponse | undefined)?.error;
      throw new SessionBoxClientError(
        error?.code ?? "INTERNAL_ERROR",
        error?.message ?? response.statusText,
      );
    }

    return body as T;
  }
}
