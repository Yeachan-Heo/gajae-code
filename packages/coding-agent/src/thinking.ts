import { type ResolvedThinkingLevel, ThinkingLevel } from "@gajae-code/agent-core/thinking";
import { clampThinkingLevelForModel, type Effort, THINKING_EFFORTS } from "@gajae-code/ai/model-thinking";
import type { Model } from "@gajae-code/ai/types";

/**
 * Metadata used to render thinking selector values in the coding-agent UI.
 */
export interface ThinkingLevelMetadata {
	value: ThinkingLevel;
	label: string;
	description: string;
}

const THINKING_LEVEL_METADATA: Record<ThinkingLevel, ThinkingLevelMetadata> = {
	[ThinkingLevel.Inherit]: {
		value: ThinkingLevel.Inherit,
		label: "inherit",
		description: "Inherit session default",
	},
	[ThinkingLevel.Off]: { value: ThinkingLevel.Off, label: "off", description: "No reasoning" },
	[ThinkingLevel.Minimal]: {
		value: ThinkingLevel.Minimal,
		label: "min",
		description: "Very brief reasoning (~1k tokens)",
	},
	[ThinkingLevel.Low]: { value: ThinkingLevel.Low, label: "low", description: "Light reasoning (~2k tokens)" },
	[ThinkingLevel.Medium]: {
		value: ThinkingLevel.Medium,
		label: "medium",
		description: "Moderate reasoning (~8k tokens)",
	},
	[ThinkingLevel.High]: { value: ThinkingLevel.High, label: "high", description: "Deep reasoning (~16k tokens)" },
	[ThinkingLevel.XHigh]: {
		value: ThinkingLevel.XHigh,
		label: "xhigh",
		description: "Maximum reasoning (~32k tokens)",
	},
	[ThinkingLevel.Max]: {
		value: ThinkingLevel.Max,
		label: "max",
		description: "Opus maximum reasoning",
	},
};

const THINKING_LEVELS = new Set<string>([ThinkingLevel.Inherit, ThinkingLevel.Off, ...THINKING_EFFORTS]);
const EFFORT_LEVELS = new Set<string>(THINKING_EFFORTS);

/**
 * Parses a provider-facing effort value.
 */
export function parseEffort(value: string | null | undefined): Effort | undefined {
	return value !== undefined && value !== null && EFFORT_LEVELS.has(value) ? (value as Effort) : undefined;
}

/**
 * Parses an agent-local thinking selector.
 */
export function parseThinkingLevel(value: string | null | undefined): ThinkingLevel | undefined {
	return value !== undefined && value !== null && THINKING_LEVELS.has(value) ? (value as ThinkingLevel) : undefined;
}

/**
 * Returns display metadata for a thinking selector.
 */
export function getThinkingLevelMetadata(level: ThinkingLevel): ThinkingLevelMetadata {
	return THINKING_LEVEL_METADATA[level];
}

/**
 * Converts an agent-local selector into the effort sent to providers.
 */
export function toReasoningEffort(level: ThinkingLevel | undefined): Effort | undefined {
	if (level === undefined || level === ThinkingLevel.Off || level === ThinkingLevel.Inherit) {
		return undefined;
	}
	return level;
}

/**
 * Resolves a selector against the current model while preserving explicit "off".
 */
export function resolveThinkingLevelForModel(
	model: Model | undefined,
	level: ThinkingLevel | undefined,
): ResolvedThinkingLevel | undefined {
	if (level === undefined || level === ThinkingLevel.Inherit) {
		return undefined;
	}
	if (level === ThinkingLevel.Off) {
		return ThinkingLevel.Off;
	}
	return clampThinkingLevelForModel(model, level);
}
