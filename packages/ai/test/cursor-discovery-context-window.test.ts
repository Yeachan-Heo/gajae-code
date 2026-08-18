import { describe, expect, it } from "bun:test";
import type { Model } from "../src/types";
import {
	CURSOR_NAMED_MILLION_CONTEXT_WINDOW,
	normalizeCursorDiscoveryModels,
	resolveCursorLiveContextWindow,
} from "../src/utils/discovery/cursor";

const DEFAULT_CONTEXT_WINDOW = 200_000;

function reference(id: string, contextWindow: number): Model<"cursor-agent"> {
	return {
		id,
		name: id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 64_000,
	};
}

describe("resolveCursorLiveContextWindow", () => {
	it("promotes a 1M display name over a stale 200k fallback", () => {
		expect(
			resolveCursorLiveContextWindow({
				id: "claude-opus-5-thinking-high",
				displayName: "Claude Opus 5 1M Thinking",
				fallback: DEFAULT_CONTEXT_WINDOW,
			}),
		).toBe(CURSOR_NAMED_MILLION_CONTEXT_WINDOW);
	});

	it("reads NxM windows from aliases when the id has no million marker", () => {
		expect(
			resolveCursorLiveContextWindow({
				id: "gpt-5.6-sol-high",
				aliases: ["GPT-5.6 Sol 1M High"],
				fallback: DEFAULT_CONTEXT_WINDOW,
			}),
		).toBe(CURSOR_NAMED_MILLION_CONTEXT_WINDOW);
	});

	it("does not treat model ids like gpt-5.1 as a 1M window", () => {
		expect(
			resolveCursorLiveContextWindow({
				id: "gpt-5.1-codex-max",
				displayName: "GPT-5.1 OpenAI code Max",
				fallback: 272_000,
			}),
		).toBe(272_000);
	});

	it("keeps a larger bundled fallback instead of shrinking to a named 1M window", () => {
		expect(
			resolveCursorLiveContextWindow({
				id: "gemini-3-pro",
				displayName: "Gemini 3 Pro 1M",
				fallback: 1_048_576,
			}),
		).toBe(1_048_576);
	});

	it("parses a 2M display name", () => {
		expect(
			resolveCursorLiveContextWindow({
				id: "future-model",
				displayName: "Future Model 2M",
				fallback: DEFAULT_CONTEXT_WINDOW,
			}),
		).toBe(2_000_000);
	});
});

describe("normalizeCursorDiscoveryModels context windows", () => {
	it("overlays live 1M names onto bundled 200k catalog rows", () => {
		const models = normalizeCursorDiscoveryModels(
			[
				{
					modelId: "claude-opus-5-thinking-high",
					displayName: "Claude Opus 5 1M Thinking",
				},
			],
			{
				references: new Map([
					["claude-opus-5-thinking-high", reference("claude-opus-5-thinking-high", DEFAULT_CONTEXT_WINDOW)],
				]),
			},
		);
		expect(models).toHaveLength(1);
		expect(models[0]?.contextWindow).toBe(CURSOR_NAMED_MILLION_CONTEXT_WINDOW);
		expect(models[0]?.name).toBe("Claude Opus 5 1M Thinking");
	});

	it("does not downgrade bundled GPT/Gemini windows when the live name has no million marker", () => {
		const models = normalizeCursorDiscoveryModels(
			[
				{ modelId: "gpt-5.2-high", displayName: "GPT-5.2 High" },
				{ modelId: "gemini-3-pro", displayName: "Gemini 3 Pro" },
			],
			{
				references: new Map([
					["gpt-5.2-high", reference("gpt-5.2-high", 400_000)],
					["gemini-3-pro", reference("gemini-3-pro", 1_048_576)],
				]),
			},
		);
		const byId = new Map(models.map(model => [model.id, model]));
		expect(byId.get("gpt-5.2-high")?.contextWindow).toBe(400_000);
		expect(byId.get("gemini-3-pro")?.contextWindow).toBe(1_048_576);
	});

	it("assigns 1M to unbundled Cursor models whose live name advertises that window", () => {
		const models = normalizeCursorDiscoveryModels([{ modelId: "claude-new-1m", displayName: "Claude New 1M" }], {
			references: new Map(),
		});
		expect(models[0]?.contextWindow).toBe(CURSOR_NAMED_MILLION_CONTEXT_WINDOW);
		expect(models[0]?.maxTokens).toBe(64_000);
	});

	it("keeps the 200k default for unbundled models with no live million marker", () => {
		const models = normalizeCursorDiscoveryModels([{ modelId: "cursor-composer", displayName: "Composer" }], {
			references: new Map(),
		});
		expect(models[0]?.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
	});
});
