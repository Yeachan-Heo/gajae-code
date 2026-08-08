import type { ThinkingLevel } from "@gajae-code/agent-core";
import type { Api, AssistantMessage, Model } from "@gajae-code/ai/core";
import { completeSimple, validateToolCall } from "@gajae-code/ai/core";
import { prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import changelogSystemPrompt from "../../commit/prompts/changelog-system.md" with { type: "text" };
import changelogUserPrompt from "../../commit/prompts/changelog-user.md" with { type: "text" };
import { CHANGELOG_CATEGORIES, type ChangelogCategory, type ChangelogGenerationResult } from "../../commit/types";
import { toReasoningEffort } from "../../thinking";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../utils";

const changelogEntryShape = Object.fromEntries(
	CHANGELOG_CATEGORIES.map(c => [c, z.array(z.string()).optional()] as const),
) as Record<ChangelogCategory, z.ZodOptional<z.ZodArray<z.ZodString>>>;

const changelogEntriesSchema = z.object(changelogEntryShape);

export const changelogTool = {
	name: "create_changelog_entries",
	description: "Generate changelog entries grouped by Keep a Changelog categories.",
	parameters: z.object({
		entries: changelogEntriesSchema,
	}),
};

export interface ChangelogPromptInput {
	model: Model<Api>;
	apiKey: string;
	thinkingLevel?: ThinkingLevel;
	changelogPath: string;
	isPackageChangelog: boolean;
	existingEntries?: string;
	stat: string;
	diff: string;
}

export async function generateChangelogEntries({
	model,
	apiKey,
	thinkingLevel,
	changelogPath,
	isPackageChangelog,
	existingEntries,
	stat,
	diff,
}: ChangelogPromptInput): Promise<ChangelogGenerationResult> {
	const userContent = prompt.render(changelogUserPrompt, {
		changelog_path: changelogPath,
		is_package_changelog: isPackageChangelog,
		existing_entries: existingEntries,
		stat,
		diff,
	});
	const response = await completeSimple(
		model,
		{
			systemPrompt: [prompt.render(changelogSystemPrompt)],
			messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
			tools: [changelogTool],
		},
		{ apiKey, maxTokens: 1200, reasoning: toReasoningEffort(thinkingLevel) },
	);

	const parsed = parseChangelogResponse(response);
	return { entries: dedupeEntries(parsed.entries) };
}

function parseChangelogResponse(message: AssistantMessage): ChangelogGenerationResult {
	const toolCall = extractToolCall(message, "create_changelog_entries");
	if (toolCall) {
		const parsed = validateToolCall([changelogTool], toolCall) as z.infer<(typeof changelogTool)["parameters"]>;
		return { entries: parsed.entries ?? {} };
	}

	const text = extractTextContent(message);
	const parsed = parseJsonPayload(text) as ChangelogGenerationResult;
	return { entries: parsed.entries ?? {} };
}

function dedupeEntries(entries: Record<string, string[]>): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const [category, values] of Object.entries(entries)) {
		const seen = new Set<string>();
		const cleaned: string[] = [];
		for (const value of values) {
			const trimmed = value.trim().replace(/\.$/, "");
			const key = trimmed.toLowerCase();
			if (!trimmed || seen.has(key)) continue;
			seen.add(key);
			cleaned.push(trimmed);
		}
		if (cleaned.length > 0) {
			result[category] = cleaned;
		}
	}
	return result;
}
