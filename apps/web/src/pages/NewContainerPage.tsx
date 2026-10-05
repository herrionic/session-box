import { useState, type FormEvent, type JSX } from "react";
import type { CreateContainerRequest } from "@sessionbox/protocol";
import { api } from "../api.ts";
import { Alert, Button, Card, Field, INPUT_CLASS } from "../components/ui.tsx";
import { describeError } from "../lib/errors.ts";
import { navigate } from "../router.ts";

export function NewContainerPage(): JSX.Element {
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [cpu, setCpu] = useState("");
  const [memory, setMemory] = useState("");
  const [pids, setPids] = useState("");
  const [autoStop, setAutoStop] = useState(true);
  const [idleMinutes, setIdleMinutes] = useState("30");
  const [maxLifetimeMinutes, setMaxLifetimeMinutes] = useState("");
  const [deleteAfterStop, setDeleteAfterStop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
          <h1 className="text-xl font-semibold text-slate-100">New container</h1>
          <p className="text-sm text-slate-500">Created from the base image and started immediately.</p>
        </div>
        <Button variant="secondary" onClick={() => navigate("/")}>
          Cancel
        </Button>
      </div>

      {error !== null && <Alert>{error}</Alert>}

      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        <Card title="Identity">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name" hint="Optional — letters, digits, . _ -">
              <input
                className={INPUT_CLASS}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="my-session"
              />
            </Field>
            <Field label="Image" hint="Defaults to sessionbox/base:latest">
              <input
                className={INPUT_CLASS}
                value={image}
                onChange={(event) => setImage(event.target.value)}
                placeholder="sessionbox/base:latest"
              />
            </Field>
          </div>
        </Card>

        <Card title="Resources" >
          <div className="grid grid-cols-3 gap-4">
            <Field label="CPU (cores)">
              <input
                className={INPUT_CLASS}
                value={cpu}
                onChange={(event) => setCpu(event.target.value)}
                placeholder="1"
                inputMode="decimal"
              />
            </Field>
            <Field label="Memory (MB)">
              <input
                className={INPUT_CLASS}
                value={memory}
                onChange={(event) => setMemory(event.target.value)}
                placeholder="1024"
                inputMode="numeric"
              />
            </Field>
            <Field label="PIDs limit">
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
              <Field label="Idle timeout (minutes)" hint="Stop after this long without activity">
                <input
                  className={INPUT_CLASS}
                  value={idleMinutes}
                  onChange={(event) => setIdleMinutes(event.target.value)}
                  placeholder="30"
                  inputMode="numeric"
                  disabled={!autoStop}
                />
              </Field>
              <Field label="Maximum lifetime (minutes)" hint="Optional hard limit">
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
          </div>
        </Card>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" type="button" onClick={() => navigate("/")}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create container"}
          </Button>
        </div>
      </form>
    </div>
  );
}
