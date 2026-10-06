import { describe, expect, it } from "vitest";
import {
  buildListCommand,
  buildStatCommand,
  parseFindOutput,
  toSshEntries,
  toSshEntry,
  type ParsedFindEntry,
} from "../src/ssh/find-entries.ts";

/** Builds one `find -printf` record (eight NUL-separated fields). */
function record(
  name: string,
  type: string,
  mode: string,
  ino: string,
  size: string,
  mtime: string,
  ctime: string,
  link = "",
): string {
  return [name, type, mode, ino, size, mtime, ctime, link, ""].join("\0");
}

describe("find metadata parsing", () => {
  it("parses files, directories and symlinks with nanosecond versions", () => {
    const stdout =
      record("a.txt", "f", "644", "1001", "5", "1791255099.7955081820", "1791255099.8") +
      record("sub", "d", "755", "1002", "4096", "1791255000.0", "1791255000.0") +
      record("link", "l", "777", "1003", "7", "1791255098.5", "1791255098.5", "/workspace/a.txt");

    const entries = parseFindOutput(stdout);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      name: "a.txt",
      type: "file",
      mode: 0o100644,
      size: 5,
      modifiedAt: 1791255099000,
      version: "1001:5:1791255099795508182:1791255099800000000",
    });
    expect(entries[1]).toMatchObject({ type: "directory", mode: 0o040755 });
    expect(entries[2]).toMatchObject({
      type: "symlink",
      mode: 0o120777,
      linkTarget: "/workspace/a.txt",
      version: "1003:7:1791255098500000000:1791255098500000000",
    });
  });

  it("keeps names with newlines and spaces intact", () => {
    const stdout = record("weird\nname with spaces", "f", "600", "1004", "1", "1.5", "1.5");
    const [entry] = parseFindOutput(stdout);
    expect(entry?.name).toBe("weird\nname with spaces");
    expect(entry?.version).toBe("1004:1:1500000000:1500000000");
  });

  it("ignores a truncated trailing record", () => {
    const stdout =
      record("ok.txt", "f", "644", "1005", "2", "2.25", "2.25") + "truncated\0f\0";
    expect(parseFindOutput(stdout).map((entry) => entry.name)).toEqual(["ok.txt"]);
    expect(parseFindOutput("")).toEqual([]);
  });

  it("maps entries to paths and builds the find commands", () => {
    const parsed = parseFindOutput(record("a.txt", "f", "644", "1006", "5", "1.5", "1.5"));
    const first = parsed[0] as ParsedFindEntry;

    expect(toSshEntries(parsed, "/workspace")).toEqual([
      expect.objectContaining({ name: "a.txt", path: "/workspace/a.txt" }),
    ]);
    expect(toSshEntry(first, "/workspace/a.txt")).toMatchObject({
      name: "a.txt",
      path: "/workspace/a.txt",
      version: "1006:5:1500000000:1500000000",
    });

    expect(buildListCommand("/workspace")).toContain(
      "find -H '/workspace' -mindepth 1 -maxdepth 1 -printf",
    );
    expect(buildStatCommand("/etc/alternatives/awk", false)).toContain(
      "find '/etc/alternatives/awk' -maxdepth 0",
    );
    expect(buildStatCommand("/etc/alternatives/awk", true)).toContain(
      "find -H '/etc/alternatives/awk' -maxdepth 0",
    );
  });
});
