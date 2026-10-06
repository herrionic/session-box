import { useCallback, useEffect, useState, type FormEvent, type JSX } from "react";
import { api, type ApiTokenEntry, type SessionUser } from "../api.ts";
import { Alert, Button, Card, Field, INPUT_CLASS } from "../components/ui.tsx";
import { useI18n } from "../i18n.tsx";
import { describeError } from "../lib/errors.ts";

export function SettingsPage({
  user,
  onUser,
}: {
  user: SessionUser;
  onUser: (user: SessionUser) => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">{t("settings.title")}</h1>
        <p className="text-sm text-slate-500">{t("settings.subtitle")}</p>
      </div>
      <ProfileCard user={user} onUser={onUser} />
      <PasswordCard />
      <TokensCard />
    </div>
  );
}

function ProfileCard({
  user,
  onUser,
}: {
  user: SessionUser;
  onUser: (user: SessionUser) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const response = await api.updateProfile(displayName.trim());
      onUser(response.user);
      setMessage(t("settings.profileSaved"));
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t("settings.profile")}>
      <form onSubmit={(event) => void save(event)} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label={t("settings.username")}>
            <input className={`${INPUT_CLASS} opacity-60`} value={user.username} disabled />
          </Field>
          <Field label={t("settings.displayName")}>
            <input
              className={INPUT_CLASS}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Field>
        </div>
        {error !== null && <Alert>{error}</Alert>}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy || displayName.trim() === ""}>
            {busy ? t("common.saving") : t("settings.saveProfile")}
          </Button>
          {message !== null && <span className="text-sm text-emerald-300">{message}</span>}
        </div>
      </form>
    </Card>
  );
}

function PasswordCard(): JSX.Element {
  const { t } = useI18n();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setMessage(null);
    setError(null);

    if (newPassword !== confirmPassword) {
      setError(t("settings.passwordMismatch"));
      return;
    }

    setBusy(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setMessage(t("settings.passwordChanged"));
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t("settings.password")}>
      <form onSubmit={(event) => void save(event)} className="space-y-4">
        <Field label={t("settings.currentPassword")}>
          <input
            className={INPUT_CLASS}
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t("settings.newPassword")} hint={t("settings.newPasswordHint")}>
            <input
              className={INPUT_CLASS}
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <Field label={t("settings.repeatNewPassword")}>
            <input
              className={INPUT_CLASS}
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
        </div>
        {error !== null && <Alert>{error}</Alert>}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy || currentPassword === "" || newPassword.length < 8}>
            {busy ? t("common.saving") : t("settings.changePassword")}
          </Button>
          {message !== null && <span className="text-sm text-emerald-300">{message}</span>}
        </div>
      </form>
    </Card>
  );
}

function TokensCard(): JSX.Element {
  const { t } = useI18n();
  const [tokens, setTokens] = useState<ApiTokenEntry[] | null>(null);
  const [name, setName] = useState("");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setTokens((await api.listTokens()).tokens);
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
    setCreatedToken(null);
    try {
      const response = await api.createToken(name.trim());
      setCreatedToken(response.token);
      setName("");
      await refresh();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (entry: ApiTokenEntry): Promise<void> => {
    if (!window.confirm(t("settings.revokeConfirm", { name: entry.name }))) return;
    try {
      await api.revokeToken(entry.id);
      await refresh();
    } catch (caught) {
      setError(describeError(caught));
    }
  };

  return (
    <Card title={t("settings.tokens")}>
      <p className="mb-4 text-sm text-slate-400">{t("settings.tokensHint")}</p>

      {createdToken !== null && (
        <div className="mb-4 rounded-lg border border-emerald-900 bg-emerald-950/40 p-3">
          <div className="text-xs font-medium text-emerald-300">{t("settings.newToken")}</div>
          <code className="mt-1 block break-all font-mono text-sm text-emerald-100">
            {createdToken}
          </code>
        </div>
      )}

      <form onSubmit={(event) => void create(event)} className="mb-4 flex items-end gap-3">
        <div className="flex-1">
          <Field label={t("settings.tokenName")}>
            <input
              className={INPUT_CLASS}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="dsh-laptop"
            />
          </Field>
        </div>
        <Button type="submit" disabled={busy || name.trim() === ""}>
          {busy ? t("settings.generating") : t("settings.generateToken")}
        </Button>
      </form>

      {error !== null && <Alert>{error}</Alert>}

      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500">
            <th className="py-2 pr-4 font-medium">{t("common.name")}</th>
            <th className="py-2 pr-4 font-medium">{t("settings.colPrefix")}</th>
            <th className="py-2 pr-4 font-medium">{t("common.created")}</th>
            <th className="py-2 pr-4 font-medium">{t("settings.colLastUsed")}</th>
            <th className="py-2 text-right font-medium">{t("common.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {tokens === null && (
            <tr>
              <td colSpan={5} className="py-4 text-center text-slate-500">
                {t("app.loading")}
              </td>
            </tr>
          )}
          {tokens !== null && tokens.length === 0 && (
            <tr>
              <td colSpan={5} className="py-4 text-center text-slate-500">
                {t("settings.tokensEmpty")}
              </td>
            </tr>
          )}
          {(tokens ?? []).map((entry) => (
            <tr key={entry.id} className="border-b border-slate-800/60 last:border-0">
              <td className="py-2 pr-4 text-slate-200">{entry.name}</td>
              <td className="py-2 pr-4 font-mono text-xs text-slate-400">{entry.prefix}…</td>
              <td className="py-2 pr-4 text-slate-400">{formatDate(entry.createdAt)}</td>
              <td className="py-2 pr-4 text-slate-400">
                {entry.lastUsedAt === undefined ? t("common.never") : formatDate(entry.lastUsedAt)}
              </td>
              <td className="py-2 text-right">
                <Button variant="danger" onClick={() => void revoke(entry)}>
                  {t("settings.revoke")}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(document.documentElement.lang || undefined);
}
