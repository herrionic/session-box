import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { apply } from "../src/index.ts";

describe("sessionbox DSH plugin", () => {
  it("registers the fs and shell capability providers", async () => {
    const ctx = new Context();

    await apply(ctx, {
      baseUrl: "http://127.0.0.1:1",
      hostCwd: process.cwd(),
      workspaceRoot: "/workspace",
    });

    expect(ctx.fs).toBeDefined();
    expect(ctx.shell).toBeDefined();
    expect(ctx.fs.sandboxMode).toBeUndefined();
  });
});
