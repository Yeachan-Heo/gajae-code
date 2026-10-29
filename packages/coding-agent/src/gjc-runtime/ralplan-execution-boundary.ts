export const RALPLAN_EXECUTION_BOUNDARIES = ["plan-only", "approval-required"] as const;

export type RalplanExecutionBoundary = (typeof RALPLAN_EXECUTION_BOUNDARIES)[number];

export function parseRalplanExecutionBoundary(value: unknown): RalplanExecutionBoundary | undefined {
	return typeof value === "string" && RALPLAN_EXECUTION_BOUNDARIES.includes(value as RalplanExecutionBoundary)
		? (value as RalplanExecutionBoundary)
		: undefined;
}
