import { describe, expect, it } from "vitest";
import {
  AGENT_PROTOCOL_VERSION,
  AgentHelloSchema,
  AgentRequestSchema,
  AgentResponseSchema,
  AgentWelcomeSchema,
} from "../src/index.ts";

describe("agent handshake", () => {
  it("speaks protocol version 1", () => {
    expect(AGENT_PROTOCOL_VERSION).toBe(2);
    expect(AgentHelloSchema.parse({ type: "hello", protocolVersion: 1 })).toMatchObject({
      type: "hello",
    });
    expect(AgentWelcomeSchema.parse({ type: "welcome", protocolVersion: 1 })).toMatchObject({
      type: "welcome",
    });
  });

  it("rejects unknown handshake fields", () => {
    expect(
      AgentHelloSchema.safeParse({ type: "hello", protocolVersion: 1, bogus: true }).success,
    ).toBe(false);
  });
});

describe("agent requests", () => {
  it("accepts every required operation", () => {
    const requests = [
      { type: "exec", requestId: "r1", containerId: "ctr_1", command: "ls" },
      { type: "file.read", requestId: "r2", containerId: "ctr_1", path: "/workspace/a.txt" },
      {
        type: "file.write",
        requestId: "r3",
        containerId: "ctr_1",
        path: "/workspace/a.txt",
        content: "hi",
      },
      { type: "file.list", requestId: "r4", containerId: "ctr_1", path: "/workspace" },
      { type: "file.stat", requestId: "r5", containerId: "ctr_1", path: "/workspace/a.txt" },
      { type: "file.mkdir", requestId: "r6", containerId: "ctr_1", path: "/workspace/x" },
      { type: "file.remove", requestId: "r7", containerId: "ctr_1", path: "/workspace/x" },
    ];

    for (const request of requests) {
      expect(AgentRequestSchema.safeParse(request).success).toBe(true);
    }
  });

  it("rejects malformed requests", () => {
    expect(AgentRequestSchema.safeParse({ type: "exec", requestId: "r1", containerId: "s" }).success).toBe(false);
    expect(AgentRequestSchema.safeParse({ type: "unknown", requestId: "r1", containerId: "s" }).success).toBe(false);
    expect(
      AgentRequestSchema.safeParse({
        type: "exec",
        requestId: "r1",
        containerId: "s",
        command: "ls",
        timeoutMs: 0,
      }).success,
    ).toBe(false);
  });
});

describe("agent responses", () => {
  it("accepts results and errors", () => {
    expect(
      AgentResponseSchema.safeParse({
        requestId: "r1",
        type: "exec.result",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }).success,
    ).toBe(true);

    expect(
      AgentResponseSchema.safeParse({
        type: "error",
        code: "CONTAINER_NOT_FOUND",
        message: "container was not found",
      }).success,
    ).toBe(true);
  });

  it("rejects unknown response types", () => {
    expect(
      AgentResponseSchema.safeParse({ requestId: "r1", type: "exec.done", exitCode: 0 }).success,
    ).toBe(false);
  });
});
