export interface SessionBoxPluginConfig {
  baseUrl: string;
  token?: string;
  /** Pin every harness process to one existing sandbox. */
  sandboxId?: string;
  /** Reuse the sandbox with this name when it already exists. */
  sandboxName?: string;
  /** Sandbox-side workspace root. */
  workspaceRoot: string;
  /** Host directory that maps to {@link workspaceRoot}. */
  hostCwd: string;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxOutputBytes: number;
}

export const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
export const DEFAULT_WORKSPACE_ROOT = "/workspace";
export const DEFAULT_TIMEOUT_MS = 120_000;
/** The agent protocol caps a single exec at 10 minutes. */
export const MAX_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Environment defaults; `cordis.yml` plugin config overrides individual keys.
 * One DSH process maps to one sandbox (DSH's execution world is per harness
 * process); run one process per session for per-session isolation.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SessionBoxPluginConfig {
  const token = env.SESSIONBOX_TOKEN?.trim();
  const sandboxId = env.SESSIONBOX_SANDBOX?.trim();
  const sandboxName = env.SESSIONBOX_SANDBOX_NAME?.trim();

  return {
    baseUrl: env.SESSIONBOX_URL?.trim() || DEFAULT_BASE_URL,
    ...(token !== undefined && token !== "" ? { token } : {}),
    ...(sandboxId !== undefined && sandboxId !== "" ? { sandboxId } : {}),
    ...(sandboxName !== undefined && sandboxName !== "" ? { sandboxName } : {}),
    workspaceRoot: env.SESSIONBOX_WORKSPACE_ROOT?.trim() || DEFAULT_WORKSPACE_ROOT,
    hostCwd: env.SESSIONBOX_HOST_CWD?.trim() || process.cwd(),
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: MAX_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  };
}
