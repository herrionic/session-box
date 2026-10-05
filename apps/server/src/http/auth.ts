import type { FastifyRequest } from "fastify";
import { ALL_PERMISSIONS, type AuthConfig } from "../auth/config.ts";
import { authenticate, type Principal } from "../auth/principals.ts";
import { SessionBoxError } from "../errors.ts";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/**
 * Bearer authentication for the whole API except the health probe. Browser
 * WebSocket clients cannot set headers, so `?token=` is accepted there; the
 * logger redacts it. Without configured clients the API is open and every
 * request carries an anonymous principal with full permissions (development
 * default, warned about at startup).
 */
export function createAuthHook(config: AuthConfig): (request: FastifyRequest) => Promise<void> {
  const enabled = config.clients.length > 0;

  return async function authHook(request: FastifyRequest): Promise<void> {
    if (!enabled) {
      request.principal = { id: "anonymous", type: "user", permissions: [ALL_PERMISSIONS] };
      return;
    }

    if (request.url === "/api/health" || request.url.startsWith("/api/health?")) return;

    const principal = authenticate(config, extractToken(request));
    if (principal === undefined) {
      throw new SessionBoxError("UNAUTHORIZED", "a valid bearer token is required");
    }

    request.principal = principal;
  };
}

export function extractToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    const value = header.slice("bearer ".length).trim();
    if (value !== "") return value;
  }

  const queryStart = request.url.indexOf("?");
  if (queryStart === -1) return undefined;

  const params = new URLSearchParams(request.url.slice(queryStart + 1));
  const token = params.get("token");
  return token !== null && token !== "" ? token : undefined;
}
