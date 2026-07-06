// Advisory perf baselines: recording only; hard gating deferred to perf-gates.test.ts.
import { describe, expect, it } from "bun:test";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "@gajae-code/agent-core/types";
import type { AssistantMessage, Message, Model } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { createAssistantMessage, createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

const model: Model = {
	id: "perf-baseline-model",
	name: "Perf Baseline Model",
	api: "openai",
	provider: "openai",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
};

function createConfig(onProviderEvent: () => void): AgentLoopConfig {
	return {
		model,
		convertToLlm: identityConverter,
		onAssistantMessageEvent() {
			onProviderEvent();
		},
	};
}

function createContext(): AgentContext {
	return {
		systemPrompt: ["You are helpful."],
		messages: [],
		tools: [],
	};
}

function createDeterministicDeltaStream(deltaCount: number) {
	return () => {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			const partial = createAssistantMessage([], "stop");
			stream.push({ type: "start", partial });

			partial.content.push({ type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex: 0, partial });

			for (let i = 0; i < deltaCount; i++) {
				const delta = `t${i % 10}`;
				(partial.content[0] as { type: "text"; text: string }).text += delta;
				stream.push({ type: "text_delta", contentIndex: 0, delta, partial });
			}

			const text = (partial.content[0] as { type: "text"; text: string }).text;
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
			stream.push({ type: "done", reason: "stop", message: partial });
		});
		return stream;
	};
}

function expectFiniteNonNegative(value: number): void {
	expect(Number.isFinite(value)).toBe(true);
	expect(value).toBeGreaterThanOrEqual(0);
}
describe("agent loop advisory performance baselines", () => {
	it("records message_update fan-out and shallow-copy proxy counts for a deterministic delta stream", async () => {
		const deltaCount = 128;
		let providerMessageEvents = 0;
		const config = createConfig(() => providerMessageEvents++);
		const events: AgentEvent[] = [];
		const { agentLoop } = await import("@gajae-code/agent-core/agent-loop");
		const stream = agentLoop(
			[createUserMessage("stream deterministic deltas")],
			createContext(),
			config,
			undefined,
			createDeterministicDeltaStream(deltaCount),
		);

		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		const messageUpdates = events.filter(
			(event): event is Extract<AgentEvent, { type: "message_update" }> => event.type === "message_update",
		);
		const shallowMessageCopies = messageUpdates.filter(
			update => update.message !== (update.assistantMessageEvent as { partial?: AssistantMessage }).partial,
		).length;
		const baseline = {
			deltaCount,
			providerMessageEvents,
			messageUpdateEvents: messageUpdates.length,
			shallowMessageCopies,
			agentEvents: events.length,
			eventsPerStream: events.length,
		};

		console.log(`[perf-baseline] agent-loop-message-update-fanout ${JSON.stringify(baseline)}`);

		expect(messages.at(-1)?.role).toBe("assistant");
		expect(providerMessageEvents).toBeGreaterThan(0);
		expect(messageUpdates.length).toBeGreaterThan(0);
		// Value may legitimately drop to 0 when the corresponding REPORT.md fix lands.
		expectFiniteNonNegative(shallowMessageCopies);
		expect(Number.isFinite(baseline.eventsPerStream)).toBe(true);
		expect(Number.isFinite(baseline.shallowMessageCopies)).toBe(true);
	});
});
