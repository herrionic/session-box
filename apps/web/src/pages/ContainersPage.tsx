import { useCallback, useEffect, useState, type JSX } from "react";
import type { Container } from "@sessionbox/protocol";
import { api } from "../api.ts";
import { Alert, Button, Card, IconButton, StatusBadge } from "../components/ui.tsx";
import { OpenIcon, PlayIcon, RestartIcon, StopIcon, TrashIcon } from "../components/Icons.tsx";
import { describeError } from "../lib/errors.ts";
import { navigate } from "../router.ts";

export function ContainersPage(): JSX.Element {
  const [containers, setContainers] = useState<Container[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setContainers(await api.list());
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (id: string, operation: () => Promise<unknown>): Promise<void> => {
    setBusyId(id);
    try {
      await operation();
      await refresh();
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (container: Container): Promise<void> => {
    if (!window.confirm(`Delete container "${container.name}"? This cannot be undone.`)) return;
    await act(container.id, () => api.remove(container.id));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Containers</h1>
          <p className="text-sm text-slate-500">Every agent session runs in its own container.</p>
        </div>
        <Button onClick={() => navigate("/containers/new")}>New container</Button>
      </div>

      {error !== null && <Alert>{error}</Alert>}

      <Card>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500">
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Image</th>
              <th className="py-2 pr-4 font-medium">Resources</th>
              <th className="py-2 pr-4 font-medium">Created</th>
              <th className="py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {containers === null && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-slate-500">
                  Loading…
                </td>
              </tr>
            )}
            {containers !== null && containers.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-slate-500">
                  No containers yet — create one to get started.
                </td>
              </tr>
            )}
            {(containers ?? []).map((container) => (
              <tr key={container.id} className="border-b border-slate-800/60 last:border-0">
                <td className="py-3 pr-4 align-top">
                  <button
                    type="button"
                    className="font-medium text-slate-100 hover:text-indigo-300"
                    onClick={() => navigate(`/containers/${container.id}`)}
                  >
                    {container.name}
                  </button>
                  <div className="font-mono text-xs text-slate-500">{container.id}</div>
                </td>
                <td className="py-3 pr-4 align-top">
                  <StatusBadge status={container.status} />
                </td>
                <td className="py-3 pr-4 align-top text-slate-300">{container.image}</td>
                <td className="py-3 pr-4 align-top text-slate-300">{resourcesText(container)}</td>
                <td className="py-3 pr-4 align-top text-slate-400">
                  {formatDate(container.createdAt)}
                </td>
                <td className="py-3 align-top">
                  <div className="flex items-center justify-end gap-1">
                    <IconButton
                      label="Open"
                      onClick={() => navigate(`/containers/${container.id}`)}
                    >
                      <OpenIcon />
                    </IconButton>
                    {container.status === "running" ? (
                      <IconButton
                        label="Stop"
                        disabled={busyId === container.id}
                        onClick={() => void act(container.id, () => api.stop(container.id))}
                      >
                        <StopIcon />
                      </IconButton>
                    ) : (
                      <IconButton
                        label="Start"
                        disabled={busyId === container.id || container.status === "creating"}
                        onClick={() => void act(container.id, () => api.start(container.id))}
                      >
                        <PlayIcon />
                      </IconButton>
                    )}
                    <IconButton
                      label="Restart"
                      disabled={busyId === container.id}
                      onClick={() => void act(container.id, () => api.restart(container.id))}
                    >
                      <RestartIcon />
                    </IconButton>
                    <IconButton
                      label="Delete"
                      variant="danger"
                      disabled={busyId === container.id}
                      onClick={() => void remove(container)}
                    >
                      <TrashIcon />
                    </IconButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
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

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
