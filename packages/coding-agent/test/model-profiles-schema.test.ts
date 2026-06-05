import { describe, expect, test } from "bun:test";
import { resolveProfileBindings } from "@gajae-code/coding-agent/config/model-profiles";
import { ModelsConfigSchema } from "@gajae-code/coding-agent/config/models-config-schema";

function issuePaths(error: { issues: Array<{ path: PropertyKey[] }> }): string[] {
	return error.issues.map(issue => issue.path.join("."));
}

describe("model profile schema", () => {
	test("config without profiles parses", () => {
		const result = ModelsConfigSchema.safeParse({ providers: {}, modelBindings: {}, equivalence: {} });
		expect(result.success).toBe(true);
	});

	test("full and partial mappings parse", () => {
		const result = ModelsConfigSchema.safeParse({
			profiles: {
				full: {
					required_providers: ["openai-codex"],
					model_mapping: {
						default: "openai-codex/gpt-5.4:medium",
						executor: "openai-codex/gpt-5.4:low",
						architect: "openai-codex/gpt-5.4:xhigh",
						planner: "openai-codex/gpt-5.4:medium",
						critic: "openai-codex/gpt-5.4:high",
					},
				},
				partial: {
					required_providers: ["opencode-go"],
					model_mapping: { default: "opencode-go/kimi-k2.6" },
				},
			},
		});
		expect(result.success).toBe(true);
	});

	test("unknown model_mapping key is rejected with model_mapping path", () => {
		const result = ModelsConfigSchema.safeParse({
			profiles: {
				bad: {
					required_providers: ["openai-codex"],
					model_mapping: { reviewer: "openai-codex/gpt-5.4" },
				},
			},
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(issuePaths(result.error).some(path => path.includes("profiles.bad.model_mapping.reviewer"))).toBe(true);
		}
	});

	test("invalid selector and bad effort are rejected", () => {
		const missingSlash = ModelsConfigSchema.safeParse({
			profiles: { bad: { required_providers: ["x"], model_mapping: { default: "gpt-5.4" } } },
		});
		const badEffort = ModelsConfigSchema.safeParse({
			profiles: { bad: { required_providers: ["x"], model_mapping: { default: "x/model:ultra" } } },
		});
		expect(missingSlash.success).toBe(false);
		expect(badEffort.success).toBe(false);
		if (!badEffort.success) {
			expect(badEffort.error.issues[0]?.message).toBe("Expected provider/modelId with optional :effort suffix");
		}
	});

	test("comma-chain selectors are rejected with model_mapping path", () => {
		const commaChain = ModelsConfigSchema.safeParse({
			profiles: {
				bad: {
					required_providers: ["provider-a", "provider-b"],
					model_mapping: { default: "provider-a/model, provider-b/model:high" },
				},
			},
		});
		const badEffort = ModelsConfigSchema.safeParse({
			profiles: {
				bad: { required_providers: ["a"], model_mapping: { default: "a/m:bogus" } },
			},
		});
		const badProvider = ModelsConfigSchema.safeParse({
			profiles: {
				bad: { required_providers: ["a"], model_mapping: { default: "/m" } },
			},
		});

		expect(commaChain.success).toBe(false);
		expect(badEffort.success).toBe(false);
		expect(badProvider.success).toBe(false);
		for (const result of [commaChain, badEffort, badProvider]) {
			if (!result.success) {
				expect(issuePaths(result.error)).toContain("profiles.bad.model_mapping.default");
				expect(result.error.issues[0]?.message).toBe("Expected provider/modelId with optional :effort suffix");
			}
		}
	});

	test("resolveProfileBindings preserves single selectors verbatim", () => {
		const resolved = resolveProfileBindings({
			name: "single",
			requiredProviders: ["provider-a"],
			modelMapping: {
				default: "provider-a/model:high",
				executor: "provider-a/executor:low",
			},
			source: "user",
		});

		expect(resolved.defaultSelector).toBe("provider-a/model:high");
		expect(resolved.agentModelOverrides.executor).toBe("provider-a/executor:low");
	});

	test("extra profile field is rejected", () => {
		const result = ModelsConfigSchema.safeParse({
			profiles: {
				bad: {
					required_providers: ["openai-codex"],
					model_mapping: { default: "openai-codex/gpt-5.4" },
					description: "not allowed",
				},
			},
		});
		expect(result.success).toBe(false);
		if (!result.success) expect(issuePaths(result.error)).toContain("profiles.bad");
	});
});
