import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalServerMessage } from "@sessionbox/protocol";
import { api } from "../api.ts";

type ConnectionState = "connecting" | "connected" | "closed" | "error";

export function TerminalPanel({ sandboxId }: { sandboxId: string }): JSX.Element {
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

    const socket = new WebSocket(
      `${api.terminalUrl(sandboxId)}?cols=${term.cols}&rows=${term.rows}`,
    );
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
        term.write(`\r\n\x1b[90m[process exited with code ${message.code ?? "?"}]\x1b[0m\r\n`);
        setState("closed");
      } else if (message.type === "error") {
        setError(`${message.message} (${message.code})`);
        setState("error");
      }
    };
    socket.onclose = () => setState((current) => (current === "error" ? current : "closed"));
    socket.onerror = () => setState("error");
  }, [sandboxId]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Courier New", monospace',
      theme: {
        background: "#0f172a",
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
    <section className="card terminal-card">
      <div className="file-toolbar">
        <h2>
          Terminal <span className={`conn conn-${state}`}>{state}</span>
        </h2>
        <div className="actions">
          <button
            type="button"
            className="secondary"
            onClick={connect}
            disabled={state === "connecting"}
          >
            Reconnect
          </button>
        </div>
      </div>
      {error !== null && <div className="alert">{error}</div>}
      <div className="terminal-container" ref={containerRef} />
    </section>
  );
}
