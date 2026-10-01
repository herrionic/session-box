import { loadConfig } from "./config.ts";
import { buildApp } from "./http/app.ts";
import { createLogger } from "./logging.ts";
import { createRuntime } from "./runtime/index.ts";
import { InMemorySandboxRepository } from "./sandbox/repository.ts";
import { SandboxService } from "./sandbox/service.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const runtime = createRuntime(config, logger);
  const repository = new InMemorySandboxRepository();
  const service = new SandboxService({
    runtime,
    repository,
    logger,
    baseImage: config.docker.baseImage,
    workspace: config.docker.workspace,
  });

  const app = await buildApp({ config, logger, runtime, service });

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
