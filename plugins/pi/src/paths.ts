// The host↔container path rules live in @sessionbox/shared so every harness
// adapter maps paths identically. Re-exported here for the Pi adapter's
// internal imports and tests.
export { DEFAULT_CONTAINER_ROOT, fromContainerPath, toContainerPath } from "@sessionbox/shared";
