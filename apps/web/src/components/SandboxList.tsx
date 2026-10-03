import { useCallback, useEffect, useState, type FormEvent, type JSX } from "react";
import type { Sandbox } from "@sessionbox/protocol";
import { ApiError, api } from "../api.ts";

export function SandboxList(): JSX.Element {
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setSandboxes(await api.list());
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

  const onDelete = async (sandbox: Sandbox): Promise<void> => {
    if (!window.confirm(`Delete sandbox "${sandbox.name}"? This cannot be undone.`)) return;
    await run(sandbox.id, () => api.remove(sandbox.id));
  };

  const openSandbox = (id: string): void => {
    window.location.hash = `#/sandboxes/${id}`;
  };

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>SessionBox</h1>
          <p className="subtitle">
            Sandboxes bound to agent sessions — managed here, executed in isolation.
          </p>
        </div>
        <button type="button" className="secondary" onClick={() => void refresh()}>
          Refresh
        </button>
      </header>

      <section className="card">
        <h2>Create sandbox</h2>
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
          Sandboxes <span className="count">{sandboxes.length}</span>
        </h2>
        {sandboxes.length === 0 ? (
          <p className="empty">
            No sandboxes yet. Create one above, or let an agent session claim one.
          </p>
        ) : (
          <table className="sandbox-table">
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
              {sandboxes.map((sandbox) => {
                const busy = busyId === sandbox.id;
                return (
                  <tr key={sandbox.id}>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => openSandbox(sandbox.id)}
                      >
                        {sandbox.name}
                      </button>
                      <div className="id" title={sandbox.id}>
                        {sandbox.id}
                      </div>
                    </td>
                    <td className="mono">{sandbox.image}</td>
                    <td>
                      <span className={`status status-${sandbox.status}`}>{sandbox.status}</span>
                    </td>
                    <td>{formatResources(sandbox)}</td>
                    <td>{formatDate(sandbox.createdAt)}</td>
                    <td>{formatDate(sandbox.lastActivityAt)}</td>
                    <td className="actions">
                      <button type="button" className="secondary" onClick={() => openSandbox(sandbox.id)}>
                        Open
                      </button>
                      {sandbox.status === "stopped" || sandbox.status === "failed" ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void run(sandbox.id, () => api.start(sandbox.id))}
                        >
                          Start
                        </button>
                      ) : null}
                      {sandbox.status === "running" ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void run(sandbox.id, () => api.stop(sandbox.id))}
                        >
                          Stop
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="danger"
                        disabled={busy || sandbox.status === "deleting"}
                        onClick={() => void onDelete(sandbox)}
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

function formatResources(sandbox: Sandbox): string {
  const parts: string[] = [];
  if (sandbox.resources.cpuLimit !== undefined) parts.push(`${sandbox.resources.cpuLimit} CPU`);
  if (sandbox.resources.memoryLimitMb !== undefined) {
    parts.push(`${sandbox.resources.memoryLimitMb} MB`);
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
