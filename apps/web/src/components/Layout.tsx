import type { JSX, ReactNode } from "react";
import type { SessionUser } from "../api.ts";
import { navigate } from "../router.ts";
import { Button } from "./ui.tsx";

export function Layout({
  user,
  current,
  onLogout,
  children,
}: {
  user: SessionUser;
  current: string;
  onLogout: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-800 bg-slate-900/70 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <button type="button" className="text-left" onClick={() => navigate("/")}>
            <div className="text-lg font-semibold text-slate-100">SessionBox</div>
            <div className="text-xs text-slate-500">containers as session runtime</div>
          </button>

          <nav className="flex items-center gap-1">
            <NavLink
              label="Containers"
              to="/"
              active={current === "/" || current.startsWith("/containers")}
            />
            <NavLink label="Settings" to="/settings" active={current === "/settings"} />
            <span className="mx-3 text-sm text-slate-400">{user.displayName}</span>
            <Button variant="secondary" onClick={onLogout}>
              Sign out
            </Button>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6">{children}</main>
    </div>
  );
}

function NavLink({ label, to, active }: { label: string; to: string; active: boolean }): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => navigate(to)}
      className={`rounded-lg px-3 py-1.5 text-sm transition ${
        active ? "bg-slate-800 text-slate-100" : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
      }`}
    >
      {label}
    </button>
  );
}
