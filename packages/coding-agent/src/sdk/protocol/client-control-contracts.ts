export const SDK_PREFERENCE_QUERY_OPERATIONS = ["model.roles.get"] as const;
export const SDK_PREFERENCE_CONTROL_OPERATIONS = [
	"model.role.set",
	"model.select",
	"model.profile.select",
	"config.write",
] as const;
export const SDK_PREFERENCE_OPERATIONS = [
	...SDK_PREFERENCE_QUERY_OPERATIONS,
	...SDK_PREFERENCE_CONTROL_OPERATIONS,
] as const;
export type SdkPreferenceOperation = (typeof SDK_PREFERENCE_OPERATIONS)[number];
export type SdkPreferenceControlOperation = (typeof SDK_PREFERENCE_CONTROL_OPERATIONS)[number];
export type SdkPreferenceQueryOperation = (typeof SDK_PREFERENCE_QUERY_OPERATIONS)[number];

export function isSdkPreferenceOperation(operation: string): operation is SdkPreferenceOperation {
	return SDK_PREFERENCE_OPERATIONS.some(candidate => candidate === operation);
}

export function isSdkPreferenceControlOperation(operation: string): operation is SdkPreferenceControlOperation {
	return SDK_PREFERENCE_CONTROL_OPERATIONS.some(candidate => candidate === operation);
}

export function isSdkPreferenceQueryOperation(operation: string): operation is SdkPreferenceQueryOperation {
	return SDK_PREFERENCE_QUERY_OPERATIONS.some(candidate => candidate === operation);
}

export const AUTHORIZATION_QUERY_OPERATIONS = ["auth.providers.status", "auth.status", "auth.read"] as const;
export const AUTHORIZATION_MUTATION_OPERATIONS = [
	"auth.start",
	"auth.answer",
	"auth.cancel",
	"auth.apiKey.store",
] as const;
export const AUTHORIZATION_CONTROL_OPERATIONS = [
	...AUTHORIZATION_QUERY_OPERATIONS,
	...AUTHORIZATION_MUTATION_OPERATIONS,
] as const;
export type AuthorizationControlOperation = (typeof AUTHORIZATION_CONTROL_OPERATIONS)[number];

export function isAuthorizationControlOperation(operation: string): operation is AuthorizationControlOperation {
	return AUTHORIZATION_CONTROL_OPERATIONS.some(candidate => candidate === operation);
}

export type SdkOperatorOperation = "operator.execute" | "operator.read" | "operator.cancel" | "operator.background";
export type SdkOperatorQueryOperation = "operator.read";

export function isSdkOperatorOperation(value: unknown): value is SdkOperatorOperation {
	return (
		value === "operator.execute" ||
		value === "operator.read" ||
		value === "operator.cancel" ||
		value === "operator.background"
	);
}

export function isSdkOperatorQueryOperation(value: unknown): value is SdkOperatorQueryOperation {
	return value === "operator.read";
}

export type ActivityControlQueryOperation = "activity.snapshot" | "activity.detail" | "mcp.snapshot";
export type ActivityControlOperation =
	| ActivityControlQueryOperation
	| "activity.cancel"
	| "activity.pause"
	| "activity.resume"
	| "activity.delete"
	| "activity.acknowledge"
	| "mcp.suspend"
	| "mcp.resume"
	| "mcp.reconnect";

export function isActivityControlQueryOperation(value: string): value is ActivityControlQueryOperation {
	return value === "activity.snapshot" || value === "activity.detail" || value === "mcp.snapshot";
}

export function isActivityControlOperation(value: string): value is ActivityControlOperation {
	return (
		isActivityControlQueryOperation(value) ||
		value === "activity.cancel" ||
		value === "activity.pause" ||
		value === "activity.resume" ||
		value === "activity.delete" ||
		value === "activity.acknowledge" ||
		value === "mcp.suspend" ||
		value === "mcp.resume" ||
		value === "mcp.reconnect"
	);
}

export type SdkComposerObservationOperation = "composer.catalog" | "composer.complete" | "session.info";

export function isSdkComposerObservationOperation(value: unknown): value is SdkComposerObservationOperation {
	return value === "composer.catalog" || value === "composer.complete" || value === "session.info";
}

export const SIDE_CONVERSATION_MUTATIONS = ["btw.open", "btw.submit", "btw.cancel", "btw.close"] as const;
export const SIDE_CONVERSATION_QUERIES = ["btw.read"] as const;
export type SideConversationOperation = (typeof SIDE_CONVERSATION_MUTATIONS)[number] | "btw.read";
export function isSideConversationOperation(value: string): value is SideConversationOperation {
	return [...SIDE_CONVERSATION_MUTATIONS, ...SIDE_CONVERSATION_QUERIES].some(operation => operation === value);
}

export type SdkDiffObservationOperation = "diff.scopes" | "diff.summary" | "diff.file";
export function isSdkDiffObservationOperation(value: unknown): value is SdkDiffObservationOperation {
	return value === "diff.scopes" || value === "diff.summary" || value === "diff.file";
}

/** Installed by a trusted local application in SessionRouter, never accepted from a wire request. */
export const SECURE_LOCAL_OPERATIONS = [
	"auth.login",
	"auth.providers.status",
	"auth.status",
	"auth.start",
	"auth.read",
	"auth.answer",
	"auth.cancel",
	"auth.apiKey.store",
] as const;
export type SecureLocalOperation = (typeof SECURE_LOCAL_OPERATIONS)[number];
export function isSecureLocalOperation(value: unknown): value is SecureLocalOperation {
	return typeof value === "string" && SECURE_LOCAL_OPERATIONS.some(operation => operation === value);
}
