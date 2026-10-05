import {
  AGENT_PROTOCOL_VERSION,
  AgentHelloSchema,
  AgentRequestSchema,
  type AgentRequest,
  type AgentResponse,
  type SessionBoxErrorCode,
} from "@sessionbox/protocol";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import type { AgentGateway } from "../../agent/gateway.ts";
import { PERMISSIONS, requirePermission } from "../../auth/principals.ts";
import { isSessionBoxError } from "../../errors.ts";
import type { ContainerService } from "../../container/service.ts";
import type { SessionBoxApp } from "../types.ts";

const HANDSHAKE_TIMEOUT_MS = 10_000;

type AgentServerMessage = AgentResponse | { type: "welcome"; protocolVersion: number };

/**
 * Agent WebSocket gateway: handshake (hello/welcome), then validated requests
 * dispatched through the agent gateway. A disconnect only ends temporary
 * access — it never stops or deletes the container (PROJECT.md §39).
 */
export function registerAgentRoutes(
  app: SessionBoxApp,
  deps: { gateway: AgentGateway; service: ContainerService },
): void {
  app.get("/api/ws/agent", { websocket: true }, (socket, request) => {
    handleAgent(socket, request, deps);
  });
}

function handleAgent(
  socket: WebSocket,
  request: { log: FastifyBaseLogger; principal?: { id: string; permissions: string[]; type: "plugin" | "user" } },
  deps: { gateway: AgentGateway; service: ContainerService },
): void {
  const trackedContainers = new Set<string>();
  const gateway = deps.gateway;
  const service = deps.service;
  const send = (message: AgentServerMessage): void => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  const fail = (code: SessionBoxErrorCode, message: string, requestId?: string): void => {
    send({
      type: "error",
      code,
      message,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  };

  let greeted = false;
  const handshakeTimer = setTimeout(() => {
    fail("INVALID_REQUEST", "agent handshake timed out");
    socket.close();
  }, HANDSHAKE_TIMEOUT_MS);

  request.log.info({ event: "agent.connected" }, "agent connected");

  socket.on("message", (raw) => {
    void (async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        fail("INVALID_REQUEST", "message is not valid JSON");
        return;
      }

      if (!greeted) {
        const hello = AgentHelloSchema.safeParse(parsed);
        if (!hello.success) {
          fail("INVALID_REQUEST", "expected a hello handshake");
          socket.close();
          return;
        }
        if (hello.data.protocolVersion !== AGENT_PROTOCOL_VERSION) {
          fail(
            "INVALID_REQUEST",
            `unsupported protocol version ${hello.data.protocolVersion}; this server speaks ${AGENT_PROTOCOL_VERSION}`,
          );
          socket.close();
          return;
        }

        greeted = true;
        clearTimeout(handshakeTimer);
        send({ type: "welcome", protocolVersion: AGENT_PROTOCOL_VERSION });
        request.log.info(
          { event: "agent.ready", client: hello.data.client },
          "agent handshake complete",
        );
        return;
      }

      const parsedRequest = AgentRequestSchema.safeParse(parsed);
      if (!parsedRequest.success) {
        fail("INVALID_REQUEST", "malformed agent request", extractRequestId(parsed));
        return;
      }

      const agentRequest = parsedRequest.data;
      try {
        requirePermission(request.principal, permissionFor(agentRequest.type));

        if (!trackedContainers.has(agentRequest.containerId)) {
          trackedContainers.add(agentRequest.containerId);
          await service.acquire(agentRequest.containerId);
        }
        await service.touch(agentRequest.containerId);

        send(await gateway.handle(agentRequest));
      } catch (error) {
        if (isSessionBoxError(error)) {
          fail(error.code, error.message, agentRequest.requestId);
          return;
        }
        request.log.error(
          {
            event: "agent.request.failed",
            requestId: agentRequest.requestId,
            containerId: agentRequest.containerId,
            err: error instanceof Error ? error.message : String(error),
          },
          "agent request failed",
        );
        fail("INTERNAL_ERROR", "internal server error", agentRequest.requestId);
      }
    })();
  });

  const cleanup = (): void => {
    clearTimeout(handshakeTimer);
  };
  socket.on("close", () => {
    cleanup();
    for (const containerId of trackedContainers) {
      void service.release(containerId);
    }
    request.log.info({ event: "agent.disconnected" }, "agent disconnected");
  });
  socket.on("error", cleanup);
}

function permissionFor(type: AgentRequest["type"]): string {
  if (type === "exec") return PERMISSIONS.execute;
  if (type === "file.write" || type === "file.mkdir" || type === "file.remove") {
    return PERMISSIONS.write;
  }
  return PERMISSIONS.read;
}

function extractRequestId(parsed: unknown): string | undefined {
  if (typeof parsed === "object" && parsed !== null && "requestId" in parsed) {
    const requestId = (parsed as { requestId?: unknown }).requestId;
    if (typeof requestId === "string" && requestId !== "") return requestId;
  }
  return undefined;
}
