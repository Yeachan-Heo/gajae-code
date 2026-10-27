import { expect, test, vi } from "bun:test";
import { Agent, type AgentEvent } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { streamOpenAICodexResponses } from "@gajae-code/ai/providers/openai-codex-responses";
import * as z from "zod/v4";
import { toAgentWireEventPayload } from "../src/modes/shared/agent-wire/event-envelope";
import { providerFailureFromAgentEnd } from "../src/sdk/host/session-runtime";

test("incomplete Codex timeout reaches a bounded SDK terminal without executing the tool", async () => {
	const events = [
		{
			type: "response.output_item.added",
			item: { type: "function_call", id: "fc_timeout", call_id: "call_timeout", name: "todo_write", arguments: "" },
		},
		{
			type: "response.function_call_arguments.delta",
			item_id: "fc_timeout",
			delta: `{"ops":"${"x".repeat(2_530_317)}`,
		},
		{ type: "error", code: "request_timeout", message: "stream closed before response.completed" },
	];
	const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async () =>
				new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
					headers: { "content-type": "text/event-stream" },
				}),
			{ preconnect: globalThis.fetch.preconnect },
		),
	);
	const model: Model<"openai-codex-responses"> = {
		id: "gpt-5.3-codex-spark",
		name: "Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		preferWebsockets: false,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
	};
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
	).toBase64();
	const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "must not execute" }], details: {} }));
	const agent = new Agent({
		initialState: {
			model,
			tools: [{ name: "todo_write", label: "Todo", description: "Update todos", parameters: z.object({}), execute }],
		},
		streamFn: (_model, context) =>
			streamOpenAICodexResponses(model, context, { apiKey: `aaa.${payload}.bbb`, disableProviderRetries: true }),
	});
	const observed: AgentEvent[] = [];
	const unsubscribe = agent.subscribe(event => observed.push(event));
	try {
		await agent.prompt("Update todos");
		const terminal = observed.find(event => event.type === "agent_end");
		expect(terminal).toBeDefined();
		expect(execute).not.toHaveBeenCalled();
		expect(providerFailureFromAgentEnd(terminal)).toMatchObject({
			code: "provider_rejected",
			providerCode: "request_timeout",
		});
		const wire = toAgentWireEventPayload(terminal!);
		expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThan(256 * 1024);
		expect(JSON.stringify(wire)).not.toContain("xxxxx");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	} finally {
		unsubscribe();
		fetchSpy.mockRestore();
	}
});
