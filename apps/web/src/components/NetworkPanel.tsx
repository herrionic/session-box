import { useCallback, useEffect, useState, type JSX } from "react";
import type { Container, Network } from "@sessionbox/protocol";
import { api } from "../api.ts";
import { Alert, Button, Card } from "./ui.tsx";
import { describeError } from "../lib/errors.ts";

/**
 * Container detail → Network tab: shows the attached networks and allows
 * attaching/detaching shared ones. The default network is locked.
 */
export function NetworkPanel({
  container,
  onChanged,
}: {
  container: Container;
  onChanged: (container: Container) => void;
}): JSX.Element {
  const [networks, setNetworks] = useState<Network[] | null>(null);
  const [selected, setSelected] = useState("");
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

  const attach = async (): Promise<void> => {
    if (selected === "") return;
    setBusy(true);
    try {
      onChanged(await api.attachNetwork(container.id, selected));
      setSelected("");
      await refresh();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const detach = async (name: string): Promise<void> => {
    setBusy(true);
    try {
      onChanged(await api.detachNetwork(container.id, name));
      await refresh();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const attached = new Set(container.networks);
  const attachable = (networks ?? []).filter(
    (network) => network.managed && !attached.has(network.name),
  );

  return (
    <Card title="Networks">
      {error !== null && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}

      <ul className="mb-4 divide-y divide-slate-800/60">
        {container.networks.map((name) => {
          const meta = networks?.find((network) => network.name === name);
          const isDefault = meta !== undefined ? !meta.managed : true;
          return (
            <li key={name} className="flex items-center justify-between py-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-slate-200">{name}</span>
                {isDefault && (
                  <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
                    default · always attached
                  </span>
                )}
              </div>
              {!isDefault && (
                <Button variant="danger" disabled={busy} onClick={() => void detach(name)}>
                  Detach
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex items-end gap-3">
        <label className="flex-1">
          <span className="mb-1 block text-xs font-medium text-slate-400">Attach to network</span>
          <select
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-indigo-500"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">Select a network…</option>
            {attachable.map((network) => (
              <option key={network.name} value={network.name}>
                {network.name}
              </option>
            ))}
          </select>
        </label>
        <Button disabled={busy || selected === ""} onClick={() => void attach()}>
          Attach
        </Button>
      </div>

      <p className="mt-4 text-xs text-slate-500">
        Containers on the same network can reach each other by name. The default network is always
        attached so every session stays reachable and cross-session access works out of the box.
      </p>
    </Card>
  );
}
