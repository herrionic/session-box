import type {
  LifecyclePolicy,
  Container,
  ContainerResources,
  ContainerStatus,
} from "@sessionbox/protocol";

/**
 * Internal container record: the public model plus runtime-internal fields that
 * must never leave the server.
 */
export interface ContainerRecord {
  id: string;
  name: string;
  image: string;
  runtime: string;
  status: ContainerStatus;
  workspace: string;
  /** Networks this container is attached to; the default network is first. */
  networks: string[];
  resources: ContainerResources;
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
export function toPublicContainer(record: ContainerRecord): Container {
  return {
    id: record.id,
    name: record.name,
    image: record.image,
    runtime: record.runtime,
    status: record.status,
    workspace: record.workspace,
    networks: record.networks,
    resources: record.resources,
    lifecycle: record.lifecycle,
    createdAt: record.createdAt,
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    ...(record.stoppedAt !== undefined ? { stoppedAt: record.stoppedAt } : {}),
    ...(record.lastActivityAt !== undefined ? { lastActivityAt: record.lastActivityAt } : {}),
    activeConnections: record.activeConnections,
  };
}
