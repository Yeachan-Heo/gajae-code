import { describe, expect, it } from "bun:test";
import { agentLoop } from "@gajae-code/agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "@gajae-code/agent-core/types";
import type { AssistantMessage, AssistantMessageEvent, Message } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function incapabilityEvent(): Extract<AssistantMessageEvent, { type: "toolChoiceIncapability" }> {
	return {
		type: "toolChoiceIncapability",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		requestedLevel: "named",
		resolvedLevel: "auto",
		reason: "tool_choice forces tool use is not compatible with this model",
		registryKey: "anthropic-messages|anthropic|https://api.anthropic.com|claude-test",
	};
}

describe("agent-loop toolChoiceIncapability handling", () => {
	it("invokes onToolChoiceIncapability without emitting message_update for the event", async () => {
		const context: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });

		const received: Array<Extract<AssistantMessageEvent, { type: "toolChoiceIncapability" }>> = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			onToolChoiceIncapability: event => {
				received.push(event);
			},
		};

		// Wrap the mock stream so the incapability event is injected before `start`,
		// mirroring transports that discover incapability during a pre-content retry.
		const streamFn = (...args: Parameters<typeof mock.stream>) => {
			const inner = mock.stream(...args);
			const wrapped = new AssistantMessageEventStream();
			void (async () => {
				wrapped.push(incapabilityEvent());
				for await (const event of inner) {
					wrapped.push(event);
				}
				const result = await inner.result();
				wrapped.end(result);
			})();
			return wrapped;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("hi")], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		// Callback consumed the event.
		expect(received).toHaveLength(1);
		expect(received[0]?.resolvedLevel).toBe("auto");

		// No message_update event carries the incapability event; it is non-rendered.
		const updates = events.filter(
			(e): e is Extract<AgentEvent, { type: "message_update" }> => e.type === "message_update",
		);
		expect(updates.every(u => u.assistantMessageEvent.type !== "toolChoiceIncapability")).toBe(true);

		// The turn still completes normally with exactly one assistant message.
		const final = messages[messages.length - 1] as AssistantMessage;
		expect(final.role).toBe("assistant");
		const assistantStarts = events.filter(
			(e): e is Extract<AgentEvent, { type: "message_start" }> =>
				e.type === "message_start" && e.message.role === "assistant",
		);
		expect(assistantStarts).toHaveLength(1);
		expect(events.filter(e => e.type === "turn_end")).toHaveLength(1);
	});

	it("ignores the event silently when no callback is configured", async () => {
		const context: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		const mock = createMockModel({ responses: [{ content: ["fine"] }] });
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const streamFn = (...args: Parameters<typeof mock.stream>) => {
			const inner = mock.stream(...args);
			const wrapped = new AssistantMessageEventStream();
			void (async () => {
				wrapped.push(incapabilityEvent());
				for await (const event of inner) {
					wrapped.push(event);
				}
				wrapped.end(await inner.result());
			})();
			return wrapped;
		};

		const stream = agentLoop([createUserMessage("hi")], context, config, undefined, streamFn);
		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();
		expect((messages[messages.length - 1] as AssistantMessage).stopReason).toBe("stop");
		expect(events.filter(e => e.type === "turn_end")).toHaveLength(1);
	});
});
