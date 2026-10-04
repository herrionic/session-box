import { Context } from "@deepseek-ai/cordis";
import { SessionBoxClientError } from "@sessionbox/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionBoxShell } from "../src/shell.ts";
import { createFakeConnection, createFakeRuntime, type FakeRuntime } from "./helpers.ts";

const HOST_CWD = process.platform === "win32" ? "D:\\work\\project" : "/home/user/project";

let ctx: Context;
let shell: SessionBoxShell;
let runtime: FakeRuntime;
let fiber: Awaited<ReturnType<Context["plugin"]>>;

beforeEach(async () => {
  runtime = createFakeRuntime();
  ctx = new Context();
  fiber = await ctx.plugin(SessionBoxShell, {
    connection: () => createFakeConnection(runtime),
    hostCwd: HOST_CWD,
    workspaceRoot: "/workspace",
    defaultTimeoutMs: 1_000,
    maxTimeoutMs: 60_000,
    maxOutputBytes: 16,
  });
  shell = ctx.shell as SessionBoxShell;
});

afterEach(async () => {
  await fiber.dispose();
});

describe("SessionBoxShell.resolve", () => {
  it("fills defaults and caps", () => {
    const spec = shell.resolve({ command: "echo hi" });

    expect(spec.workdir).toBe(HOST_CWD);
    expect(spec.timeoutMs).toBe(1_000);
    expect(spec.onExpiry).toBe("kill");
    expect(spec.stdoutMaxBytes).toBe(16);
  });

  it("caps caller overrides", () => {
    const spec = shell.resolve({ command: "x", timeoutMs: 999_999, stdoutMaxBytes: 999_999 });

    expect(spec.timeoutMs).toBe(60_000);
    expect(spec.stdoutMaxBytes).toBe(16);
  });
});

describe("SessionBoxShell.execute", () => {
  it("runs in the sandbox and projects a foreground result", async () => {
    runtime.execResults.push({ exitCode: 0, stdout: "hi\n", stderr: "" });

    const execution = await shell.execute(shell.resolve({ command: "echo hi" }));
    const result = await execution.result();

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.text).toBe("hi\n");
    expect(execution.status).toBe("completed");
    expect(runtime.execCalls[0]).toMatchObject({ cwd: "/workspace", timeoutMs: 1_000 });

    // consuming read returns the output once
    const first = execution.readOutput();
    expect(first.delta).toContain("hi\n");
    expect(execution.readOutput().delta).toBe("");

    // offset readers are independent of the consuming cursor
    const observed = execution.observed.stdout.readFrom(0);
    expect(observed.text).toBe("hi\n");
    expect(observed.nextOffset).toBe(3);
  });

  it("truncates long stdout to its tail", async () => {
    runtime.execResults.push({ exitCode: 0, stdout: "0123456789ABCDEFGHIJ", stderr: "" });

    const execution = await shell.execute(shell.resolve({ command: "long" }));
    const result = await execution.result();

    expect(result.stdout.truncated).toBe(true);
    expect(result.stdout.text).toBe("456789ABCDEFGHIJ");
  });

  it("reports protocol timeouts as timedOut results, not failures", async () => {
    runtime.execError = new SessionBoxClientError("OPERATION_TIMEOUT", "timed out");

    const execution = await shell.execute(shell.resolve({ command: "sleep 999" }));
    const result = await execution.result();

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(execution.status).toBe("killed");
  });

  it("keeps infrastructure failures on the result rejection path", async () => {
    runtime.execError = new SessionBoxClientError("SSH_UNAVAILABLE", "sandbox is gone");

    const execution = await shell.execute(shell.resolve({ command: "true" }));

    await expect(execution.result()).rejects.toThrow(/sandbox is gone/);
    await expect(execution.done).resolves.toBeUndefined();
    expect(execution.readOutput().delta).toContain("sessionbox: sandbox is gone");
    expect(execution.kill()).toBe(false);
  });

  it("feeds stdin through a base64 pipe", async () => {
    runtime.execResults.push({ exitCode: 0, stdout: "", stderr: "" });

    await shell.execute(shell.resolve({ command: "cat", stdin: "payload" }));

    const command = runtime.commands[0] ?? "";
    expect(command).toContain("base64 -d | sh -c");
    expect(command).toContain(Buffer.from("payload", "utf8").toString("base64"));
  });
});
