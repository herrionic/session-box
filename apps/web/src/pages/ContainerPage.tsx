import { useCallback, useEffect, useState, type JSX } from "react";
import type { Container } from "@sessionbox/protocol";
import { api } from "../api.ts";
import { FileBrowser } from "../components/FileBrowser.tsx";
import { TerminalPanel } from "../components/TerminalPanel.tsx";
import { Alert, Button, Card, Field, INPUT_CLASS, StatusBadge } from "../components/ui.tsx";
import { describeError } from "../lib/errors.ts";
import { navigate } from "../router.ts";

type Tab = "overview" | "files" | "terminal";

export function ContainerPage({ containerId }: { containerId: string }): JSX.Element {
  const [container, setContainer] = useState<Container | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setContainer(await api.get(containerId));
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [containerId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await operation();
      await refresh();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (container === null) return;
    if (!window.confirm(`Delete container "${container.name}"? This cannot be undone.`)) return;
    await act(async () => {
      await api.remove(container.id);
      navigate("/");
    });
  };

  if (container === null) {
    return (
      <div className="space-y-4">
        {error !== null ? <Alert>{error}</Alert> : <div className="text-slate-500">Loading…</div>}
        <Button variant="secondary" onClick={() => navigate("/")}>
          Back to containers
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        className="text-sm text-slate-400 transition hover:text-slate-200"
        onClick={() => navigate("/")}
      >
        ← All containers
      </button>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-slate-100">{container.name}</h1>
            <StatusBadge status={container.status} />
          </div>
          <div className="font-mono text-xs text-slate-500">{container.id}</div>
        </div>

        <div className="flex gap-2">
          {container.status === "running" ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void act(() => api.stop(container.id))}
            >
              Stop
            </Button>
          ) : (
            <Button
              variant="secondary"
              disabled={busy || container.status === "creating"}
              onClick={() => void act(() => api.start(container.id))}
            >
              Start
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void act(() => api.restart(container.id))}
          >
            Restart
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void remove()}>
            Delete
          </Button>
        </div>
      </div>

      {error !== null && <Alert>{error}</Alert>}

      <div className="flex gap-1 border-b border-slate-800">
        {(["overview", "files", "terminal"] as const).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm capitalize transition ${
              tab === name
                ? "border-indigo-500 text-slate-100"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            {name}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="space-y-4">
          <Card title="Overview">
            <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
              <Row label="Image" value={container.image} />
              <Row label="Runtime" value={container.runtime} />
              <Row label="Workspace" value={container.workspace} />
              <Row label="Resources" value={resourcesText(container)} />
              <Row label="Created" value={formatDate(container.createdAt)} />
              <Row label="Started" value={formatDate(container.startedAt)} />
              <Row label="Stopped" value={formatDate(container.stoppedAt)} />
              <Row label="Last activity" value={formatDate(container.lastActivityAt)} />
              <Row label="Active connections" value={String(container.activeConnections)} />
            </dl>
          </Card>

          <LifecycleForm
            key={`${container.id}:${container.lifecycle.idleTimeoutSeconds ?? "none"}:${container.lifecycle.maxLifetimeSeconds ?? "none"}:${container.lifecycle.autoStop}`}
            container={container}
            onSaved={setContainer}
            onError={(message) => setError(message)}
          />
        </div>
      )}

      {tab === "files" && <FileBrowser containerId={container.id} />}
      {tab === "terminal" && <TerminalPanel containerId={container.id} />}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-200">{value}</dd>
    </>
  );
}

function LifecycleForm({
  container,
  onSaved,
  onError,
}: {
  container: Container;
  onSaved: (container: Container) => void;
  onError: (message: string) => void;
}): JSX.Element {
  const [autoStop, setAutoStop] = useState(container.lifecycle.autoStop);
  const [idleMinutes, setIdleMinutes] = useState(minutesInput(container.lifecycle.idleTimeoutSeconds));
  const [maxLifetimeMinutes, setMaxLifetimeMinutes] = useState(
    minutesInput(container.lifecycle.maxLifetimeSeconds),
  );
  const [deleteAfterStop, setDeleteAfterStop] = useState(container.lifecycle.deleteAfterStop);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    setSaved(false);
    try {
      const updated = await api.updateSettings(container.id, {
        lifecycle: {
          autoStop,
          idleTimeoutSeconds: autoStop ? secondsFromMinutes(idleMinutes) : null,
          maxLifetimeSeconds: autoStop ? secondsFromMinutes(maxLifetimeMinutes) : null,
          deleteAfterStop: autoStop && deleteAfterStop,
        },
      });
      onSaved(updated);
      setSaved(true);
    } catch (caught) {
      onError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Lifecycle">
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            className="h-4 w-4 accent-indigo-500"
            checked={autoStop}
            onChange={(event) => setAutoStop(event.target.checked)}
          />
          Automatic stop
        </label>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Idle timeout (minutes)">
            <input
              className={INPUT_CLASS}
              value={idleMinutes}
              onChange={(event) => setIdleMinutes(event.target.value)}
              placeholder="—"
              inputMode="numeric"
              disabled={!autoStop}
            />
          </Field>
          <Field label="Maximum lifetime (minutes)">
            <input
              className={INPUT_CLASS}
              value={maxLifetimeMinutes}
              onChange={(event) => setMaxLifetimeMinutes(event.target.value)}
              placeholder="—"
              inputMode="numeric"
              disabled={!autoStop}
            />
          </Field>
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            className="h-4 w-4 accent-indigo-500"
            checked={deleteAfterStop}
            onChange={(event) => setDeleteAfterStop(event.target.checked)}
            disabled={!autoStop}
          />
          Delete after stop
        </label>

        <div className="flex items-center gap-3">
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save lifecycle"}
          </Button>
          {saved && <span className="text-sm text-emerald-300">Saved</span>}
        </div>

        <p className="text-xs text-slate-500">
          Lifecycle is enforced by SessionBox, not by the agent. A plugin disconnect never stops the
          container.
        </p>
      </div>
    </Card>
  );
}

function minutesInput(seconds: number | undefined): string {
  return seconds === undefined ? "" : String(Math.round(seconds / 60));
}

function secondsFromMinutes(value: string): number | null {
  const minutes = Number(value);
  return value.trim() === "" || !Number.isFinite(minutes) || minutes <= 0 ? null : Math.round(minutes * 60);
}

function resourcesText(container: Container): string {
  const parts: string[] = [];
  if (container.resources.cpuLimit !== undefined) parts.push(`${container.resources.cpuLimit} CPU`);
  if (container.resources.memoryLimitMb !== undefined) {
    parts.push(`${container.resources.memoryLimitMb} MB`);
  }
  if (container.resources.pidsLimit !== undefined) parts.push(`${container.resources.pidsLimit} pids`);
  return parts.length > 0 ? parts.join(" · ") : "unlimited";
}

function formatDate(iso: string | undefined): string {
  if (iso === undefined) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
