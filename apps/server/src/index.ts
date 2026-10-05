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
export { SandboxFilesService, type SandboxFilesServiceOptions } from "./files/service.ts";
export { LifecycleService, type LifecycleServiceOptions } from "./lifecycle/service.ts";
export { createLogger, redactToken } from "./logging.ts";
export { createRuntime } from "./runtime/index.ts";
export { InMemorySandboxRepository, type SandboxRepository } from "./sandbox/repository.ts";
export { SandboxService, type SandboxServiceOptions } from "./sandbox/service.ts";
export { toPublicSandbox, type SandboxRecord } from "./sandbox/types.ts";
export { openDatabase, SCHEMA_VERSION } from "./storage/database.ts";
export { SqliteSandboxRepository } from "./storage/sandbox-repository.ts";
export { InMemorySecretRepository, SqliteSecretRepository, type SecretRepository } from "./storage/secret-repository.ts";
export { generateSshKeyPair, SSH_PRIVATE_KEY_CREDENTIAL } from "./ssh/keypair.ts";
export { SshSessionManager } from "./ssh/manager.ts";
export { isWithinWorkspace, normalizeSandboxPath, resolveWithinWorkspace } from "./ssh/paths.ts";
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
