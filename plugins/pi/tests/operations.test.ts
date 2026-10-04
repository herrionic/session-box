import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionBoxClientError, type SandboxRuntime } from "@sessionbox/client";
import {
  createBashOperations,
  createEditOperations,
  createLsOperations,
  createReadOperations,
  createWriteOperations,
} from "../src/operations.ts";

const HOST_CWD = process.platform === "win32" ? "D:\\work\\project" : "/home/user/project";

function createFixture(): {
  context: { runtime: () => SandboxRuntime; hostCwd: () => string; sandboxRoot: string };
  runtime: {
    exec: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
    mkdir: ReturnType<typeof vi.fn>;
  };
  files: Map<string, string>;
} {
  const files = new Map<string, string>();

  const runtime = {
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" })),
    readFile: vi.fn(async (target: string) => {
      const content = files.get(target);
      if (content === undefined) {
        throw new SessionBoxClientError("NOT_FOUND", `${target} was not found`);
      }
      return { path: target, content, size: content.length, modifiedAt: 0 };
    }),
    writeFile: vi.fn(async (target: string, content: string) => {
      files.set(target, content);
      return { path: target, size: content.length, modifiedAt: 0 };
    }),
    listFiles: vi.fn(async (target: string) => ({
      path: target,
      entries: [
        { name: "a.txt", path: `${target}/a.txt`, type: "file" as const, size: 1, mode: 420, modifiedAt: 0 },
      ],
    })),
    statFile: vi.fn(async (target: string) => {
      if (target.endsWith("missing")) {
        throw new SessionBoxClientError("NOT_FOUND", `${target} was not found`);
      }
      return {
        name: path.posix.basename(target),
        path: target,
        type: (files.has(target) ? "file" : "directory") as "file" | "directory",
        size: 1,
        mode: 420,
        modifiedAt: 0,
      };
    }),
    mkdir: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };

  return {
    context: {
      runtime: () => runtime as unknown as SandboxRuntime,
      hostCwd: () => HOST_CWD,
      sandboxRoot: "/workspace",
    },
    runtime,
    files,
  };
}

describe("bash operations", () => {
  it("maps the working directory and streams output", async () => {
    const { context, runtime } = createFixture();
    const bash = createBashOperations(context);
    const chunks: Buffer[] = [];

    const result = await bash.exec("uname -a", HOST_CWD, {
      onData: (chunk) => chunks.push(chunk),
    });

    expect(result.exitCode).toBe(0);
    expect(Buffer.concat(chunks).toString("utf8")).toContain("ok");
    expect(runtime.exec).toHaveBeenCalledWith("uname -a", { cwd: "/workspace" });
  });

  it("converts the timeout from seconds to milliseconds", async () => {
    const { context, runtime } = createFixture();
    const bash = createBashOperations(context);

    await bash.exec("sleep 1", HOST_CWD, { onData: () => {}, timeout: 3 });

    expect(runtime.exec).toHaveBeenCalledWith("sleep 1", {
      cwd: "/workspace",
      timeoutMs: 3000,
    });
  });

  it("refuses to start when the signal is already aborted", async () => {
    const { context, runtime } = createFixture();
    const bash = createBashOperations(context);
    const controller = new AbortController();
    controller.abort();

    await expect(
      bash.exec("true", HOST_CWD, { onData: () => {}, signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
    expect(runtime.exec).not.toHaveBeenCalled();
  });
});

describe("file operations", () => {
  it("maps host paths into the sandbox for read, write and mkdir", async () => {
    const { context, files, runtime } = createFixture();
    const read = createReadOperations(context);
    const write = createWriteOperations(context);

    await write.writeFile(path.join(HOST_CWD, "src", "app.ts"), "export {};\n");
    expect(files.get("/workspace/src/app.ts")).toBe("export {};\n");

    await write.mkdir(path.join(HOST_CWD, "src", "nested"));
    expect(runtime.mkdir).toHaveBeenCalledWith("/workspace/src/nested", { recursive: true });

    const buffer = await read.readFile(path.join(HOST_CWD, "src", "app.ts"));
    expect(buffer.toString("utf8")).toBe("export {};\n");
  });

  it("supports edit read/write and access", async () => {
    const { context, files } = createFixture();
    const edit = createEditOperations(context);

    await edit.writeFile(path.join(HOST_CWD, "a.txt"), "hello");
    expect(files.get("/workspace/a.txt")).toBe("hello");
    expect((await edit.readFile(path.join(HOST_CWD, "a.txt"))).toString()).toBe("hello");
    await expect(edit.access(path.join(HOST_CWD, "a.txt"))).resolves.toBeUndefined();
  });

  it("rejects image reads with a clear error", async () => {
    const { context } = createFixture();
    const read = createReadOperations(context);

    await expect(read.readFile(path.join(HOST_CWD, "logo.png"))).rejects.toThrow(/image/);
    await expect(read.detectImageMimeType?.(path.join(HOST_CWD, "logo.png"))).resolves.toBe(
      "image/png",
    );
    await expect(read.detectImageMimeType?.(path.join(HOST_CWD, "notes.txt"))).resolves.toBeNull();
  });
});

describe("ls operations", () => {
  it("reports existence, directory stats and entries", async () => {
    const { context } = createFixture();
    const ls = createLsOperations(context);

    await expect(ls.exists(path.join(HOST_CWD, "missing"))).resolves.toBe(false);
    await expect(ls.exists(path.join(HOST_CWD, "present"))).resolves.toBe(true);

    const stat = await ls.stat(path.join(HOST_CWD, "present"));
    expect(stat.isDirectory()).toBe(true);

    await expect(ls.readdir(path.join(HOST_CWD, "present"))).resolves.toEqual(["a.txt"]);
  });
});
