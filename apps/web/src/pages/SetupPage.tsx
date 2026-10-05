import { useState, type FormEvent, type JSX } from "react";
import { api, type SessionUser } from "../api.ts";
import { Button, Field, INPUT_CLASS } from "../components/ui.tsx";
import { describeError } from "../lib/errors.ts";

/**
 * First-run wizard: shown automatically while no owner account exists.
 * Creating the account signs the user in, so the instance is usable right away.
 */
export function SetupPage({ onDone }: { onDone: (user: SessionUser) => void }): JSX.Element {
  const [username, setUsername] = useState("admin");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      const response = await api.completeSetup({
        username: username.trim(),
        ...(displayName.trim() !== "" ? { displayName: displayName.trim() } : {}),
        password,
      });
      onDone(response.user);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center px-6">
      <form
        onSubmit={(event) => void submit(event)}
        className="w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900/60 p-6"
      >
        <h1 className="text-xl font-semibold text-slate-100">Welcome to SessionBox</h1>
        <p className="mt-1 text-sm text-slate-500">
          Create the owner account. This wizard appears only once — afterwards you sign in normally.
        </p>

        <div className="mt-6 space-y-4">
          <Field label="Username">
            <input
              className={INPUT_CLASS}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
            />
          </Field>
          <Field label="Display name" hint="Optional">
            <input
              className={INPUT_CLASS}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={username}
            />
          </Field>
          <Field label="Password" hint="At least 8 characters">
            <input
              className={INPUT_CLASS}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <Field label="Repeat password">
            <input
              className={INPUT_CLASS}
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
        </div>

        {error !== null && <p className="mt-4 text-sm text-rose-300">{error}</p>}

        <Button
          type="submit"
          className="mt-6 w-full"
          disabled={busy || username.trim() === "" || password.length < 8}
        >
          {busy ? "Creating…" : "Create account and continue"}
        </Button>
      </form>
    </div>
  );
}
