import { useState, type FormEvent, type JSX } from "react";
import { api, type SessionUser } from "../api.ts";
import { LanguageSelect } from "../components/LanguageSelect.tsx";
import { Button, Field, INPUT_CLASS } from "../components/ui.tsx";
import { useI18n } from "../i18n.tsx";
import { describeError } from "../lib/errors.ts";

/**
 * First-run wizard: shown automatically while no owner account exists.
 * Creating the account signs the user in, so the instance is usable right away.
 */
export function SetupPage({ onDone }: { onDone: (user: SessionUser) => void }): JSX.Element {
  const { t } = useI18n();
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
      setError(t("setup.mismatch"));
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
      <div className="fixed right-4 top-4">
        <LanguageSelect />
      </div>
      <form
        onSubmit={(event) => void submit(event)}
        className="w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900/60 p-6"
      >
        <h1 className="text-xl font-semibold text-slate-100">{t("setup.title")}</h1>
        <p className="mt-1 text-sm text-slate-500">{t("setup.subtitle")}</p>

        <div className="mt-6 space-y-4">
          <Field label={t("setup.username")}>
            <input
              className={INPUT_CLASS}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
            />
          </Field>
          <Field label={t("setup.displayName")} hint={t("setup.displayNameHint")}>
            <input
              className={INPUT_CLASS}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={username}
            />
          </Field>
          <Field label={t("setup.password")} hint={t("setup.passwordHint")}>
            <input
              className={INPUT_CLASS}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <Field label={t("setup.repeatPassword")}>
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
          {busy ? t("setup.submitting") : t("setup.submit")}
        </Button>
      </form>
    </div>
  );
}
