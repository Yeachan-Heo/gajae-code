import { afterEach, describe, expect, it, vi } from "bun:test";
import "../src/providers/azure-openai-responses";
import "../src/providers/openai-codex-responses";
import "../src/providers/openai-completions";
import "../src/providers/openai-responses";
import { getBundledModel } from "../src/models";
import {
	resolveLazyStreamFirstEventFallbackMs,
	setBedrockProviderModule,
	streamBedrock,
} from "../src/providers/register-builtins";
import { stream as streamModel, streamSimple } from "../src/stream";
import type { AssistantMessage, Context, Model } from "../src/types";
import type { AssistantMessageEventStream } from "../src/utils/event-stream";
import { withEnv } from "./helpers";

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

function createCodexTestToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
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
	it("fires streamSimple admission only when the lazy provider is invoked", async () => {
		const finalMessage = createAssistantMessage("stop");
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: finalMessage } as const;
				yield { type: "text_delta", contentIndex: 0, delta: "ok", partial: finalMessage } as const;
			},
			result: async () => finalMessage,
		} as unknown as AssistantMessageEventStream;
		let admitted = false;
		let moduleStreamCalled = false;

		setBedrockProviderModule({
			streamBedrock: () => {
				expect(admitted).toBe(false);
				moduleStreamCalled = true;
				return source;
			},
		});

		const stream = streamSimple(createModel(), baseContext, {
			onStreamCreated: () => {
				expect(moduleStreamCalled).toBe(true);
				admitted = true;
			},
		});
		expect(admitted).toBe(false);
		await stream.result();
		expect(admitted).toBe(true);
		expect(moduleStreamCalled).toBe(true);
	});

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

	it("aborts the lazy provider request when the public stream consumer returns early", async () => {
		const partialMessage = createAssistantMessage("stop");
		let providerSignal: AbortSignal | undefined;
		let providerAborted = false;
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				const { promise, reject } = Promise.withResolvers<never>();
				providerSignal?.addEventListener(
					"abort",
					() => {
						providerAborted = true;
						reject(new Error("Request was aborted"));
					},
					{ once: true },
				);
				await promise;
			},
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: (_model, _context, options) => {
				providerSignal = options.signal;
				return source;
			},
		});

		const stream = streamBedrock(createModel(), baseContext, {});
		const iterator = stream[Symbol.asyncIterator]();
		expect((await iterator.next()).done).toBe(false);
		await iterator.return?.();
		await Bun.sleep(0);

		expect(providerSignal?.aborted).toBe(true);
		expect(providerAborted).toBe(true);
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
	it("returns each slow provider's centralized first-event fallback", () => {
		expect(resolveLazyStreamFirstEventFallbackMs("alibaba-token-plan")).toBe(600_000);
		expect(resolveLazyStreamFirstEventFallbackMs("lm-studio")).toBe(300_000);
		expect(resolveLazyStreamFirstEventFallbackMs("kimi-code")).toBe(300_000);
	});
	it("returns undefined for unrelated providers", () => {
		expect(resolveLazyStreamFirstEventFallbackMs("openai")).toBeUndefined();
		expect(resolveLazyStreamFirstEventFallbackMs("amazon-bedrock")).toBeUndefined();
	});
	it("prefers a configured wrapper fallback over the provider default", () => {
		expect(resolveLazyStreamFirstEventFallbackMs("alibaba-token-plan", 42_000)).toBe(42_000);
		expect(resolveLazyStreamFirstEventFallbackMs("kimi-code", 42_000)).toBe(42_000);
		expect(resolveLazyStreamFirstEventFallbackMs("google-gemini-cli", 300_000)).toBe(300_000);
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

	function createStagedSseResponse(stages: ReadonlyArray<{ delayMs: number; events: unknown[] }>): Response {
		const encoder = new TextEncoder();
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					stages.forEach((stage, index) => {
						setTimeout(() => {
							const payload = `${stage.events
								.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
								.join("\n\n")}\n\n`;
							controller.enqueue(encoder.encode(payload));
							if (index === stages.length - 1) controller.close();
						}, stage.delayMs);
					});
				},
			}),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	}

	it("alibaba-token-plan survives past the previous 300s outer watchdog", async () => {
		vi.useFakeTimers();
		// Source emits its first real token at 310s — past the previous Alibaba
		// floor but well within the widened 600s fallback.
		const source = createDelayedSource(310_000);
		setBedrockProviderModule({ streamBedrock: () => source });

		const stream = streamBedrock(createAlibabaModel(), baseContext, {});
		await flush();

		// Advance past the previous 300s Alibaba floor — must NOT timeout.
		vi.advanceTimersByTime(300_000);
		await flush();
		let settled = false;
		void stream.result().then(() => {
			settled = true;
		});
		await flush();
		expect(settled).toBe(false);

		// Advance to 310s — the source emits text_delta and completes.
		vi.advanceTimersByTime(10_000);
		await flush();
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});

	it("alibaba-token-plan times out at 600s when the source never emits", async () => {
		vi.useFakeTimers();
		const source = createHangingSource();
		setBedrockProviderModule({ streamBedrock: () => source });

		const stream = streamBedrock(createAlibabaModel(), baseContext, {});
		await flush();

		// 599s — still alive.
		vi.advanceTimersByTime(599_000);
		await flush();
		let settled = false;
		void stream.result().then(() => {
			settled = true;
		});
		await flush();
		expect(settled).toBe(false);

		// 600s — watchdog fires.
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
		expect(result.transportFailure).toMatchObject({
			kind: "transport",
			providerCode: "stream_first_event_timeout",
		});
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

		// 60s — explicit override fires well before the 600s Alibaba fallback.
		vi.advanceTimersByTime(1_000);
		await flush();
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider stream timed out while waiting for the first event");
	});

	it("keeps tool-capability negotiation inside the first-event window", async () => {
		vi.useFakeTimers();
		const source = {
			async *[Symbol.asyncIterator]() {
				yield {
					type: "toolChoiceIncapability",
					api: "bedrock-converse-stream",
					provider: "amazon-bedrock",
					model: "mock-bedrock",
					requestedLevel: "required",
					resolvedLevel: "auto",
					reason: "tool choice unsupported",
					registryKey: "tool-choice/required",
				} as const;
				await new Promise<never>(() => {});
			},
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: () => source,
		});

		const stream = streamBedrock(createModel(), baseContext, {
			streamIdleTimeoutMs: 10,
			streamFirstEventTimeoutMs: 100,
		});
		await flush();

		let settled = false;
		void stream.result().then(() => {
			settled = true;
		});
		vi.advanceTimersByTime(20);
		await flush();
		expect(settled).toBe(false);

		vi.advanceTimersByTime(80);
		await flush();
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider stream timed out while waiting for the first event");
		expect(result.transportFailure).toMatchObject({
			kind: "transport",
			providerCode: "stream_first_event_timeout",
		});
	});

	it("keeps the exported OpenAI Completions lazy path alive past 300s for Alibaba", async () => {
		vi.useFakeTimers();
		const model = getBundledModel("alibaba-token-plan", "glm-5.2") as Model<"openai-completions">;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async () =>
			createDelayedSseResponse(310_000, [
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

		vi.advanceTimersByTime(300_000);
		await flush();
		let settled = false;
		void lazyStream.result().then(() => {
			settled = true;
		});
		await flush();
		expect(settled).toBe(false);

		vi.advanceTimersByTime(10_000);
		await flush();
		const result = await lazyStream.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toContainEqual({ type: "text", text: "Hello delayed" });
	});

	it("keeps the exported OpenAI Responses lazy path alive past 300s for Alibaba", async () => {
		vi.useFakeTimers();
		const model = getBundledModel("alibaba-token-plan", "qwen3.8-max-preview") as Model<"openai-responses">;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async () =>
			createDelayedSseResponse(310_000, [
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

		vi.advanceTimersByTime(300_000);
		await flush();
		let settled = false;
		void lazyStream.result().then(() => {
			settled = true;
		});
		await flush();
		expect(settled).toBe(false);

		vi.advanceTimersByTime(10_000);
		await flush();
		const result = await lazyStream.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content[0]).toMatchObject({ type: "text", text: "Hello delayed" });
	});

	it("does not let the lazy wrapper time out an active OpenAI Codex transport", async () => {
		vi.useFakeTimers();
		const model = {
			...getBundledModel("openai-codex", "gpt-5.5"),
			preferWebsockets: false,
		} as Model<"openai-codex-responses">;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async () =>
			createStagedSseResponse([
				{
					delayMs: 80_000,
					events: [{ type: "response.created", response: { id: "resp-progress" } }],
				},
				{
					delayMs: 150_000,
					events: [
						{
							type: "response.output_item.added",
							item: {
								type: "message",
								id: "msg-progress",
								role: "assistant",
								status: "in_progress",
								content: [],
							},
						},
						{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
						{ type: "response.output_text.delta", delta: "Still alive" },
						{
							type: "response.output_item.done",
							item: {
								type: "message",
								id: "msg-progress",
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text: "Still alive" }],
							},
						},
						{
							type: "response.completed",
							response: {
								id: "resp-progress",
								status: "completed",
								usage: {
									input_tokens: 5,
									output_tokens: 2,
									total_tokens: 7,
									input_tokens_details: { cached_tokens: 0 },
								},
							},
						},
					],
				},
			])) as unknown as typeof fetch);

		const lazyStream = streamModel(model, baseContext, {
			apiKey: createCodexTestToken(),
			preferWebsockets: false,
			streamFirstEventTimeoutMs: 100_000,
			streamIdleTimeoutMs: 100_000,
		});
		const iterator = lazyStream[Symbol.asyncIterator]();
		const firstEvent = await iterator.next();
		expect(firstEvent.value?.type).toBe("start");
		await flush();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(80_000);
		await flush();
		vi.advanceTimersByTime(30_000);
		await flush();

		let settled = false;
		void lazyStream.result().then(() => {
			settled = true;
		});
		await flush();
		expect(settled).toBe(false);

		vi.advanceTimersByTime(40_000);
		await flush();
		const result = await lazyStream.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content[0]).toMatchObject({ type: "text", text: "Still alive" });
	});

	function getRequestSignal(input: string | URL | Request, init: RequestInit | undefined): AbortSignal | undefined {
		if (init?.signal) return init.signal;
		if (input instanceof Request) return input.signal;
		return undefined;
	}

	/** Pre-headers hang: fetch never resolves until the SDK/caller aborts the request signal. */
	function createNeverResolvingFetch(): typeof fetch {
		async function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
			const signal = getRequestSignal(input, init);
			if (signal?.aborted) {
				const reason = signal.reason;
				throw reason instanceof Error ? reason : new Error(String(reason ?? "request aborted"));
			}
			await new Promise<never>((_resolve, reject) => {
				signal?.addEventListener(
					"abort",
					() => {
						const reason = signal.reason;
						reject(reason instanceof Error ? reason : new Error(String(reason ?? "request aborted")));
					},
					{ once: true },
				);
			});
			throw new Error("never-resolving fetch should not resume");
		}
		return Object.assign(mockFetch, { preconnect: globalThis.fetch.preconnect });
	}

	it("bounds a never-resolving Responses setup on the lazy path with typed first-event facts", async () => {
		vi.useFakeTimers();
		await withEnv({ PI_STREAM_FIRST_EVENT_TIMEOUT_MS: undefined }, async () => {
			const model = getBundledModel("alibaba-token-plan", "qwen3.8-max-preview") as Model<"openai-responses">;
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(createNeverResolvingFetch());

			const lazyStream = streamModel(model, baseContext, {
				apiKey: "test-key",
				requestMaxRetries: 0,
				streamFirstEventTimeoutMs: 5_000,
			});
			await flush();
			expect(fetchSpy).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(5_000);
			await flush(100);
			const result = await lazyStream.result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("OpenAI responses stream timed out while waiting for the first event");
			expect(result.transportFailure).toMatchObject({
				kind: "transport",
				providerCode: "stream_first_event_timeout",
			});
		});
	});

	it("bounds a never-resolving Azure Responses setup on the lazy path with typed first-event facts", async () => {
		vi.useFakeTimers();
		await withEnv({ PI_STREAM_FIRST_EVENT_TIMEOUT_MS: "5000" }, async () => {
			const model: Model<"azure-openai-responses"> = {
				id: "gpt-5-mini",
				name: "GPT-5 Mini",
				api: "azure-openai-responses",
				provider: "azure",
				baseUrl: "https://example.openai.azure.com/openai/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 400000,
				maxTokens: 128000,
			};
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(createNeverResolvingFetch());

			const lazyStream = streamModel(model, baseContext, {
				apiKey: "test-key",
				azureBaseUrl: model.baseUrl,
				azureApiVersion: "v1",
				requestMaxRetries: 0,
			});
			await flush();
			expect(fetchSpy).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(5_000);
			await flush(100);
			const result = await lazyStream.result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("Azure OpenAI responses stream timed out while waiting for the first event");
			expect(result.transportFailure).toMatchObject({
				kind: "transport",
				providerCode: "stream_first_event_timeout",
			});
		});
	});

	it("keeps caller aborts as aborted on a never-resolving Responses lazy setup", async () => {
		const model = getBundledModel("alibaba-token-plan", "qwen3.8-max-preview") as Model<"openai-responses">;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(createNeverResolvingFetch());
		const controller = new AbortController();

		const pending = streamModel(model, baseContext, {
			apiKey: "test-key",
			requestMaxRetries: 0,
			streamFirstEventTimeoutMs: 60_000,
			signal: controller.signal,
		}).result();
		await flush();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		controller.abort();
		const result = await Promise.race([
			pending,
			Bun.sleep(200).then(() => {
				throw new Error("lazy Responses caller abort did not settle during never-resolving setup");
			}),
		]);
		expect(result.stopReason).toBe("aborted");
		expect((result.errorMessage ?? "").toLowerCase()).toContain("abort");
		expect(result.transportFailure?.providerCode).not.toBe("stream_first_event_timeout");
	});
});
