import { describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";
import { buildAnthropicClientOptions } from "../src/providers/anthropic";
import type { FetchImpl, Model } from "../src/types";

function openCodeModel(): Model<"anthropic-messages"> {
	const model = getBundledModel("opencode-go", "qwen3.8-flash") as Model<"anthropic-messages">;
	return { ...model, headers: model.headers ? { ...model.headers } : undefined };
}

async function captureWire(
	model: Model<"anthropic-messages">,
	providerSessionId?: string,
	headers?: Record<string, string>,
): Promise<{ url: string; headers: Headers; defaultHeaders: Record<string, string> }> {
	let capturedUrl = "";
	let capturedHeaders = new Headers();
	const fetchMock = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			capturedUrl = input instanceof Request ? input.url : String(input);
			capturedHeaders = new Headers(input instanceof Request ? input.headers : undefined);
			new Headers(init?.headers).forEach((value, key) => {
				capturedHeaders.set(key, value);
			});
			return new Response("{}", { status: 200 });
		},
		{ preconnect: fetch.preconnect },
	) as FetchImpl;
	const options = buildAnthropicClientOptions({
		model,
		apiKey: "test-key",
		providerSessionId,
		headers,
		fetch: fetchMock,
	});
	const requestHeaders = new Headers(options.defaultHeaders);
	requestHeaders.set("X-OpenCode-Session", "sdk-injection");
	await options.fetch!(new Request(`${options.baseURL}/v1/messages`, { headers: requestHeaders }));
	return { url: capturedUrl, headers: capturedHeaders, defaultHeaders: options.defaultHeaders };
}

describe("Anthropic-compatible OpenCode Go session header", () => {
	it("sends the opaque provider identity on the canonical Go endpoint", async () => {
		const captured = await captureWire(openCodeModel(), "opaque-provider-session", {
			"X-OpenCode-Session": "options-injection",
		});

		expect(captured.url).toBe("https://opencode.ai/zen/go/v1/messages");
		expect(captured.headers.get("x-opencode-session")).toBe("opaque-provider-session");
		expect(new Headers(captured.defaultHeaders).get("x-opencode-session")).toBe("opaque-provider-session");
	});

	it("does not treat generic or injected headers as provider conversation authority", async () => {
		const captured = await captureWire(openCodeModel(), undefined, {
			"X-OpenCode-Session": "options-injection",
		});

		expect(captured.headers.get("x-opencode-session")).toBeNull();
		expect(new Headers(captured.defaultHeaders).get("x-opencode-session")).toBeNull();
	});

	it("strips the reserved header from mislabeled Anthropic-compatible endpoints", async () => {
		const model = openCodeModel();
		model.baseUrl = "https://relay.example.com/anthropic";
		model.headers = { "X-OpenCode-Session": "model-injection" };
		const captured = await captureWire(model, "opaque-provider-session", {
			"X-OpenCode-Session": "options-injection",
		});

		expect(captured.headers.get("x-opencode-session")).toBeNull();
		expect(new Headers(captured.defaultHeaders).get("x-opencode-session")).toBeNull();
	});

	it.each([
		"https://opencode.ai/zen/go/relay",
		"https://opencode.ai/zen/go?route=relay",
	])("strips the reserved header from noncanonical same-origin base %s", async baseUrl => {
		const model = openCodeModel();
		model.baseUrl = baseUrl;
		model.headers = { "X-OpenCode-Session": "model-injection" };
		const captured = await captureWire(model, "opaque-provider-session", {
			"X-OpenCode-Session": "options-injection",
		});

		expect(captured.headers.get("x-opencode-session")).toBeNull();
		expect(new Headers(captured.defaultHeaders).get("x-opencode-session")).toBeNull();
	});
});
