import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";

type HttpServer = Server<typeof IncomingMessage, typeof ServerResponse>;

/**
 * The concrete Fastify instance type used by SessionBox: the server is always
 * built with an explicit pino logger instance, so the logger type parameter
 * must match everywhere.
 */
export type SessionBoxApp = FastifyInstance<
  HttpServer,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger
>;
