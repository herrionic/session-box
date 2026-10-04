/**
 * Simulated harness sessions — Day 4 acceptance test and demo tool.
 *
 * Two independent "agent sessions" each claim a sandbox, prove workspace
 * isolation, reconnect to the same sandbox and clean up.
 *
 *   pnpm --filter @sessionbox/server harness-sim --url http://host:8787 [--keep]
 */
import { SessionBoxClient } from "@sessionbox/client";

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const baseUrl = urlIndex >= 0 ? args[urlIndex + 1] : "http://127.0.0.1:8787";
const keep = args.includes("--keep");

if (baseUrl === undefined || baseUrl === "") {
  console.error("usage: harness-sim.ts --url <baseUrl> [--keep]");
  process.exit(2);
}

const client = new SessionBoxClient({ baseUrl });
const log = (message: string): void => {
  console.log(message);
};

function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    return String((error as { code: unknown }).code);
  }
  return error instanceof Error ? error.message : String(error);
}

try {
  log(`SessionBox at ${baseUrl}`);
  const health = await client.health();
  log(`health: ${health.status} (runtime=${health.runtime})`);

  const sandboxA = await client.createSandbox({
    name: "sim-session-a",
    resources: { memoryLimitMb: 256, cpuLimit: 0.5 },
  });
  const sessionA = await client.connect(sandboxA.id);
  log(`session A -> ${sandboxA.name} (${sandboxA.id})`);

  const sandboxB = await client.createSandbox({
    name: "sim-session-b",
    resources: { memoryLimitMb: 256, cpuLimit: 0.5 },
  });
  const sessionB = await client.connect(sandboxB.id);
  log(`session B -> ${sandboxB.name} (${sandboxB.id})`);

  await sessionA.writeFile("/workspace/who.txt", "AAA");
  const exec = await sessionA.exec("cat /workspace/who.txt");
  log(`A: cat /workspace/who.txt -> ${JSON.stringify(exec.stdout.trim())} (exit ${exec.exitCode})`);

  try {
    await sessionB.readFile("/workspace/who.txt");
    log("B: read succeeded — ISOLATION BROKEN");
    process.exitCode = 1;
  } catch (error) {
    log(`B: read failed as expected -> ${errorCode(error)}`);
  }

  await sessionA.close();
  const reconnected = await client.connect(sandboxA.id);
  const persisted = await reconnected.readFile("/workspace/who.txt");
  log(`A reconnect: who.txt = ${JSON.stringify(persisted.content)}`);
  await reconnected.close();
  await sessionB.close();

  const afterDisconnect = await client.getSandbox(sandboxA.id);
  log(`A after disconnect: status=${afterDisconnect.status}`);

  if (keep) {
    log(`kept sandboxes: ${sandboxA.id}, ${sandboxB.id}`);
  } else {
    await client.deleteSandbox(sandboxA.id);
    await client.deleteSandbox(sandboxB.id);
    log("sandboxes deleted");
  }
} catch (error) {
  console.error("simulated harness failed:", error);
  process.exit(1);
}
