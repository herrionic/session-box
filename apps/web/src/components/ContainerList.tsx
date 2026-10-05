import { useCallback, useEffect, useState, type FormEvent, type JSX } from "react";
import type { Container } from "@sessionbox/protocol";
import { ApiError, api, getToken, setToken } from "../api.ts";

export function ContainerList(): JSX.Element {
  const [containers, setContainers] = useState<Container[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setContainers(await api.list());
    } catch (caught) {
      setError(describeError(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const run = async (id: string, action: () => Promise<unknown>): Promise<void> => {
    setBusyId(id);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusyId(null);
    }
  };

  const onCreate = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.create({
        ...(name.trim() !== "" ? { name: name.trim() } : {}),
        ...(image.trim() !== "" ? { image: image.trim() } : {}),
      });
      setName("");
      setImage("");
      await refresh();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setCreating(false);
    }
  };

  const onDelete = async (container: Container): Promise<void> => {
    if (!window.confirm(`Delete container "${container.name}"? This cannot be undone.`)) return;
    await run(container.id, () => api.remove(container.id));
  };

  const openContainer = (id: string): void => {
    window.location.hash = `#/containers/${id}`;
  };

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>SessionBox</h1>
          <p className="subtitle">
            Containers bound to agent sessions — managed here, executed in isolation.
          </p>
        </div>
        <div className="header-actions">
          <input
            type="password"
            className="token-input"
            placeholder="API token (if required)"
            defaultValue={getToken() ?? ""}
            onChange={(event) => setToken(event.target.value)}
          />
          <button type="button" className="secondary" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      </header>

      <section className="card">
        <h2>Create container</h2>
        <form className="create-form" onSubmit={(event) => void onCreate(event)}>
          <input
            type="text"
            placeholder="name (optional, e.g. agent-workspace)"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <input
            type="text"
            placeholder="image (optional, defaults to sessionbox/base)"
            value={image}
            onChange={(event) => setImage(event.target.value)}
          />
          <button type="submit" disabled={creating}>
            {creating ? "Creating…" : "Create"}
          </button>
        </form>
      </section>

      {error !== null && (
        <div className="alert" role="alert">
          {error}
          <button type="button" className="link" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      <section className="card">
        <h2>
          Containers <span className="count">{containers.length}</span>
        </h2>
        {containers.length === 0 ? (
          <p className="empty">
            No containers yet. Create one above, or let an agent session claim one.
          </p>
        ) : (
          <table className="container-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Image</th>
                <th>Status</th>
                <th>Resources</th>
                <th>Created</th>
                <th>Last activity</th>
                <th className="actions-header">Actions</th>
              </tr>
            </thead>
            <tbody>
              {containers.map((container) => {
                const busy = busyId === container.id;
                return (
                  <tr key={container.id}>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => openContainer(container.id)}
                      >
                        {container.name}
                      </button>
                      <div className="id" title={container.id}>
                        {container.id}
                      </div>
                    </td>
                    <td className="mono">{container.image}</td>
                    <td>
                      <span className={`status status-${container.status}`}>{container.status}</span>
                    </td>
                    <td>{formatResources(container)}</td>
                    <td>{formatDate(container.createdAt)}</td>
                    <td>{formatDate(container.lastActivityAt)}</td>
                    <td className="actions">
                      <button type="button" className="secondary" onClick={() => openContainer(container.id)}>
                        Open
                      </button>
                      {container.status === "stopped" || container.status === "failed" ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void run(container.id, () => api.start(container.id))}
                        >
                          Start
                        </button>
                      ) : null}
                      {container.status === "running" ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void run(container.id, () => api.stop(container.id))}
                        >
                          Stop
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="danger"
                        disabled={busy || container.status === "deleting"}
                        onClick={() => void onDelete(container)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <footer className="footer">MVP — Docker runtime · terminal and file manager built in.</footer>
    </div>
  );
}

function formatResources(container: Container): string {
  const parts: string[] = [];
  if (container.resources.cpuLimit !== undefined) parts.push(`${container.resources.cpuLimit} CPU`);
  if (container.resources.memoryLimitMb !== undefined) {
    parts.push(`${container.resources.memoryLimitMb} MB`);
  }
  return parts.length > 0 ? parts.join(" · ") : "defaults";
}

function formatDate(value: string | undefined): string {
  if (value === undefined) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

export function describeError(caught: unknown): string {
  if (caught instanceof ApiError) return `${caught.message} (${caught.code})`;
  if (caught instanceof Error) return caught.message;
  return String(caught);
}
