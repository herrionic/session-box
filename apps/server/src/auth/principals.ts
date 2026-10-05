import { SessionBoxError } from "../errors.ts";
import { ALL_PERMISSIONS, type AuthConfig, type ClientConfig } from "./config.ts";

export interface Principal {
  id: string;
  type: "plugin" | "user";
  permissions: string[];
}

export const PERMISSIONS = {
  create: "sandbox:create",
  read: "sandbox:read",
  execute: "sandbox:execute",
  write: "sandbox:write",
  delete: "sandbox:delete",
  admin: "sandbox:admin",
} as const;

/** Resolves a bearer token to a principal; undefined when the token is unknown. */
export function authenticate(config: AuthConfig, token: string | undefined): Principal | undefined {
  if (token === undefined || token === "") return undefined;

  const client = config.clients.find((candidate) => candidate.token === token);
  if (client === undefined) return undefined;

  return toPrincipal(client);
}

function toPrincipal(client: ClientConfig): Principal {
  return { id: client.id, type: "plugin", permissions: [...client.permissions] };
}

export function hasPermission(principal: Principal, permission: string): boolean {
  return (
    principal.permissions.includes(ALL_PERMISSIONS) ||
    principal.permissions.includes(permission)
  );
}

export function requirePermission(principal: Principal | undefined, permission: string): Principal {
  if (principal === undefined) {
    throw new SessionBoxError("UNAUTHORIZED", "authentication is required");
  }
  if (!hasPermission(principal, permission)) {
    throw new SessionBoxError("FORBIDDEN", `missing permission: ${permission}`);
  }
  return principal;
}
