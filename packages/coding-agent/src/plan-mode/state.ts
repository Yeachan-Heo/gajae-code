export interface PlanModeState {
	enabled: boolean;
	planFilePath: string;
	workflow?: "parallel" | "iterative";
	reentry?: boolean;
}

export const DEFAULT_PLAN_FILE_PATH = "local://PLAN.md";

const LOCAL_PLAN_PATH = /^local:\/\/?([^\\%?#]+)$/;

/**
 * A persisted plan path becomes the plan-mode write target. Accept only a
 * relative path under the session `local:` root; any other saved value,
 * including an absolute or `..` path, falls back to the default plan file.
 */
export function restoredPlanFilePath(value: unknown): string {
	if (typeof value !== "string") return DEFAULT_PLAN_FILE_PATH;
	const relative = LOCAL_PLAN_PATH.exec(value)?.[1];
	if (!relative || relative.split("/").some(segment => segment === "" || segment === "." || segment === ".."))
		return DEFAULT_PLAN_FILE_PATH;
	return value;
}
