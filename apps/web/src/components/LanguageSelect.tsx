import type { ChangeEvent, JSX } from "react";
import { useI18n, type Locale } from "../i18n.tsx";

/** Language names stay in their own language, so they are readable either way. */
export function LanguageSelect(): JSX.Element {
  const { locale, setLocale, t } = useI18n();
  return (
    <select
      aria-label={t("nav.language")}
      title={t("nav.language")}
      value={locale}
      onChange={(event: ChangeEvent<HTMLSelectElement>) => setLocale(event.target.value as Locale)}
      className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300 outline-none transition focus:border-indigo-500"
    >
      <option value="zh">中文</option>
      <option value="en">English</option>
    </select>
  );
}
