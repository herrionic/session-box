import { z } from "zod";
import {
  CreateFileRequestSchema,
  FILE_LIMITS,
  WriteFileRequestSchema,
} from "@sessionbox/protocol";
import { SessionBoxError } from "../../errors.ts";
import type { SandboxFilesService } from "../../files/service.ts";
import type { SessionBoxApp } from "../types.ts";

const IdParamsSchema = z.strictObject({ id: z.string().min(1) });
const PathQuerySchema = z.strictObject({ path: z.string().min(1) });
const RemoveQuerySchema = z.strictObject({
  path: z.string().min(1),
  recursive: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});

export function registerFileRoutes(
  app: SessionBoxApp,
  deps: { files: SandboxFilesService },
): void {
  const { files } = deps;

  app.get("/api/sandboxes/:id/files", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const { path } = PathQuerySchema.parse(request.query);
    return await files.list(id, path);
  });

  app.get("/api/sandboxes/:id/files/content", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const { path } = PathQuerySchema.parse(request.query);
    return await files.readText(id, path);
  });

  app.put("/api/sandboxes/:id/files/content", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const body = WriteFileRequestSchema.parse(request.body ?? {});
    return await files.writeText(id, body);
  });

  app.post("/api/sandboxes/:id/files", async (request, reply) => {
    const { id } = IdParamsSchema.parse(request.params);
    const body = CreateFileRequestSchema.parse(request.body ?? {});
    reply.code(201);
    return await files.create(id, body);
  });

  app.delete("/api/sandboxes/:id/files", async (request, reply) => {
    const { id } = IdParamsSchema.parse(request.params);
    const query = RemoveQuerySchema.parse(request.query);
    await files.remove(id, query.path, query.recursive === true ? { recursive: true } : {});
    reply.code(204).send();
  });

  app.get("/api/sandboxes/:id/files/download", async (request, reply) => {
    const { id } = IdParamsSchema.parse(request.params);
    const { path } = PathQuerySchema.parse(request.query);
    const { entry, content } = await files.download(id, path);

    reply
      .header("content-type", "application/octet-stream")
      .header("content-length", String(content.length))
      .header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
      )
      .send(content);
  });

  app.post(
    "/api/sandboxes/:id/files/upload",
    { bodyLimit: FILE_LIMITS.maxUploadBytes },
    async (request, reply) => {
      const { id } = IdParamsSchema.parse(request.params);
      const { path } = PathQuerySchema.parse(request.query);
      const body: unknown = request.body;
      if (!Buffer.isBuffer(body)) {
        throw new SessionBoxError(
          "INVALID_REQUEST",
          "upload body must be sent as application/octet-stream",
        );
      }
      reply.code(201);
      return await files.upload(id, path, body);
    },
  );
}
