import { z } from "zod";
import {
  clearSessionCookie,
  readSessionCookie,
  SESSION_MAX_AGE_SECONDS,
  sessionCookie,
} from "../../auth/cookies.ts";
import { PERMISSIONS, requirePermission, type Principal } from "../../auth/principals.ts";
import type { AuthService, PublicUser } from "../../auth/service.ts";
import { SessionBoxError } from "../../errors.ts";
import type { SessionBoxApp } from "../types.ts";

const LoginSchema = z.strictObject({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

const ProfileSchema = z
  .strictObject({
    username: z.string().trim().min(1).max(64).optional(),
    displayName: z.string().trim().min(1).max(64).optional(),
  })
  .refine((value) => value.username !== undefined || value.displayName !== undefined, {
    message: "provide username or displayName",
  });

const PasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256),
});

const TokenSchema = z.strictObject({
  name: z.string().min(1).max(64),
});

const TokenParamsSchema = z.strictObject({
  id: z.string().min(1),
});

/** Login/logout, profile, password and API token management (single owner). */
export function registerAuthRoutes(app: SessionBoxApp, deps: { auth: AuthService }): void {
  const { auth } = deps;

  app.post("/api/auth/login", async (request, reply) => {
    const body = LoginSchema.parse(request.body ?? {});
    const result = await auth.login(body.username, body.password);
    if (result === undefined) {
      throw new SessionBoxError("UNAUTHORIZED", "invalid username or password");
    }

    reply.header("set-cookie", sessionCookie(result.sessionId, SESSION_MAX_AGE_SECONDS));
    return { user: result.user, expiresAt: result.expiresAt };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const sessionId = readSessionCookie(request.headers.cookie);
    if (sessionId !== undefined) await auth.logout(sessionId);

    reply.header("set-cookie", clearSessionCookie());
    reply.code(204).send();
  });

  app.get("/api/auth/me", async (request) => {
    return { user: await requireUser(request.principal, auth) };
  });

  app.patch("/api/auth/me", async (request) => {
    const user = await requireUser(request.principal, auth);
    const body = ProfileSchema.parse(request.body ?? {});
    return { user: await auth.updateProfile(user.id, body) };
  });

  app.post("/api/auth/password", async (request) => {
    const user = await requireUser(request.principal, auth);
    const body = PasswordSchema.parse(request.body ?? {});
    await auth.changePassword(user.id, body.currentPassword, body.newPassword);
    return { changed: true };
  });

  app.get("/api/auth/tokens", async (request) => {
    const user = await requireUser(request.principal, auth);
    return { tokens: await auth.listTokens(user.id) };
  });

  app.post("/api/auth/tokens", async (request, reply) => {
    const user = await requireUser(request.principal, auth);
    const body = TokenSchema.parse(request.body ?? {});
    const { token, entry } = await auth.createToken(user.id, body.name);
    reply.code(201);
    return { token, entry };
  });

  app.delete("/api/auth/tokens/:id", async (request, reply) => {
    const user = await requireUser(request.principal, auth);
    const { id } = TokenParamsSchema.parse(request.params);
    const removed = await auth.revokeToken(user.id, id);
    if (!removed) throw new SessionBoxError("NOT_FOUND", "token not found");

    reply.code(204).send();
  });
}

async function requireUser(
  principal: Principal | undefined,
  auth: AuthService,
): Promise<PublicUser> {
  const current = requirePermission(principal, PERMISSIONS.read);
  if (current.type !== "user") {
    throw new SessionBoxError("FORBIDDEN", "this endpoint requires a user session");
  }

  const user = await auth.getUser(current.id);
  if (user === undefined) {
    throw new SessionBoxError("UNAUTHORIZED", "session is no longer valid");
  }
  return user;
}
