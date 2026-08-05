import type { ThinkingLevel } from "@gajae-code/agent-core";
import type { Api, AssistantMessage, Model } from "@gajae-code/ai/core";
import { completeSimple, validateToolCall } from "@gajae-code/ai/core";
import { prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import summarySystemPrompt from "../../commit/prompts/summary-system.md" with { type: "text" };
import summaryUserPrompt from "../../commit/prompts/summary-user.md" with { type: "text" };
import type { CommitSummary } from "../../commit/types";
import { toReasoningEffort } from "../../thinking";
import { extractTextContent, extractToolCall } from "../utils";

const SummaryTool = {
	name: "create_commit_summary",
	description: "Generate the summary line for a conventional commit message.",
	parameters: z.object({
		summary: z.string(),
	}),
};

export interface SummaryInput {
	model: Model<Api>;
	apiKey: string;
	thinkingLevel?: ThinkingLevel;
	commitType: string;
	scope: string | null;
	details: string[];
	stat: string;
	maxChars: number;
	userContext?: string;
}

/**
 * Generate a commit summary line for the conventional commit header.
 */
export async function generateSummary({
	model,
	apiKey,
	thinkingLevel,
	commitType,
	scope,
	details,
	stat,
	maxChars,
	userContext,
}: SummaryInput): Promise<CommitSummary> {
	const systemPrompt = renderSummaryPrompt({ commitType, scope, maxChars });
	const userPrompt = prompt.render(summaryUserPrompt, {
		user_context: userContext,
		details: details.join("\n"),
		stat,
	});

	const response = await completeSimple(
		model,
		{
			systemPrompt: [systemPrompt],
			messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
			tools: [SummaryTool],
		},
		{ apiKey, maxTokens: 200, reasoning: toReasoningEffort(thinkingLevel) },
	);

	return parseSummaryFromResponse(response, commitType, scope);
}

function renderSummaryPrompt({
	commitType,
	scope,
	maxChars,
}: {
	commitType: string;
	scope: string | null;
	maxChars: number;
}): string {
	const scopePrefix = scope ? `(${scope})` : "";
	return prompt.render(summarySystemPrompt, {
		commit_type: commitType,
		scope_prefix: scopePrefix,
		chars: String(maxChars),
	});
}

function parseSummaryFromResponse(message: AssistantMessage, commitType: string, scope: string | null): CommitSummary {
	const toolCall = extractToolCall(message, "create_commit_summary");
	if (toolCall) {
		const parsed = validateToolCall([SummaryTool], toolCall) as z.infer<(typeof SummaryTool)["parameters"]>;
		return { summary: stripTypePrefix(parsed.summary, commitType, scope) };
	}
	const text = extractTextContent(message);
	return { summary: stripTypePrefix(text, commitType, scope) };
}

export function stripTypePrefix(summary: string, commitType: string, scope: string | null): string {
	const trimmed = summary.trim();
	const scopePart = scope ? `(${scope})` : "";
	const withScope = `${commitType}${scopePart}: `;
	if (trimmed.startsWith(withScope)) {
		return trimmed.slice(withScope.length).trim();
	}
	const withoutScope = `${commitType}: `;
	if (trimmed.startsWith(withoutScope)) {
		return trimmed.slice(withoutScope.length).trim();
	}
	return trimmed;
}
