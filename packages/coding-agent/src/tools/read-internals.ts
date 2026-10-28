import type { Settings } from "../config/settings";
import { getDefault, getEnumValues } from "../config/settings-schema";
import type { TruncationDirection } from "../session/streaming-output";

/**
 * Read execution routes that have distinct truncation-default contracts.
 * Routes that share the same default are grouped only when their truncation
 * policy is identical; selection and rendering remain owned by read.ts.
 */
export type ReadRoute =
	| "local-bare-stream"
	| "local-bare-acp"
	| "archive-member-bare"
	| "local-range"
	| "local-multi-range"
	| "local-raw"
	| "local-summary"
	| "url-reader"
	| "url-cache-page"
	| "dir-local"
	| "dir-archive"
	| "sqlite-list"
	| "sqlite-rows"
	| "converted";

function isTruncationDirection(value: unknown): value is TruncationDirection {
	return value === "head" || value === "last" || value === "both";
}

/**
 * Project layers are merged without dropping non-schema values. Only enum
 * members may reach tool text or truncation; anything else uses the default.
 */
export function configuredReadTruncation(value: unknown): TruncationDirection {
	const allowed = getEnumValues("read.truncation");
	if (typeof value === "string" && allowed?.includes(value) && isTruncationDirection(value)) return value;
	const fallback = getDefault("read.truncation");
	return isTruncationDirection(fallback) ? fallback : "last";
}

function finiteBudget(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	// Same numeric-string coercion as schema reconcile. Anything else is not a budget.
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

/** Finite numbers and numeric strings pass through. Other types use the schema default. */
export function configuredReadBudget(
	value: unknown,
	path: "read.receiptBudgetLines" | "read.receiptBudgetBytes",
): number {
	const coerced = finiteBudget(value);
	if (coerced !== undefined) return coerced;
	const fallback = getDefault(path);
	return typeof fallback === "number" && Number.isFinite(fallback) ? fallback : 0;
}

/** Resolve the configured default for a route; explicit parameters bypass it. */
export function pathDefault(route: ReadRoute, settings: Settings): TruncationDirection {
	switch (route) {
		case "local-bare-stream":
		case "local-bare-acp":
		case "archive-member-bare":
			return configuredReadTruncation(settings.get("read.truncation"));
		default:
			return "head";
	}
}

/** Resolve the effective caller-facing direction with explicit precedence. */
export function resolveEffectiveDirection(
	explicitParam: TruncationDirection | undefined,
	route: ReadRoute,
	settings: Settings,
): TruncationDirection {
	return explicitParam !== undefined ? explicitParam : pathDefault(route, settings);
}
