import { afterEach, describe, expect, it } from "bun:test";
import { registerCustomApi, unregisterCustomApis } from "../src/api-registry";
import { Effort } from "../src/model-thinking";
import { complete, completeSimple, streamSimple } from "../src/stream";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "../src/types";
import { AssistantMessageEventStream } from "../src/utils/event-stream";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	unregisterCustomApis("max-tokens-contract");
});

function createCompletionResponse(): Response {
	const events = [
		{
			id: "chatcmpl-token-contract",
			object: "chat.completion.chunk",
			created: 0,
			model: "custom-model",
			choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
		},
		{
			id: "chatcmpl-token-contract",
			object: "chat.completion.chunk",
			created: 0,
			model: "custom-model",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
		},
		"[DONE]",
	];
	const body = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function createResponsesResponse(): Response {
	const events = [
		{ type: "response.output_text.delta", delta: "ok" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "ok" }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp-token-contract",
				status: "completed",
				usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	const body = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function createModel(maxTokensSource?: Model<"openai-completions">["maxTokensSource"]): Model<"openai-completions"> {
	return {
		id: "custom-model",
		name: "Custom model",
		api: "openai-completions",
		provider: "custom-provider",
		baseUrl: "https://provider.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 65_536,
		maxTokensSource,
		compat: { maxTokensField: "max_tokens" },
	};
}

function context(): Context {
	return { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };
}

function customApiResult(model: Model<Api>): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	stream.push({ type: "done", reason: "stop", message });
	return stream;
}

async function captureCompletion(
	model: Model<"openai-completions">,
	options?: { maxTokens?: number },
): Promise<{ body: Record<string, unknown>; usage: { input: number; output: number; totalTokens: number } }> {
	let capturedBody: Record<string, unknown> | undefined;
	global.fetch = (async (_input, init) => {
		capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return createCompletionResponse();
	}) as typeof fetch;

	const response = await completeSimple(model, context(), { apiKey: "test-key", ...options });
	if (!capturedBody) throw new Error("The fake provider did not receive a request");
	return { body: capturedBody, usage: response.usage };
}

describe("model maxTokens request contract", () => {
	it("uses an explicit configured limit on the wire and preserves provider usage accounting", async () => {
		const result = await captureCompletion(createModel("configured"));

		expect(result.body.max_tokens).toBe(65_536);
		expect(result.body.max_completion_tokens).toBeUndefined();
		expect(result.usage).toMatchObject({ input: 11, output: 7, totalTokens: 18 });
	});

	it("keeps the safe default for non-configured metadata and honors a positive request override", async () => {
		const defaulted = await captureCompletion(createModel());
		const overridden = await captureCompletion(createModel(), { maxTokens: 70_000 });

		expect(defaulted.body.max_tokens).toBe(32_000);
		expect(overridden.body.max_tokens).toBe(70_000);
	});

	it("treats a zero request budget as unspecified instead of bypassing the safe default", async () => {
		const result = await captureCompletion(createModel(), { maxTokens: 0 });

		expect(result.body.max_tokens).toBe(32_000);
	});

	it("does not let invalid configured metadata produce an invalid provider budget", async () => {
		const result = await captureCompletion({ ...createModel("configured"), maxTokens: -1 });

		expect(result.body.max_tokens).toBe(32_000);
	});

	it("rejects fractional and unsafe-integer request budgets in favor of the safe default", async () => {
		const fractional = await captureCompletion(createModel(), { maxTokens: 65_536.5 });
		const unsafe = await captureCompletion(createModel(), { maxTokens: Number.MAX_SAFE_INTEGER + 1 });

		expect(fractional.body.max_tokens).toBe(32_000);
		expect(unsafe.body.max_tokens).toBe(32_000);
	});

	it("does not let fractional or unsafe configured metadata produce a non-integer wire budget", async () => {
		const fractional = await captureCompletion({ ...createModel("configured"), maxTokens: 65_536.5 });
		const unsafe = await captureCompletion({
			...createModel("configured"),
			maxTokens: Number.MAX_SAFE_INTEGER + 1,
		});

		expect(fractional.body.max_tokens).toBe(32_000);
		expect(unsafe.body.max_tokens).toBe(32_000);
	});

	it("keeps compat.extraBody from adding a competing output-limit field", async () => {
		const result = await captureCompletion({
			...createModel("configured"),
			compat: { maxTokensField: "max_tokens", extraBody: { max_completion_tokens: 1, temperature: 0.5 } },
		});

		expect(result.body.max_tokens).toBe(65_536);
		expect(result.body.max_completion_tokens).toBeUndefined();
		expect(result.body.temperature).toBe(0.5);
	});

	it("normalizes unsafe provider-option budgets at the low-level stream boundary", async () => {
		const seen: Array<Record<string, unknown>> = [];
		global.fetch = (async (_input, init) => {
			seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return createCompletionResponse();
		}) as typeof fetch;

		const model = createModel();
		await complete(model, context(), { apiKey: "test-key", maxTokens: 65_536.5 } as never);
		await complete(model, context(), {
			apiKey: "test-key",
			maxTokens: Number.MAX_SAFE_INTEGER + 1,
		} as never);
		await complete(model, context(), { apiKey: "test-key", maxTokens: 40_000 } as never);

		expect(seen[0]?.max_tokens).toBeUndefined();
		expect(seen[1]?.max_tokens).toBeUndefined();
		expect(seen[2]?.max_tokens).toBe(40_000);
	});
	it("maps the same resolved budget to max_completion_tokens", async () => {
		const result = await captureCompletion({
			...createModel("configured"),
			compat: { maxTokensField: "max_completion_tokens" },
		});

		expect(result.body.max_completion_tokens).toBe(65_536);
		expect(result.body.max_tokens).toBeUndefined();
	});

	it("maps configured limits to the Responses max_output_tokens field", async () => {
		const model: Model<"openai-responses"> = {
			id: "custom-responses-model",
			name: "Custom Responses model",
			api: "openai-responses",
			provider: "custom-provider",
			baseUrl: "https://provider.example/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131_072,
			maxTokens: 65_536,
			maxTokensSource: "configured",
		};
		let capturedBody: Record<string, unknown> | undefined;
		global.fetch = (async (_input, init) => {
			capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return createResponsesResponse();
		}) as typeof fetch;

		const response = await completeSimple(model, context(), { apiKey: "test-key" });

		expect(capturedBody?.max_output_tokens).toBe(65_536);
		expect(response.usage).toMatchObject({ input: 11, output: 7, totalTokens: 18 });
	});

	it("applies configured limits before the Synthetic OpenAI compatibility dispatch", async () => {
		const result = await captureCompletion({ ...createModel("configured"), provider: "synthetic" }, undefined);

		expect(result.body.max_tokens).toBe(65_536);
	});

	it("applies configured limits before the Synthetic Anthropic compatibility dispatch", async () => {
		const model = { ...createModel("configured"), provider: "synthetic" };
		const controller = new AbortController();
		controller.abort();
		const payloadPromise = Promise.withResolvers<Record<string, unknown>>();

		streamSimple(model, context(), {
			apiKey: "test-key",
			syntheticApiFormat: "anthropic",
			signal: controller.signal,
			onPayload: payload => payloadPromise.resolve(payload as Record<string, unknown>),
		});

		expect((await payloadPromise.promise).max_tokens).toBe(65_536);
	});

	it("passes the resolved budget to extension-provided custom APIs", async () => {
		const captured: Array<number | undefined> = [];
		registerCustomApi(
			"max-tokens-contract-api",
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				captured.push(options?.maxTokens);
				return customApiResult(_model);
			},
			"max-tokens-contract",
		);
		const model = { ...createModel("configured"), api: "max-tokens-contract-api" } as Model<Api>;

		await streamSimple(model, context(), { maxTokens: 70_000 }).result();
		expect(captured).toEqual([70_000]);
	});

	it("keeps Anthropic thinking repairs valid for malformed in-memory model limits", async () => {
		const payloadPromise = Promise.withResolvers<Record<string, unknown>>();
		const controller = new AbortController();
		controller.abort();
		const model: Model<"anthropic-messages"> = {
			id: "malformed-anthropic-model",
			name: "Malformed Anthropic model",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131_072,
			maxTokens: -1,
			maxTokensSource: "configured",
		};

		streamSimple(model, context(), {
			apiKey: "test-key",
			reasoning: Effort.XHigh,
			signal: controller.signal,
			onPayload: payload => payloadPromise.resolve(payload as Record<string, unknown>),
		});

		const payload = await payloadPromise.promise;
		expect(payload.max_tokens).toBeGreaterThan(0);
	});
	it("shrinks the thinking budget when a configured cap cannot fit budget plus output", async () => {
		const payloadPromise = Promise.withResolvers<Record<string, unknown>>();
		const controller = new AbortController();
		controller.abort();
		const model: Model<"anthropic-messages"> = {
			id: "capped-anthropic-model",
			name: "Capped Anthropic model",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131_072,
			maxTokens: 8_192,
			maxTokensSource: "configured",
		};

		streamSimple(model, context(), {
			apiKey: "test-key",
			reasoning: Effort.XHigh,
			thinkingBudgets: { [Effort.XHigh]: 8_192 },
			signal: controller.signal,
			onPayload: payload => payloadPromise.resolve(payload as Record<string, unknown>),
		});

		const payload = await payloadPromise.promise;
		const maxTokens = payload.max_tokens as number;
		const thinking = payload.thinking as { type: string; budget_tokens?: number } | undefined;
		expect(maxTokens).toBe(8_192);
		if (thinking?.type === "enabled") {
			expect(thinking.budget_tokens ?? 0).toBeLessThan(maxTokens);
		}
	});
});
