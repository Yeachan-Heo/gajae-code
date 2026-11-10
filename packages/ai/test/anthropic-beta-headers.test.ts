import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "@gajae-code/ai";
import { enrichModelThinking, getSupportedEfforts } from "@gajae-code/ai/model-thinking";
import { anthropicModelManagerOptions } from "@gajae-code/ai/provider-models/openai-compat";
import { buildAnthropicHeaders } from "@gajae-code/ai/providers/anthropic";

const featureBetas = ["context-management-2025-06-27", "prompt-caching-scope-2026-01-05"];
const oauthBetas = ["claude-code-20250219", "oauth-2025-04-20", ...featureBetas];

describe("Anthropic authentication-specific beta headers", () => {
	it("uses feature betas for API keys and preserves workspace routing", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-api03-test",
			baseUrl: "https://api.anthropic.com",
			modelHeaders: {
				"anthropic-workspace-id": "workspace-test",
				"anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
			},
		});

		expect(headers["Anthropic-Beta"].split(",")).toEqual(featureBetas);
		expect(headers["anthropic-workspace-id"]).toBe("workspace-test");
		expect(headers["X-Api-Key"]).toBe("sk-ant-api03-test");
		expect(headers.Authorization).toBeUndefined();
	});

	it("retains OAuth beta order and Bearer authentication", () => {
		const headers = buildAnthropicHeaders({ apiKey: "sk-ant-oat01-test" });

		expect(headers["Anthropic-Beta"].split(",")).toEqual(oauthBetas);
		expect(headers.Authorization).toBe("Bearer sk-ant-oat01-test");
		expect(headers["X-Api-Key"]).toBeUndefined();
	});

	it("honors explicit OAuth mode independently of the credential prefix", () => {
		const forcedApiKey = buildAnthropicHeaders({ apiKey: "sk-ant-oat01-test", isOAuth: false });
		const forcedOAuth = buildAnthropicHeaders({ apiKey: "proxy-token", isOAuth: true });

		expect(forcedApiKey["Anthropic-Beta"].split(",")).toEqual(featureBetas);
		expect(forcedApiKey["X-Api-Key"]).toBe("sk-ant-oat01-test");
		expect(forcedOAuth["Anthropic-Beta"].split(",")).toEqual(oauthBetas);
		expect(forcedOAuth.Authorization).toBe("Bearer proxy-token");
	});

	it("preserves explicitly requested extra betas and deduplicates them", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-api03-test",
			extraBetas: [
				featureBetas[0],
				"fine-grained-tool-streaming-2025-05-14",
				"claude-code-20250219",
				"claude-code-20250219",
			],
		});

		expect(headers["Anthropic-Beta"].split(",")).toEqual([
			...featureBetas,
			"fine-grained-tool-streaming-2025-05-14",
			"claude-code-20250219",
		]);
	});

	it("uses API-key beta defaults for proxies and Cloudflare without changing authentication", () => {
		const proxy = buildAnthropicHeaders({ apiKey: "proxy-key", baseUrl: "https://proxy.example.com" });
		const cloudflare = buildAnthropicHeaders({ apiKey: "gateway-key", isCloudflareAiGateway: true });

		expect(proxy["Anthropic-Beta"].split(",")).toEqual(featureBetas);
		expect(proxy.Authorization).toBe("Bearer proxy-key");
		expect(proxy["X-Api-Key"]).toBeUndefined();
		expect(cloudflare["Anthropic-Beta"].split(",")).toEqual(featureBetas);
		expect(cloudflare["cf-aig-authorization"]).toBe("Bearer gateway-key");
	});
});

describe("Anthropic model discovery beta headers", () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
	});

	async function captureDiscoveryHeaders(apiKey: string): Promise<Headers> {
		let captured: Headers | undefined;
		global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			if (String(url).startsWith("https://api.anthropic.com/")) {
				captured = new Headers(init?.headers);
				return new Response(JSON.stringify({ data: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("Not found", { status: 404 });
		}) as typeof fetch;

		await anthropicModelManagerOptions({ apiKey }).fetchDynamicModels?.();
		if (!captured) throw new Error("Anthropic /v1/models was not requested");
		return captured;
	}

	it("keeps Claude Code identity betas off API-key discovery", async () => {
		const headers = await captureDiscoveryHeaders("sk-ant-api03-test");

		expect(headers.get("x-api-key")).toBe("sk-ant-api03-test");
		expect(headers.has("anthropic-beta")).toBe(false);
	});

	it("retains Claude Code identity betas for OAuth discovery", async () => {
		const headers = await captureDiscoveryHeaders("sk-ant-oat01-test");

		expect(headers.get("authorization")).toBe("Bearer sk-ant-oat01-test");
		expect(headers.get("anthropic-beta")?.split(",")).toContain("claude-code-20250219");
		expect(headers.get("anthropic-beta")?.split(",")).toContain("oauth-2025-04-20");
	});
});

describe("Anthropic model discovery endpoint", () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
	});

	async function discover(baseUrl: string | undefined, status = 200) {
		const requested: string[] = [];
		global.fetch = (async (url: string | URL | Request) => {
			const value = String(url);
			if (value === "https://models.dev/api.json") return new Response("{}", { status: 200 });
			requested.push(value);
			return new Response(JSON.stringify({ data: [{ id: "claude-live-only" }] }), {
				status,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		const models = await anthropicModelManagerOptions({
			apiKey: "sk-ant-oat01-test",
			baseUrl,
		}).fetchDynamicModels?.();
		return { requested, models };
	}

	it("lists /v1/models from the transport origin and keeps that origin on discovered models", async () => {
		for (const baseUrl of [undefined, "https://api.anthropic.com", "https://api.anthropic.com/"]) {
			const { requested, models } = await discover(baseUrl);
			expect(requested).toEqual(["https://api.anthropic.com/v1/models"]);
			expect(models?.map(model => [model.id, model.baseUrl])).toEqual([
				["claude-live-only", "https://api.anthropic.com"],
			]);
		}
	});

	it("does not duplicate /v1 and preserves a signed query on configured endpoints", async () => {
		const { requested } = await discover("https://gateway.example.com/anthropic/v1?sig=abc");
		expect(requested).toEqual(["https://gateway.example.com/anthropic/v1/models?sig=abc"]);

		// A trailing slash inside the query is signature data, not a path separator.
		const signed = await discover("https://gateway.example.com/anthropic/v1/?sig=abc/");
		expect(signed.requested).toEqual(["https://gateway.example.com/anthropic/v1/models?sig=abc/"]);
		expect(signed.models?.[0]?.baseUrl).toBe("https://gateway.example.com/anthropic/v1?sig=abc/");

		const proxied = await discover("https://gateway.example.com/anthropic");
		expect(proxied.requested).toEqual(["https://gateway.example.com/anthropic/v1/models"]);
		expect(proxied.models?.[0]?.baseUrl).toBe("https://gateway.example.com/anthropic");
	});

	it("reports a failed listing as unavailable instead of an empty catalog", async () => {
		const { models } = await discover("https://api.anthropic.com", 404);
		expect(models).toBeNull();
	});
});

describe("Anthropic discovered models without a catalog reference", () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
	});

	async function discoverIds(ids: string[]) {
		global.fetch = (async (url: string | URL | Request) => {
			if (String(url) === "https://models.dev/api.json") return new Response("{}", { status: 200 });
			return new Response(JSON.stringify({ data: ids.map(id => ({ id, display_name: `Live ${id}` })) }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		const models = await anthropicModelManagerOptions({ apiKey: "sk-ant-oat01-test" }).fetchDynamicModels?.();
		if (!models) throw new Error("expected discovered models");
		return new Map(models.map(model => [model.id, enrichModelThinking(model)]));
	}

	it("inherits capabilities from the newest same-family catalog model and derives thinking from its own id", async () => {
		const sibling = getBundledModel("anthropic", "claude-fable-5-1");
		const models = await discoverIds(["claude-fable-5-9"]);
		const model = models.get("claude-fable-5-9");

		expect(model?.name).toBe("Live claude-fable-5-9");
		expect(model?.baseUrl).toBe("https://api.anthropic.com");
		expect(model?.reasoning).toBe(true);
		expect(model?.contextWindow).toBe(sibling.contextWindow);
		expect(model?.maxTokens).toBe(sibling.maxTokens);
		expect(model?.input).toEqual(sibling.input);
		expect(model?.thinking).toEqual(sibling.thinking);
		expect(model && getSupportedEfforts(model)).toEqual(getSupportedEfforts(sibling));
	});

	it("never borrows from a newer version or another family", async () => {
		const models = await discoverIds(["claude-fable-4-9", "claude-unknownfamily-9"]);

		for (const id of ["claude-fable-4-9", "claude-unknownfamily-9"]) {
			const model = models.get(id);
			expect(model?.reasoning).toBe(false);
			expect(model?.thinking).toBeUndefined();
			expect(model?.baseUrl).toBe("https://api.anthropic.com");
		}
	});
});
