import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { SessionBoxConnection, SessionBoxFileSystem, SessionBoxShell } from "@sessionbox/dsh-plugin";
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

async function createFixture(): Promise<{
  app: SessionBoxApp;
  ssh: FakeSshSessionFactory;
  baseUrl: string;
  workspaceDir: string;
}> {
  const runtime = new FakeRuntime();
  const logger = createTestLogger();
  const ssh = new FakeSshSessionFactory({ perSandbox: true });
  const service = new SandboxService({
    runtime,
    repository: new InMemorySandboxRepository(),
    credentials: new InMemoryCredentialStore(Buffer.alloc(32, 17)),
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

  return {
    app,
    ssh,
    baseUrl: `http://127.0.0.1:${port}`,
    workspaceDir: process.cwd(),
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

describe("DSH capability providers against a real SessionBox server", () => {
  it("routes ctx.fs and ctx.shell into the sandbox", async () => {
    const { app, ssh, baseUrl, workspaceDir } = await createFixture();
    cleanups.push(() => app.close());

    const connection = new SessionBoxConnection({
      baseUrl,
      workspaceRoot: "/workspace",
      hostCwd: workspaceDir,
      defaultTimeoutMs: 5_000,
      maxTimeoutMs: 60_000,
      maxOutputBytes: 1024 * 1024,
    });
    cleanups.push(() => connection.close());

    const ctx = new Context();
    const fsFiber = await ctx.plugin(SessionBoxFileSystem, {
      connection: () => connection,
      hostCwd: workspaceDir,
      workspaceRoot: "/workspace",
    });
    cleanups.push(() => fsFiber.dispose());

    const shellFiber = await ctx.plugin(SessionBoxShell, {
      connection: () => connection,
      hostCwd: workspaceDir,
      workspaceRoot: "/workspace",
      defaultTimeoutMs: 5_000,
      maxTimeoutMs: 60_000,
      maxOutputBytes: 1024 * 1024,
    });
    cleanups.push(() => shellFiber.dispose());

    // The first fs operation resolves the sandbox binding.
    const target = await ctx.fs.resolve("notes.txt");
    await ctx.fs.writeText(target, "hello from dsh\n");

    const sandboxes = (await (await fetch(`${baseUrl}/api/sandboxes`)).json()) as Array<{
      id: string;
    }>;
    expect(sandboxes).toHaveLength(1);
    const sandboxId = sandboxes[0]?.id ?? "";
    const session = ssh.sessionFor(sandboxId);

    // The write really landed in the sandbox filesystem.
    expect(session.nodes.get("/workspace/notes.txt")?.content.toString("utf8")).toBe(
      "hello from dsh\n",
    );

    // Shell execution runs in the sandbox and projects a foreground result.
    session.execResults.push({ exitCode: 0, stdout: "AAA\n", stderr: "" });
    const execution = await ctx.shell.execute(
      ctx.shell.resolve({ command: "cat /workspace/notes.txt" }),
    );
    const result = await execution.result();

    expect(result.exitCode).toBe(0);
    expect(result.stdout.text).toBe("AAA\n");
    expect(session.commands).toContain("cat /workspace/notes.txt");

    // Literal edit through the fs provider.
    const edited = await ctx.fs.editText(target, {
      oldString: "hello",
      newString: "goodbye",
      replaceAll: false,
    });
    expect(edited.after).toBe("goodbye from dsh\n");
  });
});
