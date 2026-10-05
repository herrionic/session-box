import { useState, type FormEvent, type JSX } from "react";
import { api, type SessionUser } from "../api.ts";
import { Button, Field, INPUT_CLASS } from "../components/ui.tsx";
import { describeError } from "../lib/errors.ts";

export function LoginPage({ onLogin }: { onLogin: (user: SessionUser) => void }): JSX.Element {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await api.login(username.trim(), password);
      onLogin(response.user);
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
        <h1 className="text-xl font-semibold text-slate-100">SessionBox</h1>
        <p className="mt-1 text-sm text-slate-500">containers as session runtime</p>

        <div className="mt-6 space-y-4">
          <Field label="Username">
            <input
              className={INPUT_CLASS}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
            />
          </Field>
          <Field label="Password">
            <input
              className={INPUT_CLASS}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </Field>
        </div>

        {error !== null && <p className="mt-4 text-sm text-rose-300">{error}</p>}

        <Button type="submit" className="mt-6 w-full" disabled={busy || password === ""}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
