import { posix } from "node:path";
import { SessionBoxError } from "../errors.ts";

function invalid(message: string): SessionBoxError {
  return new SessionBoxError("INVALID_REQUEST", message);
}

/**
 * Normalizes a sandbox-side POSIX path and rejects anything that is not an
 * absolute, traversal-free path. Used by the file manager and the agent
 * protocol before any SSH/SFTP call (PROJECT.md §41.1, §42).
 */
export function normalizeSandboxPath(input: string): string {
  if (input.trim() === "") throw invalid("path must not be empty");
  if (input.includes("\0")) throw invalid("path must not contain NUL bytes");
  if (!input.startsWith("/")) throw invalid("path must be absolute");

  return posix.normalize(input).replace(/\/{2,}/g, "/");
}

export function isWithinWorkspace(root: string, path: string): boolean {
  const normalizedRoot = normalizeSandboxPath(root);
  const normalizedPath = normalizeSandboxPath(path);

  if (normalizedPath === normalizedRoot) return true;
  const rootPrefix = normalizedRoot === "/" ? "/" : `${normalizedRoot}/`;
  return normalizedPath.startsWith(rootPrefix);
}

/**
 * Resolves a path that must stay inside the workspace root (default `/workspace`
 * for the file manager). Traversal attempts such as
 * `/workspace/../../etc/passwd` normalize to `/etc/passwd` and are rejected.
 */
export function resolveWithinWorkspace(input: string, root: string): string {
  const path = normalizeSandboxPath(input);
  if (!isWithinWorkspace(root, path)) {
    throw invalid(`path must stay within ${root}`);
  }
  return path;
}
