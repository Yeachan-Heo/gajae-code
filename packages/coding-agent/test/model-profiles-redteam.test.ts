import { describe, expect, test } from "bun:test";
import {
	BUILTIN_MODEL_PROFILES,
	mergeModelProfiles,
	resolveProfileBindings,
} from "@gajae-code/coding-agent/config/model-profiles";
import { ModelsConfigSchema, ProfileModelSelectorSchema } from "@gajae-code/coding-agent/config/models-config-schema";

function issuePaths(error: { issues: Array<{ path: PropertyKey[] }> }): string[] {
	return error.issues.map(issue => issue.path.join("."));
}

function profileConfig(modelSelector: string) {
	return {
		profiles: {
			bad: {
				required_providers: ["provider"],
				model_mapping: { default: modelSelector },
			},
		},
	};
}

describe("model profile red-team schema and catalog cases", () => {
	test("required_providers rejects empty arrays", () => {
		const result = ModelsConfigSchema.safeParse({
			profiles: {
				bad: {
					required_providers: [],
					model_mapping: { default: "provider/model" },
				},
			},
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(issuePaths(result.error)).toContain("profiles.bad.required_providers");
		}
	});

	test("model_mapping accepts a partial one-role mapping", () => {
		const result = ModelsConfigSchema.safeParse({
			profiles: {
				partial: {
					required_providers: ["provider"],
					model_mapping: { executor: "provider/model" },
				},
			},
		});

		expect(result.success).toBe(true);
	});

	test("model_mapping rejects unknown role keys with model_mapping in the path", () => {
		const result = ModelsConfigSchema.safeParse({
			profiles: {
				bad: {
					required_providers: ["provider"],
					model_mapping: { reviewer: "provider/model" },
				},
			},
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(issuePaths(result.error).some(path => path.includes("profiles.bad.model_mapping.reviewer"))).toBe(true);
		}
	});

	test.each([
		["missing slash", "providermodel"],
		["empty provider", "/model"],
		["empty model", "provider/"],
		["trailing colon", "provider/model:"],
		["bogus effort", "provider/model:ultra"],
		["double effort", "provider/model:high:low"],
	])("selector rejects %s", (_label, selector) => {
		const result = ModelsConfigSchema.safeParse(profileConfig(selector));

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(issuePaths(result.error)).toContain("profiles.bad.model_mapping.default");
			expect(result.error.issues[0]?.message).toBe("Expected provider/modelId with optional :effort suffix");
		}
	});

	test("profile definitions strictly reject extra fields", () => {
		const result = ModelsConfigSchema.safeParse({
			profiles: {
				bad: {
					required_providers: ["provider"],
					model_mapping: { default: "provider/model" },
					description: "not part of the public profile schema",
				},
			},
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(issuePaths(result.error)).toContain("profiles.bad");
		}
	});

	test("user profile with a duplicate builtin name overrides it and changes source to user", () => {
		const merged = mergeModelProfiles({
			"codex-medium": {
				required_providers: ["custom-provider"],
				model_mapping: { default: "custom-provider/custom-model" },
			},
		});

		expect(merged.get("codex-medium")).toEqual({
			name: "codex-medium",
			requiredProviders: ["custom-provider"],
			modelMapping: { default: "custom-provider/custom-model" },
			source: "user",
		});
	});

	test("mergeModelProfiles does not add underdeclared mapped providers to activation prerequisites", () => {
		const merged = mergeModelProfiles({
			underdeclared: {
				required_providers: ["provider-a"],
				model_mapping: { default: "provider-a/default", executor: "provider-b/executor:high" },
			},
		});

		expect(merged.get("underdeclared")?.requiredProviders).toEqual(["provider-a"]);
	});

	test("resolveProfileBindings on a default-only mapping returns only defaultSelector", () => {
		const resolved = resolveProfileBindings({
			name: "default-only",
			requiredProviders: ["provider"],
			modelMapping: { default: "provider/model" },
			source: "user",
		});

		expect(resolved).toEqual({ defaultSelector: "provider/model", modelRoles: {}, agentModelOverrides: {} });
	});

	test("resolveProfileBindings preserves effort suffixes verbatim", () => {
		const resolved = resolveProfileBindings({
			name: "effort",
			requiredProviders: ["provider"],
			modelMapping: {
				default: "provider/default:medium",
				executor: "provider/executor:high",
			},
			source: "user",
		});

		expect(resolved.defaultSelector).toBe("provider/default:medium");
		expect(resolved.modelRoles).toEqual({});
		expect(resolved.agentModelOverrides).toEqual({ executor: "provider/executor:high" });
	});

	test("mergeModelProfiles with undefined returns exactly the builtin catalog", () => {
		const merged = mergeModelProfiles(undefined);

		expect(merged.size).toBe(BUILTIN_MODEL_PROFILES.length);

		expect([...merged.values()]).toEqual([...BUILTIN_MODEL_PROFILES]);
	});

	test("every builtin selector satisfies public selector validation", () => {
		const failures: string[] = [];
		for (const profile of BUILTIN_MODEL_PROFILES) {
			for (const [role, selector] of Object.entries(profile.modelMapping)) {
				if (!ProfileModelSelectorSchema.safeParse(selector).success)
					failures.push(`${profile.name}.${role}=${selector}`);
			}
		}

		expect(failures).toEqual([]);
	});
});
