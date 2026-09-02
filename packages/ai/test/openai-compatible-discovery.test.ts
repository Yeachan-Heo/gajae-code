import { afterEach, describe, expect, it } from "bun:test";
import { UNK_CONTEXT_WINDOW, UNK_MAX_TOKENS } from "@gajae-code/ai";
import {
	detectDiscoveredApiFamily,
	fetchOpenAICompatibleModels,
	isSafeCatalogModelId,
	resolveLoopbackOpenAIBaseUrl,
} from "../src/utils/discovery/openai-compatible";

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
	it("drops unsafe raw and mapped catalog identities instead of renaming them", async () => {
		respondWithModels([
			{ id: "safe-model" },
			{ id: "\u001b[31munsafe-model" },
			{ id: "mapped-source" },
			{ id: "   " },
			{ id: "x".repeat(201) },
		]);

		const models = await fetchOpenAICompatibleModels({
			...options,
			mapModel: (entry, defaults) =>
				entry.id === "mapped-source" ? { ...defaults, id: "\u001b[mapped" } : defaults,
		});

		expect(models?.map(model => model.id)).toEqual(["safe-model"]);
		expect(isSafeCatalogModelId("safe-model")).toBe(true);
		expect(isSafeCatalogModelId("\u001b[31munsafe-model")).toBe(false);
	});

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

	it("rejects oversized and aborted catalogs without producing partial models", async () => {
		global.fetch = (async () =>
			new Response('{"data":[]}', {
				status: 200,
				headers: { "content-length": "1000001", "content-type": "application/json" },
			})) as unknown as typeof fetch;
		expect(await fetchOpenAICompatibleModels(options)).toBeNull();

		const controller = new AbortController();
		controller.abort();
		global.fetch = (async (...[_url, init]: Parameters<typeof fetch>) => {
			expect(init?.signal?.aborted).toBe(true);
			throw new DOMException("Aborted", "AbortError");
		}) as unknown as typeof fetch;
		expect(await fetchOpenAICompatibleModels({ ...options, signal: controller.signal })).toBeNull();
	});

	it("accepts only loopback endpoints for implicit local-provider overrides", () => {
		const fallback = "http://127.0.0.1:8080/v1";
		const accepted = [
			"http://localhost:8080/v1",
			"http://127.0.0.1:8080/v1",
			"http://127.255.255.254:8080/v1",
			"http://[::1]:8080/v1",
			"http://[0:0:0:0:0:0:0:1]:8080/v1",
			"http://[::ffff:127.0.0.1]:8080/v1",
			"http://[::ffff:7f00:1]:8080/v1",
			"http://[0:0:0:0:0:ffff:7f00:1]:8080/v1",
			"http://[0:0:0:0:0:ffff:7fff:fffe]:8080/v1",
		];
		for (const endpoint of accepted) {
			expect(resolveLoopbackOpenAIBaseUrl(endpoint, fallback)).toBe(endpoint);
		}

		const rejected = [
			"https://provider.example/v1",
			"http://127.0.0.1.example:8080/v1",
			"http://10.0.0.1:8080/v1",
			"http://[::2]:8080/v1",
			"http://[::ffff:126.255.255.255]:8080/v1",
			"http://[::ffff:128.0.0.1]:8080/v1",
			"http://[0:0:0:0:0:ffff:7e00:1]:8080/v1",
			"file:///tmp/models",
		];
		for (const endpoint of rejected) {
			expect(resolveLoopbackOpenAIBaseUrl(endpoint, fallback)).toBe(fallback);
		}
	});
});

describe("detectDiscoveredApiFamily", () => {
	it("routes by owned_by owner first", () => {
		expect(detectDiscoveredApiFamily({ id: "whatever", owned_by: "anthropic" })).toBe("anthropic-messages");
		expect(detectDiscoveredApiFamily({ id: "whatever", owned_by: "openai" })).toBe("openai-completions");
		expect(detectDiscoveredApiFamily({ id: "whatever", owned_by: "open-ai" })).toBe("openai-completions");
	});

	it("owner signal wins over a conflicting id", () => {
		// A gateway that owns a claude id under an openai account still declares
		// the true upstream via owned_by; trust the owner.
		expect(detectDiscoveredApiFamily({ id: "claude-opus-5", owned_by: "openai" })).toBe("openai-completions");
		expect(detectDiscoveredApiFamily({ id: "gpt-5.6", owned_by: "anthropic" })).toBe("anthropic-messages");
	});

	it("falls back to the model id when owner is missing or unknown", () => {
		expect(detectDiscoveredApiFamily({ id: "claude-opus-5" })).toBe("anthropic-messages");
		expect(detectDiscoveredApiFamily({ id: "claude-sonnet-4-20250514", owned_by: "proxy" })).toBe(
			"anthropic-messages",
		);
		expect(detectDiscoveredApiFamily({ id: "gpt-5.6-sol" })).toBe("openai-completions");
		expect(detectDiscoveredApiFamily({ id: "gpt-image-1.5" })).toBe("openai-completions");
		expect(detectDiscoveredApiFamily({ id: "o1-preview" })).toBe("openai-completions");
		expect(detectDiscoveredApiFamily({ id: "codex-auto-review" })).toBe("openai-completions");
	});

	it("matches namespaced ids and dotted separators", () => {
		expect(detectDiscoveredApiFamily({ id: "vendor/claude.opus" })).toBe("anthropic-messages");
		expect(detectDiscoveredApiFamily({ id: "pool:gpt-4o" })).toBe("openai-completions");
	});

	it("returns undefined when neither signal is conclusive", () => {
		expect(detectDiscoveredApiFamily({ id: "llama-3-8b" })).toBeUndefined();
		expect(detectDiscoveredApiFamily({ id: "mistral-large", owned_by: "mistralai" })).toBeUndefined();
		expect(detectDiscoveredApiFamily({ id: 123 })).toBeUndefined();
		expect(detectDiscoveredApiFamily({})).toBeUndefined();
	});
});
