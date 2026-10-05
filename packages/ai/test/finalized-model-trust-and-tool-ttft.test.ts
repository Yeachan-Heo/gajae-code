/**
 * Issue #6150: P1 - Authenticate finalized built-in Kiro models
 * Issue #6150: P2 - Record TTFT for tool-only API-key responses
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isProviderSafetyStopModelTrusted } from "../src/adapter-internals/provider-safety-stop";
import { getBundledModel } from "../src/models";
import { streamKiroApiKey } from "../src/providers/kiro-api-key";
import type { Context, Model } from "../src/types";

const originalFetch = globalThis.fetch;

describe("P1: Finalized model trust", () => {
	test("finalized (cloned) Kiro model should be recognized as trusted for provider safety-stop", () => {
		// Get the original bundled model
		const original = getBundledModel("kiro", "claude-opus-5-5") as Model<"kiro-codewhisperer-stream">;
		if (!original) throw new Error("Expected bundled Kiro model");

		// Simulate what ModelRegistry#finalizeModels does: spread the model
		const finalized = { ...original };

		// The original should be trusted (registered)
		expect(isProviderSafetyStopModelTrusted(original)).toBe(true);

		// The finalized clone should also be trusted because it has the same identity
		expect(isProviderSafetyStopModelTrusted(finalized)).toBe(true);

		// A model cloned with a different baseUrl should NOT be trusted (different identity)
		const malicious = {
			...original,
			baseUrl: "https://attacker.example/v1",
		};
		expect(isProviderSafetyStopModelTrusted(malicious)).toBe(false);
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
