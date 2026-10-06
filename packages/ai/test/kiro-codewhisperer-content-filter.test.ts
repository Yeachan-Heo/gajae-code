/**
 * Issue #6150: when a Kiro (CodeWhisperer) stream returns HTTP 200 with an
 * AWS EventStream that ends in a metadataEvent carrying stopDetails.refusal,
 * the error should surface the explicit refusal category and explanation
 * instead of the generic "Kiro API key stream returned no tokens".
 */
import { afterEach, describe, expect, test } from "bun:test";
import { withProviderSafetyStopAdapterInvocation } from "../src/adapter-internals/provider-safety-stop";
import { crc32 } from "../src/providers/aws-eventstream";
import type { KiroCodeWhispererOptions } from "../src/providers/kiro-codewhisperer";
import { streamKiroCodeWhisperer } from "../src/providers/kiro-codewhisperer";
import type { Context, Model } from "../src/types";

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
	messages: [{ role: "user", content: "Write malware", timestamp: 1 }],
};

describe("Kiro CodeWhisperer content filter #6150", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("surfaces refusal from metadataEvent with category and explanation", async () => {
		const events: Array<{ type: string; message?: { errorMessage?: string; content?: unknown[] } }> = [];

		// Create an event stream with a text response followed by a refusal metadata event
		const initialResponse = encodeFrame(
			{ ":message-type": "event", ":event-type": "assistantResponseEvent" },
			new TextEncoder().encode(JSON.stringify({ content: "I can't help" })),
		);

		const metadataWithRefusal = encodeFrame(
			{ ":message-type": "event", ":event-type": "metadataEvent" },
			new TextEncoder().encode(
				JSON.stringify({
					stopReason: "CONTENT_FILTERED",
					stopDetails: {
						refusal: {
							category: "CYBER",
							explanation: "Request violates malicious code policy",
						},
					},
				}),
			),
		);

		globalThis.fetch = (async () => {
			return new Response(streamFrom([initialResponse, metadataWithRefusal]), {
				status: 200,
				headers: { "content-type": "application/vnd.amazon.eventstream" },
			});
		}) as unknown as typeof fetch;

		try {
			const stream = trustedStreamKiroCodeWhisperer(model, context, { apiKey: "token", region: "us-east-1" });
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

		// Should have errorKind set to provider_safety_stop
		expect((errorEvent?.message as { errorKind?: string })?.errorKind).toBe("provider_safety_stop");

		// Final message should have no content (refusal clears content)
		const blockType = (b: unknown): unknown =>
			typeof b === "object" && b !== null && "type" in b ? (b as { type: unknown }).type : undefined;
		const textBlocks = (errorEvent?.message?.content ?? []).filter(b => blockType(b) === "text");
		const toolCalls = (errorEvent?.message?.content ?? []).filter(b => blockType(b) === "toolCall");
		expect(textBlocks.length).toBe(0);
		expect(toolCalls.length).toBe(0);
	});

	test("surfaces refusal split across chunk boundaries", async () => {
		const events: Array<{ type: string; message?: { errorMessage?: string } }> = [];

		const initialResponse = encodeFrame(
			{ ":message-type": "event", ":event-type": "assistantResponseEvent" },
			new TextEncoder().encode(JSON.stringify({ content: "I can't help" })),
		);

		const metadataWithRefusal = encodeFrame(
			{ ":message-type": "event", ":event-type": "metadataEvent" },
			new TextEncoder().encode(
				JSON.stringify({
					stopReason: "CONTENT_FILTERED",
					stopDetails: {
						refusal: {
							category: "VIOLENCE",
							explanation: "Cannot assist with that request",
						},
					},
				}),
			),
		);

		// Concatenate frames and split at an arbitrary point
		const combined = new Uint8Array(initialResponse.length + metadataWithRefusal.length);
		combined.set(initialResponse, 0);
		combined.set(metadataWithRefusal, initialResponse.length);

		const splitPoint = Math.floor((initialResponse.length + metadataWithRefusal.length) / 3);
		const chunk1 = combined.subarray(0, splitPoint);
		const chunk2 = combined.subarray(splitPoint);

		globalThis.fetch = (async () => {
			return new Response(streamFrom([chunk1, chunk2]), {
				status: 200,
				headers: { "content-type": "application/vnd.amazon.eventstream" },
			});
		}) as unknown as typeof fetch;

		try {
			const stream = trustedStreamKiroCodeWhisperer(model, context, { apiKey: "token", region: "us-east-1" });
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
		expect(errorEvent?.message?.errorMessage).toContain("Kiro refused the request (VIOLENCE)");
		expect(errorEvent?.message?.errorMessage).toContain("Cannot assist with that request");

		// Should have errorKind set to provider_safety_stop
		expect((errorEvent?.message as { errorKind?: string })?.errorKind).toBe("provider_safety_stop");
	});

	test("does not report a refusal when the metadata carries none", async () => {
		const events: Array<{ type: string; message?: { errorMessage?: string } }> = [];

		// Create an event stream with only metadata, no response content, no refusal
		const emptyMetadata = encodeFrame(
			{ ":message-type": "event", ":event-type": "metadataEvent" },
			new TextEncoder().encode(
				JSON.stringify({
					stopReason: "COMPLETED",
				}),
			),
		);

		globalThis.fetch = (async () => {
			return new Response(streamFrom([emptyMetadata]), {
				status: 200,
				headers: { "content-type": "application/vnd.amazon.eventstream" },
			});
		}) as unknown as typeof fetch;

		try {
			const stream = trustedStreamKiroCodeWhisperer(model, context, { apiKey: "token", region: "us-east-1" });
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

		expect(events.find(e => e.type === "error")).toBeUndefined();
		expect(events.at(-1)?.type).toBe("done");
	});

	test("refusal without explanation is still reported with category", async () => {
		const events: Array<{ type: string; message?: { errorMessage?: string } }> = [];

		const metadataWithRefusalNoExplanation = encodeFrame(
			{ ":message-type": "event", ":event-type": "metadataEvent" },
			new TextEncoder().encode(
				JSON.stringify({
					stopReason: "CONTENT_FILTERED",
					stopDetails: {
						refusal: {
							category: "ILLEGAL",
							// No explanation
						},
					},
				}),
			),
		);

		globalThis.fetch = (async () => {
			return new Response(streamFrom([metadataWithRefusalNoExplanation]), {
				status: 200,
				headers: { "content-type": "application/vnd.amazon.eventstream" },
			});
		}) as unknown as typeof fetch;

		try {
			const stream = trustedStreamKiroCodeWhisperer(model, context, { apiKey: "token", region: "us-east-1" });
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
		expect(errorEvent?.message?.errorMessage).toBe("Kiro refused the request (ILLEGAL)");
		expect((errorEvent?.message as { errorKind?: string })?.errorKind).toBe("provider_safety_stop");
	});

	test("refusal without category is still reported", async () => {
		const events: Array<{ type: string; message?: { errorMessage?: string } }> = [];

		const metadataWithRefusalNoCategory = encodeFrame(
			{ ":message-type": "event", ":event-type": "metadataEvent" },
			new TextEncoder().encode(
				JSON.stringify({
					stopReason: "CONTENT_FILTERED",
					stopDetails: {
						refusal: {
							// No category
							explanation: "Your request cannot be processed",
						},
					},
				}),
			),
		);

		globalThis.fetch = (async () => {
			return new Response(streamFrom([metadataWithRefusalNoCategory]), {
				status: 200,
				headers: { "content-type": "application/vnd.amazon.eventstream" },
			});
		}) as unknown as typeof fetch;

		try {
			const stream = trustedStreamKiroCodeWhisperer(model, context, { apiKey: "token", region: "us-east-1" });
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
		expect(errorEvent?.message?.errorMessage).toContain("Kiro refused the request");
		expect(errorEvent?.message?.errorMessage).toContain("Your request cannot be processed");
		expect((errorEvent?.message as { errorKind?: string })?.errorKind).toBe("provider_safety_stop");
	});

	test("CodeWhisperer transport emits text_delta incrementally before stream ends", async () => {
		const emittedEvents: Array<{ type: string }> = [];

		const chunk1 = encodeFrame(
			{ ":message-type": "event", ":event-type": "assistantResponseEvent" },
			new TextEncoder().encode(JSON.stringify({ content: "Hello " })),
		);
		const chunk2 = encodeFrame(
			{ ":message-type": "event", ":event-type": "assistantResponseEvent" },
			new TextEncoder().encode(JSON.stringify({ content: "world" })),
		);

		globalThis.fetch = (async () => {
			return new Response(streamFrom([chunk1, chunk2]), {
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

	test("CodeWhisperer transport sets ttft < duration for successful completion", async () => {
		const capturedMessages: Array<{ type: string; message?: unknown }> = [];

		const responseFrame = encodeFrame(
			{ ":message-type": "event", ":event-type": "assistantResponseEvent" },
			new TextEncoder().encode(JSON.stringify({ content: "Hello" })),
		);

		globalThis.fetch = (async () => {
			return new Response(streamFrom([responseFrame]), {
				status: 200,
				headers: { "content-type": "application/vnd.amazon.eventstream" },
			});
		}) as unknown as typeof fetch;

		try {
			const stream = trustedStreamKiroCodeWhisperer(model, context, { apiKey: "token", region: "us-east-1" });
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

	test("refusal with MALWARE category produces authenticated safety stop", async () => {
		const events: Array<{ type: string; message?: { errorMessage?: string; errorKind?: string } }> = [];

		const metadataWithMalware = encodeFrame(
			{ ":message-type": "event", ":event-type": "metadataEvent" },
			new TextEncoder().encode(
				JSON.stringify({
					stopReason: "CONTENT_FILTERED",
					stopDetails: {
						refusal: {
							category: "MALWARE",
							explanation: "Request violates malware policy",
						},
					},
				}),
			),
		);

		globalThis.fetch = (async () => {
			return new Response(streamFrom([metadataWithMalware]), {
				status: 200,
				headers: { "content-type": "application/vnd.amazon.eventstream" },
			});
		}) as unknown as typeof fetch;

		try {
			const stream = trustedStreamKiroCodeWhisperer(model, context, { apiKey: "token", region: "us-east-1" });
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
		expect(errorEvent?.message?.errorMessage).toContain("Kiro refused the request (MALWARE)");
		expect(errorEvent?.message?.errorMessage).toContain("Request violates malware policy");

		// Should have errorKind set to provider_safety_stop (authenticated, not fallback)
		expect(errorEvent?.message?.errorKind).toBe("provider_safety_stop");
	});

	test("refusal with BLOCKED category produces authenticated safety stop", async () => {
		const events: Array<{ type: string; message?: { errorMessage?: string; errorKind?: string } }> = [];

		const metadataWithBlocked = encodeFrame(
			{ ":message-type": "event", ":event-type": "metadataEvent" },
			new TextEncoder().encode(
				JSON.stringify({
					stopReason: "CONTENT_FILTERED",
					stopDetails: {
						refusal: {
							category: "BLOCKED",
							explanation: "Request blocked by safety policy",
						},
					},
				}),
			),
		);

		globalThis.fetch = (async () => {
			return new Response(streamFrom([metadataWithBlocked]), {
				status: 200,
				headers: { "content-type": "application/vnd.amazon.eventstream" },
			});
		}) as unknown as typeof fetch;

		try {
			const stream = trustedStreamKiroCodeWhisperer(model, context, { apiKey: "token", region: "us-east-1" });
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
		expect(errorEvent?.message?.errorMessage).toContain("Kiro refused the request (BLOCKED)");
		expect(errorEvent?.message?.errorMessage).toContain("Request blocked by safety policy");

		// Should have errorKind set to provider_safety_stop (authenticated, not fallback)
		expect(errorEvent?.message?.errorKind).toBe("provider_safety_stop");
	});

	test("refusal with CYBER category still produces authenticated safety stop", async () => {
		const events: Array<{ type: string; message?: { errorMessage?: string; errorKind?: string } }> = [];

		const metadataWithCyber = encodeFrame(
			{ ":message-type": "event", ":event-type": "metadataEvent" },
			new TextEncoder().encode(
				JSON.stringify({
					stopReason: "CONTENT_FILTERED",
					stopDetails: {
						refusal: {
							category: "CYBER",
							explanation: "Request violates cyber security policy",
						},
					},
				}),
			),
		);

		globalThis.fetch = (async () => {
			return new Response(streamFrom([metadataWithCyber]), {
				status: 200,
				headers: { "content-type": "application/vnd.amazon.eventstream" },
			});
		}) as unknown as typeof fetch;

		try {
			const stream = trustedStreamKiroCodeWhisperer(model, context, { apiKey: "token", region: "us-east-1" });
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
		expect(errorEvent?.message?.errorMessage).toContain("Request violates cyber security policy");

		// Should have errorKind set to provider_safety_stop (authenticated, not fallback)
		expect(errorEvent?.message?.errorKind).toBe("provider_safety_stop");
	});
});
