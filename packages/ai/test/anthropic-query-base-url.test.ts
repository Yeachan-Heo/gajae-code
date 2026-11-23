import { describe, expect, it } from "bun:test";
import { buildAnthropicClientOptions, normalizeAnthropicBaseUrl, streamAnthropic } from "../src/providers/anthropic";
import type { Context, FetchImpl, Model, ProviderDispatch } from "../src/types";
import { buildAnthropicAuthConfig, buildAnthropicUrl } from "../src/utils/anthropic-auth";

const baseModel: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://gateway.example.com/anthropic",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const context: Context = {
	messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }],
};

function sseResponse(): Response {
	const usage = { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
	const events: Array<Record<string, unknown>> = [
		{ type: "message_start", message: { id: "msg_query_base", usage } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function recordingFetch(respond: (index: number) => Response = sseResponse): { fetch: FetchImpl; urls: string[] } {
	const urls: string[] = [];
	const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
		urls.push(input instanceof Request ? input.url : String(input));
		return respond(urls.length - 1);
	}) as FetchImpl;
	return { fetch: fetchImpl, urls };
}

async function messagesUrls(baseUrl: string): Promise<string[]> {
	const { fetch, urls } = recordingFetch();
	const message = await streamAnthropic({ ...baseModel, baseUrl }, context, { apiKey: "test-key", fetch }).result();
	expect(message.stopReason).toBe("stop");
	return urls;
}

describe("Anthropic Messages requests with a query-bearing base URL", () => {
	it("composes /v1/messages on the path once and keeps a signed query verbatim", async () => {
		expect(await messagesUrls("https://gateway.example.com/anthropic/v1/?sig=abc/")).toEqual([
			"https://gateway.example.com/anthropic/v1/messages?sig=abc/",
		]);
		expect(await messagesUrls("https://gateway.example.com/anthropic?sig=a/b%2Bc&exp=1")).toEqual([
			"https://gateway.example.com/anthropic/v1/messages?sig=a/b%2Bc&exp=1",
		]);
		expect(await messagesUrls("https://gateway.example.com/anthropic/?sig=x/v1")).toEqual([
			"https://gateway.example.com/anthropic/v1/messages?sig=x/v1",
		]);
		// A fragment is never sent; only the query rides along.
		expect(await messagesUrls("https://gateway.example.com/anthropic/v1?sig=x#frag")).toEqual([
			"https://gateway.example.com/anthropic/v1/messages?sig=x",
		]);
	});

	it("keeps query-free bases unchanged, with or without /v1 and a trailing slash", async () => {
		expect(await messagesUrls("https://gateway.example.com/anthropic")).toEqual([
			"https://gateway.example.com/anthropic/v1/messages",
		]);
		expect(await messagesUrls("https://gateway.example.com/anthropic/v1/")).toEqual([
			"https://gateway.example.com/anthropic/v1/messages",
		]);
	});

	it("shows the signed URL to the dispatch observer and keeps it on SDK retries", async () => {
		const { fetch, urls } = recordingFetch(index =>
			index === 0
				? new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }), {
						status: 500,
						headers: { "x-should-retry": "true", "retry-after-ms": "1", "content-type": "application/json" },
					})
				: sseResponse(),
		);
		const dispatches: ProviderDispatch[] = [];
		const message = await streamAnthropic(
			{ ...baseModel, baseUrl: "https://gateway.example.com/anthropic?sig=s/1" },
			context,
			{
				apiKey: "test-key",
				fetch,
				requestMaxRetries: 1,
				streamMaxRetries: 0,
				onProviderDispatch: dispatch => dispatches.push(dispatch),
			},
		).result();

		expect(message.stopReason).toBe("stop");
		const signed = "https://gateway.example.com/anthropic/v1/messages?sig=s/1";
		expect(urls).toEqual([signed, signed]);
		expect(dispatches.map(dispatch => dispatch.url)).toEqual([signed, signed]);
	});

	it("puts the base query ahead of SDK query parameters and leaves other URLs alone", async () => {
		const { fetch, urls } = recordingFetch();
		const options = buildAnthropicClientOptions({
			model: { ...baseModel, baseUrl: "https://Gateway.Example.com/anthropic/?sig=abc/" },
			apiKey: "test-key",
			fetch,
		});
		expect(options.baseURL).toBe("https://Gateway.Example.com/anthropic");
		const requestFetch = options.fetch!;

		await requestFetch("https://gateway.example.com/anthropic/v1/messages?beta=true", { method: "POST" });
		await requestFetch(new Request("https://gateway.example.com/anthropic/v1/messages/count_tokens"), undefined);
		await requestFetch("https://gateway.example.com/anthropic2/v1/messages", { method: "POST" });
		await requestFetch("https://other.example.com/anthropic/v1/messages", { method: "POST" });

		expect(urls).toEqual([
			"https://gateway.example.com/anthropic/v1/messages?sig=abc/&beta=true",
			"https://gateway.example.com/anthropic/v1/messages/count_tokens?sig=abc/",
			"https://gateway.example.com/anthropic2/v1/messages",
			"https://other.example.com/anthropic/v1/messages",
		]);
	});
});

describe("base query fetch wrapper", () => {
	it("passes an unmatched Request through untouched, body included", async () => {
		const seen: Array<string | URL | Request> = [];
		const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
			seen.push(input);
			return new Response(null, { status: 204 });
		}) as FetchImpl;
		const requestFetch = buildAnthropicClientOptions({
			model: { ...baseModel, baseUrl: "https://gateway.example.com/anthropic?sig=abc" },
			apiKey: "test-key",
			fetch: fetchImpl,
		}).fetch!;
		const other = new Request("https://other.example.com/v1/messages", { method: "POST", body: "payload" });
		const matched = new Request("https://gateway.example.com/anthropic/v1/messages", {
			method: "POST",
			body: "signed-payload",
		});

		await requestFetch(other);
		await requestFetch(matched);

		const passed = seen[0] as Request;
		expect(passed.url).toBe("https://other.example.com/v1/messages");
		expect(await passed.text()).toBe("payload");
		const rebuilt = seen[1] as Request;
		expect(rebuilt.url).toBe("https://gateway.example.com/anthropic/v1/messages?sig=abc");
		expect(rebuilt.method).toBe("POST");
		expect(await rebuilt.text()).toBe("signed-payload");
	});
});

describe("buildAnthropicUrl (web search Messages request)", () => {
	it("puts /v1/messages on the path and keeps the signed query ahead of beta=true", () => {
		const url = (baseUrl: string) => buildAnthropicUrl(buildAnthropicAuthConfig("sk-ant-api-key", baseUrl));
		expect(url("https://gateway.example.com/anthropic/v1/?sig=abc/")).toBe(
			"https://gateway.example.com/anthropic/v1/messages?sig=abc/&beta=true",
		);
		expect(url("https://gateway.example.com/anthropic?sig=a/b%2Bc#frag")).toBe(
			"https://gateway.example.com/anthropic/v1/messages?sig=a/b%2Bc&beta=true",
		);
		expect(url("https://gateway.example.com/anthropic/v1/")).toBe(
			"https://gateway.example.com/anthropic/v1/messages?beta=true",
		);
	});
});

describe("normalizeAnthropicBaseUrl", () => {
	it("normalizes only the path and keeps the query and fragment as written", () => {
		expect(normalizeAnthropicBaseUrl(" https://gateway.example.com/anthropic/v1/ ")).toBe(
			"https://gateway.example.com/anthropic",
		);
		expect(normalizeAnthropicBaseUrl("https://gateway.example.com/anthropic/v1/?sig=abc/")).toBe(
			"https://gateway.example.com/anthropic?sig=abc/",
		);
		expect(normalizeAnthropicBaseUrl("https://gateway.example.com/anthropic?sig=x/v1")).toBe(
			"https://gateway.example.com/anthropic?sig=x/v1",
		);
		expect(normalizeAnthropicBaseUrl("   ")).toBeUndefined();
	});
});
