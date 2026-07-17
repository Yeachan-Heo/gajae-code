import { describe, expect, test } from "bun:test";
import { Effort, type Model } from "@gajae-code/ai";
import {
	expandRoleAlias,
	findInitialModel,
	managedCursorFallbackUnavailableReason,
	parseModelPattern,
	parseModelString,
	resolveAgentModelPatterns,
	resolveCliModel,
	resolveModelChainWithAuth,
	resolveModelFromString,
	resolveModelOverride,
	resolveModelRoleValue,
	resolveModelScope,
	restoreModelFromSession,
} from "@gajae-code/coding-agent/config/model-resolver";
import { Settings } from "@gajae-code/coding-agent/config/settings";

test("rejects Cursor transports from retryable managed fallback chains at resolution", () => {
	const cursor = { ...mockModels[0], api: "cursor-agent", provider: "cursor" } as Model;
	expect(managedCursorFallbackUnavailableReason(cursor, "cursor/claude-4-sonnet")).toBe(
		"Cursor model cursor/claude-4-sonnet requires provider-side tool execution and cannot be used in a retryable fallback chain",
	);
	expect(managedCursorFallbackUnavailableReason(mockModels[0], "anthropic/claude-sonnet-4-5")).toBeUndefined();
});

test("skips a Cursor chain head during managed auth-aware resolution", async () => {
	const cursor = { ...mockModels[0], api: "cursor-agent", provider: "cursor" } as Model;
	const resolution = await resolveModelChainWithAuth(
		["cursor/claude-sonnet-4-5", "openai/gpt-4o"],
		{ getAvailable: () => [cursor, mockModels[1]], getApiKey: async () => "key" } as never,
		undefined,
		undefined,
		{ managedFallback: true },
	);
	expect(resolution.model).toBe(mockModels[1]);
	expect(resolution.activeIndex).toBe(1);
	expect(resolution.skips[0]?.reason).toContain("cannot be used in a retryable fallback chain");
});

test("does not skip a Cursor single-entry selection when managed fallback is requested", async () => {
	const cursor = { ...mockModels[0], api: "cursor-agent", provider: "cursor" } as Model;
	const resolution = await resolveModelChainWithAuth(
		["cursor/claude-sonnet-4-5"],
		{ getAvailable: () => [cursor], getApiKey: async () => "key" } as never,
		undefined,
		undefined,
		{ managedFallback: true },
	);
	expect(resolution.model).toBe(cursor);
	expect(resolution.activeIndex).toBe(0);
	expect(resolution.skips).toEqual([]);
});

// Mock models for testing
const mockModels: Model<"anthropic-messages">[] = [
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		thinking: {
			mode: "budget",
			minLevel: Effort.Minimal,
			maxLevel: Effort.High,
		},
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
	{
		id: "gpt-4o",
		name: "GPT-4o",
		api: "anthropic-messages", // Using same type for simplicity
		provider: "openai",
		baseUrl: "https://api.openai.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 128000,
		maxTokens: 4096,
	},
];

// Mock OpenRouter models with colons in IDs
const mockOpenRouterModels: Model<"anthropic-messages">[] = [
	{
		id: "qwen/qwen3-coder:exacto",
		name: "Qwen3 Coder Exacto",
		api: "anthropic-messages",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		thinking: {
			mode: "budget",
			minLevel: Effort.Minimal,
			maxLevel: Effort.High,
		},
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 8192,
	},
	{
		id: "openai/gpt-4o:extended",
		name: "GPT-4o Extended",
		api: "anthropic-messages",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 128000,
		maxTokens: 4096,
	},
	{
		id: "z-ai/glm-4.7",
		name: "GLM 4.7",
		api: "anthropic-messages",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		thinking: {
			mode: "budget",
			minLevel: Effort.Minimal,
			maxLevel: Effort.High,
		},
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 8192,
	},
];

const mockProviderOverlapModels: Model<"anthropic-messages">[] = [
	{
		id: "kimi-k2.5",
		name: "Kimi K2.5",
		api: "anthropic-messages",
		provider: "kimi-code",
		baseUrl: "https://api.kimi.ai",
		reasoning: false,
		input: ["text"],
		cost: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 2 },
		contextWindow: 128000,
		maxTokens: 8192,
	},
	{
		id: "moonshotai/kimi-k2.5",
		name: "Kimi K2.5 (OpenRouter)",
		api: "anthropic-messages",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 2.2, output: 6.2, cacheRead: 0.22, cacheWrite: 2.2 },
		contextWindow: 128000,
		maxTokens: 8192,
	},
];

const mockCodexOverlapModels: Model<"anthropic-messages">[] = [
	{
		id: "gpt-5.3-codex",
		name: "GPT-5.3 Codex",
		api: "anthropic-messages",
		provider: "openai-codex",
		baseUrl: "https://api.openai.com",
		reasoning: true,
		thinking: {
			mode: "effort",
			minLevel: Effort.Low,
			maxLevel: Effort.XHigh,
		},
		input: ["text"],
		cost: { input: 1.5, output: 6, cacheRead: 0.15, cacheWrite: 1.5 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
	{
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		api: "anthropic-messages",
		provider: "openai-codex",
		baseUrl: "https://api.openai.com",
		reasoning: true,
		thinking: {
			mode: "effort",
			minLevel: Effort.Low,
			maxLevel: Effort.XHigh,
		},
		input: ["text"],
		cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
];

const canonicalVariantModels: Model<"anthropic-messages">[] = [
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		thinking: {
			mode: "budget",
			minLevel: Effort.Minimal,
			maxLevel: Effort.High,
		},
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
	{
		id: "anthropic/claude-sonnet-4.5",
		name: "Claude Sonnet 4.5 (Copilot)",
		api: "anthropic-messages",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		thinking: {
			mode: "budget",
			minLevel: Effort.Minimal,
			maxLevel: Effort.High,
		},
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
];

const canonicalRegistry = {
	resolveCanonicalModel: (canonicalId: string, options?: { candidates?: Model<"anthropic-messages">[] }) => {
		if (canonicalId !== "claude-sonnet-4-5") return undefined;
		const candidates = options?.candidates ?? canonicalVariantModels;
		return (
			candidates.find(model => model.provider === "github-copilot") ??
			candidates.find(model => model.provider === "anthropic")
		);
	},
	getCanonicalVariants: (canonicalId: string, options?: { candidates?: Model<"anthropic-messages">[] }) => {
		if (canonicalId !== "claude-sonnet-4-5") return [];
		const candidates = options?.candidates ?? canonicalVariantModels;
		return candidates.map(model => ({
			canonicalId,
			selector: `${model.provider}/${model.id}`,
			model,
			source: model.id === canonicalId ? "bundled" : "heuristic",
		}));
	},
	getCanonicalId: () => "claude-sonnet-4-5",
	getAvailable: () => canonicalVariantModels,
} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

const allModels = [...mockModels, ...mockOpenRouterModels, ...mockProviderOverlapModels, ...mockCodexOverlapModels];

describe("parseModelPattern", () => {
	describe("simple patterns without colons", () => {
		test("exact match returns model with undefined thinking level", () => {
			const result = parseModelPattern("claude-sonnet-4-5", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toBeUndefined();
		});

		test("partial match returns best model with undefined thinking level", () => {
			const result = parseModelPattern("sonnet", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toBeUndefined();
		});

		test("no match returns undefined model and thinking level", () => {
			const result = parseModelPattern("nonexistent", allModels);
			expect(result.model).toBeUndefined();
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toBeUndefined();
		});
	});

	describe("patterns with valid thinking levels", () => {
		test("sonnet:high returns sonnet with high thinking level", () => {
			const result = parseModelPattern("sonnet:high", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBe(Effort.High);
			expect(result.warning).toBeUndefined();
		});

		test("gpt-4o:medium returns gpt-4o with medium thinking level", () => {
			const result = parseModelPattern("gpt-4o:medium", allModels);
			expect(result.model?.id).toBe("gpt-4o");
			expect(result.thinkingLevel).toBe(Effort.Medium);
			expect(result.warning).toBeUndefined();
		});

		test("all valid thinking levels work", () => {
			const levels = [
				"off",
				Effort.Minimal,
				Effort.Low,
				Effort.Medium,
				Effort.High,
				Effort.XHigh,
				Effort.Max,
			] as const;
			for (const level of levels) {
				const result = parseModelPattern(`sonnet:${level}`, allModels);
				expect(result.model?.id).toBe("claude-sonnet-4-5");
				expect(result.thinkingLevel).toBe(level);
				expect(result.warning).toBeUndefined();
			}
		});
	});

	describe("patterns with invalid thinking levels", () => {
		test("sonnet:random returns sonnet with undefined thinking level and warning", () => {
			const result = parseModelPattern("sonnet:random", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toContain("Invalid thinking level");
			expect(result.warning).toContain("random");
		});

		test("gpt-4o:invalid returns gpt-4o with undefined thinking level and warning", () => {
			const result = parseModelPattern("gpt-4o:invalid", allModels);
			expect(result.model?.id).toBe("gpt-4o");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toContain("Invalid thinking level");
		});
	});

	describe("OpenRouter models with colons in IDs", () => {
		test("qwen3-coder:exacto matches the model with undefined thinking level", () => {
			const result = parseModelPattern("qwen/qwen3-coder:exacto", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toBeUndefined();
		});

		test("openrouter/qwen/qwen3-coder:exacto matches with provider prefix", () => {
			const result = parseModelPattern("openrouter/qwen/qwen3-coder:exacto", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.model?.provider).toBe("openrouter");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toBeUndefined();
		});

		test("qwen3-coder:exacto:high matches model with high thinking level", () => {
			const result = parseModelPattern("qwen/qwen3-coder:exacto:high", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.thinkingLevel).toBe(Effort.High);
			expect(result.explicitThinkingLevel).toBe(true);
			expect(result.warning).toBeUndefined();
		});

		test("openrouter/qwen/qwen3-coder:exacto:high matches with provider and thinking level", () => {
			const result = parseModelPattern("openrouter/qwen/qwen3-coder:exacto:high", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.model?.provider).toBe("openrouter");
			expect(result.thinkingLevel).toBe(Effort.High);
			expect(result.explicitThinkingLevel).toBe(true);
			expect(result.warning).toBeUndefined();
		});

		test("gpt-4o:extended matches the extended model with undefined thinking level", () => {
			const result = parseModelPattern("openai/gpt-4o:extended", allModels);
			expect(result.model?.id).toBe("openai/gpt-4o:extended");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toBeUndefined();
		});

		test("supports OpenRouter route suffixes that are not present in the catalog", () => {
			const result = parseModelPattern("openrouter/z-ai/glm-4.7-20251222:nitro", allModels);
			expect(result.model?.provider).toBe("openrouter");
			expect(result.model?.id).toBe("z-ai/glm-4.7-20251222:nitro");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toBeUndefined();
		});

		test("supports OpenRouter route suffixes with an appended thinking level", () => {
			const result = parseModelPattern("openrouter/z-ai/glm-4.7-20251222:nitro:high", allModels);
			expect(result.model?.provider).toBe("openrouter");
			expect(result.model?.id).toBe("z-ai/glm-4.7-20251222:nitro");
			expect(result.thinkingLevel).toBe(Effort.High);
			expect(result.explicitThinkingLevel).toBe(true);
			expect(result.warning).toBeUndefined();
		});
	});

	describe("invalid thinking levels with OpenRouter models", () => {
		test("qwen3-coder:exacto:random returns model with undefined thinking level and warning", () => {
			const result = parseModelPattern("qwen/qwen3-coder:exacto:random", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toContain("Invalid thinking level");
			expect(result.warning).toContain("random");
		});

		test("qwen3-coder:exacto:high:random returns model with undefined thinking level and warning", () => {
			const result = parseModelPattern("qwen/qwen3-coder:exacto:high:random", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toContain("Invalid thinking level");
			expect(result.warning).toContain("random");
		});
	});

	describe("edge cases", () => {
		test("empty pattern matches via partial matching", () => {
			// Empty string is included in all model IDs, so partial matching finds a match
			const result = parseModelPattern("", allModels);
			expect(result.model).not.toBeNull();
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
		});

		test("pattern ending with colon treats empty suffix as invalid", () => {
			const result = parseModelPattern("sonnet:", allModels);
			// Empty string after colon is not a valid thinking level
			// So it tries to match "sonnet:" which won't match, then tries "sonnet"
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.warning).toContain("Invalid thinking level");
		});
	});

	describe("preference logic", () => {
		test("prefers most recently used model when multiple providers match", () => {
			const result = parseModelPattern("k2.5", allModels, {
				usageOrder: ["kimi-code/kimi-k2.5"],
			});
			expect(result.model?.provider).toBe("kimi-code");
		});

		test("falls back to deprioritizing openrouter when no usage data", () => {
			const result = parseModelPattern("k2.5", allModels, { usageOrder: [] });
			expect(result.model?.provider).toBe("kimi-code");
		});

		test("respects most recently used provider even if openrouter", () => {
			const result = parseModelPattern("k2.5", allModels, {
				usageOrder: ["openrouter/moonshotai/kimi-k2.5"],
			});
			expect(result.model?.provider).toBe("openrouter");
			expect(result.model?.id).toBe("moonshotai/kimi-k2.5");
		});
	});

	describe("canonical ids", () => {
		test("resolves an exact canonical id through the registry before bare-id matching", () => {
			const result = parseModelPattern("claude-sonnet-4-5", canonicalVariantModels, undefined, {
				modelRegistry: canonicalRegistry,
			});
			expect(result.model?.provider).toBe("github-copilot");
			expect(result.model?.id).toBe("anthropic/claude-sonnet-4.5");
		});

		test("forwards session identity for canonical resolution", () => {
			let sessionId: string | undefined;
			const result = resolveModelRoleValue("claude-sonnet-4-5", canonicalVariantModels, {
				modelRegistry: {
					resolveCanonicalModel: (_canonicalId, options) => {
						sessionId = options?.sessionId;
						return canonicalVariantModels[0];
					},
				},
				sessionId: "stable-session-id",
			});
			expect(result.model).toBe(canonicalVariantModels[0]);
			expect(sessionId).toBe("stable-session-id");
		});
	});
});

describe("resolveModelRoleValue", () => {
	test("resolves pi/<role>:<thinking> by expanding role alias before parsing thinking", () => {
		const settings = {
			getModelRole: (role: string) => (role === "default" ? "openrouter/qwen/qwen3-coder:exacto" : undefined),
		} as NonNullable<Parameters<typeof resolveModelRoleValue>[2]>["settings"];

		const result = resolveModelRoleValue("pi/default:high", allModels, { settings });

		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
		expect(result.thinkingLevel).toBe(Effort.High);
		expect(result.explicitThinkingLevel).toBe(true);
	});

	test("resolves pi/default through configured default role alias", () => {
		const settings = {
			getModelRole: (role: string) => (role === "default" ? "openrouter/qwen/qwen3-coder:exacto" : undefined),
		} as NonNullable<Parameters<typeof resolveModelRoleValue>[2]>["settings"];

		const result = resolveModelRoleValue("pi/default", allModels, { settings });

		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
		expect(result.thinkingLevel).toBeUndefined();
		expect(result.explicitThinkingLevel).toBe(false);
		expect(result.warning).toBeUndefined();
	});

	test("does not resolve exact codex role values to codex-spark via substring matching", () => {
		const providerQualified = resolveModelRoleValue("openai-codex/gpt-5.3-codex:xhigh", allModels);
		expect(providerQualified.model?.provider).toBe("openai-codex");
		expect(providerQualified.model?.id).toBe("gpt-5.3-codex");
		expect(providerQualified.thinkingLevel).toBe(Effort.XHigh);
		expect(providerQualified.explicitThinkingLevel).toBe(true);

		const idOnly = resolveModelRoleValue("gpt-5.3-codex:xhigh", allModels);
		expect(idOnly.model?.provider).toBe("openai-codex");
		expect(idOnly.model?.id).toBe("gpt-5.3-codex");
		expect(idOnly.thinkingLevel).toBe(Effort.XHigh);
		expect(idOnly.explicitThinkingLevel).toBe(true);
	});

	test("clamps explicit thinking selectors from model metadata", () => {
		const result = resolveModelRoleValue("anthropic/claude-sonnet-4-5:xhigh", allModels);

		expect(result.model?.provider).toBe("anthropic");
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe(Effort.High);
		expect(result.explicitThinkingLevel).toBe(true);
	});
});
describe("resolveAgentModelPatterns", () => {
	test("falls back to the active session model when the agent inherits via pi/default", () => {
		const settings = Settings.isolated({
			modelRoles: { default: "anthropic/claude-sonnet-4-5" },
		});

		const result = resolveAgentModelPatterns({
			agentModel: "pi/default",
			settings,
			activeModelPattern: "openai/gpt-4o",
		});

		expect(result).toEqual(["openai/gpt-4o"]);
	});

	test("uses an explicit provider/model agent override instead of inheriting", () => {
		const settings = Settings.isolated({
			modelRoles: { default: "openai/gpt-4o" },
		});

		const result = resolveAgentModelPatterns({
			agentModel: "anthropic/claude-sonnet-4-5:high",
			settings,
			activeModelPattern: "openai/gpt-4o",
		});

		expect(result).toEqual(["anthropic/claude-sonnet-4-5:high"]);
	});
});

describe("resolveModelFromString", () => {
	test("falls back to pattern parsing for provider/model:thinking when strict provider+id miss", () => {
		const resolved = resolveModelFromString("openrouter/qwen/qwen3-coder:exacto:high", allModels);
		expect(resolved?.provider).toBe("openrouter");
		expect(resolved?.id).toBe("qwen/qwen3-coder:exacto");
	});

	test("treats colon-containing model IDs without thinking suffix as exact IDs", () => {
		const resolved = resolveModelFromString("openrouter/qwen/qwen3-coder:exacto", allModels);
		expect(resolved?.provider).toBe("openrouter");
		expect(resolved?.id).toBe("qwen/qwen3-coder:exacto");
	});
});

describe("resolveModelOverride", () => {
	test("preserves explicit off and explicit-thinking metadata", () => {
		const registry = {
			getAvailable: () => allModels,
		} as Parameters<typeof resolveModelOverride>[1];

		const result = resolveModelOverride(["sonnet:off"], registry);

		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe("off");
		expect(result.explicitThinkingLevel).toBe(true);
	});

	test("resolves colon-containing model IDs with appended thinking suffix", () => {
		const registry = {
			getAvailable: () => allModels,
		} as Parameters<typeof resolveModelOverride>[1];

		const result = resolveModelOverride(["openrouter/qwen/qwen3-coder:exacto:high"], registry);

		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
		expect(result.thinkingLevel).toBe(Effort.High);
		expect(result.explicitThinkingLevel).toBe(true);
	});
});
describe("resolveCliModel", () => {
	test("resolves exact canonical ids to the preferred concrete provider", () => {
		const result = resolveCliModel({
			cliModel: "claude-sonnet-4-5",
			modelRegistry: {
				...canonicalRegistry,
				getAll: () => canonicalVariantModels,
			} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"],
		});

		expect(result.error).toBeUndefined();
		expect(result.selector).toBe("claude-sonnet-4-5");
		expect(result.model?.provider).toBe("github-copilot");
		expect(result.model?.id).toBe("anthropic/claude-sonnet-4.5");
	});

	test("resolves --model provider/id without --provider", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "openai/gpt-4o",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o");
	});

	test("resolves fuzzy patterns within an explicit provider", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "4o",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o");
	});

	test("supports --model <pattern>:<thinking> (without explicit --thinking)", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "sonnet:high",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe(Effort.High);
	});

	test("prefers exact model id match over provider inference (OpenRouter-style ids)", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "openai/gpt-4o:extended",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("openai/gpt-4o:extended");
	});

	test("does not strip invalid :suffix as thinking level in --model (fail fast)", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "gpt-4o:extended",
			modelRegistry: registry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain("not found");
	});

	test("supports provider-prefixed OpenRouter route suffixes even when the base model is cataloged without them", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "openrouter/z-ai/glm-4.7-20251222:nitro",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("z-ai/glm-4.7-20251222:nitro");
	});

	test("supports explicit OpenRouter provider with route suffixes that are not in the catalog", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "openrouter",
			cliModel: "z-ai/glm-4.7-20251222:nitro",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("z-ai/glm-4.7-20251222:nitro");
	});

	test("returns a clear error when there are no models", () => {
		const registry = {
			getAll: () => [],
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "gpt-4o",
			modelRegistry: registry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain("No models available");
	});

	test("resolves provider-prefixed fuzzy patterns (openrouter/qwen -> openrouter model)", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "openrouter/qwen",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
	});

	test("prefers decomposed provider+id over flat id match when ambiguous", () => {
		// Simulates the zai/glm-5 bug: vercel-ai-gateway has id="zai/glm-5",
		// zai has id="glm-5". Input "zai/glm-5" should resolve to provider=zai.
		const ambiguousModels: Model<"anthropic-messages">[] = [
			{
				id: "zai/glm-5",
				name: "GLM-5 (Vercel)",
				api: "anthropic-messages",
				provider: "vercel-ai-gateway",
				baseUrl: "https://vercel.ai",
				reasoning: false,
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
			{
				id: "glm-5",
				name: "GLM-5",
				api: "anthropic-messages",
				provider: "zai",
				baseUrl: "https://api.z.ai",
				reasoning: false,
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		];
		const registry = {
			getAll: () => ambiguousModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "zai/glm-5",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("zai");
		expect(result.model?.id).toBe("glm-5");
	});
});

describe("resolveModelScope", () => {
	test("expands exact canonical ids into all concrete variants", async () => {
		const scoped = await resolveModelScope(["claude-sonnet-4-5"], {
			getAvailable: () => canonicalVariantModels,
			getCanonicalVariants: (canonicalId: string, options?: { candidates?: Model<"anthropic-messages">[] }) =>
				canonicalRegistry.getCanonicalVariants!(canonicalId, options),
		} as unknown as Parameters<typeof resolveModelScope>[1]);

		expect(scoped).toHaveLength(2);
		expect(scoped.map(entry => `${entry.model.provider}/${entry.model.id}`).sort()).toEqual([
			"anthropic/claude-sonnet-4-5",
			"github-copilot/anthropic/claude-sonnet-4.5",
		]);
	});
});

describe("parseModelString", () => {
	test("parses standard provider/id format", () => {
		const result = parseModelString("anthropic/claude-sonnet-4-5");
		expect(result).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
	});

	test("returns undefined for strings without a slash", () => {
		expect(parseModelString("claude-sonnet-4-5")).toBeUndefined();
		expect(parseModelString("")).toBeUndefined();
		expect(parseModelString("sonnet:high")).toBeUndefined();
	});

	test("returns undefined for strings starting with slash", () => {
		expect(parseModelString("/claude-sonnet-4-5")).toBeUndefined();
	});

	describe("thinking level suffix extraction", () => {
		test("extracts valid thinking level from provider/id:level", () => {
			const result = parseModelString("anthropic/claude-sonnet-4-5:high");
			expect(result).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5", thinkingLevel: Effort.High });
		});

		test("extracts all valid thinking levels", () => {
			const levels = ["off", Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] as const;
			for (const level of levels) {
				const result = parseModelString(`anthropic/claude-sonnet-4-5:${level}`);
				expect(result?.id).toBe("claude-sonnet-4-5");
				expect(result?.thinkingLevel).toBe(level);
			}
		});

		test("does NOT strip invalid suffix — treats it as part of model ID", () => {
			const result = parseModelString("openrouter/qwen/qwen3-coder:exacto");
			expect(result).toEqual({ provider: "openrouter", id: "qwen/qwen3-coder:exacto" });
		});

		test("handles model ID with colon followed by valid thinking level", () => {
			// e.g. "openrouter/qwen/qwen3-coder:exacto:high" — last colon is thinking level
			const result = parseModelString("openrouter/qwen/qwen3-coder:exacto:high");
			expect(result).toEqual({
				provider: "openrouter",
				id: "qwen/qwen3-coder:exacto",
				thinkingLevel: Effort.High,
			});
		});

		test("does not extract thinking level from model ID with invalid suffix", () => {
			const result = parseModelString("openrouter/openai/gpt-4o:extended");
			// :extended is not a valid thinking level, so it stays as part of the ID
			expect(result).toEqual({ provider: "openrouter", id: "openai/gpt-4o:extended" });
		});

		test("handles empty suffix after colon", () => {
			const result = parseModelString("anthropic/claude-sonnet-4-5:");
			// Empty string is not a valid thinking level, so colon stays as part of ID
			expect(result).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5:" });
		});
	});
});

const codexDefaultModels: Model<"anthropic-messages">[] = [
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "anthropic-messages",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		thinking: { mode: "effort", minLevel: Effort.Low, maxLevel: Effort.XHigh },
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		api: "anthropic-messages",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		thinking: { mode: "effort", minLevel: Effort.Low, maxLevel: Effort.XHigh, defaultLevel: Effort.XHigh },
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
];

const codexDefaultRegistry = {
	getAvailable: () => codexDefaultModels,
	find: (provider: string, id: string) =>
		codexDefaultModels.find(model => model.provider === provider && model.id === id),
	getApiKey: async () => "test-key",
};

describe("OpenAI Codex default resolution", () => {
	test("fresh startup prefers gpt-5.5 over gpt-5.4 when no persisted default exists", async () => {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRegistry: codexDefaultRegistry,
		});

		expect(result.model?.provider).toBe("openai-codex");
		expect(result.model?.id).toBe("gpt-5.5");
		expect(result.model?.thinking?.defaultLevel).toBe(Effort.XHigh);
	});

	test("restore fallback keeps visible fallback on gpt-5.5 instead of silently drifting to gpt-5.4", async () => {
		const result = await restoreModelFromSession(
			"openai-codex",
			"missing-gpt",
			undefined,
			false,
			codexDefaultRegistry,
		);

		expect(result.model?.provider).toBe("openai-codex");
		expect(result.model?.id).toBe("gpt-5.5");
		expect(result.fallbackMessage).toBe(
			"Could not restore model openai-codex/missing-gpt (model no longer exists). Using openai-codex/gpt-5.5.",
		);
	});
});

describe("expandRoleAlias", () => {
	test("expands pi/default to the configured default role", () => {
		const settings = Settings.isolated();
		settings.setModelRole("default", "openai/gpt-4o");

		expect(expandRoleAlias("pi/default", settings)).toBe("openai/gpt-4o");
	});

	test("leaves an unknown role alias unchanged", () => {
		const settings = Settings.isolated();

		expect(expandRoleAlias("pi/vision", settings)).toBe("pi/vision");
	});
});
