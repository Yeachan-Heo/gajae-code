import { sanitizeText } from "@gajae-code/utils";
import { type ModelSelectorValue, normalizeModelSelectorValue } from "./model-selector-value";
import type { GJC_MODEL_ASSIGNMENT_TARGET_IDS, ModelsConfig } from "./models-config-schema";

export type ModelProfileRole = (typeof GJC_MODEL_ASSIGNMENT_TARGET_IDS)[number];

export interface ModelProfileDefinition {
	name: string;
	requiredProviders: string[];
	displayName?: string;
	providerGroup?: string;
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
	modelMapping: Partial<Record<ModelProfileRole, ModelSelectorValue>>;
	source: "builtin" | "registry" | "user";
}

export interface ResolvedProfileBinding {
	defaultSelector?: ModelSelectorValue;
	modelRoles: Record<string, ModelSelectorValue>;
	agentModelOverrides: Partial<Record<Exclude<ModelProfileRole, "default">, ModelSelectorValue>>;
}

function parseModelSelectorProvider(selector: string): string | undefined {
	const slashIdx = selector.indexOf("/");
	if (slashIdx <= 0) return undefined;
	return selector.slice(0, slashIdx);
}

export function deriveModelProfileMappedProviders(definition: Pick<ModelProfileDefinition, "modelMapping">): string[] {
	const providers = new Set<string>();
	for (const selectorValue of Object.values(definition.modelMapping)) {
		for (const selector of normalizeModelSelectorValue(selectorValue)) {
			const provider = parseModelSelectorProvider(selector);
			if (provider) providers.add(provider);
		}
	}
	return [...providers].sort((a, b) => a.localeCompare(b));
}

/**
 * Return the providers explicitly declared as hard prerequisites.
 * Model mappings may reference fallback providers, but those references are
 * resolution-time candidates rather than activation requirements.
 */
export function aggregateModelProfileRequiredProviders(
	requiredProviders: readonly string[],
	_definition: Pick<ModelProfileDefinition, "modelMapping">,
): string[] {
	return [...new Set(requiredProviders)];
}

const profile = (
	name: string,
	requiredProviders: string[],
	modelMapping: Partial<Record<ModelProfileRole, ModelSelectorValue>>,
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
		default: "openai-codex/gpt-5.6-terra:low",
		executor: "openai-codex/gpt-5.6-luna:low",
		planner: "openai-codex/gpt-5.6-luna:high",
		critic: "openai-codex/gpt-5.6-terra:xhigh",
		architect: "openai-codex/gpt-5.6-terra:high",
	}),
	profile("codex-medium", ["openai-codex"], {
		default: "openai-codex/gpt-5.6-sol:low",
		executor: "openai-codex/gpt-5.6-terra:low",
		planner: "openai-codex/gpt-5.6-terra:high",
		critic: "openai-codex/gpt-5.6-sol:xhigh",
		architect: "openai-codex/gpt-5.6-sol:high",
	}),
	profile("codex-pro", ["openai-codex"], {
		default: "openai-codex/gpt-5.6-sol:medium",
		executor: "openai-codex/gpt-5.6-terra:medium",
		planner: "openai-codex/gpt-5.6-sol:high",
		critic: "openai-codex/gpt-5.6-sol:max",
		architect: "openai-codex/gpt-5.6-sol:xhigh",
	}),
	profile("lunamaxxing", ["openai-codex"], {
		default: "openai-codex/gpt-5.6-luna:medium",
		executor: "openai-codex/gpt-5.6-luna:xhigh",
		planner: "openai-codex/gpt-5.6-luna:max",
		critic: "openai-codex/gpt-5.6-luna:max",
		architect: "openai-codex/gpt-5.6-luna:max",
	}),
	profile("astra-lite", ["openai-codex"], {
		default: "openai-codex/gpt-6-astra:medium",
		executor: "openai-codex/gpt-5.6-luna:xhigh",
		planner: "openai-codex/gpt-6-astra:xhigh",
		critic: "openai-codex/gpt-5.6-sol:high",
		architect: "openai-codex/gpt-5.6-terra:xhigh",
	}),
	profile("astra-default", ["openai-codex"], {
		default: "openai-codex/gpt-6-astra:medium",
		executor: "openai-codex/gpt-5.6-luna:max",
		planner: "openai-codex/gpt-6-astra:xhigh",
		critic: "openai-codex/gpt-5.6-sol:xhigh",
		architect: "openai-codex/gpt-5.6-terra:xhigh",
	}),
	profile("astra-heavy", ["openai-codex"], {
		default: "openai-codex/gpt-6-astra:medium",
		executor: "openai-codex/gpt-5.6-sol:max",
		planner: "openai-codex/gpt-5.6-sol:max",
		critic: "openai-codex/gpt-6-astra:max",
		architect: "openai-codex/gpt-6-astra:max",
	}),
	profile("macos-omlx-fast", ["omlx"], {
		default: "omlx/Qwen3.6-35B-A3B-4bit:low",
		executor: "omlx/Qwen3.6-35B-A3B-4bit:low",
		architect: "omlx/Qwen3.6-35B-A3B-4bit:high",
		planner: "omlx/Qwen3.6-35B-A3B-4bit:medium",
		critic: "omlx/Qwen3.6-35B-A3B-4bit:high",
	}),
	profile("macos-omlx-balanced", ["omlx"], {
		default: "omlx/Qwen3.6-35B-A3B-8bit:low",
		executor: "omlx/Qwen3.6-35B-A3B-8bit:low",
		architect: "omlx/Qwen3.6-35B-A3B-8bit:high",
		planner: "omlx/Qwen3.6-35B-A3B-8bit:medium",
		critic: "omlx/Qwen3.6-35B-A3B-8bit:high",
	}),
	profile("macos-omlx-quality", ["omlx"], {
		default: "omlx/Qwen3.6-35B-A3B-8bit:low",
		executor: "omlx/Qwen3.6-35B-A3B-8bit:low",
		architect: "omlx/Qwen3.6-35B-A3B-8bit:high",
		planner: "omlx/Qwen3.6-35B-A3B-8bit:medium",
		critic: "omlx/Qwen3.8-27B-8bit:high",
	}),
	profile("macos-omlx-abliterated-fast", ["omlx"], {
		default: "omlx/Qwen3.8-27B-Uncensored-MLX-4bit:low",
		executor: "omlx/Qwen3.8-27B-Uncensored-MLX-4bit:low",
		architect: "omlx/Qwen3.8-27B-Uncensored-MLX-4bit:high",
		planner: "omlx/Qwen3.8-27B-Uncensored-MLX-4bit:medium",
		critic: "omlx/Qwen3.8-27B-Uncensored-MLX-4bit:high",
	}),
	profile("macos-omlx-abliterated-balanced", ["omlx"], {
		default: "omlx/Qwen3.8-27B-Uncensored-MLX-4bit:low",
		executor: "omlx/Qwen3.8-27B-Uncensored-MLX-4bit:low",
		architect: "omlx/Qwen3.8-27B-Uncensored-MLX-4bit:high",
		planner: "omlx/Qwen3.8-27B-Uncensored-MLX-4bit:medium",
		critic: "omlx/Qwen3.8-27B-Uncensored-MLX-4bit:high",
	}),
	profile("opencodego", ["opencode-go"], {
		default: "opencode-go/kimi-k3",
		executor: "opencode-go/deepseek-v4-flash",
		planner: "opencode-go/kimi-k3",
		critic: "opencode-go/mimo-v2.5-pro",
		architect: "opencode-go/deepseek-v4-pro",
	}),
	profile("commandcode-goat", ["commandcode-goat"], {
		default: "commandcode-goat/zai-org/GLM-5.3",
		executor: "commandcode-goat/deepseek/deepseek-v4-flash",
		planner: "commandcode-goat/moonshotai/Kimi-K3",
		critic: "commandcode-goat/zai-org/GLM-5.2",
		architect: "commandcode-goat/deepseek/deepseek-v4-pro",
	}),
	profile("open-weights-glm", [], {
		default: "glm-5.2:medium",
		executor: "glm-5.2:low",
		planner: "glm-5.2:high",
		critic: "glm-5.2:high",
		architect: "glm-5.2:xhigh",
	}),
	profile("open-weights-deepseek", [], {
		default: "deepseek-v4-flash:high",
		executor: "deepseek-v4-flash:medium",
		planner: "deepseek-v4-flash:high",
		critic: "deepseek-v4-flash:xhigh",
		architect: "deepseek-v4-flash:xhigh",
	}),
	profile("open-weights-kimi", [], {
		default: "kimi-k3:high",
		executor: "kimi-k3:high",
		planner: "kimi-k3:xhigh",
		critic: "kimi-k3:high",
		architect: "kimi-k3:xhigh",
	}),
	profile("open-weights-luna", [], {
		default: "gpt-5.6-luna:high",
		executor: "gpt-5.6-luna:high",
		planner: "gpt-5.6-luna:xhigh",
		critic: "gpt-5.6-luna:xhigh",
		architect: "gpt-5.6-luna:xhigh",
	}),
	profile("open-weights-spark", [], {
		default: "muse-spark-1.2:medium",
		executor: "muse-spark-1.2:low",
		planner: "muse-spark-1.2:high",
		critic: "muse-spark-1.2:high",
		architect: "muse-spark-1.2:xhigh",
	}),
	profile("open-weights-spark-deepseek", [], {
		default: "muse-spark-1.2:medium",
		executor: "deepseek-v4-flash:high",
		planner: "muse-spark-1.2:high",
		critic: "muse-spark-1.2:high",
		architect: "muse-spark-1.2:xhigh",
	}),
	profile("open-weights-spark-luna", [], {
		default: "muse-spark-1.2:medium",
		executor: "gpt-5.6-luna:high",
		planner: "muse-spark-1.2:high",
		critic: "muse-spark-1.2:high",
		architect: "muse-spark-1.2:xhigh",
	}),
	profile("open-weights-glm-deepseek", [], {
		default: "glm-5.2:medium",
		executor: "deepseek-v4-flash:high",
		planner: "glm-5.2:high",
		critic: "deepseek-v4-flash:xhigh",
		architect: "glm-5.2:xhigh",
	}),
	profile("open-weights-kimi-deepseek", [], {
		default: "kimi-k3:high",
		executor: "deepseek-v4-flash:high",
		planner: "kimi-k3:xhigh",
		critic: "deepseek-v4-flash:xhigh",
		architect: "kimi-k3:xhigh",
	}),
	profile("open-weights-kimi-glm", [], {
		default: "glm-5.2:high",
		executor: "glm-5.2:high",
		planner: "kimi-k3:high",
		critic: "glm-5.2:xhigh",
		architect: "kimi-k3:xhigh",
	}),
	profile("open-weights-kimi-glm-deepseek", [], {
		default: "glm-5.2:medium",
		executor: "deepseek-v4-flash:high",
		planner: "kimi-k3:high",
		critic: "glm-5.2:high",
		architect: "kimi-k3:xhigh",
	}),
	profile("open-weights-all", [], {
		default: "gpt-5.6-luna:high",
		executor: "deepseek-v4-flash:high",
		planner: "kimi-k3:high",
		critic: "glm-5.2:high",
		architect: "gpt-5.6-luna:xhigh",
	}),
	profile("claude-opus", ["anthropic"], {
		default: ["anthropic/claude-opus-5:xhigh", "anthropic/claude-opus-4-6:xhigh"],
		executor: "anthropic/claude-sonnet-5",
		planner: ["anthropic/claude-opus-5:low", "anthropic/claude-opus-4-6:low"],
		critic: ["anthropic/claude-opus-5:high", "anthropic/claude-opus-4-6:high"],
		architect: ["anthropic/claude-opus-5:xhigh", "anthropic/claude-opus-4-6:xhigh"],
	}),
	profile("claude-fable", ["anthropic"], {
		default: "anthropic/claude-fable-5-1:xhigh",
		executor: "anthropic/claude-sonnet-5",
		planner: "anthropic/claude-fable-5-1:low",
		critic: "anthropic/claude-fable-5-1:high",
		architect: "anthropic/claude-fable-5-1:xhigh",
	}),
	profile("glm-eco", ["zai"], {
		default: "zai/glm-5.3-flash:low",
		executor: "zai/glm-5.3-flash:low",
		planner: "zai/glm-5.3-flash:low",
		critic: "zai/glm-5.3:high",
		architect: "zai/glm-5.3:high",
	}),
	profile("glm-medium", ["zai"], {
		default: "zai/glm-5.3:high",
		executor: "zai/glm-5.3-flash:low",
		planner: "zai/glm-5.3:high",
		critic: "zai/glm-5.3:high",
		architect: "zai/glm-5.3:max",
	}),
	profile("glm-pro", ["zai"], {
		default: "zai/glm-5.3:max",
		executor: "zai/glm-5.3-flash:high",
		planner: "zai/glm-5.3:high",
		critic: "zai/glm-5.3:max",
		architect: "zai/glm-5.3:max",
	}),
	profile("kimi-coding-plan-eco", ["kimi-code"], {
		default: "kimi-code/k3:low",
		executor: "kimi-code/k3:low",
		planner: "kimi-code/k3:low",
		critic: "kimi-code/k3:high",
		architect: "kimi-code/k3:high",
	}),
	profile("kimi-coding-plan-medium", ["kimi-code"], {
		default: "kimi-code/k3:high",
		executor: "kimi-code/k3:low",
		planner: "kimi-code/k3:high",
		critic: "kimi-code/k3:high",
		architect: "kimi-code/k3:max",
	}),
	profile("kimi-coding-plan-pro", ["kimi-code"], {
		default: "kimi-code/k3:max",
		executor: "kimi-code/k3:high",
		planner: "kimi-code/k3:high",
		critic: "kimi-code/k3:max",
		architect: "kimi-code/k3:max",
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
	profile("grok-45-eco", ["xai"], {
		default: "xai/grok-4.5:low",
		executor: "xai/grok-4.5:low",
		planner: "xai/grok-4.5:low",
		critic: "xai/grok-4.5:medium",
		architect: "xai/grok-4.5:high",
	}),
	profile("grok-45-medium", ["xai"], {
		default: "xai/grok-4.5:medium",
		executor: "xai/grok-4.5:low",
		planner: "xai/grok-4.5:medium",
		critic: "xai/grok-4.5:high",
		architect: "xai/grok-4.5:high",
	}),
	profile("grok-45-pro", ["xai"], {
		default: "xai/grok-4.5:high",
		executor: "xai/grok-4.5:medium",
		planner: "xai/grok-4.5:high",
		critic: "xai/grok-4.5:high",
		architect: "xai/grok-4.5:high",
	}),
	profile("grok-46-eco", ["xai"], {
		default: "xai/grok-4.6:low",
		executor: "xai/grok-4.6:low",
		planner: "xai/grok-4.6:low",
		critic: "xai/grok-4.6:medium",
		architect: "xai/grok-4.6:high",
	}),
	profile("grok-46-medium", ["xai"], {
		default: "xai/grok-4.6:medium",
		executor: "xai/grok-4.6:low",
		planner: "xai/grok-4.6:medium",
		critic: "xai/grok-4.6:high",
		architect: "xai/grok-4.6:high",
	}),
	profile("grok-46-pro", ["xai"], {
		default: "xai/grok-4.6:xhigh",
		executor: "xai/grok-4.6:medium",
		planner: "xai/grok-4.6:high",
		critic: "xai/grok-4.6:xhigh",
		architect: "xai/grok-4.6:xhigh",
	}),
	profile("grok-build-pro", ["grok-build"], {
		default: "grok-build/grok-composer-2.5-fast",
		executor: "grok-build/grok-build",
		planner: "grok-build/grok-composer-2.5-fast",
		critic: "grok-build/grok-composer-2.5-fast",
		architect: "grok-build/grok-build",
	}),
	profile("cursor-eco", ["cursor"], {
		default: "cursor/composer-2.5",
		executor: "cursor/composer-2.5",
		planner: "cursor/composer-2.5",
		critic: "cursor/composer-2.5",
		architect: "cursor/composer-2.5",
	}),
	profile("cursor-medium", ["cursor"], {
		default: "cursor/composer-2.5",
		executor: "cursor/composer-2.5-fast",
		planner: "cursor/composer-2.5",
		critic: "cursor/composer-2.5-fast",
		architect: "cursor/composer-2.5-fast",
	}),
	profile("cursor-pro", ["cursor"], {
		default: "cursor/composer-2.5-fast",
		executor: "cursor/composer-2.5-fast",
		planner: "cursor/composer-2.5-fast",
		critic: "cursor/composer-2.5-fast",
		architect: "cursor/composer-2.5-fast",
	}),
	profile("minimax-eco", ["minimax-code"], {
		default: "minimax-code/MiniMax-M3:low",
		executor: "minimax-code/MiniMax-M3:minimal",
		planner: "minimax-code/MiniMax-M3:low",
		critic: "minimax-code/MiniMax-M3:medium",
		architect: "minimax-code/MiniMax-M3:high",
	}),
	profile("minimax-medium", ["minimax-code"], {
		default: "minimax-code/MiniMax-M3:medium",
		executor: "minimax-code/MiniMax-M3:low",
		planner: "minimax-code/MiniMax-M3:medium",
		critic: "minimax-code/MiniMax-M3:high",
		architect: "minimax-code/MiniMax-M3:xhigh",
	}),
	profile("minimax-pro", ["minimax-code"], {
		default: "minimax-code/MiniMax-M3:xhigh",
		executor: "minimax-code/MiniMax-M3:medium",
		planner: "minimax-code/MiniMax-M3:high",
		critic: "minimax-code/MiniMax-M3:xhigh",
		architect: "minimax-code/MiniMax-M3:xhigh",
	}),
	profile("alibaba-token-plan-balanced", ["alibaba-token-plan"], {
		default: "alibaba-token-plan/qwen3.8-max-preview:medium",
		executor: "alibaba-token-plan/deepseek-v4-pro:xhigh",
		planner: "alibaba-token-plan/glm-5.2:high",
		architect: "alibaba-token-plan/qwen3.8-max-preview:xhigh",
		critic: "alibaba-token-plan/glm-5.2:high",
	}),
	profile("alibaba-token-plan-pro", ["alibaba-token-plan"], {
		default: "alibaba-token-plan/qwen3.8-max-preview:medium",
		executor: "alibaba-token-plan/deepseek-v4-flash-0731:max",
		planner: "alibaba-token-plan/glm-5.2:high",
		architect: "alibaba-token-plan/qwen3.8-max-preview:xhigh",
		critic: "alibaba-token-plan/glm-5.2:xhigh",
	}),
	profile("alibaba-token-plan-qwenmaxxing", ["alibaba-token-plan"], {
		default: "alibaba-token-plan/qwen3.8-max-preview:medium",
		executor: "alibaba-token-plan/qwen3.8-max-preview:low",
		planner: "alibaba-token-plan/qwen3.8-max-preview:medium",
		architect: "alibaba-token-plan/qwen3.8-max-preview:xhigh",
		critic: "alibaba-token-plan/qwen3.8-max-preview:xhigh",
	}),
	profile("alibaba-token-plan-qwen-deepseek", ["alibaba-token-plan"], {
		default: "alibaba-token-plan/qwen3.8-max:high",
		executor: "alibaba-token-plan/deepseek-v4-flash-0731:high",
		planner: "alibaba-token-plan/deepseek-v4-flash-0731:max",
		architect: "alibaba-token-plan/qwen3.8-max:xhigh",
		critic: "alibaba-token-plan/qwen3.8-max:xhigh",
	}),
	profile("alibaba-token-plan-glm-deepseek", ["alibaba-token-plan"], {
		default: "alibaba-token-plan/glm-5.2:high",
		executor: "alibaba-token-plan/deepseek-v4-flash-0731:high",
		planner: "alibaba-token-plan/deepseek-v4-flash-0731:max",
		architect: "alibaba-token-plan/glm-5.2:xhigh",
		critic: "alibaba-token-plan/glm-5.2:xhigh",
	}),
	profile("opus-codex", ["anthropic", "openai-codex"], {
		default: "anthropic/claude-opus-5:xhigh",
		executor: "openai-codex/gpt-5.6-terra:low",
		planner: "anthropic/claude-sonnet-5",
		critic: "openai-codex/gpt-5.6-sol:xhigh",
		architect: "openai-codex/gpt-5.6-sol:high",
	}),
	profile("codex-opencodego", ["openai-codex", "opencode-go"], {
		default: "openai-codex/gpt-5.6-sol:low",
		executor: "opencode-go/deepseek-v4-pro",
		planner: "opencode-go/kimi-k3",
		critic: "opencode-go/mimo-v2.5-pro",
		architect: "openai-codex/gpt-5.6-sol:high",
	}),
	profile("fable-opus-codex", ["anthropic", "openai-codex"], {
		default: "anthropic/claude-fable-5-1:high",
		executor: "openai-codex/gpt-5.6-terra:medium",
		planner: "anthropic/claude-opus-5:medium",
		critic: "anthropic/claude-opus-5:high",
		architect: "openai-codex/gpt-5.6-sol:xhigh",
	}),
	profile("astra-fable", ["openai-codex", "anthropic"], {
		default: "openai-codex/gpt-6-astra:medium",
		executor: "openai-codex/gpt-5.6-luna:max",
		planner: "openai-codex/gpt-6-astra:xhigh",
		critic: "anthropic/claude-fable-5-1:xhigh",
		architect: "anthropic/claude-fable-5-1:xhigh",
	}),
	profile("astra-fable-opus", ["openai-codex", "anthropic"], {
		default: "openai-codex/gpt-6-astra:medium",
		executor: "openai-codex/gpt-5.6-luna:max",
		planner: "anthropic/claude-opus-5:medium",
		critic: "anthropic/claude-fable-5-1:xhigh",
		architect: "anthropic/claude-fable-5-1:xhigh",
	}),
];

/**
 * Providers that built-in model presets pin via qualified `<provider>/<model>`
 * selectors. When `modelProfile.proxyProvider` is set, selectors for these
 * providers are rewritten to `<proxy>/<model>` at activation time when their
 * direct provider is unauthenticated, or unconditionally when
 * `modelProfile.proxyMode` is `always`. Bare-alias (open-weights) profiles are
 * not included: they already resolve through any authenticated provider,
 * including a configured proxy.
 */
export const PROXY_ROUTABLE_PROVIDER_IDS: ReadonlySet<string> = new Set(
	BUILTIN_MODEL_PROFILES.flatMap(definition => [
		...definition.requiredProviders,
		...deriveModelProfileMappedProviders(definition),
		...(definition.alternativeProviderGroups ?? []).flat(),
	]),
);

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
	lunamaxxing: { displayName: "LunaMaxxing", providerGroup: "CODEX" },
	"astra-lite": { displayName: "ASTRA-Lite", providerGroup: "CODEX" },
	"astra-default": { displayName: "ASTRA-Default", providerGroup: "CODEX" },
	"astra-heavy": { displayName: "ASTRA-Heavy", providerGroup: "CODEX" },
	opencodego: { displayName: "OpenCodeGo", providerGroup: "OPENCODEGO" },
	"commandcode-goat": { displayName: "Command Code GOAT", providerGroup: "COMMAND CODE GOAT" },
	"open-weights-glm": { displayName: "GLM", providerGroup: "OPEN WEIGHT MODELS (PROVIDER AGNOSTIC)" },
	"open-weights-deepseek": {
		displayName: "DeepSeek",
		providerGroup: "OPEN WEIGHT MODELS (PROVIDER AGNOSTIC)",
	},
	"open-weights-kimi": { displayName: "Kimi", providerGroup: "OPEN WEIGHT MODELS (PROVIDER AGNOSTIC)" },
	"open-weights-luna": { displayName: "Luna", providerGroup: "OPEN WEIGHT MODELS (PROVIDER AGNOSTIC)" },
	"open-weights-spark": { displayName: "Muse Spark", providerGroup: "OPEN WEIGHT MODELS (PROVIDER AGNOSTIC)" },
	"open-weights-spark-deepseek": {
		displayName: "Muse Spark + DeepSeek",
		providerGroup: "OPEN WEIGHT MODELS (PROVIDER AGNOSTIC)",
	},
	"open-weights-spark-luna": {
		displayName: "Muse Spark + Luna",
		providerGroup: "OPEN WEIGHT MODELS (PROVIDER AGNOSTIC)",
	},
	"open-weights-glm-deepseek": {
		displayName: "GLM + DeepSeek",
		providerGroup: "OPEN WEIGHT MODELS (PROVIDER AGNOSTIC)",
	},
	"open-weights-kimi-deepseek": {
		displayName: "Kimi + DeepSeek",
		providerGroup: "OPEN WEIGHT MODELS (PROVIDER AGNOSTIC)",
	},
	"open-weights-kimi-glm": {
		displayName: "Kimi + GLM",
		providerGroup: "OPEN WEIGHT MODELS (PROVIDER AGNOSTIC)",
	},
	"open-weights-kimi-glm-deepseek": {
		displayName: "Kimi + GLM + DeepSeek",
		providerGroup: "OPEN WEIGHT MODELS (PROVIDER AGNOSTIC)",
	},
	"open-weights-all": {
		displayName: "Kimi + GLM + DeepSeek + Luna",
		providerGroup: "OPEN WEIGHT MODELS (PROVIDER AGNOSTIC)",
	},
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
	"grok-45-eco": { displayName: "Grok 4.5 Eco", providerGroup: "GROK" },
	"grok-45-medium": { displayName: "Grok 4.5 Medium", providerGroup: "GROK" },
	"grok-45-pro": { displayName: "Grok 4.5 Pro", providerGroup: "GROK" },
	"grok-46-eco": { displayName: "Grok 4.6 Eco", providerGroup: "GROK" },
	"grok-46-medium": { displayName: "Grok 4.6 Medium", providerGroup: "GROK" },
	"grok-46-pro": { displayName: "Grok 4.6 Pro", providerGroup: "GROK" },
	"grok-build-pro": { displayName: "Grok Build Pro", providerGroup: "GROK" },
	"cursor-eco": { displayName: "Cursor Eco", providerGroup: "CURSOR" },
	"cursor-medium": { displayName: "Cursor Medium", providerGroup: "CURSOR" },
	"cursor-pro": { displayName: "Cursor Pro", providerGroup: "CURSOR" },
	"minimax-eco": { displayName: "MiniMax Eco", providerGroup: "MINIMAX" },
	"minimax-medium": { displayName: "MiniMax Medium", providerGroup: "MINIMAX" },
	"minimax-pro": { displayName: "MiniMax Pro", providerGroup: "MINIMAX" },
	"alibaba-token-plan-balanced": { displayName: "Balanced", providerGroup: "ALIBABA TOKEN PLAN" },
	"alibaba-token-plan-pro": { displayName: "Pro", providerGroup: "ALIBABA TOKEN PLAN" },
	"alibaba-token-plan-qwenmaxxing": { displayName: "QwenMaxxing", providerGroup: "ALIBABA TOKEN PLAN" },
	"alibaba-token-plan-qwen-deepseek": { displayName: "Qwen + DeepSeek", providerGroup: "ALIBABA TOKEN PLAN" },
	"alibaba-token-plan-glm-deepseek": { displayName: "GLM + DeepSeek", providerGroup: "ALIBABA TOKEN PLAN" },
	"opus-codex": { displayName: "Opus + Codex", providerGroup: "COMBOS" },
	"codex-opencodego": { displayName: "Codex + OpenCodeGo", providerGroup: "COMBOS" },
	"fable-opus-codex": { displayName: "Fable + Opus + Codex", providerGroup: "COMBOS" },
	"astra-fable": { displayName: "ASTRA + Fable (5.1)", providerGroup: "COMBOS" },
	"astra-fable-opus": { displayName: "ASTRA + Fable (5.1) + Opus", providerGroup: "COMBOS" },
	"macos-omlx-fast": { displayName: "4-bit Fast (MoE measured 93.5 tok/s)", providerGroup: "macOS Local (oMLX)" },
	"macos-omlx-balanced": {
		displayName: "8-bit Balanced (MoE measured 71.1 tok/s)",
		providerGroup: "macOS Local (oMLX)",
	},
	"macos-omlx-quality": {
		displayName: "Quality mix (8-bit MoE + 8-bit dense critic)",
		providerGroup: "macOS Local (oMLX)",
	},
	"macos-omlx-abliterated-fast": {
		displayName: "Uncensored 4-bit Fast (measured 19.8 tok/s)",
		providerGroup: "macOS Local (oMLX)",
	},
	"macos-omlx-abliterated-balanced": {
		displayName: "Uncensored 4-bit Balanced (same winner as fast)",
		providerGroup: "macOS Local (oMLX)",
	},
};

const PROFILE_GROUP_ORDER = [
	"CODEX",
	"OPENCODEGO",
	"COMMAND CODE GOAT",
	"macOS Local (oMLX)",
	"OPEN WEIGHT MODELS (PROVIDER AGNOSTIC)",
	"CLAUDE",
	"GLM",
	"KIMI CODING PLAN",
	"MIMO",
	"GROK",
	"CURSOR",
	"MINIMAX",
	"ALIBABA TOKEN PLAN",
	"COMBOS",
];

const OPEN_WEIGHT_PROFILE_ORDER = [
	"open-weights-glm",
	"open-weights-deepseek",
	"open-weights-kimi",
	"open-weights-luna",
	"open-weights-spark",
	"open-weights-spark-deepseek",
	"open-weights-spark-luna",
	"open-weights-glm-deepseek",
	"open-weights-kimi-deepseek",
	"open-weights-kimi-glm",
	"open-weights-kimi-glm-deepseek",
	"open-weights-all",
] as const;
const OPEN_WEIGHT_PROFILE_RANK = new Map<string, number>(OPEN_WEIGHT_PROFILE_ORDER.map((name, index) => [name, index]));
const MACOS_OMLX_PROFILE_ORDER = [
	"macos-omlx-fast",
	"macos-omlx-balanced",
	"macos-omlx-quality",
	"macos-omlx-abliterated-fast",
	"macos-omlx-abliterated-balanced",
] as const;
const MACOS_OMLX_PROFILE_RANK = new Map<string, number>(MACOS_OMLX_PROFILE_ORDER.map((name, index) => [name, index]));

const PROFILE_RECOMMENDATIONS: Record<string, string> = {
	"openai-codex": "codex-medium",
	anthropic: "claude-opus",
	"opencode-go": "opencodego",
	"commandcode-goat": "commandcode-goat",
	zai: "glm-medium",
	"kimi-code": "kimi-coding-plan-medium",
	xiaomi: "mimo-medium",
	"xiaomi-token-plan-sgp": "mimo-medium",
	"xiaomi-token-plan-ams": "mimo-medium",
	"xiaomi-token-plan-cn": "mimo-medium",
	xai: "grok-46-medium",
	"grok-build": "grok-build-pro",
	cursor: "cursor-medium",
	omlx: "macos-omlx-balanced",
	"minimax-code": "minimax-medium",
	"alibaba-token-plan": "alibaba-token-plan-balanced",
};

export function getModelProfilePresentation(
	profile: string | Pick<ModelProfileDefinition, "name" | "displayName" | "providerGroup">,
): ModelProfilePresentation {
	const name = typeof profile === "string" ? profile : profile.name;
	const displayName = typeof profile === "string" ? undefined : profile.displayName;
	const presentation = PROFILE_PRESENTATION[name];
	if (presentation) return presentation;
	if (typeof profile !== "string" && profile.providerGroup)
		return { displayName: formatModelProfileDisplayLabel(profile), providerGroup: profile.providerGroup };
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
		if (entries.length === 0) {
			groups.delete(group);
			continue;
		}
		if (group === "OPEN WEIGHT MODELS (PROVIDER AGNOSTIC)") {
			entries.sort(
				(a, b) =>
					(OPEN_WEIGHT_PROFILE_RANK.get(a.name) ?? Number.MAX_SAFE_INTEGER) -
					(OPEN_WEIGHT_PROFILE_RANK.get(b.name) ?? Number.MAX_SAFE_INTEGER),
			);
		} else if (group === "macOS Local (oMLX)") {
			entries.sort(
				(a, b) =>
					(MACOS_OMLX_PROFILE_RANK.get(a.name) ?? Number.MAX_SAFE_INTEGER) -
					(MACOS_OMLX_PROFILE_RANK.get(b.name) ?? Number.MAX_SAFE_INTEGER),
			);
		} else {
			entries.sort((a, b) => a.name.localeCompare(b.name));
		}
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

export type RegistryModelProfilesInput =
	| ReadonlyMap<string, ModelProfileDefinition>
	| readonly ModelProfileDefinition[]
	| Readonly<Record<string, ModelProfileDefinition>>;

function cloneModelSelectorValue(value: ModelSelectorValue): ModelSelectorValue {
	return Array.isArray(value) ? [...value] : value;
}

function cloneModelProfileDefinition(
	definition: ModelProfileDefinition,
	source: ModelProfileDefinition["source"] = definition.source,
): ModelProfileDefinition {
	return {
		name: definition.name,
		displayName: definition.displayName,
		providerGroup: definition.providerGroup,
		requiredProviders: [...definition.requiredProviders],
		alternativeProviderGroups: definition.alternativeProviderGroups?.map(group => [...group]),
		modelMapping: Object.fromEntries(
			Object.entries(definition.modelMapping).map(([role, value]) => [role, cloneModelSelectorValue(value)]),
		) as Partial<Record<ModelProfileRole, ModelSelectorValue>>,
		source,
	};
}

function registryProfileEntries(
	input: RegistryModelProfilesInput | undefined,
): Array<[string, ModelProfileDefinition]> {
	if (!input) return [];
	if (input instanceof Map) return [...input.entries()];
	if (Array.isArray(input)) return input.map(definition => [definition.name, definition]);
	return Object.entries(input);
}

export function mergeModelProfiles(
	userProfiles?: ModelsConfig["profiles"],
	registryProfiles?: RegistryModelProfilesInput,
): Map<string, ModelProfileDefinition> {
	const profiles = new Map<string, ModelProfileDefinition>();
	for (const definition of BUILTIN_MODEL_PROFILES) {
		profiles.set(definition.name, cloneModelProfileDefinition(definition, "builtin"));
	}
	for (const [name, definition] of registryProfileEntries(registryProfiles)) {
		profiles.set(name, cloneModelProfileDefinition({ ...definition, name }, "registry"));
	}
	for (const [name, definition] of Object.entries(userProfiles ?? {})) {
		const modelMapping = Object.fromEntries(
			Object.entries(definition.model_mapping).map(([role, value]) => [role, cloneModelSelectorValue(value)]),
		) as Partial<Record<ModelProfileRole, ModelSelectorValue>>;
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
