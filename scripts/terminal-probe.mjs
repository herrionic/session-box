#!/usr/bin/env node
/**
 * Terminal probe: connects to the SessionBox terminal WebSocket, runs a
 * command in the container and prints the output.
 *
 *   node scripts/terminal-probe.mjs ws://host:8787/api/ws/terminal/<containerId> [command]
 *
 * Uses Node's built-in WebSocket client (Node 22+), so it has no dependencies.
 */
const url = process.argv[2];
const command = process.argv[3] ?? "uname -a && pwd && id";

if (!url) {
  console.error("usage: node scripts/terminal-probe.mjs <ws-url> [command]");
  process.exit(2);
}

const MARKER = "SESSIONBOX_PROBE_DONE";
const socket = new WebSocket(url);
let buffer = "";

const timer = setTimeout(() => {
  console.error("probe timed out");
  process.exit(3);
}, 20_000);

socket.addEventListener("open", () => {});
socket.addEventListener("error", () => {
  clearTimeout(timer);
  console.error("websocket error");
  process.exit(4);
});
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));

  if (message.type === "ready") {
    socket.send(JSON.stringify({ type: "input", data: `${command}; echo ${MARKER}\n` }));
    return;
  }

  if (message.type === "output") {
    buffer += message.data;
    // The PTY echoes the command line, which also contains the marker text;
    // only treat a line that is exactly the marker as completion.
    const done = buffer.split(/\r?\n/).some((line) => line.trim() === MARKER);
    if (done) {
      clearTimeout(timer);
      socket.close();
      console.log(buffer);
      process.exit(0);
    }
    return;
  }

  if (message.type === "error") {
    clearTimeout(timer);
    console.error(`terminal error: ${message.code} ${message.message}`);
    process.exit(1);
  }

  if (message.type === "exit") {
    clearTimeout(timer);
    console.error(`shell exited with code ${message.code}`);
    process.exit(5);
  }
});
