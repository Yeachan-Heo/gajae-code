/**
 * Regression test for issue #6002: Kiro CodeWhisperer OAuth endpoint
 * was using non-existent amazoncodewhispererstreamingservice hostname.
 * Must use codewhisperer.${region}.amazonaws.com instead.
 */
import { describe, expect, test } from "bun:test";
import { crc32 } from "../src/providers/aws-eventstream";
import { streamKiroCodeWhisperer } from "../src/providers/kiro-codewhisperer";
import type { AssistantMessage, Context, Model } from "../src/types";
import { PROVIDER_PROTOCOL_MISMATCH_ERROR_CODE } from "../src/utils/fallback-transport";

const originalFetch = globalThis.fetch;

// Frame builder for eventstream test fixtures (shared with aws-eventstream.test.ts)
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

describe("Kiro CodeWhisperer OAuth endpoint #6002", () => {
	test(`uses codewhisperer.\${region}.amazonaws.com hostname for OAuth bearer token`, async () => {
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
				baseUrl: "",
				reasoning: false,
				input: ["text"],
				output: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8_192,
			} satisfies Model<"kiro-codewhisperer-stream">;

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
		expect(capturedHeaders?.["x-amz-target"]).toBe("AmazonCodeWhispererStreamingService.GenerateAssistantResponse");
		expect(capturedHeaders?.["content-type"]).toBe("application/x-amz-json-1.0");
	});

	test("respects custom region parameter", async () => {
		let capturedUrl: string | undefined;

		globalThis.fetch = (async (input: string | URL | Request, _init?: RequestInit) => {
			capturedUrl = String(input);
			return new Response("error", { status: 500 });
		}) as unknown as typeof fetch;

		try {
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
		// KIRO_REGION takes precedence over AWS_REGION, so clear it for the duration of
		// the test and restore both exactly (deleting keys that were originally unset).
		const originalRegion = process.env.AWS_REGION;
		const originalKiroRegion = process.env.KIRO_REGION;
		delete process.env.KIRO_REGION;
		process.env.AWS_REGION = "ap-southeast-1";

		let capturedUrl: string | undefined;

		globalThis.fetch = (async (input: string | URL | Request, _init?: RequestInit) => {
			capturedUrl = String(input);
			return new Response("error", { status: 500 });
		}) as unknown as typeof fetch;

		try {
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
		} finally {
			globalThis.fetch = originalFetch;
			if (originalRegion === undefined) delete process.env.AWS_REGION;
			else process.env.AWS_REGION = originalRegion;
			if (originalKiroRegion === undefined) delete process.env.KIRO_REGION;
			else process.env.KIRO_REGION = originalKiroRegion;
		}

		expect(capturedUrl).toBe("https://codewhisperer.ap-southeast-1.amazonaws.com/");
	});

	async function streamError(response: Response): Promise<AssistantMessage | undefined> {
		globalThis.fetch = (async () => response) as unknown as typeof fetch;
		try {
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
			const context: Context = { messages: [{ role: "user", content: "say ok", timestamp: 1 }] };
			const stream = streamKiroCodeWhisperer(model, context, { apiKey: "secret-bearer", region: "us-east-1" });
			let error: AssistantMessage | undefined;
			for await (const event of stream) {
				if (event.type === "error") error = event.error;
			}
			return error;
		} finally {
			globalThis.fetch = originalFetch;
		}
	}

	async function streamErrorMessage(response: Response): Promise<string | undefined> {
		return (await streamError(response))?.errorMessage;
	}

	test("does not classify a non-eventstream 200 as a retryable transport failure", async () => {
		const error = await streamError(
			new Response(JSON.stringify({ message: "Invalid API key" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		expect(error?.errorMessage).toContain("Invalid API key");
		expect(error?.transportFailure).toBeUndefined();
		expect(error?.errorStatus).toBeUndefined();
	});

	test("surfaces a non-eventstream 200 body instead of an eventstream truncation error (#6158)", async () => {
		const errorMessage = await streamErrorMessage(
			new Response(JSON.stringify({ message: "Invalid API key" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		expect(errorMessage).toContain("Invalid API key");
		expect(errorMessage).toContain("application/json");
		expect(errorMessage).toContain("non-eventstream 200 response");
		expect(errorMessage).not.toContain("eventstream: truncated message");
		expect(errorMessage).not.toContain("secret-bearer");
	});

	test("does not parse a status out of status-like body text in a non-eventstream 200", async () => {
		const error = await streamError(
			new Response("Error: 401 Invalid API key (HTTP 503)", {
				status: 200,
				headers: { "content-type": "text/plain" },
			}),
		);

		expect(error?.errorMessage).toContain("401 Invalid API key");
		expect(error?.errorStatus).toBeUndefined();
		expect(error?.transportFailure).toBeUndefined();
		expect(error?.errorCode).toBe(PROVIDER_PROTOCOL_MISMATCH_ERROR_CODE);
	});

	test("classifies a bodyless 204 as a terminal protocol mismatch", async () => {
		const error = await streamError(new Response(null, { status: 204 }));

		expect(error?.errorMessage).toContain("non-eventstream 204 response");
		expect(error?.errorCode).toBe(PROVIDER_PROTOCOL_MISMATCH_ERROR_CODE);
		expect(error?.errorStatus).toBeUndefined();
		expect(error?.transportFailure).toBeUndefined();
	});

	test("classifies a bodyless 2xx labeled as eventstream as a terminal protocol mismatch", async () => {
		const error = await streamError(
			new Response(null, { status: 204, headers: { "content-type": "application/vnd.amazon.eventstream" } }),
		);

		expect(error?.errorMessage).toContain("non-eventstream 204 response");
		expect(error?.errorCode).toBe(PROVIDER_PROTOCOL_MISMATCH_ERROR_CODE);
		expect(error?.errorStatus).toBeUndefined();
	});

	test("redacts an echoed bearer credential from a non-eventstream 200 body", async () => {
		const errorMessage = await streamErrorMessage(
			new Response("echo: Authorization: Bearer secret-bearer; raw=secret-bearer", {
				status: 200,
				headers: { "content-type": "text/plain" },
			}),
		);

		expect(errorMessage).toContain("non-eventstream");
		expect(errorMessage).not.toContain("secret-bearer");
	});

	test("keeps the full body diagnostic budget after the status/content-type prefix", async () => {
		const body = `${"a".repeat(990)}TAIL`;
		const errorMessage = await streamErrorMessage(
			new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
		);

		expect(errorMessage).toContain("non-eventstream 200 response (application/json)");
		expect(errorMessage).toContain("TAIL");
	});

	test("reads only a bounded prefix of a non-terminating non-eventstream body", async () => {
		let pulls = 0;
		let cancelled = false;
		const chunk = new TextEncoder().encode("x".repeat(1024));
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls++;
				controller.enqueue(chunk);
			},
			cancel() {
				cancelled = true;
			},
		});
		const errorMessage = await streamErrorMessage(
			new Response(body, { status: 200, headers: { "content-type": "text/html" } }),
		);

		expect(errorMessage).toContain("non-eventstream");
		expect(cancelled).toBe(true);
		expect(pulls).toBeLessThan(16);
	});

	test("accepts the eventstream media type case-insensitively with parameters", async () => {
		const errorMessage = await streamErrorMessage(
			new Response(new Uint8Array(0), {
				status: 200,
				headers: { "content-type": "Application/Vnd.Amazon.Eventstream; charset=binary" },
			}),
		);

		expect(errorMessage ?? "").not.toContain("non-eventstream");
	});

	test("rejects EOF with completed tool A and unfinished tool B", async () => {
		const frames: Uint8Array[] = [];

		// Frame 1: Text content
		const textPayload = new TextEncoder().encode(
			JSON.stringify({ assistantResponseEvent: { content: "Processing files" } }),
		);
		frames.push(
			encodeFrame(
				{
					":message-type": "event",
					":event-type": "assistantResponseEvent",
					":content-type": "application/json",
				},
				textPayload,
			),
		);

		// Frame 2: Tool A - complete with stop signal
		const toolAPayload = new TextEncoder().encode(
			JSON.stringify({
				toolUseId: "tool-a",
				name: "read_file",
				input: JSON.stringify({ path: "/src/a.ts" }),
				stop: true,
			}),
		);
		frames.push(
			encodeFrame(
				{
					":message-type": "event",
					":event-type": "toolUseEvent",
				},
				toolAPayload,
			),
		);

		// Frame 3: Tool B - start with no stop signal (unfinished)
		const toolBPayload = new TextEncoder().encode(
			JSON.stringify({
				toolUseId: "tool-b",
				name: "read_file",
				input: '{"path":"/src/b",',
				// Incomplete: stream ends before input is finished
			}),
		);
		frames.push(
			encodeFrame(
				{
					":message-type": "event",
					":event-type": "toolUseEvent",
				},
				toolBPayload,
			),
		);

		const response = new Response(streamFrom(frames), {
			status: 200,
			headers: { "content-type": "application/vnd.amazon.eventstream" },
		});

		const error = await streamError(response);
		expect(error?.errorMessage).toContain("incomplete tool calls");
		expect(error?.errorMessage).toContain("tool-b");
	});

	test("rejects EOF with text and unfinished tool B", async () => {
		const frames: Uint8Array[] = [];

		// Frame 1: Text content
		const textPayload = new TextEncoder().encode(
			JSON.stringify({ assistantResponseEvent: { content: "Reading file" } }),
		);
		frames.push(
			encodeFrame(
				{
					":message-type": "event",
					":event-type": "assistantResponseEvent",
					":content-type": "application/json",
				},
				textPayload,
			),
		);

		// Frame 2: Tool B - start with no stop signal (unfinished)
		const toolBPayload = new TextEncoder().encode(
			JSON.stringify({
				toolUseId: "tool-b",
				name: "read_file",
				input: "{",
				// Incomplete: missing rest of object
			}),
		);
		frames.push(
			encodeFrame(
				{
					":message-type": "event",
					":event-type": "toolUseEvent",
				},
				toolBPayload,
			),
		);

		const response = new Response(streamFrom(frames), {
			status: 200,
			headers: { "content-type": "application/vnd.amazon.eventstream" },
		});

		const error = await streamError(response);
		expect(error?.errorMessage).toContain("incomplete tool calls");
		expect(error?.errorMessage).toContain("tool-b");
	});
});
