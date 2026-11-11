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
