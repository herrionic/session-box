import { describe, expect, it } from "vitest";
import { newRequestId, newSandboxId, newUlid, nowIso } from "../src/index.ts";

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]+$/;

describe("ids", () => {
  it("generates 26-char Crockford base32 ULIDs", () => {
    const ulid = newUlid();
    expect(ulid).toHaveLength(26);
    expect(ulid).toMatch(CROCKFORD);
  });

  it("prefixes sandbox and request ids", () => {
    expect(newSandboxId()).toMatch(/^sbx_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newRequestId()).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("is lexicographically ordered by timestamp", () => {
    const earlier = newSandboxId(1_700_000_000_000);
    const later = newSandboxId(1_700_000_000_001);
    expect(earlier < later).toBe(true);
  });

  it("does not collide across many calls", () => {
    const ids = new Set<string>();
    for (let index = 0; index < 1000; index += 1) {
      ids.add(newSandboxId());
    }
    expect(ids.size).toBe(1000);
  });
});

describe("time", () => {
  it("formats ISO timestamps", () => {
    expect(nowIso(0)).toBe("1970-01-01T00:00:00.000Z");
  });
});
