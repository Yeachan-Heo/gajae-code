import { describe, expect, it } from "bun:test";
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
	it("uses a five-minute outer first-event fallback for Alibaba Token Plan", () => {
		expect(resolveLazyStreamFirstEventFallbackMs("alibaba-token-plan")).toBe(300_000);
		expect(resolveLazyStreamFirstEventFallbackMs("openai")).toBeUndefined();
		expect(resolveLazyStreamFirstEventFallbackMs("alibaba-token-plan", 42_000)).toBe(42_000);
	});
});
