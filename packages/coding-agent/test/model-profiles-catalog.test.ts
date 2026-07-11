import { describe, expect, test } from "bun:test";
import {
	BUILTIN_MODEL_PROFILES,
	formatAvailableProfileNames,
	getModelProfilePresentation,
	groupModelProfilesForPresetLanding,
	type ModelProfileDefinition,
	mergeModelProfiles,
	recommendModelProfileForProvider,
	resolveProfileBindings,
} from "@gajae-code/coding-agent/config/model-profiles";
import { parseModelString } from "@gajae-code/coding-agent/config/model-resolver";
import { ProfileModelSelectorSchema } from "@gajae-code/coding-agent/config/models-config-schema";
import modelsJson from "../../ai/src/models.json";

type Role = "default" | "executor" | "planner" | "critic" | "architect";

const roles: Role[] = ["default", "executor", "planner", "critic", "architect"];

const expectedProfiles: Array<{ name: string; requiredProviders: string[]; mapping: Record<Role, string> }> = [
	{
		name: "codex-eco",
		requiredProviders: ["openai-codex"],
		mapping: {
			default: "openai-codex/gpt-5.6-terra:high",
			executor: "openai-codex/gpt-5.6-luna:high",
			planner: "openai-codex/gpt-5.6-terra:medium",
			critic: "openai-codex/gpt-5.6-terra:high",
			architect: "openai-codex/gpt-5.6-sol:medium",
		},
	},
	{
		name: "codex-medium",
		requiredProviders: ["openai-codex"],
		mapping: {
			default: "openai-codex/gpt-5.6-sol:medium",
			executor: "openai-codex/gpt-5.6-terra:xhigh",
			planner: "openai-codex/gpt-5.6-terra:high",
			critic: "openai-codex/gpt-5.6-terra:xhigh",
			architect: "openai-codex/gpt-5.6-sol:high",
		},
	},
	{
		name: "codex-pro",
		requiredProviders: ["openai-codex"],
		mapping: {
			default: "openai-codex/gpt-5.6-sol:xhigh",
			executor: "openai-codex/gpt-5.6-terra:xhigh",
			planner: "openai-codex/gpt-5.6-sol:high",
			critic: "openai-codex/gpt-5.6-sol:xhigh",
			architect: "openai-codex/gpt-5.6-sol:max",
		},
	},
	{
		name: "opencodego",
		requiredProviders: ["opencode-go"],
		mapping: {
			default: "opencode-go/kimi-k2.6",
			executor: "opencode-go/deepseek-v4-flash",
			planner: "opencode-go/qwen3.7-max",
			critic: "opencode-go/mimo-v2.5-pro",
			architect: "opencode-go/deepseek-v4-pro",
		},
	},
	{
		name: "claude-opus",
		requiredProviders: ["anthropic"],
		mapping: {
			default: "anthropic/claude-opus-4-8:xhigh",
			executor: "anthropic/claude-sonnet-5",
			planner: "anthropic/claude-opus-4-8:low",
			critic: "anthropic/claude-opus-4-8:high",
			architect: "anthropic/claude-opus-4-8:xhigh",
		},
	},
	{
		name: "claude-fable",
		requiredProviders: ["anthropic"],
		mapping: {
			default: "anthropic/claude-fable-5:xhigh",
			executor: "anthropic/claude-sonnet-5",
			planner: "anthropic/claude-fable-5:low",
			critic: "anthropic/claude-fable-5:high",
			architect: "anthropic/claude-fable-5:xhigh",
		},
	},
	{
		name: "glm-eco",
		requiredProviders: ["zai"],
		mapping: {
			default: "zai/glm-5.2:low",
			executor: "zai/glm-5.2:minimal",
			planner: "zai/glm-5.2:low",
			critic: "zai/glm-5.2:medium",
			architect: "zai/glm-5.2:high",
		},
	},
	{
		name: "glm-medium",
		requiredProviders: ["zai"],
		mapping: {
			default: "zai/glm-5.2:medium",
			executor: "zai/glm-5.2:low",
			planner: "zai/glm-5.2:medium",
			critic: "zai/glm-5.2:high",
			architect: "zai/glm-5.2:xhigh",
		},
	},
	{
		name: "glm-pro",
		requiredProviders: ["zai"],
		mapping: {
			default: "zai/glm-5.2:xhigh",
			executor: "zai/glm-5.2:medium",
			planner: "zai/glm-5.2:high",
			critic: "zai/glm-5.2:xhigh",
			architect: "zai/glm-5.2:xhigh",
		},
	},
	{
		name: "kimi-coding-plan-eco",
		requiredProviders: ["kimi-code"],
		mapping: {
			default: "kimi-code/kimi-k2.7-code:low",
			executor: "kimi-code/kimi-k2.7-code:minimal",
			planner: "kimi-code/kimi-k2.7-code:low",
			critic: "kimi-code/kimi-k2.7-code:medium",
			architect: "kimi-code/kimi-k2.7-code:high",
		},
	},
	{
		name: "kimi-coding-plan-medium",
		requiredProviders: ["kimi-code"],
		mapping: {
			default: "kimi-code/kimi-k2.7-code:medium",
			executor: "kimi-code/kimi-k2.7-code:low",
			planner: "kimi-code/kimi-k2.7-code:medium",
			critic: "kimi-code/kimi-k2.7-code:high",
			architect: "kimi-code/kimi-k2.7-code:xhigh",
		},
	},
	{
		name: "kimi-coding-plan-pro",
		requiredProviders: ["kimi-code"],
		mapping: {
			default: "kimi-code/kimi-k2.7-code:xhigh",
			executor: "kimi-code/kimi-k2.7-code:medium",
			planner: "kimi-code/kimi-k2.7-code:high",
			critic: "kimi-code/kimi-k2.7-code:xhigh",
			architect: "kimi-code/kimi-k2.7-code:xhigh",
		},
	},
	{
		name: "mimo-eco",
		requiredProviders: ["xiaomi"],
		mapping: {
			default: "xiaomi/mimo-v2.5-pro:low",
			executor: "xiaomi/mimo-v2.5-pro:minimal",
			planner: "xiaomi/mimo-v2.5-pro:low",
			critic: "xiaomi/mimo-v2.5-pro:medium",
			architect: "xiaomi/mimo-v2.5-pro:high",
		},
	},
	{
		name: "mimo-medium",
		requiredProviders: ["xiaomi", "xiaomi-token-plan-sgp", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn"],
		mapping: {
			default: "xiaomi/mimo-v2.5-pro:medium",
			executor: "xiaomi/mimo-v2.5-pro:low",
			planner: "xiaomi/mimo-v2.5-pro:medium",
			critic: "xiaomi/mimo-v2.5-pro:high",
			architect: "xiaomi/mimo-v2.5-pro:xhigh",
		},
	},
	{
		name: "mimo-pro",
		requiredProviders: ["xiaomi", "xiaomi-token-plan-sgp", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn"],
		mapping: {
			default: "xiaomi/mimo-v2.5-pro:xhigh",
			executor: "xiaomi/mimo-v2.5-pro:medium",
			planner: "xiaomi/mimo-v2.5-pro:high",
			critic: "xiaomi/mimo-v2.5-pro:xhigh",
			architect: "xiaomi/mimo-v2.5-pro:xhigh",
		},
	},
	{
		name: "grok-eco",
		requiredProviders: ["xai"],
		mapping: {
			default: "xai/grok-4.3:low",
			executor: "xai/grok-4.3:minimal",
			planner: "xai/grok-4.3:low",
			critic: "xai/grok-4.3:medium",
			architect: "xai/grok-4.3:high",
		},
	},
	{
		name: "grok-medium",
		requiredProviders: ["xai"],
		mapping: {
			default: "xai/grok-4.3:medium",
			executor: "xai/grok-4.3:low",
			planner: "xai/grok-4.3:medium",
			critic: "xai/grok-4.3:high",
			architect: "xai/grok-4.3:xhigh",
		},
	},
	{
		name: "grok-pro",
		requiredProviders: ["xai"],
		mapping: {
			default: "xai/grok-4.3:xhigh",
			executor: "xai/grok-4.3:medium",
			planner: "xai/grok-4.3:high",
			critic: "xai/grok-4.3:xhigh",
			architect: "xai/grok-4.3:xhigh",
		},
	},
	{
		name: "grok-build-pro",
		requiredProviders: ["grok-build"],
		mapping: {
			default: "grok-build/grok-composer-2.5-fast",
			executor: "grok-build/grok-build",
			planner: "grok-build/grok-composer-2.5-fast",
			critic: "grok-build/grok-composer-2.5-fast",
			architect: "grok-build/grok-build",
		},
	},
	{
		name: "cursor-eco",
		requiredProviders: ["cursor"],
		mapping: {
			default: "cursor/composer-1.5:low",
			executor: "cursor/composer-1.5:minimal",
			planner: "cursor/composer-1.5:low",
			critic: "cursor/composer-1.5:medium",
			architect: "cursor/composer-1.5:high",
		},
	},
	{
		name: "cursor-medium",
		requiredProviders: ["cursor"],
		mapping: {
			default: "cursor/composer-1.5:medium",
			executor: "cursor/composer-1.5:low",
			planner: "cursor/composer-1.5:medium",
			critic: "cursor/composer-1.5:high",
			architect: "cursor/composer-1.5:xhigh",
		},
	},
	{
		name: "cursor-pro",
		requiredProviders: ["cursor"],
		mapping: {
			default: "cursor/composer-1.5:xhigh",
			executor: "cursor/composer-1.5:medium",
			planner: "cursor/composer-1.5:high",
			critic: "cursor/composer-1.5:xhigh",
			architect: "cursor/composer-1.5:xhigh",
		},
	},
	{
		name: "minimax-eco",
		requiredProviders: ["minimax-code"],
		mapping: {
			default: "minimax-code/minimax-m3:low",
			executor: "minimax-code/minimax-m3:minimal",
			planner: "minimax-code/minimax-m3:low",
			critic: "minimax-code/minimax-m3:medium",
			architect: "minimax-code/minimax-m3:high",
		},
	},
	{
		name: "minimax-medium",
		requiredProviders: ["minimax-code"],
		mapping: {
			default: "minimax-code/minimax-m3:medium",
			executor: "minimax-code/minimax-m3:low",
			planner: "minimax-code/minimax-m3:medium",
			critic: "minimax-code/minimax-m3:high",
			architect: "minimax-code/minimax-m3:xhigh",
		},
	},
	{
		name: "minimax-pro",
		requiredProviders: ["minimax-code"],
		mapping: {
			default: "minimax-code/minimax-m3:xhigh",
			executor: "minimax-code/minimax-m3:medium",
			planner: "minimax-code/minimax-m3:high",
			critic: "minimax-code/minimax-m3:xhigh",
			architect: "minimax-code/minimax-m3:xhigh",
		},
	},
	{
		name: "opus-codex",
		requiredProviders: ["anthropic", "openai-codex"],
		mapping: {
			default: "anthropic/claude-opus-4-8:xhigh",
			executor: "openai-codex/gpt-5.6-terra:xhigh",
			planner: "openai-codex/gpt-5.6-terra:high",
			critic: "openai-codex/gpt-5.6-terra:xhigh",
			architect: "openai-codex/gpt-5.6-sol:xhigh",
		},
	},
	{
		name: "codex-opencodego",
		requiredProviders: ["openai-codex", "opencode-go"],
		mapping: {
			default: "openai-codex/gpt-5.6-terra:xhigh",
			executor: "opencode-go/deepseek-v4-pro",
			planner: "opencode-go/kimi-k2.6",
			critic: "opencode-go/mimo-v2.5-pro",
			architect: "openai-codex/gpt-5.6-sol:xhigh",
		},
	},
	{
		name: "fable-opus-codex",
		requiredProviders: ["anthropic", "openai-codex"],
		mapping: {
			default: "anthropic/claude-fable-5:high",
			executor: "openai-codex/gpt-5.6-terra:xhigh",
			planner: "anthropic/claude-opus-4-8:medium",
			critic: "anthropic/claude-opus-4-8:high",
			architect: "openai-codex/gpt-5.6-sol:xhigh",
		},
	},
];

const oldNames = [
	"opencode-go-eco",
	"opencode-go-standard",
	"opencode-go-pro",
	"codex-standard",
	"opencode-go-codex-eco",
	"opencode-go-codex-standard",
	"opencode-go-codex-pro",
	"minimax-standard",
	"minimax-cn-standard",
	"kimi-standard",
	"glm-standard",
	"fable-codex",
];

function selectorExists(selector: string): boolean {
	const parsed = parseModelString(selector);
	if (!parsed) return false;
	if (parsed.provider === "grok-build") return ["grok-composer-2.5-fast", "grok-build"].includes(parsed.id);
	return (modelsJson as Record<string, Record<string, unknown>>)[parsed.provider]?.[parsed.id] !== undefined;
}

describe("built-in model profile catalog", () => {
	test("contains exact 28-profile matrix cell-for-cell", () => {
		expect(BUILTIN_MODEL_PROFILES.map(profile => profile.name)).toEqual(
			expectedProfiles.map(profile => profile.name),
		);
		for (const expected of expectedProfiles) {
			const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === expected.name);
			expect(profile?.requiredProviders).toEqual(expected.requiredProviders);
			expect(profile?.modelMapping).toEqual(expected.mapping);
		}
	});

	test("old builtin names are absent and available names list current names", () => {
		const profiles = mergeModelProfiles();
		for (const oldName of oldNames) expect(profiles.has(oldName)).toBe(false);
		expect(formatAvailableProfileNames(profiles)).toContain("codex-medium");
		expect(formatAvailableProfileNames(profiles)).not.toContain("codex-standard");
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
		expect((modelsJson as Record<string, Record<string, unknown>>)["kimi-code"]?.["kimi-k2.7-code"]).toBeDefined();
		expect((modelsJson as Record<string, Record<string, unknown>>)["minimax-code"]?.["minimax-m3"]).toBeDefined();
	});

	test("plain minimax provider does not appear in catalog or recommendations", () => {
		expect(JSON.stringify(BUILTIN_MODEL_PROFILES)).not.toContain("minimax/");
		expect(recommendModelProfileForProvider("minimax", mergeModelProfiles())).toBeUndefined();
		expect(recommendModelProfileForProvider("minimax-code", mergeModelProfiles())?.name).toBe("minimax-medium");
	});

	test("presentation groups and provider recommendations are pure catalog helpers", () => {
		const profiles = mergeModelProfiles();
		expect(getModelProfilePresentation("kimi-coding-plan-medium")).toEqual({
			displayName: "Kimi Coding Plan Medium",
			providerGroup: "KIMI CODING PLAN",
		});
		expect([...groupModelProfilesForPresetLanding(profiles).keys()]).toEqual([
			"CODEX",
			"OPENCODEGO",
			"CLAUDE",
			"GLM",
			"KIMI CODING PLAN",
			"MIMO",
			"GROK",
			"CURSOR",
			"MINIMAX",
			"COMBOS",
		]);
		expect(recommendModelProfileForProvider("openai-codex", profiles)?.name).toBe("codex-medium");
		expect(recommendModelProfileForProvider("anthropic", profiles)?.name).toBe("claude-opus");
		expect(recommendModelProfileForProvider("opencode-go", profiles)?.name).toBe("opencodego");
		expect(recommendModelProfileForProvider("zai", profiles)?.name).toBe("glm-medium");
		expect(recommendModelProfileForProvider("kimi-code", profiles)?.name).toBe("kimi-coding-plan-medium");
		expect(recommendModelProfileForProvider("xiaomi", profiles)?.name).toBe("mimo-medium");
		expect(recommendModelProfileForProvider("xiaomi-token-plan-sgp", profiles)?.name).toBe("mimo-medium");
		expect(recommendModelProfileForProvider("xiaomi-token-plan-ams", profiles)?.name).toBe("mimo-medium");
		expect(recommendModelProfileForProvider("xiaomi-token-plan-cn", profiles)?.name).toBe("mimo-medium");
		expect(recommendModelProfileForProvider("xai", profiles)?.name).toBe("grok-medium");
		expect(recommendModelProfileForProvider("grok-build", profiles)?.name).toBe("grok-build-pro");
		expect(recommendModelProfileForProvider("cursor", profiles)?.name).toBe("cursor-medium");
	});

	test("grok-build-pro maps Composer 2.5 Fast and Grok Build roles", () => {
		const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === "grok-build-pro");
		expect(profile).toBeDefined();
		expect(profile?.requiredProviders).toEqual(["grok-build"]);
		expect(profile?.modelMapping).toEqual({
			default: "grok-build/grok-composer-2.5-fast",
			executor: "grok-build/grok-build",
			architect: "grok-build/grok-build",
			planner: "grok-build/grok-composer-2.5-fast",
			critic: "grok-build/grok-composer-2.5-fast",
		});
	});

	test("built-in minimax profiles resolve to minimax-m3 and never minimax-v3 (issue #656)", () => {
		const minimaxProfiles = BUILTIN_MODEL_PROFILES.filter(profile =>
			profile.requiredProviders.includes("minimax-code"),
		);
		expect(minimaxProfiles.map(profile => profile.name)).toEqual(["minimax-eco", "minimax-medium", "minimax-pro"]);
		for (const profile of minimaxProfiles) {
			for (const role of roles) {
				const selector = profile.modelMapping[role];
				expect(selector).toBeDefined();
				const parsed = parseModelString(selector ?? "");
				expect(parsed?.provider).toBe("minimax-code");
				expect(parsed?.id).toBe("minimax-m3");
			}
		}
		expect(JSON.stringify(BUILTIN_MODEL_PROFILES)).not.toContain("minimax-v3");
	});

	test("user same-name profile overrides builtin via mergeModelProfiles", () => {
		const merged = mergeModelProfiles({
			"codex-medium": {
				required_providers: ["custom"],
				model_mapping: { default: "custom/model" },
			},
		});
		const profile = merged.get("codex-medium");
		expect(profile).toEqual({
			name: "codex-medium",
			requiredProviders: ["custom"],
			modelMapping: { default: "custom/model" },
			source: "user",
		});
		expect(resolveProfileBindings(profile as ModelProfileDefinition)).toEqual({
			defaultSelector: "custom/model",
			modelRoles: {},
			agentModelOverrides: {},
		});
	});
});
