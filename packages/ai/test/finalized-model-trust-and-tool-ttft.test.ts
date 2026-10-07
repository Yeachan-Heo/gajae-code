/**
 * Issue #6150: P1 - Authenticate finalized built-in Kiro models
 * Issue #6150: P2 - Record TTFT for tool-only API-key responses
 * Issue #6150: P3 - Streaming thinking without buffering text
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	isProviderSafetyStopModelTrusted,
	registerProviderSafetyStopModel,
} from "../src/adapter-internals/provider-safety-stop";
import { getBundledModel } from "../src/models";
import { streamKiroApiKey } from "../src/providers/kiro-api-key";
import type { Context, Model } from "../src/types";
import { registerFinalizedModelClone } from "../src/utils/trusted-model-clone";

const originalFetch = globalThis.fetch;

describe("P1: Finalized model trust", () => {
	test("bundled Kiro model should be trusted at registration time", () => {
		// Get the original bundled model
		const original = getBundledModel("kiro", "claude-opus-5-5") as Model<"kiro-codewhisperer-stream">;
		if (!original) throw new Error("Expected bundled Kiro model");

		// The bundled model should be trusted (registered during module load)
		expect(isProviderSafetyStopModelTrusted(original)).toBeTruthy();
	});

	test("finalized (cloned) Kiro model should be trusted after explicit clone registration", () => {
		// Get the original bundled model
		const original = getBundledModel("kiro", "claude-opus-5-5") as Model<"kiro-codewhisperer-stream">;
		if (!original) throw new Error("Expected bundled Kiro model");

		// Simulate what ModelRegistry#finalizeModels does: spread the model
		const finalized = { ...original };

		// Before registration, the finalized clone should NOT be trusted (different object)
		expect(isProviderSafetyStopModelTrusted(finalized)).toBe(false);

		// After calling registerFinalizedModelClone, use the returned trusted clone
		const trustedClone = registerFinalizedModelClone(original, finalized);
		expect(trustedClone).toBeDefined();
		// The returned clone should be trusted
		expect(isProviderSafetyStopModelTrusted(trustedClone)).toBeTruthy();
		// The caller-supplied finalized object should remain untrusted
		expect(isProviderSafetyStopModelTrusted(finalized)).toBe(false);
	});

	test("model clone with modified baseUrl should not be trusted even after trying to register", () => {
		// Create a trusted model
		const original = {
			id: "test-model",
			name: "Test",
			api: "kiro-codewhisperer-stream" as const,
			provider: "kiro-api-key" as const,
			baseUrl: "https://trusted.example",
			reasoning: false,
			input: ["text"] as const,
			output: ["text"] as const,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		} satisfies Model<"kiro-codewhisperer-stream">;

		// Register the original
		registerProviderSafetyStopModel(original);
		expect(isProviderSafetyStopModelTrusted(original)).toBeTruthy();

		// Create a malicious clone with a different baseUrl
		const malicious = {
			...original,
			baseUrl: "https://attacker.example/v1",
		};

		// Register it as a clone of the original
		registerFinalizedModelClone(original, malicious);

		// The malicious model should NOT be trusted because it has a different baseUrl
		// The trust transfer only works if the clone's identity matches the original
		expect(isProviderSafetyStopModelTrusted(malicious)).toBe(false);
	});

	test("Proxy returning different values on consecutive reads should not be trusted", () => {
		// Create a trusted model
		const original = {
			id: "test-model",
			name: "Test",
			api: "kiro-codewhisperer-stream" as const,
			provider: "kiro-api-key" as const,
			baseUrl: "https://trusted.example",
			reasoning: false,
			input: ["text"] as const,
			output: ["text"] as const,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		} satisfies Model<"kiro-codewhisperer-stream">;

		// Register the original as trusted
		registerProviderSafetyStopModel(original);

		// Create a Proxy that changes baseUrl on each read
		let readCount = 0;
		const proxyModel = new Proxy(original, {
			get(target, prop) {
				if (prop === "baseUrl") {
					readCount++;
					return readCount === 1 ? "https://trusted.example" : "https://attacker.example";
				}
				return Reflect.get(target, prop);
			},
		}) as Model<"kiro-codewhisperer-stream">;

		// The Proxy should NOT be trusted because it's a different object (not the registered original)
		expect(isProviderSafetyStopModelTrusted(proxyModel)).toBe(false);
	});
});

describe("P2: Tool-only TTFT", () => {
	beforeEach(() => {
		globalThis.fetch = originalFetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("tool-only response should have firstTokenTime set and ttft calculated", async () => {
		const model = {
			id: "test-model",
			name: "Test",
			api: "kiro-codewhisperer-stream" as const,
			provider: "kiro-api-key" as const,
			baseUrl: "",
			reasoning: false,
			input: ["text"] as const,
			output: ["text"] as const,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		} satisfies Model<"kiro-codewhisperer-stream">;

		const context: Context = {
			messages: [{ role: "user", content: "Call my tool", timestamp: 1 }],
		};

		const apiKey = "ksk_test_kiro_key";

		// Mock fetch to return a tool-only response (no text)
		globalThis.fetch = (async () => {
			// Kiro API-key stream format: JSON objects in the response body
			const responseBody =
				'{"name":"my_tool","toolUseId":"tool_1","input":"{\\"key\\":\\"value\\"}","stop":true}\n' +
				'{"usage":{"inputTokens":100,"outputTokens":50}}';

			return new Response(responseBody, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const result = await streamKiroApiKey(model, context, {
			apiKey,
			requestMaxRetries: 0,
			streamMaxRetries: 0,
		}).result();

		// Verify the response is successful with tool call (toolUse stopReason)
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]?.type).toBe("toolCall");

		// Verify firstTokenTime was set (ttft should be present)
		expect(result.ttft).toBeDefined();
		expect(result.duration).toBeGreaterThanOrEqual(0);
		if (result.ttft !== undefined && result.duration !== undefined) {
			expect(result.ttft).toBeLessThanOrEqual(result.duration);
		}
	});

	test("tool response should have ttft even when text precedes tool", async () => {
		const model = {
			id: "test-model",
			name: "Test",
			api: "kiro-codewhisperer-stream" as const,
			provider: "kiro-api-key" as const,
			baseUrl: "",
			reasoning: false,
			input: ["text"] as const,
			output: ["text"] as const,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		} satisfies Model<"kiro-codewhisperer-stream">;

		const context: Context = {
			messages: [{ role: "user", content: "Call my tool after text", timestamp: 1 }],
		};

		const apiKey = "ksk_test_kiro_key";

		globalThis.fetch = (async () => {
			// Kiro API-key stream format: JSON objects in the response body
			const responseBody =
				'{"content":"Here\'s the tool call: "}\n' +
				'{"name":"my_tool","toolUseId":"tool_1","input":"{\\"key\\":\\"value\\"}","stop":true}\n' +
				'{"usage":{"inputTokens":100,"outputTokens":50}}';

			return new Response(responseBody, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const result = await streamKiroApiKey(model, context, {
			apiKey,
			requestMaxRetries: 0,
			streamMaxRetries: 0,
		}).result();

		// Verify the response is successful with both text and tool
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toHaveLength(2);

		// Verify firstTokenTime was set
		expect(result.ttft).toBeDefined();
		expect(result.ttft).toBeGreaterThanOrEqual(0);
		expect(result.duration).toBeGreaterThanOrEqual(0);
	});
});

describe("P3: Thinking block streamed without text buffering", () => {
	beforeEach(() => {
		globalThis.fetch = originalFetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("thinking followed by answer should emit thinking first, then stream answer incrementally", async () => {
		const model = {
			id: "test-model",
			name: "Test",
			api: "kiro-codewhisperer-stream" as const,
			provider: "kiro-api-key" as const,
			baseUrl: "",
			reasoning: false,
			input: ["text"] as const,
			output: ["text"] as const,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		} satisfies Model<"kiro-codewhisperer-stream">;

		const context: Context = {
			messages: [{ role: "user", content: "Think then answer", timestamp: 1 }],
		};

		const apiKey = "ksk_test_kiro_key";

		// Mock fetch to return thinking followed by text in multiple chunks
		globalThis.fetch = (async () => {
			const responseBody =
				'{"content":"<thinking>I need to think about this..."}\n' +
				'{"content":"</thinking>The answer is: "}\n' +
				'{"content":"this is the answer"}\n' +
				'{"usage":{"inputTokens":100,"outputTokens":50}}';

			return new Response(responseBody, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const events: unknown[] = [];
		const stream = streamKiroApiKey(model, context, {
			apiKey,
			requestMaxRetries: 0,
			streamMaxRetries: 0,
		});

		for await (const event of stream) {
			events.push(event);
		}

		// Find indices of different event types
		const thinkingStartIdx = events.findIndex(e => (e as any).type === "thinking_start");
		const thinkingEndIdx = events.findIndex(e => (e as any).type === "thinking_end");
		const textStartIdx = events.findIndex(e => (e as any).type === "text_start");
		const textDeltaEvents = events.filter(e => (e as any).type === "text_delta");

		// Verify thinking was emitted
		expect(thinkingStartIdx).toBeGreaterThanOrEqual(0);
		expect(thinkingEndIdx).toBeGreaterThanOrEqual(0);

		// Verify thinking comes before text
		expect(thinkingEndIdx).toBeLessThan(textStartIdx);

		// Verify we received text_delta events (answer was streamed, not buffered)
		expect(textDeltaEvents.length).toBeGreaterThan(0);

		// Verify the answer text contains the full answer
		const doneEvent = events.find(e => (e as any).type === "done") as any;
		if (doneEvent?.message?.content) {
			const textBlock = doneEvent.message.content.find((c: any) => c.type === "text");
			expect(textBlock?.text).toContain("this is the answer");
		}
	});

	test("parameterless tool call should have consistent empty args in delta and end", async () => {
		const model = {
			id: "test-model",
			name: "Test",
			api: "kiro-codewhisperer-stream" as const,
			provider: "kiro-api-key" as const,
			baseUrl: "",
			reasoning: false,
			input: ["text"] as const,
			output: ["text"] as const,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		} satisfies Model<"kiro-codewhisperer-stream">;

		const context: Context = {
			messages: [{ role: "user", content: "Call a tool with no args", timestamp: 1 }],
		};

		const apiKey = "ksk_test_kiro_key";

		globalThis.fetch = (async () => {
			// Tool with empty args should result in {} not ""
			const responseBody =
				'{"name":"no_args_tool","toolUseId":"tool_1","input":"","stop":true}\n' +
				'{"usage":{"inputTokens":100,"outputTokens":50}}';

			return new Response(responseBody, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const events: unknown[] = [];
		const stream = streamKiroApiKey(model, context, {
			apiKey,
			requestMaxRetries: 0,
			streamMaxRetries: 0,
		});

		for await (const event of stream) {
			events.push(event);
		}

		const toolcallDeltaEvent = events.find(e => (e as any).type === "toolcall_delta") as any;
		const toolcallEndEvent = events.find(e => (e as any).type === "toolcall_end") as any;

		// Delta should have normalized args (empty string for no args, not raw input)
		expect(toolcallDeltaEvent?.delta).toBe("{}");

		// End should have arguments as object
		expect(toolcallEndEvent?.toolCall?.arguments).toEqual({});
	});
});
