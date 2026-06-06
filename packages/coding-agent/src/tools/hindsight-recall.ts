import type { AgentTool, AgentToolResult } from "@gajae-code/agent-core";
import { logger, untilAborted } from "@gajae-code/utils";
import * as z from "zod/v4";
import { formatCurrentTime, formatMemories } from "../hindsight/content";
import recallDescription from "../prompts/tools/recall.md" with { type: "text" };
import type { ToolSession } from ".";

const hindsightRecallSchema = z.object({
	query: z.string().describe("natural language search query"),
});

export type HindsightRecallParams = z.infer<typeof hindsightRecallSchema>;

export class HindsightRecallTool implements AgentTool<typeof hindsightRecallSchema> {
	readonly name = "recall";
	readonly label = "Recall";
	readonly description = recallDescription;
	readonly parameters = hindsightRecallSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): HindsightRecallTool | null {
		if (session.settings.get("memory.backend") !== "hindsight") return null;
		return new HindsightRecallTool(session);
	}

	async execute(_id: string, params: HindsightRecallParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const state = this.session.getHindsightSessionState?.();
			if (!state) {
				throw new Error("Hindsight backend is not initialised for this session.");
			}

			try {
				const response = await state.client.recall(state.bankId, params.query, {
					budget: state.config.recallBudget,
					maxTokens: state.config.recallMaxTokens,
					types: state.config.recallTypes.length > 0 ? state.config.recallTypes : undefined,
					tags: state.recallTags,
					tagsMatch: state.recallTagsMatch,
				});
				const results = response.results ?? [];
				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "No relevant memories found." }],
						details: {},
					};
				}
				const formatted = formatMemories(results);
				return {
					content: [
						{
							type: "text",
							text: `Found ${results.length} relevant memories (as of ${formatCurrentTime()} UTC):\n\n${formatted}`,
						},
					],
					details: {},
				};
			} catch (err) {
				logger.warn("recall failed", { bankId: state.bankId, error: String(err) });
				throw err instanceof Error ? err : new Error(String(err));
			}
		});
	}
}
