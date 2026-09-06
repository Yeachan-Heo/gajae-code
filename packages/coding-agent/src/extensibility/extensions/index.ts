/**
 * Extension system for lifecycle events and custom tools.
 */

export type { SlashCommandInfo, SlashCommandLocation, SlashCommandSource } from "../slash-commands";
export {
	attenuateFunctionHookGrant,
	cloneFunctionHookData,
	compatibilityFunctionHookGrant,
	createFunctionHookCapabilities,
	DEFAULT_EXTENSION_FUNCTION_HOOK_GRANT,
	FUNCTION_HOOK_CAPABILITIES,
	functionHookDenyAllowed,
	functionHookEventIdentityMatches,
	functionHookGrantHash,
	functionHookGrantOperations,
	functionHookPayloadHash,
	functionHookTransformAllowed,
	intersectFunctionHookGrants,
	isPlainFunctionHookData,
	isSafeFunctionHookValue,
	isValidFunctionHookEventValue,
	normalizeFunctionHookGrant,
	redactFunctionHookValue,
	sanitizeFunctionHookReason,
	validateFunctionHookTarget,
} from "./function-hooks";
export {
	discoverAndLoadExtensions,
	ExtensionRuntimeNotInitializedError,
	loadExtensionFromFactory,
	loadExtensions,
} from "./loader";
export * from "./ouroboros-ooo-bridge";
export * from "./prefix-command-bridge";
export * from "./runner";
// Type guards
export * from "./types";
export * from "./wrapper";
