import { useCallback, useEffect, useState, type JSX } from "react";
import { api, ApiError, type SessionUser } from "./api.ts";
import { Layout } from "./components/Layout.tsx";
import { ContainerPage } from "./pages/ContainerPage.tsx";
import { ContainersPage } from "./pages/ContainersPage.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { NewContainerPage } from "./pages/NewContainerPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { navigate, useRoute } from "./router.ts";

export function App(): JSX.Element {
  const route = useRoute();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.me();
        if (!cancelled) setUser(response.user);
      } catch (error) {
        if (!cancelled && error instanceof ApiError && error.code === "UNAUTHORIZED") {
          setUser(null);
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [route]);

  const handleLogout = useCallback(async (): Promise<void> => {
    try {
      await api.logout();
    } catch {
      // The session is gone either way; clear the UI.
    }
    setUser(null);
    navigate("/");
  }, []);

  if (!ready) {
    return <div className="grid min-h-screen place-items-center text-slate-500">Loading…</div>;
  }

  if (user === null) {
    return (
      <LoginPage
        onLogin={(next) => {
          setUser(next);
          navigate("/");
        }}
      />
    );
  }

  const detail = /^\/containers\/([^/]+)$/.exec(route);
  let page: JSX.Element;
  if (route === "/containers/new") {
    page = <NewContainerPage />;
  } else if (detail !== null) {
    page = <ContainerPage containerId={decodeURIComponent(detail[1] ?? "")} />;
  } else if (route === "/settings") {
    page = <SettingsPage user={user} onUser={setUser} />;
  } else {
    page = <ContainersPage />;
  }

  return (
    <Layout user={user} current={route} onLogout={() => void handleLogout()}>
      {page}
    </Layout>
  );
}
