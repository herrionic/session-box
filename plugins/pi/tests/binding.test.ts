import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionBoxClientError, type SessionBoxClient } from "@sessionbox/client";
import { readBindings, resolveContainerId, writeBindings } from "../src/binding.ts";

class FakeClient {
  readonly existing = new Set<string>();
  readonly createdNames: string[] = [];
  private counter = 0;

  async getContainer(id: string): Promise<{ id: string }> {
    if (this.existing.has(id)) return { id };
    throw new SessionBoxClientError("CONTAINER_NOT_FOUND", `container ${id} was not found`);
  }

  async createContainer(input: { name?: string } = {}): Promise<{ id: string }> {
    this.counter += 1;
    const id = `ctr_test_${this.counter}`;
    this.existing.add(id);
    if (input.name !== undefined) this.createdNames.push(input.name);
    return { id };
  }
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

async function tempBindingsFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sessionbox-pi-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "bindings.json");
}

function client(fake: FakeClient): SessionBoxClient {
  return fake as unknown as SessionBoxClient;
}

describe("resolveContainerId", () => {
  it("creates a container and persists the binding", async () => {
    const fake = new FakeClient();
    const file = await tempBindingsFile();

    const containerId = await resolveContainerId({
      client: client(fake),
      sessionId: "ses_1",
      bindingsFile: file,
      containerName: "pi-ses1",
      now: () => "2026-10-04T00:00:00.000Z",
    });

    expect(containerId).toBe("ctr_test_1");
    expect(fake.createdNames).toEqual(["pi-ses1"]);
    await expect(readBindings(file)).resolves.toEqual({
      ses_1: { containerId: "ctr_test_1", updatedAt: "2026-10-04T00:00:00.000Z" },
    });
  });

  it("reuses a live binding without creating another container", async () => {
    const fake = new FakeClient();
    const file = await tempBindingsFile();
    await writeBindings(file, { ses_1: { containerId: "ctr_existing", updatedAt: "x" } });
    fake.existing.add("ctr_existing");

    const containerId = await resolveContainerId({
      client: client(fake),
      sessionId: "ses_1",
      bindingsFile: file,
      containerName: "pi-ses1",
    });

    expect(containerId).toBe("ctr_existing");
    expect(fake.createdNames).toEqual([]);
  });

  it("recreates the container when the bound one disappeared", async () => {
    const fake = new FakeClient();
    const file = await tempBindingsFile();
    await writeBindings(file, { ses_1: { containerId: "ctr_gone", updatedAt: "x" } });

    const containerId = await resolveContainerId({
      client: client(fake),
      sessionId: "ses_1",
      bindingsFile: file,
      containerName: "pi-ses1",
    });

    expect(containerId).toBe("ctr_test_1");
    expect((await readBindings(file)).ses_1?.containerId).toBe("ctr_test_1");
  });

  it("honours a pinned container without touching the binding file", async () => {
    const fake = new FakeClient();
    fake.existing.add("ctr_pinned");
    const file = await tempBindingsFile();

    const containerId = await resolveContainerId({
      client: client(fake),
      sessionId: "ses_1",
      bindingsFile: file,
      containerName: "pi-ses1",
      pinnedContainerId: "ctr_pinned",
    });

    expect(containerId).toBe("ctr_pinned");
    await expect(readBindings(file)).resolves.toEqual({});
  });

  it("treats a broken binding file as empty", async () => {
    const fake = new FakeClient();
    const file = await tempBindingsFile();
    await writeFile(file, "{ not json", "utf8");

    const containerId = await resolveContainerId({
      client: client(fake),
      sessionId: "ses_1",
      bindingsFile: file,
      containerName: "pi-ses1",
    });

    expect(containerId).toBe("ctr_test_1");
    await expect(readFile(file, "utf8")).resolves.toContain("ctr_test_1");
  });
});
