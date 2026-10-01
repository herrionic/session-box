import type { SandboxStatus } from "@sessionbox/protocol";
import { SessionBoxError } from "../errors.ts";

export type SandboxOperation = "start" | "stop" | "restart" | "delete";

/**
 * Which sandbox statuses each operation may be applied to. Everything else is
 * a client error (INVALID_STATE) and must not touch the runtime.
 */
export const ALLOWED_STATUSES: Record<SandboxOperation, readonly SandboxStatus[]> = {
  start: ["stopped", "failed"],
  stop: ["running"],
  restart: ["running", "stopped"],
  delete: ["creating", "running", "stopped", "failed"],
};

export function assertOperationAllowed(operation: SandboxOperation, status: SandboxStatus): void {
  if (!ALLOWED_STATUSES[operation].includes(status)) {
    throw new SessionBoxError(
      "INVALID_STATE",
      `cannot ${operation} a sandbox in status "${status}"`,
    );
  }
}
