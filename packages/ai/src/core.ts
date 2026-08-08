/**
 * Lightweight public AI runtime surface.
 *
 * This entrypoint intentionally exports core types, schemas, model metadata,
 * stream dispatch, and lazy provider descriptors only. Concrete provider
 * implementations stay behind `register-builtins` loaders and are not
 * re-exported here.
 */
export { type ZodType, z } from "zod/v4";
export * from "./api-registry";
export * from "./auth-broker";
export * from "./auth-gateway/types";
export * from "./auth-storage";
export * from "./codex-tools";
export * from "./context-cap-policy";
export * from "./model-cache";
export * from "./model-manager";
export * from "./model-thinking";
export * from "./models";
export * from "./provider-models";
export {
	getProviderRuntimeDescriptor,
	PROVIDER_RUNTIME_DESCRIPTORS,
	type ProviderRuntimeDescriptor,
} from "./providers/register-builtins";
export * from "./rate-limit-utils";
export * from "./stream";
export * from "./types";
export * from "./usage";
export * from "./utils/event-stream";
export * from "./utils/fallback-transport";
export * from "./utils/oauth";
export type {
	OAuthCredentials,
	OAuthProvider,
	OAuthProviderId,
	OAuthProviderInfo,
} from "./utils/oauth/types";
export * from "./utils/overflow";
export * from "./utils/retry";
export * from "./utils/schema";
export * from "./utils/tool-choice-capability";
export * from "./utils/validation";
