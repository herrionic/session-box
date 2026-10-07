import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { SessionBoxClient, type ContainerRuntime } from "@sessionbox/client";
import { resolveContainerId } from "./binding.ts";
import { loadConfig, type SessionBoxPluginConfig } from "./config.ts";
import {
  createBashOperations,
  createEditOperations,
  createLsOperations,
  createReadOperations,
  createWriteOperations,
} from "./operations.ts";
import { DEFAULT_CONTAINER_ROOT } from "./paths.ts";

/**
 * SessionBox extension for Pi.
 *
 * A Pi session gets its own container; the native bash/read/write/edit/ls tools
 * are re-registered with operations that execute inside it, so the model sees
 * exactly the same tool set while everything runs remotely.
 *
 * Failure is closed: if SessionBox is unreachable the tools report an error
 * instead of silently running on the host.
 */
export default function sessionboxExtension(pi: ExtensionAPI): void {
  pi.registerFlag("no-sessionbox", {
    description: "Run Pi tools on the host instead of inside a SessionBox container",
    type: "boolean",
    default: false,
  });

  const state: {
    runtime: ContainerRuntime | null;
    containerId: string | null;
    hostCwd: string;
    config: SessionBoxPluginConfig | null;
  } = {
    runtime: null,
    containerId: null,
    hostCwd: process.cwd(),
    config: null,
  };

  const context = {
    runtime: (): ContainerRuntime => {
      if (state.runtime === null) {
        throw new Error(
          "SessionBox is not connected for this session; check SESSIONBOX_URL and the extension status",
        );
      }
      return state.runtime;
    },
    hostCwd: () => state.hostCwd,
    containerRoot: DEFAULT_CONTAINER_ROOT,
  };

  const bash = createBashOperations(context);
  const read = createReadOperations(context);
  const write = createWriteOperations(context);
  const edit = createEditOperations(context);
  const ls = createLsOperations(context);

  const localCwd = process.cwd();
  pi.registerTool(createBashTool(localCwd, { operations: bash }));
  pi.registerTool(createReadTool(localCwd, { operations: read }));
  pi.registerTool(createWriteTool(localCwd, { operations: write }));
  pi.registerTool(createEditTool(localCwd, { operations: edit }));
  pi.registerTool(createLsTool(localCwd, { operations: ls }));

  // User-issued shell commands (`!cmd`) run in the container too.
  pi.on("user_bash", () => (state.runtime !== null ? { operations: bash } : undefined));

  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig({ flagDisabled: pi.getFlag("no-sessionbox") === true });
    state.config = config;

    if (config.disabled) {
      ctx.ui.notify("SessionBox disabled; Pi tools run on the host", "info");
      return;
    }

    state.hostCwd = ctx.cwd;

    // A reload fires session_start again; drop the previous connection first.
    await disconnect();

    const client = new SessionBoxClient({
      baseUrl: config.baseUrl,
      ...(config.token !== undefined ? { token: config.token } : {}),
    });

    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const containerId = await resolveContainerId({
        client,
        sessionId,
        bindingsFile:
          config.bindingsFile ??
          path.join(getAgentDir(), "extensions", "sessionbox", "bindings.json"),
        containerName: `pi-${sessionId.slice(0, 8)}`,
        ...(config.pinnedContainerId !== undefined
          ? { pinnedContainerId: config.pinnedContainerId }
          : {}),
      });

      state.runtime = await client.connect(containerId);
      state.containerId = containerId;

      ctx.ui.setStatus("sessionbox", `SessionBox: ${containerId}`);
      ctx.ui.notify(`SessionBox container ready: ${containerId}`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`SessionBox unavailable: ${message}`, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    await disconnect();
  });

  pi.registerCommand("sessionbox", {
    description: "Show the SessionBox container bound to this session",
    handler: async (_args, ctx) => {
      if (state.containerId === null) {
        ctx.ui.notify(
          state.config?.disabled === true
            ? "SessionBox is disabled"
            : "No SessionBox container is bound to this session",
          "warning",
        );
        return;
      }

      ctx.ui.notify(
        [
          `container: ${state.containerId}`,
          `server: ${state.config?.baseUrl ?? "(unknown)"}`,
          `workspace: ${DEFAULT_CONTAINER_ROOT}`,
        ].join("\n"),
        "info",
      );
    },
  });

  async function disconnect(): Promise<void> {
    const runtime = state.runtime;
    state.runtime = null;
    state.containerId = null;

    if (runtime !== null) {
      try {
        await runtime.close();
      } catch {
        // The connection is already gone; nothing to release.
      }
    }
  }
}
