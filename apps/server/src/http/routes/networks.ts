import { z } from "zod";
import { CreateNetworkRequestSchema } from "@sessionbox/protocol";
import { PERMISSIONS, requirePermission } from "../../auth/principals.ts";
import type { NetworkService } from "../../network/service.ts";
import type { SessionBoxApp } from "../types.ts";

const NameParamsSchema = z.strictObject({ name: z.string().min(1) });

/** Networks as a resource: list, create, delete. */
export function registerNetworkRoutes(
  app: SessionBoxApp,
  deps: { networks: NetworkService },
): void {
  const { networks } = deps;

  app.get("/api/networks", async (request) => {
    requirePermission(request.principal, PERMISSIONS.read);
    return await networks.list();
  });

  app.post("/api/networks", async (request, reply) => {
    requirePermission(request.principal, PERMISSIONS.admin);
    const body = CreateNetworkRequestSchema.parse(request.body ?? {});
    const network = await networks.create(body.name);
    reply.code(201);
    return network;
  });

  app.delete("/api/networks/:name", async (request, reply) => {
    requirePermission(request.principal, PERMISSIONS.admin);
    const { name } = NameParamsSchema.parse(request.params);
    await networks.remove(name);
    reply.code(204).send();
  });
}
