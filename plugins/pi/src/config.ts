export interface SessionBoxPluginConfig {
  baseUrl: string;
  token?: string;
  /** Pin every session to one existing container (development/demo helper). */
  pinnedContainerId?: string;
  /** Override the session→container binding file location. */
  bindingsFile?: string;
  disabled: boolean;
}

export const DEFAULT_BASE_URL = "http://127.0.0.1:8787";

/**
 * Configuration comes from the environment plus the `--no-sessionbox` flag.
 * A missing SessionBox server is not a configuration error: the extension
 * reports it on session start and tools fail closed rather than running
 * locally.
 */
export function loadConfig(
  options: { env?: NodeJS.ProcessEnv; flagDisabled?: boolean } = {},
): SessionBoxPluginConfig {
  const env = options.env ?? process.env;

  const token = env.SESSIONBOX_TOKEN?.trim();
  const pinnedContainerId = env.SESSIONBOX_CONTAINER?.trim() ?? env.SESSIONBOX_SANDBOX?.trim();
  const bindingsFile = env.SESSIONBOX_BINDINGS_FILE?.trim();

  return {
    baseUrl: env.SESSIONBOX_URL?.trim() || DEFAULT_BASE_URL,
    ...(token !== undefined && token !== "" ? { token } : {}),
    ...(pinnedContainerId !== undefined && pinnedContainerId !== ""
      ? { pinnedContainerId }
      : {}),
    ...(bindingsFile !== undefined && bindingsFile !== "" ? { bindingsFile } : {}),
    disabled: options.flagDisabled === true || env.SESSIONBOX_DISABLED === "1",
  };
}
