import { useCallback, useEffect, useState, type JSX } from "react";
import type { Container } from "@sessionbox/protocol";
import { api } from "../api.ts";
import { FileBrowser } from "../components/FileBrowser.tsx";
import { NetworkPanel } from "../components/NetworkPanel.tsx";
import { TerminalPanel } from "../components/TerminalPanel.tsx";
import { Alert, Button, Card, Field, INPUT_CLASS, StatusBadge } from "../components/ui.tsx";
import { PlayIcon, RestartIcon, StopIcon, TrashIcon } from "../components/Icons.tsx";
import { useI18n, type MessageKey } from "../i18n.tsx";
import { describeError } from "../lib/errors.ts";
import { navigate } from "../router.ts";

type Tab = "overview" | "files" | "terminal" | "network";

export function ContainerPage({ containerId }: { containerId: string }): JSX.Element {
  const { t } = useI18n();
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
    if (!window.confirm(t("containers.deleteConfirm", { name: container.name }))) return;
    await act(async () => {
      await api.remove(container.id);
      navigate("/");
    });
  };

  if (container === null) {
    return (
      <div className="space-y-4">
        {error !== null ? (
          <Alert>{error}</Alert>
        ) : (
          <div className="text-slate-500">{t("app.loading")}</div>
        )}
        <Button variant="secondary" onClick={() => navigate("/")}>
          {t("container.backShort")}
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
        {t("container.back")}
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
              className="inline-flex items-center gap-1.5"
              disabled={busy}
              onClick={() => void act(() => api.stop(container.id))}
            >
              <StopIcon /> {t("containers.stop")}
            </Button>
          ) : (
            <Button
              variant="secondary"
              className="inline-flex items-center gap-1.5"
              disabled={busy || container.status === "creating"}
              onClick={() => void act(() => api.start(container.id))}
            >
              <PlayIcon /> {t("containers.start")}
            </Button>
          )}
          <Button
            variant="secondary"
            className="inline-flex items-center gap-1.5"
            disabled={busy}
            onClick={() => void act(() => api.restart(container.id))}
          >
            <RestartIcon /> {t("containers.restart")}
          </Button>
          <Button
            variant="danger"
            className="inline-flex items-center gap-1.5"
            disabled={busy}
            onClick={() => void remove()}
          >
            <TrashIcon /> {t("common.delete")}
          </Button>
        </div>
      </div>

      {error !== null && <Alert>{error}</Alert>}

      <div className="flex gap-1 border-b border-slate-800">
        {(["overview", "files", "terminal", "network"] as const).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm transition ${
              tab === name
                ? "border-indigo-500 text-slate-100"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            {t(`container.tab.${name}`)}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="space-y-4">
          <Card title={t("container.overview")}>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
              <Row label={t("container.image")} value={container.image} />
              <Row label={t("container.runtime")} value={container.runtime} />
              <Row label={t("container.workspace")} value={container.workspace} />
              <Row label={t("container.resources")} value={resourcesText(container, t)} />
              <Row label={t("container.created")} value={formatDate(container.createdAt)} />
              <Row label={t("container.started")} value={formatDate(container.startedAt)} />
              <Row label={t("container.stopped")} value={formatDate(container.stoppedAt)} />
              <Row label={t("container.lastActivity")} value={formatDate(container.lastActivityAt)} />
              <Row
                label={t("container.activeConnections")}
                value={String(container.activeConnections)}
              />
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
      {tab === "network" && <NetworkPanel container={container} onChanged={setContainer} />}
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
  const { t } = useI18n();
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
    <Card title={t("container.lifecycle")}>
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            className="h-4 w-4 accent-indigo-500"
            checked={autoStop}
            onChange={(event) => setAutoStop(event.target.checked)}
          />
          {t("container.autoStop")}
        </label>

        <div className="grid grid-cols-2 gap-4">
          <Field label={t("container.idleTimeout")}>
            <input
              className={INPUT_CLASS}
              value={idleMinutes}
              onChange={(event) => setIdleMinutes(event.target.value)}
              placeholder="—"
              inputMode="numeric"
              disabled={!autoStop}
            />
          </Field>
          <Field label={t("container.maxLifetime")}>
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
          {t("container.deleteAfterStop")}
        </label>

        <div className="flex items-center gap-3">
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? t("common.saving") : t("container.saveLifecycle")}
          </Button>
          {saved && <span className="text-sm text-emerald-300">{t("common.saved")}</span>}
        </div>

        <p className="text-xs text-slate-500">{t("container.lifecycleNote")}</p>
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

function resourcesText(
  container: Container,
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
): string {
  const parts: string[] = [];
  if (container.resources.cpuLimit !== undefined) parts.push(`${container.resources.cpuLimit} CPU`);
  if (container.resources.memoryLimitMb !== undefined) {
    parts.push(`${container.resources.memoryLimitMb} MB`);
  }
  if (container.resources.pidsLimit !== undefined) parts.push(`${container.resources.pidsLimit} pids`);
  return parts.length > 0 ? parts.join(" · ") : t("common.unlimited");
}

function formatDate(iso: string | undefined): string {
  if (iso === undefined) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(document.documentElement.lang || undefined);
}
