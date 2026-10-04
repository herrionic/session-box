// The host↔sandbox path rules live in @sessionbox/shared so every harness
// adapter maps paths identically. Re-exported here for the Pi adapter's
// internal imports and tests.
export { DEFAULT_SANDBOX_ROOT, fromSandboxPath, toSandboxPath } from "@sessionbox/shared";
