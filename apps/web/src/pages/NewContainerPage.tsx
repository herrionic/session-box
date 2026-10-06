import { useEffect, useState, type FormEvent, type JSX } from "react";
import type { CreateContainerRequest, Network } from "@sessionbox/protocol";
import { api } from "../api.ts";
import { Alert, Button, Card, Field, INPUT_CLASS } from "../components/ui.tsx";
import { useI18n } from "../i18n.tsx";
import { describeError } from "../lib/errors.ts";
import { navigate } from "../router.ts";

export function NewContainerPage(): JSX.Element {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [cpu, setCpu] = useState("");
  const [memory, setMemory] = useState("");
  const [pids, setPids] = useState("");
  const [autoStop, setAutoStop] = useState(true);
  const [idleMinutes, setIdleMinutes] = useState("30");
  const [maxLifetimeMinutes, setMaxLifetimeMinutes] = useState("");
  const [deleteAfterStop, setDeleteAfterStop] = useState(false);
  const [networks, setNetworks] = useState<Network[]>([]);
  const [selectedNetworks, setSelectedNetworks] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setNetworks(await api.listNetworks());
      } catch {
        // The networks section is optional; creation works without it.
      }
    })();
  }, []);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const input: CreateContainerRequest = {
      ...(name.trim() !== "" ? { name: name.trim() } : {}),
      ...(image.trim() !== "" ? { image: image.trim() } : {}),
      resources: {
        ...(cpu.trim() !== "" ? { cpuLimit: Number(cpu) } : {}),
        ...(memory.trim() !== "" ? { memoryLimitMb: Number(memory) } : {}),
        ...(pids.trim() !== "" ? { pidsLimit: Number(pids) } : {}),
      },
      ...(selectedNetworks.length > 0 ? { networks: selectedNetworks } : {}),
      lifecycle: {
        autoStop,
        ...(idleMinutes.trim() !== "" ? { idleTimeoutSeconds: Number(idleMinutes) * 60 } : {}),
        ...(maxLifetimeMinutes.trim() !== ""
          ? { maxLifetimeSeconds: Number(maxLifetimeMinutes) * 60 }
          : {}),
        deleteAfterStop,
      },
    };

    try {
      const created = await api.create(input);
      navigate(`/containers/${created.id}`);
    } catch (caught) {
      setError(describeError(caught));
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">{t("newContainer.title")}</h1>
          <p className="text-sm text-slate-500">{t("newContainer.subtitle")}</p>
        </div>
        <Button variant="secondary" onClick={() => navigate("/")}>
          {t("common.cancel")}
        </Button>
      </div>

      {error !== null && <Alert>{error}</Alert>}

      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        <Card title={t("newContainer.identity")}>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t("newContainer.name")} hint={t("newContainer.nameHint")}>
              <input
                className={INPUT_CLASS}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="my-session"
              />
            </Field>
            <Field label={t("newContainer.image")} hint={t("newContainer.imageHint")}>
              <input
                className={INPUT_CLASS}
                value={image}
                onChange={(event) => setImage(event.target.value)}
                placeholder="sessionbox/base:latest"
              />
            </Field>
          </div>
        </Card>

        <Card title={t("newContainer.resources")}>
          <div className="grid grid-cols-3 gap-4">
            <Field label={t("newContainer.cpu")}>
              <input
                className={INPUT_CLASS}
                value={cpu}
                onChange={(event) => setCpu(event.target.value)}
                placeholder="1"
                inputMode="decimal"
              />
            </Field>
            <Field label={t("newContainer.memory")}>
              <input
                className={INPUT_CLASS}
                value={memory}
                onChange={(event) => setMemory(event.target.value)}
                placeholder="1024"
                inputMode="numeric"
              />
            </Field>
            <Field label={t("newContainer.pids")}>
              <input
                className={INPUT_CLASS}
                value={pids}
                onChange={(event) => setPids(event.target.value)}
                placeholder="512"
                inputMode="numeric"
              />
            </Field>
          </div>
        </Card>

        <Card title={t("newContainer.networks")}>
          <p className="mb-3 text-xs text-slate-500">{t("newContainer.networksHint")}</p>
          {networks.length === 0 ? (
            <p className="text-sm text-slate-500">{t("newContainer.networksEmpty")}</p>
          ) : (
            <div className="space-y-2">
              {networks.map((network) => (
                <label key={network.name} className="flex items-center gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-indigo-500"
                    checked={selectedNetworks.includes(network.name)}
                    onChange={(event) =>
                      setSelectedNetworks((current) =>
                        event.target.checked
                          ? [...current, network.name]
                          : current.filter((name) => name !== network.name),
                      )
                    }
                  />
                  <span className="font-mono">{network.name}</span>
                </label>
              ))}
            </div>
          )}
        </Card>

        <Card title={t("newContainer.lifecycle")}>
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
              <Field
                label={t("container.idleTimeout")}
                hint={t("container.idleTimeoutHint")}
              >
                <input
                  className={INPUT_CLASS}
                  value={idleMinutes}
                  onChange={(event) => setIdleMinutes(event.target.value)}
                  placeholder="30"
                  inputMode="numeric"
                  disabled={!autoStop}
                />
              </Field>
              <Field
                label={t("container.maxLifetime")}
                hint={t("container.maxLifetimeHint")}
              >
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
          </div>
        </Card>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" type="button" onClick={() => navigate("/")}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? t("common.creating") : t("newContainer.create")}
          </Button>
        </div>
      </form>
    </div>
  );
}
