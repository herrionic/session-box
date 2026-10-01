import { z } from "zod";

export const SandboxStatusSchema = z.enum([
  "creating",
  "running",
  "stopped",
  "failed",
  "deleting",
]);

export type SandboxStatus = z.infer<typeof SandboxStatusSchema>;

export const SandboxResourcesSchema = z.strictObject({
  /** CPU limit in cores, e.g. 0.5 or 2 */
  cpuLimit: z.number().positive().max(128).optional(),
  memoryLimitMb: z.number().int().positive().max(1_048_576).optional(),
  pidsLimit: z.number().int().positive().max(100_000).optional(),
});

export type SandboxResources = z.infer<typeof SandboxResourcesSchema>;

export const SandboxNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "name must be docker-safe (letters, digits, . _ -)");

/**
 * Public sandbox model. Runtime-neutral by design: no container IDs, no IPs,
 * no SSH details (PROJECT.md §10).
 */
export const SandboxSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  image: z.string().min(1),
  runtime: z.string().min(1),
  status: SandboxStatusSchema,
  workspace: z.string().min(1),
  resources: SandboxResourcesSchema,
  lifecycle: z.object({
    autoStop: z.boolean(),
    idleTimeoutSeconds: z.number().int().positive().optional(),
    maxLifetimeSeconds: z.number().int().positive().optional(),
    deleteAfterStop: z.boolean(),
  }),
  createdAt: z.string().min(1),
  startedAt: z.string().min(1).optional(),
  stoppedAt: z.string().min(1).optional(),
  lastActivityAt: z.string().min(1).optional(),
  activeConnections: z.number().int().nonnegative(),
});

export type Sandbox = z.infer<typeof SandboxSchema>;

export const CreateSandboxRequestSchema = z.strictObject({
  name: z.string().min(1).max(64).optional(),
  image: z.string().min(1).optional(),
  resources: SandboxResourcesSchema.optional(),
  lifecycle: z
    .strictObject({
      autoStop: z.boolean().optional(),
      idleTimeoutSeconds: z.number().int().positive().optional(),
      maxLifetimeSeconds: z.number().int().positive().optional(),
      deleteAfterStop: z.boolean().optional(),
    })
    .optional(),
});

export type CreateSandboxRequest = z.infer<typeof CreateSandboxRequestSchema>;

export const UpdateSandboxSettingsRequestSchema = z.strictObject({
  name: z.string().min(1).max(64).optional(),
  lifecycle: z
    .strictObject({
      autoStop: z.boolean().optional(),
      idleTimeoutSeconds: z.number().int().positive().nullable().optional(),
      maxLifetimeSeconds: z.number().int().positive().nullable().optional(),
      deleteAfterStop: z.boolean().optional(),
    })
    .optional(),
});

export type UpdateSandboxSettingsRequest = z.infer<typeof UpdateSandboxSettingsRequestSchema>;
