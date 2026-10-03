import { useCallback, useEffect, useState, type JSX } from "react";
import type { Sandbox, UpdateSandboxSettingsRequest } from "@sessionbox/protocol";
import { api } from "../api.ts";
import { FileBrowser } from "./FileBrowser.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { describeError } from "./SandboxList.tsx";

type Tab = "overview" | "files" | "terminal";

export function SandboxDetail({
  sandboxId,
  onBack,
}: {
  sandboxId: string;
  onBack: () => void;
}): JSX.Element {
  const [sandbox, setSandbox] = useState<Sandbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setSandbox(await api.get(sandboxId));
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [sandboxId]);

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

  if (sandbox === null) {
    return (
      <div className="page">
        <button type="button" className="link-button" onClick={onBack}>
          ← All sandboxes
        </button>
        {error !== null ? <div className="alert">{error}</div> : <p className="empty">Loading…</p>}
      </div>
    );
  }

  const onDelete = (): void => {
    if (!window.confirm(`Delete sandbox "${sandbox.name}"? This cannot be undone.`)) return;
    void run(async () => {
      await api.remove(sandbox.id);
      onBack();
    });
  };

  return (
    <div className="page">
      <header className="header">
        <div>
          <button type="button" className="link-button" onClick={onBack}>
            ← All sandboxes
          </button>
          <h1>{sandbox.name}</h1>
          <p className="subtitle">
            <span className={`status status-${sandbox.status}`}>{sandbox.status}</span>{" "}
            <span className="mono">{sandbox.id}</span>
          </p>
        </div>
        <div className="actions">
          {sandbox.status === "stopped" || sandbox.status === "failed" ? (
            <button type="button" disabled={busy} onClick={() => void run(() => api.start(sandbox.id))}>
              Start
            </button>
          ) : null}
          {sandbox.status === "running" ? (
            <button type="button" disabled={busy} onClick={() => void run(() => api.stop(sandbox.id))}>
              Stop
            </button>
          ) : null}
          {sandbox.status === "running" || sandbox.status === "stopped" ? (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void run(() => api.restart(sandbox.id))}
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
          sandbox={sandbox}
          busy={busy}
          onSave={(patch) => void run(() => api.updateSettings(sandbox.id, patch))}
        />
      ) : null}

      {tab === "files" ? (
        sandbox.status === "running" ? (
          <FileBrowser sandboxId={sandbox.id} />
        ) : (
          <section className="card">
            <p className="empty">Start the sandbox to browse its files.</p>
          </section>
        )
      ) : null}

      {tab === "terminal" ? (
        sandbox.status === "running" ? (
          <TerminalPanel sandboxId={sandbox.id} />
        ) : (
          <section className="card">
            <p className="empty">Start the sandbox to open a terminal.</p>
          </section>
        )
      ) : null}
    </div>
  );
}

function Overview({
  sandbox,
  busy,
  onSave,
}: {
  sandbox: Sandbox;
  busy: boolean;
  onSave: (patch: UpdateSandboxSettingsRequest) => void;
}): JSX.Element {
  const [autoStop, setAutoStop] = useState(sandbox.lifecycle.autoStop);
  const [idleMinutes, setIdleMinutes] = useState(
    sandbox.lifecycle.idleTimeoutSeconds !== undefined
      ? String(Math.round(sandbox.lifecycle.idleTimeoutSeconds / 60))
      : "",
  );
  const [deleteAfterStop, setDeleteAfterStop] = useState(sandbox.lifecycle.deleteAfterStop);

  useEffect(() => {
    setAutoStop(sandbox.lifecycle.autoStop);
    setIdleMinutes(
      sandbox.lifecycle.idleTimeoutSeconds !== undefined
        ? String(Math.round(sandbox.lifecycle.idleTimeoutSeconds / 60))
        : "",
    );
    setDeleteAfterStop(sandbox.lifecycle.deleteAfterStop);
  }, [sandbox]);

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
          <dt>Sandbox ID</dt>
          <dd className="mono">{sandbox.id}</dd>
          <dt>Image</dt>
          <dd className="mono">{sandbox.image}</dd>
          <dt>Runtime</dt>
          <dd>{sandbox.runtime}</dd>
          <dt>Workspace</dt>
          <dd className="mono">{sandbox.workspace}</dd>
          <dt>Created</dt>
          <dd>{formatDate(sandbox.createdAt)}</dd>
          <dt>Started</dt>
          <dd>{formatDate(sandbox.startedAt)}</dd>
          <dt>Last activity</dt>
          <dd>{formatDate(sandbox.lastActivityAt)}</dd>
          <dt>Resources</dt>
          <dd>
            {sandbox.resources.cpuLimit ?? "—"} CPU · {sandbox.resources.memoryLimitMb ?? "—"} MB
          </dd>
          <dt>Active connections</dt>
          <dd>{sandbox.activeConnections}</dd>
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
          sandbox.
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
