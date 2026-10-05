import type { ButtonHTMLAttributes, JSX, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "danger";

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary:
    "rounded-lg bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-400 disabled:opacity-50",
  secondary:
    "rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 transition hover:bg-slate-700 disabled:opacity-50",
  danger:
    "rounded-lg border border-rose-900/70 bg-rose-950/40 px-3 py-1.5 text-sm text-rose-300 transition hover:bg-rose-900/40 disabled:opacity-50",
};

export function Button({
  variant = "primary",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }): JSX.Element {
  return <button className={`${BUTTON_STYLES[variant]} ${className}`} {...rest} />;
}

const ICON_BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary:
    "border-indigo-500 bg-indigo-500/90 text-white hover:bg-indigo-400",
  secondary:
    "border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-slate-100",
  danger: "border-rose-900/70 bg-rose-950/40 text-rose-300 hover:bg-rose-900/40",
};

export function IconButton({
  label,
  variant = "secondary",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; variant?: ButtonVariant }): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition disabled:opacity-40 ${ICON_BUTTON_STYLES[variant]} ${className}`}
      {...rest}
    />
  );
}

export function Card({
  title,
  actions,
  children,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      {(title !== undefined || actions !== undefined) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title !== undefined && (
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</h2>
          )}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

const STATUS_STYLES: Record<string, string> = {
  running: "bg-emerald-950/60 text-emerald-300 border-emerald-900",
  stopped: "bg-slate-800 text-slate-300 border-slate-700",
  creating: "bg-amber-950/60 text-amber-300 border-amber-900",
  deleting: "bg-amber-950/60 text-amber-300 border-amber-900",
  failed: "bg-rose-950/60 text-rose-300 border-rose-900",
};

export function StatusBadge({ status }: { status: string }): JSX.Element {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.stopped;
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${style}`}>
      {status}
    </span>
  );
}

export function Alert({ kind = "error", children }: { kind?: "error" | "info"; children: ReactNode }): JSX.Element {
  const style =
    kind === "error"
      ? "border-rose-900/70 bg-rose-950/40 text-rose-200"
      : "border-sky-900/70 bg-sky-950/40 text-sky-200";
  return <div className={`rounded-lg border px-3 py-2 text-sm ${style}`}>{children}</div>;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-400">{label}</span>
      {children}
      {hint !== undefined && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export const INPUT_CLASS =
  "w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 outline-none transition focus:border-indigo-500";
