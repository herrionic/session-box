import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import sessionboxExtension from "@sessionbox/pi-plugin";
import { AgentGateway } from "../src/agent/gateway.ts";
import type { ServerConfig } from "../src/config.ts";
import { InMemoryCredentialStore } from "../src/credentials/store.ts";
import { SandboxFilesService } from "../src/files/service.ts";
import { buildApp } from "../src/http/app.ts";
import type { SessionBoxApp } from "../src/http/types.ts";
import { InMemorySandboxRepository } from "../src/sandbox/repository.ts";
import { SandboxService } from "../src/sandbox/service.ts";
import { SshSessionManager } from "../src/ssh/manager.ts";
import { FakeRuntime } from "./helpers/fake-runtime.ts";
import { FakeSshSessionFactory } from "./helpers/fake-ssh.ts";
import { createTestLogger } from "./helpers/test-logger.ts";

const testConfig: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  runtime: "docker",
  logLevel: "silent",
  dataDir: "./data",
  docker: {
    socketPath: "/var/run/docker.sock",
    networkName: "sessionbox",
    baseImage: "sessionbox/base:test",
    workspace: "/workspace",
  },
  databaseFile: ":memory:",
  auth: { clients: [] },
  lifecycle: { intervalMs: 1000 },
};

interface RegisteredTool {
  name: string;
  execute: (
    id: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<unknown>;
}

type PiExtensionApi = Parameters<typeof sessionboxExtension>[0];
type PiEventHandler = (event: unknown, ctx: unknown) => unknown;

interface MockApi {
  api: PiExtensionApi;
  tools: Map<string, RegisteredTool>;
  handlers: Map<string, PiEventHandler[]>;
  commands: Map<string, unknown>;
}

function createMockApi(options: { noSessionbox?: boolean } = {}): MockApi {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, PiEventHandler[]>();
  const commands = new Map<string, unknown>();
  const flags = new Map<string, unknown>([["no-sessionbox", options.noSessionbox === true]]);

  const api = {
    registerTool(tool: RegisteredTool): void {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: PiEventHandler): () => void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerCommand(name: string, command: unknown): void {
      commands.set(name, command);
    },
    registerFlag(name: string, flag: { default?: unknown }): void {
      if (!flags.has(name)) flags.set(name, flag.default);
    },
    getFlag(name: string): unknown {
      return flags.get(name);
    },
  };

  return { api: api as unknown as PiExtensionApi, tools, handlers, commands };
}

interface Fixture {
  app: SessionBoxApp;
  ssh: FakeSshSessionFactory;
  baseUrl: string;
  workspaceDir: string;
  bindingsDir: string;
}

async function createFixture(): Promise<Fixture> {
  const runtime = new FakeRuntime();
  const logger = createTestLogger();
  const ssh = new FakeSshSessionFactory({ perSandbox: true });
  const service = new SandboxService({
    runtime,
    repository: new InMemorySandboxRepository(),
    credentials: new InMemoryCredentialStore(Buffer.alloc(32, 13)),
    ssh,
    sessions: new SshSessionManager(ssh, logger),
    logger,
    baseImage: testConfig.docker.baseImage,
    workspace: testConfig.docker.workspace,
    sshReadyTimeoutMs: 50,
    sshRetryIntervalMs: 1,
    sleep: async () => {},
  });
  const files = new SandboxFilesService({
    sandboxes: service,
    workspace: testConfig.docker.workspace,
    logger,
  });
  const gateway = new AgentGateway(service, logger);

  const app = await buildApp({ config: testConfig, logger, runtime, service, files, gateway });
  await app.listen({ host: "127.0.0.1", port: 0 });

  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  const workspaceDir = await mkdtemp(join(tmpdir(), "sessionbox-pi-ws-"));

  // Pi registers its tools with the process cwd; a real Pi process runs with
  // the session cwd, so the test mirrors that instead of relying on the repo
  // directory. afterEach restores the original cwd.
  process.chdir(workspaceDir);

  return {
    app,
    ssh,
    baseUrl: `http://127.0.0.1:${port}`,
    workspaceDir,
    bindingsDir: await mkdtemp(join(tmpdir(), "sessionbox-pi-bind-")),
  };
}

const cleanups: Array<() => Promise<void>> = [];
const savedEnv = new Map<string, string | undefined>();
const ORIGINAL_CWD = process.cwd();

function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

afterEach(async () => {
  // Restore the process cwd before removing temp directories; Windows keeps a
  // directory busy while it is the current working directory.
  process.chdir(ORIGINAL_CWD);

  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

function createMockContext(
  workspaceDir: string,
  sessionId: string,
): { ctx: unknown; notify: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> } {
  const notify = vi.fn();
  const setStatus = vi.fn();
  const ctx = {
    cwd: workspaceDir,
    sessionManager: { getSessionId: () => sessionId },
    ui: { notify, setStatus },
  };
  return { ctx, notify, setStatus };
}

describe("Pi extension against a real SessionBox server", () => {
  it("routes tools into the sandbox, reuses the binding and survives shutdown", async () => {
    const { app, ssh, baseUrl, workspaceDir, bindingsDir } = await createFixture();
    cleanups.push(() => app.close());
    cleanups.push(() => rm(workspaceDir, { recursive: true, force: true }));
    cleanups.push(() => rm(bindingsDir, { recursive: true, force: true }));

    setEnv("SESSIONBOX_URL", baseUrl);
    setEnv("SESSIONBOX_BINDINGS_FILE", join(bindingsDir, "bindings.json"));

    const { api, tools, handlers } = createMockApi();
    sessionboxExtension(api);

    const start = handlers.get("session_start")?.[0];
    expect(start).toBeDefined();

    const { ctx, setStatus } = createMockContext(workspaceDir, "ses_pi_1");
    await start?.({ type: "session_start", reason: "startup" }, ctx);
    expect(setStatus).toHaveBeenCalled();

    const sandboxes = (await (await fetch(`${baseUrl}/api/sandboxes`)).json()) as Array<{
      id: string;
    }>;
    expect(sandboxes).toHaveLength(1);
    const sandboxId = sandboxes[0]?.id ?? "";
    const session = ssh.sessionFor(sandboxId);

    // bash routes into the sandbox and streams the scripted output back
    session.execResults.push({ exitCode: 0, stdout: "AAA\n", stderr: "" });
    const bash = tools.get("bash");
    const bashResult = await bash?.execute("t1", { command: "cat /workspace/who.txt" });
    expect(session.commands).toContain("cat /workspace/who.txt");
    expect(JSON.stringify(bashResult)).toContain("AAA");

    // write maps a host path into /workspace
    const write = tools.get("write");
    await write?.execute("t2", { path: join(workspaceDir, "notes.txt"), content: "hello" });
    expect(session.nodes.get("/workspace/notes.txt")?.content.toString("utf8")).toBe("hello");

    // read and ls see it
    const read = tools.get("read");
    expect(JSON.stringify(await read?.execute("t3", { path: join(workspaceDir, "notes.txt") }))).toContain(
      "hello",
    );
    const ls = tools.get("ls");
    expect(JSON.stringify(await ls?.execute("t4", { path: workspaceDir }))).toContain("notes.txt");

    // the same Pi session reuses its sandbox
    await start?.({ type: "session_start", reason: "reload" }, ctx);
    const afterReload = (await (await fetch(`${baseUrl}/api/sandboxes`)).json()) as unknown[];
    expect(afterReload).toHaveLength(1);

    // shutdown only closes the connection; the sandbox keeps running
    const shutdown = handlers.get("session_shutdown")?.[0];
    await shutdown?.({ type: "session_shutdown", reason: "quit" }, ctx);

    const sandbox = (await (
      await fetch(`${baseUrl}/api/sandboxes/${sandboxId}`)
    ).json()) as { status: string };
    expect(sandbox.status).toBe("running");
  });

  it("fails closed when the SessionBox server is unreachable", async () => {
    const { app, workspaceDir, bindingsDir } = await createFixture();
    cleanups.push(() => app.close());
    cleanups.push(() => rm(workspaceDir, { recursive: true, force: true }));
    cleanups.push(() => rm(bindingsDir, { recursive: true, force: true }));

    setEnv("SESSIONBOX_URL", "http://127.0.0.1:1");
    setEnv("SESSIONBOX_BINDINGS_FILE", join(bindingsDir, "bindings.json"));

    const { api, tools, handlers } = createMockApi();
    sessionboxExtension(api);

    const { ctx, notify } = createMockContext(workspaceDir, "ses_pi_2");
    await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("SessionBox unavailable"), "error");

    const bash = tools.get("bash");
    await expect(bash?.execute("t1", { command: "echo hi" })).rejects.toThrow(/not connected/);
  });

  it("honours the --no-sessionbox flag", async () => {
    const { app, baseUrl, workspaceDir, bindingsDir } = await createFixture();
    cleanups.push(() => app.close());
    cleanups.push(() => rm(workspaceDir, { recursive: true, force: true }));
    cleanups.push(() => rm(bindingsDir, { recursive: true, force: true }));

    setEnv("SESSIONBOX_URL", baseUrl);
    setEnv("SESSIONBOX_BINDINGS_FILE", join(bindingsDir, "bindings.json"));

    const { api, tools, handlers } = createMockApi({ noSessionbox: true });
    sessionboxExtension(api);

    const { ctx, notify } = createMockContext(workspaceDir, "ses_pi_3");
    await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("disabled"), "info");

    const sandboxes = (await (await fetch(`${baseUrl}/api/sandboxes`)).json()) as unknown[];
    expect(sandboxes).toHaveLength(0);

    const bash = tools.get("bash");
    await expect(bash?.execute("t1", { command: "echo hi" })).rejects.toThrow(/not connected/);
  });
});
