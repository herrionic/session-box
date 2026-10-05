/**
 * Entry point for programmatic use (tests import the app builder directly;
 * this module exists so the package has a stable public export later).
 */
export { loadConfig, type ServerConfig } from "./config.ts";
export { AgentGateway } from "./agent/gateway.ts";
export { loadAuthConfig, type AuthConfig, type ClientConfig } from "./auth/config.ts";
export { authenticate, hasPermission, PERMISSIONS, requirePermission, type Principal } from "./auth/principals.ts";
export { parseMasterKey } from "./credentials/master-key.ts";
export { EncryptedCredentialStore, InMemoryCredentialStore, type CredentialStore } from "./credentials/store.ts";
export { buildApp, type AppDependencies } from "./http/app.ts";
export { ContainerFilesService, type ContainerFilesServiceOptions } from "./files/service.ts";
export { LifecycleService, type LifecycleServiceOptions } from "./lifecycle/service.ts";
export { NetworkService, type NetworkServiceOptions } from "./network/service.ts";
export { createLogger, redactToken } from "./logging.ts";
export { createRuntime } from "./runtime/index.ts";
export { InMemoryContainerRepository, type ContainerRepository } from "./container/repository.ts";
export { ContainerService, type ContainerServiceOptions } from "./container/service.ts";
export { toPublicContainer, type ContainerRecord } from "./container/types.ts";
export { openDatabase } from "./storage/database.ts";
export { SqliteContainerRepository } from "./storage/container-repository.ts";
export { InMemorySecretRepository, SqliteSecretRepository, type SecretRepository } from "./storage/secret-repository.ts";
export { generateSshKeyPair, SSH_PRIVATE_KEY_CREDENTIAL } from "./ssh/keypair.ts";
export { SshSessionManager } from "./ssh/manager.ts";
export { normalizeContainerPath } from "./ssh/paths.ts";
export { waitForSsh } from "./ssh/readiness.ts";
export {
  SshError,
  SshNotFoundError,
  SshTimeoutError,
  SshUnavailableError,
  type SshExecResult,
  type SshFileEntry,
  type SshSession,
  type SshSessionFactory,
} from "./ssh/session.ts";
export { Ssh2SessionFactory } from "./ssh/ssh2-session.ts";
