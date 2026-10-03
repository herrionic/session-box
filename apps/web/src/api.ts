import type {
  CreateSandboxRequest,
  ErrorResponse,
  FileContent,
  FileEntry,
  FileListResponse,
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

async function parseError(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => undefined);
  const error = (body as ErrorResponse | undefined)?.error;
  return new ApiError(error?.code ?? "INTERNAL_ERROR", error?.message ?? response.statusText);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

  if (response.status === 204) {
    return undefined as T;
  }

  if (!response.ok) {
    throw await parseError(response);
  }

  return (await response.json()) as T;
}

export const api = {
  list: (): Promise<Sandbox[]> => request("/api/sandboxes"),

  get: (id: string): Promise<Sandbox> => request(`/api/sandboxes/${id}`),

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

  listFiles: (id: string, path: string): Promise<FileListResponse> =>
    request(`/api/sandboxes/${id}/files?path=${encodeURIComponent(path)}`),

  readFile: (id: string, path: string): Promise<FileContent> =>
    request(`/api/sandboxes/${id}/files/content?path=${encodeURIComponent(path)}`),

  writeFile: (id: string, path: string, content: string): Promise<FileContent> =>
    request(`/api/sandboxes/${id}/files/content`, {
      method: "PUT",
      body: JSON.stringify({ path, content }),
    }),

  createFile: (id: string, path: string, type: "file" | "directory"): Promise<FileEntry> =>
    request(`/api/sandboxes/${id}/files`, {
      method: "POST",
      body: JSON.stringify({ path, type }),
    }),

  removeFile: (id: string, path: string, recursive = false): Promise<void> =>
    request(
      `/api/sandboxes/${id}/files?path=${encodeURIComponent(path)}${recursive ? "&recursive=true" : ""}`,
      { method: "DELETE" },
    ),

  uploadFile: async (id: string, path: string, file: File): Promise<FileEntry> => {
    const response = await fetch(
      `/api/sandboxes/${id}/files/upload?path=${encodeURIComponent(path)}`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: file,
      },
    );
    if (!response.ok) throw await parseError(response);
    return (await response.json()) as FileEntry;
  },

  downloadUrl: (id: string, path: string): string =>
    `/api/sandboxes/${id}/files/download?path=${encodeURIComponent(path)}`,

  terminalUrl: (id: string): string =>
    `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/api/ws/terminal/${id}`,
};
