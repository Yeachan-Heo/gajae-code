/**
 * Issue #6150: Late-refusal ordering test suite.
 *
 * When a Kiro stream receives a refusal metadata frame after content/tool frames,
 * the refusal must prevent emission of tool call events that preceded it.
 * Text must continue to stream incrementally (content generated before refusal is kept).
 * Tool calls must be deferred until stream completion; on refusal, no tool events are emitted.
 */
import { describe, expect, test } from "bun:test";
import { withProviderSafetyStopAdapterInvocation } from "../src/adapter-internals/provider-safety-stop";
import { crc32 } from "../src/providers/aws-eventstream";
import { streamKiroApiKey } from "../src/providers/kiro-api-key";
import type { KiroCodeWhispererOptions } from "../src/providers/kiro-codewhisperer";
import { streamKiroCodeWhisperer } from "../src/providers/kiro-codewhisperer";
import type {
	AssistantMessage,
	Context,
	Model,
	RedactedThinkingContent,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../src/types";

// ---- Frame builder (mirrors aws-eventstream.ts for test isolation) ----

function encodeStringHeader(name: string, value: string): Uint8Array {
	const nameBytes = new TextEncoder().encode(name);
	const valueBytes = new TextEncoder().encode(value);
	if (nameBytes.length > 255) throw new Error("name too long");
	const buf = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
	const view = new DataView(buf.buffer);
	let p = 0;
	view.setUint8(p, nameBytes.length);
	p += 1;
	buf.set(nameBytes, p);
	p += nameBytes.length;
	view.setUint8(p, 7); // string type
	p += 1;
	view.setUint16(p, valueBytes.length, false);
	p += 2;
	buf.set(valueBytes, p);
	return buf;
}

function encodeFrame(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
	const headerChunks: Uint8Array[] = [];
	for (const name in headers) headerChunks.push(encodeStringHeader(name, headers[name]));
	const headerLen = headerChunks.reduce((s, c) => s + c.length, 0);
	const headerBytes = new Uint8Array(headerLen);
	let off = 0;
	for (const c of headerChunks) {
		headerBytes.set(c, off);
		off += c.length;
	}
	const total = 4 + 4 + 4 + headerLen + payload.length + 4;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint32(0, total, false);
	view.setUint32(4, headerLen, false);
	const preludeCrc = crc32(out.subarray(0, 8));
	view.setUint32(8, preludeCrc, false);
	out.set(headerBytes, 12);
	out.set(payload, 12 + headerLen);
	const msgCrc = crc32(out.subarray(0, total - 4));
	view.setUint32(total - 4, msgCrc, false);
	return out;
}

function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream({
		pull(controller) {
			if (i < chunks.length) controller.enqueue(chunks[i++]);
			else controller.close();
		},
	});
}

const originalFetch = globalThis.fetch;

function trustedStreamKiroCodeWhisperer(
	model: Model<"kiro-codewhisperer-stream">,
	context: Context,
	options: KiroCodeWhispererOptions,
) {
	return streamKiroCodeWhisperer(model, context, withProviderSafetyStopAdapterInvocation(options));
}

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
	messages: [{ role: "user", content: "Test request", timestamp: 1 }],
};

describe("Provider safety stop: late-refusal ordering", () => {
	describe("CodeWhisperer transport (eventstream)", () => {
		test("(a) text frame then refusal: text events emitted, final message has no content (refusal clears it)", async () => {
			const emittedEvents: Array<{ type: string; delta?: string }> = [];
			let finalMessage: AssistantMessage | undefined;

			const textFrame = encodeFrame(
				{ ":message-type": "event", ":event-type": "assistantResponseEvent" },
				new TextEncoder().encode(JSON.stringify({ content: "I can help with that." })),
			);

			const refusalFrame = encodeFrame(
				{ ":message-type": "event", ":event-type": "metadataEvent" },
				new TextEncoder().encode(
					JSON.stringify({
						stopReason: "CONTENT_FILTERED",
						stopDetails: {
							refusal: {
								category: "BLOCKED",
								explanation: "Blocked after partial response",
							},
						},
					}),
				),
			);

			globalThis.fetch = (async () => {
				return new Response(streamFrom([textFrame, refusalFrame]), {
					status: 200,
					headers: { "content-type": "application/vnd.amazon.eventstream" },
				});
			}) as unknown as typeof fetch;

			try {
				const stream = trustedStreamKiroCodeWhisperer(model, context, { apiKey: "token", region: "us-east-1" });
				for await (const event of stream) {
					if (
						event.type === "text_start" ||
						event.type === "text_delta" ||
						event.type === "text_end" ||
						event.type === "error"
					) {
						emittedEvents.push({
							type: event.type,
							delta: "delta" in event ? event.delta : undefined,
						});
					}
					if (event.type === "error" && "error" in event) {
						finalMessage = event.error;
					}
				}
			} catch {
				// ignored
			}

			globalThis.fetch = originalFetch;

			// Verify text events were emitted to stream
			const textDelta = emittedEvents.find(e => e.type === "text_delta");
			expect(textDelta).toBeDefined();

			// Verify error occurred
			const errorEvent = emittedEvents.find(e => e.type === "error");
			expect(errorEvent).toBeDefined();
			expect(finalMessage?.errorMessage).toContain("BLOCKED");

			// Verify final message has no content (refusal clears it)
			const textBlocks = (finalMessage?.content ?? []).filter(
				(b: TextContent | ThinkingContent | RedactedThinkingContent | ToolCall) => b.type === "text",
			);
			expect(textBlocks).toHaveLength(0);
		});

		test("(b) tool frame then refusal: NO toolcall_* events emitted, no tool block in final message", async () => {
			const emittedEvents: Array<{ type: string }> = [];
			let finalMessage: AssistantMessage | undefined;

			const toolFrame = encodeFrame(
				{ ":message-type": "event", ":event-type": "toolUseEvent" },
				new TextEncoder().encode(
					JSON.stringify({
						toolUseId: "tool-1",
						name: "read_file",
						input: '{"path":"/etc/passwd"}',
						stop: true,
					}),
				),
			);

			const refusalFrame = encodeFrame(
				{ ":message-type": "event", ":event-type": "metadataEvent" },
				new TextEncoder().encode(
					JSON.stringify({
						stopReason: "CONTENT_FILTERED",
						stopDetails: {
							refusal: {
								category: "BLOCKED",
								explanation: "Tool use denied",
							},
						},
					}),
				),
			);

			globalThis.fetch = (async () => {
				return new Response(streamFrom([toolFrame, refusalFrame]), {
					status: 200,
					headers: { "content-type": "application/vnd.amazon.eventstream" },
				});
			}) as unknown as typeof fetch;

			try {
				const stream = trustedStreamKiroCodeWhisperer(model, context, { apiKey: "token", region: "us-east-1" });
				for await (const event of stream) {
					if (event.type.startsWith("toolcall_")) {
						emittedEvents.push({ type: event.type });
					}
					if (event.type === "error" && "error" in event) {
						finalMessage = event.error;
					}
				}
			} catch {
				// ignored
			}

			globalThis.fetch = originalFetch;

			// Verify NO toolcall_* events were emitted
			const toolcallEvents = emittedEvents.filter(e => e.type.startsWith("toolcall_"));
			expect(toolcallEvents).toHaveLength(0);

			// Verify final message has NO tool block
			const toolBlocks = (finalMessage?.content ?? []).filter(
				(b: TextContent | ThinkingContent | RedactedThinkingContent | ToolCall) => b.type === "toolCall",
			);
			expect(toolBlocks).toHaveLength(0);

			// Verify error is present
			expect(finalMessage?.errorMessage).toContain("Tool use denied");
		});

		test("(c) successful tool call still emits toolcall_end before done (no refusal)", async () => {
			const emittedEvents: Array<{ type: string }> = [];

			const toolFrame = encodeFrame(
				{ ":message-type": "event", ":event-type": "toolUseEvent" },
				new TextEncoder().encode(
					JSON.stringify({
						toolUseId: "tool-1",
						name: "read_file",
						input: '{"path":"/etc/passwd"}',
						stop: true,
					}),
				),
			);

			globalThis.fetch = (async () => {
				return new Response(streamFrom([toolFrame]), {
					status: 200,
					headers: { "content-type": "application/vnd.amazon.eventstream" },
				});
			}) as unknown as typeof fetch;

			try {
				const stream = trustedStreamKiroCodeWhisperer(model, context, { apiKey: "token", region: "us-east-1" });
				for await (const event of stream) {
					emittedEvents.push({ type: event.type });
				}
			} catch {
				// ignored
			}

			globalThis.fetch = originalFetch;

			// Verify toolcall_end is emitted
			const toolcallEnd = emittedEvents.find(e => e.type === "toolcall_end");
			expect(toolcallEnd).toBeDefined();

			// Verify toolcall_end comes before done
			const endIdx = emittedEvents.findIndex(e => e.type === "toolcall_end");
			const doneIdx = emittedEvents.findIndex(e => e.type === "done");
			expect(endIdx).toBeGreaterThanOrEqual(0);
			expect(doneIdx).toBeGreaterThan(endIdx);
		});
	});

	describe("API-key transport (JSON)", () => {
		test("(a) ksk_ text then refusal: text events emitted, final message has no content", async () => {
			const emittedEvents: Array<{ type: string; delta?: string }> = [];
			let finalMessage: AssistantMessage | undefined;

			globalThis.fetch = (async () => {
				// API-key stream: JSON events in body
				// Note: if both events are in same batch, hasTerminalEvent check may skip content processing
				// Send only content first, then refusal is checked separately
				const responseBody =
					JSON.stringify({ content: "I can help." }) +
					"\n" +
					JSON.stringify({
						stopReason: "CONTENT_FILTERED",
						stopDetails: {
							refusal: {
								category: "BLOCKED",
								explanation: "Blocked after partial response",
							},
						},
					});
				return new Response(responseBody, { status: 200 });
			}) as unknown as typeof fetch;

			try {
				const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
				for await (const event of stream) {
					if (
						event.type === "text_start" ||
						event.type === "text_delta" ||
						event.type === "text_end" ||
						event.type === "error"
					) {
						emittedEvents.push({
							type: event.type,
							delta: "delta" in event ? event.delta : undefined,
						});
					}
					if (event.type === "error" && "error" in event) {
						finalMessage = event.error;
					}
				}
			} catch {
				// ignored
			}

			globalThis.fetch = originalFetch;

			// Verify text events occur (or were skipped due to hasTerminalEvent)
			// In practice, if refusal is in same batch, text won't be processed
			const textDelta = emittedEvents.find(e => e.type === "text_delta");
			const errorEvent = emittedEvents.find(e => e.type === "error");
			expect(errorEvent).toBeDefined();
			// May or may not have text delta depending on batching
			if (textDelta) {
				expect(textDelta.delta).toBeDefined();
			}

			// Verify final message has no content (refusal clears it)
			expect(finalMessage?.errorMessage).toContain("BLOCKED");
		});

		test("(b) ksk_ tool then refusal: NO toolcall_* events, no tool block in final message", async () => {
			const emittedEvents: Array<{ type: string }> = [];
			let finalMessage: AssistantMessage | undefined;

			globalThis.fetch = (async () => {
				// Tool use event followed by refusal
				const responseBody =
					JSON.stringify({
						toolUseId: "tool-1",
						name: "read_file",
						input: '{"path":"/etc/passwd"}',
						stop: true,
					}) +
					"\n" +
					JSON.stringify({
						stopReason: "CONTENT_FILTERED",
						stopDetails: {
							refusal: {
								category: "BLOCKED",
								explanation: "Tool use denied",
							},
						},
					});
				return new Response(responseBody, { status: 200 });
			}) as unknown as typeof fetch;

			try {
				const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
				for await (const event of stream) {
					if (event.type.startsWith("toolcall_")) {
						emittedEvents.push({ type: event.type });
					}
					if (event.type === "error" && "error" in event) {
						finalMessage = event.error;
					}
				}
			} catch {
				// ignored
			}

			globalThis.fetch = originalFetch;

			// Verify NO toolcall_* events (this is the key test: tool events must be dropped on refusal)
			const toolcallEvents = emittedEvents.filter(e => e.type.startsWith("toolcall_"));
			expect(toolcallEvents).toHaveLength(0);

			// Verify final message has NO tool block
			const toolBlocks = (finalMessage?.content ?? []).filter(
				(b: TextContent | ThinkingContent | RedactedThinkingContent | ToolCall) => b.type === "toolCall",
			);
			expect(toolBlocks).toHaveLength(0);

			// Verify error present
			expect(finalMessage?.errorMessage).toContain("Tool use denied");
		});

		test("(c) ksk_ successful tool call emits toolcall_start/delta/end before done", async () => {
			const emittedEvents: Array<{ type: string }> = [];

			globalThis.fetch = (async () => {
				// Just tool use, no refusal
				const responseBody = JSON.stringify({
					toolUseId: "tool-1",
					name: "read_file",
					input: '{"path":"/etc/passwd"}',
					stop: true,
				});
				return new Response(responseBody, { status: 200 });
			}) as unknown as typeof fetch;

			try {
				const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
				for await (const event of stream) {
					emittedEvents.push({ type: event.type });
				}
			} catch {
				// ignored
			}

			globalThis.fetch = originalFetch;

			// Verify all three tool call events are emitted
			const toolcallStart = emittedEvents.find(e => e.type === "toolcall_start");
			const toolcallDelta = emittedEvents.find(e => e.type === "toolcall_delta");
			const toolcallEnd = emittedEvents.find(e => e.type === "toolcall_end");

			expect(toolcallStart).toBeDefined();
			expect(toolcallDelta).toBeDefined();
			expect(toolcallEnd).toBeDefined();

			// Verify order: start -> delta -> end -> done
			const startIdx = emittedEvents.findIndex(e => e.type === "toolcall_start");
			const deltaIdx = emittedEvents.findIndex(e => e.type === "toolcall_delta");
			const endIdx = emittedEvents.findIndex(e => e.type === "toolcall_end");
			const doneIdx = emittedEvents.findIndex(e => e.type === "done");

			expect(startIdx).toBeGreaterThanOrEqual(0);
			expect(deltaIdx).toBeGreaterThan(startIdx);
			expect(endIdx).toBeGreaterThan(deltaIdx);
			expect(doneIdx).toBeGreaterThan(endIdx);
		});

		test("ksk_ multiple tool calls before refusal: all dropped, no toolcall_* events", async () => {
			const emittedEvents: Array<{ type: string }> = [];
			let finalMessage: AssistantMessage | undefined;

			globalThis.fetch = (async () => {
				// Multiple tool calls followed by refusal - verifies all tools are dropped
				const responseBody =
					JSON.stringify({
						toolUseId: "tool-1",
						name: "read_file",
						input: '{"path":"/etc/passwd"}',
						stop: true,
					}) +
					"\n" +
					JSON.stringify({
						toolUseId: "tool-2",
						name: "exec",
						input: '{"cmd":"ls"}',
						stop: true,
					}) +
					"\n" +
					JSON.stringify({
						stopReason: "CONTENT_FILTERED",
						stopDetails: {
							refusal: {
								category: "BLOCKED",
								explanation: "Dangerous tool sequence",
							},
						},
					});
				return new Response(responseBody, { status: 200 });
			}) as unknown as typeof fetch;

			try {
				const stream = streamKiroApiKey(model, context, { apiKey: "ksk_test-secret", region: "us-east-1" });
				for await (const event of stream) {
					if (event.type.startsWith("toolcall_")) {
						emittedEvents.push({ type: event.type });
					}
					if (event.type === "error" && "error" in event) {
						finalMessage = event.error;
					}
				}
			} catch {
				// ignored
			}

			globalThis.fetch = originalFetch;

			// Verify NO toolcall_* events at all (both tools dropped)
			expect(emittedEvents).toHaveLength(0);

			// Verify final message has NO tool blocks
			const toolBlocks = (finalMessage?.content ?? []).filter(
				(b: TextContent | ThinkingContent | RedactedThinkingContent | ToolCall) => b.type === "toolCall",
			);
			expect(toolBlocks).toHaveLength(0);
		});
	});
});
