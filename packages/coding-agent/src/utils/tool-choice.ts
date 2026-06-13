import type { Api, Model, ResolveToolChoiceResult, ToolChoice } from "@gajae-code/ai";
import { resolveToolChoice } from "@gajae-code/ai";

/**
 * Build a provider-aware tool choice that targets one specific tool when supported.
 * Providers that only expose required/any forcing may still honor named choices by
 * narrowing their request tool list before transport.
 */
export interface NamedToolChoiceResult {
	choice: ToolChoice | undefined;
	exactNamed: boolean;
	resolved?: ResolveToolChoiceResult;
}

export function buildNamedToolChoiceResult(toolName: string, model?: Model<Api>): NamedToolChoiceResult {
	if (!model) return { choice: undefined, exactNamed: false };

	let namedChoice: ToolChoice | undefined;
	let namedShape = false;

	if (model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") {
		namedChoice = { type: "tool", name: toolName };
		namedShape = true;
	} else if (
		model.api === "openai-codex-responses" ||
		model.api === "openai-responses" ||
		model.api === "openai-completions" ||
		model.api === "azure-openai-responses" ||
		model.api === "ollama-chat"
	) {
		namedChoice = { type: "function", name: toolName };
		namedShape = true;
	} else if (
		model.api === "google-generative-ai" ||
		model.api === "google-gemini-cli" ||
		model.api === "google-vertex"
	) {
		namedChoice = "required";
	}

	if (!namedChoice) return { choice: undefined, exactNamed: false };

	const resolved = resolveToolChoice(model, namedChoice);
	const exactNamed = namedShape && resolved.resolvedLevel === "named" && resolved.targetToolName === toolName;
	return {
		choice: exactNamed ? resolved.resolvedChoice : undefined,
		exactNamed,
		resolved,
	};
}

/**
 * Legacy capability-aware wrapper. May return a lossy `"required"` when named
 * forcing degrades (e.g. Google APIs, or compat `toolChoiceSupport: "required"`),
 * which forces *some* tool rather than `toolName` specifically. Queue directives
 * that need exact tool identity (resolve / todo_write / yield) MUST use
 * `buildNamedToolChoiceResult` and gate on `exactNamed` instead.
 */
export function buildNamedToolChoice(toolName: string, model?: Model<Api>): ToolChoice | undefined {
	const result = buildNamedToolChoiceResult(toolName, model);
	return result.choice ?? result.resolved?.resolvedChoice;
}
