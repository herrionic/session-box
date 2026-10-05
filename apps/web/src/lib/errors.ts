import { ApiError } from "../api.ts";

/** One-line error text for inline alerts. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (${error.code})`;
  return error instanceof Error ? error.message : String(error);
}
