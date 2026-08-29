import type { AgentTool, AgentToolResult } from "@gajae-code/agent-core";
import { logger, untilAborted } from "@gajae-code/utils";
import * as z from "zod/v4";
import { ensureBankMission } from "../hindsight/bank";
import reflectDescription from "../prompts/tools/reflect.md" with { type: "text" };
import type { ToolSession } from ".";

const hindsightReflectSchema = z.object({
	query: z.string().describe("question to answer"),
	context: z.string().describe("optional context").optional(),
});

export type HindsightReflectParams = z.infer<typeof hindsightReflectSchema>;

export class HindsightReflectTool implements AgentTool<typeof hindsightReflectSchema> {
	readonly name = "reflect";
	readonly label = "Reflect";
	readonly description = reflectDescription;
	readonly parameters = hindsightReflectSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): HindsightReflectTool | null {
		if (session.settings.get("memory.backend") !== "hindsight") return null;
		return new HindsightReflectTool(session);
	}

	async execute(_id: string, params: HindsightReflectParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const state = this.session.getHindsightSessionState?.();
			if (!state) {
				throw new Error("Hindsight backend is not initialised for this session.");
			}
			if (!state.isActive) {
				throw new Error("Hindsight backend is not active for this session.");
			}

			try {
				if (!state.isActive) return noRelevantReflectionResult();
				await ensureBankMission(state.client, state.bankId, state.config, state.missionsSet);
				if (!state.isActive) return noRelevantReflectionResult();
				const response = await state.client.reflect(state.bankId, params.query, {
					context: params.context,
					budget: state.config.recallBudget,
					tags: state.recallTags,
					tagsMatch: state.recallTagsMatch,
				});
				if (!state.isActive) return noRelevantReflectionResult();
				const text = response.text?.trim();
				return {
					content: [{ type: "text", text: text || "No relevant information found to reflect on." }],
					details: {},
				};
			} catch (err) {
				logger.warn("reflect failed", { bankId: state.bankId, error: String(err) });
				throw err instanceof Error ? err : new Error(String(err));
			}
		});
	}
}

function noRelevantReflectionResult(): AgentToolResult {
	return {
		content: [{ type: "text", text: "No relevant information found to reflect on." }],
		details: {},
	};
}
