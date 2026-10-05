import type { ContainerRuntime } from "@sessionbox/client";
import { SessionBoxClientError } from "@sessionbox/client";
import type { SessionBoxRuntimeProvider } from "../src/connection.ts";

export interface FakeRuntime {
  files: Map<string, string>;
  commands: string[];
  execCalls: Array<{ command: string; cwd?: string; timeoutMs?: number }>;
  execResults: Array<{ exitCode: number | null; stdout: string; stderr: string }>;
  execError: Error | null;
  exec: (command: string, options?: { cwd?: string; timeoutMs?: number }) => Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>;
  readFile: (target: string) => Promise<{ path: string; content: string; size: number; modifiedAt: number }>;
  writeFile: (target: string, content: string) => Promise<{ path: string; size: number; modifiedAt: number }>;
  listFiles: (target: string) => Promise<{
    path: string;
    entries: Array<{
      name: string;
      path: string;
      type: "file" | "directory" | "symlink" | "other";
      size: number;
      mode: number;
      modifiedAt: number;
    }>;
  }>;
  statFile: (target: string) => Promise<{
    name: string;
    path: string;
    type: "file" | "directory" | "symlink" | "other";
    size: number;
    mode: number;
    modifiedAt: number;
  }>;
  mkdir: (target: string) => Promise<void>;
  remove: (target: string) => Promise<void>;
  close: () => Promise<void>;
}

/** In-memory runtime double covering the operations the providers use. */
export function createFakeRuntime(): FakeRuntime {
  const files = new Map<string, string>();

  const runtime: FakeRuntime = {
    files,
    commands: [],
    execCalls: [],
    execResults: [],
    execError: null,
    exec: async (command, options) => {
      runtime.commands.push(command);
      runtime.execCalls.push({
        command,
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      if (runtime.execError !== null) throw runtime.execError;
      return runtime.execResults.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
    },
    readFile: async (target) => {
      const content = files.get(target);
      if (content === undefined) {
        throw new SessionBoxClientError("NOT_FOUND", `${target} was not found`);
      }
      return { path: target, content, size: Buffer.byteLength(content), modifiedAt: 1000 };
    },
    writeFile: async (target, content) => {
      files.set(target, content);
      return { path: target, size: Buffer.byteLength(content), modifiedAt: 1000 };
    },
    listFiles: async (target) => {
      const entries = [...files.entries()]
        .filter(([candidate]) => candidate.startsWith(`${target}/`))
        .filter(([candidate]) => !candidate.slice(target.length + 1).includes("/"))
        .map(([candidate, content]) => ({
          name: candidate.slice(target.length + 1),
          path: candidate,
          type: "file" as const,
          size: Buffer.byteLength(content),
          mode: 420,
          modifiedAt: 1000,
        }));
      return { path: target, entries };
    },
    statFile: async (target) => {
      const content = files.get(target);
      if (content === undefined) {
        throw new SessionBoxClientError("NOT_FOUND", `${target} was not found`);
      }
      return {
        name: target.split("/").pop() ?? target,
        path: target,
        type: "file",
        size: Buffer.byteLength(content),
        mode: 420,
        modifiedAt: 1000,
      };
    },
    mkdir: async () => {},
    remove: async () => {},
    close: async () => {},
  };

  return runtime;
}

export function createFakeConnection(
  runtime: FakeRuntime,
  containerId = "ctr_fake",
): SessionBoxRuntimeProvider {
  return {
    connect: async () => ({ containerId, runtime: runtime as unknown as ContainerRuntime }),
    containerIdOrNull: () => containerId,
    close: async () => {},
  };
}
