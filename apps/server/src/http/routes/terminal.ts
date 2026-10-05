import { z } from "zod";
import {
  TerminalClientMessageSchema,
  type TerminalServerMessage,
} from "@sessionbox/protocol";
import type { WebSocket } from "ws";
import { PERMISSIONS, requirePermission, type Principal } from "../../auth/principals.ts";
import { SessionBoxError, isSessionBoxError } from "../../errors.ts";
import type { ContainerService } from "../../container/service.ts";
import type { SessionBoxApp } from "../types.ts";

const ParamsSchema = z.strictObject({ containerId: z.string().min(1) });
const QuerySchema = z.strictObject({
  cols: z.coerce.number().int().min(1).max(1000).optional(),
  rows: z.coerce.number().int().min(1).max(1000).optional(),
});

/**
 * WebSocket terminal: browser (xterm.js) ↔ SessionBox ↔ SSH PTY.
 * Every message is validated at runtime (PROJECT.md §17).
 */
export function registerTerminalRoutes(
  app: SessionBoxApp,
  deps: { service: ContainerService },
): void {
  app.get("/api/ws/terminal/:containerId", { websocket: true }, (socket, request) => {
    void handleTerminal(socket, request, deps.service);
  });
}

async function handleTerminal(
  socket: WebSocket,
  request: { params: unknown; query: unknown; log: import("fastify").FastifyBaseLogger; principal?: Principal },
  service: ContainerService,
): Promise<void> {
  const send = (message: TerminalServerMessage): void => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  try {
    requirePermission(request.principal, PERMISSIONS.execute);
    const { containerId } = ParamsSchema.parse(request.params);
    const query = QuerySchema.parse(request.query ?? {});

    const session = await service.openSshSession(containerId);
    const shell = await session.openShell({
      cols: query.cols ?? 80,
      rows: query.rows ?? 24,
      onData: (data) => send({ type: "output", data }),
      onExit: (code) => {
        send({ type: "exit", code });
        socket.close();
      },
      onError: (error) => {
        request.log.warn(
          { event: "terminal.shell_error", containerId, err: error.message },
          "terminal shell error",
        );
      },
    });

    await service.acquire(containerId);
    send({ type: "ready", containerId });
    request.log.info({ event: "terminal.opened", containerId }, "terminal opened");

    socket.on("message", (raw) => {
      try {
        const message = TerminalClientMessageSchema.parse(JSON.parse(String(raw)));
        if (message.type === "input") {
          shell.write(message.data);
          void service.touch(containerId);
        } else {
          shell.resize(message.cols, message.rows);
        }
      } catch {
        send({
          type: "error",
          code: "INVALID_REQUEST",
          message: "malformed terminal message",
        });
      }
    });

    const closeShell = (): void => {
      shell.close();
      void service.release(containerId);
      request.log.info({ event: "terminal.closed", containerId }, "terminal closed");
    };
    socket.on("close", closeShell);
    socket.on("error", closeShell);
  } catch (error) {
    const mapped = isSessionBoxError(error)
      ? error
      : new SessionBoxError("RUNTIME_ERROR", "the terminal could not be started; see server logs");

    request.log.warn(
      {
        event: "terminal.failed",
        err: describeError(error),
      },
      "terminal failed to start",
    );
    send({ type: "error", code: mapped.code, message: mapped.message });
    socket.close();
  }
}

/** Includes the underlying cause so failures are diagnosable in the logs. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error) return `${error.message}: ${cause.message}`;
    return error.message;
  }
  return String(error);
}
