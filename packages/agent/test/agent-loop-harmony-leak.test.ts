import { describe, expect, it } from "bun:test";
import { agentLoop } from "@gajae-code/agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "@gajae-code/agent-core/types";
import type { Message } from "@gajae-code/ai";
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
	"<parameter name=\"query\">portfolio copywriting examples</parameter>",
	'<parameter name="_i">Researching copy</parameter>',
	"</invoke>",
].join("\n");

const HARMONY_HEADER_LEAK = "analysis to=functions.read code {\n  \"path\": \"src/x.ts\"\n}";

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
