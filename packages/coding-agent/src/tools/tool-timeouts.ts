export interface ToolTimeoutConfig {
	/** Default timeout in seconds when agent omits the field */
	default: number;
	/** Minimum allowed timeout in seconds */
	min: number;
	/** Maximum allowed timeout in seconds (per-tool ceiling) */
	max: number;
}

export const TOOL_TIMEOUTS = {
	bash: { default: 300, min: 1, max: 3600 },
	eval: { default: 30, min: 1, max: 600 },
	browser: { default: 30, min: 1, max: 300 },
	computer: { default: 30, min: 1, max: 300 },
	ssh: { default: 60, min: 1, max: 3600 },
	fetch: { default: 20, min: 1, max: 45 },
	lsp: { default: 20, min: 5, max: 60 },
	debug: { default: 30, min: 5, max: 300 },
} as const satisfies Record<string, ToolTimeoutConfig>;

export type ToolWithTimeout = keyof typeof TOOL_TIMEOUTS;

/**
 * Clamp a raw timeout to the allowed range for a tool.
 * If rawTimeout is undefined, returns the tool's default.
 */
export function clampTimeout(tool: ToolWithTimeout, rawTimeout?: number): number {
	const config = TOOL_TIMEOUTS[tool];
	const timeout = rawTimeout ?? config.default;
	return Math.max(config.min, Math.min(config.max, timeout));
}
