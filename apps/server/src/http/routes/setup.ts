import { z } from "zod";
import { SESSION_MAX_AGE_SECONDS, sessionCookie } from "../../auth/cookies.ts";
import type { AuthService } from "../../auth/service.ts";
import type { SessionBoxApp } from "../types.ts";

const SetupRequestSchema = z.strictObject({
  username: z.string().min(1).max(64),
  displayName: z.string().min(1).max(64).optional(),
  password: z.string().min(8).max(256),
});

/**
 * First-run setup wizard (public by design): the web UI shows it automatically
 * while no owner account exists. Creating the owner also signs the user in, so
 * the instance is ready to use right after the wizard.
 */
export function registerSetupRoutes(app: SessionBoxApp, deps: { auth: AuthService }): void {
  const { auth } = deps;

  app.get("/api/setup/status", async () => {
    return { needsSetup: await auth.needsSetup() };
  });

  app.post("/api/setup", async (request, reply) => {
    const body = SetupRequestSchema.parse(request.body ?? {});
    const user = await auth.completeSetup(
      body.username,
      body.displayName ?? body.username,
      body.password,
    );

    const session = await auth.login(body.username, body.password);
    if (session !== undefined) {
      reply.header("set-cookie", sessionCookie(session.sessionId, SESSION_MAX_AGE_SECONDS));
    }

    reply.code(201);
    return { user };
  });
}
