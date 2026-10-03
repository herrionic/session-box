import { posix } from "node:path";
import { Client, type ClientChannel, type SFTPWrapper, type Stats } from "ssh2";
import type { CredentialStore } from "../credentials/store.ts";
import type { Logger } from "../logging.ts";
import type { SandboxRuntime } from "../runtime/types.ts";
import { SSH_PRIVATE_KEY_CREDENTIAL } from "./keypair.ts";
import {
  SshError,
  SshNotFoundError,
  SshTimeoutError,
  SshUnavailableError,
  type SshExecOptions,
  type SshExecResult,
  type SshFileEntry,
  type SshFileType,
  type SshSession,
  type SshSessionFactory,
  type SshSessionRequest,
  type SshShell,
  type SshShellOptions,
} from "./session.ts";

export interface Ssh2SessionFactoryOptions {
  runtime: SandboxRuntime;
  credentials: CredentialStore;
  logger: Logger;
  port?: number;
  username?: string;
  connectTimeoutMs?: number;
}

const DEFAULT_SSH_PORT = 22;
const DEFAULT_SSH_USERNAME = "agent";
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const DEFAULT_TERM = "xterm-256color";

/**
 * SSH/SFTP implementation over ssh2. The TCP transport always comes from
 * `SandboxRuntime.openPortStream`, so the server never dials a sandbox
 * directly and never exposes ports or credentials (PROJECT.md §14, §18).
 */
export class Ssh2SessionFactory implements SshSessionFactory {
  constructor(private readonly options: Ssh2SessionFactoryOptions) {}

  async create(request: SshSessionRequest): Promise<SshSession> {
    const privateKey = await this.options.credentials.read(
      request.sandboxId,
      SSH_PRIVATE_KEY_CREDENTIAL,
    );
    if (privateKey === undefined) {
      throw new SshUnavailableError("no SSH credential is stored for this sandbox");
    }

    const timeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    let transport;
    try {
      transport = await this.options.runtime.openPortStream(
        request.runtimeRef,
        this.options.port ?? DEFAULT_SSH_PORT,
      );
    } catch (error) {
      throw new SshUnavailableError("sandbox SSH endpoint is not reachable", { cause: error });
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
      { event: "ssh.connection.created", sandboxId: request.sandboxId },
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
    const fullCommand =
      options.cwd !== undefined ? `cd -- ${shellQuote(options.cwd)} && ${command}` : command;

    return new Promise<SshExecResult>((resolve, reject) => {
      let settled = false;
      let channel: ClientChannel | undefined;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        channel?.close();
        reject(new SshTimeoutError(`command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.client.exec(fullCommand, (error, stream) => {
        if (error) {
          settled = true;
          clearTimeout(timer);
          reject(new SshError("failed to start command in the sandbox", { cause: error }));
          return;
        }

        channel = stream;
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];

        stream.on("data", (chunk: Buffer) => stdout.push(chunk));
        stream.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

        stream.once("close", (code: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            exitCode: code ?? null,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        });

        stream.once("error", (streamError: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new SshError("command stream failed", { cause: streamError }));
        });
      });
    });
  }

  async readFile(path: string): Promise<Buffer> {
    const sftp = await this.sftp();
    return await new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(path, (error, data) => {
        if (error) reject(sftpError("read file", path, error));
        else resolve(data);
      });
    });
  }

  async writeFile(path: string, content: Buffer | string): Promise<void> {
    const sftp = await this.sftp();
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(path, content, (error) => {
        if (error) reject(sftpError("write file", path, error));
        else resolve();
      });
    });
  }

  async list(path: string): Promise<SshFileEntry[]> {
    const sftp = await this.sftp();
    const entries = await new Promise<Array<{ filename: string; attrs: Stats }>>(
      (resolve, reject) => {
        sftp.readdir(path, (error, list) => {
          if (error) reject(sftpError("list directory", path, error));
          else resolve(list);
        });
      },
    );

    return entries.map((entry) => {
      const entryPath = posix.join(path, entry.filename);
      return toFileEntry(entryPath, entry.filename, entry.attrs);
    });
  }

  async stat(path: string): Promise<SshFileEntry> {
    const sftp = await this.sftp();
    const stats = await new Promise<Stats>((resolve, reject) => {
      sftp.stat(path, (error, value) => {
        if (error) reject(sftpError("stat path", path, error));
        else resolve(value);
      });
    });

    return toFileEntry(path, posix.basename(path), stats);
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
      this.client.shell(
        {
          term: options.term ?? DEFAULT_TERM,
          cols: options.cols,
          rows: options.rows,
        },
        (error, stream) => {
          if (error) {
            reject(new SshError("failed to open a shell in the sandbox", { cause: error }));
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

  private sftp(): Promise<SFTPWrapper> {
    if (this.sftpPromise === undefined) {
      this.sftpPromise = new Promise<SFTPWrapper>((resolve, reject) => {
        this.client.sftp((error, sftp) => {
          if (error) reject(new SshError("failed to open an SFTP channel", { cause: error }));
          else resolve(sftp);
        });
      });
    }
    return this.sftpPromise;
  }

  private async mkdirOne(path: string): Promise<void> {
    const sftp = await this.sftp();
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(path, (error) => {
        if (error) reject(sftpError("create directory", path, error));
        else resolve();
      });
    });
  }

  private async rmdirOne(path: string): Promise<void> {
    const sftp = await this.sftp();
    await new Promise<void>((resolve, reject) => {
      sftp.rmdir(path, (error) => {
        if (error) reject(sftpError("remove directory", path, error));
        else resolve();
      });
    });
  }

  private async unlinkOne(path: string): Promise<void> {
    const sftp = await this.sftp();
    await new Promise<void>((resolve, reject) => {
      sftp.unlink(path, (error) => {
        if (error) reject(sftpError("remove file", path, error));
        else resolve();
      });
    });
  }
}

function toFileEntry(path: string, name: string, stats: Stats): SshFileEntry {
  let type: SshFileType = "other";
  if (stats.isDirectory()) type = "directory";
  else if (stats.isFile()) type = "file";
  else if (stats.isSymbolicLink()) type = "symlink";

  return {
    name,
    path,
    type,
    size: stats.size,
    mode: stats.mode,
    modifiedAt: stats.mtime * 1000,
  };
}

function sftpError(action: string, path: string, error: unknown): SshError {
  const code = (error as { code?: unknown } | null)?.code;
  // SFTP status code 2 = no such file.
  if (code === 2) return new SshNotFoundError(`${path} was not found`, { cause: error });
  return new SshError(`failed to ${action}: ${path}`, { cause: error });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
