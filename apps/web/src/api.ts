import type {
  Container,
  CreateContainerRequest,
  CreateNetworkRequest,
  ErrorResponse,
  FileContent,
  FileEntry,
  FileListResponse,
  Network,
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

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
}

export interface ApiTokenEntry {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
}

async function parseError(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => undefined);
  const error = (body as ErrorResponse | undefined)?.error;
  return new ApiError(error?.code ?? "INTERNAL_ERROR", error?.message ?? response.statusText);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });

  if (response.status === 204) {
    return undefined as T;
  }

  if (!response.ok) {
    throw await parseError(response);
  }

  return (await response.json()) as T;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return query.toString();
}

export const api = {
  // ---- containers -------------------------------------------------------
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

  // ---- networks ---------------------------------------------------------
  listNetworks: (): Promise<Network[]> => request("/api/networks"),

  createNetwork: (name: string): Promise<Network> =>
    request("/api/networks", {
      method: "POST",
      body: JSON.stringify({ name } satisfies CreateNetworkRequest),
    }),

  deleteNetwork: (name: string): Promise<void> =>
    request(`/api/networks/${encodeURIComponent(name)}`, { method: "DELETE" }),

  attachNetwork: (id: string, network: string): Promise<Container> =>
    request(`/api/containers/${id}/networks/${encodeURIComponent(network)}`, { method: "POST" }),

  detachNetwork: (id: string, network: string): Promise<Container> =>
    request(`/api/containers/${id}/networks/${encodeURIComponent(network)}`, { method: "DELETE" }),

  // ---- files ------------------------------------------------------------
  listFiles: (id: string, path: string): Promise<FileListResponse> =>
    request(`/api/containers/${id}/files?${buildQuery({ path })}`),

  readFile: (id: string, path: string): Promise<FileContent> =>
    request(`/api/containers/${id}/files/content?${buildQuery({ path })}`),

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
    request(`/api/containers/${id}/files?${buildQuery({ path, recursive: recursive ? "true" : undefined })}`, {
      method: "DELETE",
    }),

  uploadFile: async (id: string, path: string, file: File): Promise<FileEntry> => {
    const response = await fetch(`/api/containers/${id}/files/upload?${buildQuery({ path })}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      credentials: "same-origin",
      body: file,
    });
    if (!response.ok) throw await parseError(response);
    return (await response.json()) as FileEntry;
  },

  downloadUrl: (id: string, path: string): string =>
    `/api/containers/${id}/files/download?${buildQuery({ path })}`,

  terminalUrl: (id: string, params?: { cols?: number; rows?: number }): string =>
    `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/api/ws/terminal/${id}?${buildQuery(
      { cols: params?.cols, rows: params?.rows },
    )}`,

  // ---- setup (first run) ------------------------------------------------
  setupStatus: (): Promise<{ needsSetup: boolean }> => request("/api/setup/status"),

  completeSetup: (input: {
    username: string;
    displayName?: string;
    password: string;
  }): Promise<{ user: SessionUser }> =>
    request("/api/setup", { method: "POST", body: JSON.stringify(input) }),

  // ---- auth (single owner) ---------------------------------------------
  login: (username: string, password: string): Promise<{ user: SessionUser }> =>
    request("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),

  logout: (): Promise<void> => request("/api/auth/logout", { method: "POST" }),

  me: (): Promise<{ user: SessionUser }> => request("/api/auth/me"),

  updateProfile: (displayName: string): Promise<{ user: SessionUser }> =>
    request("/api/auth/me", { method: "PATCH", body: JSON.stringify({ displayName }) }),

  changePassword: (currentPassword: string, newPassword: string): Promise<{ changed: boolean }> =>
    request("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  listTokens: (): Promise<{ tokens: ApiTokenEntry[] }> => request("/api/auth/tokens"),

  createToken: (name: string): Promise<{ token: string; entry: ApiTokenEntry }> =>
    request("/api/auth/tokens", { method: "POST", body: JSON.stringify({ name }) }),

  revokeToken: (id: string): Promise<void> =>
    request(`/api/auth/tokens/${id}`, { method: "DELETE" }),
};
