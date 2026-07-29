import type { Settings } from "../config/settings";
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

/** Resolve the configured default for a route; explicit parameters bypass it. */
export function pathDefault(route: ReadRoute, settings: Settings): TruncationDirection {
	switch (route) {
		case "local-bare-stream":
		case "local-bare-acp":
		case "archive-member-bare":
			return settings.get("read.truncation") ?? "last";
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
