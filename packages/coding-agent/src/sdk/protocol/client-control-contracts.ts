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

export type SdkDiffObservationOperation = "diff.scopes" | "diff.summary" | "diff.file";

export function isSdkDiffObservationOperation(value: unknown): value is SdkDiffObservationOperation {
	return value === "diff.scopes" || value === "diff.summary" || value === "diff.file";
}
