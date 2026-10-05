import { describe, expect, it } from "vitest";
import {
  isWithinWorkspace,
  normalizeContainerPath,
  resolveWithinWorkspace,
} from "../src/ssh/paths.ts";

describe("normalizeContainerPath", () => {
  it("normalizes redundant separators and dot segments", () => {
    expect(normalizeContainerPath("/workspace/./a/../b")).toBe("/workspace/b");
    expect(normalizeContainerPath("//workspace//a")).toBe("/workspace/a");
    expect(normalizeContainerPath("/")).toBe("/");
  });

  it("rejects relative, empty and NUL paths", () => {
    expect(() => normalizeContainerPath("workspace/a")).toThrow(/absolute/);
    expect(() => normalizeContainerPath("  ")).toThrow(/empty/);
    expect(() => normalizeContainerPath("/a\0b")).toThrow(/NUL/);
  });
});

describe("isWithinWorkspace", () => {
  it("accepts the root and its children", () => {
    expect(isWithinWorkspace("/", "/workspace")).toBe(true);
    expect(isWithinWorkspace("/workspace", "/workspace")).toBe(true);
    expect(isWithinWorkspace("/workspace", "/workspace/a/b.txt")).toBe(true);
    expect(isWithinWorkspace("/workspace", "/")).toBe(false);
  });

  it("rejects siblings and traversal escapes", () => {
    expect(isWithinWorkspace("/workspace", "/etc/passwd")).toBe(false);
    expect(isWithinWorkspace("/workspace", "/workspace-evil")).toBe(false);
    expect(isWithinWorkspace("/workspace", "/workspace/../../etc/passwd")).toBe(false);
  });
});

describe("resolveWithinWorkspace", () => {
  it("resolves paths inside the workspace", () => {
    expect(resolveWithinWorkspace("/workspace/a/../b.txt", "/workspace")).toBe("/workspace/b.txt");
  });

  it("rejects traversal attempts with a stable error code", () => {
    try {
      resolveWithinWorkspace("/workspace/../../etc/passwd", "/workspace");
      throw new Error("expected resolveWithinWorkspace to throw");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_REQUEST" });
    }
  });
});
