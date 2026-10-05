import { useEffect, useState, type JSX } from "react";
import { ContainerList } from "./components/ContainerList.tsx";
import { ContainerDetail } from "./components/ContainerDetail.tsx";

const DETAIL_ROUTE = /^#\/containers\/(.+)$/;

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
      <ContainerDetail
        containerId={match[1]}
        onBack={() => {
          window.location.hash = "";
        }}
      />
    );
  }

  return <ContainerList />;
}
