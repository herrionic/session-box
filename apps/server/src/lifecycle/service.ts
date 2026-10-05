import type { Logger } from "../logging.ts";
import type { SandboxService } from "../sandbox/service.ts";
import type { SandboxRecord } from "../sandbox/types.ts";

export interface LifecycleServiceOptions {
  sandboxes: SandboxService;
  logger: Logger;
  intervalMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

const DEFAULT_INTERVAL_MS = 15_000;

/**
 * Enforces the lifecycle policy owned by SessionBox (PROJECT.md §11):
 * `autoStop` plus the optional idle timeout and maximum lifetime. Active
 * connections always win — a sandbox with an open agent or terminal
 * connection is never auto-stopped.
 */
export class LifecycleService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: LifecycleServiceOptions) {}

  start(): void {
    if (this.timer !== null) return;

    const intervalMs = this.options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.options.logger.warn(
          {
            event: "lifecycle.evaluation_failed",
            err: error instanceof Error ? error.message : String(error),
          },
          "lifecycle evaluation failed",
        );
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One evaluation pass over every running sandbox; also used by tests. */
  async runOnce(): Promise<void> {
    const now = (this.options.now ?? Date.now)();

    for (const record of await this.options.sandboxes.list()) {
      if (record.status !== "running") continue;

      const reason = expiryReason(record, now);
      if (reason === null) continue;

      this.options.logger.info(
        { event: "lifecycle.auto_stop", sandboxId: record.id, reason },
        "auto-stopping sandbox",
      );

      try {
        await this.options.sandboxes.stop(record.id);

        if (record.lifecycle.deleteAfterStop) {
          await this.options.sandboxes.remove(record.id);
          this.options.logger.info(
            { event: "lifecycle.auto_delete", sandboxId: record.id },
            "deleted sandbox after auto-stop",
          );
        }
      } catch (error) {
        this.options.logger.warn(
          {
            event: "lifecycle.auto_stop_failed",
            sandboxId: record.id,
            err: error instanceof Error ? error.message : String(error),
          },
          "auto-stop failed; the sandbox keeps running",
        );
      }
    }
  }
}

function expiryReason(record: SandboxRecord, now: number): string | null {
  const { lifecycle } = record;
  if (!lifecycle.autoStop) return null;

  // Live connections keep the sandbox alive regardless of the timers.
  if (record.activeConnections > 0) return null;

  if (lifecycle.idleTimeoutSeconds !== undefined) {
    const lastActivity = Date.parse(
      record.lastActivityAt ?? record.startedAt ?? record.createdAt,
    );
    if (Number.isFinite(lastActivity)) {
      const idleMs = now - lastActivity;
      if (idleMs >= lifecycle.idleTimeoutSeconds * 1000) {
        return `idle for ${Math.round(idleMs / 1000)}s`;
      }
    }
  }

  if (lifecycle.maxLifetimeSeconds !== undefined && record.startedAt !== undefined) {
    const startedAt = Date.parse(record.startedAt);
    if (Number.isFinite(startedAt)) {
      const ageMs = now - startedAt;
      if (ageMs >= lifecycle.maxLifetimeSeconds * 1000) {
        return `alive for ${Math.round(ageMs / 1000)}s`;
      }
    }
  }

  return null;
}
