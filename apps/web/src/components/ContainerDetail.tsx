import { useCallback, useEffect, useState, type JSX } from "react";
import type { Container, UpdateContainerSettingsRequest } from "@sessionbox/protocol";
import { api } from "../api.ts";
import { FileBrowser } from "./FileBrowser.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { describeError } from "./ContainerList.tsx";

type Tab = "overview" | "files" | "terminal";

export function ContainerDetail({
  containerId,
  onBack,
}: {
  containerId: string;
  onBack: () => void;
}): JSX.Element {
  const [container, setContainer] = useState<Container | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setContainer(await api.get(containerId));
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [containerId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  if (container === null) {
    return (
      <div className="page">
        <button type="button" className="link-button" onClick={onBack}>
          ← All containers
        </button>
        {error !== null ? <div className="alert">{error}</div> : <p className="empty">Loading…</p>}
      </div>
    );
  }

  const onDelete = (): void => {
    if (!window.confirm(`Delete container "${container.name}"? This cannot be undone.`)) return;
    void run(async () => {
      await api.remove(container.id);
      onBack();
    });
  };

  return (
    <div className="page">
      <header className="header">
        <div>
          <button type="button" className="link-button" onClick={onBack}>
            ← All containers
          </button>
          <h1>{container.name}</h1>
          <p className="subtitle">
            <span className={`status status-${container.status}`}>{container.status}</span>{" "}
            <span className="mono">{container.id}</span>
          </p>
        </div>
        <div className="actions">
          {container.status === "stopped" || container.status === "failed" ? (
            <button type="button" disabled={busy} onClick={() => void run(() => api.start(container.id))}>
              Start
            </button>
          ) : null}
          {container.status === "running" ? (
            <button type="button" disabled={busy} onClick={() => void run(() => api.stop(container.id))}>
              Stop
            </button>
          ) : null}
          {container.status === "running" || container.status === "stopped" ? (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void run(() => api.restart(container.id))}
            >
              Restart
            </button>
          ) : null}
          <button type="button" className="danger" disabled={busy} onClick={onDelete}>
            Delete
          </button>
        </div>
      </header>

      {error !== null && (
        <div className="alert" role="alert">
          {error}
          <button type="button" className="link" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      <nav className="tabs">
        {(["overview", "files", "terminal"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={tab === value ? "tab active" : "tab"}
            onClick={() => setTab(value)}
          >
            {value}
          </button>
        ))}
      </nav>

      {tab === "overview" ? (
        <Overview
          container={container}
          busy={busy}
          onSave={(patch) => void run(() => api.updateSettings(container.id, patch))}
        />
      ) : null}

      {tab === "files" ? (
        container.status === "running" ? (
          <FileBrowser containerId={container.id} />
        ) : (
          <section className="card">
            <p className="empty">Start the container to browse its files.</p>
          </section>
        )
      ) : null}

      {tab === "terminal" ? (
        container.status === "running" ? (
          <TerminalPanel containerId={container.id} />
        ) : (
          <section className="card">
            <p className="empty">Start the container to open a terminal.</p>
          </section>
        )
      ) : null}
    </div>
  );
}

function Overview({
  container,
  busy,
  onSave,
}: {
  container: Container;
  busy: boolean;
  onSave: (patch: UpdateContainerSettingsRequest) => void;
}): JSX.Element {
  const [autoStop, setAutoStop] = useState(container.lifecycle.autoStop);
  const [idleMinutes, setIdleMinutes] = useState(
    container.lifecycle.idleTimeoutSeconds !== undefined
      ? String(Math.round(container.lifecycle.idleTimeoutSeconds / 60))
      : "",
  );
  const [deleteAfterStop, setDeleteAfterStop] = useState(container.lifecycle.deleteAfterStop);

  useEffect(() => {
    setAutoStop(container.lifecycle.autoStop);
    setIdleMinutes(
      container.lifecycle.idleTimeoutSeconds !== undefined
        ? String(Math.round(container.lifecycle.idleTimeoutSeconds / 60))
        : "",
    );
    setDeleteAfterStop(container.lifecycle.deleteAfterStop);
  }, [container]);

  const save = (): void => {
    const minutes = idleMinutes.trim() === "" ? null : Number(idleMinutes);
    if (minutes !== null && (!Number.isFinite(minutes) || minutes <= 0)) return;

    onSave({
      lifecycle: {
        autoStop,
        deleteAfterStop,
        idleTimeoutSeconds: minutes === null ? null : Math.round(minutes * 60),
      },
    });
  };

  return (
    <>
      <section className="card">
        <h2>Overview</h2>
        <dl className="details">
          <dt>Container ID</dt>
          <dd className="mono">{container.id}</dd>
          <dt>Image</dt>
          <dd className="mono">{container.image}</dd>
          <dt>Runtime</dt>
          <dd>{container.runtime}</dd>
          <dt>Workspace</dt>
          <dd className="mono">{container.workspace}</dd>
          <dt>Created</dt>
          <dd>{formatDate(container.createdAt)}</dd>
          <dt>Started</dt>
          <dd>{formatDate(container.startedAt)}</dd>
          <dt>Last activity</dt>
          <dd>{formatDate(container.lastActivityAt)}</dd>
          <dt>Resources</dt>
          <dd>
            {container.resources.cpuLimit ?? "unlimited"} CPU ·{" "}
            {container.resources.memoryLimitMb ?? "unlimited"} MB
          </dd>
          <dt>Active connections</dt>
          <dd>{container.activeConnections}</dd>
        </dl>
      </section>

      <section className="card">
        <h2>Lifecycle</h2>
        <div className="lifecycle-form">
          <label>
            <input
              type="checkbox"
              checked={autoStop}
              onChange={(event) => setAutoStop(event.target.checked)}
            />
            Automatic stop
          </label>
          <label>
            Idle timeout (minutes)
            <input
              type="number"
              min="1"
              placeholder="disabled"
              value={idleMinutes}
              onChange={(event) => setIdleMinutes(event.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={deleteAfterStop}
              onChange={(event) => setDeleteAfterStop(event.target.checked)}
            />
            Delete after stop
          </label>
          <button type="button" onClick={save} disabled={busy}>
            Save lifecycle
          </button>
        </div>
        <p className="hint">
          Lifecycle is enforced by SessionBox, not by the agent. A plugin disconnect never stops the
          container.
        </p>
      </section>
    </>
  );
}

function formatDate(value: string | undefined): string {
  if (value === undefined) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
