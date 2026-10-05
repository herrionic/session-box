import { posix } from "node:path";
import { SessionBoxError } from "../errors.ts";

function invalid(message: string): SessionBoxError {
  return new SessionBoxError("INVALID_REQUEST", message);
}

/**
 * Normalizes a container-side POSIX path and rejects anything that is not an
 * absolute, traversal-free path. Used by the file manager and the agent
 * protocol before any SSH/SFTP call (PROJECT.md §41.1, §42).
 */
export function normalizeContainerPath(input: string): string {
  if (input.trim() === "") throw invalid("path must not be empty");
  if (input.includes("\0")) throw invalid("path must not contain NUL bytes");
  if (!input.startsWith("/")) throw invalid("path must be absolute");

  return posix.normalize(input).replace(/\/{2,}/g, "/");
}
