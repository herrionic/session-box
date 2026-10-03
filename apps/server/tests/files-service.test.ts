import { FILE_LIMITS } from "@sessionbox/protocol";
import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/credentials/store.ts";
import { SandboxFilesService } from "../src/files/service.ts";
import { InMemorySandboxRepository } from "../src/sandbox/repository.ts";
import { SandboxService } from "../src/sandbox/service.ts";
import { SshSessionManager } from "../src/ssh/manager.ts";
import { FakeRuntime } from "./helpers/fake-runtime.ts";
import { FakeSshSessionFactory } from "./helpers/fake-ssh.ts";
import { createTestLogger } from "./helpers/test-logger.ts";

async function createFixture() {
  const runtime = new FakeRuntime();
  const logger = createTestLogger();
  const ssh = new FakeSshSessionFactory();

  const service = new SandboxService({
    runtime,
    repository: new InMemorySandboxRepository(),
    credentials: new InMemoryCredentialStore(Buffer.alloc(32, 3)),
    ssh,
    sessions: new SshSessionManager(ssh, logger),
    logger,
    baseImage: "sessionbox/base:test",
    workspace: "/workspace",
    sshReadyTimeoutMs: 50,
    sshRetryIntervalMs: 1,
    sleep: async () => {},
  });
  const files = new SandboxFilesService({
    sandboxes: service,
    workspace: "/workspace",
    logger,
  });

  const sandbox = await service.create({});
  return { service, files, ssh: ssh.session, sandbox };
}

describe("SandboxFilesService", () => {
  it("lists, creates, writes, reads and deletes files", async () => {
    const { files, sandbox } = await createFixture();

    expect((await files.list(sandbox.id, "/workspace")).entries).toEqual([]);

    const created = await files.create(sandbox.id, {
      path: "/workspace/notes.txt",
      type: "file",
    });
    expect(created.type).toBe("file");

    await files.writeText(sandbox.id, { path: "/workspace/notes.txt", content: "hello" });
    const read = await files.readText(sandbox.id, "/workspace/notes.txt");
    expect(read.content).toBe("hello");
    expect(read.size).toBe(5);

    const listing = await files.list(sandbox.id, "/workspace");
    expect(listing.entries.map((entry) => entry.name)).toEqual(["notes.txt"]);

    await files.remove(sandbox.id, "/workspace/notes.txt");
    await expect(files.readText(sandbox.id, "/workspace/notes.txt")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("creates directories recursively and supports upload/download", async () => {
    const { files, sandbox } = await createFixture();

    await files.create(sandbox.id, { path: "/workspace/a/b", type: "directory" });
    await files.create(sandbox.id, { path: "/workspace/a/b/c.txt", type: "file" });

    const uploaded = await files.upload(sandbox.id, "/workspace/a/up.bin", Buffer.from([1, 2, 3]));
    expect(uploaded.size).toBe(3);

    const { content } = await files.download(sandbox.id, "/workspace/a/up.bin");
    expect([...content]).toEqual([1, 2, 3]);

    const deep = await files.list(sandbox.id, "/workspace/a/b");
    expect(deep.entries.map((entry) => entry.name)).toEqual(["c.txt"]);
  });

  it("rejects paths outside the workspace before touching SSH", async () => {
    const { files, sandbox, ssh } = await createFixture();
    const commandsBefore = ssh.commands.length;

    await expect(files.list(sandbox.id, "/etc")).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(
      files.readText(sandbox.id, "/workspace/../../etc/passwd"),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    expect(ssh.commands).toHaveLength(commandsBefore);
  });

  it("refuses to delete the workspace root", async () => {
    const { files, sandbox } = await createFixture();
    await expect(files.remove(sandbox.id, "/workspace")).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  it("enforces the text size limit", async () => {
    const { files, sandbox, ssh } = await createFixture();
    ssh.ensureFile("/workspace/big.txt", Buffer.alloc(FILE_LIMITS.maxTextFileBytes + 1, 65));

    await expect(files.readText(sandbox.id, "/workspace/big.txt")).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  it("requires a running sandbox", async () => {
    const { files, sandbox, service } = await createFixture();
    await service.stop(sandbox.id);

    await expect(files.list(sandbox.id, "/workspace")).rejects.toMatchObject({
      code: "SANDBOX_NOT_RUNNING",
    });
  });

  it("reports missing paths as NOT_FOUND", async () => {
    const { files, sandbox } = await createFixture();
    await expect(files.readText(sandbox.id, "/workspace/missing.txt")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
