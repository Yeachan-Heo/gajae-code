import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	resolveLazyStreamFirstEventFallbackMs,
	setBedrockProviderModule,
	streamBedrock,
} from "../src/providers/register-builtins";
import type { AssistantMessage, Context, Model } from "../src/types";
import type { AssistantMessageEventStream } from "../src/utils/event-stream";

function createModel(): Model<"bedrock-converse-stream"> {
	return {
		id: "mock-bedrock",
		name: "Mock Bedrock",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: errorMessage ? `error: ${errorMessage}` : "ok" }],
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		model: "mock-bedrock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

const baseContext: Context = { messages: [] };

describe("register-builtins lazy streams", () => {
	it("resolves the outer stream result from source.result() when no terminal event is iterated", async () => {
		const finalMessage = createAssistantMessage("stop");
		const partialMessage = createAssistantMessage("stop");
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
			},
			result: async () => finalMessage,
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: () => source,
		});

		const stream = streamBedrock(createModel(), baseContext, {});
		const result = await Promise.race([stream.result(), Bun.sleep(100).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded stream result");
		}
		expect(result).toEqual(finalMessage);
	});

	it("turns iterator failures into terminal error results", async () => {
		const partialMessage = createAssistantMessage("stop");
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				throw new Error("bedrock exploded");
			},
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: () => source,
		});

		const stream = streamBedrock(createModel(), baseContext, {});
		const result = await Promise.race([stream.result(), Bun.sleep(100).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded error result");
		}
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("bedrock exploded");
	});

	it("turns idle lazy provider streams into retryable terminal errors", async () => {
		const partialMessage = createAssistantMessage("stop");
		let providerSignal: AbortSignal | undefined;
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				yield { type: "text_delta", contentIndex: 0, delta: "hello", partial: partialMessage } as const;
				const { promise, reject } = Promise.withResolvers<never>();
				if (providerSignal?.aborted) {
					reject(new Error("Request was aborted"));
				}
				providerSignal?.addEventListener("abort", () => reject(new Error("Request was aborted")), {
					once: true,
				});
				await promise;
			},
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: (_model, _context, options) => {
				providerSignal = options.signal;
				return source;
			},
		});

		const stream = streamBedrock(createModel(), baseContext, { streamIdleTimeoutMs: 10 });
		const result = await Promise.race([stream.result(), Bun.sleep(500).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded stream stall result");
		}
		expect(providerSignal?.aborted).toBe(true);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider stream stalled while waiting for the next event");
	});

	it("preserves caller aborts while forwarding lazy provider streams", async () => {
		const abortController = new AbortController();
		const partialMessage = createAssistantMessage("stop");
		let providerSignal: AbortSignal | undefined;
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				const { promise, reject } = Promise.withResolvers<never>();
				if (providerSignal?.aborted) {
					reject(new Error("Request was aborted"));
				}
				providerSignal?.addEventListener("abort", () => reject(new Error("Request was aborted")), {
					once: true,
				});
				await promise;
			},
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: (_model, _context, options) => {
				providerSignal = options.signal;
				return source;
			},
		});

		const stream = streamBedrock(createModel(), baseContext, {
			signal: abortController.signal,
			streamIdleTimeoutMs: 500,
		});
		const iterator = stream[Symbol.asyncIterator]();
		const firstEvent = await iterator.next();
		expect(firstEvent.value?.type).toBe("start");

		abortController.abort();
		const result = await Promise.race([stream.result(), Bun.sleep(500).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded caller abort result");
		}
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Request was aborted");
	});
});

describe("resolveLazyStreamFirstEventFallbackMs", () => {
	it("returns 300s for alibaba-token-plan without a configured fallback", () => {
		expect(resolveLazyStreamFirstEventFallbackMs("alibaba-token-plan")).toBe(300_000);
	});
	it("returns undefined for unrelated providers", () => {
		expect(resolveLazyStreamFirstEventFallbackMs("openai")).toBeUndefined();
		expect(resolveLazyStreamFirstEventFallbackMs("amazon-bedrock")).toBeUndefined();
	});
	it("prefers a configured wrapper fallback over the provider default", () => {
		expect(resolveLazyStreamFirstEventFallbackMs("alibaba-token-plan", 42_000)).toBe(42_000);
		expect(resolveLazyStreamFirstEventFallbackMs("google-gemini-cli", 300_000)).toBe(300_000);
	});
});

describe("outer lazy-stream first-event watchdog (fake timers)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function createAlibabaModel(): Model<"bedrock-converse-stream"> {
		return { ...createModel(), provider: "alibaba-token-plan" };
	}

	/** Flush pending microtasks so async generators and Promise.race settle. */
	async function flush(ticks = 20): Promise<void> {
		for (let i = 0; i < ticks; i++) await Promise.resolve();
	}

	/**
	 * Creates a source that yields `start` immediately, then delays `delayMs`
	 * (fake-timer controlled) before yielding a text_delta and completing.
	 */
	function createDelayedSource(delayMs: number) {
		const partialMessage = createAssistantMessage("stop");
		const finalMessage = createAssistantMessage("stop");
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				await new Promise<void>(resolve => setTimeout(resolve, delayMs));
				yield { type: "text_delta", contentIndex: 0, delta: "hello", partial: partialMessage } as const;
			},
			result: async () => finalMessage,
		} as unknown as AssistantMessageEventStream;
	}

	/** Creates a source that yields `start` then hangs forever. */
	function createHangingSource() {
		const partialMessage = createAssistantMessage("stop");
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				await new Promise<never>(() => {});
			},
		} as unknown as AssistantMessageEventStream;
	}

	it("alibaba-token-plan survives past the 120s shared default outer watchdog", async () => {
		vi.useFakeTimers();
		// Source emits its first real token at 150s — past the 120s default but
		// well within Alibaba's 300s outer fallback.
		const source = createDelayedSource(150_000);
		setBedrockProviderModule({ streamBedrock: () => source });

		const stream = streamBedrock(createAlibabaModel(), baseContext, {});
		await flush();

		// Advance past the shared 120s default — must NOT timeout.
		vi.advanceTimersByTime(120_000);
		await flush();
		let settled = false;
		void stream.result().then(() => {
			settled = true;
		});
		await flush();
		expect(settled).toBe(false);

		// Advance to 150s — the source emits text_delta and completes.
		vi.advanceTimersByTime(30_000);
		await flush();
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});

	it("alibaba-token-plan times out at 300s when the source never emits", async () => {
		vi.useFakeTimers();
		const source = createHangingSource();
		setBedrockProviderModule({ streamBedrock: () => source });

		const stream = streamBedrock(createAlibabaModel(), baseContext, {});
		await flush();

		// 299s — still alive.
		vi.advanceTimersByTime(299_000);
		await flush();
		let settled = false;
		void stream.result().then(() => {
			settled = true;
		});
		await flush();
		expect(settled).toBe(false);

		// 300s — watchdog fires.
		vi.advanceTimersByTime(1_000);
		await flush();
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider stream timed out while waiting for the first event");
	});

	it("unrelated providers still time out at the 120s shared default", async () => {
		vi.useFakeTimers();
		// Source would emit at 150s, but the generic 120s watchdog fires first.
		const source = createDelayedSource(150_000);
		setBedrockProviderModule({ streamBedrock: () => source });

		const stream = streamBedrock(createModel(), baseContext, {});
		await flush();

		vi.advanceTimersByTime(120_000);
		await flush();
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider stream timed out while waiting for the first event");
	});

	it("explicit streamFirstEventTimeoutMs takes precedence over the Alibaba fallback", async () => {
		vi.useFakeTimers();
		const source = createHangingSource();
		setBedrockProviderModule({ streamBedrock: () => source });

		const stream = streamBedrock(createAlibabaModel(), baseContext, {
			streamFirstEventTimeoutMs: 60_000,
		});
		await flush();

		// 59s — still alive.
		vi.advanceTimersByTime(59_000);
		await flush();
		let settled = false;
		void stream.result().then(() => {
			settled = true;
		});
		await flush();
		expect(settled).toBe(false);

		// 60s — explicit override fires well before the 300s Alibaba fallback.
		vi.advanceTimersByTime(1_000);
		await flush();
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider stream timed out while waiting for the first event");
	});
});
