import type { Logger } from "../logging.ts";
import {
  SshError,
  type SshSession,
  type SshSessionFactory,
  type SshSessionRequest,
} from "./session.ts";

/**
 * Caches one SSH session per container so file operations, the terminal and the
 * agent gateway share a single connection. Sessions are explicitly released
 * when the container stops, restarts or is deleted; a failed operation drops the
 * cached session so the next request reconnects.
 */
export class SshSessionManager {
  private readonly sessions = new Map<string, Promise<SshSession>>();

  constructor(
    private readonly factory: SshSessionFactory,
    private readonly logger: Logger,
  ) {}

  get(request: SshSessionRequest): Promise<SshSession> {
    const existing = this.sessions.get(request.containerId);
    if (existing !== undefined) return existing;

    const created = this.factory.create(request).catch((error: unknown) => {
      // Never cache a failed connection.
      if (this.sessions.get(request.containerId) === created) {
        this.sessions.delete(request.containerId);
      }
      throw error;
    });

    this.sessions.set(request.containerId, created);
    return created;
  }

  /**
   * Runs an operation on the cached session. If it fails with an SSH error the
   * session is dropped (the connection may be dead) and the error is rethrown
   * so the caller can decide whether to retry.
   */
  async withSession<T>(
    request: SshSessionRequest,
    operation: (session: SshSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.get(request);
    try {
      return await operation(session);
    } catch (error) {
      // Only connection-level failures discard the cached session; clean
      // outcomes such as NOT_FOUND or a cancelled command keep it alive.
      if (error instanceof SshError && error.dropsSession) {
        await this.release(request.containerId);
      }
      throw error;
    }
  }

  async release(containerId: string): Promise<void> {
    const pending = this.sessions.get(containerId);
    if (pending === undefined) return;
    this.sessions.delete(containerId);

    try {
      const session = await pending;
      await session.close();
    } catch {
      // The connection is already gone; nothing to clean up.
    }
    this.logger.debug({ event: "ssh.connection.released", containerId }, "SSH session released");
  }

  async releaseAll(): Promise<void> {
    for (const containerId of [...this.sessions.keys()]) {
      await this.release(containerId);
    }
  }
}
