/**
 * RLM research preset: the static research system prompt, the exact tool
 * allowlist, and a hard boundary assertion that fails launch if any
 * non-allowlisted tool is active.
 */
import rlmResearchPrompt from "../prompts/system/rlm-research.md" with { type: "text" };
import type { RlmDataContext } from "./data-context";

/**
 * tool; `read` and `web_search` are the existing built-ins. `bash` is exposed
 * through the read-only restriction profile below for inspection commands only,
 * and `goal` is required so RLM sessions cannot finish without explicit goal
 * completion. Everything else (edit, write, task, skill, browser, eval-js, ...) is excluded.
 */
export const RLM_READ_ONLY_BASH_PREFIXES: readonly string[] = [
	"grep",
	"rg",
	"tree",
	"ls",
	"pwd",
	"wc",
	"du",
	"file",
	"stat",
];
export const RLM_TOOL_ALLOWLIST: readonly string[] = [
	"python",
	"read",
	"web_search",
	"search_tool_bm25",
	"bash",
	"goal",
	"complete_research",
];

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
 * prompt, data context, and prior-notebook replay context to the default blocks.
 */
export function buildRlmSystemPrompt(
	dataContext: RlmDataContext | null,
	resumeContext?: string,
): (defaultPrompt: string[]) => string[] {
	return (defaultPrompt: string[]): string[] => {
		const blocks = [...defaultPrompt, rlmResearchPrompt];
		if (dataContext) {
			blocks.push(`# Data context (from ${dataContext.path})\n\n${dataContext.content}`);
		}
		if (resumeContext && resumeContext.trim().length > 0) {
			blocks.push(`# Prior notebook replay context\n\n${resumeContext}`);
		}
		return blocks;
	};
}
