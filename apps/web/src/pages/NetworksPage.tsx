import { useCallback, useEffect, useState, type FormEvent, type JSX } from "react";
import type { Container, Network } from "@sessionbox/protocol";
import { api } from "../api.ts";
import { Alert, Button, Card, Field, INPUT_CLASS, Modal } from "../components/ui.tsx";
import { useI18n } from "../i18n.tsx";
import { describeError } from "../lib/errors.ts";
import { navigate } from "../router.ts";

/** Networks as a resource: create (dialog), inspect attachments, delete. */
export function NetworksPage(): JSX.Element {
  const { t } = useI18n();
  const [networks, setNetworks] = useState<Network[] | null>(null);
  const [containers, setContainers] = useState<Container[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [networkList, containerList] = await Promise.all([api.listNetworks(), api.list()]);
      setNetworks(networkList);
      setContainers(containerList);
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const nameOf = useCallback(
    (id: string): string => containers.find((container) => container.id === id)?.name ?? id,
    [containers],
  );

  const closeModal = (): void => {
    setCreating(false);
    setName("");
    setModalError(null);
  };

  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setModalError(null);
    try {
      await api.createNetwork(name.trim());
      closeModal();
      await refresh();
    } catch (caught) {
      setModalError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (network: Network): Promise<void> => {
    if (!window.confirm(t("networks.deleteConfirm", { name: network.name }))) return;
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
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">{t("networks.title")}</h1>
          <p className="text-sm text-slate-500">{t("networks.subtitle")}</p>
        </div>
        <Button onClick={() => setCreating(true)}>{t("networks.new")}</Button>
      </div>

      {error !== null && <Alert>{error}</Alert>}

      <Card>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500">
              <th className="py-2 pr-4 font-medium">{t("common.name")}</th>
              <th className="py-2 pr-4 font-medium">{t("networks.colContainers")}</th>
              <th className="py-2 pr-4 font-medium">{t("common.created")}</th>
              <th className="py-2 text-right font-medium">{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {networks === null && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-slate-500">
                  {t("app.loading")}
                </td>
              </tr>
            )}
            {networks !== null && networks.length === 0 && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-slate-500">
                  {t("networks.empty")}
                </td>
              </tr>
            )}
            {(networks ?? []).map((network) => (
              <tr key={network.name} className="border-b border-slate-800/60 last:border-0">
                <td className="py-3 pr-4 align-top">
                  <span className="font-mono text-slate-100">{network.name}</span>
                </td>
                <td className="py-3 pr-4 align-top">
                  {network.containers.length === 0 ? (
                    <span className="text-slate-500">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {network.containers.map((id) => (
                        <button
                          key={id}
                          type="button"
                          className="rounded-full border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-xs text-slate-300 transition hover:border-indigo-700 hover:text-indigo-300"
                          onClick={() => navigate(`/containers/${id}`)}
                        >
                          {nameOf(id)}
                        </button>
                      ))}
                    </div>
                  )}
                </td>
                <td className="py-3 pr-4 align-top text-slate-400">
                  {network.createdAt === undefined
                    ? "—"
                    : new Date(network.createdAt).toLocaleString(
                        document.documentElement.lang || undefined,
                      )}
                </td>
                <td className="py-3 align-top text-right">
                  <Button variant="danger" disabled={busy} onClick={() => void remove(network)}>
                    {t("common.delete")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {creating && (
        <Modal title={t("networks.modalTitle")} onClose={closeModal}>
          <form onSubmit={(event) => void create(event)} className="space-y-4">
            <Field label={t("common.name")} hint={t("networks.nameHint")}>
              <input
                autoFocus
                className={INPUT_CLASS}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="team-a"
              />
            </Field>

            {modalError !== null && <Alert>{modalError}</Alert>}

            <div className="flex justify-end gap-2">
              <Button variant="secondary" type="button" onClick={closeModal}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy || name.trim() === ""}>
                {busy ? t("common.creating") : t("networks.create")}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
