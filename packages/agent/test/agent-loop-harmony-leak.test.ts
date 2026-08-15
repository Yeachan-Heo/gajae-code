import { describe, expect, it } from "bun:test";
import { agentLoop } from "@gajae-code/agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, StreamFn } from "@gajae-code/agent-core/types";
import type { AssistantMessageEvent, Message } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

// A leaked tool-call envelope on the assistant text surface: the openai-codex
// model emitted the `ask` call as visible text instead of a native function
// call (with the `court` glitch line in front), exactly as seen in the wild.
const LEAKED = [
	"call",
	'<invoke name="web_search">',
	'<parameter name="query">portfolio copywriting examples</parameter>',
	'<parameter name="_i">Researching copy</parameter>',
	"</invoke>",
].join("\n");

const HARMONY_HEADER_LEAK = 'analysis to=functions.read code {\n  "path": "src/x.ts"\n}';

function assistantContains(messages: AgentMessage[], needle: string): boolean {
	return messages.some(m => m.role === "assistant" && JSON.stringify(m.content).includes(needle));
}

describe("agent-loop harmony-leak mitigation wiring (openai-codex)", () => {
	it("detects a leaked <invoke> envelope, drops it from history, and retries to a clean turn", async () => {
		const context: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		const mock = createMockModel({
			provider: "openai-codex",
			responses: [{ content: [LEAKED] }, { content: ["ok"] }],
		});
		const audits: Array<{ action: string }> = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			onHarmonyLeak: e => {
				audits.push(e);
			},
		};

		const stream = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream);
		await Array.fromAsync(stream);
		const messages = await stream.result();

		// Detector fired and routed to abort-retry (a text-surface leak is not a
		// recoverable tool-arg leak).
		expect(audits.some(a => a.action === "abort_retry")).toBe(true);
		// Two model calls: the leaked turn + the clean retry.
		expect(mock.calls).toHaveLength(2);
		// The retry produced a clean turn; the leak is not replayed in the output.
		expect(assistantContains(messages, "ok")).toBe(true);
		expect(assistantContains(messages, "<invoke name=")).toBe(false);
		// The contaminated assistant message was dropped from the working context,
		// so the model does not see its own leak as history on the retry.
		expect(assistantContains(context.messages, "<invoke name=")).toBe(false);
	});

	it("publishes a sanitized aborted terminal without replayable native payload before retry", async () => {
		const context: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		const mock = createMockModel({
			provider: "openai-codex",
			responses: [
				{
					content: [LEAKED],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: "openai-codex",
						items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: LEAKED }] }],
					},
					transportFailure: {
						kind: "transport",
						status: 400,
						headers: new Headers({ "x-provider": "live" }) as never,
					},
				},
				{ content: ["ok"] },
			],
		});
		const events: AgentEvent[] = [];
		const callbackEvents: AssistantMessageEvent[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			onAssistantMessageEvent: (_message, event) => callbackEvents.push(event),
		};

		const stream = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream);
		for await (const event of stream) events.push(event);

		const assistantEnds = events.filter(
			(event): event is Extract<AgentEvent, { type: "message_end" }> =>
				event.type === "message_end" && event.message.role === "assistant",
		);
		expect(assistantEnds).toHaveLength(2);
		const retryTerminal = assistantEnds[0]?.message;
		expect(retryTerminal?.role).toBe("assistant");
		if (retryTerminal?.role !== "assistant") throw new Error("Expected assistant retry terminal");
		expect(retryTerminal.stopReason).toBe("aborted");
		expect(retryTerminal.content).toEqual([]);
		expect(retryTerminal.providerPayload).toBeUndefined();
		expect(retryTerminal.transportFailure).toEqual({ kind: "transport", status: 400 });
		expect(() => structuredClone(retryTerminal)).not.toThrow();
		const updateEvents = events.filter(
			(event): event is Extract<AgentEvent, { type: "message_update" }> => event.type === "message_update",
		);
		expect(updateEvents.every(event => "partial" in event.assistantMessageEvent)).toBe(true);
		expect(
			callbackEvents
				.filter(event => event.type !== "done" && event.type !== "error")
				.every(event => "partial" in event),
		).toBe(true);
		expect(JSON.stringify(mock.calls[1]?.context.messages)).not.toContain("<invoke name=");
	});

	it("does not retry a Harmony leak when fallback is managed", async () => {
		const context: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		const mock = createMockModel({
			provider: "openai-codex",
			responses: [{ content: [LEAKED] }, { content: ["unreachable"] }],
		});
		let upstreamRequests = 0;
		const streamFn: StreamFn = (...args) => {
			upstreamRequests++;
			return mock.stream(...args);
		};
		const audits: Array<{ action: string }> = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			fallbackManaged: true,
			onHarmonyLeak: event => {
				audits.push(event);
			},
		};

		const stream = agentLoop([createUserMessage("hi")], context, config, undefined, streamFn);
		await expect(Array.fromAsync(stream)).rejects.toThrow("Detected GPT-5 Harmony protocol leakage");

		expect(upstreamRequests).toBe(1);
		expect(audits.map(audit => audit.action)).toEqual(["escalated"]);
	});

	it("detects a leaked <invoke> envelope for non-codex providers too", async () => {
		const context: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		const mock = createMockModel({
			provider: "anthropic",
			responses: [{ content: [LEAKED] }, { content: ["ok"] }],
		});
		const audits: Array<{ action: string }> = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			onHarmonyLeak: e => {
				audits.push(e);
			},
		};

		const stream = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream);
		await Array.fromAsync(stream);
		const messages = await stream.result();

		expect(audits.some(a => a.action === "abort_retry")).toBe(true);
		expect(mock.calls).toHaveLength(2);
		expect(assistantContains(messages, "ok")).toBe(true);
		expect(assistantContains(messages, "<invoke name=")).toBe(false);
	});

	it("keeps harmony-header mitigation scoped to codex providers", async () => {
		const context: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		const mock = createMockModel({
			provider: "anthropic",
			responses: [{ content: [HARMONY_HEADER_LEAK] }],
		});
		const audits: Array<{ action: string }> = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			onHarmonyLeak: e => {
				audits.push(e);
			},
		};

		const stream = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream);
		await Array.fromAsync(stream);
		const messages = await stream.result();

		expect(audits).toHaveLength(0);
		expect(mock.calls).toHaveLength(1);
		expect(assistantContains(messages, "to=functions.read")).toBe(true);
	});
});
