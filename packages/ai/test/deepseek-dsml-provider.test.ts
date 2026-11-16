import { afterEach, describe, expect, it } from "bun:test";
import { type OpenAICompletionsOptions, streamOpenAICompletions } from "@gajae-code/ai/providers/openai-completions";
import type { AssistantMessage, Model, ToolCall } from "@gajae-code/ai/types";

const originalFetch = global.fetch;
afterEach(() => {
	global.fetch = originalFetch;
});

interface Delta {
	content?: string;
	tool_calls?: Array<{
		index: number;
		id?: string;
		type?: "function";
		function: { name?: string; arguments?: string };
	}>;
}

const model: Model<"openai-completions"> = {
	id: "deepseek-v3",
	name: "DeepSeek",
	api: "openai-completions",
	provider: "test-provider",
	baseUrl: "https://example.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

const wrapperStart = "<｜DSML｜tool_calls>";
const wrapperEnd = "</｜DSML｜tool_calls>";
const invocationStart = '<｜DSML｜invoke name="read"><｜DSML｜parameter name="path" string="true">';
const invocationEnd = "</｜DSML｜parameter></｜DSML｜invoke>";

function structured(argumentsText: string, start = true): NonNullable<Delta["tool_calls"]> {
	return [
		{
			index: 0,
			...(start ? { id: "call_structured", type: "function" as const } : {}),
			function: { ...(start ? { name: "read" } : {}), arguments: argumentsText },
		},
	];
}

async function response(
	deltas: Delta[],
	options: Omit<OpenAICompletionsOptions, "apiKey"> = {},
): Promise<AssistantMessage> {
	const events = [...deltas, {}].map((delta, index) => ({
		id: "chatcmpl-dsml",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [{ index: 0, delta, finish_reason: index === deltas.length ? "stop" : null }],
	}));
	const payload = `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
	global.fetch = Object.assign(
		async () => new Response(payload, { headers: { "content-type": "text/event-stream" } }),
		{ preconnect: originalFetch.preconnect },
	);
	const result = await streamOpenAICompletions(
		model,
		{ messages: [{ role: "user", content: "Read src/index.ts", timestamp: 0 }] },
		{ apiKey: "test", ...options },
	).result();
	expect(result.stopReason).not.toBe("error");
	return result;
}

function tools(result: AssistantMessage): ToolCall[] {
	return result.content.filter((block): block is ToolCall => block.type === "toolCall");
}

function text(result: AssistantMessage): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("");
}

describe("DeepSeek DSML provider streaming", () => {
	it("recovers exactly one invocation split across three content-only deltas", async () => {
		const result = await response([
			{ content: `Before${wrapperStart}${invocationStart}src/` },
			{ content: "index.ts" },
			{ content: `${invocationEnd}${wrapperEnd}After` },
		]);
		expect(tools(result)).toHaveLength(1);
		expect(tools(result)[0].name).toBe("read");
		expect(tools(result)[0].arguments).toEqual({ path: "src/index.ts" });
		expect(tools(result)[0].incompleteArguments).toBeFalsy();
		expect(text(result)).toBe("BeforeAfter");
	});

	it("keeps structured calls authoritative while a suppressed invocation spans content-only deltas", async () => {
		const result = await response([
			{ content: `Before${wrapperStart}${invocationStart}src/`, tool_calls: structured('{"path":"src/') },
			{ content: "index.ts" },
			{ content: invocationEnd },
			{ tool_calls: structured('index.ts"}', false) },
			{ content: `${wrapperEnd}After` },
		]);
		expect(tools(result)).toHaveLength(1);
		expect(tools(result)[0].id).toBe("call_structured");
		expect(tools(result)[0].arguments).toEqual({ path: "src/index.ts" });
		expect(text(result)).toBe("BeforeAfter");
	});

	it("reconciles a completed recovered invocation with matching structured calls in later deltas", async () => {
		const result = await response([
			{ content: `${wrapperStart}${invocationStart}src/` },
			{ content: `index.ts${invocationEnd}${wrapperEnd}` },
			{ tool_calls: structured('{"path":') },
			{ tool_calls: structured('"src/index.ts"}', false) },
		]);
		expect(tools(result)).toHaveLength(1);
		expect(tools(result)[0].id).toBe("call_structured");
		expect(tools(result)[0].arguments).toEqual({ path: "src/index.ts" });
		expect(text(result)).toBe("");
	});

	it("does not expose an executable call when invoke closes with its parameter still open", async () => {
		const result = await response([
			{ content: `Before${wrapperStart}${invocationStart}src/` },
			{ content: "index.ts" },
			{ content: `</｜DSML｜invoke>${wrapperEnd}After` },
		]);
		expect(tools(result).filter(call => !call.incompleteArguments)).toHaveLength(0);
		expect(text(result)).toBe("BeforeAfter");
	});

	it("reconciles a recovered invocation whose parameters arrive in a different key order", async () => {
		const result = await response([
			{
				content:
					wrapperStart +
					'<｜DSML｜invoke name="read"><｜DSML｜parameter name="path" string="true">src/index.ts</｜DSML｜parameter>' +
					'<｜DSML｜parameter name="offset" string="false">10</｜DSML｜parameter></｜DSML｜invoke>' +
					wrapperEnd,
			},
			{ tool_calls: structured('{"offset":10,"path":"src/index.ts"}') },
		]);
		expect(tools(result)).toHaveLength(1);
		expect(tools(result)[0].id).toBe("call_structured");
	});

	it("preserves distinct recovered arguments alongside a structured call with the same name", async () => {
		const result = await response([
			{ content: `${wrapperStart}${invocationStart}other.ts` },
			{ content: invocationEnd },
			{ content: wrapperEnd },
			{ tool_calls: structured('{"path":"src/index.ts"}') },
		]);
		expect(tools(result)).toHaveLength(2);
		expect(tools(result).map(call => call.arguments)).toContainEqual({ path: "other.ts" });
		expect(tools(result).map(call => call.arguments)).toContainEqual({ path: "src/index.ts" });
	});

	it("keeps distinct recovered DSML calls when structured calls are present in same delta", async () => {
		const result = await response([
			{
				content:
					wrapperStart +
					'<｜DSML｜invoke name="write"><｜DSML｜parameter name="path" string="true">out.txt</｜DSML｜parameter></｜DSML｜invoke>' +
					wrapperEnd,
				tool_calls: structured('{"path":"in.txt"}'),
			},
		]);
		// Should have both the recovered write call and the structured read call
		expect(tools(result)).toHaveLength(2);
		const callsByName = Object.fromEntries(tools(result).map(c => [c.name, c]));
		expect(callsByName.write).toBeDefined();
		expect(callsByName.read).toBeDefined();
	});

	it("matches structured calls one-to-one with recovered calls", async () => {
		// Two identical recovered calls followed by one structured call
		// The structured call should suppress exactly one recovered call
		const result = await response([
			{
				content:
					wrapperStart +
					'<｜DSML｜invoke name="read"><｜DSML｜parameter name="path" string="true">file.txt</｜DSML｜parameter></｜DSML｜invoke>' +
					'<｜DSML｜invoke name="read"><｜DSML｜parameter name="path" string="true">file.txt</｜DSML｜parameter></｜DSML｜invoke>' +
					wrapperEnd,
			},
			{ tool_calls: structured('{"path":"file.txt"}') },
		]);
		// Should have 2 calls: one structured (suppressing one recovered) and one unmatched recovered
		expect(tools(result)).toHaveLength(2);
	});

	it("drops recovered calls the request's tool choice forbids", async () => {
		const deltas: Delta[] = [
			{ content: `${wrapperStart}${invocationStart}src/index.ts${invocationEnd}${wrapperEnd}` },
		];
		expect(tools(await response(deltas, { toolChoice: "none" }))).toHaveLength(0);
		expect(tools(await response(deltas, { toolChoice: { type: "tool", name: "write" } }))).toHaveLength(0);
		expect(tools(await response(deltas, { toolChoice: { type: "tool", name: "read" } }))).toHaveLength(1);
	});

	it("uses effective tool_choice from compat.extraBody when no explicit tool_choice is set", async () => {
		// When compat.extraBody.tool_choice is 'none' and options.toolChoice is not set,
		// the effective tool_choice becomes 'none', and recovered DSML calls should not be admitted.
		const testModelWithExtraBody: Model<"openai-completions"> = {
			...model,
			compat: { extraBody: { tool_choice: "none" as const } },
		};
		const deltas: Delta[] = [
			{ content: `${wrapperStart}${invocationStart}src/index.ts${invocationEnd}${wrapperEnd}` },
		];
		const events = [...deltas, {}].map((delta, index) => ({
			id: "chatcmpl-dsml",
			object: "chat.completion.chunk",
			created: 0,
			model: testModelWithExtraBody.id,
			choices: [{ index: 0, delta, finish_reason: index === deltas.length ? "stop" : null }],
		}));
		const payload = `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
		const originalFetchInner = global.fetch;
		global.fetch = Object.assign(
			async () => new Response(payload, { headers: { "content-type": "text/event-stream" } }),
			{ preconnect: originalFetchInner.preconnect },
		);
		try {
			const result = await streamOpenAICompletions(
				testModelWithExtraBody,
				{
					messages: [{ role: "user", content: "Read src/index.ts", timestamp: 0 }],
					tools: [
						{
							name: "read",
							description: "Read a file",
							parameters: { type: "object" as const, properties: {} },
						},
					],
				},
				{
					apiKey: "test",
					// No explicit toolChoice set, so compat.extraBody.tool_choice 'none' should be used
				},
			).result();
			expect(result.stopReason).not.toBe("error");
			// The effective tool_choice is 'none' from compat.extraBody, so recovered calls should not be admitted
			expect(tools(result)).toHaveLength(0);
		} finally {
			global.fetch = originalFetchInner;
		}
	});
});
