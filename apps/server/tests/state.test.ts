import { describe, expect, it } from "vitest";
import type { ContainerStatus } from "@sessionbox/protocol";
import { SessionBoxError } from "../src/errors.ts";
import { ALLOWED_STATUSES, assertOperationAllowed, type ContainerOperation } from "../src/container/state.ts";

const ALL_STATUSES: ContainerStatus[] = ["creating", "running", "stopped", "failed", "deleting"];

describe("container state machine", () => {
  it("documents the full transition matrix", () => {
    expect(ALLOWED_STATUSES).toEqual({
      start: ["stopped", "failed"],
      stop: ["running"],
      restart: ["running", "stopped"],
      delete: ["creating", "running", "stopped", "failed"],
    });
  });

  it.each<[ContainerOperation, ContainerStatus, boolean]>([
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
