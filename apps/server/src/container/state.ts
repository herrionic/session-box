import type { ContainerStatus } from "@sessionbox/protocol";
import { SessionBoxError } from "../errors.ts";

export type ContainerOperation = "start" | "stop" | "restart" | "delete";

/**
 * Which container statuses each operation may be applied to. Everything else is
 * a client error (INVALID_STATE) and must not touch the runtime.
 */
export const ALLOWED_STATUSES: Record<ContainerOperation, readonly ContainerStatus[]> = {
  start: ["stopped", "failed"],
  stop: ["running"],
  restart: ["running", "stopped"],
  delete: ["creating", "running", "stopped", "failed"],
};

export function assertOperationAllowed(operation: ContainerOperation, status: ContainerStatus): void {
  if (!ALLOWED_STATUSES[operation].includes(status)) {
    throw new SessionBoxError(
      "INVALID_STATE",
      `cannot ${operation} a container in status "${status}"`,
    );
  }
}
