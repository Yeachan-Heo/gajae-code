import { afterEach, describe, expect, it } from "bun:test";
import { agentLoop } from "@gajae-code/agent-core/agent-loop";
import type { AgentContext, StreamFn } from "@gajae-code/agent-core/types";
import { streamOpenAICompletions } from "@gajae-code/ai/providers/openai-completions";
import type { Model } from "@gajae-code/ai/types";
import * as z from "zod/v4";
import { createUserMessage, identityConverter } from "./helpers";

const savedFetch = global.fetch;
afterEach(() => {
	global.fetch = savedFetch;
});
const model: Model<"openai-completions"> = {
	id: "deepseek-v4-1-flash-1017-uncensored",
	name: "DeepSeek",
	api: "openai-completions",
	provider: "venice",
	baseUrl: "https://example.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};
const malformed = { content: '<｜DSML｜ invoke name="_i" string="true">probe</｜DSML｜ parameter>' };
const structured = {
	tool_calls: [{ index: 0, id: "call_real", type: "function", function: { name: "probe", arguments: "{}" } }],
};
const streamFn: StreamFn = (_model, context, options) =>
	streamOpenAICompletions(model, context, { ...options, apiKey: "test" });

async function run(deltas: Record<string, unknown>[][]) {
	const requests: Array<{ messages: { role: string }[]; tool_choice?: string }> = [];
	let executions = 0;
	global.fetch = Object.assign(
		async (_input: unknown, init?: RequestInit) => {
			const reply = deltas[requests.length];
			requests.push(JSON.parse(String(init?.body)));
			if (!reply) throw new Error("unexpected retry");
			const events = [...reply, {}].map((delta, i) => ({
				id: "test",
				model: model.id,
				choices: [
					{
						index: 0,
						delta,
						finish_reason: i === reply.length ? (reply.some(d => d.tool_calls) ? "tool_calls" : "stop") : null,
					},
				],
			}));
			return new Response(`${events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
		{ preconnect: savedFetch.preconnect },
	);
	const context: AgentContext = {
		systemPrompt: [],
		messages: [],
		tools: [
			{
				name: "probe",
				label: "Probe",
				description: "Read a synthetic value",
				parameters: z.object({}),
				async execute() {
					executions++;
					return { content: [{ type: "text", text: "value" }], details: {} };
				},
			},
		],
	};
	const stream = agentLoop(
		[createUserMessage("look up the value")],
		context,
		{ model, convertToLlm: identityConverter },
		undefined,
		streamFn,
	);
	for await (const _ of stream) {
		/* drain */
	}
	return { requests, executions, messages: await stream.result() };
}

describe("Venice DeepSeek malformed DSML recovery", () => {
	it("resends from clean history and dispatches the valid retry exactly once", async () => {
		const result = await run([[malformed], [structured], [{ content: "done" }]]);
		expect(result.requests).toHaveLength(3);
		expect(result.requests[1].messages).toEqual(result.requests[0].messages);
		expect(result.requests[0].tool_choice).not.toBe("required");
		expect(result.requests[1].tool_choice).toBe("required");
		expect(result.requests[2].tool_choice).not.toBe("required");
		expect(result.executions).toBe(1);
		expect(result.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});
	it("stops after a second malformed response", async () => {
		const result = await run([[malformed], [malformed]]);
		expect(result.requests).toHaveLength(2);
		expect(result.executions).toBe(0);
		expect(result.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorCode: "venice_deepseek_malformed_tool_call",
		});
	});
	it("does not resend a response that carries a genuine structured call", async () => {
		const result = await run([[malformed, structured], [{ content: "done" }]]);
		expect(result.requests).toHaveLength(2);
		expect(result.executions).toBe(1);
	});
});
