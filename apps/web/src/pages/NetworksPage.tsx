import { useCallback, useEffect, useState, type FormEvent, type JSX } from "react";
import type { Network } from "@sessionbox/protocol";
import { api } from "../api.ts";
import { Alert, Button, Card, Field, INPUT_CLASS } from "../components/ui.tsx";
import { describeError } from "../lib/errors.ts";

/** Networks as a resource: create, inspect attachments, delete. */
export function NetworksPage(): JSX.Element {
  const [networks, setNetworks] = useState<Network[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setNetworks(await api.listNetworks());
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createNetwork(name.trim());
      setName("");
      await refresh();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (network: Network): Promise<void> => {
    if (!window.confirm(`Delete network "${network.name}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteNetwork(network.name);
      await refresh();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Networks</h1>
        <p className="text-sm text-slate-500">
          Shared networks let containers from different sessions reach each other by name.
        </p>
      </div>

      {error !== null && <Alert>{error}</Alert>}

      <Card title="New network">
        <form onSubmit={(event) => void create(event)} className="flex items-end gap-3">
          <div className="flex-1">
            <Field label="Name" hint="Letters, digits, . _ - (e.g. team-a)">
              <input
                className={INPUT_CLASS}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="team-a"
              />
            </Field>
          </div>
          <Button type="submit" disabled={busy || name.trim() === ""}>
            {busy ? "Creating…" : "Create network"}
          </Button>
        </form>
      </Card>

      <Card>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500">
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Containers</th>
              <th className="py-2 pr-4 font-medium">Created</th>
              <th className="py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {networks === null && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-slate-500">
                  Loading…
                </td>
              </tr>
            )}
            {(networks ?? []).map((network) => (
              <tr key={network.name} className="border-b border-slate-800/60 last:border-0">
                <td className="py-3 pr-4">
                  <span className="font-mono text-slate-100">{network.name}</span>
                  {!network.managed && (
                    <span className="ml-2 rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
                      default
                    </span>
                  )}
                </td>
                <td className="py-3 pr-4 text-slate-400">
                  {network.containers.length === 0
                    ? "—"
                    : network.containers.map((id) => id.slice(-6)).join(", ")}
                </td>
                <td className="py-3 pr-4 text-slate-400">
                  {network.createdAt === undefined ? "—" : new Date(network.createdAt).toLocaleString()}
                </td>
                <td className="py-3 text-right">
                  {network.managed ? (
                    <Button variant="danger" disabled={busy} onClick={() => void remove(network)}>
                      Delete
                    </Button>
                  ) : (
                    <span className="text-xs text-slate-500">locked</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
