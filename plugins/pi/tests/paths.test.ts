import path from "node:path";
import { describe, expect, it } from "vitest";
import { toSandboxPath } from "../src/paths.ts";

const HOST_CWD = process.platform === "win32" ? "D:\\work\\project" : "/home/user/project";

describe("toSandboxPath", () => {
  it("passes through paths already inside the sandbox root", () => {
    expect(toSandboxPath("/workspace/who.txt", HOST_CWD)).toBe("/workspace/who.txt");
    expect(toSandboxPath("/workspace", HOST_CWD)).toBe("/workspace");
  });

  it("maps host paths under the session cwd into the workspace", () => {
    expect(toSandboxPath(path.join(HOST_CWD, "src", "app.ts"), HOST_CWD)).toBe(
      "/workspace/src/app.ts",
    );
    expect(toSandboxPath(HOST_CWD, HOST_CWD)).toBe("/workspace");
  });

  it("rejects host paths outside the session cwd", () => {
    const outside = path.join(path.dirname(HOST_CWD), "elsewhere", "file.txt");
    expect(() => toSandboxPath(outside, HOST_CWD)).toThrow(/outside the session workspace/);
  });

  it("rejects empty paths", () => {
    expect(() => toSandboxPath("", HOST_CWD)).toThrow(/must not be empty/);
  });

  it.runIf(process.platform === "win32")("passes POSIX paths through on Windows hosts", () => {
    expect(toSandboxPath("/tmp/scratch.txt", HOST_CWD)).toBe("/tmp/scratch.txt");
  });
});
