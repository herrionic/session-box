import {
  SshError,
  SshNotFoundError,
  SshUnavailableError,
  type SshExecResult,
  type SshSession,
  type SshSessionFactory,
  type SshSessionRequest,
} from "../../src/ssh/session.ts";

/** Scriptable SSH session factory for service/probe tests (no real sshd). */
export class FakeSshSessionFactory implements SshSessionFactory {
  readonly requests: SshSessionRequest[] = [];
  readonly session = new FakeSshSession();

  /** Fail this many attempts before reporting ready (readiness probe tests). */
  failuresBeforeSuccess = 0;
  alwaysFail = false;

  async create(request: SshSessionRequest): Promise<SshSession> {
    this.requests.push(request);

    if (this.alwaysFail) {
      throw new SshUnavailableError("fake SSH is not available");
    }
    if (this.failuresBeforeSuccess > 0) {
      this.failuresBeforeSuccess -= 1;
      throw new SshUnavailableError("fake SSH is not ready yet");
    }
    return this.session;
  }
}

export class FakeSshSession implements SshSession {
  readonly commands: string[] = [];
  readonly files = new Map<string, Buffer>();
  execResults: SshExecResult[] = [];

  async exec(command: string): Promise<SshExecResult> {
    this.commands.push(command);
    return this.execResults.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
  }

  async readFile(path: string): Promise<Buffer> {
    const content = this.files.get(path);
    if (content === undefined) throw new SshNotFoundError(`${path} was not found`);
    return content;
  }

  async writeFile(path: string, content: Buffer | string): Promise<void> {
    this.files.set(path, Buffer.from(content));
  }

  async list(): Promise<never> {
    throw new SshError("list is not implemented in the fake session");
  }

  async stat(): Promise<never> {
    throw new SshError("stat is not implemented in the fake session");
  }

  async mkdir(): Promise<void> {}

  async remove(): Promise<void> {}

  async close(): Promise<void> {}
}
