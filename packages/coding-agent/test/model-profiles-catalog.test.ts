import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import modelsJson from "@gajae-code/ai/models.json" with { type: "json" };
import {
	BUILTIN_MODEL_PROFILES,
	type ModelProfileDefinition,
	mergeModelProfiles,
	resolveProfileBindings,
} from "@gajae-code/coding-agent/config/model-profiles";
import { parseModelString } from "@gajae-code/coding-agent/config/model-resolver";
import { ProfileModelSelectorSchema } from "@gajae-code/coding-agent/config/models-config-schema";

type Role = "default" | "executor" | "architect" | "planner" | "critic";

const roles: Role[] = ["default", "executor", "architect", "planner", "critic"];
const reviewRoles: Role[] = ["architect", "planner", "critic"];
const effortRank: Partial<Record<ThinkingLevel, number>> = {
	[ThinkingLevel.Minimal]: 0,
	[ThinkingLevel.Low]: 1,
	[ThinkingLevel.Medium]: 2,
	[ThinkingLevel.High]: 3,
	[ThinkingLevel.XHigh]: 4,
};

function builtIn(name: string): ModelProfileDefinition {
	const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === name);
	expect(profile).toBeDefined();
	return profile as ModelProfileDefinition;
}

function selectorExists(selector: string): boolean {
	const parsed = parseModelString(selector);
	if (!parsed) return false;
	const providerModels = modelsJson[parsed.provider as keyof typeof modelsJson] as Record<string, unknown> | undefined;
	return providerModels?.[parsed.id] !== undefined;
}

function effortOf(selector: string): number {
	const parsed = parseModelString(selector);
	return parsed?.thinkingLevel ? (effortRank[parsed.thinkingLevel] ?? 0) : 0;
}

describe("built-in model profile catalog", () => {
	test("contains exactly 9 builtins", () => {
		expect(BUILTIN_MODEL_PROFILES).toHaveLength(9);
		expect(new Set(BUILTIN_MODEL_PROFILES.map(profile => profile.name)).size).toBe(9);
	});

	test("required_providers are correct per family", () => {
		for (const profile of BUILTIN_MODEL_PROFILES) {
			if (profile.name.startsWith("opencode-go-codex-")) {
				expect(profile.requiredProviders).toEqual(["opencode-go", "openai-codex"]);
			} else if (profile.name.startsWith("opencode-go-")) {
				expect(profile.requiredProviders).toEqual(["opencode-go"]);
			} else if (profile.name.startsWith("codex-")) {
				expect(profile.requiredProviders).toEqual(["openai-codex"]);
			} else {
				throw new Error(`Unexpected built-in profile ${profile.name}`);
			}
		}
	});

	test("models.json package export is a plain relative path", async () => {
		const manifest = (await Bun.file(new URL("../../ai/package.json", import.meta.url)).json()) as {
			exports?: Record<string, { import?: string }>;
		};
		const exportTarget = manifest.exports?.["./models.json"]?.import;
		expect(exportTarget).toBe("./src/models.json");
		expect(exportTarget).not.toMatch(/^file:(?:file:)+/u);
	});

	test("every selector parses with schema validation and exists in models.json", () => {
		const missing: string[] = [];
		for (const profile of BUILTIN_MODEL_PROFILES) {
			for (const role of roles) {
				const selector = profile.modelMapping[role];
				expect(selector).toBeDefined();
				expect(ProfileModelSelectorSchema.safeParse(selector).success).toBe(true);
				expect(parseModelString(selector ?? "")).toBeDefined();
				if (selector && !selectorExists(selector)) missing.push(`${profile.name}.${role}=${selector}`);
			}
		}
		expect(missing).toEqual([]);
	});

	test("*-pro profiles raise effort on architect/planner/critic", () => {
		for (const profile of BUILTIN_MODEL_PROFILES.filter(candidate => candidate.name.endsWith("-pro"))) {
			for (const role of reviewRoles) {
				expect(effortOf(profile.modelMapping[role] ?? "")).toBeGreaterThanOrEqual(
					effortRank[ThinkingLevel.High] ?? 3,
				);
			}
		}
	});

	test("codex-standard mapping exactly equals OpenAI Code profile preset efforts", () => {
		const profile = builtIn("codex-standard");
		const expected: Record<Role, ThinkingLevel> = {
			default: ThinkingLevel.Medium,
			executor: ThinkingLevel.Low,
			architect: ThinkingLevel.XHigh,
			planner: ThinkingLevel.Medium,
			critic: ThinkingLevel.High,
		};
		for (const role of roles) {
			const parsed = parseModelString(profile.modelMapping[role] ?? "");
			expect(parsed?.provider).toBe("openai-codex");
			expect(parsed?.id).toBe("gpt-5.4");
			expect(parsed?.thinkingLevel).toBe(expected[role]);
		}
	});

	test("user same-name profile overrides builtin via mergeModelProfiles", () => {
		const merged = mergeModelProfiles({
			"codex-standard": {
				required_providers: ["custom"],
				model_mapping: { default: "custom/model" },
			},
		});
		const profile = merged.get("codex-standard");
		expect(profile).toEqual({
			name: "codex-standard",
			requiredProviders: ["custom"],
			modelMapping: { default: "custom/model" },
			source: "user",
		});
		expect(resolveProfileBindings(profile as ModelProfileDefinition)).toEqual({
			defaultSelector: "custom/model",
			agentModelOverrides: {},
		});
	});
});
