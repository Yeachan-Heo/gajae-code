import type { AgentTool, AgentToolResult } from "@gajae-code/agent-core";
import * as z from "zod/v4";
import retainDescription from "../prompts/tools/retain.md" with { type: "text" };
import type { ToolSession } from ".";

const hindsightRetainSchema = z.object({
	items: z
		.array(
			z.object({
				content: z.string().describe("information to remember"),
				context: z.string().describe("source context").optional(),
			}),
		)
		.min(1)
		.describe("memories to retain"),
});

export type HindsightRetainParams = z.infer<typeof hindsightRetainSchema>;
export class HindsightRetainTool implements AgentTool<typeof hindsightRetainSchema> {
	readonly name = "retain";
	readonly label = "Retain";
	readonly description = retainDescription;
	readonly parameters = hindsightRetainSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): HindsightRetainTool | null {
		if (session.settings.get("memory.backend") !== "hindsight") return null;
		return new HindsightRetainTool(session);
	}

	async execute(_id: string, params: HindsightRetainParams): Promise<AgentToolResult> {
		const state = this.session.getHindsightSessionState?.();
		if (!state) {
			throw new Error("Hindsight backend is not initialised for this session.");
		}

		// Push every item onto the session-owned queue and return immediately.
		// The queue flushes either when it reaches its batch threshold or when
		// its debounce timer fires. If the eventual batch fails, the queue
		// surfaces a UI-only warning notice — the LLM is not informed.
		for (const item of params.items) {
			state.enqueueRetain(item.content, item.context);
		}

		const count = params.items.length;
		const noun = count === 1 ? "memory" : "memories";
		return {
			content: [{ type: "text", text: `${count} ${noun} queued.` }],
			details: { count },
		};
	}
}
