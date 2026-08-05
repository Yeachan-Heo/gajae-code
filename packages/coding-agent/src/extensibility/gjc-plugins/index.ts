export * from "./activation";
export * from "./compiler";
export * from "./constrained-hooks";
export * from "./injection";
/**
 * Public barrel. Mutation primitives are deliberately NOT re-exported here:
 * `lifecycle.ts` is the sole policy and persistence writer, so the installer
 * transaction and the registry writers stay reachable only through their own
 * modules. Re-exporting them would let a caller commit a replacement and
 * bypass the create-only rule.
 */
export { isGjcPluginBundleSource, isGjcPluginSourceShape } from "./installer";
export * from "./lifecycle";
export * from "./lifecycle-reconciliation";
export * from "./mcp-policy";
export * from "./observability";
export * from "./paths";
export * from "./prompt-appendix";
export {
	loadEffectiveGjcPluginRegistry,
	readRegistry,
	registryEntryFingerprint,
	registryPathForScope,
	registryRootForScope,
	sortRegistryEntries,
} from "./registry";
export * from "./runtime-adapters";
export * from "./runtime-quarantine";
export * from "./schema";
export * from "./session-validation";
export * from "./state";
export * from "./tools";
export * from "./types";
export * from "./validation";
export * from "./metadata";
export * from "./migration";
export * from "./subskill-authority";
