/**
 * Repro for #489 — OpenCode Go: `qwen3.7-max` is served over the Anthropic
 * Messages API (`https://opencode.ai/zen/go`), and the bundled catalog records
 * `api: "anthropic-messages"` accordingly. But the opencode-go model manager's
 * dynamic discovery (`fetchOpenAICompatibleModels`) enumerates every id with a
 * single hardcoded `api: "openai-completions"` at `.../v1`. When merged, the
 * dynamic row used to clobber the catalog's transport, so the model routed as
 * OpenAI-compatible and the gateway rejected it with
 * `401 Model qwen3.7-max is not supported for format oa-compat`.
 *
 * The merge must treat the static catalog as authoritative for `api` (and its
 * api-specific `baseUrl`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeModelCache } from "../src/model-cache";
import { resolveProviderModels } from "../src/model-manager";
import { getBundledModels } from "../src/models";
import type { Api, Model } from "../src/types";

describe("opencode-go qwen3.7-max keeps anthropic-messages transport (issue #489)", () => {
	let cacheDir: string;
	let cacheDbPath: string;

	beforeEach(() => {
		cacheDir = mkdtempSync(join(tmpdir(), "issue-489-"));
		cacheDbPath = join(cacheDir, "models.db");
	});

	afterEach(() => {
		rmSync(cacheDir, { recursive: true, force: true });
	});

	test("bundled catalog routes qwen3.7-max over anthropic-messages", () => {
		const bundled = getBundledModels("opencode-go");
		const qwen = bundled.find(m => m.id === "qwen3.7-max");
		expect(qwen?.api).toBe("anthropic-messages");
		expect(qwen?.baseUrl).toBe("https://opencode.ai/zen/go");
	});

	test("dynamic openai-completions discovery does not downgrade qwen3.7-max", async () => {
		// Mimic fetchOpenAICompatibleModels: every discovered id is tagged with a
		// single hardcoded openai-completions transport at the /v1 base.
		const discovered: Model<Api>[] = [
			{
				id: "qwen3.7-max",
				name: "Qwen3.7 Max",
				api: "openai-completions",
				provider: "opencode-go",
				baseUrl: "https://opencode.ai/zen/go/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000000,
				maxTokens: 65536,
			},
		];

		const { models } = await resolveProviderModels<Api>(
			{
				providerId: "opencode-go",
				cacheDbPath,
				fetchDynamicModels: async () => discovered,
			},
			"online",
		);

		const qwen = models.find(m => m.id === "qwen3.7-max");
		expect(qwen).toBeDefined();
		expect(qwen?.api).toBe("anthropic-messages");
		expect(qwen?.baseUrl).toBe("https://opencode.ai/zen/go");
	});

	test("fresh authoritative cache with stale transport is repaired before fast-path return", async () => {
		const staticModels: Model<Api>[] = [
			{
				id: "qwen3.7-max",
				name: "Qwen3.7 Max",
				api: "anthropic-messages",
				provider: "opencode-go",
				baseUrl: "https://opencode.ai/zen/go",
				reasoning: true,
				input: ["text"],
				cost: { input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 3.125 },
				contextWindow: 1000000,
				maxTokens: 65536,
			},
		];
		const poisonedCache: Model<Api>[] = [
			{
				...staticModels[0],
				api: "openai-completions",
				baseUrl: "https://opencode.ai/zen/go/v1",
			},
		];
		const now = () => 1_800_000_000_000;
		const staticFingerprint = Bun.hash(JSON.stringify(staticModels)).toString(36);
		writeModelCache("opencode-go", now(), poisonedCache, true, staticFingerprint, cacheDbPath);

		const { models, stale } = await resolveProviderModels<Api>(
			{
				providerId: "opencode-go",
				staticModels,
				cacheDbPath,
				now,
				fetchDynamicModels: async () => {
					throw new Error("fast path should not fetch");
				},
			},
			"online-if-uncached",
		);

		const qwen = models.find(m => m.id === "qwen3.7-max");
		expect(stale).toBe(false);
		expect(qwen?.api).toBe("anthropic-messages");
		expect(qwen?.baseUrl).toBe("https://opencode.ai/zen/go");
		expect(qwen?.contextWindow).toBe(1000000);
	});

	test("dynamic discovery still enriches matching-transport models", async () => {
		// A genuinely openai-completions opencode-go model should still pick up
		// dynamic metadata (pricing/limits) without transport regressions.
		// Qwen Plus/Max rows are now Anthropic Messages on the official Go contract,
		// so use a chat-completions row here.
		const discovered: Model<"openai-completions">[] = [
			{
				id: "glm-5.2",
				name: "GLM-5.2",
				api: "openai-completions",
				provider: "opencode-go",
				baseUrl: "https://opencode.ai/zen/go/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 },
				contextWindow: 1000000,
				maxTokens: 131072,
			},
		];

		const { models } = await resolveProviderModels<"openai-completions">(
			{
				providerId: "opencode-go",
				cacheDbPath,
				fetchDynamicModels: async () => discovered,
			},
			"online",
		);

		const glm = models.find(m => m.id === "glm-5.2");
		expect(glm?.api).toBe("openai-completions");
		expect(glm?.baseUrl).toBe("https://opencode.ai/zen/go/v1");
		expect(glm?.cost.input).toBe(9);
	});
	test("gpt-5.5 context cap is normalized without clobbering static overrides", async () => {
		const staticModels: Model<Api>[] = [
			{
				id: "gpt-5.5",
				name: "GPT-5.5",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_100_000,
				maxTokens: 128_000,
			},
			{
				id: "gpt-5.5-pro",
				name: "GPT-5.5 Pro",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_100_000,
				maxTokens: 128_000,
			},
			{
				id: "gpt-5.5-preview",
				name: "GPT-5.5 Preview",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_100_000,
				maxTokens: 128_000,
			},
			{
				id: "gpt-5.5-experimental",
				name: "GPT-5.5 Experimental",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_100_000,
				maxTokens: 128_000,
			},
			{
				id: "gpt-5.4",
				name: "GPT-5.4",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_100_000,
				maxTokens: 128_000,
			},
		];
		const discovered: Model<Api>[] = [
			{
				...staticModels[0],
				api: "openai-completions",
				baseUrl: "https://proxy.example.com/v1",
				contextWindow: 1_100_000,
			},
			{
				...staticModels[1],
				contextWindow: 1_100_000,
			},
		];

		const { models } = await resolveProviderModels<Api>(
			{
				providerId: "openai",
				staticModels,
				cacheDbPath,
				fetchDynamicModels: async () => discovered,
			},
			"online",
		);

		const gpt55 = models.find(m => m.id === "gpt-5.5");
		const pro = models.find(m => m.id === "gpt-5.5-pro");
		const preview = models.find(m => m.id === "gpt-5.5-preview");
		const unknownSuffix = models.find(m => m.id === "gpt-5.5-experimental");
		const other = models.find(m => m.id === "gpt-5.4");
		expect(gpt55?.contextWindow).toBe(1_000_000);
		expect(gpt55?.api).toBe("openai-responses");
		expect(gpt55?.baseUrl).toBe("https://api.openai.com/v1");
		expect(pro?.contextWindow).toBe(1_100_000);
		expect(preview?.contextWindow).toBe(1_100_000);
		expect(unknownSuffix?.contextWindow).toBe(1_100_000);
		expect(other?.contextWindow).toBe(1_100_000);
	});
});
