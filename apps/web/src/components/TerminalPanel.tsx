import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalServerMessage } from "@sessionbox/protocol";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { Alert, Button } from "./ui.tsx";

type ConnectionState = "connecting" | "connected" | "closed" | "error";

const STATE_STYLES: Record<ConnectionState, string> = {
  connecting: "bg-amber-950/60 text-amber-300",
  connected: "bg-emerald-950/60 text-emerald-300",
  closed: "bg-slate-800 text-slate-400",
  error: "bg-rose-950/60 text-rose-300",
};

export function TerminalPanel({ containerId }: { containerId: string }): JSX.Element {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback((): void => {
    const term = termRef.current;
    if (term === null) return;

    socketRef.current?.close();
    setState("connecting");
    setError(null);

    const socket = new WebSocket(api.terminalUrl(containerId, { cols: term.cols, rows: term.rows }));
    socketRef.current = socket;

    socket.onopen = () => setState("connected");
    socket.onmessage = (event) => {
      let message: TerminalServerMessage;
      try {
        message = JSON.parse(String(event.data)) as TerminalServerMessage;
      } catch {
        return;
      }

      if (message.type === "output") {
        term.write(message.data);
      } else if (message.type === "ready") {
        setState("connected");
      } else if (message.type === "exit") {
        const notice = t("terminal.exited", { code: message.code ?? "?" });
        term.write(`\r\n\x1b[90m${notice}\x1b[0m\r\n`);
        setState("closed");
      } else if (message.type === "error") {
        setError(`${message.message} (${message.code})`);
        setState("error");
      }
    };
    socket.onclose = () => setState((current) => (current === "error" ? current : "closed"));
    socket.onerror = () => setState("error");
  }, [containerId, t]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Courier New", monospace',
      theme: {
        background: "#020617",
        foreground: "#e2e8f0",
        cursor: "#93c5fd",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    termRef.current = term;

    term.onData((data) => {
      const socket = socketRef.current;
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });

    const onWindowResize = (): void => {
      fit.fit();
      const socket = socketRef.current;
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };
    window.addEventListener("resize", onWindowResize);

    connect();

    return () => {
      window.removeEventListener("resize", onWindowResize);
      socketRef.current?.close();
      socketRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [connect]);

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
          {t("terminal.title")}
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium normal-case ${STATE_STYLES[state]}`}>
            {t(`terminal.${state}`)}
          </span>
        </h2>
        <Button variant="secondary" onClick={connect} disabled={state === "connecting"}>
          {t("terminal.reconnect")}
        </Button>
      </div>

      {error !== null && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}

      <div className="terminal-host overflow-hidden rounded-lg bg-slate-950" ref={containerRef} />
    </section>
  );
}
