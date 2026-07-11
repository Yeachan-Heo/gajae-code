import { sanitizeText } from "@gajae-code/utils";
import type { GjcModelAssignmentTargetId } from "./model-registry";
import type { ModelsConfig } from "./models-config-schema";

export type ModelProfileRole = GjcModelAssignmentTargetId;

export interface ModelProfileDefinition {
	name: string;
	requiredProviders: string[];
	displayName?: string;
	/**
	 * Optional groups of providers that are interchangeable fallbacks.
	 * Each group is an array of provider ids where at least one must be
	 * authenticated. Providers NOT in any group are treated as strict
	 * requirements (all must be authenticated).
	 *
	 * Example: `[["xiaomi", "xiaomi-token-plan-sgp", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn"]]`
	 * means any single xiaomi credential satisfies the group.
	 */
	alternativeProviderGroups?: readonly (readonly string[])[];
	modelMapping: Partial<Record<ModelProfileRole, string>>;
	source: "builtin" | "user";
}

export interface ResolvedProfileBinding {
	defaultSelector?: string;
	modelRoles: Record<string, string>;
	agentModelOverrides: Partial<Record<Exclude<ModelProfileRole, "default">, string>>;
}

function parseModelSelectorProvider(selector: string): string | undefined {
	const slashIdx = selector.indexOf("/");
	if (slashIdx <= 0) return undefined;
	return selector.slice(0, slashIdx);
}

export function deriveModelProfileMappedProviders(definition: Pick<ModelProfileDefinition, "modelMapping">): string[] {
	const providers = new Set<string>();
	for (const selector of Object.values(definition.modelMapping)) {
		if (!selector) continue;
		const provider = parseModelSelectorProvider(selector);
		if (provider) providers.add(provider);
	}
	return [...providers].sort((a, b) => a.localeCompare(b));
}

export function aggregateModelProfileRequiredProviders(
	requiredProviders: readonly string[],
	definition: Pick<ModelProfileDefinition, "modelMapping">,
): string[] {
	const providers = new Set(requiredProviders);
	for (const provider of deriveModelProfileMappedProviders(definition)) {
		providers.add(provider);
	}
	return [...providers];
}

const profile = (
	name: string,
	requiredProviders: string[],
	modelMapping: Partial<Record<ModelProfileRole, string>>,
	alternativeProviderGroups?: readonly (readonly string[])[],
): ModelProfileDefinition => ({
	name,
	requiredProviders: aggregateModelProfileRequiredProviders(requiredProviders, { modelMapping }),
	alternativeProviderGroups,
	modelMapping,
	source: "builtin",
});

export const BUILTIN_MODEL_PROFILES: readonly ModelProfileDefinition[] = [
	profile("codex-eco", ["openai-codex"], {
		default: "openai-codex/gpt-5.6-terra:high",
		executor: "openai-codex/gpt-5.6-luna:high",
		planner: "openai-codex/gpt-5.6-terra:medium",
		critic: "openai-codex/gpt-5.6-terra:high",
		architect: "openai-codex/gpt-5.6-sol:medium",
	}),
	profile("codex-medium", ["openai-codex"], {
		default: "openai-codex/gpt-5.6-sol:medium",
		executor: "openai-codex/gpt-5.6-terra:xhigh",
		planner: "openai-codex/gpt-5.6-terra:high",
		critic: "openai-codex/gpt-5.6-terra:xhigh",
		architect: "openai-codex/gpt-5.6-sol:high",
	}),
	profile("codex-pro", ["openai-codex"], {
		default: "openai-codex/gpt-5.6-sol:xhigh",
		executor: "openai-codex/gpt-5.6-terra:xhigh",
		planner: "openai-codex/gpt-5.6-sol:high",
		critic: "openai-codex/gpt-5.6-sol:xhigh",
		architect: "openai-codex/gpt-5.6-sol:max",
	}),
	profile("opencodego", ["opencode-go"], {
		default: "opencode-go/kimi-k2.6",
		executor: "opencode-go/deepseek-v4-flash",
		planner: "opencode-go/qwen3.7-max",
		critic: "opencode-go/mimo-v2.5-pro",
		architect: "opencode-go/deepseek-v4-pro",
	}),
	profile("claude-opus", ["anthropic"], {
		default: "anthropic/claude-opus-4-8:xhigh",
		executor: "anthropic/claude-sonnet-5",
		planner: "anthropic/claude-opus-4-8:low",
		critic: "anthropic/claude-opus-4-8:high",
		architect: "anthropic/claude-opus-4-8:xhigh",
	}),
	profile("claude-fable", ["anthropic"], {
		default: "anthropic/claude-fable-5:xhigh",
		executor: "anthropic/claude-sonnet-5",
		planner: "anthropic/claude-fable-5:low",
		critic: "anthropic/claude-fable-5:high",
		architect: "anthropic/claude-fable-5:xhigh",
	}),
	profile("glm-eco", ["zai"], {
		default: "zai/glm-5.2:low",
		executor: "zai/glm-5.2:minimal",
		planner: "zai/glm-5.2:low",
		critic: "zai/glm-5.2:medium",
		architect: "zai/glm-5.2:high",
	}),
	profile("glm-medium", ["zai"], {
		default: "zai/glm-5.2:medium",
		executor: "zai/glm-5.2:low",
		planner: "zai/glm-5.2:medium",
		critic: "zai/glm-5.2:high",
		architect: "zai/glm-5.2:xhigh",
	}),
	profile("glm-pro", ["zai"], {
		default: "zai/glm-5.2:xhigh",
		executor: "zai/glm-5.2:medium",
		planner: "zai/glm-5.2:high",
		critic: "zai/glm-5.2:xhigh",
		architect: "zai/glm-5.2:xhigh",
	}),
	profile("kimi-coding-plan-eco", ["kimi-code"], {
		default: "kimi-code/kimi-k2.7-code:low",
		executor: "kimi-code/kimi-k2.7-code:minimal",
		planner: "kimi-code/kimi-k2.7-code:low",
		critic: "kimi-code/kimi-k2.7-code:medium",
		architect: "kimi-code/kimi-k2.7-code:high",
	}),
	profile("kimi-coding-plan-medium", ["kimi-code"], {
		default: "kimi-code/kimi-k2.7-code:medium",
		executor: "kimi-code/kimi-k2.7-code:low",
		planner: "kimi-code/kimi-k2.7-code:medium",
		critic: "kimi-code/kimi-k2.7-code:high",
		architect: "kimi-code/kimi-k2.7-code:xhigh",
	}),
	profile("kimi-coding-plan-pro", ["kimi-code"], {
		default: "kimi-code/kimi-k2.7-code:xhigh",
		executor: "kimi-code/kimi-k2.7-code:medium",
		planner: "kimi-code/kimi-k2.7-code:high",
		critic: "kimi-code/kimi-k2.7-code:xhigh",
		architect: "kimi-code/kimi-k2.7-code:xhigh",
	}),
	profile("mimo-eco", ["xiaomi"], {
		default: "xiaomi/mimo-v2.5-pro:low",
		executor: "xiaomi/mimo-v2.5-pro:minimal",
		planner: "xiaomi/mimo-v2.5-pro:low",
		critic: "xiaomi/mimo-v2.5-pro:medium",
		architect: "xiaomi/mimo-v2.5-pro:high",
	}),
	profile(
		"mimo-medium",
		["xiaomi", "xiaomi-token-plan-sgp", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn"],
		{
			default: "xiaomi/mimo-v2.5-pro:medium",
			executor: "xiaomi/mimo-v2.5-pro:low",
			planner: "xiaomi/mimo-v2.5-pro:medium",
			critic: "xiaomi/mimo-v2.5-pro:high",
			architect: "xiaomi/mimo-v2.5-pro:xhigh",
		},
		[["xiaomi", "xiaomi-token-plan-sgp", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn"]],
	),
	profile(
		"mimo-pro",
		["xiaomi", "xiaomi-token-plan-sgp", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn"],
		{
			default: "xiaomi/mimo-v2.5-pro:xhigh",
			executor: "xiaomi/mimo-v2.5-pro:medium",
			planner: "xiaomi/mimo-v2.5-pro:high",
			critic: "xiaomi/mimo-v2.5-pro:xhigh",
			architect: "xiaomi/mimo-v2.5-pro:xhigh",
		},
		[["xiaomi", "xiaomi-token-plan-sgp", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn"]],
	),
	profile("grok-eco", ["xai"], {
		default: "xai/grok-4.3:low",
		executor: "xai/grok-4.3:minimal",
		planner: "xai/grok-4.3:low",
		critic: "xai/grok-4.3:medium",
		architect: "xai/grok-4.3:high",
	}),
	profile("grok-medium", ["xai"], {
		default: "xai/grok-4.3:medium",
		executor: "xai/grok-4.3:low",
		planner: "xai/grok-4.3:medium",
		critic: "xai/grok-4.3:high",
		architect: "xai/grok-4.3:xhigh",
	}),
	profile("grok-pro", ["xai"], {
		default: "xai/grok-4.3:xhigh",
		executor: "xai/grok-4.3:medium",
		planner: "xai/grok-4.3:high",
		critic: "xai/grok-4.3:xhigh",
		architect: "xai/grok-4.3:xhigh",
	}),
	profile("grok-build-pro", ["grok-build"], {
		default: "grok-build/grok-composer-2.5-fast",
		executor: "grok-build/grok-build",
		planner: "grok-build/grok-composer-2.5-fast",
		critic: "grok-build/grok-composer-2.5-fast",
		architect: "grok-build/grok-build",
	}),
	profile("cursor-eco", ["cursor"], {
		default: "cursor/composer-1.5:low",
		executor: "cursor/composer-1.5:minimal",
		planner: "cursor/composer-1.5:low",
		critic: "cursor/composer-1.5:medium",
		architect: "cursor/composer-1.5:high",
	}),
	profile("cursor-medium", ["cursor"], {
		default: "cursor/composer-1.5:medium",
		executor: "cursor/composer-1.5:low",
		planner: "cursor/composer-1.5:medium",
		critic: "cursor/composer-1.5:high",
		architect: "cursor/composer-1.5:xhigh",
	}),
	profile("cursor-pro", ["cursor"], {
		default: "cursor/composer-1.5:xhigh",
		executor: "cursor/composer-1.5:medium",
		planner: "cursor/composer-1.5:high",
		critic: "cursor/composer-1.5:xhigh",
		architect: "cursor/composer-1.5:xhigh",
	}),
	profile("minimax-eco", ["minimax-code"], {
		default: "minimax-code/minimax-m3:low",
		executor: "minimax-code/minimax-m3:minimal",
		planner: "minimax-code/minimax-m3:low",
		critic: "minimax-code/minimax-m3:medium",
		architect: "minimax-code/minimax-m3:high",
	}),
	profile("minimax-medium", ["minimax-code"], {
		default: "minimax-code/minimax-m3:medium",
		executor: "minimax-code/minimax-m3:low",
		planner: "minimax-code/minimax-m3:medium",
		critic: "minimax-code/minimax-m3:high",
		architect: "minimax-code/minimax-m3:xhigh",
	}),
	profile("minimax-pro", ["minimax-code"], {
		default: "minimax-code/minimax-m3:xhigh",
		executor: "minimax-code/minimax-m3:medium",
		planner: "minimax-code/minimax-m3:high",
		critic: "minimax-code/minimax-m3:xhigh",
		architect: "minimax-code/minimax-m3:xhigh",
	}),
	profile("opus-codex", ["anthropic", "openai-codex"], {
		default: "anthropic/claude-opus-4-8:xhigh",
		executor: "openai-codex/gpt-5.6-terra:xhigh",
		planner: "openai-codex/gpt-5.6-terra:high",
		critic: "openai-codex/gpt-5.6-terra:xhigh",
		architect: "openai-codex/gpt-5.6-sol:xhigh",
	}),
	profile("codex-opencodego", ["openai-codex", "opencode-go"], {
		default: "openai-codex/gpt-5.6-terra:xhigh",
		executor: "opencode-go/deepseek-v4-pro",
		planner: "opencode-go/kimi-k2.6",
		critic: "opencode-go/mimo-v2.5-pro",
		architect: "openai-codex/gpt-5.6-sol:xhigh",
	}),
	profile("fable-opus-codex", ["anthropic", "openai-codex"], {
		default: "anthropic/claude-fable-5:high",
		executor: "openai-codex/gpt-5.6-terra:xhigh",
		planner: "anthropic/claude-opus-4-8:medium",
		critic: "anthropic/claude-opus-4-8:high",
		architect: "openai-codex/gpt-5.6-sol:xhigh",
	}),
];

export interface ModelProfilePresentation {
	displayName: string;
	providerGroup: string;
}

function sanitizeModelProfileLabel(value: string): string {
	return sanitizeText(value).replace(/\s+/g, " ").trim();
}

const PROFILE_PRESENTATION: Record<string, ModelProfilePresentation> = {
	"codex-eco": { displayName: "Codex Eco", providerGroup: "CODEX" },
	"codex-medium": { displayName: "Codex Medium", providerGroup: "CODEX" },
	"codex-pro": { displayName: "Codex Pro", providerGroup: "CODEX" },
	opencodego: { displayName: "OpenCodeGo", providerGroup: "OPENCODEGO" },
	"claude-opus": { displayName: "Claude Opus", providerGroup: "CLAUDE" },
	"claude-fable": { displayName: "Claude Fable", providerGroup: "CLAUDE" },
	"glm-eco": { displayName: "GLM Eco", providerGroup: "GLM" },
	"glm-medium": { displayName: "GLM Medium", providerGroup: "GLM" },
	"glm-pro": { displayName: "GLM Pro", providerGroup: "GLM" },
	"kimi-coding-plan-eco": { displayName: "Kimi Coding Plan Eco", providerGroup: "KIMI CODING PLAN" },
	"kimi-coding-plan-medium": { displayName: "Kimi Coding Plan Medium", providerGroup: "KIMI CODING PLAN" },
	"kimi-coding-plan-pro": { displayName: "Kimi Coding Plan Pro", providerGroup: "KIMI CODING PLAN" },
	"mimo-eco": { displayName: "Mimo Eco", providerGroup: "MIMO" },
	"mimo-medium": { displayName: "Mimo Medium", providerGroup: "MIMO" },
	"mimo-pro": { displayName: "Mimo Pro", providerGroup: "MIMO" },
	"grok-eco": { displayName: "Grok Eco", providerGroup: "GROK" },
	"grok-medium": { displayName: "Grok Medium", providerGroup: "GROK" },
	"grok-pro": { displayName: "Grok Pro", providerGroup: "GROK" },
	"grok-build-pro": { displayName: "Grok Build Pro", providerGroup: "GROK" },
	"cursor-eco": { displayName: "Cursor Eco", providerGroup: "CURSOR" },
	"cursor-medium": { displayName: "Cursor Medium", providerGroup: "CURSOR" },
	"cursor-pro": { displayName: "Cursor Pro", providerGroup: "CURSOR" },
	"minimax-eco": { displayName: "MiniMax Eco", providerGroup: "MINIMAX" },
	"minimax-medium": { displayName: "MiniMax Medium", providerGroup: "MINIMAX" },
	"minimax-pro": { displayName: "MiniMax Pro", providerGroup: "MINIMAX" },
	"opus-codex": { displayName: "Opus + Codex", providerGroup: "COMBOS" },
	"codex-opencodego": { displayName: "Codex + OpenCodeGo", providerGroup: "COMBOS" },
	"fable-opus-codex": { displayName: "Fable + Opus + Codex", providerGroup: "COMBOS" },
};

const PROFILE_GROUP_ORDER = [
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
];

const PROFILE_RECOMMENDATIONS: Record<string, string> = {
	"openai-codex": "codex-medium",
	anthropic: "claude-opus",
	"opencode-go": "opencodego",
	zai: "glm-medium",
	"kimi-code": "kimi-coding-plan-medium",
	xiaomi: "mimo-medium",
	"xiaomi-token-plan-sgp": "mimo-medium",
	"xiaomi-token-plan-ams": "mimo-medium",
	"xiaomi-token-plan-cn": "mimo-medium",
	xai: "grok-medium",
	"grok-build": "grok-build-pro",
	cursor: "cursor-medium",
	"minimax-code": "minimax-medium",
};

export function getModelProfilePresentation(
	profile: string | Pick<ModelProfileDefinition, "name" | "displayName">,
): ModelProfilePresentation {
	const name = typeof profile === "string" ? profile : profile.name;
	const displayName = typeof profile === "string" ? undefined : profile.displayName;
	const presentation = PROFILE_PRESENTATION[name];
	if (presentation) return presentation;
	return { displayName: formatModelProfileDisplayLabel({ name, displayName }), providerGroup: "CUSTOM" };
}

export function formatModelProfileDisplayLabel(profile: Pick<ModelProfileDefinition, "name" | "displayName">): string {
	return (
		sanitizeModelProfileLabel(profile.displayName ?? profile.name) ||
		sanitizeModelProfileLabel(profile.name) ||
		"Unnamed profile"
	);
}

export function groupModelProfilesForPresetLanding(
	profiles: ReadonlyMap<string, ModelProfileDefinition>,
): Map<string, ModelProfileDefinition[]> {
	const groups = new Map<string, ModelProfileDefinition[]>();
	for (const group of PROFILE_GROUP_ORDER) groups.set(group, []);
	for (const profile of profiles.values()) {
		const group = getModelProfilePresentation(profile).providerGroup;
		if (!groups.has(group)) groups.set(group, []);
		groups.get(group)?.push(profile);
	}
	for (const [group, entries] of groups) {
		if (entries.length === 0) groups.delete(group);
		else entries.sort((a, b) => a.name.localeCompare(b.name));
	}
	return groups;
}

export function recommendModelProfileForProvider(
	providerId: string,
	profiles: ReadonlyMap<string, ModelProfileDefinition>,
): ModelProfileDefinition | undefined {
	const recommended = PROFILE_RECOMMENDATIONS[providerId];
	return recommended ? profiles.get(recommended) : undefined;
}

export function mergeModelProfiles(userProfiles?: ModelsConfig["profiles"]): Map<string, ModelProfileDefinition> {
	const profiles = new Map<string, ModelProfileDefinition>();
	for (const definition of BUILTIN_MODEL_PROFILES) {
		profiles.set(definition.name, {
			...definition,
			requiredProviders: [...definition.requiredProviders],
			modelMapping: { ...definition.modelMapping },
		});
	}
	for (const [name, definition] of Object.entries(userProfiles ?? {})) {
		const modelMapping = { ...definition.model_mapping };
		profiles.set(name, {
			name,
			displayName: definition.display_name,
			requiredProviders: aggregateModelProfileRequiredProviders(definition.required_providers, { modelMapping }),
			modelMapping,
			source: "user",
		});
	}
	return profiles;
}

export function resolveProfileBindings(definition: ModelProfileDefinition): ResolvedProfileBinding {
	const { default: defaultSelector, executor, architect, planner, critic } = definition.modelMapping;
	const modelRoles: ResolvedProfileBinding["modelRoles"] = {};
	const agentModelOverrides: ResolvedProfileBinding["agentModelOverrides"] = {};
	if (executor !== undefined) agentModelOverrides.executor = executor;
	if (architect !== undefined) agentModelOverrides.architect = architect;
	if (planner !== undefined) agentModelOverrides.planner = planner;
	if (critic !== undefined) agentModelOverrides.critic = critic;
	return { defaultSelector, modelRoles, agentModelOverrides };
}

export function formatAvailableProfileNames(profiles: ReadonlyMap<string, ModelProfileDefinition>): string {
	return [...profiles.keys()].sort((a, b) => a.localeCompare(b)).join(", ");
}
