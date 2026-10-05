export interface SshExecOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Aborts the command and kills its process group. */
  signal?: AbortSignal;
}

/** Default exec timeout; also used by the agent route as its deadline base. */
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

export interface SshExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type SshFileType = "file" | "directory" | "symlink" | "other";

export interface SshFileEntry {
  name: string;
  path: string;
  type: SshFileType;
  size: number;
  mode: number;
  /** Epoch milliseconds. */
  modifiedAt: number;
}

export interface SshShellOptions {
  cols: number;
  rows: number;
  term?: string;
  onData: (data: string) => void;
  onExit: (code: number | null) => void;
  onError?: (error: Error) => void;
}

/** An interactive PTY-backed shell channel (used by the web terminal). */
export interface SshShell {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/**
 * SessionBox-side SSH/SFTP session. The transport is always a runtime-provided
 * duplex stream (`ContainerRuntime.openPortStream`); callers never see host or
 * port information (PROJECT.md §18).
 */
export interface SshSession {
  exec(command: string, options?: SshExecOptions): Promise<SshExecResult>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: Buffer | string): Promise<void>;
  list(path: string): Promise<SshFileEntry[]>;
  stat(path: string): Promise<SshFileEntry>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  openShell(options: SshShellOptions): Promise<SshShell>;
  close(): Promise<void>;
}

export interface SshSessionRequest {
  containerId: string;
  runtimeRef: string;
}

export interface SshSessionFactory {
  create(request: SshSessionRequest): Promise<SshSession>;
}

export class SshError extends Error {
  /**
   * Whether the underlying connection should be discarded. Connection-level
   * failures do; clean operation outcomes (not found, cancelled) do not.
   */
  readonly dropsSession: boolean;

  constructor(message: string, options?: { cause?: unknown; dropsSession?: boolean }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SshError";
    this.dropsSession = options?.dropsSession ?? true;
  }
}

export class SshUnavailableError extends SshError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SshUnavailableError";
  }
}

export class SshTimeoutError extends SshError {
  constructor(message: string, options?: { cause?: unknown; dropsSession?: boolean }) {
    super(message, options);
    this.name = "SshTimeoutError";
  }
}

export class SshNotFoundError extends SshError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { ...options, dropsSession: false });
    this.name = "SshNotFoundError";
  }
}

export class SshCancelledError extends SshError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { ...options, dropsSession: false });
    this.name = "SshCancelledError";
  }
}
