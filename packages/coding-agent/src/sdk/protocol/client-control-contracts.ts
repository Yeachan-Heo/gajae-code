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
