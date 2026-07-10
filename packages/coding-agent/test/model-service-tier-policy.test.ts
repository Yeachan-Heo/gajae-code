import { describe, expect, it } from "bun:test";
import {
	formatModelServiceTierOverrideKey,
	resolveModelServiceTierPolicy,
	sanitizeModelServiceTierOverrides,
} from "@gajae-code/coding-agent/config/model-service-tier-policy";

describe("resolveModelServiceTierPolicy", () => {
	it("preserves baseline and provider resolution when no override is present", () => {
		expect(
			resolveModelServiceTierPolicy({
				rawBaseline: "openai-only",
				provider: "openai",
				model: "gpt-5",
			}),
		).toMatchObject({
			decision: "inherit",
			rawRequestTier: "openai-only",
			providerResolvedTier: "priority",
			effectiveTier: "priority",
		});
	});

	it("keeps overrides distinct for model keys under the same provider", () => {
		const overrides = {
			[formatModelServiceTierOverrideKey("openai", "gpt-5")]: "on" as const,
			[formatModelServiceTierOverrideKey("openai", "gpt-4.1")]: "off" as const,
		};
		expect(
			resolveModelServiceTierPolicy({ rawBaseline: "flex", provider: "openai", model: "gpt-5", overrides }),
		).toMatchObject({ decision: "on", effectiveTier: "priority" });
		expect(
			resolveModelServiceTierPolicy({ rawBaseline: "flex", provider: "openai", model: "gpt-4.1", overrides }),
		).toMatchObject({ decision: "off", effectiveTier: "flex" });
	});

	it("requests priority when the per-model decision is on", () => {
		expect(
			resolveModelServiceTierPolicy({ rawBaseline: "flex", provider: "anthropic", model: "claude-sonnet", decision: "on" }),
		).toMatchObject({ rawRequestTier: "priority", effectiveTier: "priority" });
	});

	it("suppresses only a priority-resolved baseline when the decision is off", () => {
		expect(
			resolveModelServiceTierPolicy({ rawBaseline: "priority", provider: "openai", model: "gpt-5", decision: "off" }),
		).toMatchObject({ providerResolvedTier: "priority", effectiveTier: undefined });
		expect(
			resolveModelServiceTierPolicy({ rawBaseline: "flex", provider: "openai", model: "gpt-5", decision: "off" }),
		).toMatchObject({ providerResolvedTier: "flex", effectiveTier: "flex" });
	});

	it("applies provider-scoped OpenAI and Anthropic baselines", () => {
		expect(resolveModelServiceTierPolicy({ rawBaseline: "openai-only", provider: "openai", model: "gpt-5" })).toMatchObject({
			providerResolvedTier: "priority",
			effectiveTier: "priority",
		});
		expect(resolveModelServiceTierPolicy({ rawBaseline: "openai-only", provider: "anthropic", model: "claude-sonnet" })).toMatchObject({
			providerResolvedTier: undefined,
			effectiveTier: undefined,
		});
		expect(resolveModelServiceTierPolicy({ rawBaseline: "claude-only", provider: "anthropic", model: "claude-sonnet" })).toMatchObject({
			providerResolvedTier: "priority",
			effectiveTier: "priority",
		});
	});

	it("ignores malformed values without mutating persisted settings", () => {
		const input = { "openai/gpt-5": "on", "openai/gpt-4.1": "invalid", "": "off", nested: { value: "on" } };
		const before = structuredClone(input);
		expect(sanitizeModelServiceTierOverrides(input)).toEqual({ "openai/gpt-5": "on" });
		expect(input).toEqual(before);
		expect(
			resolveModelServiceTierPolicy({ rawBaseline: "flex", provider: "openai", model: "gpt-4.1", overrides: input }),
		).toMatchObject({ decision: "inherit", override: undefined, effectiveTier: "flex" });
	});
});
