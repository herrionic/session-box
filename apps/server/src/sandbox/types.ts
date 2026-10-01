import type {
  LifecyclePolicy,
  Sandbox,
  SandboxResources,
  SandboxStatus,
} from "@sessionbox/protocol";

/**
 * Internal sandbox record: the public model plus runtime-internal fields that
 * must never leave the server.
 */
export interface SandboxRecord {
  id: string;
  name: string;
  image: string;
  runtime: string;
  status: SandboxStatus;
  workspace: string;
  resources: SandboxResources;
  lifecycle: LifecyclePolicy;
  createdAt: string;
  startedAt?: string;
  stoppedAt?: string;
  lastActivityAt?: string;
  activeConnections: number;
  /** Runtime handle (container id, pod name, ...). Server-internal only. */
  runtimeRef?: string;
}

/**
 * Explicit mapping (not a spread) so new internal fields can never leak into
 * the public API by accident.
 */
export function toPublicSandbox(record: SandboxRecord): Sandbox {
  return {
    id: record.id,
    name: record.name,
    image: record.image,
    runtime: record.runtime,
    status: record.status,
    workspace: record.workspace,
    resources: record.resources,
    lifecycle: record.lifecycle,
    createdAt: record.createdAt,
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    ...(record.stoppedAt !== undefined ? { stoppedAt: record.stoppedAt } : {}),
    ...(record.lastActivityAt !== undefined ? { lastActivityAt: record.lastActivityAt } : {}),
    activeConnections: record.activeConnections,
  };
}
