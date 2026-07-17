import { FORK_CONTEXT_TOKEN_BUDGET_BY_MODE } from "./fork-context-budget";
import type { ForkContextMode } from "./types";

export interface ForkContextAdvisory {
	recommendedMode: ForkContextMode;
	reasons: string[];
	estimatedClonedTokens: Record<ForkContextMode, number>;
	callerModeRespected: true;
}

/**
 * Per-mode clone budget ceilings (advisory estimates only). These bound how
 * many parent-context tokens each mode may clone into the child; the actual
 * cloned amount can never exceed the parent context itself.
 */
const CLONE_BUDGET_BY_MODE = FORK_CONTEXT_TOKEN_BUDGET_BY_MODE;

const RECEIPT_TRIGGERS = [
	{ pattern: /as discussed/i, reason: "prior-session-reference:as-discussed" },
	{ pattern: /as decided/i, reason: "prior-session-reference:as-decided" },
	{ pattern: /earlier in this session/i, reason: "prior-session-reference:earlier-in-this-session" },
	{ pattern: /per the plan above/i, reason: "prior-session-reference:per-the-plan-above" },
	{ pattern: /the previous review/i, reason: "prior-session-reference:the-previous-review" },
	{ pattern: /\.gjc\/plans\//i, reason: "prior-session-reference:gjc-plans-path" },
	{ pattern: /\.gjc\/specs\//i, reason: "prior-session-reference:gjc-specs-path" },
] as const;

const LAST_TURN_TRIGGERS = [
	{ pattern: /the last message/i, reason: "last-turn-reference:the-last-message" },
	{ pattern: /the previous turn/i, reason: "last-turn-reference:the-previous-turn" },
	{ pattern: /see above/i, reason: "last-turn-reference:see-above" },
] as const;

/**
 * Estimated tokens cloned into the child per mode: the per-mode budget
 * ceiling, capped by the actual parent context (you can never clone more
 * than exists). Negative parent contexts are normalized to 0.
 */
function estimateClonedTokens(parentContextTokens: number): Record<ForkContextMode, number> {
	const parent = Math.max(0, parentContextTokens);
	return {
		none: Math.min(parent, CLONE_BUDGET_BY_MODE.none),
		receipt: Math.min(parent, CLONE_BUDGET_BY_MODE.receipt),
		"last-turn": Math.min(parent, CLONE_BUDGET_BY_MODE["last-turn"]),
		bounded: Math.min(parent, CLONE_BUDGET_BY_MODE.bounded),
		full: Math.min(parent, CLONE_BUDGET_BY_MODE.full),
	};
}

export function adviseForkContextMode(input: {
	assignment: string;
	context?: string;
	explicitMode?: ForkContextMode;
	parentContextTokens?: number;
}): ForkContextAdvisory {
	const parentContextTokens = input.parentContextTokens ?? 0;
	const estimatedClonedTokens = estimateClonedTokens(parentContextTokens);

	if (input.explicitMode !== undefined) {
		return {
			recommendedMode: input.explicitMode,
			reasons: ["explicit-caller-mode"],
			estimatedClonedTokens,
			callerModeRespected: true,
		};
	}

	const text = `${input.assignment}\n${input.context ?? ""}`;
	const reasons: string[] = [];
	let recommendedMode: ForkContextMode = "none";

	for (const trigger of LAST_TURN_TRIGGERS) {
		if (trigger.pattern.test(text)) {
			reasons.push(trigger.reason);
			recommendedMode = "last-turn";
		}
	}

	for (const trigger of RECEIPT_TRIGGERS) {
		if (trigger.pattern.test(text)) {
			reasons.push(trigger.reason);
			if (recommendedMode === "none") {
				recommendedMode = "receipt";
			}
		}
	}

	return {
		recommendedMode,
		reasons,
		estimatedClonedTokens,
		callerModeRespected: true,
	};
}
