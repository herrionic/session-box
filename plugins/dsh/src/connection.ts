import { SessionBoxClient, type SandboxRuntime } from "@sessionbox/client";
import type { SessionBoxPluginConfig } from "./config.ts";

/**
 * What the capability providers need from the binding. Keeping it an interface
 * lets tests supply a fake without a SessionBox server.
 */
export interface SessionBoxRuntimeProvider {
  connect(): Promise<{ sandboxId: string; runtime: SandboxRuntime }>;
  sandboxIdOrNull(): string | null;
  close(): Promise<void>;
}

/**
 * Process-scoped SessionBox binding: resolves (or creates) the sandbox this
 * harness process runs against and keeps one agent-protocol connection for
 * both capability providers. DSH's execution world is per harness process
 * (like its SSH helper), so the binding lives here rather than per call.
 */
export class SessionBoxConnection implements SessionBoxRuntimeProvider {
  private readonly client: SessionBoxClient;
  private runtime: SandboxRuntime | null = null;
  private sandboxId: string | null = null;
  private connecting: Promise<{ sandboxId: string; runtime: SandboxRuntime }> | null = null;

  constructor(private readonly config: SessionBoxPluginConfig) {
    this.client = new SessionBoxClient({
      baseUrl: config.baseUrl,
      ...(config.token !== undefined ? { token: config.token } : {}),
    });
  }

  async connect(): Promise<{ sandboxId: string; runtime: SandboxRuntime }> {
    if (this.runtime !== null && this.sandboxId !== null) {
      return { sandboxId: this.sandboxId, runtime: this.runtime };
    }

    if (this.connecting === null) {
      this.connecting = this.doConnect().catch((error: unknown) => {
        this.connecting = null;
        throw error;
      });
    }
    return await this.connecting;
  }

  sandboxIdOrNull(): string | null {
    return this.sandboxId;
  }

  async close(): Promise<void> {
    const runtime = this.runtime;
    this.runtime = null;
    this.sandboxId = null;
    this.connecting = null;

    if (runtime !== null) {
      try {
        await runtime.close();
      } catch {
        // The connection is already gone; nothing to release.
      }
    }
  }

  private async doConnect(): Promise<{ sandboxId: string; runtime: SandboxRuntime }> {
    const sandboxId = await this.resolveSandboxId();
    const runtime = await this.client.connect(sandboxId);
    this.runtime = runtime;
    this.sandboxId = sandboxId;
    return { sandboxId, runtime };
  }

  private async resolveSandboxId(): Promise<string> {
    const { config } = this;

    if (config.sandboxId !== undefined) {
      await this.client.getSandbox(config.sandboxId);
      return config.sandboxId;
    }

    if (config.sandboxName !== undefined) {
      const existing = (await this.client.listSandboxes()).find(
        (sandbox) =>
          sandbox.name === config.sandboxName &&
          sandbox.status !== "failed" &&
          sandbox.status !== "deleting",
      );
      if (existing !== undefined) return existing.id;
    }

    const sandbox = await this.client.createSandbox({
      name: config.sandboxName ?? `dsh-${process.pid}`,
    });
    return sandbox.id;
  }
}
