import { describe, expect, it, vi } from "bun:test";
import { gunzipSync } from "node:zlib";
import type Anthropic from "@anthropic-ai/sdk";
import { buildAnthropicClientOptions, streamAnthropic } from "../src/providers/anthropic";
import type { Context, FetchImpl, Model, ProviderDispatch } from "../src/types";

const firstPartyModel: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

// A non-first-party host keeps the body uncompressed (gzip is api.anthropic.com only).
const plainModel: Model<"anthropic-messages"> = { ...firstPartyModel, baseUrl: "https://gateway.example.test" };

const context: Context = {
	messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }],
};

interface FetchCall {
	url: string;
	init: RequestInit | undefined;
}

type FakeResponder = (call: FetchCall, callIndex: number) => Response;

function sseResponse(text: string): Response {
	const events: Array<Record<string, unknown>> = [
		{
			type: "message_start",
			message: {
				id: "msg_dispatch",
				usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function fakeFetch(responder: FakeResponder = () => sseResponse("hi")): { fetch: FetchImpl; calls: FetchCall[] } {
	const calls: FetchCall[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const call: FetchCall = { url: input instanceof Request ? input.url : String(input), init };
		calls.push(call);
		return responder(call, calls.length - 1);
	}) as FetchImpl;
	return { fetch: fetchImpl, calls };
}

function headerMap(headers: RequestInit["headers"]): Record<string, string> {
	return Object.fromEntries(new Headers(headers));
}

function wireBytes(body: RequestInit["body"]): Uint8Array {
	if (typeof body === "string") return new TextEncoder().encode(body);
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	throw new Error("uninspectable body");
}

function dispatchText(body: ProviderDispatch["body"]): string {
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return new TextDecoder().decode(body);
	throw new Error("dispatch has no body");
}

describe("Anthropic provider dispatch hook", () => {
	it("hands the observer the exact request the fake fetch receives", async () => {
		const { fetch, calls } = fakeFetch();
		const dispatches: ProviderDispatch[] = [];

		const message = await streamAnthropic(plainModel, context, {
			apiKey: "test-key",
			fetch,
			onProviderDispatch: dispatch => dispatches.push(dispatch),
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(calls).toHaveLength(1);
		expect(dispatches).toHaveLength(1);
		const [dispatch] = dispatches;
		const [call] = calls;
		expect(dispatch.api).toBe("anthropic-messages");
		expect(dispatch.method).toBe("POST");
		expect(dispatch.url).toBe(call.url);
		expect(dispatch.url).toContain("gateway.example.test");
		expect(typeof dispatch.body).toBe("string");
		expect(dispatchText(dispatch.body)).toBe(new TextDecoder().decode(wireBytes(call.init?.body)));
		expect(JSON.parse(dispatchText(dispatch.body)).model).toBe(plainModel.id);
		expect(Object.fromEntries(dispatch.headers)).toEqual(headerMap(call.init?.headers));
	});

	it("keeps the wire request unchanged when the observer mutates its copies", async () => {
		const { fetch, calls } = fakeFetch();
		let observedBody = "";
		let observedContentType: string | null = null;

		await streamAnthropic(firstPartyModel, context, {
			apiKey: "test-key",
			fetch,
			onProviderDispatch: dispatch => {
				observedContentType = dispatch.headers.get("content-type");
				if (dispatch.body instanceof Uint8Array) {
					observedBody = new TextDecoder().decode(gunzipSync(dispatch.body));
					dispatch.body.fill(0);
				}
				dispatch.headers.set("x-api-key", "mutated-by-observer");
				dispatch.headers.delete("content-encoding");
				dispatch.headers.delete("content-type");
			},
		}).result();

		expect(calls).toHaveLength(1);
		const wire = headerMap(calls[0].init?.headers);
		expect(wire["x-api-key"]).toBe("test-key");
		expect(wire["content-encoding"]).toBe("gzip");
		expect(wire["content-type"]).toBe(observedContentType ?? "");
		const wireJson = new TextDecoder().decode(gunzipSync(wireBytes(calls[0].init?.body)));
		expect(wireJson).toBe(observedBody);
		expect(JSON.parse(wireJson).model).toBe(firstPartyModel.id);
	});

	it("observes the final gzip body, not the pre-compression JSON", async () => {
		const { fetch, calls } = fakeFetch();
		const dispatches: ProviderDispatch[] = [];

		await streamAnthropic(firstPartyModel, context, {
			apiKey: "test-key",
			fetch,
			onProviderDispatch: dispatch => dispatches.push(dispatch),
		}).result();

		expect(dispatches).toHaveLength(1);
		const [dispatch] = dispatches;
		expect(dispatch.body).toBeInstanceOf(Uint8Array);
		expect(dispatch.headers.get("content-encoding")).toBe("gzip");
		expect(dispatch.headers.has("content-length")).toBe(false);
		const wire = wireBytes(calls[0].init?.body);
		expect(Array.from(dispatch.body as Uint8Array)).toEqual(Array.from(wire));
		expect(wire[0]).toBe(0x1f);
		expect(wire[1]).toBe(0x8b);
		expect(JSON.parse(new TextDecoder().decode(gunzipSync(dispatch.body as Uint8Array))).model).toBe(
			firstPartyModel.id,
		);
	});

	it("does not consume unreadable bodies and reports them as undefined", async () => {
		const { fetch, calls } = fakeFetch();
		const dispatches: ProviderDispatch[] = [];
		const options = buildAnthropicClientOptions({
			model: plainModel,
			apiKey: "test-key",
			fetch,
			onProviderDispatch: dispatch => dispatches.push(dispatch),
		});
		const requestFetch = options.fetch!;

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("{}"));
				controller.close();
			},
		});
		await requestFetch("https://gateway.example.test/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: stream,
		});

		const request = new Request("https://gateway.example.test/v1/messages", { method: "POST", body: "payload" });
		await requestFetch(request);

		expect(dispatches).toHaveLength(2);
		expect(dispatches[0].body).toBeUndefined();
		expect(dispatches[1].body).toBeUndefined();
		expect(dispatches[1].method).toBe("POST");
		expect(dispatches[1].url).toBe(request.url);
		expect(stream.locked).toBe(false);
		expect(calls[0].init?.body).toBe(stream);
		expect(request.bodyUsed).toBe(false);
	});

	it("reports the headers fetch sends for a Request input, with init headers replacing the Request's", async () => {
		const { fetch } = fakeFetch();
		const dispatches: ProviderDispatch[] = [];
		const options = buildAnthropicClientOptions({
			model: plainModel,
			apiKey: "test-key",
			fetch,
			onProviderDispatch: dispatch => dispatches.push(dispatch),
		});
		const requestFetch = options.fetch!;
		const request = new Request("https://gateway.example.test/v1/messages", {
			method: "POST",
			headers: { authorization: "Bearer request-header", "x-request-only": "1" },
		});
		const init: RequestInit = { method: "POST", headers: { "x-api-key": "init-header" } };

		await requestFetch(request, init);
		await requestFetch(request);

		expect(dispatches).toHaveLength(2);
		// Fetch semantics: `init.headers` replaces the Request's headers on the wire, and the observer sees the wire.
		expect(Object.fromEntries(dispatches[0].headers)).toEqual(Object.fromEntries(new Request(request, init).headers));
		expect(dispatches[0].headers.has("authorization")).toBe(false);
		expect(Object.fromEntries(dispatches[1].headers)).toEqual(Object.fromEntries(request.headers));
	});

	it("rejects the dispatch with zero network I/O and no retry when the observer throws", async () => {
		const { fetch, calls } = fakeFetch();
		const providerRetryWait = vi.fn(async () => {});
		const onProviderDispatch = vi.fn((_dispatch: ProviderDispatch) => {
			throw new Error("dispatch rejected by observer");
		});

		const message = await streamAnthropic(plainModel, context, {
			apiKey: "test-key",
			fetch,
			onProviderDispatch,
			providerRetryWait,
		}).result();

		expect(calls).toHaveLength(0);
		expect(onProviderDispatch).toHaveBeenCalledTimes(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("dispatch rejected by observer");
	});

	it("reflects request mutations made after onPayload", async () => {
		const { fetch } = fakeFetch();
		const dispatches: ProviderDispatch[] = [];

		await streamAnthropic(firstPartyModel, context, {
			apiKey: "test-key",
			fetch,
			onPayload: payload => ({ ...(payload as Record<string, unknown>), metadata: { user_id: "payload-stage" } }),
			onProviderDispatch: dispatch => dispatches.push(dispatch),
		}).result();

		expect(dispatches).toHaveLength(1);
		const observed = JSON.parse(new TextDecoder().decode(gunzipSync(dispatches[0].body as Uint8Array)));
		expect(observed.metadata).toEqual({ user_id: "payload-stage" });
	});

	it("observes every SDK retry of the same request", async () => {
		const { fetch, calls } = fakeFetch((_call, index) =>
			index === 0
				? new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }), {
						status: 500,
						headers: { "x-should-retry": "true", "retry-after-ms": "1", "content-type": "application/json" },
					})
				: sseResponse("hi"),
		);
		const dispatches: ProviderDispatch[] = [];

		const message = await streamAnthropic(plainModel, context, {
			apiKey: "test-key",
			fetch,
			requestMaxRetries: 1,
			streamMaxRetries: 0,
			onProviderDispatch: dispatch => dispatches.push(dispatch),
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(calls).toHaveLength(2);
		expect(dispatches).toHaveLength(2);
		expect(dispatchText(dispatches[1].body)).toBe(dispatchText(dispatches[0].body));
		expect(dispatchText(dispatches[1].body)).toBe(new TextDecoder().decode(wireBytes(calls[1].init?.body)));
	});

	it("leaves requests without the hook unchanged", async () => {
		const { fetch, calls } = fakeFetch();

		const message = await streamAnthropic(firstPartyModel, context, { apiKey: "test-key", fetch }).result();

		expect(message.stopReason).toBe("stop");
		expect(message.content[0]).toMatchObject({ type: "text", text: "hi" });
		expect(calls).toHaveLength(1);
		expect(headerMap(calls[0].init?.headers)["content-encoding"]).toBe("gzip");
	});

	it("does not claim observation for a caller-supplied client", async () => {
		const onProviderDispatch = vi.fn();
		const create = vi.fn(() => ({
			withResponse: async () => ({
				data: (async function* () {
					yield {
						type: "message_start",
						message: {
							id: "msg_custom_client",
							usage: {
								input_tokens: 1,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						},
					};
					yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
					yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "custom" } };
					yield { type: "content_block_stop", index: 0 };
					yield {
						type: "message_delta",
						delta: { stop_reason: "end_turn" },
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					};
					yield { type: "message_stop" };
				})(),
				response: new Response(null, { status: 200 }),
				request_id: "req_custom_client",
			}),
		}));

		const message = await streamAnthropic(plainModel, context, {
			apiKey: "test-key",
			client: { messages: { create } } as unknown as Anthropic,
			onProviderDispatch,
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(message.content[0]).toMatchObject({ type: "text", text: "custom" });
		expect(create).toHaveBeenCalledTimes(1);
		expect(onProviderDispatch).not.toHaveBeenCalled();
	});
});
