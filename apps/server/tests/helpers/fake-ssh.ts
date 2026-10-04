import { posix } from "node:path";
import {
  SshError,
  SshNotFoundError,
  SshUnavailableError,
  type SshExecResult,
  type SshFileEntry,
  type SshSession,
  type SshSessionFactory,
  type SshSessionRequest,
  type SshShell,
  type SshShellOptions,
} from "../../src/ssh/session.ts";

interface FakeNode {
  type: "file" | "directory";
  content: Buffer;
  mode: number;
  modifiedAt: number;
}

export interface FakeShell {
  cols: number;
  rows: number;
  writes: string[];
  closed: boolean;
  emit(data: string): void;
  exit(code: number | null): void;
}

/** Scriptable SSH session factory for service/file/probe tests (no sshd). */
export class FakeSshSessionFactory implements SshSessionFactory {
  readonly requests: SshSessionRequest[] = [];
  /** Shared session used when `perSandbox` is false. */
  readonly session = new FakeSshSession();
  private readonly sessionsBySandbox = new Map<string, FakeSshSession>();
  private readonly perSandbox: boolean;

  /** Fail this many attempts before reporting ready (readiness probe tests). */
  failuresBeforeSuccess = 0;
  alwaysFail = false;

  constructor(options: { perSandbox?: boolean } = {}) {
    this.perSandbox = options.perSandbox === true;
  }

  /** The fake filesystem for one sandbox (isolation tests). */
  sessionFor(sandboxId: string): FakeSshSession {
    return this.sessionsBySandbox.get(sandboxId) ?? this.session;
  }

  async create(request: SshSessionRequest): Promise<SshSession> {
    this.requests.push(request);

    if (this.alwaysFail) {
      throw new SshUnavailableError("fake SSH is not available");
    }
    if (this.failuresBeforeSuccess > 0) {
      this.failuresBeforeSuccess -= 1;
      throw new SshUnavailableError("fake SSH is not ready yet");
    }

    if (!this.perSandbox) return this.session;

    let session = this.sessionsBySandbox.get(request.sandboxId);
    if (session === undefined) {
      session = new FakeSshSession();
      this.sessionsBySandbox.set(request.sandboxId, session);
    }
    return session;
  }
}

/** In-memory POSIX-ish filesystem backing the fake SSH session. */
export class FakeSshSession implements SshSession {
  readonly commands: string[] = [];
  readonly nodes = new Map<string, FakeNode>();
  readonly shells: FakeShell[] = [];
  execResults: SshExecResult[] = [];
  closed = false;

  constructor() {
    this.ensureDirectory("/");
    this.ensureDirectory("/workspace");
    this.ensureDirectory("/home");
    this.ensureDirectory("/home/agent");
  }

  ensureDirectory(path: string): void {
    const target = normalize(path);
    this.ensureParent(target);
    this.nodes.set(target, { type: "directory", content: Buffer.alloc(0), mode: 0o755, modifiedAt: Date.now() });
  }

  ensureFile(path: string, content: Buffer | string = ""): void {
    const target = normalize(path);
    this.ensureParent(target);
    this.nodes.set(target, { type: "file", content: Buffer.from(content), mode: 0o644, modifiedAt: Date.now() });
  }

  async exec(command: string): Promise<SshExecResult> {
    this.commands.push(command);
    return this.execResults.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
  }

  async readFile(path: string): Promise<Buffer> {
    const node = this.requireNode(path);
    if (node.type !== "file") throw new SshError(`${path} is not a regular file`);
    return node.content;
  }

  async writeFile(path: string, content: Buffer | string): Promise<void> {
    const target = normalize(path);
    const parent = this.nodes.get(posix.dirname(target));
    if (parent === undefined || parent.type !== "directory") {
      throw new SshNotFoundError(`${posix.dirname(target)} was not found`);
    }
    this.nodes.set(target, {
      type: "file",
      content: Buffer.from(content),
      mode: 0o644,
      modifiedAt: Date.now(),
    });
  }

  async list(path: string): Promise<SshFileEntry[]> {
    const target = normalize(path);
    this.requireDirectory(target);

    return [...this.nodes.entries()]
      .filter(([candidate]) => candidate !== target && posix.dirname(candidate) === target)
      .map(([candidate, node]) => toEntry(candidate, node));
  }

  async stat(path: string): Promise<SshFileEntry> {
    return toEntry(normalize(path), this.requireNode(path));
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const target = normalize(path);

    if (options.recursive === true) {
      const segments = target.split("/").filter((segment) => segment !== "");
      let current = "/";
      for (const segment of segments) {
        current = posix.join(current, segment);
        const existing = this.nodes.get(current);
        if (existing === undefined) {
          this.nodes.set(current, { type: "directory", content: Buffer.alloc(0), mode: 0o755, modifiedAt: Date.now() });
        } else if (existing.type !== "directory") {
          throw new SshError(`${current} is not a directory`);
        }
      }
      return;
    }

    if (this.nodes.has(target)) throw new SshError(`${target} already exists`);
    this.ensureParent(target);
    this.nodes.set(target, { type: "directory", content: Buffer.alloc(0), mode: 0o755, modifiedAt: Date.now() });
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const target = normalize(path);
    const node = this.nodes.get(target);
    if (node === undefined) return;

    if (node.type === "directory") {
      const hasChildren = [...this.nodes.keys()].some(
        (candidate) => candidate !== target && candidate.startsWith(`${target}/`),
      );
      if (hasChildren && options.recursive !== true) {
        throw new SshError(`${target} is not empty`);
      }
      for (const candidate of [...this.nodes.keys()]) {
        if (candidate === target || candidate.startsWith(`${target}/`)) {
          this.nodes.delete(candidate);
        }
      }
      return;
    }

    this.nodes.delete(target);
  }

  async openShell(options: SshShellOptions): Promise<SshShell> {
    const shell: FakeShell = {
      cols: options.cols,
      rows: options.rows,
      writes: [],
      closed: false,
      emit: (data: string) => options.onData(data),
      exit: (code: number | null) => options.onExit(code),
    };
    this.shells.push(shell);

    return {
      write: (data: string) => {
        shell.writes.push(data);
      },
      resize: (cols: number, rows: number) => {
        shell.cols = cols;
        shell.rows = rows;
      },
      close: () => {
        shell.closed = true;
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private requireNode(path: string): FakeNode {
    const target = normalize(path);
    const node = this.nodes.get(target);
    if (node === undefined) throw new SshNotFoundError(`${path} was not found`);
    return node;
  }

  private requireDirectory(path: string): FakeNode {
    const node = this.requireNode(path);
    if (node.type !== "directory") throw new SshError(`${path} is not a directory`);
    return node;
  }

  private ensureParent(path: string): void {
    const parent = posix.dirname(path);
    if (parent === path) return;
    if (!this.nodes.has(parent)) this.ensureDirectory(parent);
  }
}

function normalize(path: string): string {
  return posix.normalize(path);
}

function toEntry(path: string, node: FakeNode): SshFileEntry {
  return {
    name: posix.basename(path),
    path,
    type: node.type,
    size: node.content.length,
    mode: node.mode,
    modifiedAt: node.modifiedAt,
  };
}
