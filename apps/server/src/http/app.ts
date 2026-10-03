import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { ZodError } from "zod";
import { newRequestId } from "@sessionbox/shared";
import type { ServerConfig } from "../config.ts";
import { SessionBoxError, isSessionBoxError } from "../errors.ts";
import type { SandboxFilesService } from "../files/service.ts";
import type { Logger } from "../logging.ts";
import type { SandboxRuntime } from "../runtime/types.ts";
import type { SandboxService } from "../sandbox/service.ts";
import { registerFileRoutes } from "./routes/files.ts";
import { registerHealthRoutes } from "./routes/health.ts";
import { registerSandboxRoutes } from "./routes/sandboxes.ts";
import { registerTerminalRoutes } from "./routes/terminal.ts";
import type { SessionBoxApp } from "./types.ts";

export interface AppDependencies {
  config: ServerConfig;
  logger: Logger;
  runtime: SandboxRuntime;
  service: SandboxService;
  files: SandboxFilesService;
}

export async function buildApp(deps: AppDependencies): Promise<SessionBoxApp> {
  const app = Fastify({
    loggerInstance: deps.logger,
    genReqId: () => newRequestId(),
  });

  const webDist = deps.config.webDist;
  const servesWeb = webDist !== undefined && existsSync(webDist);

  // Error and not-found handlers are registered before any plugin. Registering
  // a plugin (static, websocket) first makes Fastify fall back to its default
  // error envelopes for routes registered on the root context.
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

  // WebSocket support must be registered before the websocket routes.
  await app.register(websocket);

  registerHealthRoutes(app, { config: deps.config, runtime: deps.runtime });
  registerSandboxRoutes(app, { service: deps.service });
  registerFileRoutes(app, { files: deps.files });
  registerTerminalRoutes(app, { service: deps.service });

  // Uploads arrive as raw bytes; everything else stays JSON.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  if (servesWeb && webDist !== undefined) {
    await app.register(fastifyStatic, { root: resolve(webDist) });
  }

  return app;
}
