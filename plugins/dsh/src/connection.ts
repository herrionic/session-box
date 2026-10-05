import { SessionBoxClient, type ContainerRuntime } from "@sessionbox/client";
import type { SessionBoxPluginConfig } from "./config.ts";

/**
 * What the capability providers need from the binding. Keeping it an interface
 * lets tests supply a fake without a SessionBox server.
 */
export interface SessionBoxRuntimeProvider {
  connect(): Promise<{ containerId: string; runtime: ContainerRuntime }>;
  containerIdOrNull(): string | null;
  close(): Promise<void>;
}

/**
 * Process-scoped SessionBox binding: resolves (or creates) the container this
 * harness process runs against and keeps one agent-protocol connection for
 * both capability providers. DSH's execution world is per harness process
 * (like its SSH helper), so the binding lives here rather than per call.
 */
export class SessionBoxConnection implements SessionBoxRuntimeProvider {
  private readonly client: SessionBoxClient;
  private runtime: ContainerRuntime | null = null;
  private containerId: string | null = null;
  private connecting: Promise<{ containerId: string; runtime: ContainerRuntime }> | null = null;

  constructor(private readonly config: SessionBoxPluginConfig) {
    this.client = new SessionBoxClient({
      baseUrl: config.baseUrl,
      ...(config.token !== undefined ? { token: config.token } : {}),
    });
  }

  async connect(): Promise<{ containerId: string; runtime: ContainerRuntime }> {
    if (this.runtime !== null && this.containerId !== null) {
      return { containerId: this.containerId, runtime: this.runtime };
    }

    if (this.connecting === null) {
      this.connecting = this.doConnect().catch((error: unknown) => {
        this.connecting = null;
        throw error;
      });
    }
    return await this.connecting;
  }

  containerIdOrNull(): string | null {
    return this.containerId;
  }

  async close(): Promise<void> {
    const runtime = this.runtime;
    this.runtime = null;
    this.containerId = null;
    this.connecting = null;

    if (runtime !== null) {
      try {
        await runtime.close();
      } catch {
        // The connection is already gone; nothing to release.
      }
    }
  }

  private async doConnect(): Promise<{ containerId: string; runtime: ContainerRuntime }> {
    const containerId = await this.resolveContainerId();
    const runtime = await this.client.connect(containerId);
    this.runtime = runtime;
    this.containerId = containerId;
    return { containerId, runtime };
  }

  private async resolveContainerId(): Promise<string> {
    const { config } = this;

    if (config.containerId !== undefined) {
      await this.client.getContainer(config.containerId);
      return config.containerId;
    }

    if (config.containerName !== undefined) {
      const existing = (await this.client.listContainers()).find(
        (container) =>
          container.name === config.containerName &&
          container.status !== "failed" &&
          container.status !== "deleting",
      );
      if (existing !== undefined) return existing.id;
    }

    const container = await this.client.createContainer({
      name: config.containerName ?? `dsh-${process.pid}`,
    });
    return container.id;
  }
}
