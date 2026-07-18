import { type ResolvedThinkingLevel, ThinkingLevel } from "@gajae-code/agent-core/thinking";
import { clampThinkingLevelForModel, type Effort, THINKING_EFFORTS } from "@gajae-code/ai/model-thinking";
import type { Model } from "@gajae-code/ai/types";

export { getThinkingLevelMetadata, type ThinkingLevelMetadata } from "./thinking-metadata";

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

export function clampExplicitThinkingLevelForModel(
	model: Model | undefined,
	level: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
	if (level === undefined || level === ThinkingLevel.Inherit || level === ThinkingLevel.Off) {
		return level;
	}
	return clampThinkingLevelForModel(model, level);
}

export interface SelectorThinkingSuffix {
	selector: string;
	thinkingLevel?: ThinkingLevel;
	invalidSuffix?: string;
}

/** Split the final selector suffix once, preserving colons in model IDs. */
export function splitSelectorThinkingSuffix(selector: string): SelectorThinkingSuffix {
	const colonIndex = selector.lastIndexOf(":");
	if (colonIndex === -1) return { selector };

	const suffix = selector.slice(colonIndex + 1);
	const thinkingLevel = parseThinkingLevel(suffix);
	return thinkingLevel
		? { selector: selector.slice(0, colonIndex), thinkingLevel }
		: { selector: selector.slice(0, colonIndex), invalidSuffix: suffix };
}

export function formatClampedModelSelector(selector: string, model: Model | undefined): string {
	const slashIdx = selector.indexOf("/");
	if (slashIdx <= 0) return selector;
	const id = selector.slice(slashIdx + 1);
	const { selector: baseId, thinkingLevel } = splitSelectorThinkingSuffix(id);
	if (!thinkingLevel) return selector;
	const clamped = clampExplicitThinkingLevelForModel(model, thinkingLevel);
	return clamped && clamped !== ThinkingLevel.Inherit
		? `${selector.slice(0, slashIdx + 1)}${baseId}:${clamped}`
		: selector.slice(0, slashIdx + 1) + baseId;
}
