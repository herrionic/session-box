import type { Context } from "@deepseek-ai/cordis";
import { loadConfig, type SessionBoxPluginConfig } from "./config.ts";
import { SessionBoxConnection } from "./connection.ts";
import SessionBoxFileSystem from "./fs.ts";
import SessionBoxShell from "./shell.ts";

export const name = "sessionbox";

/**
 * SessionBox capability providers for DeepSeek Harness.
 *
 * One DSH process binds one sandbox: `ctx.fs` and `ctx.shell` execute inside
 * it, so the harness's native file and bash tools run transparently in the
 * sandbox without new model-visible tools. DSH's execution world is per
 * harness process (the same model as its SSH helper), so run one process per
 * session for per-session isolation.
 *
 * Configuration comes from `cordis.yml` plugin config, falling back to
 * `SESSIONBOX_URL`, `SESSIONBOX_TOKEN`, `SESSIONBOX_SANDBOX`,
 * `SESSIONBOX_SANDBOX_NAME`, `SESSIONBOX_WORKSPACE_ROOT`, `SESSIONBOX_HOST_CWD`.
 */
export async function apply(
  ctx: Context,
  config: Partial<SessionBoxPluginConfig> = {},
): Promise<void> {
  const resolved: SessionBoxPluginConfig = {
    ...loadConfig(),
    ...stripUndefined(config),
  };

  const connection = new SessionBoxConnection(resolved);
  const getConnection = (): SessionBoxConnection => connection;

  await ctx.plugin(SessionBoxFileSystem, {
    connection: getConnection,
    hostCwd: resolved.hostCwd,
    workspaceRoot: resolved.workspaceRoot,
  });
  await ctx.plugin(SessionBoxShell, {
    connection: getConnection,
    hostCwd: resolved.hostCwd,
    workspaceRoot: resolved.workspaceRoot,
    defaultTimeoutMs: resolved.defaultTimeoutMs,
    maxTimeoutMs: resolved.maxTimeoutMs,
    maxOutputBytes: resolved.maxOutputBytes,
  });

  ctx.effect(() => () => connection.close(), "sessionbox: sandbox connection");
}

function stripUndefined(config: Partial<SessionBoxPluginConfig>): Partial<SessionBoxPluginConfig> {
  return Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined),
  ) as Partial<SessionBoxPluginConfig>;
}

export { loadConfig, type SessionBoxPluginConfig } from "./config.ts";
export { SessionBoxConnection, type SessionBoxRuntimeProvider } from "./connection.ts";
export { SessionBoxFileSystem } from "./fs.ts";
export { SessionBoxShell } from "./shell.ts";
