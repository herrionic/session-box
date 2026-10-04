import type { Context } from "@deepseek-ai/cordis";
import { ShellExecutor } from "@deepseek-ai/dsh-shell";
import type {
  CollectedOutput,
  ShellExecRequest,
  ShellExecSpec,
  ShellExecution,
  ShellProcessRead,
  ShellRunResult,
} from "@deepseek-ai/dsh-shell";
import { SessionBoxClientError } from "@sessionbox/client";
import { toSandboxPath } from "@sessionbox/shared";
import type { SessionBoxRuntimeProvider } from "./connection.ts";

export interface ShellServiceConfig {
  connection: () => SessionBoxRuntimeProvider;
  hostCwd: string;
  workspaceRoot: string;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxOutputBytes: number;
}

/**
 * `ctx.shell` over the SessionBox agent protocol. Commands run in the sandbox;
 * the agent protocol is request/response, so every execution is settled when
 * `execute` resolves: foreground results, incremental reads and observed
 * streams all work, while `kill()` reports "already finished" and expiry is
 * enforced by the protocol timeout.
 */
export class SessionBoxShell extends ShellExecutor {
  private readonly connection: () => SessionBoxRuntimeProvider;
  private readonly hostCwd: string;
  private readonly workspaceRoot: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(ctx: Context, config: ShellServiceConfig) {
    super(ctx);
    this.connection = config.connection;
    this.hostCwd = config.hostCwd;
    this.workspaceRoot = config.workspaceRoot;
    this.defaultTimeoutMs = config.defaultTimeoutMs;
    this.maxTimeoutMs = config.maxTimeoutMs;
    this.maxOutputBytes = config.maxOutputBytes;
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? this.hostCwd,
      timeoutMs: Math.min(request.timeoutMs ?? this.defaultTimeoutMs, this.maxTimeoutMs),
      onExpiry: request.onExpiry ?? "kill",
      stdoutMaxBytes: Math.min(request.stdoutMaxBytes ?? this.maxOutputBytes, this.maxOutputBytes),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
      ...(request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
      sandboxPolicy: request.sandboxPolicy,
    };
  }

  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const { runtime } = await this.connection().connect();
    const workdir = toSandboxPath(spec.workdir, this.hostCwd, this.workspaceRoot);
    const limits = { stdoutMaxBytes: spec.stdoutMaxBytes, stderrMaxBytes: this.maxOutputBytes };

    if (isAborted(spec.signal)) {
      return completedExecution({
        result: { exitCode: null, stdout: "", stderr: "" },
        aborted: true,
        timedOut: false,
        timeoutMs: spec.timeoutMs,
        ...limits,
      });
    }

    try {
      const result = await runtime.exec(withStdin(spec.command, spec.stdin), {
        cwd: workdir,
        timeoutMs: spec.timeoutMs,
      });

      return completedExecution({
        result,
        aborted: isAborted(spec.signal),
        timedOut: false,
        timeoutMs: spec.timeoutMs,
        ...limits,
      });
    } catch (error) {
      if (error instanceof SessionBoxClientError && error.code === "OPERATION_TIMEOUT") {
        // The protocol killed the command at its deadline: a timeout result,
        // not an infrastructure failure.
        return completedExecution({
          result: { exitCode: null, stdout: "", stderr: "" },
          aborted: false,
          timedOut: true,
          timeoutMs: spec.timeoutMs,
          ...limits,
        });
      }
      return failedExecution(error);
    }
  }
}

export default SessionBoxShell;

interface CompletedOptions {
  result: { exitCode: number | null; stdout: string; stderr: string };
  aborted: boolean;
  timedOut: boolean;
  timeoutMs: number;
  stdoutMaxBytes: number;
  stderrMaxBytes: number;
}

function completedExecution(options: CompletedOptions): ShellExecution {
  const stdout = collect(options.result.stdout, options.stdoutMaxBytes);
  const stderr = collect(options.result.stderr, options.stderrMaxBytes);
  const settled = options.aborted || options.timedOut;

  let consumed = false;
  return {
    status: settled ? "killed" : "completed",
    exitCode: settled ? null : options.result.exitCode,
    signal: null,
    done: Promise.resolve(),
    readOutput(): ShellProcessRead {
      if (consumed) return { delta: "", lossy: false };
      consumed = true;

      const parts: string[] = [];
      if (stdout.text !== "") parts.push(stdout.text);
      if (stderr.text !== "") parts.push(`[stderr]\n${stderr.text}`);

      return { delta: parts.join(""), lossy: stdout.truncated || stderr.truncated };
    },
    observed: {
      stdout: outputReader(stdout.text),
      stderr: outputReader(stderr.text),
    },
    kill: () => false,
    result: async (): Promise<ShellRunResult> => ({
      exitCode: settled ? null : options.result.exitCode,
      signal: null,
      timedOut: options.timedOut,
      aborted: options.aborted,
      timeoutMs: options.timeoutMs,
      stdout,
      stderr,
    }),
  };
}

function failedExecution(error: unknown): ShellExecution {
  const message = error instanceof Error ? error.message : String(error);
  const note: CollectedOutput = { text: `sessionbox: ${message}`, truncated: false };
  const empty: CollectedOutput = { text: "", truncated: false };

  return {
    status: "killed",
    exitCode: null,
    signal: null,
    done: Promise.resolve(),
    readOutput: (): ShellProcessRead => ({ delta: note.text, lossy: false }),
    observed: {
      stdout: outputReader(""),
      stderr: outputReader(note.text),
    },
    kill: () => false,
    result: async (): Promise<ShellRunResult> => {
      throw error instanceof Error ? error : new Error(message);
    },
  };
}

/** Tail-truncating collection, matching the CollectedOutput contract. */
function collect(text: string, maxBytes: number): CollectedOutput {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return { text, truncated: false };
  }
  return { text: buffer.subarray(buffer.length - maxBytes).toString("utf8"), truncated: true };
}

/** Reads the abort state without TypeScript's control-flow narrowing. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function outputReader(text: string): ShellExecution["observed"]["stdout"] {
  const buffer = Buffer.from(text, "utf8");
  return {
    readFrom(fromByte: number) {
      const offset = Math.max(0, Math.min(fromByte, buffer.length));
      return {
        text: buffer.subarray(offset).toString("utf8"),
        nextOffset: buffer.length,
        lossy: false,
      };
    },
  };
}

/**
 * The agent protocol has no stdin channel; feed it through a base64 pipe so
 * any bytes survive the shell round-trip.
 */
function withStdin(command: string, stdin: string | undefined): string {
  if (stdin === undefined) return command;
  const encoded = Buffer.from(stdin, "utf8").toString("base64");
  return `printf '%s' '${encoded}' | base64 -d | sh -c ${shellQuote(command)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
