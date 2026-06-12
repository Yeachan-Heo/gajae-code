import type { GjcModelAssignmentTargetId } from "./model-registry";
import type { ModelsConfig } from "./models-config-schema";

export type ModelProfileRole = GjcModelAssignmentTargetId;

export interface ModelProfileDefinition {
	name: string;
	requiredProviders: string[];
	modelMapping: Partial<Record<ModelProfileRole, string>>;
	source: "builtin" | "user";
}

export interface ResolvedProfileBinding {
	defaultSelector?: string;
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
	modelMapping: Record<ModelProfileRole, string>,
): ModelProfileDefinition => ({
	name,
	requiredProviders: aggregateModelProfileRequiredProviders(requiredProviders, { modelMapping }),
	modelMapping,
	source: "builtin",
});

export const BUILTIN_MODEL_PROFILES: readonly ModelProfileDefinition[] = [
	profile("opencode-go-eco", ["opencode-go"], {
		default: "opencode-go/deepseek-v4-flash",
		executor: "opencode-go/qwen3.5-plus",
		architect: "opencode-go/glm-5",
		planner: "opencode-go/minimax-m2.5",
		critic: "opencode-go/kimi-k2.5",
	}),
	profile("opencode-go-standard", ["opencode-go"], {
		default: "opencode-go/kimi-k2.6",
		executor: "opencode-go/qwen3.6-plus",
		architect: "opencode-go/glm-5.1",
		planner: "opencode-go/minimax-m2.7",
		critic: "opencode-go/deepseek-v4-pro",
	}),
	profile("opencode-go-pro", ["opencode-go"], {
		default: "opencode-go/qwen3.7-max",
		executor: "opencode-go/kimi-k2.6",
		architect: "opencode-go/deepseek-v4-pro:high",
		planner: "opencode-go/glm-5.1:high",
		critic: "opencode-go/minimax-m2.7:high",
	}),
	profile("codex-eco", ["openai-codex"], {
		default: "openai-codex/gpt-5.4-mini",
		executor: "openai-codex/gpt-5.4-nano",
		architect: "openai-codex/gpt-5.4-mini",
		planner: "openai-codex/gpt-5.4-mini",
		critic: "openai-codex/gpt-5.4-mini",
	}),
	profile("codex-standard", ["openai-codex"], {
		default: "openai-codex/gpt-5.5:medium",
		executor: "openai-codex/gpt-5.5:low",
		architect: "openai-codex/gpt-5.5:xhigh",
		planner: "openai-codex/gpt-5.5:medium",
		critic: "openai-codex/gpt-5.5:high",
	}),
	profile("codex-pro", ["openai-codex"], {
		default: "openai-codex/gpt-5.5:xhigh",
		executor: "openai-codex/gpt-5.5:high",
		architect: "openai-codex/gpt-5.5:xhigh",
		planner: "openai-codex/gpt-5.5:high",
		critic: "openai-codex/gpt-5.5:high",
	}),
	profile("opencode-go-codex-eco", ["opencode-go", "openai-codex"], {
		default: "opencode-go/deepseek-v4-flash",
		executor: "opencode-go/qwen3.5-plus",
		architect: "openai-codex/gpt-5.4-mini",
		planner: "openai-codex/gpt-5.4-mini",
		critic: "openai-codex/gpt-5.4-mini",
	}),
	profile("opencode-go-codex-standard", ["opencode-go", "openai-codex"], {
		default: "opencode-go/kimi-k2.6",
		executor: "opencode-go/qwen3.6-plus",
		architect: "openai-codex/gpt-5.4",
		planner: "openai-codex/gpt-5.4",
		critic: "openai-codex/gpt-5.4",
	}),
	profile("opencode-go-codex-pro", ["opencode-go", "openai-codex"], {
		default: "opencode-go/qwen3.7-max",
		executor: "opencode-go/kimi-k2.6",
		architect: "openai-codex/gpt-5.1-codex-max:high",
		planner: "openai-codex/gpt-5.5:high",
		critic: "openai-codex/gpt-5.3-codex-spark:high",
	}),
];

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
			requiredProviders: aggregateModelProfileRequiredProviders(definition.required_providers, { modelMapping }),
			modelMapping,
			source: "user",
		});
	}
	return profiles;
}

export function resolveProfileBindings(definition: ModelProfileDefinition): ResolvedProfileBinding {
	const { default: defaultSelector, executor, architect, planner, critic } = definition.modelMapping;
	const agentModelOverrides: ResolvedProfileBinding["agentModelOverrides"] = {};
	if (executor !== undefined) agentModelOverrides.executor = executor;
	if (architect !== undefined) agentModelOverrides.architect = architect;
	if (planner !== undefined) agentModelOverrides.planner = planner;
	if (critic !== undefined) agentModelOverrides.critic = critic;
	return { defaultSelector, agentModelOverrides };
}

export function formatAvailableProfileNames(profiles: ReadonlyMap<string, ModelProfileDefinition>): string {
	return [...profiles.keys()].sort((a, b) => a.localeCompare(b)).join(", ");
}
