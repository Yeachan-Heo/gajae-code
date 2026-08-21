import { afterEach, describe, expect, test } from "bun:test";
import type { AssistantMessageEvent, Message, Model, SimpleStreamOptions } from "@gajae-code/ai";
import * as z from "zod/v4";
import { agentLoop } from "../src/agent-loop";
import { streamProxy } from "../src/proxy";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types";
import { createUserMessage } from "./helpers";

type EmptySchema = z.ZodObject<Record<string, never>>;
type TestTool = AgentTool<EmptySchema, Record<string, never>>;

const model: Model = {
	id: "test",
	name: "test",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
};

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function installProxyEvents(events: Array<Record<string, unknown>>): void {
	(
		globalThis as {
			fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;
		}
	).fetch = async () =>
		new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
			headers: { "Content-Type": "text/event-stream" },
		});
}
/** Serve one SSE body per fetch, in order — each body is exactly one assistant message, as a real proxy does. */
function installProxyResponses(responses: Array<Array<Record<string, unknown>>>): void {
	let next = 0;
	(
		globalThis as {
			fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;
		}
	).fetch = async () => {
		const events = responses[next];
		next += 1;
		return new Response((events ?? []).map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
			headers: { "Content-Type": "text/event-stream" },
		});
	};
}

async function collectEvents(): Promise<AssistantMessageEvent[]> {
	return Array.fromAsync(
		streamProxy(model, { messages: [] }, { authToken: "test", proxyUrl: "https://proxy.example.test" }),
	);
}

function countingTool(name: string, counter: { n: number }): TestTool {
	return {
		name,
		label: name,
		description: `The ${name} tool`,
		parameters: z.object({}),
		lenientArgValidation: true,
		async execute() {
			counter.n += 1;
			return { content: [{ type: "text", text: "executed locally" }], details: {} };
		},
	} as unknown as TestTool;
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

// The proxy server runs the provider (Cursor) and relays its assistant stream
// over the stripped wire protocol. Cursor executes its native tools during
// streaming, so the server must relay `providerExecuted` on `toolcall_start`
// and the client must reconstruct the marker — otherwise the agent loop
// dispatches the already-executed call a second time over the local `bash`
// tool. This is the end-to-end serialization-boundary companion to the direct
// object-path tests in agent-loop-provider-executed-toolcall.test.ts.
describe("streamProxy provider-executed tool calls cross the wire", () => {
	test("reconstructs the providerExecuted marker from toolcall_start", async () => {
		installProxyEvents([
			{ type: "start" },
			{
				type: "toolcall_start",
				contentIndex: 0,
				id: "call-1",
				toolName: "bash",
				providerExecuted: "cursor-exec",
			},
			{
				type: "toolcall_end",
				contentIndex: 0,
				arguments: { command: "rm -rf build" },
				providerExecutionResult: { status: "success", output: "provider output" },
			},
			{ type: "done", reason: "stop", usage },
		]);

		const events = await collectEvents();
		const ended = events.find(event => event.type === "toolcall_end");
		expect(ended?.type).toBe("toolcall_end");
		if (ended?.type !== "toolcall_end") throw new Error("expected a toolcall_end event");
		expect(ended.toolCall.providerExecuted).toBe("cursor-exec");
		expect(ended.toolCall.providerExecutionResult).toEqual({ status: "success", output: "provider output" });
		expect(ended.toolCall.arguments).toMatchObject({ command: "rm -rf build" });
	});

	test("ignores malformed provider markers and keeps final ordinary arguments", async () => {
		installProxyEvents([
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call-malformed", toolName: "lookup", providerExecuted: true },
			{ type: "toolcall_end", contentIndex: 0, arguments: { query: "status" } },
			{ type: "done", reason: "stop", usage },
		]);

		const events = await collectEvents();
		const ended = events.find(event => event.type === "toolcall_end");
		if (ended?.type !== "toolcall_end") throw new Error("expected a toolcall_end event");
		expect(ended.toolCall.providerExecuted).toBeUndefined();
		expect(ended.toolCall.arguments).toEqual({ query: "status" });
	});

	test("leaves ordinary wire calls unflagged", async () => {
		installProxyEvents([
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call-2", toolName: "lookup" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"query":"status"}' },
			{ type: "toolcall_end", contentIndex: 0 },
			{ type: "done", reason: "stop", usage },
		]);

		const events = await collectEvents();
		const ended = events.find(event => event.type === "toolcall_end");
		if (ended?.type !== "toolcall_end") throw new Error("expected a toolcall_end event");
		expect(ended.toolCall.providerExecuted).toBeUndefined();
	});

	test("does not re-execute a provider-executed call that crossed the proxy", async () => {
		// The provider side (behind the proxy) already ran this bash call during
		// streaming and relays the marker. The loop must record the synthetic
		// provider-executed result and never touch the local tool.
		installProxyResponses([
			[
				{ type: "start" },
				{
					type: "toolcall_start",
					contentIndex: 0,
					id: "call-3",
					toolName: "bash",
					providerExecuted: "cursor-exec",
				},
				{ type: "toolcall_delta", contentIndex: 0, delta: '{"command":"echo ran-on-the-provider"}' },
				{
					type: "toolcall_end",
					contentIndex: 0,
					providerExecutionResult: { status: "success", output: "provider output" },
				},
				{ type: "done", reason: "toolUse", usage },
			],
			[
				{ type: "start" },
				{ type: "text_start", contentIndex: 0 },
				{ type: "text_delta", contentIndex: 0, delta: "done" },
				{ type: "text_end", contentIndex: 0 },
				{ type: "done", reason: "stop", usage },
			],
		]);

		const counter = { n: 0 };
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [],
			tools: [countingTool("bash", counter)],
		};
		const config: AgentLoopConfig = {
			model,
			convertToLlm: identityConverter,
		};
		const streamFn = (
			proxyModel: Model,
			proxyContext: Parameters<typeof streamProxy>[1],
			options?: SimpleStreamOptions,
		) =>
			streamProxy(proxyModel, proxyContext, {
				...options,
				authToken: "test",
				proxyUrl: "https://proxy.example.test",
			});

		const results: Array<{ isError?: boolean; text: string }> = [];
		for await (const event of agentLoop([createUserMessage("go")], context, config, undefined, streamFn)) {
			if (event.type === "tool_execution_end") {
				const first = event.result.content?.[0];
				results.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
			}
		}

		expect(counter.n).toBe(0);
		expect(results).toHaveLength(1);
		expect(results[0]?.isError).toBeFalsy();
		expect(results[0]?.text).toContain("provider output");
		expect(results[0]?.text).not.toContain("executed locally");
	});
});
