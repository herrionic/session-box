import { HealthResponseSchema } from "@sessionbox/protocol";
import type { ServerConfig } from "../../config.ts";
import type { SandboxRuntime } from "../../runtime/types.ts";
import { SERVER_VERSION } from "../../version.ts";
import type { SessionBoxApp } from "../types.ts";

export function registerHealthRoutes(
  app: SessionBoxApp,
  deps: { config: ServerConfig; runtime: SandboxRuntime },
): void {
  app.get("/api/health", async () =>
    HealthResponseSchema.parse({
      status: "ok",
      version: SERVER_VERSION,
      runtime: deps.runtime.runtimeId,
      uptimeSeconds: Math.round(process.uptime()),
    }),
  );
}
