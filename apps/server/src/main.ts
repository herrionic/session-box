import { AgentGateway } from "./agent/gateway.ts";
import { loadConfig } from "./config.ts";
import { parseMasterKey } from "./credentials/master-key.ts";
import { EncryptedCredentialStore } from "./credentials/store.ts";
import { ContainerFilesService } from "./files/service.ts";
import { buildApp } from "./http/app.ts";
import { LifecycleService } from "./lifecycle/service.ts";
import { createLogger } from "./logging.ts";
import { createRuntime } from "./runtime/index.ts";
import { ContainerService } from "./container/service.ts";
import { SshSessionManager } from "./ssh/manager.ts";
import { Ssh2SessionFactory } from "./ssh/ssh2-session.ts";
import { openDatabase } from "./storage/database.ts";
import { SqliteContainerRepository } from "./storage/container-repository.ts";
import { SqliteSecretRepository } from "./storage/secret-repository.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  if (config.auth.clients.length === 0) {
    logger.warn(
      { event: "server.auth.disabled" },
      "SESSIONBOX_CLIENTS is not configured; the API is unauthenticated",
    );
  }

  const masterKey = parseMasterKey(config.masterKey);
  if (masterKey === undefined) {
    logger.warn(
      { event: "server.master_key.missing" },
      "SESSIONBOX_MASTER_KEY is not configured; container creation will fail until it is set",
    );
  }

  const database = openDatabase(config.databaseFile);
  const repository = new SqliteContainerRepository(database);
  const secrets = new SqliteSecretRepository(database);
  const credentials = new EncryptedCredentialStore(masterKey, secrets);

  const runtime = createRuntime(config, logger);
  const ssh = new Ssh2SessionFactory({ runtime, credentials, logger });
  const sessions = new SshSessionManager(ssh, logger);
  const service = new ContainerService({
    runtime,
    repository,
    credentials,
    ssh,
    sessions,
    logger,
    baseImage: config.docker.baseImage,
    workspace: config.docker.workspace,
  });
  const files = new ContainerFilesService({
    containers: service,
    workspace: config.docker.workspace,
    logger,
  });
  const gateway = new AgentGateway(service, logger);

  const app = await buildApp({ config, logger, runtime, service, files, gateway });

  try {
    await service.reconcile();
  } catch (error) {
    logger.warn(
      {
        event: "container.reconcile.skipped",
        err: error instanceof Error ? error.message : String(error),
      },
      "container runtime not reachable at startup; continuing without reconciliation",
    );
  }

  const lifecycle = new LifecycleService({
    containers: service,
    logger,
    intervalMs: config.lifecycle.intervalMs,
  });
  lifecycle.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ event: "server.shutdown", signal }, "shutting down");
    try {
      lifecycle.stop();
      await service.close();
      await app.close();
      database.close();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  logger.info(
    { event: "server.started", host: config.host, port: config.port, database: config.databaseFile },
    "sessionbox server listening",
  );
}

await main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
