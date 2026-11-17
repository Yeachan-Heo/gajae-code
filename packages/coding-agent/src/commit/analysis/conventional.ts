import type { ThinkingLevel } from "@gajae-code/agent-core";
import type { Api, Model } from "@gajae-code/ai/core";
import { completeSimple } from "@gajae-code/ai/core";
import { prompt } from "@gajae-code/utils";
import analysisSystemPrompt from "../../commit/prompts/analysis-system.md" with { type: "text" };
import analysisUserPrompt from "../../commit/prompts/analysis-user.md" with { type: "text" };
import type { ConventionalAnalysis } from "../../commit/types";
import { escapePromptMetadata } from "../../session/messages";
import { toReasoningEffort } from "../../thinking";
import { createConventionalAnalysisTool, parseConventionalAnalysisResponse } from "../shared-llm";

const ConventionalAnalysisTool = createConventionalAnalysisTool(
	"Analyze a diff and return conventional commit classification.",
);

export interface ConventionalAnalysisInput {
	model: Model<Api>;
	apiKey: string;
	thinkingLevel?: ThinkingLevel;
	contextFiles?: Array<{ path: string; content: string }>;
	userContext?: string;
	typesDescription?: string;
	recentCommits?: string[];
	scopeCandidates: string;
	stat: string;
	diff: string;
}

/**
 * Generate conventional analysis data from a diff and metadata.
 */
export async function generateConventionalAnalysis({
	model,
	apiKey,
	thinkingLevel,
	contextFiles,
	userContext,
	typesDescription,
	recentCommits,
	scopeCandidates,
	stat,
	diff,
}: ConventionalAnalysisInput): Promise<ConventionalAnalysis> {
	const userContent = prompt.render(analysisUserPrompt, {
		context_files:
			contextFiles && contextFiles.length > 0
				? contextFiles.map(file => ({
						path: escapePromptMetadata(file.path),
						content: escapePromptMetadata(file.content, { preserveNewlines: true }),
					}))
				: undefined,
		user_context: userContext,
		types_description: typesDescription,
		recent_commits: recentCommits
			?.map(subject => escapePromptMetadata(subject, { preserveNewlines: true }))
			.join("\n"),
		scope_candidates: escapePromptMetadata(scopeCandidates, { preserveNewlines: true }),
		stat: escapePromptMetadata(stat, { preserveNewlines: true }),
		diff: escapePromptMetadata(diff, { preserveNewlines: true }),
	});

	const response = await completeSimple(
		model,
		{
			systemPrompt: [prompt.render(analysisSystemPrompt)],
			messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
			tools: [ConventionalAnalysisTool],
		},
		{ apiKey, maxTokens: 2400, reasoning: toReasoningEffort(thinkingLevel) },
	);

	return parseConventionalAnalysisResponse(response, ConventionalAnalysisTool);
}
