import { useEffect, useState, type JSX } from "react";
import { SandboxList } from "./components/SandboxList.tsx";
import { SandboxDetail } from "./components/SandboxDetail.tsx";

const DETAIL_ROUTE = /^#\/sandboxes\/(.+)$/;

export function App(): JSX.Element {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const onHashChange = (): void => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const match = DETAIL_ROUTE.exec(hash);
  if (match !== null && match[1] !== undefined) {
    return (
      <SandboxDetail
        sandboxId={match[1]}
        onBack={() => {
          window.location.hash = "";
        }}
      />
    );
  }

  return <SandboxList />;
}
