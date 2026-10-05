import type { FastifyRequest } from "fastify";
import { ALL_PERMISSIONS, type AuthConfig } from "../auth/config.ts";
import { readSessionCookie } from "../auth/cookies.ts";
import { authenticate, type Principal } from "../auth/principals.ts";
import type { AuthService } from "../auth/service.ts";
import { SessionBoxError } from "../errors.ts";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface AuthHookOptions {
  config: AuthConfig;
  /** Present when the single-owner user system is wired up. */
  auth?: AuthService;
}

const PUBLIC_PATHS = ["/api/health", "/api/auth/login", "/api/auth/logout"];

/**
 * Authentication for the whole API except the public paths. Resolution order:
 * session cookie (web UI) → static `SESSIONBOX_CLIENTS` token (env-based
 * plugins) → API token from the database (`sbt_…`). Browser WebSocket and
 * download URLs cannot set headers, so `?token=` is accepted and stripped
 * before route schemas run; the logger redacts it.
 *
 * Without an owner account and without configured clients the API stays open
 * (development default) and every request carries an anonymous principal.
 */
export function createAuthHook(options: AuthHookOptions): (request: FastifyRequest) => Promise<void> {
  const { config, auth } = options;
  const enforced = config.clients.length > 0 || (auth?.enforced ?? false);

  return async function authHook(request: FastifyRequest): Promise<void> {
    // `?token=` is a transport detail for WebSocket and download URLs; remove
    // it before strict route schemas parse the query.
    if (request.query !== null && typeof request.query === "object") {
      delete (request.query as Record<string, unknown>).token;
    }

    if (isPublicPath(request.url)) return;

    if (!enforced) {
      request.principal = { id: "anonymous", type: "user", permissions: [ALL_PERMISSIONS] };
      return;
    }

    const sessionId = readSessionCookie(request.headers.cookie);
    if (sessionId !== undefined && auth !== undefined) {
      const sessionPrincipal = await auth.resolveSession(sessionId);
      if (sessionPrincipal !== undefined) {
        request.principal = sessionPrincipal;
        return;
      }
    }

    const token = extractToken(request);
    const staticPrincipal = authenticate(config, token);
    if (staticPrincipal !== undefined) {
      request.principal = staticPrincipal;
      return;
    }

    if (token !== undefined && auth !== undefined) {
      const tokenPrincipal = await auth.authenticateToken(token);
      if (tokenPrincipal !== undefined) {
        request.principal = tokenPrincipal;
        return;
      }
    }

    throw new SessionBoxError("UNAUTHORIZED", "a valid session or bearer token is required");
  };
}

function isPublicPath(url: string): boolean {
  return PUBLIC_PATHS.some((path) => url === path || url.startsWith(`${path}?`));
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
