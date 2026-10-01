import { z } from "zod";

/**
 * Stable public error codes. These never change shape over the wire;
 * detailed internal errors stay in server logs.
 */
export const ErrorCodeSchema = z.enum([
  "SANDBOX_NOT_FOUND",
  "SANDBOX_NOT_RUNNING",
  "SANDBOX_CREATE_FAILED",
  "SSH_UNAVAILABLE",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "INVALID_REQUEST",
  "INVALID_STATE",
  "OPERATION_TIMEOUT",
  "RUNTIME_ERROR",
  "INTERNAL_ERROR",
  "NOT_FOUND",
]);

export type SessionBoxErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: ErrorCodeSchema,
    message: z.string().min(1),
    requestId: z.string().min(1).optional(),
    details: z.unknown().optional(),
  }),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const HealthResponseSchema = z.strictObject({
  status: z.literal("ok"),
  version: z.string().min(1),
  runtime: z.string().min(1),
  uptimeSeconds: z.number().nonnegative(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
