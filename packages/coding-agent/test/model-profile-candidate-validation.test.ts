import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { validateModelProfileCandidate } from "@gajae-code/coding-agent/config/model-profile-activation";
import type { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";

import { Settings } from "@gajae-code/coding-agent/config/settings";

const model = (provider: string, id: string, thinking?: Model["thinking"]): Model =>
	({
		provider,
		id,
		name: id,
		api: "openai-responses",
		contextWindow: 1000,
		maxTokens: 1000,
		thinking,
		reasoning: thinking !== undefined,
	}) as Model;

type CandidateRegistry = Pick<
	ModelRegistry,
	"getAll" | "getApiKeyForProvider" | "resolveCanonicalModel" | "getCanonicalVariants" | "getCanonicalId"
>;

function candidateRegistry(options?: { missingProviders?: string[] }): CandidateRegistry {
	const missing = new Set(options?.missingProviders ?? []);
	return {
		getAll: () => [
			model("my-oai", "gpt-custom"),
			model("anthropic", "claude"),
			model("openai-codex", "gpt-5.5", {
				mode: "effort",
				minLevel: ThinkingLevel.Low,
				maxLevel: ThinkingLevel.XHigh,
			}),
		],
		getApiKeyForProvider: async (provider: string) => (missing.has(provider) ? undefined : `key-${provider}`),
		resolveCanonicalModel: () => undefined,
		getCanonicalVariants: () => [],
		getCanonicalId: () => undefined,
	} as unknown as CandidateRegistry;
}

describe("validateModelProfileCandidate", () => {
	it("rejects a candidate with zero mapped roles", async () => {
		const result = await validateModelProfileCandidate({
			profileName: "empty",
			profile: { required_providers: ["my-oai"], model_mapping: {} },
			modelRegistry: candidateRegistry(),
			settings: Settings.isolated(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("at least one role");
	});

	it("rejects an unresolvable selector before any credential check", async () => {
		const result = await validateModelProfileCandidate({
			profileName: "bad",
			profile: { required_providers: ["ghost"], model_mapping: { default: "ghost/does-not-exist:high" } },
			modelRegistry: candidateRegistry(),
			settings: Settings.isolated(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("did not resolve");
	});

	it("rejects a provider without credentials", async () => {
		const result = await validateModelProfileCandidate({
			profileName: "needs-key",
			profile: { required_providers: ["my-oai"], model_mapping: { default: "my-oai/gpt-custom:low" } },
			modelRegistry: candidateRegistry({ missingProviders: ["my-oai"] }),
			settings: Settings.isolated(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("my-oai");
	});

	it("accepts a supported effort unchanged and returns derived sorted providers", async () => {
		const result = await validateModelProfileCandidate({
			profileName: "ok",
			profile: {
				required_providers: ["stale"],
				model_mapping: { default: "openai-codex/gpt-5.5:high", executor: "anthropic/claude" },
			},
			modelRegistry: candidateRegistry(),
			settings: Settings.isolated(),
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.normalizedMapping.default).toBe("openai-codex/gpt-5.5:high");
			expect(result.normalizedMapping.executor).toBe("anthropic/claude");
			expect(result.requiredProviders).toEqual(["anthropic", "openai-codex"]);
			expect(result.profile.required_providers).toEqual(["anthropic", "openai-codex"]);
		}
	});

	it("accepts and normalizes an above-max effort by clamping instead of rejecting", async () => {
		const result = await validateModelProfileCandidate({
			profileName: "clamp",
			profile: { required_providers: ["openai-codex"], model_mapping: { default: "openai-codex/gpt-5.5:max" } },
			modelRegistry: candidateRegistry(),
			settings: Settings.isolated(),
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.normalizedMapping.default).toBe("openai-codex/gpt-5.5:xhigh");
			expect(result.normalizedMapping.default).not.toBe("openai-codex/gpt-5.5:max");
		}
	});

	it("rejects an unknown effort suffix at the schema layer", async () => {
		const result = await validateModelProfileCandidate({
			profileName: "ultra",
			profile: { required_providers: ["openai-codex"], model_mapping: { default: "openai-codex/gpt-5.5:ultra" } },
			modelRegistry: candidateRegistry(),
			settings: Settings.isolated(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason.toLowerCase()).toContain("invalid");
	});
});
