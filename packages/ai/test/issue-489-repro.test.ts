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

	test("dynamic discovery still enriches matching-transport models", async () => {
		// A genuinely openai-completions opencode-go model should still pick up
		// dynamic metadata (pricing/limits) without transport regressions.
		const discovered: Model<"openai-completions">[] = [
			{
				id: "qwen3.6-plus",
				name: "Qwen3.6 Plus",
				api: "openai-completions",
				provider: "opencode-go",
				baseUrl: "https://opencode.ai/zen/go/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 },
				contextWindow: 1000000,
				maxTokens: 65536,
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

		const qwen = models.find(m => m.id === "qwen3.6-plus");
		expect(qwen?.api).toBe("openai-completions");
		expect(qwen?.baseUrl).toBe("https://opencode.ai/zen/go/v1");
		expect(qwen?.cost.input).toBe(9);
	});
});
