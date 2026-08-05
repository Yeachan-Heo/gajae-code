import type { AssistantMessage } from "@gajae-code/ai/core";
import { validateToolCall } from "@gajae-code/ai/core";
import * as z from "zod/v4";
import type { ChangelogCategory, ConventionalAnalysis } from "./types";
import { extractTextContent, extractToolCall, normalizeAnalysis, parseJsonPayload } from "./utils";

const changelogCategoryLiteral = z.enum([
	"Added",
	"Changed",
	"Fixed",
	"Deprecated",
	"Removed",
	"Security",
	"Breaking Changes",
]);

/**
 * Shared Zod schema for the `create_conventional_analysis` tool used by
 * both the single-pass analysis call and the map-reduce reduce phase. Schemas
 * are identical across phases — only the surrounding tool `description`
 * differs to reflect the input the phase is summarizing.
 */
export const conventionalAnalysisParameters = z.object({
	type: z.enum(["feat", "fix", "refactor", "docs", "test", "chore", "style", "perf", "build", "ci", "revert"]),
	scope: z.union([z.string(), z.null()]),
	details: z.array(
		z.object({
			text: z.string(),
			changelog_category: changelogCategoryLiteral.optional(),
			user_visible: z.boolean().optional(),
		}),
	),
	issue_refs: z.array(z.string()),
});

export interface ConventionalAnalysisTool {
	name: "create_conventional_analysis";
	description: string;
	parameters: typeof conventionalAnalysisParameters;
}

/**
 * Build a `create_conventional_analysis` tool descriptor. Phase-specific
 * `description` text is the only thing that varies between callers.
 */
export function createConventionalAnalysisTool(description: string): ConventionalAnalysisTool {
	return {
		name: "create_conventional_analysis",
		description,
		parameters: conventionalAnalysisParameters,
	};
}

interface ParsedConventionalAnalysis {
	type: ConventionalAnalysis["type"];
	scope: string | null;
	details: Array<{ text: string; changelog_category?: ChangelogCategory; user_visible?: boolean }>;
	issue_refs: string[];
}

/**
 * Extract a {@link ConventionalAnalysis} from an assistant response, preferring
 * a structured tool call and falling back to JSON embedded in text content.
 */
export function parseConventionalAnalysisResponse(
	message: AssistantMessage,
	tool: ConventionalAnalysisTool,
): ConventionalAnalysis {
	const toolCall = extractToolCall(message, tool.name);
	if (toolCall) {
		const parsed = validateToolCall([tool], toolCall) as z.infer<typeof conventionalAnalysisParameters>;
		return normalizeAnalysis(parsed);
	}
	const text = extractTextContent(message);
	const parsed = parseJsonPayload(text) as ParsedConventionalAnalysis;
	return normalizeAnalysis(parsed);
}
