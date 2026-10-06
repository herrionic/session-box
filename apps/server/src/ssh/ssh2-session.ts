import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { Client, type ClientChannel, type SFTPWrapper, type Stats } from "ssh2";
import type { CredentialStore } from "../credentials/store.ts";
import type { Logger } from "../logging.ts";
import type { ContainerRuntime } from "../runtime/types.ts";
import { SSH_PRIVATE_KEY_CREDENTIAL } from "./keypair.ts";
import {
  buildListCommand,
  buildStatCommand,
  parseFindOutput,
  toSshEntries,
  toSshEntry,
} from "./find-entries.ts";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  SshCancelledError,
  SshError,
  SshNotFoundError,
  SshPermissionError,
  SshTimeoutError,
  SshUnavailableError,
  type SshExecOptions,
  type SshExecResult,
  type SshFileEntry,
  type SshSession,
  type SshSessionFactory,
  type SshSessionRequest,
  type SshShell,
  type SshShellOptions,
} from "./session.ts";

export interface Ssh2SessionFactoryOptions {
  runtime: ContainerRuntime;
  credentials: CredentialStore;
  logger: Logger;
  port?: number;
  username?: string;
  connectTimeoutMs?: number;
}

const DEFAULT_SSH_PORT = 22;
const DEFAULT_SSH_USERNAME = "agent";
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_TERM = "xterm-256color";
/** Bounds a single SFTP/channel round trip so a dead connection fails instead of hanging. */
const OPERATION_TIMEOUT_MS = 30_000;

/**
 * SSH/SFTP implementation over ssh2. The TCP transport always comes from
 * `ContainerRuntime.openPortStream`, so the server never dials a container
 * directly and never exposes ports or credentials (PROJECT.md §14, §18).
 */
export class Ssh2SessionFactory implements SshSessionFactory {
  constructor(private readonly options: Ssh2SessionFactoryOptions) {}

  async create(request: SshSessionRequest): Promise<SshSession> {
    const privateKey = await this.options.credentials.read(
      request.containerId,
      SSH_PRIVATE_KEY_CREDENTIAL,
    );
    if (privateKey === undefined) {
      throw new SshUnavailableError("no SSH credential is stored for this container");
    }

    const timeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    let transport;
    try {
      transport = await this.options.runtime.openPortStream(
        request.runtimeRef,
        this.options.port ?? DEFAULT_SSH_PORT,
      );
    } catch (error) {
      throw new SshUnavailableError("container SSH endpoint is not reachable", { cause: error });
    }

    const client = new Client();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          // Do not leak the transport socket when the handshake fails.
          try {
            transport.destroy();
          } catch {
            // ignore
          }
          reject(error);
        } else {
          resolve();
        }
      };

      const timer = setTimeout(() => {
        client.destroy();
        settle(new SshTimeoutError("SSH handshake timed out"));
      }, timeoutMs);

      client.once("ready", () => settle());
      client.once("error", (error) => {
        settle(new SshUnavailableError("SSH connection failed", { cause: error }));
      });

      client.connect({
        sock: transport,
        username: this.options.username ?? DEFAULT_SSH_USERNAME,
        privateKey,
        readyTimeout: timeoutMs,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 4,
      });
    });

    this.options.logger.info(
      { event: "ssh.connection.created", containerId: request.containerId },
      "SSH connection established",
    );

    return new Ssh2Session(client);
  }
}

class Ssh2Session implements SshSession {
  private sftpPromise: Promise<SFTPWrapper> | undefined;

  constructor(private readonly client: Client) {}

  exec(command: string, options: SshExecOptions = {}): Promise<SshExecResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const inner =
      options.cwd !== undefined ? `cd -- ${shellQuote(options.cwd)} && ${command}` : command;
    const pidFile = `/tmp/.sessionbox-exec-${randomBytes(12).toString("hex")}.pid`;
    // Run the command in its own session (process group) and record the group
    // leader's pid, so cancellation and timeouts can kill the whole tree —
    // background children included — instead of only closing the channel.
    const script = `echo $$ > ${shellQuote(pidFile)}; /bin/sh -c ${shellQuote(inner)}; rc=$?; rm -f ${shellQuote(pidFile)}; exit $rc`;
    const wrapped = `setsid -w /bin/sh -c ${shellQuote(script)}`;

    return this.runChannel(wrapped, {
      timeoutMs,
      timeoutDropsSession: false,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.onStdout !== undefined ? { onStdout: options.onStdout } : {}),
      ...(options.onStderr !== undefined ? { onStderr: options.onStderr } : {}),
      onAbort: (channel) => this.killProcessGroup(pidFile, channel),
    });
  }

  /**
   * Runs one channel to completion, buffering stdout/stderr. `onAbort` runs
   * when the timeout fires or the signal aborts, so callers can clean up
   * beyond the channel (e.g. kill a process group); the timeout error is only
   * produced after that cleanup resolves.
   */
  private runChannel(
    command: string,
    options: {
      timeoutMs: number;
      signal?: AbortSignal;
      /** Exec timeouts leave the connection usable; SFTP timeouts drop it. */
      timeoutDropsSession?: boolean;
      onStdout?: (data: string) => void;
      onStderr?: (data: string) => void;
      onAbort?: (channel: ClientChannel | undefined) => Promise<void>;
    },
  ): Promise<SshExecResult> {
    return new Promise<SshExecResult>((resolve, reject) => {
      let settled = false;
      let aborting = false;
      let channel: ClientChannel | undefined;

      const finish = (error?: SshError, result?: SshExecResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (error !== undefined) reject(error);
        else resolve(result as SshExecResult);
      };

      const abortWith = (error: SshError): void => {
        if (settled || aborting) return;
        // The abort path owns the outcome: the command's death closes the
        // channel, and that close must not settle the request as a result.
        aborting = true;
        if (options.onAbort === undefined) {
          closeQuietly(channel);
          finish(error);
          return;
        }
        void options
          .onAbort(channel)
          .catch(() => undefined)
          .then(() => finish(error));
      };

      const timer = setTimeout(() => {
        abortWith(
          new SshTimeoutError(`command timed out after ${options.timeoutMs}ms`, {
            dropsSession: options.timeoutDropsSession ?? true,
          }),
        );
      }, options.timeoutMs);

      const onAbort = (): void => {
        abortWith(new SshCancelledError("command was cancelled"));
      };

      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.client.exec(command, (error, stream) => {
        if (settled || aborting) {
          closeQuietly(stream);
          return;
        }
        if (error) {
          finish(new SshError("failed to start command in the container", { cause: error }));
          return;
        }

        channel = stream;
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];

        stream.on("data", (chunk: Buffer) => {
          stdout.push(chunk);
          options.onStdout?.(chunk.toString("utf8"));
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          stderr.push(chunk);
          options.onStderr?.(chunk.toString("utf8"));
        });

        stream.once("close", (code: number | null) => {
          if (aborting) return;
          finish(undefined, {
            exitCode: code ?? null,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        });

        stream.once("error", (streamError: Error) => {
          if (aborting) return;
          finish(new SshError("command stream failed", { cause: streamError }));
        });
      });
    });
  }

  /** Runs a command for internal cleanup; no process-group wrapper. */
  private execRaw(command: string, timeoutMs: number): Promise<SshExecResult> {
    return this.runChannel(command, { timeoutMs });
  }

  /**
   * Kills the command's process group: TERM is awaited (so the caller can
   * report completion with confidence), then KILL after a grace period and
   * pid-file removal run detached. Best effort: the session may be gone.
   */
  private async killProcessGroup(
    pidFile: string,
    channel: ClientChannel | undefined,
  ): Promise<void> {
    const pgid = await this.readPgid(pidFile);
    if (pgid === undefined) {
      // The wrapper never recorded a pid; closing the channel is all we can do.
      closeQuietly(channel);
      return;
    }

    try {
      await this.execRaw(`pkill -TERM -g ${pgid} 2>/dev/null`, 5_000);
    } catch {
      closeQuietly(channel);
      return;
    }

    void this.execRaw(
      `sleep 1; pkill -KILL -g ${pgid} 2>/dev/null; rm -f ${shellQuote(pidFile)}`,
      10_000,
    ).catch(() => {
      // The connection is gone; nothing left to clean up.
    });
    closeQuietly(channel);
  }

  /** Reads the process-group id the wrapper recorded, retrying briefly. */
  private async readPgid(pidFile: string): Promise<number | undefined> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const content = await this.readFile(pidFile);
        const pgid = Number.parseInt(content.toString("ascii").trim(), 10);
        if (Number.isSafeInteger(pgid) && pgid > 0) return pgid;
      } catch {
        // Not written yet (or already removed).
      }
      await delay(100);
    }
    return undefined;
  }

  async readFile(path: string): Promise<Buffer> {
    const sftp = await this.sftp();
    return await this.sftpCall<Buffer>("read file", path, (done) => sftp.readFile(path, done));
  }

  async writeFile(path: string, content: Buffer | string): Promise<void> {
    const sftp = await this.sftp();
    await this.sftpCall<void>("write file", path, (done) => sftp.writeFile(path, content, done));
  }

  async readFileRange(path: string, offset: number, length: number): Promise<Buffer> {
    const sftp = await this.sftp();
    const handle = await this.sftpCall<Buffer>("open file", path, (done) =>
      sftp.open(path, "r", done),
    );

    try {
      const chunks: Buffer[] = [];
      let position = offset;
      let remaining = length;

      while (remaining > 0) {
        const size = Math.min(remaining, 256 * 1024);
        const chunk = await this.sftpCall<Buffer>("read file", path, (done) =>
          sftp.read(handle, Buffer.alloc(size), 0, size, position, (error, bytesRead, buffer) => {
            if (error) done(error);
            else done(undefined, buffer.subarray(0, bytesRead));
          }),
        );
        if (chunk.length === 0) break;
        chunks.push(chunk);
        position += chunk.length;
        remaining -= chunk.length;
      }

      return Buffer.concat(chunks);
    } finally {
      await this.sftpCall<void>("close file", path, (done) => sftp.close(handle, done)).catch(
        () => undefined,
      );
    }
  }

  async writeFileAtomic(path: string, content: Buffer | string): Promise<void> {
    const sftp = await this.sftp();
    // Preserve "write through a symlink" semantics when the target exists.
    const target = await this.resolvePath(path);
    const temp = posix.join(
      posix.dirname(target),
      `.sessionbox-tmp-${randomBytes(8).toString("hex")}`,
    );

    await this.sftpCall<void>("write file", temp, (done) => sftp.writeFile(temp, content, done));
    try {
      await this.replaceFile(sftp, temp, target);
    } catch (error) {
      await this.sftpCall<void>("remove file", temp, (done) => sftp.unlink(temp, done)).catch(
        () => undefined,
      );
      throw error;
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const sftp = await this.sftp();
    await this.replaceFile(sftp, from, to);
  }

  /**
   * Atomically replaces `target` with `source`. Plain SFTP rename fails when
   * the destination exists (OpenSSH behavior), so the `posix-rename@openssh.com`
   * extension is preferred; servers without it get an unlink-then-rename
   * fallback.
   */
  private async replaceFile(sftp: SFTPWrapper, source: string, target: string): Promise<void> {
    try {
      await this.sftpCall<void>("replace file", target, (done) => {
        sftp.ext_openssh_rename(source, target, done);
      });
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("does not support this extended request")
      ) {
        throw error;
      }
    }

    await this.sftpCall<void>("remove file", target, (done) =>
      sftp.unlink(target, (error) => {
        const code = (error as { code?: unknown } | null)?.code;
        done(code === 2 ? undefined : error);
      }),
    ).catch(() => undefined);
    await this.sftpCall<void>("replace file", target, (done) => sftp.rename(source, target, done));
  }

  async chmod(path: string, mode: number): Promise<void> {
    const sftp = await this.sftp();
    await this.sftpCall<void>("change mode", path, (done) => sftp.chmod(path, mode, done));
  }

  async symlink(path: string, target: string): Promise<void> {
    const sftp = await this.sftp();
    await this.sftpCall<void>("create symlink", path, (done) => sftp.symlink(target, path, done));
  }

  /** Readdir used only to classify a failed `find` call. */
  private async sftpReaddir(path: string): Promise<Array<{ filename: string; attrs: Stats }>> {
    const sftp = await this.sftp();
    return await this.sftpCall<Array<{ filename: string; attrs: Stats }>>(
      "list directory",
      path,
      (done) => sftp.readdir(path, done),
    );
  }

  /** Stat used only to classify a failed `find` call. */
  private async sftpStatOnly(path: string, follow: boolean): Promise<void> {
    const sftp = await this.sftp();
    await this.sftpCall<Stats>("stat path", path, (done) =>
      follow ? sftp.stat(path, done) : sftp.lstat(path, done),
    );
  }

  /** Resolves symlinks so a write lands on the real file; falls back to the input. */
  private async resolvePath(path: string): Promise<string> {
    const sftp = await this.sftp();
    try {
      return await this.sftpCall<string>("resolve path", path, (done) => sftp.realpath(path, done));
    } catch {
      return path;
    }
  }

  async list(path: string): Promise<SshFileEntry[]> {
    const result = await this.execRaw(buildListCommand(path), OPERATION_TIMEOUT_MS);
    const entries = toSshEntries(parseFindOutput(result.stdout), path);
    if (result.exitCode === 0) return entries;

    // `find` failed: classify through SFTP so NOT_FOUND / permission / "not a
    // directory" stay typed. A successful empty readdir means an empty dir.
    const fallback = await this.sftpReaddir(path);
    if (fallback.length === 0) return [];
    throw new SshError(`failed to list directory: ${path}`);
  }

  async stat(path: string, options: { follow?: boolean } = {}): Promise<SshFileEntry> {
    const follow = options.follow !== false;
    const result = await this.execRaw(buildStatCommand(path, follow), OPERATION_TIMEOUT_MS);
    const [parsed] = parseFindOutput(result.stdout);
    if (parsed === undefined) {
      // Classify the failure (missing path, permission, dangling link, ...).
      await this.sftpStatOnly(path, follow);
      throw new SshError(`failed to stat path: ${path}`);
    }
    return toSshEntry(parsed, path);
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    if (!options.recursive) {
      await this.mkdirOne(path);
      return;
    }

    const segments = posix.normalize(path).split("/").filter((segment) => segment !== "");
    let current = "/";
    for (const segment of segments) {
      current = posix.join(current, segment);
      try {
        await this.mkdirOne(current);
      } catch (error) {
        const existing = await this.stat(current).catch(() => undefined);
        if (existing?.type !== "directory") throw error;
      }
    }
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const entry = await this.stat(path).catch((error: unknown) => {
      if (error instanceof SshNotFoundError) return undefined;
      throw error;
    });
    if (entry === undefined) return;

    if (entry.type === "directory") {
      if (options.recursive === true) {
        for (const child of await this.list(path)) {
          await this.remove(child.path, { recursive: true });
        }
      }
      await this.rmdirOne(path);
    } else {
      await this.unlinkOne(path);
    }
  }

  async close(): Promise<void> {
    this.sftpPromise = undefined;
    this.client.end();
  }

  async openShell(options: SshShellOptions): Promise<SshShell> {
    return await new Promise<SshShell>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new SshTimeoutError("opening a shell timed out"));
      }, OPERATION_TIMEOUT_MS);

      this.client.shell(
        {
          term: options.term ?? DEFAULT_TERM,
          cols: options.cols,
          rows: options.rows,
        },
        (error, stream) => {
          if (settled) {
            closeQuietly(stream);
            return;
          }
          settled = true;
          clearTimeout(timer);
          if (error) {
            reject(new SshError("failed to open a shell in the container", { cause: error }));
            return;
          }

          stream.on("data", (chunk: Buffer) => options.onData(chunk.toString("utf8")));
          stream.stderr.on("data", (chunk: Buffer) => options.onData(chunk.toString("utf8")));
          stream.on("close", (code: number | null) => options.onExit(code ?? null));
          stream.on("error", (streamError: Error) => options.onError?.(streamError));

          resolve({
            write: (data: string) => {
              stream.write(data);
            },
            resize: (cols: number, rows: number) => {
              stream.setWindow(rows, cols, 0, 0);
            },
            close: () => {
              stream.close();
            },
          });
        },
      );
    });
  }

  private async mkdirOne(path: string): Promise<void> {
    const sftp = await this.sftp();
    await this.sftpCall<void>("create directory", path, (done) => sftp.mkdir(path, done));
  }

  private async rmdirOne(path: string): Promise<void> {
    const sftp = await this.sftp();
    await this.sftpCall<void>("remove directory", path, (done) => sftp.rmdir(path, done));
  }

  private async unlinkOne(path: string): Promise<void> {
    const sftp = await this.sftp();
    await this.sftpCall<void>("remove file", path, (done) => sftp.unlink(path, done));
  }

  /**
   * Runs one SFTP request with a deadline; a wedged connection rejects with
   * `SshTimeoutError` (which drops the session) instead of hanging forever.
   */
  private sftpCall<T>(
    action: string,
    path: string,
    invoke: (done: (error: Error | null | undefined, value?: T) => void) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new SshTimeoutError(`failed to ${action} (timed out): ${path}`));
      }, OPERATION_TIMEOUT_MS);

      invoke((error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error !== undefined && error !== null) reject(sftpError(action, path, error));
        else resolve(value as T);
      });
    });
  }

  private sftp(): Promise<SFTPWrapper> {
    if (this.sftpPromise === undefined) {
      const created = new Promise<SFTPWrapper>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new SshTimeoutError("opening an SFTP channel timed out"));
        }, OPERATION_TIMEOUT_MS);

        this.client.sftp((error, sftp) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(new SshError("failed to open an SFTP channel", { cause: error }));
          else resolve(sftp);
        });
      });

      // Never cache a failed channel.
      const guarded = created.catch((error: unknown) => {
        if (this.sftpPromise === guarded) this.sftpPromise = undefined;
        throw error;
      });
      this.sftpPromise = guarded;
    }
    return this.sftpPromise;
  }
}

function sftpError(action: string, path: string, error: unknown): SshError {
  const code = (error as { code?: unknown } | null)?.code;
  // SFTP status codes: 2 = no such file, 3 = permission denied.
  if (code === 2) return new SshNotFoundError(`${path} was not found`, { cause: error });
  if (code === 3) return new SshPermissionError(`permission denied: ${path}`, { cause: error });
  return new SshError(`failed to ${action}: ${path}`, { cause: error });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function closeQuietly(channel: { close(): void } | undefined): void {
  try {
    channel?.close();
  } catch {
    // The channel is already gone.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
