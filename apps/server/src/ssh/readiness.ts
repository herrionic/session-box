import { SessionBoxError } from "../errors.ts";
import type { SshSessionFactory } from "./session.ts";

export interface WaitForSshOptions {
  factory: SshSessionFactory;
  sandboxId: string;
  runtimeRef: string;
  timeoutMs?: number;
  intervalMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_INTERVAL_MS = 500;

/**
 * Polls the sandbox SSH endpoint until a session can be established. The
 * sandbox is only reported as `running` after this succeeds (PROJECT.md §13).
 */
export async function waitForSsh(options: WaitForSshOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;

  let lastError: unknown;

  for (;;) {
    try {
      const session = await options.factory.create({
        sandboxId: options.sandboxId,
        runtimeRef: options.runtimeRef,
      });
      await session.close();
      return;
    } catch (error) {
      lastError = error;
    }

    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }

  throw new SessionBoxError(
    "SSH_UNAVAILABLE",
    "sandbox SSH did not become ready before the timeout",
    { cause: lastError },
  );
}
