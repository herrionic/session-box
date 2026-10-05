import path from "node:path";
import { describe, expect, it } from "vitest";
import { toContainerPath } from "../src/paths.ts";

const HOST_CWD = process.platform === "win32" ? "D:\\work\\project" : "/home/user/project";

describe("toContainerPath", () => {
  it("passes through paths already inside the container root", () => {
    expect(toContainerPath("/workspace/who.txt", HOST_CWD)).toBe("/workspace/who.txt");
    expect(toContainerPath("/workspace", HOST_CWD)).toBe("/workspace");
  });

  it("maps host paths under the session cwd into the workspace", () => {
    expect(toContainerPath(path.join(HOST_CWD, "src", "app.ts"), HOST_CWD)).toBe(
      "/workspace/src/app.ts",
    );
    expect(toContainerPath(HOST_CWD, HOST_CWD)).toBe("/workspace");
  });

  it("rejects host paths outside the session cwd", () => {
    const outside = path.join(path.dirname(HOST_CWD), "elsewhere", "file.txt");
    expect(() => toContainerPath(outside, HOST_CWD)).toThrow(/outside the session workspace/);
  });

  it("rejects empty paths", () => {
    expect(() => toContainerPath("", HOST_CWD)).toThrow(/must not be empty/);
  });

  it.runIf(process.platform === "win32")("passes POSIX paths through on Windows hosts", () => {
    expect(toContainerPath("/tmp/scratch.txt", HOST_CWD)).toBe("/tmp/scratch.txt");
  });
});
