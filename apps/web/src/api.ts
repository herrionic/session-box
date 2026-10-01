import type {
  CreateSandboxRequest,
  ErrorResponse,
  Sandbox,
  UpdateSandboxSettingsRequest,
} from "@sessionbox/protocol";

export class ApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const body: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const error = (body as ErrorResponse | undefined)?.error;
    throw new ApiError(error?.code ?? "INTERNAL_ERROR", error?.message ?? response.statusText);
  }

  return body as T;
}

export const api = {
  list: (): Promise<Sandbox[]> => request("/api/sandboxes"),

  create: (input: CreateSandboxRequest): Promise<Sandbox> =>
    request("/api/sandboxes", { method: "POST", body: JSON.stringify(input) }),

  start: (id: string): Promise<Sandbox> =>
    request(`/api/sandboxes/${id}/start`, { method: "POST" }),

  stop: (id: string): Promise<Sandbox> =>
    request(`/api/sandboxes/${id}/stop`, { method: "POST" }),

  restart: (id: string): Promise<Sandbox> =>
    request(`/api/sandboxes/${id}/restart`, { method: "POST" }),

  remove: (id: string): Promise<void> => request(`/api/sandboxes/${id}`, { method: "DELETE" }),

  updateSettings: (id: string, patch: UpdateSandboxSettingsRequest): Promise<Sandbox> =>
    request(`/api/sandboxes/${id}/settings`, { method: "PATCH", body: JSON.stringify(patch) }),
};
