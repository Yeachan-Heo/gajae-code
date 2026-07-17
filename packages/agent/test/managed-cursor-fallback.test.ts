import { describe, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import type { Model, SimpleStreamOptions } from "@gajae-code/ai";
import { z } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";

type CursorOptionSnapshot = {
	hasCursorExecHandlers: boolean;
	hasCursorOnToolResult: boolean;
	fallbackManaged: boolean | undefined;
};

function cursorModel(model: Model): Model {
	return { ...model, api: "cursor-agent", provider: "cursor" };
}

describe("managed Cursor fallback", () => {
	it("omits provider-side Cursor hooks and executes accepted tool calls once through the ordinary loop", async () => {
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "write", arguments: { value: "accepted" } }] },
				{ content: ["done"] },
			],
		});
		const calls: CursorOptionSnapshot[] = [];
		let providerHandlerCalls = 0;
		let ordinaryToolCalls = 0;
		const toolSchema = z.object({ value: z.string() });
		const tool: AgentTool<typeof toolSchema> = {
			name: "write",
			label: "Write",
			description: "Writes accepted content",
			parameters: toolSchema,
			execute: async (_id, args) => {
				ordinaryToolCalls += 1;
				return { content: [{ type: "text", text: args.value }] };
			},
		};
		const agent = new Agent({
			initialState: { model: cursorModel(mock.model), systemPrompt: ["test"], tools: [tool], messages: [] },
			cursorExecHandlers: {
				write: async () => {
					providerHandlerCalls += 1;
					return { success: true } as never;
				},
			},
			cursorOnToolResult: async result => {
				providerHandlerCalls += 1;
				return result;
			},
			streamFn: (model, context, options) => {
				calls.push({
					hasCursorExecHandlers: Object.hasOwn(options ?? {}, "cursorExecHandlers"),
					hasCursorOnToolResult: Object.hasOwn(options ?? {}, "cursorOnToolResult"),
					fallbackManaged: options?.fallbackManaged,
				});
				return mock.stream(model, context, options);
			},
		});

		await agent.prompt("run", { fallbackManaged: true });

		expect(calls).toEqual([
			{ hasCursorExecHandlers: false, hasCursorOnToolResult: false, fallbackManaged: true },
			{ hasCursorExecHandlers: false, hasCursorOnToolResult: false, fallbackManaged: true },
		]);
		expect(providerHandlerCalls).toBe(0);
		expect(ordinaryToolCalls).toBe(1);
		expect(agent.state.messages.filter(message => message.role === "toolResult")).toHaveLength(1);
	});

	it("preserves provider-side Cursor hooks for non-managed runs", async () => {
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		let captured: SimpleStreamOptions | undefined;
		const agent = new Agent({
			initialState: { model: cursorModel(mock.model), systemPrompt: ["test"], tools: [], messages: [] },
			cursorExecHandlers: { read: async () => ({}) as never },
			cursorOnToolResult: async result => result,
			streamFn: (model, context, options) => {
				captured = options;
				return mock.stream(model, context, options);
			},
		});

		await agent.prompt("run");

		expect(captured?.cursorExecHandlers).toBeDefined();
		expect(captured?.cursorOnToolResult).toBeDefined();
		expect(captured?.fallbackManaged).toBeUndefined();
	});
});
