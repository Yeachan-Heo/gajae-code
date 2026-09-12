/**
 * Regression test: the GJC agent loop must never dispatch a Devin tool call.
 *
 * ACP agents execute their own tools, so the Devin provider renders
 * `tool_call`/`tool_call_update` notifications as display-only transcript
 * entries. The agent loop dispatches every `toolCall` block it is not told to
 * skip, so this test drives the real loop with the real provider (against the
 * ACP agent fixture over stdio) and a recording `bash` tool whose only job is to
 * prove local execution never happens.
 *
 * Devin CLI itself is not installed here: the traffic is fixture traffic and no
 * live Devin session is claimed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Agent, type AgentEvent, type AgentTool } from "@gajae-code/agent-core";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@gajae-code/ai";
import {
	DEVIN_ACP_BASE_URL,
	DEVIN_ACP_CONTEXT_WINDOW,
	DEVIN_ACP_MAX_TOKENS,
	streamDevinAcp,
} from "@gajae-code/ai/providers/devin-acp";
import { isProviderResolvedToolCall } from "@gajae-code/ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";

const ACP_FIXTURE = path.resolve(import.meta.dir, "../../ai/test/fixtures/devin-acp-agent.ts");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ZERO_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function devinModel(): Model<"devin-acp"> {
	return {
		id: "adaptive",
		name: "adaptive",
		api: "devin-acp",
		provider: "devin",
		baseUrl: DEVIN_ACP_BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEVIN_ACP_CONTEXT_WINDOW,
		maxTokens: DEVIN_ACP_MAX_TOKENS,
	};
}

function scriptedStop(text: string): AsyncIterable<AssistantMessageEvent> & {
	result(): Promise<AssistantMessage>;
} {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({
			type: "done",
			reason: "stop",
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				api: "devin-acp",
				provider: "devin",
				model: "adaptive",
				usage: ZERO_USAGE,
				stopReason: "stop",
				timestamp: Date.now(),
			},
		});
		stream.end();
	});
	return stream;
}

const cleanup: Array<() => void> = [];

afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
});

describe("devin tool-call dispatch boundary", () => {
	test("the agent loop executes no Devin tool call and emits no tool result", async () => {
		await expectNoDevinDispatch(undefined);
	});

	test("managed fallback runs still execute no Devin tool call", async () => {
		await expectNoDevinDispatch({ fallbackManaged: true });
	});

	async function expectNoDevinDispatch(promptOptions: { fallbackManaged: boolean } | undefined): Promise<void> {
		const invocations: unknown[] = [];
		const bashTool = {
			name: "bash",
			label: "bash",
			description: "records any local execution of a Devin-issued tool call",
			parameters: { type: "object", properties: { command: { type: "string" } }, additionalProperties: true },
			async execute(_id: string, params: unknown) {
				invocations.push(params);
				return { content: [{ type: "text" as const, text: "LOCAL_BASH_EXECUTED" }] };
			},
		} as unknown as AgentTool;

		let calls = 0;
		let providerStream: AssistantMessageEventStream | undefined;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: devinModel(), systemPrompt: ["test"], tools: [bashTool], messages: [] },
			streamFn: ((model: unknown, context: Context, options: Record<string, unknown>) => {
				calls += 1;
				if (calls > 1) return scriptedStop("second turn");
				providerStream = streamDevinAcp(model as Model<"devin-acp">, context, {
					...options,
					devinAcp: { cliPath: process.execPath, cliArgs: [ACP_FIXTURE, "chat"] },
					providerSessionId: "devin-dispatch-regression",
				});
				return providerStream;
			}) as never,
		});

		const toolEvents: AgentEvent[] = [];
		let firstAssistant: AssistantMessage | undefined;
		agent.subscribe(event => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") toolEvents.push(event);
			if (event.type === "message_end" && (event as { message?: AssistantMessage }).message?.role === "assistant") {
				firstAssistant ??= (event as { message: AssistantMessage }).message;
			}
		});

		await agent.prompt("run the tests", promptOptions as never);
		const providerMessage = await providerStream!.result();

		const providerToolCall = providerMessage.content.find(block => block.type === "toolCall");
		// The fixture's `chat` scenario reports a `kind: execute` tool call, so the
		// provider renders it under the local `bash` display name — and marks it so
		// the loop cannot dispatch it.
		expect(providerToolCall?.type === "toolCall" && providerToolCall.name).toBe("bash");
		expect(providerToolCall !== undefined && isProviderResolvedToolCall(providerToolCall)).toBe(true);
		expect(providerMessage.stopReason).not.toBe("toolUse");
		// The loop-visible message is an event snapshot (spreads drop symbol keys),
		// so the dispatch boundary is proven by what the loop did, not by that copy.
		expect(firstAssistant?.content.some(block => block.type === "toolCall")).toBe(true);
		expect(invocations).toEqual([]);
		expect(toolEvents).toEqual([]);
	}

	test("an aborted turn fabricates no tool result for a Devin tool call", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-devin-abort-"));
		tempDirs.push(dir);
		const receipt = path.join(dir, "toolcall-receipt.json");
		const invocations: unknown[] = [];
		const bashTool = {
			name: "bash",
			label: "bash",
			description: "records local execution",
			parameters: { type: "object", properties: { command: { type: "string" } }, additionalProperties: true },
			async execute(_id: string, params: unknown) {
				invocations.push(params);
				return { content: [{ type: "text" as const, text: "LOCAL_BASH_EXECUTED" }] };
			},
		} as unknown as AgentTool;

		const toolEvents: AgentEvent[] = [];
		let providerStream: AssistantMessageEventStream | undefined;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: devinModel(), systemPrompt: ["test"], tools: [bashTool], messages: [] },
			streamFn: ((model: unknown, context: Context, options: Record<string, unknown>) => {
				providerStream = streamDevinAcp(model as Model<"devin-acp">, context, {
					...options,
					devinAcp: {
						cliPath: process.execPath,
						cliArgs: [ACP_FIXTURE, "toolcall-then-wait", receipt],
					},
					providerSessionId: "devin-abort-regression",
				});
				return providerStream;
			}) as never,
		});
		agent.subscribe(event => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") toolEvents.push(event);
		});

		const sawToolCall = (): boolean => {
			try {
				return (JSON.parse(fs.readFileSync(receipt, "utf8")) as { toolCallSent?: boolean }).toolCallSent === true;
			} catch {
				return false;
			}
		};
		const run = agent.prompt("run the tests");
		for (let attempt = 0; attempt < 120 && !sawToolCall(); attempt += 1) await Bun.sleep(25);
		expect(sawToolCall()).toBe(true);
		agent.abort();
		await run;

		const aborted = agent.state.messages.findLast(message => message.role === "assistant") as
			| AssistantMessage
			| undefined;
		const phantomResults = agent.state.messages.filter(
			message => message.role === "toolResult" && message.toolCallId === "call-abort",
		);
		expect(aborted?.stopReason).toBe("aborted");
		expect(invocations).toEqual([]);
		expect(toolEvents).toEqual([]);
		expect(phantomResults).toEqual([]);
	});

	test("marks Devin tool calls as provider-resolved while plain tool calls still dispatch", async () => {
		const invocations: unknown[] = [];
		const bashTool = {
			name: "bash",
			label: "bash",
			description: "records local execution",
			parameters: { type: "object", properties: { command: { type: "string" } }, additionalProperties: true },
			async execute(_id: string, params: unknown) {
				invocations.push(params);
				return { content: [{ type: "text" as const, text: "LOCAL_BASH_EXECUTED" }] };
			},
		} as unknown as AgentTool;

		// Control: an unmarked tool call with the same name and arguments must still
		// be dispatched, so the assertion above cannot pass for the wrong reason.
		let calls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: devinModel(), systemPrompt: ["test"], tools: [bashTool], messages: [] },
			streamFn: ((model: Model<"devin-acp">) => {
				calls += 1;
				if (calls > 1) return scriptedStop("done");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message: AssistantMessage = {
						role: "assistant",
						content: [{ type: "toolCall", id: "local-1", name: "bash", arguments: { command: "echo local" } }],
						api: "devin-acp",
						provider: "devin",
						model: model.id,
						usage: ZERO_USAGE,
						stopReason: "toolUse",
						timestamp: Date.now(),
					};
					stream.push({
						type: "toolcall_end",
						contentIndex: 0,
						toolCall: message.content[0] as never,
						partial: message,
					});
					stream.push({ type: "done", reason: "toolUse", message });
					stream.end();
				});
				return stream;
			}) as never,
		});

		await agent.prompt("run a local command");
		expect(invocations).toEqual([{ command: "echo local" }]);
	});
});
