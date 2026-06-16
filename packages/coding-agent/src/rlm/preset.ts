/**
 * RLM research preset: the static research system prompt, the exact tool
 * allowlist, and a hard boundary assertion that fails launch if any
 * non-allowlisted tool is active.
 */
import rlmResearchPrompt from "../prompts/system/rlm-research.md" with { type: "text" };
import type { RlmDataContext } from "./data-context";

/**
 * Tools the model may use in RLM mode. `python` is the RLM research execution
 * tool; `read` and `web_search` are the existing built-ins. Everything else
 * (bash, edit, write, goal, task, skill, browser, eval-js, ...) is excluded.
 */
export const RLM_TOOL_ALLOWLIST: readonly string[] = ["python", "read", "web_search", "search_tool_bm25"];

export function isRlmToolAllowed(name: string): boolean {
	return RLM_TOOL_ALLOWLIST.includes(name.toLowerCase());
}

/**
 * Hard boundary: throws if any active tool is outside the allowlist. Call this
 * after the session's tool registry is fully assembled and before running, so a
 * tool leaked in by defaults/discovery/extensions fails the launch loudly.
 */
export function assertRlmToolAllowlist(activeToolNames: readonly string[]): void {
	const leaked = activeToolNames.filter(name => !isRlmToolAllowed(name));
	if (leaked.length > 0) {
		throw new Error(
			`RLM tool boundary violation: non-allowlisted active tool(s) [${leaked.join(", ")}]. ` +
				`RLM mode allows only: ${RLM_TOOL_ALLOWLIST.join(", ")}.`,
		);
	}
}

/** The research prompt text (exported for testing / prompt assembly). */
export const RLM_RESEARCH_PROMPT: string = rlmResearchPrompt;

/**
 * Build the systemPrompt transform for createAgentSession: appends the research
 * prompt and (when present) the data-context block to the default blocks.
 */
export function buildRlmSystemPrompt(dataContext: RlmDataContext | null): (defaultPrompt: string[]) => string[] {
	return (defaultPrompt: string[]): string[] => {
		const blocks = [...defaultPrompt, rlmResearchPrompt];
		if (dataContext) {
			blocks.push(`# Data context (from ${dataContext.path})\n\n${dataContext.content}`);
		}
		return blocks;
	};
}
