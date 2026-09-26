/**
 * Regression test for issue #6002: Kiro CodeWhisperer OAuth endpoint
 * was using non-existent amazoncodewhispererstreamingservice hostname.
 * Must use codewhisperer.${region}.amazonaws.com instead.
 */
import { describe, expect, test } from "bun:test";
import { streamKiroCodeWhisperer } from "../src/providers/kiro-codewhisperer";
import type { Context } from "../src/types";

const originalFetch = globalThis.fetch;

describe("Kiro CodeWhisperer OAuth endpoint #6002", () => {
	test("uses codewhisperer.${region}.amazonaws.com hostname for OAuth bearer token", async () => {
		let capturedUrl: string | undefined;
		let capturedHeaders: Record<string, string> | undefined;

		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = String(input);
			capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
			// Return error response to short-circuit the stream
			return new Response("error", { status: 500 });
		}) as unknown as typeof fetch;

		try {
			const model = {
				id: "test-model",
				name: "Test",
				api: "kiro-codewhisperer-stream" as const,
				provider: "kiro" as const,
				input: ["text"],
				output: ["text"],
			};

			const context: Context = {
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
			};

			const stream = streamKiroCodeWhisperer(model, context, {
				apiKey: "oauth-bearer-token",
				region: "us-east-1",
			});

			// Consume first event to trigger the fetch
			for await (const _event of stream) {
				break;
			}
		} catch {
			// Expected to fail due to mocked 500 response
		}

		globalThis.fetch = originalFetch;

		// Verify the endpoint uses the correct hostname
		expect(capturedUrl).toBe("https://codewhisperer.us-east-1.amazonaws.com/");
		expect(capturedHeaders?.authorization).toBe("Bearer oauth-bearer-token");
		expect(capturedHeaders?.["amzn-x-amz-target"]).toBe("AmazonCodeWhispererService.GenerateAssistantResponse");
	});

	test("respects custom region parameter", async () => {
		let capturedUrl: string | undefined;

		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = String(input);
			return new Response("error", { status: 500 });
		}) as unknown as typeof fetch;

		try {
			const model = {
				id: "test-model",
				name: "Test",
				api: "kiro-codewhisperer-stream" as const,
				provider: "kiro" as const,
				input: ["text"],
				output: ["text"],
			};

			const context: Context = {
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
			};

			const stream = streamKiroCodeWhisperer(model, context, {
				apiKey: "oauth-bearer-token",
				region: "eu-west-1",
			});

			for await (const _event of stream) {
				break;
			}
		} catch {
			// Expected to fail
		}

		globalThis.fetch = originalFetch;

		expect(capturedUrl).toBe("https://codewhisperer.eu-west-1.amazonaws.com/");
	});

	test("respects AWS_REGION environment variable when region not explicitly provided", async () => {
		const originalRegion = process.env.AWS_REGION;
		process.env.AWS_REGION = "ap-southeast-1";

		let capturedUrl: string | undefined;

		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = String(input);
			return new Response("error", { status: 500 });
		}) as unknown as typeof fetch;

		try {
			const model = {
				id: "test-model",
				name: "Test",
				api: "kiro-codewhisperer-stream" as const,
				provider: "kiro" as const,
				input: ["text"],
				output: ["text"],
			};

			const context: Context = {
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
			};

			const stream = streamKiroCodeWhisperer(model, context, {
				apiKey: "oauth-bearer-token",
			});

			for await (const _event of stream) {
				break;
			}
		} catch {
			// Expected to fail
		}

		globalThis.fetch = originalFetch;
		process.env.AWS_REGION = originalRegion;

		expect(capturedUrl).toBe("https://codewhisperer.ap-southeast-1.amazonaws.com/");
	});
});
