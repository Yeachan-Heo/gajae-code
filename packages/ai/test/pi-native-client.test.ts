import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { streamPiNative } from "../src/providers/pi-native-client";
import type { AssistantMessage, AssistantMessageEvent, Context, FetchImpl, Model } from "../src/types";

function sseBytes(events: AssistantMessageEvent[]): Uint8Array {
	const encoder = new TextEncoder();
	const parts: Uint8Array[] = [];
	for (const event of events) {
		parts.push(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
	}
	parts.push(encoder.encode("data: [DONE]\n\n"));
	const total = parts.reduce((n, p) => n + p.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

function fakeBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

function fakeResponse(events: AssistantMessageEvent[], init: ResponseInit = {}): Response {
	return new Response(fakeBody(sseBytes(events)), {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
		...init,
	});
}

function baseAssistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

function fakeModel(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "http://llm-gateway.internal:4000",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 64000,
		transport: "pi-native",
		...overrides,
	};
}

const baseContext: Context = {
	systemPrompt: ["you are helpful"],
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const out: AssistantMessageEvent[] = [];
	for await (const event of stream) out.push(event);
	return out;
}

afterEach(() => {
	mock.restore();
});

describe("streamPiNative request shape", () => {
	it("POSTs `{modelId, context, options, stream:true}` to `<baseUrl>/v1/pi/stream`", async () => {
		const final = baseAssistant();
		const captured: { url?: string; init?: RequestInit } = {};
		const fetchImpl: FetchImpl = (async (input, init) => {
			captured.url = typeof input === "string" ? input : input.toString();
			captured.init = init;
			return fakeResponse([{ type: "done", reason: "stop", message: final }]);
		}) as FetchImpl;

		const stream = streamPiNative(fakeModel(), baseContext, {
			apiKey: "gw-bearer",
			fetch: fetchImpl,
			temperature: 0.7,
		});
		await stream.result();

		expect(captured.url).toBe("http://llm-gateway.internal:4000/v1/pi/stream");
		expect(captured.init?.method).toBe("POST");
		const headers = captured.init?.headers as Record<string, string>;
		expect(headers["Content-Type"]).toBe("application/json");
		expect(headers.Accept).toBe("text/event-stream");
		expect(headers.Authorization).toBe("Bearer gw-bearer");

		const body = JSON.parse(captured.init?.body as string);
		expect(body.modelId).toBe("claude-sonnet-4-5");
		expect(body.context).toEqual(baseContext);
		expect(body.stream).toBe(true);
		expect(body.options.temperature).toBe(0.7);
	});

	it("strips non-wire fields (signal, apiKey, fetch, callbacks) from `options`", async () => {
		// `apiKey` must ride in the Authorization header, never the body — sending
		// it twice would let a logged request leak the gateway bearer. The other
		// fields are non-serializable function/runtime handles.
		const captured: { init?: RequestInit } = {};
		const fetchImpl: FetchImpl = (async (_input, init) => {
			captured.init = init;
			return fakeResponse([{ type: "done", reason: "stop", message: baseAssistant() }]);
		}) as FetchImpl;

		const controller = new AbortController();
		const stream = streamPiNative(fakeModel(), baseContext, {
			apiKey: "gw-bearer",
			fetch: fetchImpl,
			signal: controller.signal,
			onPayload: () => undefined,
			onResponse: () => undefined,
			onSseEvent: () => undefined,
			providerSessionState: new Map(),
			maxTokens: 1024,
		});
		await stream.result();

		const body = JSON.parse(captured.init?.body as string);
		expect("apiKey" in body.options).toBe(false);
		expect("signal" in body.options).toBe(false);
		expect("fetch" in body.options).toBe(false);
		expect("onPayload" in body.options).toBe(false);
		expect("onResponse" in body.options).toBe(false);
		expect("onSseEvent" in body.options).toBe(false);
		expect("providerSessionState" in body.options).toBe(false);
		// And the legitimate options survive
		expect(body.options.maxTokens).toBe(1024);
	});

	it("normalizes trailing slashes on `baseUrl` so the endpoint never double-slashes", async () => {
		const captured: { url?: string } = {};
		const fetchImpl: FetchImpl = (async (input, _init) => {
			captured.url = typeof input === "string" ? input : input.toString();
			return fakeResponse([{ type: "done", reason: "stop", message: baseAssistant() }]);
		}) as FetchImpl;

		await streamPiNative(fakeModel({ baseUrl: "http://llm-gateway.internal:4000///" }), baseContext, {
			apiKey: "k",
			fetch: fetchImpl,
		}).result();
		expect(captured.url).toBe("http://llm-gateway.internal:4000/v1/pi/stream");
	});

	it("forwards `model.headers` and lets a caller-supplied Authorization win", async () => {
		const captured: { init?: RequestInit } = {};
		const fetchImpl: FetchImpl = (async (_input, init) => {
			captured.init = init;
			return fakeResponse([{ type: "done", reason: "stop", message: baseAssistant() }]);
		}) as FetchImpl;

		await streamPiNative(
			fakeModel({ headers: { "x-gjc-slot": "worker-1", Authorization: "Bearer model-wins" } }),
			baseContext,
			{ apiKey: "options-loses", fetch: fetchImpl },
		).result();

		const headers = captured.init?.headers as Record<string, string>;
		expect(headers["x-gjc-slot"]).toBe("worker-1");
		expect(headers.Authorization).toBe("Bearer model-wins");
	});

	it("throws synchronously when `baseUrl` is missing", async () => {
		const broken = fakeModel({ baseUrl: "" as unknown as string });
		// The promise the iterator awaits surfaces the error via `.result()`.
		const stream = streamPiNative(broken, baseContext, { apiKey: "k" });
		await expect(stream.result()).rejects.toThrow(/baseUrl/);
	});
});

describe("streamPiNative event flow", () => {
	it("pushes parsed events verbatim and resolves `.result()` on terminal `done`", async () => {
		const final = baseAssistant({
			content: [{ type: "text", text: "hi" }],
			usage: {
				input: 4,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 6,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const partial = baseAssistant({ content: [{ type: "text", text: "hi" }] });
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: baseAssistant() },
			{ type: "text_delta", contentIndex: 0, delta: "hi", partial },
			{ type: "done", reason: "stop", message: final },
		];
		const fetchImpl: FetchImpl = (async () => fakeResponse(events)) as FetchImpl;

		const stream = streamPiNative(fakeModel(), baseContext, { apiKey: "k", fetch: fetchImpl });
		const seen = await collectEvents(stream);
		const result = await stream.result();

		expect(seen).toEqual(events);
		expect(result).toEqual(final);
	});

	it("classifies non-2xx responses into Errors with status + type tags", async () => {
		const fetchImpl: FetchImpl = (async () =>
			new Response(JSON.stringify({ error: { type: "authentication_error", message: "no credential" } }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			})) as FetchImpl;

		const stream = streamPiNative(fakeModel(), baseContext, { apiKey: "k", fetch: fetchImpl });
		await expect(stream.result()).rejects.toThrow(/no credential/);
	});

	it("falls back to plain text on a non-JSON error body", async () => {
		const fetchImpl: FetchImpl = (async () => new Response("bad gateway", { status: 502 })) as FetchImpl;
		const stream = streamPiNative(fakeModel(), baseContext, { apiKey: "k", fetch: fetchImpl });
		await expect(stream.result()).rejects.toThrow(/502/);
	});

	it("fails with classified transport evidence when the SSE stream closes silently", async () => {
		const halfEvents: AssistantMessageEvent[] = [{ type: "start", partial: baseAssistant() }];
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const event of halfEvents) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				controller.close();
			},
		});
		const fetchImpl: FetchImpl = (async () =>
			new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })) as FetchImpl;

		const stream = streamPiNative(fakeModel(), baseContext, { apiKey: "k", fetch: fetchImpl });
		await expect(collectEvents(stream)).rejects.toMatchObject({
			message: "pi-native SSE stream closed without terminal event",
			status: 502,
		});
		await expect(stream.result()).rejects.toMatchObject({ status: 502 });
	});

	it("fails fast when the caller's signal is already aborted before fetch fires", async () => {
		const fetchImpl = spyOn({ fetch: globalThis.fetch }, "fetch") as unknown as FetchImpl;
		const controller = new AbortController();
		controller.abort(new Error("pre-aborted"));

		const stream = streamPiNative(fakeModel(), baseContext, {
			apiKey: "k",
			fetch: fetchImpl,
			signal: controller.signal,
		});

		await expect(stream.result()).rejects.toThrow(/pre-aborted/);
		// fetch was never called — short-circuit happened in the abort guard
		expect((fetchImpl as unknown as ReturnType<typeof spyOn>).mock.calls.length).toBe(0);
	});

	it("forwards the caller's AbortSignal to the underlying fetch", async () => {
		// The real abort path runs through fetch — its body is wired to the
		// signal by the runtime. We test the contract we guarantee (signal
		// forwarding); body-cancel hooks are a best-effort backstop on the
		// `streamProxy` shape, and not worth asserting through a synthetic
		// `ReadableStream` (whose reader is locked by `readSseJson`, so any
		// `body.cancel()` would throw a `TypeError("locked")` we then swallow).
		const captured: { signal?: AbortSignal } = {};
		const fetchImpl: FetchImpl = (async (_input, init) => {
			captured.signal = init?.signal ?? undefined;
			return fakeResponse([{ type: "done", reason: "stop", message: baseAssistant() }]);
		}) as FetchImpl;
		const controller = new AbortController();
		await streamPiNative(fakeModel(), baseContext, {
			apiKey: "k",
			fetch: fetchImpl,
			signal: controller.signal,
		}).result();
		expect(captured.signal).toBe(controller.signal);
	});
});
