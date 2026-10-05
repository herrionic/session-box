import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CreateSandboxRequestSchema,
  UpdateSandboxSettingsRequestSchema,
} from "@sessionbox/protocol";
import { PERMISSIONS, requirePermission } from "../../auth/principals.ts";
import type { SandboxService } from "../../sandbox/service.ts";
import { toPublicSandbox } from "../../sandbox/types.ts";
import type { SessionBoxApp } from "../types.ts";

const IdParamsSchema = z.strictObject({ id: z.string().min(1) });

const LogsQuerySchema = z.strictObject({
  tail: z.coerce.number().int().min(1).max(5000).optional(),
});

export function registerSandboxRoutes(
  app: SessionBoxApp,
  deps: { service: SandboxService },
): void {
  const { service } = deps;

  app.get("/api/sandboxes", async (request) => {
    requirePermission(request.principal, PERMISSIONS.read);
    return (await service.list()).map(toPublicSandbox);
  });

  app.post("/api/sandboxes", async (request, reply) => {
    requirePermission(request.principal, PERMISSIONS.create);
    const body = CreateSandboxRequestSchema.parse(request.body ?? {});
    const record = await service.create(body);
    reply.code(201);
    return toPublicSandbox(record);
  });

  app.get("/api/sandboxes/:id", async (request) => {
    requirePermission(request.principal, PERMISSIONS.read);
    const { id } = IdParamsSchema.parse(request.params);
    return toPublicSandbox(await service.get(id));
  });

  app.post("/api/sandboxes/:id/start", async (request) => {
    requirePermission(request.principal, PERMISSIONS.execute);
    const { id } = IdParamsSchema.parse(request.params);
    return toPublicSandbox(await service.start(id));
  });

  app.post("/api/sandboxes/:id/stop", async (request) => {
    requirePermission(request.principal, PERMISSIONS.execute);
    const { id } = IdParamsSchema.parse(request.params);
    return toPublicSandbox(await service.stop(id));
  });

  app.post("/api/sandboxes/:id/restart", async (request) => {
    requirePermission(request.principal, PERMISSIONS.execute);
    const { id } = IdParamsSchema.parse(request.params);
    return toPublicSandbox(await service.restart(id));
  });

  app.delete("/api/sandboxes/:id", async (request, reply) => {
    requirePermission(request.principal, PERMISSIONS.delete);
    const { id } = IdParamsSchema.parse(request.params);
    await service.remove(id);
    reply.code(204).send();
  });

  app.patch("/api/sandboxes/:id/settings", async (request) => {
    requirePermission(request.principal, PERMISSIONS.admin);
    const { id } = IdParamsSchema.parse(request.params);
    const patch = UpdateSandboxSettingsRequestSchema.parse(request.body ?? {});
    return toPublicSandbox(await service.updateSettings(id, patch));
  });

  app.get("/api/sandboxes/:id/logs", async (request) => {
    requirePermission(request.principal, PERMISSIONS.read);
    const { id } = IdParamsSchema.parse(request.params);
    const query = LogsQuerySchema.parse(request.query ?? {});
    const logs = await service.logs(id, query.tail !== undefined ? { tailLines: query.tail } : {});
    return { logs };
  });
}
