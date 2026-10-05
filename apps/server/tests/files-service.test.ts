import { FILE_LIMITS } from "@sessionbox/protocol";
import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/credentials/store.ts";
import { ContainerFilesService } from "../src/files/service.ts";
import { InMemoryContainerRepository } from "../src/container/repository.ts";
import { ContainerService } from "../src/container/service.ts";
import { SshSessionManager } from "../src/ssh/manager.ts";
import { FakeRuntime } from "./helpers/fake-runtime.ts";
import { FakeSshSessionFactory } from "./helpers/fake-ssh.ts";
import { createTestLogger } from "./helpers/test-logger.ts";

async function createFixture() {
  const runtime = new FakeRuntime();
  const logger = createTestLogger();
  const ssh = new FakeSshSessionFactory();

  const service = new ContainerService({
    runtime,
    repository: new InMemoryContainerRepository(),
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
  const files = new ContainerFilesService({
    containers: service,
    workspace: "/workspace",
    logger,
  });

  const container = await service.create({});
  return { service, files, ssh: ssh.session, container };
}

describe("ContainerFilesService", () => {
  it("lists, creates, writes, reads and deletes files", async () => {
    const { files, container } = await createFixture();

    expect((await files.list(container.id, "/workspace")).entries).toEqual([]);

    const created = await files.create(container.id, {
      path: "/workspace/notes.txt",
      type: "file",
    });
    expect(created.type).toBe("file");

    await files.writeText(container.id, { path: "/workspace/notes.txt", content: "hello" });
    const read = await files.readText(container.id, "/workspace/notes.txt");
    expect(read.content).toBe("hello");
    expect(read.size).toBe(5);

    const listing = await files.list(container.id, "/workspace");
    expect(listing.entries.map((entry) => entry.name)).toEqual(["notes.txt"]);

    await files.remove(container.id, "/workspace/notes.txt");
    await expect(files.readText(container.id, "/workspace/notes.txt")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("creates directories recursively and supports upload/download", async () => {
    const { files, container } = await createFixture();

    await files.create(container.id, { path: "/workspace/a/b", type: "directory" });
    await files.create(container.id, { path: "/workspace/a/b/c.txt", type: "file" });

    const uploaded = await files.upload(container.id, "/workspace/a/up.bin", Buffer.from([1, 2, 3]));
    expect(uploaded.size).toBe(3);

    const { content } = await files.download(container.id, "/workspace/a/up.bin");
    expect([...content]).toEqual([1, 2, 3]);

    const deep = await files.list(container.id, "/workspace/a/b");
    expect(deep.entries.map((entry) => entry.name)).toEqual(["c.txt"]);
  });

  it("rejects paths outside the workspace before touching SSH", async () => {
    const { files, container, ssh } = await createFixture();
    const commandsBefore = ssh.commands.length;

    await expect(files.list(container.id, "/etc")).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(
      files.readText(container.id, "/workspace/../../etc/passwd"),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    expect(ssh.commands).toHaveLength(commandsBefore);
  });

  it("refuses to delete the workspace root", async () => {
    const { files, container } = await createFixture();
    await expect(files.remove(container.id, "/workspace")).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  it("enforces the text size limit", async () => {
    const { files, container, ssh } = await createFixture();
    ssh.ensureFile("/workspace/big.txt", Buffer.alloc(FILE_LIMITS.maxTextFileBytes + 1, 65));

    await expect(files.readText(container.id, "/workspace/big.txt")).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  it("requires a running container", async () => {
    const { files, container, service } = await createFixture();
    await service.stop(container.id);

    await expect(files.list(container.id, "/workspace")).rejects.toMatchObject({
      code: "CONTAINER_NOT_RUNNING",
    });
  });

  it("reports missing paths as NOT_FOUND", async () => {
    const { files, container } = await createFixture();
    await expect(files.readText(container.id, "/workspace/missing.txt")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
