import { useCallback, useEffect, useState, type JSX } from "react";
import type { Container, Network } from "@sessionbox/protocol";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { describeError } from "../lib/errors.ts";
import { navigate } from "../router.ts";
import { Alert, Button, Card } from "./ui.tsx";

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
  const { t } = useI18n();
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

  const countLabel = (count: number): string =>
    count === 1 ? t("network.oneContainer") : t("network.manyContainers", { count });

  const attached = new Set(container.networks);
  const attachable = (networks ?? []).filter((network) => !attached.has(network.name));

  return (
    <Card title={t("nav.networks")}>
      {error !== null && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}

      <ul className="mb-4 divide-y divide-slate-800/60">
        {container.networks.map((name) => {
          const meta = networks?.find((network) => network.name === name);
          // Networks missing from the shared list are private (per-container).
          const isPrivate = meta === undefined;
          return (
            <li key={name} className="flex items-center justify-between py-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-slate-200">{name}</span>
                {isPrivate ? (
                  <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
                    {t("network.private")}
                  </span>
                ) : (
                  <span className="text-xs text-slate-500">{countLabel(meta.containers.length)}</span>
                )}
              </div>
              {!isPrivate && (
                <Button variant="danger" disabled={busy} onClick={() => void detach(name)}>
                  {t("network.detach")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {attachable.length === 0 ? (
        <div className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
          <span className="text-sm text-slate-500">
            {networks === null ? t("network.loading") : t("network.none")}
          </span>
          <Button variant="secondary" onClick={() => navigate("/networks")}>
            {t("network.createOne")}
          </Button>
        </div>
      ) : (
        <div className="flex items-end gap-3">
          <label className="flex-1">
            <span className="mb-1 block text-xs font-medium text-slate-400">
              {t("network.attachTo")}
            </span>
            <select
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-indigo-500"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">{t("network.select")}</option>
              {attachable.map((network) => (
                <option key={network.name} value={network.name}>
                  {network.name} ({countLabel(network.containers.length)})
                </option>
              ))}
            </select>
          </label>
          <Button disabled={busy || selected === ""} onClick={() => void attach()}>
            {t("network.attach")}
          </Button>
        </div>
      )}

      <p className="mt-4 text-xs text-slate-500">{t("network.note")}</p>
    </Card>
  );
}
