import { describe, expect, test } from "bun:test";
import {
	compareRankedProviders,
	FAMOUS_PROVIDER_ORDER,
	famousProviderIndex,
	PROVIDER_RANK_TIER,
	providerRankTier,
	type RankableProvider,
	rankProvider,
	sortRankedProviders,
} from "../src/config/provider-ranking";

function provider(id: string, authState: RankableProvider["authState"], label = id): RankableProvider {
	return { id, label, authState };
}

describe("providerRankTier", () => {
	test("valid, checking, and configured share the existing tier", () => {
		expect(providerRankTier("valid", "anthropic")).toBe(PROVIDER_RANK_TIER.existing);
		expect(providerRankTier("checking", "anthropic")).toBe(PROVIDER_RANK_TIER.existing);
		expect(providerRankTier("configured", "glm-proxy")).toBe(PROVIDER_RANK_TIER.existing);
	});

	test("invalid credentials rank in the problematic tier", () => {
		expect(providerRankTier("invalid", "anthropic")).toBe(PROVIDER_RANK_TIER.problematic);
		expect(providerRankTier("invalid", "some-unknown-provider")).toBe(PROVIDER_RANK_TIER.problematic);
	});

	test("unauthenticated providers split into famous and other", () => {
		expect(providerRankTier("none", "openai-codex")).toBe(PROVIDER_RANK_TIER.famous);
		expect(providerRankTier("none", "tavily")).toBe(PROVIDER_RANK_TIER.other);
	});
});

describe("rankProvider", () => {
	test("returns the tier and the intra-tier rank in one result", () => {
		expect(rankProvider(provider("anthropic", "valid"))).toEqual({
			tier: PROVIDER_RANK_TIER.existing,
			intraTierRank: famousProviderIndex("anthropic") as number,
		});
		expect(rankProvider(provider("openai-codex", "none"))).toEqual({
			tier: PROVIDER_RANK_TIER.famous,
			intraTierRank: famousProviderIndex("openai-codex") as number,
		});
		expect(rankProvider(provider("kagi", "invalid"))).toEqual({
			tier: PROVIDER_RANK_TIER.problematic,
			intraTierRank: Number.MAX_SAFE_INTEGER,
		});
		expect(rankProvider(provider("my-custom-gateway", "none"))).toEqual({
			tier: PROVIDER_RANK_TIER.other,
			intraTierRank: Number.MAX_SAFE_INTEGER,
		});
	});

	test("agrees with the comparator it backs", () => {
		const left = provider("openai-codex", "none");
		const right = provider("cursor", "none");
		const leftRank = rankProvider(left);
		const rightRank = rankProvider(right);
		expect(leftRank.tier).toBe(rightRank.tier);
		expect(leftRank.intraTierRank).toBeLessThan(rightRank.intraTierRank);
		expect(compareRankedProviders(left, right)).toBeLessThan(0);
	});
});

describe("famous provider list", () => {
	test("variants sit immediately behind their primary", () => {
		const pairs: [string, string][] = [
			["openai-codex", "openai-codex-device"],
			["zai", "glm-zcode"],
			["alibaba-token-plan", "qwen-portal"],
			["kimi-code", "moonshot"],
			["minimax-code", "minimax-code-cn"],
			["xiaomi", "xiaomi-token-plan-sgp"],
		];
		for (const [primary, variant] of pairs) {
			const primaryIndex = famousProviderIndex(primary);
			const variantIndex = famousProviderIndex(variant);
			expect(primaryIndex).toBeDefined();
			expect(variantIndex).toBe((primaryIndex as number) + 1);
		}
	});

	test("github copilot and cursor are on the famous list", () => {
		expect(famousProviderIndex("github-copilot")).toBeDefined();
		expect(famousProviderIndex("cursor")).toBeDefined();
	});

	test("the list has no duplicates", () => {
		expect(new Set(FAMOUS_PROVIDER_ORDER).size).toBe(FAMOUS_PROVIDER_ORDER.length);
	});

	test("matches the agreed curated order exactly", () => {
		// Written out independently of FAMOUS_PROVIDER_ORDER so an accidental
		// reorder or removal of the constant cannot validate itself.
		const agreedOrder = [
			"openai-codex",
			"openai-codex-device",
			"anthropic",
			"xai",
			"opencode-go",
			"zai",
			"glm-zcode",
			"alibaba-token-plan",
			"qwen-portal",
			"kimi-code",
			"moonshot",
			"minimax-code",
			"minimax-code-cn",
			"xiaomi",
			"xiaomi-token-plan-sgp",
			"xiaomi-token-plan-ams",
			"xiaomi-token-plan-cn",
			"opengateway",
			"bizrouter",
			"mara",
			"github-copilot",
			"cursor",
		];
		expect([...FAMOUS_PROVIDER_ORDER]).toEqual(agreedOrder);

		// The same order must survive an actual sort of shuffled input.
		const shuffled = [...agreedOrder]
			.reverse()
			.map((id, index) => provider(id, "none", `Label ${String(index).padStart(2, "0")}`));
		expect(sortRankedProviders(shuffled).map(entry => entry.id)).toEqual(agreedOrder);
	});
});

describe("compareRankedProviders", () => {
	test("orders a fixture registry exactly", () => {
		const fixture: RankableProvider[] = [
			provider("tavily", "none", "Tavily"),
			provider("cursor", "none", "Cursor (Claude, GPT, etc.)"),
			provider("kagi", "invalid", "Kagi"),
			provider("openai-codex", "none", "ChatGPT Plus/Pro (Codex Subscription)"),
			provider("glm-proxy", "configured", "GLM / zAI"),
			provider("anthropic", "valid", "Anthropic (Claude Pro/Max)"),
			provider("cerebras", "none", "Cerebras"),
			provider("minimax-code-cn", "none", "MiniMax Coding Plan (China)"),
			provider("xai", "checking", "xAI"),
			provider("minimax-code", "none", "MiniMax Coding Plan (International)"),
		];

		expect(sortRankedProviders(fixture).map(entry => entry.id)).toEqual([
			// tier 0: valid / checking / configured, famous order then label
			"anthropic",
			"xai",
			"glm-proxy",
			// tier 1: problematic credentials
			"kagi",
			// tier 2: famous, curated order with variants behind their primary
			"openai-codex",
			"minimax-code",
			"minimax-code-cn",
			"cursor",
			// tier 3: everything else, alphabetical by label
			"cerebras",
			"tavily",
		]);
	});

	test("an authed-but-invalid provider outranks an unauthenticated famous provider", () => {
		const invalid = provider("kagi", "invalid", "Kagi");
		const famous = provider("anthropic", "none", "Anthropic (Claude Pro/Max)");
		expect(compareRankedProviders(invalid, famous)).toBeLessThan(0);
		expect(sortRankedProviders([famous, invalid]).map(entry => entry.id)).toEqual(["kagi", "anthropic"]);
	});

	test("checking ranks with valid so rows do not reflow during validation", () => {
		const before = sortRankedProviders([
			provider("anthropic", "checking", "Anthropic (Claude Pro/Max)"),
			provider("cursor", "none", "Cursor"),
			provider("kagi", "invalid", "Kagi"),
		]).map(entry => entry.id);
		const after = sortRankedProviders([
			provider("anthropic", "valid", "Anthropic (Claude Pro/Max)"),
			provider("cursor", "none", "Cursor"),
			provider("kagi", "invalid", "Kagi"),
		]).map(entry => entry.id);
		expect(after).toEqual(before);
	});

	test("unknown and custom providers land last", () => {
		const ranked = sortRankedProviders([
			provider("my-custom-gateway", "none", "My Custom Gateway"),
			provider("opengateway", "none", "OpenGateway by Sionic AI"),
			provider("github-copilot", "none", "GitHub Copilot"),
			provider("aaa-custom", "none", "AAA Custom"),
		]).map(entry => entry.id);
		expect(ranked.slice(0, 2)).toEqual(["opengateway", "github-copilot"]);
		expect(ranked.slice(2)).toEqual(["aaa-custom", "my-custom-gateway"]);
	});

	test("the comparator is a stable total order with no ties", () => {
		const states: RankableProvider["authState"][] = ["valid", "checking", "configured", "invalid", "none"];
		const entries: RankableProvider[] = [];
		for (const id of [...FAMOUS_PROVIDER_ORDER, "tavily", "kagi", "custom-one", "custom-two"]) {
			entries.push(provider(id, states[entries.length % states.length], `Label ${id}`));
		}

		for (const left of entries) {
			for (const right of entries) {
				if (left.id === right.id) {
					expect(compareRankedProviders(left, right)).toBe(0);
					continue;
				}
				const forward = compareRankedProviders(left, right);
				const backward = compareRankedProviders(right, left);
				expect(forward).not.toBe(0);
				expect(Math.sign(forward)).toBe(-Math.sign(backward));
			}
		}

		const sorted = sortRankedProviders(entries).map(entry => entry.id);
		const reversed = sortRankedProviders([...entries].reverse()).map(entry => entry.id);
		expect(reversed).toEqual(sorted);
		expect(new Set(sorted).size).toBe(entries.length);
	});

	test("identical labels still break ties by id", () => {
		const left = provider("bbb", "none", "Same Label");
		const right = provider("aaa", "none", "Same Label");
		expect(compareRankedProviders(left, right)).toBeGreaterThan(0);
		expect(sortRankedProviders([left, right]).map(entry => entry.id)).toEqual(["aaa", "bbb"]);
	});
});
