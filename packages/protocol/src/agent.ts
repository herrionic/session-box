import { z } from "zod";
import { ErrorCodeSchema } from "./errors.ts";
import {
  FileBytesSchema,
  FileContentSchema,
  FileEntrySchema,
  FileMetadataSchema,
} from "./files.ts";

/** MVP protocol version (PROJECT.md §40). */
export const AGENT_PROTOCOL_VERSION = 2;

/** Client → server handshake. */
export const AgentHelloSchema = z.strictObject({
  type: z.literal("hello"),
  protocolVersion: z.number().int().positive(),
  client: z.string().min(1).max(128).optional(),
});

export type AgentHello = z.infer<typeof AgentHelloSchema>;

/** Server → client handshake response. */
export const AgentWelcomeSchema = z.strictObject({
  type: z.literal("welcome"),
  protocolVersion: z.number().int().positive(),
});

export type AgentWelcome = z.infer<typeof AgentWelcomeSchema>;

const requestBase = {
  requestId: z.string().min(1).max(128),
  containerId: z.string().min(1).max(128),
};

const pathSchema = z.string().min(1).max(4096);

/**
 * Agent requests (PROJECT.md §16). EDIT stays in the harness layer; the
 * protocol exposes the primitives an adapter can build it from.
 */
export const AgentRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...requestBase,
    type: z.literal("exec"),
    command: z.string().min(1).max(64 * 1024),
    cwd: pathSchema.optional(),
    timeoutMs: z.number().int().positive().max(10 * 60_000).optional(),
  }),
  z.strictObject({
    ...requestBase,
    type: z.literal("exec.cancel"),
    /** The `requestId` of an in-flight `exec` on the same connection. */
    targetRequestId: z.string().min(1).max(128),
  }),
  z.strictObject({ ...requestBase, type: z.literal("file.read"), path: pathSchema }),
  z.strictObject({ ...requestBase, type: z.literal("file.readBytes"), path: pathSchema }),
  z.strictObject({
    ...requestBase,
    type: z.literal("file.write"),
    path: pathSchema,
    content: z.string().max(8 * 1024 * 1024),
  }),
  z.strictObject({ ...requestBase, type: z.literal("file.list"), path: pathSchema }),
  z.strictObject({ ...requestBase, type: z.literal("file.stat"), path: pathSchema }),
  z.strictObject({
    ...requestBase,
    type: z.literal("file.mkdir"),
    path: pathSchema,
    recursive: z.boolean().optional(),
  }),
  z.strictObject({
    ...requestBase,
    type: z.literal("file.remove"),
    path: pathSchema,
    recursive: z.boolean().optional(),
  }),
]);

export type AgentRequest = z.infer<typeof AgentRequestSchema>;
export type AgentRequestType = AgentRequest["type"];

const responseBase = {
  requestId: z.string().min(1).max(128),
};

/** Server → client responses, one per request (plus errors). */
export const AgentResponseSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...responseBase,
    type: z.literal("exec.result"),
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
  }),
  z.strictObject({
    ...responseBase,
    type: z.literal("exec.cancel.result"),
    targetRequestId: z.string().min(1).max(128),
  }),
  z.strictObject({ ...responseBase, type: z.literal("file.read.result"), file: FileContentSchema }),
  z.strictObject({
    ...responseBase,
    type: z.literal("file.readBytes.result"),
    file: FileBytesSchema,
  }),
  z.strictObject({
    ...responseBase,
    type: z.literal("file.write.result"),
    file: FileMetadataSchema,
  }),
  z.strictObject({
    ...responseBase,
    type: z.literal("file.list.result"),
    path: z.string().min(1),
    entries: z.array(FileEntrySchema),
  }),
  z.strictObject({ ...responseBase, type: z.literal("file.stat.result"), entry: FileEntrySchema }),
  z.strictObject({ ...responseBase, type: z.literal("file.mkdir.result"), path: z.string().min(1) }),
  z.strictObject({ ...responseBase, type: z.literal("file.remove.result"), path: z.string().min(1) }),
  // Protocol-level errors (malformed handshake, unknown request) may not have
  // a requestId to echo.
  z.strictObject({
    type: z.literal("error"),
    requestId: z.string().min(1).max(128).optional(),
    code: ErrorCodeSchema,
    message: z.string().min(1),
  }),
]);

export type AgentResponse = z.infer<typeof AgentResponseSchema>;

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
