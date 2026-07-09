export type ThinkingLevelValue = "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/**
 * Metadata used to render thinking selector values in the coding-agent UI.
 *
 * This module is intentionally provider/native-free so schema generation can
 * import settings metadata before native addons have been built in CI.
 */
export interface ThinkingLevelMetadata {
	value: ThinkingLevelValue;
	label: string;
	description: string;
}

const THINKING_LEVEL_METADATA: Record<ThinkingLevelValue, ThinkingLevelMetadata> = {
	inherit: {
		value: "inherit",
		label: "inherit",
		description: "Inherit session default",
	},
	off: { value: "off", label: "off", description: "No reasoning" },
	minimal: {
		value: "minimal",
		label: "min",
		description: "Very brief reasoning (~1k tokens)",
	},
	low: { value: "low", label: "low", description: "Light reasoning (~2k tokens)" },
	medium: {
		value: "medium",
		label: "medium",
		description: "Moderate reasoning (~8k tokens)",
	},
	high: { value: "high", label: "high", description: "Deep reasoning (~16k tokens)" },
	xhigh: {
		value: "xhigh",
		label: "xhigh",
		description: "Extra-high reasoning for complex work",
	},
	max: {
		value: "max",
		label: "max",
		description: "Maximum single-agent reasoning and revision",
	},
	ultra: {
		value: "ultra",
		label: "ultra",
		description: "Coordinates four agents in parallel by default",
	},
};

/**
 * Returns display metadata for a thinking selector.
 */
export function getThinkingLevelMetadata(level: ThinkingLevelValue): ThinkingLevelMetadata {
	return THINKING_LEVEL_METADATA[level];
}
