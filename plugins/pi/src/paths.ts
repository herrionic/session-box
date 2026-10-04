import path from "node:path";

export const DEFAULT_SANDBOX_ROOT = "/workspace";

/**
 * Maps a path the Pi tool layer received (a host path) to the equivalent path
 * inside the sandbox.
 *
 * Rules, in order:
 * 1. Paths already under the sandbox root (`/workspace/...`) pass through, so
 *    a session can address the sandbox explicitly on any host.
 * 2. On Windows hosts, POSIX-absolute paths (e.g. `/tmp/x`) pass through: the
 *    host cannot mean them literally.
 * 3. Host paths inside the session cwd map to `<sandboxRoot>/<relative>`.
 * 4. Everything else is rejected: silently mapping an unrelated host path into
 *    the sandbox would hide a mistake.
 */
export function toSandboxPath(
  input: string,
  hostCwd: string,
  sandboxRoot: string = DEFAULT_SANDBOX_ROOT,
): string {
  if (input === "") {
    throw new Error("path must not be empty");
  }

  const root = sandboxRoot.replace(/\/+$/, "") || "/";

  if (input === root || input.startsWith(`${root}/`)) {
    return input;
  }

  if (process.platform === "win32" && input.startsWith("/")) {
    return input;
  }

  const host = path.resolve(input);
  const cwd = path.resolve(hostCwd);
  const relative = path.relative(cwd, host);
  const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));

  if (!inside) {
    throw new Error(
      `path is outside the session workspace (${hostCwd}) and is not a sandbox path: ${input}`,
    );
  }

  const posixRelative = relative.split(path.sep).filter((segment) => segment !== "").join("/");
  return posixRelative === "" ? root : `${root}/${posixRelative}`;
}
