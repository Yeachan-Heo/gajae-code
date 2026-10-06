/**
 * Issue #6150: when a Kiro API-key (ksk_) stream returns HTTP 200 with
 * JSON events including a refusal metadata event, the error should surface
 * the explicit refusal category and explanation instead of the generic
 * "Kiro API key stream returned no tokens".
 */
import { afterEach, describe, expect, test } from "bun:test";
import { isProviderSafetyStopModelTrusted } from "../src/adapter-internals/provider-safety-stop";
import { kiroApiBaseUrl, kiroApiStaticModels, streamKiroApiKey } from "../src/providers/kiro-api-key";
import type { AssistantMessage, Context, Model } from "../src/types";

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
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

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

		const errorEvent = events.find(e => e.type === "error");
		expect(errorEvent).toBeDefined();
		expect(errorEvent?.message?.errorMessage).toBe("Kiro API key stream returned no tokens");
	});

	test("refusal split across network chunks is handled correctly in ksk_ stream", async () => {
		const events: Array<{ type: string; message?: { errorMessage?: string } }> = [];

		globalThis.fetch = (async () => {
			// Deliver incomplete JSON chunks so the parser must reassemble the refusal.
			const fullRefusal = JSON.stringify({
				stopReason: "CONTENT_FILTERED",
				stopDetails: {
					refusal: {
						category: "ILLEGAL",
						explanation: "This request cannot be processed due to policy restrictions",
					},
				},
			});
			const bytes = new TextEncoder().encode(fullRefusal);
			let offset = 0;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					controller.enqueue(bytes.subarray(offset, offset + 100));
					offset += 100;
					if (offset >= bytes.length) controller.close();
				},
			});
			return new Response(body, { status: 200 });
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

		const errorEvent = events.find(e => e.type === "error");
		expect(errorEvent).toBeDefined();
		expect(errorEvent?.message?.errorMessage).toContain("Kiro refused the request (ILLEGAL)");
		expect(errorEvent?.message?.errorMessage).toContain(
			"This request cannot be processed due to policy restrictions",
		);
	});

	test.each([
		undefined,
		"Request included ksk_test-secret",
	])("redacts secrets in structured refusal category and explanation (%s)", async explanation => {
		let finalError: AssistantMessage | undefined;
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					stopReason: "CONTENT_FILTERED",
					stopDetails: { refusal: { category: "ksk_test-secret", explanation } },
				}),
				{ status: 200 },
			)) as unknown as typeof fetch;

		const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
		for await (const event of stream) {
			if (event.type === "error") finalError = event.error;
		}

		expect(finalError?.errorMessage).toBe(
			explanation
				? "Kiro refused the request ([redacted]): Request included [redacted]"
				: "Kiro refused the request ([redacted])",
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
		let finalError: AssistantMessage | undefined;

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
		// Manually set a non-default region via environment
		const originalRegion = process.env.KIRO_API_REGION;
		process.env.KIRO_API_REGION = "eu-central-1";

		try {
			const models = kiroApiStaticModels();
			expect(models.length).toBeGreaterThan(0);

			// All models should be registered as trusted (even with non-default region)
			for (const m of models) {
				const isTrusted = isProviderSafetyStopModelTrusted(m);
				expect(isTrusted).toBeTruthy();
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

		// Error should be reported but should mention accumulated partial output (text and tool)
		const errorEvent = emittedEvents.find(e => e.type === "error");
		expect(errorEvent).toBeDefined();
		expect(errorEvent?.message?.errorMessage).toContain("connection_timeout");
		expect(errorEvent?.message?.errorMessage).toContain("Connection lost");
		// Should mention partial output was accumulated
		expect(errorEvent?.message?.errorMessage).toContain("Partial output");
	});
});

describe("reasoning-before-answer contentIndex invariant #6151", () => {
	test("thinking then text — every contentIndex matches block final position", async () => {
		const emittedEvents: Array<{
			type: string;
			contentIndex?: number;
			message?: AssistantMessage | undefined;
		}> = [];

		globalThis.fetch = (async () => {
			// Simulate response with thinking tags followed by text (all in one content event)
			// When thinking is parsed from a single content event, it's known BEFORE text starts
			const responseBody = JSON.stringify({
				content: "<thinking>This is my reasoning about the request</thinking>The answer is 42.",
			});
			return new Response(responseBody, { status: 200 });
		}) as unknown as typeof fetch;

		let caughtError: unknown;
		try {
			const stream = streamKiroApiKey(model, context, {
				apiKey: "ksk_test-secret",
				region: "us-east-1",
			});
			for await (const event of stream) {
				if (event.type.includes("_start") || event.type.includes("_delta") || event.type.includes("_end")) {
					emittedEvents.push({
						type: event.type,
						contentIndex: (event as unknown as { contentIndex?: number }).contentIndex,
					});
				} else if (event.type === "done") {
					emittedEvents.push({
						type: event.type,
						message: event.message,
					});
				} else if (event.type === "error") {
					caughtError = (event as unknown as { error?: unknown }).error;
				}
			}
		} catch (err) {
			caughtError = err;
		}

		// Debug if error occurred
		if (caughtError) {
			console.error("Stream error:", caughtError);
		}

		// Find done event to inspect final output.content
		const doneEvent = emittedEvents.find(e => e.type === "done");
		expect(doneEvent?.type).toBe("done");
		const finalMessage = doneEvent?.message as unknown as { content?: unknown[] };
		const finalBlocks = finalMessage?.content;

		// Verify blocks are in correct order: thinking first, then text
		// (when thinking is known before text starts, it's inserted at index 0)
		expect(finalBlocks).toBeDefined();
		expect(finalBlocks?.length).toBeGreaterThanOrEqual(2);
		const firstBlock = (finalBlocks?.[0] as unknown as { type?: string })?.type;
		const secondBlock = (finalBlocks?.[1] as unknown as { type?: string })?.type;
		expect(firstBlock).toBe("thinking");
		expect(secondBlock).toBe("text");

		// Critical invariant: every thinking_start/delta/end has contentIndex === 0
		const thinkingEvents = emittedEvents.filter(e => e.type.startsWith("thinking"));
		for (const ev of thinkingEvents) {
			expect(ev.contentIndex).toBe(0);
		}

		// Critical invariant: every text_start/delta/end has contentIndex === 1
		// (text was shifted from 0 to 1 when thinking was inserted at 0)
		const textEvents = emittedEvents.filter(e => e.type.startsWith("text"));
		for (const ev of textEvents) {
			expect(ev.contentIndex).toBe(1);
		}

		// Invariant: contentIndex never changes for a given block during streaming
		const thinkingStartIdx = emittedEvents.find(e => e.type === "thinking_start")?.contentIndex;
		const thinkingEndIdx = emittedEvents.find(e => e.type === "thinking_end")?.contentIndex;
		const textStartIdx = emittedEvents.find(e => e.type === "text_start")?.contentIndex;
		const textEndIdx = emittedEvents.find(e => e.type === "text_end")?.contentIndex;

		expect(thinkingStartIdx).toBe(thinkingEndIdx);
		expect(textStartIdx).toBe(textEndIdx);
		expect(thinkingStartIdx).not.toBe(textStartIdx);
	});

	test("thinking then text then tool — indices consistent across all blocks", async () => {
		const emittedEvents: Array<{
			type: string;
			contentIndex?: number;
			message?: AssistantMessage | undefined;
		}> = [];

		globalThis.fetch = (async () => {
			// Simulate response with thinking, text, and tool call
			const responseBody =
				JSON.stringify({
					content: "<thinking>I need to read a file</thinking>Let me read that file for you.",
				}) + JSON.stringify({ toolUseId: "tool-123", name: "read_file", input: '{"path":"/tmp/test.txt"}' });
			return new Response(responseBody, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, {
				apiKey: "ksk_test-secret",
				region: "us-east-1",
			});
			for await (const event of stream) {
				if (event.type.includes("_start") || event.type.includes("_delta") || event.type.includes("_end")) {
					emittedEvents.push({
						type: event.type,
						contentIndex: (event as unknown as { contentIndex?: number }).contentIndex,
					});
				} else if (event.type === "done") {
					emittedEvents.push({
						type: event.type,
						message: event.message,
					});
				}
			}
		} catch {
			// Stream may throw; events are captured above
		}

		// Find done event to inspect final output.content
		const doneEvent = emittedEvents.find(e => e.type === "done");
		const finalMessage = doneEvent?.message as unknown as { content?: unknown[] };
		const finalBlocks = finalMessage?.content;

		// Verify block order: thinking (0), text (1), tool (2)
		// (thinking is inserted at 0, text shifts to 1, tool remains at 2)
		expect(finalBlocks?.length).toBeGreaterThanOrEqual(3);
		expect((finalBlocks?.[0] as unknown as { type?: string })?.type).toBe("thinking");
		expect((finalBlocks?.[1] as unknown as { type?: string })?.type).toBe("text");
		expect((finalBlocks?.[2] as unknown as { type?: string })?.type).toBe("toolCall");

		// Each event type must have consistent contentIndex throughout its lifecycle
		const getIndicesForType = (prefix: string) =>
			emittedEvents.filter(e => e.type.startsWith(prefix)).map(e => e.contentIndex);

		const thinkingIndices = getIndicesForType("thinking");
		const textIndices = getIndicesForType("text");
		const toolIndices = getIndicesForType("toolcall");

		// All thinking events should have the same index throughout streaming
		const uniqueThinkingIndices = new Set(thinkingIndices);
		expect(uniqueThinkingIndices.size).toBe(1);

		// All text events should have the same index throughout streaming
		const uniqueTextIndices = new Set(textIndices);
		expect(uniqueTextIndices.size).toBe(1);

		// All toolcall events should have the same index throughout streaming
		const uniqueToolIndices = new Set(toolIndices);
		expect(uniqueToolIndices.size).toBe(1);

		// Indices must be distinct
		const allIndices = [...uniqueThinkingIndices, ...uniqueTextIndices, ...uniqueToolIndices];
		const uniqueAll = new Set(allIndices);
		expect(uniqueAll.size).toBe(3);
	});

	test("text only — single text block at index 0", async () => {
		const emittedEvents: Array<{
			type: string;
			contentIndex?: number;
			message?: AssistantMessage | undefined;
		}> = [];

		globalThis.fetch = (async () => {
			// Simulate response with only text, no thinking
			const responseBody = JSON.stringify({ content: "Here is the answer without any thinking." });
			return new Response(responseBody, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, {
				apiKey: "ksk_test-secret",
				region: "us-east-1",
			});
			for await (const event of stream) {
				if (event.type.includes("_start") || event.type.includes("_delta") || event.type.includes("_end")) {
					emittedEvents.push({
						type: event.type,
						contentIndex: (event as unknown as { contentIndex?: number }).contentIndex,
					});
				} else if (event.type === "done") {
					emittedEvents.push({
						type: event.type,
						message: event.message,
					});
				}
			}
		} catch {
			// Stream may throw; events are captured above
		}

		// Find done event to inspect final output.content
		const doneEvent = emittedEvents.find(e => e.type === "done");
		const finalMessage = doneEvent?.message as unknown as { content?: unknown[] };
		const finalBlocks = finalMessage?.content;

		// Verify only text block exists
		expect(finalBlocks).toBeDefined();
		expect(finalBlocks?.length).toBe(1);
		const block = finalBlocks?.[0] as unknown as { type?: string };
		expect(block?.type).toBe("text");

		// All text events must have contentIndex === 0
		const textEvents = emittedEvents.filter(e => e.type.startsWith("text"));
		for (const ev of textEvents) {
			expect(ev.contentIndex).toBe(0);
		}

		// Verify index is consistent across all text events
		const textIndices = new Set(textEvents.map(e => e.contentIndex));
		expect(textIndices.size).toBe(1);
		expect([...textIndices][0]).toBe(0);
	});

	test("ksk_ emits tool call events before ordinary error", async () => {
		const emittedEvents: Array<{ type: string; error?: string }> = [];

		globalThis.fetch = (async () => {
			// Tool-use frame followed by ordinary error (not refusal)
			const responseBody =
				JSON.stringify({ toolUseId: "tool-1", name: "read_file", input: '{"path":"/tmp/test"}', stop: true }) +
				JSON.stringify({ error: "rate_limit", message: "Too many requests" });
			return new Response(responseBody, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
			for await (const event of stream) {
				emittedEvents.push({
					type: event.type,
					error: event.type === "error" && "error" in event ? (event.error as any).errorMessage : undefined,
				});
			}
		} catch {
			// Stream may throw; errors are captured in events
		}

		// When an ordinary error follows a tool, tool events should be emitted before the error
		const toolcallStart = emittedEvents.find(e => e.type === "toolcall_start");
		const toolcallEnd = emittedEvents.find(e => e.type === "toolcall_end");
		const errorEvent = emittedEvents.find(e => e.type === "error");

		expect(toolcallStart).toBeDefined();
		expect(toolcallEnd).toBeDefined();
		expect(errorEvent).toBeDefined();

		// Verify tool events come before error
		const toolStartIdx = emittedEvents.findIndex(e => e.type === "toolcall_start");
		const toolEndIdx = emittedEvents.findIndex(e => e.type === "toolcall_end");
		const errorIdx = emittedEvents.findIndex(e => e.type === "error");

		expect(toolStartIdx).toBeLessThan(errorIdx);
		expect(toolEndIdx).toBeLessThan(errorIdx);
	});

	test("ksk_ drops tool events on refusal (no error event)", async () => {
		const emittedEvents: Array<{ type: string }> = [];

		globalThis.fetch = (async () => {
			// Tool-use frame followed by refusal (content filtered)
			const responseBody =
				JSON.stringify({ toolUseId: "tool-1", name: "read_file", input: '{"path":"/tmp/test"}', stop: true }) +
				JSON.stringify({
					stopReason: "CONTENT_FILTERED",
					stopDetails: { refusal: { category: "CYBER", explanation: "Malicious" } },
				});
			return new Response(responseBody, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
			for await (const event of stream) {
				emittedEvents.push({ type: event.type });
			}
		} catch {
			// Stream may throw; errors are captured in events
		}

		// On refusal, tool events should not be emitted
		const toolcallStart = emittedEvents.find(e => e.type === "toolcall_start");
		const toolcallEnd = emittedEvents.find(e => e.type === "toolcall_end");

		expect(toolcallStart).toBeUndefined();
		expect(toolcallEnd).toBeUndefined();
		// Error event should be present for refusal
		const errorEvent = emittedEvents.find(e => e.type === "error");
		expect(errorEvent).toBeDefined();
	});
});

describe("reader.read() error handling with pending tools #6151", () => {
	test("emits completed tool events before error when reader.read() throws", async () => {
		const emittedEventTypes: string[] = [];

		globalThis.fetch = (async () => {
			// Stream that has a completed tool, then reader.read() throws
			const toolJson = JSON.stringify({
				stopReason: "TOOL_USE",
				toolUseId: "tool-123",
				name: "calculate",
				input: '{"x": 5}',
				stop: true,
			});
			const bytes = new TextEncoder().encode(toolJson);

			let pullCount = 0;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					pullCount++;
					if (pullCount === 1) {
						// First pull: deliver the completed tool event
						controller.enqueue(bytes);
					} else if (pullCount === 2) {
						// Second pull: simulate reader.read() error (network reset)
						controller.error(new Error("Network connection reset"));
					}
				},
			});
			return new Response(body, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
			for await (const event of stream) {
				emittedEventTypes.push(event.type);
			}
		} catch {
			// Stream may throw; errors are captured in events
		}

		// Should have tool call events before error
		const startIdx = emittedEventTypes.indexOf("toolcall_start");
		const deltaIdx = emittedEventTypes.indexOf("toolcall_delta");
		const endIdx = emittedEventTypes.indexOf("toolcall_end");
		const errorIdx = emittedEventTypes.indexOf("error");

		expect(startIdx).toBeGreaterThan(-1);
		expect(deltaIdx).toBeGreaterThan(-1);
		expect(endIdx).toBeGreaterThan(-1);
		expect(errorIdx).toBeGreaterThan(-1);
		// Tool events should come before error
		expect(startIdx).toBeLessThan(errorIdx);
		expect(deltaIdx).toBeLessThan(errorIdx);
		expect(endIdx).toBeLessThan(errorIdx);
	});

	test("does NOT emit incomplete tool when reader.read() throws mid-tool", async () => {
		const emittedEventTypes: string[] = [];

		globalThis.fetch = (async () => {
			// Stream that has an incomplete tool (no stop flag), then reader.read() throws
			const incompleteToolJson = JSON.stringify({
				stopReason: "TOOL_USE",
				toolUseId: "tool-456",
				name: "search",
				input: '{"query',
				// Note: no 'stop: true' - tool is incomplete
			});
			const bytes = new TextEncoder().encode(incompleteToolJson);

			let pullCount = 0;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					pullCount++;
					if (pullCount === 1) {
						// First pull: deliver the incomplete tool
						controller.enqueue(bytes);
					} else if (pullCount === 2) {
						// Second pull: simulate reader.read() error
						controller.error(new Error("Connection closed unexpectedly"));
					}
				},
			});
			return new Response(body, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
			for await (const event of stream) {
				emittedEventTypes.push(event.type);
			}
		} catch {
			// Stream may throw; errors are captured in events
		}

		// Incomplete tools (no stop flag) should NOT be emitted, only error
		const startIdx = emittedEventTypes.indexOf("toolcall_start");
		const endIdx = emittedEventTypes.indexOf("toolcall_end");
		const errorIdx = emittedEventTypes.indexOf("error");

		expect(startIdx).toBe(-1);
		expect(endIdx).toBe(-1);
		expect(errorIdx).toBeGreaterThan(-1);
	});
});

describe("Regression tests for #6151 issues", () => {
	test("#4199034431: incomplete JSON frame without valid nested objects preserves data for next call", async () => {
		const { parseKiroApiEvents } = await import("../src/providers/kiro-api-key");

		// Simulate a malformed chunk with a stray opening brace (no complete nested JSON)
		// This tests that when there's incomplete JSON with no valid nested objects to resync to,
		// the data is preserved in remaining for the next parse call
		const malformedChunk = '{"content": "hello'; // Opening { but no closing }, incomplete value

		// First parse should recognize the incomplete frame
		const result1 = parseKiroApiEvents(malformedChunk);
		// Should not parse any complete events (frame is incomplete)
		expect(result1.events).toHaveLength(0);
		// Should preserve incomplete frame in remaining for next parse
		expect(result1.remaining).toBeTruthy();
		expect(result1.remaining.length).toBeGreaterThan(0);
		// Should start with the incomplete frame
		expect(result1.remaining[0]).toBe("{");

		// Second parse with completion of the frame (complete the content and close the object)
		const completed = `${result1.remaining}"}`;
		const result2 = parseKiroApiEvents(completed);
		// Should now parse a content event from the completed frame
		const contentEvent = result2.events.find(e => e.type === "content");
		expect(contentEvent).toBeDefined();
		expect(contentEvent?.type).toBe("content");
	});

	test("#4199034439: incomplete tool should NOT be emitted when reader.read() throws mid-tool", async () => {
		const emittedEventTypes: string[] = [];

		globalThis.fetch = (async () => {
			// Stream that has an incomplete tool (no stop flag), then reader.read() throws
			const incompleteToolJson = JSON.stringify({
				stopReason: "TOOL_USE",
				toolUseId: "tool-incomplete",
				name: "search",
				input: '{"query": "incomplete',
				// Note: no 'stop: true' - tool is not complete
			});
			const bytes = new TextEncoder().encode(incompleteToolJson);

			let pullCount = 0;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					pullCount++;
					if (pullCount === 1) {
						// First pull: deliver the incomplete tool
						controller.enqueue(bytes);
					} else if (pullCount === 2) {
						// Second pull: simulate reader.read() error
						controller.error(new Error("Stream interrupted"));
					}
				},
			});
			return new Response(body, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
			for await (const event of stream) {
				emittedEventTypes.push(event.type);
			}
		} catch {
			// Stream may throw; errors are captured in events
		}

		// Incomplete tool (no stop flag) should NOT have toolcall_start/end events emitted
		// Only the error event should be present
		const toolcallStart = emittedEventTypes.indexOf("toolcall_start");
		const toolcallEnd = emittedEventTypes.indexOf("toolcall_end");
		const errorIdx = emittedEventTypes.indexOf("error");

		// REGRESSION: The incomplete tool should NOT be emitted
		// Currently (buggy behavior), toolcall_start/end are emitted
		// After fix: toolcall_start/end should NOT appear
		expect(toolcallStart).toBe(-1);
		expect(toolcallEnd).toBe(-1);
		// Only error event should be present
		expect(errorIdx).toBeGreaterThan(-1);
	});

	test("#4199034444: 64KiB retention cap enforced for stray brace with no valid JSON", async () => {
		const { parseKiroApiEvents } = await import("../src/providers/kiro-api-key");

		// Create a buffer with a stray opening brace followed by 100KB of garbage
		// This should be truncated to 64KB max when returned as remaining
		const strayBrace = "{";
		const garbage = "x".repeat(100 * 1024); // 100KB of non-JSON data
		const buffer = strayBrace + garbage;

		const result = parseKiroApiEvents(buffer);

		// Should not parse any events
		expect(result.events).toHaveLength(0);

		// REGRESSION: The remaining buffer should be capped at 64KB
		// Currently (buggy behavior), remaining could contain 100KB+
		// After fix: remaining should be truncated to 64KB
		const MAX_RESCAN_DISTANCE = 64 * 1024;
		expect(result.remaining.length).toBeLessThanOrEqual(MAX_RESCAN_DISTANCE);
	});

	test("#4199282140: balanced junk wrapper around valid refusal event is rescanned", async () => {
		const { parseKiroApiEvents } = await import("../src/providers/kiro-api-key");

		// Codex finding: balanced junk wrapper around a valid event
		// e.g. '{junk{"stopReason":"CONTENT_FILTERED",...}}' should not be discarded
		const balancedJunkWrapper =
			'{junk{"stopReason":"CONTENT_FILTERED","stopDetails":{"refusal":{"category":"CYBER","explanation":"Malicious"}}}}}';

		const result = parseKiroApiEvents(balancedJunkWrapper);

		// Should parse the refusal event from inside the junk wrapper
		const refusalEvent = result.events.find(e => e.type === "refusal");
		expect(refusalEvent).toBeDefined();
		if (refusalEvent?.type === "refusal") {
			expect(refusalEvent.data.stopReason).toBe("CONTENT_FILTERED");
			expect(refusalEvent.data.stopDetails?.refusal?.category).toBe("CYBER");
		}
	});

	test("#4199282147: ordinary error after incomplete toolUse does not emit unfinished tool", async () => {
		const emittedEventTypes: string[] = [];

		globalThis.fetch = (async () => {
			// Incomplete toolUse (no stop flag) followed by ordinary error
			// Error occurs after toolUse start but before stop
			const incompleteToolJson = JSON.stringify({
				toolUseId: "tool-incomplete",
				name: "search",
				input: '{"query": "incomplete',
				// Note: no 'stop: true' - tool is not complete
			});
			const errorJson = JSON.stringify({
				error: "rate_limit",
				message: "Too many requests",
			});
			const responseBody = incompleteToolJson + errorJson;
			return new Response(responseBody, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
			for await (const event of stream) {
				emittedEventTypes.push(event.type);
			}
		} catch {
			// Stream may throw; errors are captured in events
		}

		// Incomplete tools (no stop flag) must NOT be emitted, only error
		const toolcallStart = emittedEventTypes.indexOf("toolcall_start");
		const toolcallEnd = emittedEventTypes.indexOf("toolcall_end");
		const errorIdx = emittedEventTypes.indexOf("error");

		// REGRESSION: The incomplete tool should NOT be emitted
		// Currently (buggy behavior), toolcall_start/end are emitted
		// After fix: toolcall_start/end should NOT appear
		expect(toolcallStart).toBe(-1);
		expect(toolcallEnd).toBe(-1);
		// Only error event should be present
		expect(errorIdx).toBeGreaterThan(-1);
	});
});
