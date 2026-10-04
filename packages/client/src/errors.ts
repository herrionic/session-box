/** Stable error shape thrown by every client call. */
export class SessionBoxClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SessionBoxClientError";
    this.code = code;
  }
}
