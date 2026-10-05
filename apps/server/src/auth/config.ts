export interface ClientConfig {
  id: string;
  token: string;
  permissions: string[];
}

export interface AuthConfig {
  clients: ClientConfig[];
}

export const ALL_PERMISSIONS = "*";

/**
 * Parses `SESSIONBOX_CLIENTS` — a JSON array of
 * `{ "id": "dsh", "token": "...", "permissions": ["sandbox:create", ...] }`.
 * An empty configuration disables authentication (development default) and is
 * reported loudly at startup.
 */
export function loadAuthConfig(raw: string | undefined): AuthConfig {
  const value = raw?.trim();
  if (value === undefined || value === "") {
    return { clients: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`SESSIONBOX_CLIENTS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("SESSIONBOX_CLIENTS must be a JSON array");
  }

  return { clients: parsed.map((entry, index) => parseClient(entry, index)) };
}

function parseClient(entry: unknown, index: number): ClientConfig {
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`SESSIONBOX_CLIENTS[${index}] must be an object`);
  }

  const candidate = entry as { id?: unknown; token?: unknown; permissions?: unknown };
  if (typeof candidate.id !== "string" || candidate.id === "") {
    throw new Error(`SESSIONBOX_CLIENTS[${index}].id must be a non-empty string`);
  }
  if (typeof candidate.token !== "string" || candidate.token === "") {
    throw new Error(`SESSIONBOX_CLIENTS[${index}].token must be a non-empty string`);
  }

  const permissions = candidate.permissions;
  if (permissions !== undefined && !Array.isArray(permissions)) {
    throw new Error(`SESSIONBOX_CLIENTS[${index}].permissions must be an array of strings`);
  }

  return {
    id: candidate.id,
    token: candidate.token,
    permissions: (permissions ?? [ALL_PERMISSIONS]).map((permission) => {
      if (typeof permission !== "string" || permission === "") {
        throw new Error(`SESSIONBOX_CLIENTS[${index}].permissions must contain non-empty strings`);
      }
      return permission;
    }),
  };
}
