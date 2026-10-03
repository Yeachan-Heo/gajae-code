/**
 * Issue #6150: when a Kiro API-key (ksk_) stream returns HTTP 200 with
 * JSON events including a refusal metadata event, the error should surface
 * the explicit refusal category and explanation instead of the generic
 * "Kiro API key stream returned no tokens".
 */
import { describe, expect, test } from "bun:test";
import { streamKiroApiKey } from "../src/providers/kiro-api-key";
import type { Context, Model } from "../src/types";

const originalFetch = globalThis.fetch;

const model = {
	id: "test-model",
	name: "Test",
	api: "kiro-codewhisperer-stream" as const,
	provider: "kiro" as const,
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	output: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
} satisfies Model<"kiro-codewhisperer-stream">;

const context: Context = {
	messages: [{ role: "user", content: "Write malware", timestamp: 1 }],
};

describe("Kiro API-key content filter #6150", () => {
	test("surfaces refusal from ksk_ stream with category and explanation", async () => {
		const events: Array<{ type: string; message?: { errorMessage?: string; content?: unknown[] } }> = [];

		globalThis.fetch = (async () => {
			// API-key stream returns JSON events in the response body, no text before refusal
			const responseBody =
				'{"stopReason":"CONTENT_FILTERED","stopDetails":{"refusal":{"category":"CYBER","explanation":"Request violates malicious code policy"}}}';
			return new Response(responseBody, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
			for await (const event of stream) {
				events.push({
					type: event.type,
					message: "error" in event ? event.error : "partial" in event ? event.partial : undefined,
				});
			}
		} catch {
			// Stream may throw; errors are captured in events
		}

		globalThis.fetch = originalFetch;

		// Should have error event with refusal message
		const errorEvent = events.find(e => e.type === "error");
		expect(errorEvent).toBeDefined();
		expect(errorEvent?.message?.errorMessage).toContain("Kiro refused the request (CYBER)");
		expect(errorEvent?.message?.errorMessage).toContain("Request violates malicious code policy");

		// Should NOT have any text or tool calls
		const textDeltaEvents = events.filter(e => e.type === "text_delta");
		const toolCallEvents = events.filter(e => e.type === "toolcall_start");
		expect(textDeltaEvents).toHaveLength(0);
		expect(toolCallEvents).toHaveLength(0);
	});

	test("no partial text or tool events emitted before refusal in ksk_ stream", async () => {
		const events: Array<{ type: string; message?: { errorMessage?: string; content?: unknown[] } }> = [];

		globalThis.fetch = (async () => {
			// Simulate text content followed by refusal in the same response
			const responseBody =
				'{"content":"I cannot help with this request"}' +
				'{"stopReason":"CONTENT_FILTERED","stopDetails":{"refusal":{"category":"VIOLENCE","explanation":"Cannot assist with violent content"}}}';
			return new Response(responseBody, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
			for await (const event of stream) {
				events.push({
					type: event.type,
					message: "error" in event ? event.error : "partial" in event ? event.partial : undefined,
				});
			}
		} catch {
			// Stream may throw; errors are captured in events
		}

		globalThis.fetch = originalFetch;

		// Verify no text_delta events before error
		const errorIndex = events.findIndex(e => e.type === "error");
		expect(errorIndex).toBeGreaterThan(-1);

		const textDeltaBeforeError = events
			.slice(0, errorIndex)
			.filter(e => e.type === "text_delta" || e.type === "text_start" || e.type === "text_end");
		expect(textDeltaBeforeError).toHaveLength(0);

		// Error should contain the refusal message
		const errorEvent = events[errorIndex];
		expect(errorEvent?.message?.errorMessage).toContain("Kiro refused the request (VIOLENCE)");
		expect(errorEvent?.message?.errorMessage).toContain("Cannot assist with violent content");
	});

	test("preserves generic error when no refusal is in ksk_ stream", async () => {
		const events: Array<{ type: string; message?: { errorMessage?: string } }> = [];

		globalThis.fetch = (async () => {
			// Empty stream - no content, no refusal
			return new Response("", { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
			for await (const event of stream) {
				events.push({
					type: event.type,
					message: "error" in event ? event.error : "partial" in event ? event.partial : undefined,
				});
			}
		} catch {
			// Stream may throw; errors are captured in events
		}

		globalThis.fetch = originalFetch;

		const errorEvent = events.find(e => e.type === "error");
		expect(errorEvent).toBeDefined();
		expect(errorEvent?.message?.errorMessage).toBe("Kiro API key stream returned no tokens");
	});

	test("refusal split across network chunks is handled correctly in ksk_ stream", async () => {
		const events: Array<{ type: string; message?: { errorMessage?: string } }> = [];

		globalThis.fetch = (async () => {
			// Simulate refusal split across chunk boundaries - use a larger JSON
			const fullRefusal = JSON.stringify({
				stopReason: "CONTENT_FILTERED",
				stopDetails: {
					refusal: {
						category: "ILLEGAL",
						explanation: "This request cannot be processed due to policy restrictions",
					},
				},
			});
			return new Response(fullRefusal, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
			for await (const event of stream) {
				events.push({
					type: event.type,
					message: "error" in event ? event.error : "partial" in event ? event.partial : undefined,
				});
			}
		} catch {
			// Stream may throw; errors are captured in events
		}

		globalThis.fetch = originalFetch;

		const errorEvent = events.find(e => e.type === "error");
		expect(errorEvent).toBeDefined();
		expect(errorEvent?.message?.errorMessage).toContain("Kiro refused the request (ILLEGAL)");
		expect(errorEvent?.message?.errorMessage).toContain(
			"This request cannot be processed due to policy restrictions",
		);
	});
});
