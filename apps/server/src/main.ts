import { loadConfig } from "./config.ts";
import { parseMasterKey } from "./credentials/master-key.ts";
import { InMemoryCredentialStore } from "./credentials/store.ts";
import { SandboxFilesService } from "./files/service.ts";
import { buildApp } from "./http/app.ts";
import { createLogger } from "./logging.ts";
import { createRuntime } from "./runtime/index.ts";
import { InMemorySandboxRepository } from "./sandbox/repository.ts";
import { SandboxService } from "./sandbox/service.ts";
import { SshSessionManager } from "./ssh/manager.ts";
import { Ssh2SessionFactory } from "./ssh/ssh2-session.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const masterKey = parseMasterKey(config.masterKey);
  if (masterKey === undefined) {
    logger.warn(
      { event: "server.master_key.missing" },
      "SESSIONBOX_MASTER_KEY is not configured; sandbox creation will fail until it is set",
    );
  }

  const runtime = createRuntime(config, logger);
  const repository = new InMemorySandboxRepository();
  const credentials = new InMemoryCredentialStore(masterKey);
  const ssh = new Ssh2SessionFactory({ runtime, credentials, logger });
  const sessions = new SshSessionManager(ssh, logger);
  const service = new SandboxService({
    runtime,
    repository,
    credentials,
    ssh,
    sessions,
    logger,
    baseImage: config.docker.baseImage,
    workspace: config.docker.workspace,
  });
  const files = new SandboxFilesService({
    sandboxes: service,
    workspace: config.docker.workspace,
    logger,
  });

  const app = await buildApp({ config, logger, runtime, service, files });

  try {
    await service.reconcile();
  } catch (error) {
    logger.warn(
      {
        event: "sandbox.reconcile.skipped",
        err: error instanceof Error ? error.message : String(error),
      },
      "container runtime not reachable at startup; continuing without reconciliation",
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ event: "server.shutdown", signal }, "shutting down");
    try {
      await service.close();
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  logger.info({ event: "server.started", host: config.host, port: config.port }, "sessionbox server listening");
}

await main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
