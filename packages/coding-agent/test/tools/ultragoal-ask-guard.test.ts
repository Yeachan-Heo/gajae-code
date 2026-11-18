import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@gajae-code/agent-core";
import * as z from "zod/v4";
import { ToolAbortError } from "../../src/tools/tool-errors";
import { guardToolForUltragoalAsk } from "../../src/tools/ultragoal-ask-guard";

function askTool(calls: unknown[]): AgentTool {
	return {
		name: "ask",
		label: "Ask",
		description: "ask",
		parameters: z.object({}),
		async execute(_toolCallId, args) {
			calls.push(args);
			return { content: [{ type: "text" as const, text: "ASKED" }] };
		},
	};
}

describe("guardToolForUltragoalAsk cancellation", () => {
	it("does not invoke ask when the call is aborted during the guard", async () => {
		const calls: unknown[] = [];
		const guarded = guardToolForUltragoalAsk(
			askTool(calls),
			() => "/tmp",
			() => ({}),
			() => "/tmp",
		);
		const controller = new AbortController();
		controller.abort();

		await expect(guarded.execute("ask-1", {}, controller.signal)).rejects.toBeInstanceOf(ToolAbortError);
		expect(calls).toEqual([]);
	});

	it("invokes ask when the call is not aborted", async () => {
		const calls: unknown[] = [];
		const guarded = guardToolForUltragoalAsk(
			askTool(calls),
			() => "/tmp",
			() => ({}),
			() => "/tmp",
		);

		await guarded.execute("ask-1", {}, new AbortController().signal);
		expect(calls).toHaveLength(1);
	});
});
