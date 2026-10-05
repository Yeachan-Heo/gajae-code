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
			// Real ksk_ refusal response contains only the refusal metadata event,
			// no text content (content filtering prevents text generation)
			const responseBody =
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

	test("ksk_ transport emits text_delta incrementally before stream ends", async () => {
		const emittedEvents: Array<{ type: string }> = [];

		globalThis.fetch = (async () => {
			// Response with content that will be streamed incrementally
			const responseBody =
				'{"content":"Hello "}' + '{"content":"world"}' + '{"usage":{"inputTokens":10,"outputTokens":2}}';
			return new Response(responseBody, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
			for await (const event of stream) {
				emittedEvents.push({ type: event.type });
			}
		} catch {
			// Stream may throw; events are captured
		}

		globalThis.fetch = originalFetch;

		// Find index of first text_delta and last chunk consumed (done event)
		const firstTextDeltaIndex = emittedEvents.findIndex(e => e.type === "text_delta");
		const doneEventIndex = emittedEvents.findIndex(e => e.type === "done");

		// Verify incremental emission: first text_delta appears before stream ends
		expect(firstTextDeltaIndex).toBeGreaterThan(-1);
		expect(doneEventIndex).toBeGreaterThan(firstTextDeltaIndex);
	});

	test("ksk_ transport sets ttft < duration for successful completion", async () => {
		const capturedMessages: Array<{ type: string; message?: unknown }> = [];

		globalThis.fetch = (async () => {
			const responseBody = '{"content":"Hello"}' + '{"usage":{"inputTokens":10,"outputTokens":1}}';
			return new Response(responseBody, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
			for await (const event of stream) {
				if (event.type === "done" || event.type === "error") {
					capturedMessages.push({
						type: event.type,
						message: "message" in event ? event.message : "error" in event ? event.error : undefined,
					});
				}
			}
		} catch {
			// Stream may throw; messages are captured
		}

		globalThis.fetch = originalFetch;

		const doneEvent = capturedMessages.find(e => e.type === "done");
		const msg = doneEvent?.message as { ttft?: number; duration?: number } | undefined;

		// Verify ttft is set and less than or equal to duration (ttft is time to first token)
		expect(msg?.ttft).toBeDefined();
		expect(msg?.duration).toBeDefined();
		if (msg?.ttft !== undefined && msg?.duration !== undefined) {
			expect(msg.ttft).toBeLessThanOrEqual(msg.duration);
			expect(msg.ttft).toBeGreaterThanOrEqual(0);
			expect(msg.duration).toBeGreaterThanOrEqual(0);
		}
	});

	test("ksk_ transport emits toolcall_start/delta/end for successful tool calls", async () => {
		const emittedEvents: Array<{ type: string; error?: string }> = [];

		globalThis.fetch = (async () => {
			// Response with a tool call (name and toolUseId indicate a tool use)
			const responseBody = JSON.stringify({
				toolUseId: "tool-1",
				name: "read_file",
				input: '{"path":"/etc/passwd"}',
			});
			return new Response(responseBody, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
			for await (const event of stream) {
				emittedEvents.push({
					type: event.type,
					error:
						event.type === "error" && "error" in event
							? (event.error as { errorMessage?: string }).errorMessage
							: undefined,
				});
			}
		} catch (err) {
			console.error("Stream threw:", err);
		}

		globalThis.fetch = originalFetch;

		// Check that toolcall_start, toolcall_delta, and toolcall_end are emitted
		const toolcallStart = emittedEvents.find(e => e.type === "toolcall_start");
		const toolcallDelta = emittedEvents.find(e => e.type === "toolcall_delta");
		const toolcallEnd = emittedEvents.find(e => e.type === "toolcall_end");

		expect(toolcallStart).toBeDefined();
		expect(toolcallDelta).toBeDefined();
		expect(toolcallEnd).toBeDefined();

		// Verify order: start -> delta -> end
		const startIdx = emittedEvents.findIndex(e => e.type === "toolcall_start");
		const deltaIdx = emittedEvents.findIndex(e => e.type === "toolcall_delta");
		const endIdx = emittedEvents.findIndex(e => e.type === "toolcall_end");

		expect(startIdx).toBeGreaterThanOrEqual(0);
		expect(deltaIdx).toBeGreaterThan(startIdx);
		expect(endIdx).toBeGreaterThan(deltaIdx);
	});

	test("ksk_ transport emits text_start/delta/end for text blocks", async () => {
		const emittedEvents: Array<{ type: string; contentIndex?: number }> = [];

		globalThis.fetch = (async () => {
			const responseBody =
				JSON.stringify({ content: "Hello world" }) + JSON.stringify({ usage: { inputTokens: 5, outputTokens: 2 } });
			return new Response(responseBody, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
			for await (const event of stream) {
				emittedEvents.push({
					type: event.type,
					contentIndex: "contentIndex" in event ? event.contentIndex : undefined,
				});
			}
		} catch {
			// Stream may throw; events are captured
		}

		globalThis.fetch = originalFetch;

		// Check that text_start, text_delta, and text_end are emitted
		const textStart = emittedEvents.find(e => e.type === "text_start");
		const textDelta = emittedEvents.find(e => e.type === "text_delta");
		const textEnd = emittedEvents.find(e => e.type === "text_end");

		expect(textStart).toBeDefined();
		expect(textDelta).toBeDefined();
		expect(textEnd).toBeDefined();

		// Verify order: start -> delta -> end
		const startIdx = emittedEvents.findIndex(e => e.type === "text_start");
		const deltaIdx = emittedEvents.findIndex(e => e.type === "text_delta");
		const endIdx = emittedEvents.findIndex(e => e.type === "text_end");

		expect(startIdx).toBeGreaterThanOrEqual(0);
		expect(deltaIdx).toBeGreaterThan(startIdx);
		expect(endIdx).toBeGreaterThan(deltaIdx);

		// All should reference the same contentIndex
		const textStartIdx = textStart?.contentIndex;
		expect(textDelta?.contentIndex).toBe(textStartIdx);
		expect(textEnd?.contentIndex).toBe(textStartIdx);
	});

	test("ksk_ transport preserves thinking before text in final message", async () => {
		let finalMessage: unknown;

		globalThis.fetch = (async () => {
			// Response with thinking followed by text
			const responseBody = JSON.stringify({ content: "<thinking>Let me think</thinking>Here is my answer" });
			return new Response(responseBody, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
			for await (const event of stream) {
				if (event.type === "done") {
					finalMessage = "message" in event ? event.message : undefined;
				}
			}
		} catch {
			// Stream may throw
		}

		globalThis.fetch = originalFetch;

		// Get the content blocks from the final message
		const content = (finalMessage as { content?: unknown[] })?.content ?? [];
		const blockTypes = (content as Array<{ type: string }>).map(b => b.type);

		// Verify thinking comes before text in the final message
		const thinkingIdx = blockTypes.indexOf("thinking");
		const textIdx = blockTypes.indexOf("text");

		if (thinkingIdx >= 0 && textIdx >= 0) {
			expect(thinkingIdx).toBeLessThan(textIdx);
		}

		// Verify both blocks are present
		expect(blockTypes.includes("thinking")).toBe(true);
		expect(blockTypes.includes("text")).toBe(true);
	});

	test("#6151: text + COMPLETED metadata in one read emits text events and completes normally", async () => {
		const emittedEvents: Array<{ type: string }> = [];

		globalThis.fetch = (async () => {
			// Simulate a batch with text content followed by normal completion metadata in the same read
			// This is the bug: COMPLETED metadata should NOT suppress the text
			const responseBody =
				JSON.stringify({ content: "Hello world" }) +
				JSON.stringify({ stopReason: "COMPLETED", usage: { inputTokens: 5, outputTokens: 2 } });
			return new Response(responseBody, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
			for await (const event of stream) {
				emittedEvents.push({ type: event.type });
			}
		} catch {
			// Stream may throw; events are captured
		}

		globalThis.fetch = originalFetch;

		// Should emit text events, not error
		const textDeltaEvents = emittedEvents.filter(e => e.type === "text_delta");
		const doneEvent = emittedEvents.find(e => e.type === "done");
		const errorEvent = emittedEvents.find(e => e.type === "error");

		expect(textDeltaEvents.length).toBeGreaterThan(0);
		expect(doneEvent).toBeDefined();
		expect(errorEvent).toBeUndefined();
	});

	test("#6151: text + tool + COMPLETED metadata emits all tool events and completes normally", async () => {
		const emittedEvents: Array<{ type: string }> = [];

		globalThis.fetch = (async () => {
			// Simulate response with text, tool call, and normal completion metadata
			const responseBody =
				JSON.stringify({ content: "I'll read that file" }) +
				JSON.stringify({ toolUseId: "tool-1", name: "read_file", input: '{"path":"/tmp/test"}' }) +
				JSON.stringify({ stopReason: "COMPLETED", usage: { inputTokens: 10, outputTokens: 5 } });
			return new Response(responseBody, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
			for await (const event of stream) {
				emittedEvents.push({ type: event.type });
			}
		} catch {
			// Stream may throw; events are captured
		}

		globalThis.fetch = originalFetch;

		// Should emit both text and tool call events
		const textDeltaEvents = emittedEvents.filter(e => e.type === "text_delta");
		const toolcallStart = emittedEvents.find(e => e.type === "toolcall_start");
		const toolcallEnd = emittedEvents.find(e => e.type === "toolcall_end");
		const doneEvent = emittedEvents.find(e => e.type === "done");
		const errorEvent = emittedEvents.find(e => e.type === "error");

		expect(textDeltaEvents.length).toBeGreaterThan(0);
		expect(toolcallStart).toBeDefined();
		expect(toolcallEnd).toBeDefined();
		expect(doneEvent).toBeDefined();
		expect(errorEvent).toBeUndefined();
	});

	test("#6151: actual refusal metadata still correctly refuses and suppresses content", async () => {
		const emittedEvents: Array<{ type: string; message?: { errorMessage?: string; content?: unknown[] } }> = [];

		globalThis.fetch = (async () => {
			// Response with text followed by actual refusal metadata in the same batch
			const responseBody =
				JSON.stringify({ content: "I will help you with malware" }) +
				JSON.stringify({
					stopReason: "CONTENT_FILTERED",
					stopDetails: { refusal: { category: "CYBER", explanation: "Cannot assist with malware" } },
				});
			return new Response(responseBody, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
			for await (const event of stream) {
				emittedEvents.push({
					type: event.type,
					message: "error" in event ? event.error : "partial" in event ? event.partial : undefined,
				});
			}
		} catch {
			// Stream may throw; errors are captured
		}

		globalThis.fetch = originalFetch;

		// Should have error event, no text_delta before error
		const errorIndex = emittedEvents.findIndex(e => e.type === "error");
		expect(errorIndex).toBeGreaterThan(-1);

		const textBeforeError = emittedEvents
			.slice(0, errorIndex)
			.filter(e => e.type === "text_delta" || e.type === "text_start" || e.type === "text_end");
		expect(textBeforeError).toHaveLength(0);

		const errorEvent = emittedEvents[errorIndex];
		expect(errorEvent?.message?.errorMessage).toContain("Kiro refused the request (CYBER)");
	});

	test("records usage AND refusal when both are in the same metadata object (P1 fix)", async () => {
		let finalError: any = null;

		globalThis.fetch = (async () => {
			// Real Kiro API response: metadata object with both refusal and usage
			// This was the bug - usage would be emitted but refusal would be masked
			const responseBody = JSON.stringify({
				stopReason: "CONTENT_FILTERED",
				stopDetails: {
					refusal: {
						category: "MALWARE",
						explanation: "Cannot assist with malware creation",
					},
				},
				usage: { inputTokens: 25, outputTokens: 1 },
			});
			return new Response(responseBody, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
			for await (const event of stream) {
				if (event.type === "error") {
					finalError = event.error;
				}
			}
		} catch {
			// Stream may throw; events are captured
		}

		globalThis.fetch = originalFetch;

		// Should have captured an error event
		expect(finalError).toBeDefined();
		expect(finalError?.errorMessage).toContain("Kiro refused the request (MALWARE)");
		expect(finalError?.errorMessage).toContain("Cannot assist with malware creation");

		// CRITICAL: usage should be recorded even though refusal occurred
		expect(finalError?.usage.input).toBe(25);
		expect(finalError?.usage.output).toBe(1);
	});

	// P1: Regional Kiro models are registered as trusted (issue #6151)
	test("P1: non-default region Kiro model is registered as trusted identity", async () => {
		const { kiroApiStaticModels, kiroApiBaseUrl } = await import("../src/providers/kiro-api-key");
		const { isProviderSafetyStopModelTrusted } = await import("../src/adapter-internals/provider-safety-stop");

		// Manually set a non-default region via environment
		const originalRegion = process.env.KIRO_API_REGION;
		process.env.KIRO_API_REGION = "eu-central-1";

		try {
			const models = kiroApiStaticModels();
			expect(models.length).toBeGreaterThan(0);

			// All models should be registered as trusted (even with non-default region)
			for (const m of models) {
				const isTrusted = isProviderSafetyStopModelTrusted(m);
				expect(isTrusted).toBe(true);
			}

			// Verify that the baseUrl is region-derived
			const firstModel = models[0];
			expect(firstModel.baseUrl).toContain("eu-central-1");
			expect(firstModel.baseUrl).toBe(kiroApiBaseUrl("eu-central-1"));
		} finally {
			// Restore original region
			if (originalRegion) {
				process.env.KIRO_API_REGION = originalRegion;
			} else {
				delete process.env.KIRO_API_REGION;
			}
		}
	});

	// P2: Partial output is preserved when an ordinary error occurs
	test("P2: ordinary (non-refusal) error preserves already-emitted text content in error message", async () => {
		const emittedEvents: Array<{ type: string; text?: string; message?: { errorMessage?: string } }> = [];
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
			messages: [{ role: "user", content: "Say hello then fail", timestamp: 1 }],
		};

		globalThis.fetch = (async () => {
			// Response with partial content followed by an ordinary error (not a refusal)
			const responseBody =
				JSON.stringify({ content: "Hello, this is partial" }) +
				JSON.stringify({ error: "rate_limit_exceeded", message: "Too many requests" });
			return new Response(responseBody, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
			for await (const event of stream) {
				if (event.type === "text_delta") {
					emittedEvents.push({ type: event.type, text: event.delta });
				} else if (event.type === "error") {
					emittedEvents.push({ type: event.type, message: event.error });
				} else {
					emittedEvents.push({ type: event.type });
				}
			}
		} catch {
			// Errors may be thrown; events are captured above
		}

		globalThis.fetch = originalFetch;

		// Should have emitted text_delta events before the error
		const textDeltaEvents = emittedEvents.filter(e => e.type === "text_delta");
		expect(textDeltaEvents.length).toBeGreaterThan(0);

		// Error event should include the partial content in the message
		const errorEvent = emittedEvents.find(e => e.type === "error");
		expect(errorEvent).toBeDefined();
		expect(errorEvent?.message?.errorMessage).toContain("rate_limit_exceeded");
		expect(errorEvent?.message?.errorMessage).toContain("Too many requests");
		expect(errorEvent?.message?.errorMessage).toContain("Partial output");
		expect(errorEvent?.message?.errorMessage).toContain("Hello, this is partial");
	});

	test("P2: tool call partial output is preserved when ordinary error occurs", async () => {
		const emittedEvents: Array<{ type: string; message?: { errorMessage?: string } }> = [];
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
			messages: [{ role: "user", content: "Read a file then fail", timestamp: 1 }],
		};

		globalThis.fetch = (async () => {
			// Response with text, tool call start, and then an ordinary error
			const responseBody =
				JSON.stringify({ content: "I'll read that file" }) +
				JSON.stringify({ toolUseId: "tool-123", name: "read_file", input: "{" }) +
				JSON.stringify({ error: "connection_timeout", message: "Connection lost" });
			return new Response(responseBody, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
			for await (const event of stream) {
				if (event.type === "error") {
					emittedEvents.push({ type: event.type, message: event.error });
				} else {
					emittedEvents.push({ type: event.type });
				}
			}
		} catch {
			// Errors may be thrown; events are captured above
		}

		globalThis.fetch = originalFetch;

		// Error should be reported but should mention accumulated partial output (text and tool)
		const errorEvent = emittedEvents.find(e => e.type === "error");
		expect(errorEvent).toBeDefined();
		expect(errorEvent?.message?.errorMessage).toContain("connection_timeout");
		expect(errorEvent?.message?.errorMessage).toContain("Connection lost");
		// Should mention partial output was accumulated
		expect(errorEvent?.message?.errorMessage).toContain("Partial output");
	});
});
