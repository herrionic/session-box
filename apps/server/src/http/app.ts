import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { ZodError } from "zod";
import { newRequestId } from "@sessionbox/shared";
import type { ServerConfig } from "../config.ts";
import { SessionBoxError, isSessionBoxError } from "../errors.ts";
import type { Logger } from "../logging.ts";
import type { SandboxRuntime } from "../runtime/types.ts";
import type { SandboxService } from "../sandbox/service.ts";
import { registerHealthRoutes } from "./routes/health.ts";
import { registerSandboxRoutes } from "./routes/sandboxes.ts";
import type { SessionBoxApp } from "./types.ts";

export interface AppDependencies {
  config: ServerConfig;
  logger: Logger;
  runtime: SandboxRuntime;
  service: SandboxService;
}

export async function buildApp(deps: AppDependencies): Promise<SessionBoxApp> {
  const app = Fastify({
    loggerInstance: deps.logger,
    genReqId: () => newRequestId(),
  });

  registerHealthRoutes(app, { config: deps.config, runtime: deps.runtime });
  registerSandboxRoutes(app, { service: deps.service });

  let servesWeb = false;
  if (deps.config.webDist !== undefined && existsSync(deps.config.webDist)) {
    await app.register(fastifyStatic, { root: resolve(deps.config.webDist) });
    servesWeb = true;
  }

  app.setErrorHandler((error, request, reply) => {
    if (isSessionBoxError(error)) {
      reply.status(error.statusCode).send(error.toResponse(request.id));
      return;
    }

    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      }));
      reply
        .status(400)
        .send(
          new SessionBoxError("INVALID_REQUEST", "request validation failed", {
            details,
          }).toResponse(request.id),
        );
      return;
    }

    // Fastify framework errors (malformed JSON, unsupported media type, ...)
    // are client errors; never surface them as internal server errors.
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
      reply
        .status(statusCode)
        .send(
          new SessionBoxError("INVALID_REQUEST", "invalid request", {
            details: { reason: (error as { message?: string }).message },
          }).toResponse(request.id),
        );
      return;
    }

    // Unknown failures: details stay in the server log, never in the response.
    request.log.error({ event: "http.unhandled_error", err: error }, "unhandled request error");
    reply
      .status(500)
      .send(new SessionBoxError("INTERNAL_ERROR", "internal server error").toResponse(request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    if (servesWeb && !request.url.startsWith("/api/")) {
      reply.sendFile("index.html");
      return;
    }
    reply
      .status(404)
      .send(new SessionBoxError("NOT_FOUND", "route not found").toResponse(request.id));
  });

  return app;
}
