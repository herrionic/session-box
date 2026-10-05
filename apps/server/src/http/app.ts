import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { ZodError } from "zod";
import { newRequestId } from "@sessionbox/shared";
import type { AgentGateway } from "../agent/gateway.ts";
import type { AuthService } from "../auth/service.ts";
import type { ServerConfig } from "../config.ts";
import { SessionBoxError, isSessionBoxError } from "../errors.ts";
import type { ContainerFilesService } from "../files/service.ts";
import type { Logger } from "../logging.ts";
import type { ContainerRuntime } from "../runtime/types.ts";
import type { ContainerService } from "../container/service.ts";
import { createAuthHook } from "./auth.ts";
import { registerAgentRoutes } from "./routes/agent.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerFileRoutes } from "./routes/files.ts";
import { registerHealthRoutes } from "./routes/health.ts";
import { registerContainerRoutes } from "./routes/containers.ts";
import { registerTerminalRoutes } from "./routes/terminal.ts";
import type { SessionBoxApp } from "./types.ts";

export interface AppDependencies {
  config: ServerConfig;
  logger: Logger;
  runtime: ContainerRuntime;
  service: ContainerService;
  files: ContainerFilesService;
  gateway: AgentGateway;
  /** Single-owner user system; absent in tests that only exercise the API. */
  auth?: AuthService;
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

  // Authentication runs before every route (health and login stay open).
  app.addHook(
    "onRequest",
    createAuthHook({
      config: deps.config.auth,
      ...(deps.auth !== undefined ? { auth: deps.auth } : {}),
    }),
  );

  registerHealthRoutes(app, { config: deps.config, runtime: deps.runtime });
  if (deps.auth !== undefined) {
    registerAuthRoutes(app, { auth: deps.auth });
  }
  registerContainerRoutes(app, { service: deps.service });
  registerFileRoutes(app, { files: deps.files });
  registerTerminalRoutes(app, { service: deps.service });
  registerAgentRoutes(app, { gateway: deps.gateway, service: deps.service });

  // JSON bodies may legitimately be absent on body-less POSTs (start/stop);
  // treat an empty body as undefined instead of failing the parse.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    const text = (typeof body === "string" ? body : body.toString("utf8")).trim();
    if (text === "") {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch {
      done(
        new SessionBoxError("INVALID_REQUEST", "invalid request", {
          details: { reason: "body is not valid JSON" },
        }),
      );
    }
  });

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
