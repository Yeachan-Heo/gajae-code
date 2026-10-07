import { afterAll, afterEach, describe, expect, test, vi } from "bun:test";
import { crc32 } from "../src/providers/aws-eventstream";
import { streamKiroCodeWhisperer } from "../src/providers/kiro-codewhisperer";
import type { AssistantMessageEvent, Context, Model } from "../src/types";

// Frame encoder (copied from aws-eventstream.test.ts for use in fixtures)
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

// Mock fetch to capture request and serve responses
let capturedRequest: { headers: Record<string, string>; body: string } | null = null;

function createMockFetch() {
	return async (_url: string, init?: RequestInit) => {
		// Capture request
		const headers: Record<string, string> = {};
		const headerObj = init?.headers;
		if (headerObj instanceof Headers) {
			headerObj.forEach((v, k) => {
				headers[k.toLowerCase()] = v;
			});
		} else if (Array.isArray(headerObj)) {
			headerObj.forEach(([k, v]) => {
				headers[k.toLowerCase()] = v;
			});
		} else if (typeof headerObj === "object" && headerObj !== null) {
			Object.entries(headerObj).forEach(([k, v]) => {
				headers[k.toLowerCase()] = v as string;
			});
		}

		const body = init?.body ? new TextDecoder().decode(init.body as Uint8Array) : "";
		capturedRequest = { headers, body };

		// Return mock response
		const frame = encodeFrame(
			{ ":message-type": "event", ":event-type": "messageMetadataEvent" },
			new TextEncoder().encode("{}"),
		);

		return new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(frame);
					controller.close();
				},
			}),
			{
				status: 200,
				headers: { "content-type": "application/vnd.amazon.eventstream" },
			},
		);
	};
}

const mockFetch = vi.spyOn(globalThis, "fetch" as any).mockImplementation(createMockFetch());

afterEach(() => {
	mockFetch.mockClear();
});

afterAll(() => {
	mockFetch.mockRestore();
});

const mockModel: Model<"kiro-codewhisperer-stream"> = {
	id: "test-model",
	name: "Test Model",
	api: "kiro-codewhisperer-stream" as const,
	provider: "kiro" as const,
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	output: ["text"],
	contextWindow: 128000,
	maxTokens: 4096,
	cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0 },
};

describe("kiro-codewhisperer wire protocol", () => {
	test("sends correct x-amz-target header (not amzn-X-amz-target)", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};

		const stream = streamKiroCodeWhisperer(mockModel, context, {
			apiKey: "test-token",
		});

		// Drain stream to trigger the fetch
		for await (const _event of stream) {
			// consume events
		}

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest!.headers["x-amz-target"]).toBe(
			"AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
		);
		expect(capturedRequest!.headers["amzn-x-amz-target"]).toBeUndefined();
	});

	test("sends application/x-amz-json-1.0 content-type (not application/json)", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};

		const stream = streamKiroCodeWhisperer(mockModel, context, {
			apiKey: "test-token",
		});

		// Drain stream
		for await (const _event of stream) {
			// consume events
		}

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest!.headers["content-type"]).toBe("application/x-amz-json-1.0");
	});

	test("does not send x-amzn-codewhisperer-proflearn header", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};

		const stream = streamKiroCodeWhisperer(mockModel, context, {
			apiKey: "test-token",
			profileArn: "arn:aws:iam::123456789012:role/my-role",
		});

		// Drain stream
		for await (const _event of stream) {
			// consume events
		}

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest!.headers["x-amzn-codewhisperer-proflearn"]).toBeUndefined();
	});

	test("sends profileArn in request body next to conversationState", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};

		const stream = streamKiroCodeWhisperer(mockModel, context, {
			apiKey: "test-token",
			profileArn: "arn:aws:iam::123456789012:role/my-role",
		});

		// Drain stream
		for await (const _event of stream) {
			// consume events
		}

		expect(capturedRequest).not.toBeNull();
		const body = JSON.parse(capturedRequest!.body);
		expect(body.conversationState.profileArn).toBe("arn:aws:iam::123456789012:role/my-role");
	});

	test("sends tools as flat array in userInputMessageContext, not {tools:[...]}", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "call a tool", timestamp: Date.now() }],
			tools: [
				{
					name: "test-tool",
					description: "A test tool",
					parameters: { type: "object", properties: {} },
				},
			],
		};

		const stream = streamKiroCodeWhisperer(mockModel, context, {
			apiKey: "test-token",
		});

		// Drain stream
		for await (const _event of stream) {
			// consume events
		}

		expect(capturedRequest).not.toBeNull();
		const body = JSON.parse(capturedRequest!.body);
		const msg = body.conversationState.currentMessage.userInputMessage;
		const tools = msg.userInputMessageContext?.tools;

		// Should be a flat array
		expect(Array.isArray(tools)).toBe(true);
		expect(tools?.[0]).toHaveProperty("toolSpecification");
		// Should NOT have nested {tools: [...]} structure
		expect(tools?.tools).toBeUndefined();
	});

	test("handles flat event payloads {content} not {assistantResponseEvent:{content}}", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};

		// Mock the response with flat payload
		const flatPayload = { content: "Hello, world!" };
		const frame = encodeFrame(
			{ ":message-type": "event", ":event-type": "assistantResponseEvent" },
			new TextEncoder().encode(JSON.stringify(flatPayload)),
		);

		mockFetch.mockImplementation(async () => {
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(frame);
						controller.close();
					},
				}),
				{
					status: 200,
					headers: { "content-type": "application/vnd.amazon.eventstream" },
				},
			);
		});

		const stream = streamKiroCodeWhisperer(mockModel, context, {
			apiKey: "test-token",
		});

		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// Should have captured text content from flat payload
		const textEvent = events.find(e => e.type === "text_delta");
		expect(textEvent).toBeDefined();
		expect(textEvent?.delta).toBe("Hello, world!");
	});

	test("accumulates toolUseEvent input fragments per toolUseId", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};

		// Tool input arrives in two frames, both with same toolUseId
		// Frame 1: partial input
		const frame1 = encodeFrame(
			{ ":message-type": "event", ":event-type": "toolUseEvent" },
			new TextEncoder().encode(
				JSON.stringify({
					toolUseId: "tool-1",
					name: "test-tool",
					input: '{"key": "va',
				}),
			),
		);

		// Frame 2: rest of input with stop:true
		const frame2 = encodeFrame(
			{ ":message-type": "event", ":event-type": "toolUseEvent" },
			new TextEncoder().encode(
				JSON.stringify({
					toolUseId: "tool-1",
					input: 'lue"}',
					stop: true,
				}),
			),
		);

		mockFetch.mockImplementation(async () => {
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(frame1);
						controller.enqueue(frame2);
						controller.close();
					},
				}),
				{
					status: 200,
					headers: { "content-type": "application/vnd.amazon.eventstream" },
				},
			);
		});

		const stream = streamKiroCodeWhisperer(mockModel, context, {
			apiKey: "test-token",
		});

		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// Should have one tool call with accumulated input
		const toolcallEvent = events.find(e => e.type === "toolcall_end");
		expect(toolcallEvent).toBeDefined();
		expect(toolcallEvent?.toolCall.id).toBe("tool-1");
		expect(toolcallEvent?.toolCall.name).toBe("test-tool");
		expect(toolcallEvent?.toolCall.arguments).toEqual({ key: "value" });
	});

	test("associates ID-less input fragments with the active tool call", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};

		// Tool input arrives in frames, last two without toolUseId
		// Frame 1: toolUseId + partial input
		const frame1 = encodeFrame(
			{ ":message-type": "event", ":event-type": "toolUseEvent" },
			new TextEncoder().encode(
				JSON.stringify({
					toolUseId: "tool-1",
					name: "test-tool",
					input: '{"data": "',
				}),
			),
		);

		// Frame 2: continuation without toolUseId
		const frame2 = encodeFrame(
			{ ":message-type": "event", ":event-type": "toolUseEvent" },
			new TextEncoder().encode(
				JSON.stringify({
					input: "hello",
				}),
			),
		);

		// Frame 3: rest of input with stop:true, no toolUseId
		const frame3 = encodeFrame(
			{ ":message-type": "event", ":event-type": "toolUseEvent" },
			new TextEncoder().encode(
				JSON.stringify({
					input: '"}',
					stop: true,
				}),
			),
		);

		mockFetch.mockImplementation(async () => {
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(frame1);
						controller.enqueue(frame2);
						controller.enqueue(frame3);
						controller.close();
					},
				}),
				{
					status: 200,
					headers: { "content-type": "application/vnd.amazon.eventstream" },
				},
			);
		});

		const stream = streamKiroCodeWhisperer(mockModel, context, {
			apiKey: "test-token",
		});

		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// Should have one tool call with all input fragments accumulated
		const toolcallEvent = events.find(e => e.type === "toolcall_end");
		expect(toolcallEvent).toBeDefined();
		expect(toolcallEvent?.toolCall.id).toBe("tool-1");
		expect(toolcallEvent?.toolCall.name).toBe("test-tool");
		expect(toolcallEvent?.toolCall.arguments).toEqual({ data: "hello" });
	});

	test("emits start exactly once for a tool-only multi-fragment stream", async () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "test",
					timestamp: Date.now(),
				},
			],
			tools: [
				{
					name: "test-tool",
					description: "A test tool",
					parameters: { type: "object" },
				},
			],
		};

		// Frame 1: tool use fragment (tool with ID, partial input, no stop)
		const frame1 = encodeFrame(
			{ ":message-type": "event", ":event-type": "toolUseEvent" },
			new TextEncoder().encode(
				JSON.stringify({
					toolUseId: "tool-1",
					name: "test-tool",
					input: '{"data":"',
				}),
			),
		);

		// Frame 2: continuation without toolUseId (ID-less fragment)
		const frame2 = encodeFrame(
			{ ":message-type": "event", ":event-type": "toolUseEvent" },
			new TextEncoder().encode(
				JSON.stringify({
					input: "world",
				}),
			),
		);

		// Frame 3: final fragment with stop
		const frame3 = encodeFrame(
			{ ":message-type": "event", ":event-type": "toolUseEvent" },
			new TextEncoder().encode(
				JSON.stringify({
					input: '"}',
					stop: true,
				}),
			),
		);

		mockFetch.mockImplementation(async () => {
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(frame1);
						controller.enqueue(frame2);
						controller.enqueue(frame3);
						controller.close();
					},
				}),
				{
					status: 200,
					headers: { "content-type": "application/vnd.amazon.eventstream" },
				},
			);
		});

		const stream = streamKiroCodeWhisperer(mockModel, context, {
			apiKey: "test-token",
		});

		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// Should have exactly one start event
		const startEvents = events.filter(e => e.type === "start");
		expect(startEvents).toHaveLength(1);

		// Should have one tool call with all input fragments accumulated
		const toolcallEvent = events.find(e => e.type === "toolcall_end");
		expect(toolcallEvent).toBeDefined();
		expect(toolcallEvent?.toolCall.id).toBe("tool-1");
		expect(toolcallEvent?.toolCall.name).toBe("test-tool");
		expect(toolcallEvent?.toolCall.arguments).toEqual({ data: "world" });
	});

	test("Bearer token emits tool events before ordinary error", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "test", timestamp: 1 }],
		};

		// Prepare mock response: tool event followed by error in metadata event
		const toolEventFrame = encodeFrame(
			{ ":message-type": "event", ":event-type": "toolUseEvent" },
			new TextEncoder().encode(
				JSON.stringify({
					toolUseId: "tool-123",
					name: "test-tool",
					input: '{"action":"test"}',
					stop: true,
				}),
			),
		);

		// Error frame with message indicating an error
		const errorEventFrame = encodeFrame(
			{ ":message-type": "event", ":event-type": "messageMetadataEvent" },
			new TextEncoder().encode(
				JSON.stringify({
					error: { message: "Rate limit exceeded" },
				}),
			),
		);

		mockFetch.mockImplementation(async () => {
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(toolEventFrame);
						controller.enqueue(errorEventFrame);
						controller.close();
					},
				}),
				{
					status: 200,
					headers: { "content-type": "application/vnd.amazon.eventstream" },
				},
			);
		});

		const stream = streamKiroCodeWhisperer(mockModel, context, {
			apiKey: "test-token",
		});

		const events: AssistantMessageEvent[] = [];
		try {
			for await (const event of stream) {
				events.push(event);
			}
		} catch {
			// Error caught in events
		}

		// When an ordinary error follows a tool, tool events should be emitted before the error
		const toolcallEnd = events.find(e => e.type === "toolcall_end");
		const errorEvent = events.find(e => e.type === "error");

		expect(toolcallEnd).toBeDefined();
		expect(errorEvent).toBeDefined();

		// Verify tool event comes before error
		const toolEndIdx = events.findIndex(e => e.type === "toolcall_end");
		const errorIdx = events.findIndex(e => e.type === "error");

		if (toolEndIdx >= 0 && errorIdx >= 0) {
			expect(toolEndIdx).toBeLessThan(errorIdx);
		}
	});
});
