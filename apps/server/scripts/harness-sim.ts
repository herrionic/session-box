/**
 * Simulated harness sessions — Day 4 acceptance test and demo tool.
 *
 * Two independent "agent sessions" each claim a container, prove workspace
 * isolation, reconnect to the same container and clean up.
 *
 *   pnpm --filter @sessionbox/server harness-sim --url http://host:8787 [--token <token>] [--keep]
 */
import { SessionBoxClient } from "@sessionbox/client";

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const baseUrl = urlIndex >= 0 ? args[urlIndex + 1] : "http://127.0.0.1:8787";
const keep = args.includes("--keep");
const tokenIndex = args.indexOf("--token");
const token = tokenIndex >= 0 ? args[tokenIndex + 1] : process.env.SESSIONBOX_TOKEN;

if (baseUrl === undefined || baseUrl === "") {
  console.error("usage: harness-sim.ts --url <baseUrl> [--token <token>] [--keep]");
  process.exit(2);
}

const client = new SessionBoxClient({
  baseUrl,
  ...(token !== undefined && token !== "" ? { token } : {}),
});
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

  const containerA = await client.createContainer({
    name: "sim-session-a",
    resources: { memoryLimitMb: 256, cpuLimit: 0.5 },
  });
  const sessionA = await client.connect(containerA.id);
  log(`session A -> ${containerA.name} (${containerA.id})`);

  const containerB = await client.createContainer({
    name: "sim-session-b",
    resources: { memoryLimitMb: 256, cpuLimit: 0.5 },
  });
  const sessionB = await client.connect(containerB.id);
  log(`session B -> ${containerB.name} (${containerB.id})`);

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
  const reconnected = await client.connect(containerA.id);
  const persisted = await reconnected.readFile("/workspace/who.txt");
  log(`A reconnect: who.txt = ${JSON.stringify(persisted.content)}`);
  await reconnected.close();
  await sessionB.close();

  const afterDisconnect = await client.getContainer(containerA.id);
  log(`A after disconnect: status=${afterDisconnect.status}`);

  if (keep) {
    log(`kept containers: ${containerA.id}, ${containerB.id}`);
  } else {
    await client.deleteContainer(containerA.id);
    await client.deleteContainer(containerB.id);
    log("containers deleted");
  }
} catch (error) {
  console.error("simulated harness failed:", error);
  process.exit(1);
}
