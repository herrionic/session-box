import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { FsError, FsVersion } from "@deepseek-ai/dsh-fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionBoxFileSystem } from "../src/fs.ts";
import { createFakeConnection, createFakeRuntime, type FakeRuntime } from "./helpers.ts";

const HOST_CWD = process.platform === "win32" ? "D:\\work\\project" : "/home/user/project";

let ctx: Context;
let fs: SessionBoxFileSystem;
let runtime: FakeRuntime;
let fiber: Awaited<ReturnType<Context["plugin"]>>;

beforeEach(async () => {
  runtime = createFakeRuntime();
  runtime.files.set("/workspace/notes.txt", "hello\n");
  ctx = new Context();
  fiber = await ctx.plugin(SessionBoxFileSystem, {
    connection: () => createFakeConnection(runtime),
    hostCwd: HOST_CWD,
    workspaceRoot: "/workspace",
  });
  fs = ctx.fs as SessionBoxFileSystem;
});

afterEach(async () => {
  await fiber.dispose();
});

describe("SessionBoxFileSystem", () => {
  it("resolves host paths into sandbox targets and back for display", async () => {
    const target = await fs.resolve("notes.txt");

    expect(String(target.targetKey)).toBe("/workspace/notes.txt");
    expect(target.displayPath).toBe(path.join(HOST_CWD, "notes.txt"));
    expect(fs.processPath(target)).toBe("/workspace/notes.txt");
    expect(fs.fileUrl(target)).toBe("file:///workspace/notes.txt");
  });

  it("stats and reads text", async () => {
    const target = await fs.resolve(path.join(HOST_CWD, "notes.txt"));
    const info = await fs.stat(target);

    expect(info).toMatchObject({ type: "file", size: 6 });
    await expect(fs.readText(target)).resolves.toBe("hello\n");

    const chunks: string[] = [];
    for await (const chunk of await fs.streamText(target)) chunks.push(chunk);
    expect(chunks.join("")).toBe("hello\n");
  });

  it("reports missing files as absent or FS_NOT_FOUND", async () => {
    const target = await fs.resolve("missing.txt");

    await expect(fs.stat(target)).resolves.toBeUndefined();
    await expect(fs.readText(target)).rejects.toMatchObject({ code: "FS_NOT_FOUND" });
  });

  it("lists directories with host-visible display paths", async () => {
    const entries = await fs.listDir(await fs.resolve(HOST_CWD));

    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("notes.txt");
    expect(entries[0]?.target.displayPath).toBe(path.join(HOST_CWD, "notes.txt"));
  });

  it("writes files with create/update outcomes", async () => {
    const created = await fs.writeText(await fs.resolve("fresh.txt"), "one");

    expect(created.operation).toBe("create");
    expect(created.before).toBeNull();
    expect(created.after).toBe("one");

    const updated = await fs.writeText(await fs.resolve("fresh.txt"), "two");
    expect(updated.operation).toBe("update");
    expect(updated.before).toBe("one");
    expect(runtime.files.get("/workspace/fresh.txt")).toBe("two");
  });

  it("enforces write guards", async () => {
    await expect(
      fs.writeText(await fs.resolve("notes.txt"), "x", { kind: "createIfAbsent" }),
    ).rejects.toMatchObject({ code: "FS_NOT_OBSERVED" });

    await expect(
      fs.writeText(await fs.resolve("notes.txt"), "x", {
        kind: "replaceIfVersion",
        version: FsVersion("0:0"),
      }),
    ).rejects.toMatchObject({ code: "FS_STALE_VERSION" });

    const current = await fs.stat(await fs.resolve("notes.txt"));
    const replaced = await fs.writeText(await fs.resolve("notes.txt"), "new", {
      kind: "replaceIfVersion",
      version: current?.version ?? FsVersion("missing"),
    });
    expect(replaced.after).toBe("new");
  });

  it("edits literal text and reports edit errors", async () => {
    const target = await fs.resolve("notes.txt");

    const edited = await fs.editText(target, {
      oldString: "hello",
      newString: "goodbye",
      replaceAll: false,
    });
    expect(edited.before).toBe("hello\n");
    expect(edited.after).toBe("goodbye\n");

    await expect(
      fs.editText(target, { oldString: "absent", newString: "x", replaceAll: false }),
    ).rejects.toMatchObject({ code: "FS_EDIT_NOT_FOUND" });

    runtime.files.set("/workspace/dup.txt", "a a");
    await expect(
      fs.editText(await fs.resolve("dup.txt"), { oldString: "a", newString: "b", replaceAll: false }),
    ).rejects.toMatchObject({ code: "FS_AMBIGUOUS_EDIT" });

    const all = await fs.editText(await fs.resolve("dup.txt"), {
      oldString: "a",
      newString: "b",
      replaceAll: true,
    });
    expect(all.after).toBe("b b");
  });

  it("rejects binary reads with a typed error", async () => {
    const target = await fs.resolve("notes.txt");

    await expect(fs.readBytes(target, undefined, 1024)).rejects.toBeInstanceOf(FsError);
    await expect(fs.readByteRange(target, { offset: 0, length: 1 })).rejects.toMatchObject({
      code: "FS_IO_ERROR",
    });
  });

  it("answers containment from sandbox targets", async () => {
    const parent = await fs.resolve(HOST_CWD);
    const child = await fs.resolve("notes.txt");

    expect(fs.contains(parent, child)).toBe(true);
    expect(fs.contains(child, parent)).toBe(false);
  });
});
