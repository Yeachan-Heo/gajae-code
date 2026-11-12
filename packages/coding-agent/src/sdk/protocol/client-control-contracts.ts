export const SIDE_CONVERSATION_MUTATIONS = ["btw.open", "btw.submit", "btw.cancel", "btw.close"] as const;
export const SIDE_CONVERSATION_QUERIES = ["btw.read"] as const;
export type SideConversationOperation = (typeof SIDE_CONVERSATION_MUTATIONS)[number] | "btw.read";
export function isSideConversationOperation(value: string): value is SideConversationOperation {
	return [...SIDE_CONVERSATION_MUTATIONS, ...SIDE_CONVERSATION_QUERIES].some(operation => operation === value);
}

/** Installed by a trusted local application in SessionRouter, never accepted from a wire request. */

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

/** Installed by a trusted local application in SessionRouter, never accepted from a wire request. */
