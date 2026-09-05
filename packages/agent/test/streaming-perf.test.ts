import { expect, it } from "bun:test";
import type { AssistantMessageEvent, Message } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { agentLoop } from "../src/agent-loop";
import { AppendOnlyContextManager } from "../src/append-only-context";
import { createAssistantMessage, createUserMessage } from "./helpers";

class CountingSignal extends EventTarget {
	aborted = false;
	reason: unknown;
	onabort = null;
	listeners = new Set<EventListener | EventListenerObject>();
	addEventListener(
		type: string,
		listener: EventListener | EventListenerObject | null,
		options?: AddEventListenerOptions | boolean,
	): void {
		if (type === "abort" && listener) this.listeners.add(listener);
		if (listener) super.addEventListener(type, listener, options);
	}
	removeEventListener(
		type: string,
		listener: EventListener | EventListenerObject | null,
		options?: EventListenerOptions | boolean,
	): void {
		if (type === "abort" && listener) this.listeners.delete(listener);
		if (listener) super.removeEventListener(type, listener, options);
	}
	throwIfAborted(): void {
		if (this.aborted) throw this.reason;
	}
	abort(): void {
		this.aborted = true;
		this.reason = new Error("cancelled after many events");
		this.dispatchEvent(new Event("abort"));
	}
}

for (const abort of [false, true]) {
	it(`keeps one stream abort listener across 4096 reads (abort=${abort})`, async () => {
		const signal = new CountingSignal();
		const mock = createMockModel();
		const message = createAssistantMessage([{ type: "text", text: "answer" }]);
		let reads = 0;
		let closes = 0;
		class Response extends AssistantMessageEventStream {
			[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
				return {
					next: async () => {
						expect(signal.listeners.size).toBe(1);
						if (reads++ < 4096)
							return {
								done: false,
								value: { type: "text_delta", contentIndex: 0, delta: "x", partial: message },
							};
						if (abort) {
							signal.abort();
							return Promise.withResolvers<IteratorResult<AssistantMessageEvent>>().promise;
						}
						return { done: true, value: undefined };
					},
					return: async () => {
						closes++;
						return { done: true, value: undefined };
					},
				};
			}
		}
		const response = new Response();
		response.end(message);
		const events = agentLoop(
			[createUserMessage("hello")],
			{ systemPrompt: [], messages: [], tools: [] },
			{
				model: mock.model,
				convertToLlm: messages => messages as Message[],
			},
			signal as AbortSignal,
			() => response,
		);
		let aborted = false;
		for await (const event of events) {
			if (event.type === "message_end" && event.message.role === "assistant")
				aborted = event.message.stopReason === "aborted";
		}
		expect(reads).toBe(4097);
		expect(aborted).toBe(abort);
		expect(signal.listeners.size).toBe(0);
		expect(closes).toBe(abort ? 1 : 0);
	});
}

it("appends new history and replaces same-length in-place edits", () => {
	const manager = new AppendOnlyContextManager();
	const messages = [createUserMessage("first")];
	manager.syncMessages(messages);
	messages.push(createUserMessage("second"));
	manager.syncMessages(messages);
	expect(manager.log.toMessages()).toEqual(messages);
	messages[0].content = "rewritten";
	manager.syncMessages(messages);
	expect(manager.log.toMessages()).toEqual(messages);
	expect(manager.log.length).toBe(2);
	manager.syncMessages(messages);
	expect(manager.log.length).toBe(2);
});
