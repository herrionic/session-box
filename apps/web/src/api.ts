import type {
  CreateContainerRequest,
  ErrorResponse,
  FileContent,
  FileEntry,
  FileListResponse,
  Container,
  UpdateContainerSettingsRequest,
} from "@sessionbox/protocol";

export class ApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

const TOKEN_STORAGE_KEY = "sessionbox.token";

export function getToken(): string | null {
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setToken(token: string | null): void {
  if (token === null || token.trim() === "") {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token === null ? {} : { authorization: `Bearer ${token}` };
}

async function parseError(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => undefined);
  const error = (body as ErrorResponse | undefined)?.error;
  return new ApiError(error?.code ?? "INTERNAL_ERROR", error?.message ?? response.statusText);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...authHeaders(),
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(path, { ...init, headers });

  if (response.status === 204) {
    return undefined as T;
  }

  if (!response.ok) {
    throw await parseError(response);
  }

  return (await response.json()) as T;
}

export const api = {
  list: (): Promise<Container[]> => request("/api/containers"),

  get: (id: string): Promise<Container> => request(`/api/containers/${id}`),

  create: (input: CreateContainerRequest): Promise<Container> =>
    request("/api/containers", { method: "POST", body: JSON.stringify(input) }),

  start: (id: string): Promise<Container> =>
    request(`/api/containers/${id}/start`, { method: "POST" }),

  stop: (id: string): Promise<Container> =>
    request(`/api/containers/${id}/stop`, { method: "POST" }),

  restart: (id: string): Promise<Container> =>
    request(`/api/containers/${id}/restart`, { method: "POST" }),

  remove: (id: string): Promise<void> => request(`/api/containers/${id}`, { method: "DELETE" }),

  updateSettings: (id: string, patch: UpdateContainerSettingsRequest): Promise<Container> =>
    request(`/api/containers/${id}/settings`, { method: "PATCH", body: JSON.stringify(patch) }),

  listFiles: (id: string, path: string): Promise<FileListResponse> =>
    request(`/api/containers/${id}/files?path=${encodeURIComponent(path)}`),

  readFile: (id: string, path: string): Promise<FileContent> =>
    request(`/api/containers/${id}/files/content?path=${encodeURIComponent(path)}`),

  writeFile: (id: string, path: string, content: string): Promise<FileContent> =>
    request(`/api/containers/${id}/files/content`, {
      method: "PUT",
      body: JSON.stringify({ path, content }),
    }),

  createFile: (id: string, path: string, type: "file" | "directory"): Promise<FileEntry> =>
    request(`/api/containers/${id}/files`, {
      method: "POST",
      body: JSON.stringify({ path, type }),
    }),

  removeFile: (id: string, path: string, recursive = false): Promise<void> =>
    request(
      `/api/containers/${id}/files?path=${encodeURIComponent(path)}${recursive ? "&recursive=true" : ""}`,
      { method: "DELETE" },
    ),

  uploadFile: async (id: string, path: string, file: File): Promise<FileEntry> => {
    const response = await fetch(
      `/api/containers/${id}/files/upload?path=${encodeURIComponent(path)}`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream", ...authHeaders() },
        body: file,
      },
    );
    if (!response.ok) throw await parseError(response);
    return (await response.json()) as FileEntry;
  },

  downloadUrl: (id: string, path: string): string =>
    `/api/containers/${id}/files/download?${buildQuery({ path })}`,

  terminalUrl: (id: string, params?: { cols?: number; rows?: number }): string =>
    `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/api/ws/terminal/${id}?${buildQuery(
      { cols: params?.cols, rows: params?.rows },
    )}`,
};

/**
 * WebSocket and download URLs cannot set headers; carry the token in the
 * query. Built with URLSearchParams so an existing query is never concatenated
 * twice.
 */
function buildQuery(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  const token = getToken();
  if (token !== null) query.set("token", token);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return query.toString();
}
