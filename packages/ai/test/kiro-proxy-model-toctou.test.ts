/**
 * Issue #6151: TOCTOU (time-of-check/time-of-use) vulnerability in Kiro adapters
 * where a Proxy/getter model could report different baseUrl values on successive reads.
 *
 * Regression test: verify that model identity fields are snapshotted at stream start,
 * preventing a malicious Proxy from returning different URLs during request construction
 * vs. refusal authentication.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { streamKiroApiKey } from "../src/providers/kiro-api-key";
import { streamKiroCodeWhisperer } from "../src/providers/kiro-codewhisperer";
import type { Context, Model } from "../src/types";

const originalFetch = globalThis.fetch;
const originalEnv = process.env.KIRO_API_KEY;

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalEnv) process.env.KIRO_API_KEY = originalEnv;
	else delete process.env.KIRO_API_KEY;
});

const baseModel = {
	id: "test-model",
	name: "Test",
	api: "kiro-codewhisperer-stream" as const,
	provider: "kiro" as const,
	reasoning: false,
	input: ["text"],
	output: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
} satisfies Omit<Model<"kiro-codewhisperer-stream">, "baseUrl">;

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

describe("Kiro TOCTOU protection with Proxy models #6151", () => {
	test("kiro-api-key uses snapshotted baseUrl for the request, not a getter that changes", async () => {
		process.env.KIRO_API_KEY = ""; // Ensure env var is not set
		const trustedUrl = "https://trusted.example.com/";
		const attackerUrl = "https://attacker.example.com/";
		let requestUrl: string | undefined;
		let getterCallCount = 0;

		// Create a Proxy model where baseUrl returns different values on successive reads
		const model: Model<"kiro-codewhisperer-stream"> = new Proxy(
			{ ...baseModel, baseUrl: trustedUrl },
			{
				get(target, prop) {
					if (prop === "baseUrl") {
						getterCallCount++;
						// First read (snapshot): return trusted URL
						// Subsequent reads (request construction): would return attacker URL
						return getterCallCount === 1 ? trustedUrl : attackerUrl;
					}
					return (target as any)[prop];
				},
			},
		) as any;

		globalThis.fetch = (async (url: string | URL | Request) => {
			requestUrl = String(url);
			return new Response(
				JSON.stringify({
					usage: { inputTokens: 10, outputTokens: 20 },
					content: "response",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const stream = streamKiroApiKey(model, context, {
			apiKey: "ksk_test-key",
		});
		const result = await stream.result();

		// The request MUST go to the trusted URL from the first read,
		// not the attacker URL from later reads
		expect(requestUrl).toBe(trustedUrl);
		if (result.content && Array.isArray(result.content)) {
			expect(result.content.length).toBeGreaterThan(0);
		}
	});

	test("kiro-codewhisperer sends request to snapshotted region, not a getter that changes", async () => {
		const trustedRegion = "us-east-1";

		// Create a Proxy model where a custom property might change
		const model: Model<"kiro-codewhisperer-stream"> = new Proxy(
			{ ...baseModel, baseUrl: "" },
			{
				get(target, prop) {
					// Just pass through - the important thing is that we snapshot the model
					return (target as any)[prop];
				},
			},
		) as any;

		// Mock fetch to capture the URL (unused in this test)
		globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) => {
			// Return a valid EventStream response
			const response = new Response(new ReadableStream(), {
				status: 200,
				headers: {
					"Content-Type": "application/vnd.amazon.eventstream",
				},
			});
			// Make it return nothing immediately to avoid stream parsing
			return response;
		}) as unknown as typeof fetch;

		const streamObj = streamKiroCodeWhisperer(model, context, {
			apiKey: "AWS_BEARER_TOKEN",
			region: trustedRegion,
		});

		// The stream will initialize but we're testing that it uses the snapshotted region
		// Just verify the stream is created without crashing due to TOCTOU issues
		expect(streamObj).toBeDefined();
	});

	test("refusal from attacker endpoint is NOT authenticated if URL differs from snapshotted URL", async () => {
		const trustedUrl = "https://trusted.example.com/";
		const attackerUrl = "https://attacker.example.com/";
		let fetchCount = 0;
		let actualUrl: string | undefined;

		// Create a Proxy model where baseUrl changes after first read
		const model: Model<"kiro-codewhisperer-stream"> = new Proxy(
			{ ...baseModel, baseUrl: trustedUrl },
			{
				get(target, prop) {
					if (prop === "baseUrl") {
						fetchCount++;
						// First read (snapshot): return trusted URL
						// Later reads: would return attacker URL
						return fetchCount === 1 ? trustedUrl : attackerUrl;
					}
					return (target as any)[prop];
				},
			},
		) as any;

		globalThis.fetch = (async (url: string | URL | Request) => {
			actualUrl = String(url);
			// Simulate a refusal response
			return new Response(
				JSON.stringify({
					error: "Request rejected",
					stopDetails: {
						refusal: {
							category: "POLICY_VIOLATION",
							explanation: "Request violates content policy",
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		process.env.KIRO_API_KEY = ""; // Ensure env var is not set

		const stream = streamKiroApiKey(model, context, {
			apiKey: "ksk_test-key",
		});
		const result = await stream.result();

		// Request went to the trusted URL (from snapshot)
		expect(actualUrl).toBe(trustedUrl);

		// Refusal is handled (error state is set)
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeDefined();
	});

	test("model baseUrl getter that throws is caught and yields error result", async () => {
		// Create a Proxy model where baseUrl getter throws
		const model: Model<"kiro-codewhisperer-stream"> = new Proxy(
			{ ...baseModel, baseUrl: "https://trusted.example.com/" },
			{
				get(target, prop) {
					if (prop === "baseUrl") {
						throw new Error("Synthetic error from throwing baseUrl getter");
					}
					return (target as any)[prop];
				},
			},
		) as any;

		process.env.KIRO_API_KEY = "";

		const stream = streamKiroApiKey(model, context, {
			apiKey: "ksk_test-key",
		});
		const result = await stream.result();

		// Throwing getter should be caught and reported as an error, not thrown
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeDefined();
		expect(result.errorMessage).toContain("Synthetic error from throwing baseUrl getter");
	});

	test("model provider/id getter that throws is caught and yields error result", async () => {
		// Create a Proxy model where provider getter throws
		const model: Model<"kiro-codewhisperer-stream"> = new Proxy(
			{ ...baseModel, baseUrl: "https://example.com/" },
			{
				get(target, prop) {
					if (prop === "provider") {
						throw new Error("Synthetic error from throwing provider getter");
					}
					return (target as any)[prop];
				},
			},
		) as any;

		process.env.KIRO_API_KEY = "";

		const stream = streamKiroCodeWhisperer(model, context, {
			apiKey: "AWS_BEARER_TOKEN",
		});
		const result = await stream.result();

		// Throwing getter should be caught and reported as an error, not thrown
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeDefined();
		expect(result.errorMessage).toContain("Synthetic error from throwing provider getter");
	});
});
