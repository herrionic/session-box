import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CreateContainerRequestSchema,
  UpdateContainerSettingsRequestSchema,
} from "@sessionbox/protocol";
import { PERMISSIONS, requirePermission } from "../../auth/principals.ts";
import type { ContainerService } from "../../container/service.ts";
import { toPublicContainer } from "../../container/types.ts";
import type { SessionBoxApp } from "../types.ts";

const IdParamsSchema = z.strictObject({ id: z.string().min(1) });

const LogsQuerySchema = z.strictObject({
  tail: z.coerce.number().int().min(1).max(5000).optional(),
});

export function registerContainerRoutes(
  app: SessionBoxApp,
  deps: { service: ContainerService },
): void {
  const { service } = deps;

  app.get("/api/containers", async (request) => {
    requirePermission(request.principal, PERMISSIONS.read);
    return (await service.list()).map(toPublicContainer);
  });

  app.post("/api/containers", async (request, reply) => {
    requirePermission(request.principal, PERMISSIONS.create);
    const body = CreateContainerRequestSchema.parse(request.body ?? {});
    const record = await service.create(body);
    reply.code(201);
    return toPublicContainer(record);
  });

  app.get("/api/containers/:id", async (request) => {
    requirePermission(request.principal, PERMISSIONS.read);
    const { id } = IdParamsSchema.parse(request.params);
    return toPublicContainer(await service.get(id));
  });

  app.post("/api/containers/:id/start", async (request) => {
    requirePermission(request.principal, PERMISSIONS.execute);
    const { id } = IdParamsSchema.parse(request.params);
    return toPublicContainer(await service.start(id));
  });

  app.post("/api/containers/:id/stop", async (request) => {
    requirePermission(request.principal, PERMISSIONS.execute);
    const { id } = IdParamsSchema.parse(request.params);
    return toPublicContainer(await service.stop(id));
  });

  app.post("/api/containers/:id/restart", async (request) => {
    requirePermission(request.principal, PERMISSIONS.execute);
    const { id } = IdParamsSchema.parse(request.params);
    return toPublicContainer(await service.restart(id));
  });

  app.delete("/api/containers/:id", async (request, reply) => {
    requirePermission(request.principal, PERMISSIONS.delete);
    const { id } = IdParamsSchema.parse(request.params);
    await service.remove(id);
    reply.code(204).send();
  });

  app.patch("/api/containers/:id/settings", async (request) => {
    requirePermission(request.principal, PERMISSIONS.admin);
    const { id } = IdParamsSchema.parse(request.params);
    const patch = UpdateContainerSettingsRequestSchema.parse(request.body ?? {});
    return toPublicContainer(await service.updateSettings(id, patch));
  });

  app.get("/api/containers/:id/logs", async (request) => {
    requirePermission(request.principal, PERMISSIONS.read);
    const { id } = IdParamsSchema.parse(request.params);
    const query = LogsQuerySchema.parse(request.query ?? {});
    const logs = await service.logs(id, query.tail !== undefined ? { tailLines: query.tail } : {});
    return { logs };
  });
}
