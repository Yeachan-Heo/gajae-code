import { afterEach, describe, expect, it, vi } from "bun:test";
import "../src/providers/openai-completions";
import "../src/providers/openai-responses";
import { getBundledModel } from "../src/models";
import {
	KIRO_LAZY_STREAM_LIMITS,
	resolveLazyStreamFirstEventFallbackMs,
	setBedrockProviderModule,
	streamBedrock,
} from "../src/providers/register-builtins";
import { stream as streamModel } from "../src/stream";
import type { AssistantMessage, Context, Model } from "../src/types";
import type { AssistantMessageEventStream } from "../src/utils/event-stream";
import { getStreamIdleTimeoutMs } from "../src/utils/idle-iterator";

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
		expect(result.transportFailure).toBeUndefined();
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
	it("returns 300s for slow-first-event providers without a configured fallback", () => {
		expect(resolveLazyStreamFirstEventFallbackMs("alibaba-token-plan")).toBe(300_000);
		expect(resolveLazyStreamFirstEventFallbackMs("kimi-code")).toBe(300_000);
		expect(resolveLazyStreamFirstEventFallbackMs("kiro")).toBeUndefined();
	});
	it("returns undefined for unrelated providers", () => {
		expect(resolveLazyStreamFirstEventFallbackMs("openai")).toBeUndefined();
		expect(resolveLazyStreamFirstEventFallbackMs("amazon-bedrock")).toBeUndefined();
	});
	it("prefers a configured wrapper fallback over the provider default", () => {
		expect(resolveLazyStreamFirstEventFallbackMs("alibaba-token-plan", 42_000)).toBe(42_000);
		expect(resolveLazyStreamFirstEventFallbackMs("kimi-code", 42_000)).toBe(42_000);
		expect(resolveLazyStreamFirstEventFallbackMs("kiro", 42_000)).toBe(42_000);
		expect(resolveLazyStreamFirstEventFallbackMs("google-gemini-cli", 300_000)).toBe(300_000);
	});
});

describe("kiro lazy-stream idle floor", () => {
	it("owns the first-event floor at the wrapper level for aliased providers", () => {
		expect(KIRO_LAZY_STREAM_LIMITS.defaultFirstEventTimeoutMs).toBe(300_000);
		expect(
			resolveLazyStreamFirstEventFallbackMs("kiro-alias", KIRO_LAZY_STREAM_LIMITS.defaultFirstEventTimeoutMs),
		).toBe(300_000);
	});
	it("widens the steady-state idle watchdog to the first-event floor", () => {
		expect(getStreamIdleTimeoutMs(KIRO_LAZY_STREAM_LIMITS.defaultIdleTimeoutMs)).toBe(300_000);
	});
	it("leaves the shared idle default untouched for other providers", () => {
		expect(getStreamIdleTimeoutMs()).toBe(120_000);
	});
});

describe("outer lazy-stream first-event watchdog (fake timers)", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
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

	function createDelayedSseResponse(delayMs: number, events: unknown[]): Response {
		const encoder = new TextEncoder();
		const payload = `${events
			.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
			.join("\n\n")}\n\n`;
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					setTimeout(() => {
						controller.enqueue(encoder.encode(payload));
						controller.close();
					}, delayMs);
				},
			}),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
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
		expect(result.transportFailure).toMatchObject({
			kind: "transport",
			providerCode: "stream_first_event_timeout",
		});
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
	it("keeps the exported OpenAI Completions lazy path alive past 120s for Alibaba", async () => {
		vi.useFakeTimers();
		const model = getBundledModel("alibaba-token-plan", "glm-5.2") as Model<"openai-completions">;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async () =>
			createDelayedSseResponse(150_000, [
				{
					id: "chatcmpl-delayed",
					object: "chat.completion.chunk",
					created: 0,
					model: model.id,
					choices: [{ index: 0, delta: { content: "Hello delayed" } }],
				},
				{
					id: "chatcmpl-delayed",
					object: "chat.completion.chunk",
					created: 0,
					model: model.id,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: {
						prompt_tokens: 5,
						completion_tokens: 2,
						total_tokens: 7,
						prompt_tokens_details: { cached_tokens: 0 },
					},
				},
				"[DONE]",
			])) as unknown as typeof fetch);

		const lazyStream = streamModel(model, baseContext, { apiKey: "test-key" });
		await flush();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(120_000);
		await flush();
		let settled = false;
		void lazyStream.result().then(() => {
			settled = true;
		});
		await flush();
		expect(settled).toBe(false);

		vi.advanceTimersByTime(30_000);
		await flush();
		const result = await lazyStream.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toContainEqual({ type: "text", text: "Hello delayed" });
	});

	it("keeps the exported OpenAI Responses lazy path alive past 120s for Alibaba", async () => {
		vi.useFakeTimers();
		const model = getBundledModel("alibaba-token-plan", "qwen3.8-max-preview") as Model<"openai-responses">;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async () =>
			createDelayedSseResponse(150_000, [
				{ type: "response.created", response: { id: "resp-delayed" } },
				{
					type: "response.output_item.added",
					item: { type: "message", id: "msg-delayed", role: "assistant", status: "in_progress", content: [] },
				},
				{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
				{ type: "response.output_text.delta", delta: "Hello delayed" },
				{
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "msg-delayed",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Hello delayed" }],
					},
				},
				{
					type: "response.completed",
					response: {
						id: "resp-delayed",
						status: "completed",
						usage: {
							input_tokens: 5,
							output_tokens: 2,
							total_tokens: 7,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			])) as unknown as typeof fetch);

		const lazyStream = streamModel(model, baseContext, { apiKey: "test-key" });
		await flush();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(120_000);
		await flush();
		let settled = false;
		void lazyStream.result().then(() => {
			settled = true;
		});
		await flush();
		expect(settled).toBe(false);

		vi.advanceTimersByTime(30_000);
		await flush();
		const result = await lazyStream.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content[0]).toMatchObject({ type: "text", text: "Hello delayed" });
	});
});
