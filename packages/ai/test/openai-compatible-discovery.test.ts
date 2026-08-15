import { afterEach, describe, expect, it } from "bun:test";
import { UNK_CONTEXT_WINDOW, UNK_MAX_TOKENS } from "@gajae-code/ai";
import { fetchOpenAICompatibleModels } from "../src/utils/discovery/openai-compatible";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

function respondWithModels(models: unknown): void {
	global.fetch = (async (url: string | URL | Request) => {
		if (String(url).endsWith("/models")) {
			return new Response(JSON.stringify({ object: "list", data: models }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response("Not found", { status: 404 });
	}) as typeof fetch;
}

const options = {
	api: "openai-completions" as const,
	provider: "custom",
	baseUrl: "http://127.0.0.1:8000/v1",
};

describe("fetchOpenAICompatibleModels contextWindow & maxTokens discovery", () => {
	it("parses max_model_len for contextWindow from OpenAI-compatible /v1/models response", async () => {
		respondWithModels([
			{
				id: "Qwen3.6-35B-A3B-8bit",
				object: "model",
				max_model_len: 262144,
				max_tokens: 16384,
			},
		]);

		const models = await fetchOpenAICompatibleModels(options);

		expect(models).not.toBeNull();
		expect(models!.length).toBe(1);
		expect(models![0].id).toBe("Qwen3.6-35B-A3B-8bit");
		expect(models![0].contextWindow).toBe(262144);
		expect(models![0].maxTokens).toBe(16384);
	});

	it("parses context_length as fallback when max_model_len is not present", async () => {
		respondWithModels([{ id: "custom-local-model", context_length: 131072 }]);

		const models = await fetchOpenAICompatibleModels(options);

		expect(models).not.toBeNull();
		expect(models![0].contextWindow).toBe(131072);
	});

	it("parses context_window and max_context_length (LM Studio / gateways)", async () => {
		respondWithModels([
			{ id: "lm-studio-model", max_context_length: 32768 },
			{ id: "groq-model", context_window: 131072 },
		]);

		const models = await fetchOpenAICompatibleModels(options);

		expect(models).not.toBeNull();
		const byId = new Map(models!.map(model => [model.id, model]));
		expect(byId.get("lm-studio-model")?.contextWindow).toBe(32768);
		expect(byId.get("groq-model")?.contextWindow).toBe(131072);
	});

	it("falls back to max_position_embeddings only when no served context field exists", async () => {
		respondWithModels([{ id: "hf-adapter-model", max_position_embeddings: 4096 }]);

		const models = await fetchOpenAICompatibleModels(options);

		expect(models).not.toBeNull();
		expect(models![0].contextWindow).toBe(4096);
	});

	it("prefers served context fields over max_position_embeddings when both are present", async () => {
		// max_position_embeddings is the training ceiling; the served window is authoritative.
		respondWithModels([{ id: "quantized-model", max_model_len: 32768, max_position_embeddings: 262144 }]);

		const models = await fetchOpenAICompatibleModels(options);

		expect(models).not.toBeNull();
		expect(models![0].contextWindow).toBe(32768);
	});

	it("keeps the UNK sentinel when the record carries no limit fields at all", async () => {
		respondWithModels([{ id: "bare-model", object: "model" }]);

		const models = await fetchOpenAICompatibleModels(options);

		expect(models).not.toBeNull();
		expect(models![0].contextWindow).toBe(UNK_CONTEXT_WINDOW);
		expect(models![0].maxTokens).toBe(UNK_MAX_TOKENS);
	});

	it("never assigns a context-window field to maxTokens", async () => {
		// Adversarial isolation: total-window fields must not leak into the
		// output-token ceiling (which drives request max_tokens budgets).
		respondWithModels([
			{
				id: "isolated-model",
				max_model_len: 262144,
				context_length: 262144,
				context_window: 262144,
				max_context_length: 262144,
				max_position_embeddings: 262144,
			},
		]);

		const models = await fetchOpenAICompatibleModels(options);

		expect(models).not.toBeNull();
		expect(models![0].contextWindow).toBe(262144);
		expect(models![0].maxTokens).toBe(UNK_MAX_TOKENS);
	});

	it("rejects non-finite limits and never lets them reach model records", async () => {
		// A gateway can emit a raw `1e400` literal; JSON.parse yields Infinity
		// client-side (JSON.stringify of Infinity would produce null, so the
		// body must be handed to the parser verbatim). Infinity must never
		// reach contextWindow/maxTokens: it would disable compaction
		// thresholds and collapse compact-input budgets to zero.
		const body =
			'{"object":"list","data":[{"id":"bad-limits","max_model_len":1e400,"context_length":1e400,"context_window":1e400,"max_context_length":1e400,"max_tokens":1e400}]}';
		global.fetch = (async (_url: string | URL | Request) =>
			new Response(body, { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

		const models = await fetchOpenAICompatibleModels(options);

		expect(models).not.toBeNull();
		expect(models![0].contextWindow).toBe(UNK_CONTEXT_WINDOW);
		expect(models![0].maxTokens).toBe(UNK_MAX_TOKENS);
	});

	it("rejects zero and negative limits", async () => {
		respondWithModels([
			{ id: "zero-negative", max_model_len: 0, context_length: -8, context_window: -1, max_tokens: -1 },
		]);

		const models = await fetchOpenAICompatibleModels(options);

		expect(models).not.toBeNull();
		expect(models![0].contextWindow).toBe(UNK_CONTEXT_WINDOW);
		expect(models![0].maxTokens).toBe(UNK_MAX_TOKENS);
	});

	it("skips a malformed field and takes the next positive candidate", async () => {
		const body =
			'{"object":"list","data":[{"id":"mixed-model","max_model_len":1e400,"context_length":131072,"max_tokens":0}]}';
		global.fetch = (async (_url: string | URL | Request) =>
			new Response(body, { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

		const models = await fetchOpenAICompatibleModels(options);

		expect(models).not.toBeNull();
		expect(models![0].contextWindow).toBe(131072);
		expect(models![0].maxTokens).toBe(UNK_MAX_TOKENS);
	});

	it("preserves mixed-record behavior: healthy and malformed entries in one catalog", async () => {
		const body =
			'{"object":"list","data":[' +
			'{"id":"healthy","max_model_len":65536,"max_tokens":8192},' +
			'{"id":"malformed","max_model_len":1e400,"max_tokens":-1},' +
			'{"id":"bare"}]}';
		global.fetch = (async (_url: string | URL | Request) =>
			new Response(body, { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

		const models = await fetchOpenAICompatibleModels(options);

		expect(models).not.toBeNull();
		const byId = new Map(models!.map(model => [model.id, model]));
		expect(byId.get("healthy")?.contextWindow).toBe(65536);
		expect(byId.get("healthy")?.maxTokens).toBe(8192);
		expect(byId.get("malformed")?.contextWindow).toBe(UNK_CONTEXT_WINDOW);
		expect(byId.get("malformed")?.maxTokens).toBe(UNK_MAX_TOKENS);
		expect(byId.get("bare")?.contextWindow).toBe(UNK_CONTEXT_WINDOW);
	});

	it("still passes parsed limits through mapModel overrides", async () => {
		respondWithModels([{ id: "mapped-model", max_model_len: 131072, max_tokens: 4096 }]);

		const models = await fetchOpenAICompatibleModels({
			...options,
			mapModel: (entry, defaults) => ({
				...defaults,
				contextWindow: typeof entry.max_model_len === "number" ? entry.max_model_len * 2 : defaults.contextWindow,
			}),
		});

		expect(models).not.toBeNull();
		expect(models![0].contextWindow).toBe(262144);
		expect(models![0].maxTokens).toBe(4096);
	});
});
