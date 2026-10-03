/**
 * Entry point for programmatic use (tests import the app builder directly;
 * this module exists so the package has a stable public export later).
 */
export { loadConfig, type ServerConfig } from "./config.ts";
export { parseMasterKey } from "./credentials/master-key.ts";
export { InMemoryCredentialStore, type CredentialStore } from "./credentials/store.ts";
export { buildApp, type AppDependencies } from "./http/app.ts";
export { SandboxFilesService, type SandboxFilesServiceOptions } from "./files/service.ts";
export { createLogger } from "./logging.ts";
export { createRuntime } from "./runtime/index.ts";
export { InMemorySandboxRepository, type SandboxRepository } from "./sandbox/repository.ts";
export { SandboxService, type SandboxServiceOptions } from "./sandbox/service.ts";
export { toPublicSandbox, type SandboxRecord } from "./sandbox/types.ts";
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
