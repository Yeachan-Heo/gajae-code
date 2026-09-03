import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry as ModelRegistryImpl } from "@gajae-code/coding-agent/config/model-registry";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { hookFetch, Snowflake } from "@gajae-code/utils";

/**
 * Feature: a custom OpenAI-compatible provider (e.g. a CLIProxyAPI-style
 * subscription gateway like "withfox") should auto-populate `/model` from its
 * live `/v1/models` catalog with zero manual `discovery:` config, and should
 * auto-classify each discovered model's wire API family (openai vs anthropic).
 */
describe("custom provider auto model discovery", () => {
	let tempDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `gjc-auto-discovery-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	function mixedGatewayResponse(): Response {
		return new Response(
			JSON.stringify({
				object: "list",
				data: [
					{ id: "gpt-5.6-sol", owned_by: "openai" },
					{ id: "gpt-image-1.5", owned_by: "openai" },
					{ id: "claude-opus-5", owned_by: "anthropic" },
					// No owner: id must still classify claude-* as anthropic.
					{ id: "claude-sonnet-4-20250514" },
					// Unknown family: keeps the provider default api.
					{ id: "llama-3-70b", owned_by: "meta" },
				],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}

	test("auto-enables /v1/models discovery for a mixed gateway without a discovery block", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  withfox:",
				"    baseUrl: http://100.92.25.20:1436/v1",
				"    apiKey: sk-withfox",
				"    auth: apiKey",
				"    models:",
				"      - id: gpt-5.6-sol",
				"        api: openai-responses",
				"      - id: claude-opus-5",
				"        api: anthropic-messages",
			].join("\n"),
		);

		using _hook = hookFetch((input, init) => {
			const url = String(input);
			if (url !== "http://100.92.25.20:1436/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			const headers = init?.headers as Headers | Record<string, string> | undefined;
			const authHeader = headers instanceof Headers ? headers.get("Authorization") : headers?.Authorization;
			expect(authHeader).toBe("Bearer sk-withfox");
			return mixedGatewayResponse();
		});

		const registry = new ModelRegistryImpl(authStorage, modelsPath);
		await registry.refreshProvider("withfox");

		expect(registry.getProviderDiscoveryState("withfox")?.status).toBe("ok");

		const ids = registry
			.getAll()
			.filter(model => model.provider === "withfox")
			.map(model => model.id)
			.sort();
		// Discovered ids beyond the two statically-configured models are present.
		expect(ids).toContain("gpt-image-1.5");
		expect(ids).toContain("claude-sonnet-4-20250514");
		expect(ids).toContain("llama-3-70b");
	});

	test("keeps the current static catalog during a provider-only refresh", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  withfox:",
				"    baseUrl: https://first.example.test/v1",
				"    api: openai-completions",
				"    apiKey: sk-withfox",
				"    auth: apiKey",
				"    models:",
				"      - id: first-static-model",
			].join("\n"),
		);
		const requested: string[] = [];
		using _hook = hookFetch(input => {
			requested.push(String(input));
			return new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
				headers: { "Content-Type": "application/json" },
			});
		});
		const registry = new ModelRegistryImpl(authStorage, modelsPath);
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  withfox:",
				"    baseUrl: https://second.example.test/v1",
				"    api: openai-completions",
				"    apiKey: sk-withfox",
				"    auth: apiKey",
				"    models:",
				"      - id: second-static-model",
			].join("\n"),
		);

		await registry.refreshProvider("withfox", "online");

		expect(requested).toEqual(["https://first.example.test/v1/models"]);
		expect(registry.find("withfox", "first-static-model")).toBeDefined();
		expect(registry.find("withfox", "second-static-model")).toBeUndefined();
	});

	test("auto-classifies the wire api family per discovered model", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  withfox:",
				"    baseUrl: http://100.92.25.20:1436/v1",
				"    apiKey: sk-withfox",
				"    auth: apiKey",
				"    models:",
				// Only per-model api set (no provider-level api) — the dominant
				// OpenAI-family model api (openai-responses) becomes the default.
				"      - id: gpt-5.6-sol",
				"        api: openai-responses",
				"      - id: claude-opus-5",
				"        api: anthropic-messages",
			].join("\n"),
		);

		using _hook = hookFetch(input => {
			const url = String(input);
			if (url !== "http://100.92.25.20:1436/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			return mixedGatewayResponse();
		});

		const registry = new ModelRegistryImpl(authStorage, modelsPath);
		await registry.refreshProvider("withfox");

		// owned_by:anthropic -> anthropic-messages
		expect(registry.find("withfox", "claude-opus-5")?.api).toBe("anthropic-messages");
		// claude-* id with no owner -> anthropic-messages
		expect(registry.find("withfox", "claude-sonnet-4-20250514")?.api).toBe("anthropic-messages");
		// OpenAI family keeps the provider's OpenAI transport (openai-responses),
		// not a forced downgrade to openai-completions.
		expect(registry.find("withfox", "gpt-5.6-sol")?.api).toBe("openai-responses");
		expect(registry.find("withfox", "gpt-image-1.5")?.api).toBe("openai-responses");
		// Unknown family falls back to the provider default api.
		expect(registry.find("withfox", "llama-3-70b")?.api).toBe("openai-responses");
	});

	test("does not auto-enable discovery for an Anthropic-only custom provider", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  anthroxy:",
				"    baseUrl: https://anthroxy.example/v1",
				"    apiKey: sk-anthroxy",
				"    auth: apiKey",
				"    models:",
				"      - id: claude-opus-5",
				"        api: anthropic-messages",
			].join("\n"),
		);

		let modelsListRequested = false;
		using _hook = hookFetch(input => {
			const url = String(input);
			if (url.endsWith("/models")) {
				modelsListRequested = true;
			}
			return new Response(null, { status: 404 });
		});

		const registry = new ModelRegistryImpl(authStorage, modelsPath);
		await registry.refreshProvider("anthroxy");

		// An Anthropic-only base has no dominant OpenAI-family api, so no
		// OpenAI /v1/models probe is issued and only the static model remains.
		expect(modelsListRequested).toBe(false);
		const ids = registry
			.getAll()
			.filter(model => model.provider === "anthroxy")
			.map(model => model.id);
		expect(ids).toEqual(["claude-opus-5"]);
	});

	test("honors an explicit apiByModelPrefix over auto-detection", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  withfox:",
				"    baseUrl: http://100.92.25.20:1436/v1",
				"    apiKey: sk-withfox",
				"    auth: apiKey",
				"    api: openai-completions",
				"    discovery:",
				"      type: openai-models-list",
				"      apiByModelPrefix:",
				"        claude: openai-completions",
				"    models: []",
			].join("\n"),
		);

		using _hook = hookFetch(input => {
			const url = String(input);
			if (url !== "http://100.92.25.20:1436/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			return mixedGatewayResponse();
		});

		const registry = new ModelRegistryImpl(authStorage, modelsPath);
		await registry.refreshProvider("withfox");

		// Explicit prefix wins even though owned_by says anthropic.
		expect(registry.find("withfox", "claude-opus-5")?.api).toBe("openai-completions");
	});
});
