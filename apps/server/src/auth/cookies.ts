/** Session cookie helpers (no @fastify/cookie dependency for the MVP). */

export const SESSION_COOKIE_NAME = "sessionbox_session";

export function readSessionCookie(header: string | undefined): string | undefined {
  if (header === undefined || header === "") return undefined;

  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE_NAME) {
      const value = rest.join("=").trim();
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}

export function sessionCookie(sessionId: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
