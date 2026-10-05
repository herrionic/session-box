import { SessionBoxError } from "../errors.ts";
import type { Logger } from "../logging.ts";
import {
  SshCancelledError,
  SshNotFoundError,
  SshTimeoutError,
  SshUnavailableError,
} from "./session.ts";

/**
 * Maps SSH-layer failures to stable public error codes and keeps the details
 * in the server log (PROJECT.md §37).
 */
export function toPublicSshError(error: unknown, logger: Logger, event: string): SessionBoxError {
  if (error instanceof SessionBoxError) return error;

  if (error instanceof SshNotFoundError) {
    return new SessionBoxError("NOT_FOUND", "the path was not found in the container", {
      cause: error,
    });
  }
  if (error instanceof SshTimeoutError) {
    return new SessionBoxError("OPERATION_TIMEOUT", "the operation timed out", { cause: error });
  }
  if (error instanceof SshCancelledError) {
    return new SessionBoxError("OPERATION_CANCELLED", "the operation was cancelled", {
      cause: error,
    });
  }
  if (error instanceof SshUnavailableError) {
    return new SessionBoxError(
      "SSH_UNAVAILABLE",
      "the container SSH connection is unavailable",
      { cause: error },
    );
  }

  logger.error(
    { event, err: error instanceof Error ? error.message : String(error) },
    "SSH operation failed",
  );
  return new SessionBoxError("RUNTIME_ERROR", "the operation failed; see server logs", {
    cause: error,
  });
}
