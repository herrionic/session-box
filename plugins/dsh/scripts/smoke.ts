/**
 * DSH adapter smoke test: drives the ctx.fs and ctx.shell providers against a
 * real SessionBox server, without booting the full harness.
 *
 *   pnpm --filter @sessionbox/dsh-plugin smoke --url http://host:8787
 */
import { Context } from "@deepseek-ai/cordis";
import { SessionBoxConnection, SessionBoxFileSystem, SessionBoxShell } from "../src/index.ts";

const urlIndex = process.argv.indexOf("--url");
const baseUrl = urlIndex >= 0 ? process.argv[urlIndex + 1] : "http://127.0.0.1:8787";
const keep = process.argv.includes("--keep");

if (baseUrl === undefined || baseUrl === "") {
  console.error("usage: smoke.ts --url <baseUrl> [--keep]");
  process.exit(2);
}

const hostCwd = process.cwd();
const connection = new SessionBoxConnection({
  baseUrl,
  workspaceRoot: "/workspace",
  hostCwd,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 60_000,
  maxOutputBytes: 1024 * 1024,
});

const ctx = new Context();
await ctx.plugin(SessionBoxFileSystem, { connection: () => connection, hostCwd, workspaceRoot: "/workspace" });
await ctx.plugin(SessionBoxShell, {
  connection: () => connection,
  hostCwd,
  workspaceRoot: "/workspace",
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 60_000,
  maxOutputBytes: 1024 * 1024,
});

const log = (label: string, value: unknown): void => {
  console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
};

try {
  const target = await ctx.fs.resolve("dsh-smoke.txt");
  log("fs.target", { targetKey: String(target.targetKey), displayPath: target.displayPath });

  const written = await ctx.fs.writeText(target, "written through ctx.fs\n");
  log("fs.write", { operation: written.operation, version: String(written.version) });
  log("fs.read", await ctx.fs.readText(target));

  const execution = await ctx.shell.execute(
    ctx.shell.resolve({ command: "hostname; id; cat /workspace/dsh-smoke.txt" }),
  );
  const result = await execution.result();
  log("shell.exit", { exitCode: result.exitCode, timedOut: result.timedOut });
  console.log(result.stdout.text);

  const edited = await ctx.fs.editText(target, {
    oldString: "ctx.fs",
    newString: "the DSH adapter",
    replaceAll: false,
  });
  log("fs.edit", { after: edited.after.trim() });

  const sandboxId = connection.sandboxIdOrNull();
  log("sandbox", sandboxId);

  if (!keep && sandboxId !== null) {
    const response = await fetch(`${baseUrl}/api/sandboxes/${sandboxId}`, { method: "DELETE" });
    log("sandbox.delete", response.status);
  }
} catch (error) {
  console.error("dsh smoke failed:", error);
  process.exitCode = 1;
} finally {
  await connection.close();
}
