/**
 * Session-neutral fixed-context (non-message) token estimation.
 *
 * Lives in the session layer so load-bearing session/compaction behavior
 * (`AgentSession` context estimates) never depends on a presentation module.
 * UI surfaces (`modes/utils/context-usage.ts`, status line) import from here
 * as well, so every surface reports the same numbers.
 */
import { estimateTextTokensHeuristic } from "@gajae-code/agent-core/compaction";
import type { Skill } from "../extensibility/skills";
import type { Tool } from "../tools";
import type { AgentSession } from "./agent-session";

export function estimateSkillsTokens(skills: readonly Skill[]): number {
	const fragments: string[] = [];
	for (const skill of skills) {
		// "- name: description\n" wire framing tokenizes ~identically to the
		// concatenated form, so encode each piece separately and sum.
		fragments.push(skill.name, skill.description);
	}
	return estimateTextTokensHeuristic(fragments);
}

export function estimateToolSchemaTokens(
	tools: ReadonlyArray<Pick<Tool, "name" | "description" | "parameters">>,
): number {
	const fragments: string[] = [];
	for (const tool of tools) {
		fragments.push(tool.name, tool.description);
		try {
			fragments.push(JSON.stringify(tool.parameters ?? {}));
		} catch {
			// Schema may contain functions or cycles; ignore.
		}
	}
	return estimateTextTokensHeuristic(fragments);
}

/**
 * Compute just the NON-MESSAGE token total: system prompt (with its skills
 * section subtracted, since skills are tokenized separately) + system context
 * (the rest of the system-prompt array) + tools + skills.
 *
 * Exposed so callers like `StatusLineComponent` can cache the non-message
 * total separately from the message total. Non-message inputs (skills,
 * tools, system prompt) change rarely; the message list grows on every
 * streaming turn. Splitting the two lets the caller refresh each on its own
 * cadence — non-message recomputed only when the inputs identity changes,
 * messages walked incrementally as new entries append.
 */
export function computeNonMessageTokens(session: AgentSession): number {
	const parts = computeNonMessageBreakdown(session);
	return (
		parts.systemPromptTokens + parts.systemContextTokens + parts.rulesTokens + parts.toolsTokens + parts.skillsTokens
	);
}

/**
 * Shared helper for the four non-message token totals. Single source of truth
 * for `computeNonMessageTokens` (session estimates + status-line incremental
 * cache) and `computeContextBreakdown` (/context panel). The split avoids
 * drift between the surfaces — they MUST report the same numbers.
 */
export function computeNonMessageBreakdown(session: AgentSession): {
	rulesTokens: number;
	skillsTokens: number;
	toolsTokens: number;
	systemContextTokens: number;
	systemPromptTokens: number;
} {
	const skillsTokens = estimateSkillsTokens(session.skills ?? []);
	const toolsTokens = estimateToolSchemaTokens(session.agent?.state?.tools ?? []);
	const systemPromptParts = session.systemPrompt ?? [];
	const rulesTokens = estimateRulesTokens(systemPromptParts);
	const systemContextTokens = estimateTextTokensHeuristic(systemPromptParts.slice(1));
	const systemPromptTokens = Math.max(
		0,
		estimateTextTokensHeuristic(systemPromptParts[0] ?? "") - skillsTokens - rulesTokens,
	);
	return { rulesTokens, skillsTokens, toolsTokens, systemContextTokens, systemPromptTokens };
}

function estimateRulesTokens(systemPromptParts: readonly string[]): number {
	const fragments: string[] = [];
	for (const part of systemPromptParts) {
		for (const match of part.matchAll(/<rules>[\s\S]*?<\/rules>/g)) {
			fragments.push(match[0]);
		}
	}
	return fragments.length === 0 ? 0 : estimateTextTokensHeuristic(fragments);
}
