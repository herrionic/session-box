import { describe, expect, it } from "vitest";
import { normalizeContainerPath } from "../src/ssh/paths.ts";

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
