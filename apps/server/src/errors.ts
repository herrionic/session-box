import type { ErrorResponse, SessionBoxErrorCode } from "@sessionbox/protocol";

const HTTP_STATUS_BY_CODE: Record<SessionBoxErrorCode, number> = {
  CONTAINER_NOT_FOUND: 404,
  CONTAINER_NOT_RUNNING: 409,
  CONTAINER_CREATE_FAILED: 502,
  SSH_UNAVAILABLE: 503,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  INVALID_REQUEST: 400,
  INVALID_STATE: 409,
  OPERATION_TIMEOUT: 504,
  OPERATION_CANCELLED: 499,
  FS_NOT_TEXT: 400,
  RUNTIME_ERROR: 502,
  INTERNAL_ERROR: 500,
  NOT_FOUND: 404,
};

export interface SessionBoxErrorOptions {
  details?: unknown;
  cause?: unknown;
}

/**
 * Errors safe to surface through the public API: stable code, human message,
 * no stack traces and no runtime internals.
 */
export class SessionBoxError extends Error {
  readonly code: SessionBoxErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: SessionBoxErrorCode, message: string, options: SessionBoxErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SessionBoxError";
    this.code = code;
    this.statusCode = HTTP_STATUS_BY_CODE[code];
    if (options.details !== undefined) this.details = options.details;
  }

  toResponse(requestId?: string): ErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(requestId ? { requestId } : {}),
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export function isSessionBoxError(error: unknown): error is SessionBoxError {
  return error instanceof SessionBoxError;
}
