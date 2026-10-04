import type {
  BashOperations,
  EditOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { SessionBoxClientError, type SandboxRuntime } from "@sessionbox/client";
import { toSandboxPath } from "./paths.ts";

export interface OperationContext {
  /** The live agent-protocol connection; throws when SessionBox is unavailable. */
  runtime: () => SandboxRuntime;
  /** The Pi session working directory on the host. */
  hostCwd: () => string;
  sandboxRoot: string;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/**
 * The SessionBox agent protocol moves text; image bytes are not supported yet.
 * Rejecting them explicitly is better than handing the model mojibake.
 */
function assertTextReadable(hostPath: string): void {
  const extension = hostPath.toLowerCase().match(/\.[^./\\]+$/)?.[0] ?? "";
  if (extension in IMAGE_MIME_TYPES) {
    throw new Error(
      `reading image files through SessionBox is not supported yet: ${hostPath}`,
    );
  }
}

/** Bash runs inside the sandbox; cwd and output stream through the protocol. */
export function createBashOperations(context: OperationContext): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      if (signal?.aborted === true) {
        throw new Error("aborted");
      }

      const result = await context.runtime().exec(command, {
        cwd: toSandboxPath(cwd, context.hostCwd(), context.sandboxRoot),
        ...(timeout !== undefined ? { timeoutMs: Math.round(timeout * 1000) } : {}),
      });

      if (result.stdout !== "") onData(Buffer.from(result.stdout, "utf8"));
      if (result.stderr !== "") onData(Buffer.from(result.stderr, "utf8"));

      return { exitCode: result.exitCode };
    },
  };
}

export function createReadOperations(context: OperationContext): ReadOperations {
  return {
    readFile: async (absolutePath) => {
      assertTextReadable(absolutePath);
      const file = await context.runtime().readFile(toSandbox(absolutePath, context));
      return Buffer.from(file.content, "utf8");
    },
    access: async (absolutePath) => {
      await context.runtime().statFile(toSandbox(absolutePath, context));
    },
    detectImageMimeType: async (absolutePath) => {
      const extension = absolutePath.toLowerCase().match(/\.[^./\\]+$/)?.[0] ?? "";
      return IMAGE_MIME_TYPES[extension] ?? null;
    },
  };
}

export function createWriteOperations(context: OperationContext): WriteOperations {
  return {
    writeFile: async (absolutePath, content) => {
      await context.runtime().writeFile(toSandbox(absolutePath, context), content);
    },
    mkdir: async (dir) => {
      await context.runtime().mkdir(toSandbox(dir, context), { recursive: true });
    },
  };
}

export function createEditOperations(context: OperationContext): EditOperations {
  return {
    readFile: async (absolutePath) => {
      assertTextReadable(absolutePath);
      const file = await context.runtime().readFile(toSandbox(absolutePath, context));
      return Buffer.from(file.content, "utf8");
    },
    writeFile: async (absolutePath, content) => {
      await context.runtime().writeFile(toSandbox(absolutePath, context), content);
    },
    access: async (absolutePath) => {
      await context.runtime().statFile(toSandbox(absolutePath, context));
    },
  };
}

export function createLsOperations(context: OperationContext): LsOperations {
  return {
    exists: async (absolutePath) => {
      try {
        await context.runtime().statFile(toSandbox(absolutePath, context));
        return true;
      } catch (error) {
        if (error instanceof SessionBoxClientError && error.code === "NOT_FOUND") return false;
        throw error;
      }
    },
    stat: async (absolutePath) => {
      const entry = await context.runtime().statFile(toSandbox(absolutePath, context));
      return { isDirectory: () => entry.type === "directory" };
    },
    readdir: async (absolutePath) => {
      const listing = await context.runtime().listFiles(toSandbox(absolutePath, context));
      return listing.entries.map((entry) => entry.name);
    },
  };
}

function toSandbox(hostPath: string, context: OperationContext): string {
  return toSandboxPath(hostPath, context.hostCwd(), context.sandboxRoot);
}
