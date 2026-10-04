/**
 * Pi adapter smoke test: drives the tools the extension registers against a
 * real SessionBox server, without a model in the loop.
 *
 *   pnpm --filter @sessionbox/pi-plugin smoke --url http://host:8787
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sessionboxExtension from "../src/index.ts";

type Tool = {
  name: string;
  execute: (id: string, params: unknown) => Promise<unknown>;
};

type Handler = (event: unknown, ctx: unknown) => unknown;

const urlIndex = process.argv.indexOf("--url");
const baseUrl = urlIndex >= 0 ? process.argv[urlIndex + 1] : "http://127.0.0.1:8787";
if (baseUrl === undefined || baseUrl === "") {
  console.error("usage: smoke.ts --url <baseUrl>");
  process.exit(2);
}

const bindingsDir = await mkdtemp(join(tmpdir(), "sessionbox-pi-smoke-"));
process.env.SESSIONBOX_URL = baseUrl;
process.env.SESSIONBOX_BINDINGS_FILE = join(bindingsDir, "bindings.json");

const workspaceDir = await mkdtemp(join(tmpdir(), "sessionbox-pi-ws-"));
process.chdir(workspaceDir);

const tools = new Map<string, Tool>();
const handlers = new Map<string, Handler[]>();

const api = {
  registerTool(tool: Tool): void {
    tools.set(tool.name, tool);
  },
  on(event: string, handler: Handler): () => void {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
    return () => {};
  },
  registerCommand(): void {},
  registerFlag(): void {},
  getFlag(): unknown {
    return false;
  },
};

sessionboxExtension(api as never);

const ctx = {
  cwd: workspaceDir,
  sessionManager: { getSessionId: () => "ses_pi_smoke" },
  ui: {
    notify: (message: string, level: string) => console.log(`[${level}] ${message}`),
    setStatus: (): void => {},
  },
};

const log = (label: string, value: unknown): void => {
  console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
};

await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);

const bash = tools.get("bash");
const bashResult = await bash?.execute("smoke-1", {
  command: "hostname; id; echo HELLO_FROM_PI_ADAPTER",
});
log("bash", bashResult);

const write = tools.get("write");
await write?.execute("smoke-2", {
  path: join(workspaceDir, "smoke.txt"),
  content: "written through the Pi adapter\n",
});
log("write", "ok");

const read = tools.get("read");
const readResult = await read?.execute("smoke-3", { path: join(workspaceDir, "smoke.txt") });
log("read", readResult);

const ls = tools.get("ls");
const lsResult = await ls?.execute("smoke-4", { path: workspaceDir });
log("ls", lsResult);

await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, ctx);
console.log("smoke complete");
