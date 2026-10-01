import { describe, expect, it } from "vitest";
import type { SandboxStatus } from "@sessionbox/protocol";
import { SessionBoxError } from "../src/errors.ts";
import { ALLOWED_STATUSES, assertOperationAllowed, type SandboxOperation } from "../src/sandbox/state.ts";

const ALL_STATUSES: SandboxStatus[] = ["creating", "running", "stopped", "failed", "deleting"];

describe("sandbox state machine", () => {
  it("documents the full transition matrix", () => {
    expect(ALLOWED_STATUSES).toEqual({
      start: ["stopped", "failed"],
      stop: ["running"],
      restart: ["running", "stopped"],
      delete: ["creating", "running", "stopped", "failed"],
    });
  });

  it.each<[SandboxOperation, SandboxStatus, boolean]>([
    ["start", "stopped", true],
    ["start", "failed", true],
    ["start", "running", false],
    ["start", "deleting", false],
    ["stop", "running", true],
    ["stop", "stopped", false],
    ["restart", "running", true],
    ["restart", "stopped", true],
    ["restart", "failed", false],
    ["delete", "running", true],
    ["delete", "stopped", true],
    ["delete", "creating", true],
    ["delete", "deleting", false],
  ])("%s from %s -> allowed=%s", (operation, status, allowed) => {
    if (allowed) {
      expect(() => assertOperationAllowed(operation, status)).not.toThrow();
    } else {
      expect(() => assertOperationAllowed(operation, status)).toThrow(SessionBoxError);
    }
  });

  it("rejects every status for stop except running", () => {
    for (const status of ALL_STATUSES) {
      if (status === "running") continue;
      expect(() => assertOperationAllowed("stop", status)).toThrow(/cannot stop/);
    }
  });
});
