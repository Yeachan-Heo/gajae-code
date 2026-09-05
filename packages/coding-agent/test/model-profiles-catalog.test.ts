import { describe, expect, test } from "bun:test";
import { type GeneratedProvider, getBundledModel, getSupportedEfforts } from "@gajae-code/ai";
import {
	BUILTIN_MODEL_PROFILES,
	deriveModelProfileMappedProviders,
	formatAvailableProfileNames,
	getModelProfilePresentation,
	groupModelProfilesForPresetLanding,
	type ModelProfileDefinition,
	mergeModelProfiles,
	PROXY_ROUTABLE_PROVIDER_IDS,
	recommendModelProfileForProvider,
	resolveProfileBindings,
} from "@gajae-code/coding-agent/config/model-profiles";
import { parseModelString, splitSelectorThinkingSuffix } from "@gajae-code/coding-agent/config/model-resolver";
import { ProfileModelSelectorSchema } from "@gajae-code/coding-agent/config/models-config-schema";
import modelsJson from "../../ai/src/models.json";
import { isModelProfileProviderAvailable } from "../src/config/model-profile-contract";
import { type ModelSelectorValue, normalizeModelSelectorValue, selectorHead } from "../src/config/model-selector-value";

type Role = "default" | "executor" | "planner" | "critic" | "architect";

const roles: Role[] = ["default", "executor", "planner", "critic", "architect"];
const astraProfileNames = ["astra-lite", "astra-default", "astra-heavy", "astra-fable", "astra-fable-opus"] as const;
const astraProfileNameSet = new Set<string>(astraProfileNames);

const expectedProfiles: Array<{
	name: string;
	requiredProviders: string[];
	mapping: Record<Role, ModelSelectorValue>;
}> = [
	{
		name: "codex-eco",
		requiredProviders: ["openai-codex"],
		mapping: {
			default: "openai-codex/gpt-5.6-terra:low",
			executor: "openai-codex/gpt-5.6-luna:low",
			planner: "openai-codex/gpt-5.6-luna:high",
			critic: "openai-codex/gpt-5.6-terra:xhigh",
			architect: "openai-codex/gpt-5.6-terra:high",
		},
	},
	{
		name: "codex-medium",
		requiredProviders: ["openai-codex"],
		mapping: {
			default: "openai-codex/gpt-5.6-sol:low",
			executor: "openai-codex/gpt-5.6-terra:low",
			planner: "openai-codex/gpt-5.6-terra:high",
			critic: "openai-codex/gpt-5.6-sol:xhigh",
			architect: "openai-codex/gpt-5.6-sol:high",
		},
	},
	{
		name: "codex-pro",
		requiredProviders: ["openai-codex"],
		mapping: {
			default: "openai-codex/gpt-5.6-sol:medium",
			executor: "openai-codex/gpt-5.6-terra:medium",
			planner: "openai-codex/gpt-5.6-sol:high",
			critic: "openai-codex/gpt-5.6-sol:max",
			architect: "openai-codex/gpt-5.6-sol:xhigh",
		},
	},
	{
		name: "lunamaxxing",
		requiredProviders: ["openai-codex"],
		mapping: {
			default: "openai-codex/gpt-5.6-luna:medium",
			executor: "openai-codex/gpt-5.6-luna:xhigh",
			planner: "openai-codex/gpt-5.6-luna:max",
			critic: "openai-codex/gpt-5.6-luna:max",
			architect: "openai-codex/gpt-5.6-luna:max",
		},
	},
	{
		name: "astra-lite",
		requiredProviders: ["openai-codex"],
		mapping: {
			default: "openai-codex/gpt-6-astra:medium",
			executor: "openai-codex/gpt-5.6-luna:xhigh",
			planner: "openai-codex/gpt-6-astra:xhigh",
			critic: "openai-codex/gpt-5.6-sol:high",
			architect: "openai-codex/gpt-5.6-terra:xhigh",
		},
	},
	{
		name: "astra-default",
		requiredProviders: ["openai-codex"],
		mapping: {
			default: "openai-codex/gpt-6-astra:medium",
			executor: "openai-codex/gpt-5.6-luna:max",
			planner: "openai-codex/gpt-6-astra:xhigh",
			critic: "openai-codex/gpt-5.6-sol:xhigh",
			architect: "openai-codex/gpt-5.6-terra:xhigh",
		},
	},
	{
		name: "astra-heavy",
		requiredProviders: ["openai-codex"],
		mapping: {
			default: "openai-codex/gpt-6-astra:medium",
			executor: "openai-codex/gpt-5.6-sol:max",
			planner: "openai-codex/gpt-5.6-sol:max",
			critic: "openai-codex/gpt-6-astra:max",
			architect: "openai-codex/gpt-6-astra:max",
		},
	},
	{
		name: "macos-omlx-fast",
		requiredProviders: ["omlx"],
		mapping: {
			default: "omlx/Qwen3.6-35B-A3B-4bit:low",
			executor: "omlx/Qwen3.6-35B-A3B-4bit:low",
			architect: "omlx/Qwen3.6-35B-A3B-4bit:high",
			planner: "omlx/Qwen3.6-35B-A3B-4bit:medium",
			critic: "omlx/Qwen3.6-35B-A3B-4bit:high",
		},
	},
	{
		name: "macos-omlx-balanced",
		requiredProviders: ["omlx"],
		mapping: {
			default: "omlx/Qwen3.6-35B-A3B-8bit:low",
			executor: "omlx/Qwen3.6-35B-A3B-8bit:low",
			architect: "omlx/Qwen3.6-35B-A3B-8bit:high",
			planner: "omlx/Qwen3.6-35B-A3B-8bit:medium",
			critic: "omlx/Qwen3.6-35B-A3B-8bit:high",
		},
	},
	{
		name: "macos-omlx-quality",
		requiredProviders: ["omlx"],
		mapping: {
			default: "omlx/Qwen3.6-35B-A3B-8bit:low",
			executor: "omlx/Qwen3.6-35B-A3B-8bit:low",
			architect: "omlx/Qwen3.6-35B-A3B-8bit:high",
			planner: "omlx/Qwen3.6-35B-A3B-8bit:medium",
			critic: "omlx/Qwen3.8-27B-8bit:high",
		},
	},
	{
		name: "macos-omlx-abliterated-fast",
		requiredProviders: ["omlx"],
		mapping: {
			default: "omlx/Qwen3.8-27B-Uncensored-MLX-4bit:low",
			executor: "omlx/Qwen3.8-27B-Uncensored-MLX-4bit:low",
			architect: "omlx/Qwen3.8-27B-Uncensored-MLX-4bit:high",
			planner: "omlx/Qwen3.8-27B-Uncensored-MLX-4bit:medium",
			critic: "omlx/Qwen3.8-27B-Uncensored-MLX-4bit:high",
		},
	},
	{
		name: "macos-omlx-abliterated-balanced",
		requiredProviders: ["omlx"],
		mapping: {
			default: "omlx/Qwen3.8-27B-Uncensored-MLX-4bit:low",
			executor: "omlx/Qwen3.8-27B-Uncensored-MLX-4bit:low",
			architect: "omlx/Qwen3.8-27B-Uncensored-MLX-4bit:high",
			planner: "omlx/Qwen3.8-27B-Uncensored-MLX-4bit:medium",
			critic: "omlx/Qwen3.8-27B-Uncensored-MLX-4bit:high",
		},
	},
	{
		name: "opencodego",
		requiredProviders: ["opencode-go"],
		mapping: {
			default: "opencode-go/kimi-k3",
			executor: "opencode-go/deepseek-v4-flash",
			planner: "opencode-go/kimi-k3",
			critic: "opencode-go/mimo-v2.5-pro",
			architect: "opencode-go/deepseek-v4-pro",
		},
	},
	{
		name: "commandcode-goat",
		requiredProviders: ["commandcode-goat"],
		mapping: {
			default: "commandcode-goat/zai-org/GLM-5.3",
			executor: "commandcode-goat/deepseek/deepseek-v4-flash",
			planner: "commandcode-goat/moonshotai/Kimi-K3",
			critic: "commandcode-goat/zai-org/GLM-5.2",
			architect: "commandcode-goat/deepseek/deepseek-v4-pro",
		},
	},
	{
		name: "open-weights-glm",
		requiredProviders: [],
		mapping: {
			default: "glm-5.2:medium",
			executor: "glm-5.2:low",
			planner: "glm-5.2:high",
			critic: "glm-5.2:high",
			architect: "glm-5.2:xhigh",
		},
	},
	{
		name: "open-weights-deepseek",
		requiredProviders: [],
		mapping: {
			default: "deepseek-v4-flash:high",
			executor: "deepseek-v4-flash:medium",
			planner: "deepseek-v4-flash:high",
			critic: "deepseek-v4-flash:xhigh",
			architect: "deepseek-v4-flash:xhigh",
		},
	},
	{
		name: "open-weights-kimi",
		requiredProviders: [],
		mapping: {
			default: "kimi-k3:high",
			executor: "kimi-k3:high",
			planner: "kimi-k3:xhigh",
			critic: "kimi-k3:high",
			architect: "kimi-k3:xhigh",
		},
	},
	{
		name: "open-weights-luna",
		requiredProviders: [],
		mapping: {
			default: "gpt-5.6-luna:high",
			executor: "gpt-5.6-luna:high",
			planner: "gpt-5.6-luna:xhigh",
			critic: "gpt-5.6-luna:xhigh",
			architect: "gpt-5.6-luna:xhigh",
		},
	},
	{
		name: "open-weights-spark",
		requiredProviders: [],
		mapping: {
			default: "muse-spark-1.2:medium",
			executor: "muse-spark-1.2:low",
			planner: "muse-spark-1.2:high",
			critic: "muse-spark-1.2:high",
			architect: "muse-spark-1.2:xhigh",
		},
	},
	{
		name: "open-weights-spark-deepseek",
		requiredProviders: [],
		mapping: {
			default: "muse-spark-1.2:medium",
			executor: "deepseek-v4-flash:high",
			planner: "muse-spark-1.2:high",
			critic: "muse-spark-1.2:high",
			architect: "muse-spark-1.2:xhigh",
		},
	},
	{
		name: "open-weights-spark-luna",
		requiredProviders: [],
		mapping: {
			default: "muse-spark-1.2:medium",
			executor: "gpt-5.6-luna:high",
			planner: "muse-spark-1.2:high",
			critic: "muse-spark-1.2:high",
			architect: "muse-spark-1.2:xhigh",
		},
	},
	{
		name: "open-weights-glm-deepseek",
		requiredProviders: [],
		mapping: {
			default: "glm-5.2:medium",
			executor: "deepseek-v4-flash:high",
			planner: "glm-5.2:high",
			critic: "deepseek-v4-flash:xhigh",
			architect: "glm-5.2:xhigh",
		},
	},
	{
		name: "open-weights-kimi-deepseek",
		requiredProviders: [],
		mapping: {
			default: "kimi-k3:high",
			executor: "deepseek-v4-flash:high",
			planner: "kimi-k3:xhigh",
			critic: "deepseek-v4-flash:xhigh",
			architect: "kimi-k3:xhigh",
		},
	},
	{
		name: "open-weights-kimi-glm",
		requiredProviders: [],
		mapping: {
			default: "glm-5.2:high",
			executor: "glm-5.2:high",
			planner: "kimi-k3:high",
			critic: "glm-5.2:xhigh",
			architect: "kimi-k3:xhigh",
		},
	},
	{
		name: "open-weights-kimi-glm-deepseek",
		requiredProviders: [],
		mapping: {
			default: "glm-5.2:medium",
			executor: "deepseek-v4-flash:high",
			planner: "kimi-k3:high",
			critic: "glm-5.2:high",
			architect: "kimi-k3:xhigh",
		},
	},
	{
		name: "open-weights-all",
		requiredProviders: [],
		mapping: {
			default: "gpt-5.6-luna:high",
			executor: "deepseek-v4-flash:high",
			planner: "kimi-k3:high",
			critic: "glm-5.2:high",
			architect: "gpt-5.6-luna:xhigh",
		},
	},
	{
		name: "claude-opus",
		requiredProviders: ["anthropic"],
		mapping: {
			default: ["anthropic/claude-opus-5:xhigh", "anthropic/claude-opus-4-6:xhigh"],
			executor: "anthropic/claude-sonnet-5",
			planner: ["anthropic/claude-opus-5:low", "anthropic/claude-opus-4-6:low"],
			critic: ["anthropic/claude-opus-5:high", "anthropic/claude-opus-4-6:high"],
			architect: ["anthropic/claude-opus-5:xhigh", "anthropic/claude-opus-4-6:xhigh"],
		},
	},
	{
		name: "claude-fable",
		requiredProviders: ["anthropic"],
		mapping: {
			default: "anthropic/claude-fable-5-1:xhigh",
			executor: "anthropic/claude-sonnet-5",
			planner: "anthropic/claude-fable-5-1:low",
			critic: "anthropic/claude-fable-5-1:high",
			architect: "anthropic/claude-fable-5-1:xhigh",
		},
	},
	{
		name: "glm-eco",
		requiredProviders: ["zai"],
		mapping: {
			default: "zai/glm-5.3-flash:low",
			executor: "zai/glm-5.3-flash:low",
			planner: "zai/glm-5.3-flash:low",
			critic: "zai/glm-5.3:high",
			architect: "zai/glm-5.3:high",
		},
	},
	{
		name: "glm-medium",
		requiredProviders: ["zai"],
		mapping: {
			default: "zai/glm-5.3:high",
			executor: "zai/glm-5.3-flash:low",
			planner: "zai/glm-5.3:high",
			critic: "zai/glm-5.3:high",
			architect: "zai/glm-5.3:max",
		},
	},
	{
		name: "glm-pro",
		requiredProviders: ["zai"],
		mapping: {
			default: "zai/glm-5.3:max",
			executor: "zai/glm-5.3-flash:high",
			planner: "zai/glm-5.3:high",
			critic: "zai/glm-5.3:max",
			architect: "zai/glm-5.3:max",
		},
	},
	{
		name: "kimi-coding-plan-eco",
		requiredProviders: ["kimi-code"],
		mapping: {
			default: "kimi-code/k3:low",
			executor: "kimi-code/k3:low",
			planner: "kimi-code/k3:low",
			critic: "kimi-code/k3:high",
			architect: "kimi-code/k3:high",
		},
	},
	{
		name: "kimi-coding-plan-medium",
		requiredProviders: ["kimi-code"],
		mapping: {
			default: "kimi-code/k3:high",
			executor: "kimi-code/k3:low",
			planner: "kimi-code/k3:high",
			critic: "kimi-code/k3:high",
			architect: "kimi-code/k3:max",
		},
	},
	{
		name: "kimi-coding-plan-pro",
		requiredProviders: ["kimi-code"],
		mapping: {
			default: "kimi-code/k3:max",
			executor: "kimi-code/k3:high",
			planner: "kimi-code/k3:high",
			critic: "kimi-code/k3:max",
			architect: "kimi-code/k3:max",
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
		name: "grok-45-eco",
		requiredProviders: ["xai"],
		mapping: {
			default: "xai/grok-4.5:low",
			executor: "xai/grok-4.5:low",
			planner: "xai/grok-4.5:low",
			critic: "xai/grok-4.5:medium",
			architect: "xai/grok-4.5:high",
		},
	},
	{
		name: "grok-45-medium",
		requiredProviders: ["xai"],
		mapping: {
			default: "xai/grok-4.5:medium",
			executor: "xai/grok-4.5:low",
			planner: "xai/grok-4.5:medium",
			critic: "xai/grok-4.5:high",
			architect: "xai/grok-4.5:high",
		},
	},
	{
		name: "grok-45-pro",
		requiredProviders: ["xai"],
		mapping: {
			default: "xai/grok-4.5:high",
			executor: "xai/grok-4.5:medium",
			planner: "xai/grok-4.5:high",
			critic: "xai/grok-4.5:high",
			architect: "xai/grok-4.5:high",
		},
	},
	{
		name: "grok-46-eco",
		requiredProviders: ["xai"],
		mapping: {
			default: "xai/grok-4.6:low",
			executor: "xai/grok-4.6:low",
			planner: "xai/grok-4.6:low",
			critic: "xai/grok-4.6:medium",
			architect: "xai/grok-4.6:high",
		},
	},
	{
		name: "grok-46-medium",
		requiredProviders: ["xai"],
		mapping: {
			default: "xai/grok-4.6:medium",
			executor: "xai/grok-4.6:low",
			planner: "xai/grok-4.6:medium",
			critic: "xai/grok-4.6:high",
			architect: "xai/grok-4.6:high",
		},
	},
	{
		name: "grok-46-pro",
		requiredProviders: ["xai"],
		mapping: {
			default: "xai/grok-4.6:xhigh",
			executor: "xai/grok-4.6:medium",
			planner: "xai/grok-4.6:high",
			critic: "xai/grok-4.6:xhigh",
			architect: "xai/grok-4.6:xhigh",
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
			default: "cursor/composer-2.5",
			executor: "cursor/composer-2.5",
			planner: "cursor/composer-2.5",
			critic: "cursor/composer-2.5",
			architect: "cursor/composer-2.5",
		},
	},
	{
		name: "cursor-medium",
		requiredProviders: ["cursor"],
		mapping: {
			default: "cursor/composer-2.5",
			executor: "cursor/composer-2.5-fast",
			planner: "cursor/composer-2.5",
			critic: "cursor/composer-2.5-fast",
			architect: "cursor/composer-2.5-fast",
		},
	},
	{
		name: "cursor-pro",
		requiredProviders: ["cursor"],
		mapping: {
			default: "cursor/composer-2.5-fast",
			executor: "cursor/composer-2.5-fast",
			planner: "cursor/composer-2.5-fast",
			critic: "cursor/composer-2.5-fast",
			architect: "cursor/composer-2.5-fast",
		},
	},
	{
		name: "minimax-eco",
		requiredProviders: ["minimax-code"],
		mapping: {
			default: "minimax-code/MiniMax-M3:low",
			executor: "minimax-code/MiniMax-M3:minimal",
			planner: "minimax-code/MiniMax-M3:low",
			critic: "minimax-code/MiniMax-M3:medium",
			architect: "minimax-code/MiniMax-M3:high",
		},
	},
	{
		name: "minimax-medium",
		requiredProviders: ["minimax-code"],
		mapping: {
			default: "minimax-code/MiniMax-M3:medium",
			executor: "minimax-code/MiniMax-M3:low",
			planner: "minimax-code/MiniMax-M3:medium",
			critic: "minimax-code/MiniMax-M3:high",
			architect: "minimax-code/MiniMax-M3:xhigh",
		},
	},
	{
		name: "minimax-pro",
		requiredProviders: ["minimax-code"],
		mapping: {
			default: "minimax-code/MiniMax-M3:xhigh",
			executor: "minimax-code/MiniMax-M3:medium",
			planner: "minimax-code/MiniMax-M3:high",
			critic: "minimax-code/MiniMax-M3:xhigh",
			architect: "minimax-code/MiniMax-M3:xhigh",
		},
	},
	{
		name: "alibaba-token-plan-balanced",
		requiredProviders: ["alibaba-token-plan"],
		mapping: {
			default: "alibaba-token-plan/qwen3.8-max-preview:medium",
			executor: "alibaba-token-plan/deepseek-v4-pro:xhigh",
			planner: "alibaba-token-plan/glm-5.2:high",
			critic: "alibaba-token-plan/glm-5.2:high",
			architect: "alibaba-token-plan/qwen3.8-max-preview:xhigh",
		},
	},
	{
		name: "alibaba-token-plan-pro",
		requiredProviders: ["alibaba-token-plan"],
		mapping: {
			default: "alibaba-token-plan/qwen3.8-max-preview:medium",
			executor: "alibaba-token-plan/deepseek-v4-flash-0731:max",
			planner: "alibaba-token-plan/glm-5.2:high",
			critic: "alibaba-token-plan/glm-5.2:xhigh",
			architect: "alibaba-token-plan/qwen3.8-max-preview:xhigh",
		},
	},
	{
		name: "alibaba-token-plan-qwenmaxxing",
		requiredProviders: ["alibaba-token-plan"],
		mapping: {
			default: "alibaba-token-plan/qwen3.8-max-preview:medium",
			executor: "alibaba-token-plan/qwen3.8-max-preview:low",
			planner: "alibaba-token-plan/qwen3.8-max-preview:medium",
			critic: "alibaba-token-plan/qwen3.8-max-preview:xhigh",
			architect: "alibaba-token-plan/qwen3.8-max-preview:xhigh",
		},
	},
	{
		name: "alibaba-token-plan-qwen-deepseek",
		requiredProviders: ["alibaba-token-plan"],
		mapping: {
			default: "alibaba-token-plan/qwen3.8-max:high",
			executor: "alibaba-token-plan/deepseek-v4-flash-0731:high",
			planner: "alibaba-token-plan/deepseek-v4-flash-0731:max",
			critic: "alibaba-token-plan/qwen3.8-max:xhigh",
			architect: "alibaba-token-plan/qwen3.8-max:xhigh",
		},
	},
	{
		name: "alibaba-token-plan-glm-deepseek",
		requiredProviders: ["alibaba-token-plan"],
		mapping: {
			default: "alibaba-token-plan/glm-5.2:high",
			executor: "alibaba-token-plan/deepseek-v4-flash-0731:high",
			planner: "alibaba-token-plan/deepseek-v4-flash-0731:max",
			critic: "alibaba-token-plan/glm-5.2:xhigh",
			architect: "alibaba-token-plan/glm-5.2:xhigh",
		},
	},
	{
		name: "opus-codex",
		requiredProviders: ["anthropic", "openai-codex"],
		mapping: {
			default: "anthropic/claude-opus-5:xhigh",
			executor: "openai-codex/gpt-5.6-terra:low",
			planner: "anthropic/claude-sonnet-5",
			critic: "openai-codex/gpt-5.6-sol:xhigh",
			architect: "openai-codex/gpt-5.6-sol:high",
		},
	},
	{
		name: "codex-opencodego",
		requiredProviders: ["openai-codex", "opencode-go"],
		mapping: {
			default: "openai-codex/gpt-5.6-sol:low",
			executor: "opencode-go/deepseek-v4-pro",
			planner: "opencode-go/kimi-k3",
			critic: "opencode-go/mimo-v2.5-pro",
			architect: "openai-codex/gpt-5.6-sol:high",
		},
	},
	{
		name: "fable-opus-codex",
		requiredProviders: ["anthropic", "openai-codex"],
		mapping: {
			default: "anthropic/claude-fable-5-1:high",
			executor: "openai-codex/gpt-5.6-terra:medium",
			planner: "anthropic/claude-opus-5:medium",
			critic: "anthropic/claude-opus-5:high",
			architect: "openai-codex/gpt-5.6-sol:xhigh",
		},
	},
	{
		name: "astra-fable",
		requiredProviders: ["openai-codex", "anthropic"],
		mapping: {
			default: "openai-codex/gpt-6-astra:medium",
			executor: "openai-codex/gpt-5.6-luna:max",
			planner: "openai-codex/gpt-6-astra:xhigh",
			critic: "anthropic/claude-fable-5-1:xhigh",
			architect: "anthropic/claude-fable-5-1:xhigh",
		},
	},
	{
		name: "astra-fable-opus",
		requiredProviders: ["openai-codex", "anthropic"],
		mapping: {
			default: "openai-codex/gpt-6-astra:medium",
			executor: "openai-codex/gpt-5.6-luna:max",
			planner: "anthropic/claude-opus-5:medium",
			critic: "anthropic/claude-fable-5-1:xhigh",
			architect: "anthropic/claude-fable-5-1:xhigh",
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

const commandCodeGoatModels = new Set([
	"zai-org/GLM-5.2",
	"zai-org/GLM-5.3",
	"deepseek/deepseek-v4-flash",
	"deepseek/deepseek-v4-pro",
	"moonshotai/Kimi-K3",
]);
const macosOmlxModels = new Set([
	"Qwen3.6-35B-A3B-4bit",
	"Qwen3.6-35B-A3B-8bit",
	"Qwen3.8-27B-8bit",
	"Qwen3.8-27B-Uncensored-MLX-4bit",
]);

function selectorExists(selector: string): boolean {
	const selectorWithoutThinking = splitSelectorThinkingSuffix(selector).selector;
	if (!selectorWithoutThinking.includes("/")) {
		const alias = selectorWithoutThinking.trim().toLowerCase();
		return Object.values(modelsJson as Record<string, Record<string, unknown>>).some(models =>
			Object.keys(models).some(modelId => modelId.split("/").at(-1)?.toLowerCase() === alias),
		);
	}
	const parsed = parseModelString(selector);
	if (!parsed) return false;
	if (parsed.provider === "grok-build") return ["grok-composer-2.5-fast", "grok-build"].includes(parsed.id);
	if (parsed.provider === "commandcode-goat") return commandCodeGoatModels.has(parsed.id);
	if (parsed.provider === "omlx") return macosOmlxModels.has(parsed.id);
	return (modelsJson as Record<string, Record<string, unknown>>)[parsed.provider]?.[parsed.id] !== undefined;
}

function builtinMapping(name: string): Record<Role, string> {
	const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === name);
	if (!profile) throw new Error(`Missing built-in profile: ${name}`);
	if (roles.some(role => profile.modelMapping[role] === undefined)) {
		throw new Error(`Built-in profile is missing a role mapping: ${name}`);
	}
	return profile.modelMapping as Record<Role, string>;
}

function substituteCodexFamily(selector: string, source: "sol" | "terra", target: "terra" | "luna"): string {
	const match = /^openai-codex\/gpt-5\.6-(sol|terra|luna):(.+)$/.exec(selector);
	if (!match) throw new Error(`Expected GPT-5.6 Codex selector, got: ${selector}`);
	return match[1] === source ? `openai-codex/gpt-5.6-${target}:${match[2]}` : selector;
}

const fixedNonCodexComboMappings: Record<string, Partial<Record<Role, string>>> = {
	"opus-codex": {
		default: "anthropic/claude-opus-5:xhigh",
		planner: "anthropic/claude-sonnet-5",
	},
	"codex-opencodego": {
		executor: "opencode-go/deepseek-v4-pro",
		planner: "opencode-go/kimi-k3",
		critic: "opencode-go/mimo-v2.5-pro",
	},
	"fable-opus-codex": {
		default: "anthropic/claude-fable-5-1:high",
		planner: "anthropic/claude-opus-5:medium",
		critic: "anthropic/claude-opus-5:high",
	},
	"astra-fable": {
		critic: "anthropic/claude-fable-5-1:xhigh",
		architect: "anthropic/claude-fable-5-1:xhigh",
	},
	"astra-fable-opus": {
		planner: "anthropic/claude-opus-5:medium",
		critic: "anthropic/claude-fable-5-1:xhigh",
		architect: "anthropic/claude-fable-5-1:xhigh",
	},
};

describe("built-in model profile catalog", () => {
	test("contains exact 63-profile matrix cell-for-cell without replacing prior presets", () => {
		expect(expectedProfiles).toHaveLength(63);
		expect(BUILTIN_MODEL_PROFILES.map(profile => profile.name)).toEqual(
			expectedProfiles.map(profile => profile.name),
		);
		const priorExpectedProfiles = expectedProfiles.filter(profile => !astraProfileNameSet.has(profile.name));
		expect(priorExpectedProfiles).toHaveLength(58);
		expect(
			BUILTIN_MODEL_PROFILES.filter(profile => !astraProfileNameSet.has(profile.name)).map(profile => ({
				name: profile.name,
				requiredProviders: profile.requiredProviders,
				mapping: profile.modelMapping,
			})),
		).toEqual(priorExpectedProfiles);
		for (const expected of expectedProfiles) {
			const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === expected.name);
			expect(profile?.requiredProviders).toEqual(expected.requiredProviders);
			expect(profile?.modelMapping).toEqual(expected.mapping);
		}
	});

	test("Astra tiers and combinations resolve their exact role bindings", () => {
		const profiles = mergeModelProfiles();
		for (const name of astraProfileNames) {
			const expected = expectedProfiles.find(profile => profile.name === name);
			if (!expected) throw new Error(`Missing expected profile: ${name}`);
			const definition = profiles.get(name);
			if (!definition) throw new Error(`Missing resolved profile: ${name}`);
			const resolved = resolveProfileBindings(definition);
			expect(resolved.defaultSelector).toBe(expected.mapping.default);
			expect(resolved.agentModelOverrides).toEqual({
				executor: expected.mapping.executor,
				architect: expected.mapping.architect,
				planner: expected.mapping.planner,
				critic: expected.mapping.critic,
			});
		}
	});

	test("Astra profiles enforce provider availability and keep mapped providers proxy-routable", () => {
		const profiles = mergeModelProfiles();
		for (const name of ["astra-lite", "astra-default", "astra-heavy"] as const) {
			const profile = profiles.get(name);
			if (!profile) throw new Error(`Missing Astra profile: ${name}`);
			expect(profile.requiredProviders).toEqual(["openai-codex"]);
			expect(deriveModelProfileMappedProviders(profile)).toEqual(["openai-codex"]);
			expect(isModelProfileProviderAvailable(profile, new Set<string>())).toBe(false);
			expect(isModelProfileProviderAvailable(profile, new Set(["openai-codex"]))).toBe(true);
		}
		for (const name of ["astra-fable", "astra-fable-opus"] as const) {
			const profile = profiles.get(name);
			if (!profile) throw new Error(`Missing Astra combination: ${name}`);
			expect(profile.requiredProviders).toEqual(["openai-codex", "anthropic"]);
			expect(deriveModelProfileMappedProviders(profile)).toEqual(["anthropic", "openai-codex"]);
			expect(isModelProfileProviderAvailable(profile, new Set(["openai-codex"]))).toBe(false);
			expect(isModelProfileProviderAvailable(profile, new Set(["anthropic"]))).toBe(false);
			expect(isModelProfileProviderAvailable(profile, new Set(["openai-codex", "anthropic"]))).toBe(true);
		}
		for (const provider of ["openai-codex", "anthropic"]) {
			expect(PROXY_ROUTABLE_PROVIDER_IDS.has(provider)).toBe(true);
		}
	});

	test("Astra mappings use only thinking efforts declared by their bundled models", () => {
		for (const name of astraProfileNames) {
			const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === name);
			if (!profile) throw new Error(`Missing Astra profile: ${name}`);
			for (const selectorValue of Object.values(profile.modelMapping)) {
				for (const selector of normalizeModelSelectorValue(selectorValue)) {
					const suffix = splitSelectorThinkingSuffix(selector);
					expect(suffix.invalidSuffix).toBeUndefined();
					if (suffix.thinkingLevel === undefined) throw new Error(`Missing Astra effort: ${selector}`);
					const parsed = parseModelString(suffix.selector);
					if (!parsed) throw new Error(`Invalid Astra selector: ${selector}`);
					const model = getBundledModel(parsed.provider as GeneratedProvider, parsed.id);
					expect(model).toBeDefined();
					const supportedEfforts: readonly string[] = getSupportedEfforts(model);
					expect(supportedEfforts).toContain(suffix.thinkingLevel);
				}
			}
		}
	});

	test("open-weight profiles use only provider-agnostic aliases", () => {
		const profiles = BUILTIN_MODEL_PROFILES.filter(profile => profile.name.startsWith("open-weights-"));
		expect(profiles.map(profile => profile.name)).toEqual([
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
		]);
		for (const profile of profiles) {
			expect(profile.requiredProviders).toEqual([]);
			for (const selectorValue of Object.values(profile.modelMapping)) {
				for (const selector of normalizeModelSelectorValue(selectorValue)) {
					expect(splitSelectorThinkingSuffix(selector).selector).not.toContain("/");
				}
			}
		}
	});
	test("Grok 4.5 profiles resolve every role at the expected effort", () => {
		const profiles = mergeModelProfiles();
		for (const name of ["grok-45-eco", "grok-45-medium", "grok-45-pro"] as const) {
			const expected = expectedProfiles.find(profile => profile.name === name);
			if (!expected) throw new Error(`Missing expected profile: ${name}`);
			const definition = profiles.get(name);
			if (!definition) throw new Error(`Missing resolved profile: ${name}`);
			const resolved = resolveProfileBindings(definition);
			expect(resolved.defaultSelector).toBe(expected.mapping.default);
			expect(resolved.agentModelOverrides).toEqual({
				executor: expected.mapping.executor,
				architect: expected.mapping.architect,
				planner: expected.mapping.planner,
				critic: expected.mapping.critic,
			});
		}
	});

	test("Grok 4.5 profiles never request unsupported xhigh reasoning", () => {
		const grok45Profiles = BUILTIN_MODEL_PROFILES.filter(profile => profile.name.startsWith("grok-45-"));
		expect(grok45Profiles.map(profile => profile.name)).toEqual(["grok-45-eco", "grok-45-medium", "grok-45-pro"]);
		for (const profile of grok45Profiles) {
			for (const selectorValue of Object.values(profile.modelMapping)) {
				for (const selector of normalizeModelSelectorValue(selectorValue)) {
					const trimmedSelector = selector.trim();
					const separator = trimmedSelector.lastIndexOf(":");
					const hasEffort = separator > trimmedSelector.indexOf("/");
					const modelReference = hasEffort ? trimmedSelector.slice(0, separator).trim() : trimmedSelector;
					const parsed = parseModelString(modelReference);
					if (parsed?.provider.toLowerCase() !== "xai" || parsed.id.toLowerCase() !== "grok-4.5") continue;
					const effort = hasEffort
						? trimmedSelector
								.slice(separator + 1)
								.trim()
								.toLowerCase()
						: undefined;
					// grok-4.5 mappings must carry an effort suffix; narrow for tsc + assert allowlist
					if (effort === undefined) {
						throw new Error(`missing effort suffix on grok-4.5 selector ${trimmedSelector}`);
					}
					expect(["minimal", "low", "medium", "high"]).toContain(effort);
				}
			}
		}
	});

	test("codex Eco is Medium with Terra lowered to Luna and Sol lowered to Terra", () => {
		const eco = builtinMapping("codex-eco");
		const medium = builtinMapping("codex-medium");
		const loweredMedium = Object.fromEntries(
			roles.map(role => [
				role,
				substituteCodexFamily(substituteCodexFamily(medium[role], "terra", "luna"), "sol", "terra"),
			]),
		) as Record<Role, string>;

		expect(eco).toEqual(loweredMedium);
		expect(Object.values(eco).some(selector => selector.includes("gpt-5.6-sol"))).toBe(false);
	});

	test("combo Codex roles project their source preset at the same role", () => {
		const medium = builtinMapping("codex-medium");
		const pro = builtinMapping("codex-pro");
		const astraDefault = builtinMapping("astra-default");
		const opusCodex = builtinMapping("opus-codex");
		const codexOpencodego = builtinMapping("codex-opencodego");
		const fableOpusCodex = builtinMapping("fable-opus-codex");
		const astraFable = builtinMapping("astra-fable");
		const astraFableOpus = builtinMapping("astra-fable-opus");

		for (const role of ["executor", "critic", "architect"] as const) {
			expect(opusCodex[role]).toBe(medium[role]);
		}
		for (const role of ["default", "architect"] as const) {
			expect(codexOpencodego[role]).toBe(medium[role]);
		}
		for (const role of ["executor", "architect"] as const) {
			expect(fableOpusCodex[role]).toBe(pro[role]);
		}
		for (const role of ["default", "executor", "planner"] as const) {
			expect(astraFable[role]).toBe(astraDefault[role]);
		}
		for (const role of ["default", "executor"] as const) {
			expect(astraFableOpus[role]).toBe(astraDefault[role]);
		}
	});

	test("combo non-Codex cells retain their fixed baselines", () => {
		for (const [profileName, expectedMapping] of Object.entries(fixedNonCodexComboMappings)) {
			const mapping = builtinMapping(profileName);
			for (const [role, selector] of Object.entries(expectedMapping) as Array<[Role, string]>) {
				expect(mapping[role]).toBe(selector);
			}
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
				const selectorValue = profile.modelMapping[role];
				expect(selectorValue).toBeDefined();
				for (const selector of normalizeModelSelectorValue(selectorValue)) {
					expect(ProfileModelSelectorSchema.safeParse(selector).success).toBe(true);
					if (selector.includes("/")) expect(parseModelString(selector)).toBeDefined();
					if (!selectorExists(selector)) missing.push(`${profile.name}.${role}=${selector}`);
				}
			}
		}
		expect(missing).toEqual([]);
		expect((modelsJson as Record<string, Record<string, unknown>>)["kimi-code"]?.k3).toBeDefined();
		expect((modelsJson as Record<string, Record<string, unknown>>)["minimax-code"]?.["MiniMax-M3"]).toBeDefined();
		expect(
			(modelsJson as Record<string, Record<string, unknown>>)["alibaba-token-plan"]?.["deepseek-v4-flash-0731"],
		).toBeDefined();
		expect((modelsJson as Record<string, Record<string, unknown>>)["alibaba-token-plan"]?.["glm-5.2"]).toBeDefined();
		expect(
			(modelsJson as Record<string, Record<string, unknown>>)["alibaba-token-plan"]?.["qwen3.8-max-preview"],
		).toBeDefined();
		expect((modelsJson as Record<string, Record<string, unknown>>).xai?.["grok-4.6"]).toBeDefined();
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
		expect(getModelProfilePresentation("open-weights-glm-deepseek")).toEqual({
			displayName: "GLM + DeepSeek",
			providerGroup: "OPEN WEIGHT MODELS (PROVIDER AGNOSTIC)",
		});
		expect(getModelProfilePresentation("commandcode-goat")).toEqual({
			displayName: "Command Code GOAT",
			providerGroup: "COMMAND CODE GOAT",
		});
		for (const [name, displayName] of Object.entries({
			"macos-omlx-fast": "4-bit Fast (MoE measured 93.5 tok/s)",
			"macos-omlx-balanced": "8-bit Balanced (MoE measured 71.1 tok/s)",
			"macos-omlx-quality": "Quality mix (8-bit MoE + 8-bit dense critic)",
			"macos-omlx-abliterated-fast": "Uncensored 4-bit Fast (measured 19.8 tok/s)",
			"macos-omlx-abliterated-balanced": "Uncensored 4-bit Balanced (same winner as fast)",
		})) {
			expect(getModelProfilePresentation(name)).toEqual({ displayName, providerGroup: "macOS Local (oMLX)" });
		}
		for (const [name, displayName] of Object.entries({
			"grok-45-eco": "Grok 4.5 Eco",
			"grok-45-medium": "Grok 4.5 Medium",
			"grok-45-pro": "Grok 4.5 Pro",
			"grok-46-eco": "Grok 4.6 Eco",
			"grok-46-medium": "Grok 4.6 Medium",
			"grok-46-pro": "Grok 4.6 Pro",
		})) {
			expect(getModelProfilePresentation(name)).toEqual({ displayName, providerGroup: "GROK" });
		}
		for (const [name, displayName] of Object.entries({
			"astra-lite": "ASTRA-Lite",
			"astra-default": "ASTRA-Default",
			"astra-heavy": "ASTRA-Heavy",
		})) {
			expect(getModelProfilePresentation(name)).toEqual({ displayName, providerGroup: "CODEX" });
		}
		for (const [name, displayName] of Object.entries({
			"astra-fable": "ASTRA + Fable (5.1)",
			"astra-fable-opus": "ASTRA + Fable (5.1) + Opus",
		})) {
			expect(getModelProfilePresentation(name)).toEqual({ displayName, providerGroup: "COMBOS" });
		}
		expect([...groupModelProfilesForPresetLanding(profiles).keys()]).toEqual([
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
		]);
		expect(
			groupModelProfilesForPresetLanding(profiles)
				.get("CODEX")
				?.map(profile => profile.name),
		).toEqual([
			"astra-default",
			"astra-heavy",
			"astra-lite",
			"codex-eco",
			"codex-medium",
			"codex-pro",
			"lunamaxxing",
		]);
		expect(
			groupModelProfilesForPresetLanding(profiles)
				.get("COMBOS")
				?.map(profile => profile.name),
		).toEqual(["astra-fable", "astra-fable-opus", "codex-opencodego", "fable-opus-codex", "opus-codex"]);
		expect(
			groupModelProfilesForPresetLanding(profiles)
				.get("macOS Local (oMLX)")
				?.map(profile => profile.name),
		).toEqual([
			"macos-omlx-fast",
			"macos-omlx-balanced",
			"macos-omlx-quality",
			"macos-omlx-abliterated-fast",
			"macos-omlx-abliterated-balanced",
		]);
		expect(
			groupModelProfilesForPresetLanding(profiles)
				.get("OPEN WEIGHT MODELS (PROVIDER AGNOSTIC)")
				?.map(profile => profile.name),
		).toEqual([
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
		]);
		expect(recommendModelProfileForProvider("openai-codex", profiles)?.name).toBe("codex-medium");
		expect(recommendModelProfileForProvider("anthropic", profiles)?.name).toBe("claude-opus");
		expect(recommendModelProfileForProvider("opencode-go", profiles)?.name).toBe("opencodego");
		expect(recommendModelProfileForProvider("commandcode-goat", profiles)?.name).toBe("commandcode-goat");
		expect(recommendModelProfileForProvider("zai", profiles)?.name).toBe("glm-medium");
		expect(recommendModelProfileForProvider("kimi-code", profiles)?.name).toBe("kimi-coding-plan-medium");
		expect(recommendModelProfileForProvider("xiaomi", profiles)?.name).toBe("mimo-medium");
		expect(recommendModelProfileForProvider("xiaomi-token-plan-sgp", profiles)?.name).toBe("mimo-medium");
		expect(recommendModelProfileForProvider("xiaomi-token-plan-ams", profiles)?.name).toBe("mimo-medium");
		expect(recommendModelProfileForProvider("xiaomi-token-plan-cn", profiles)?.name).toBe("mimo-medium");
		expect(recommendModelProfileForProvider("xai", profiles)?.name).toBe("grok-46-medium");
		expect(recommendModelProfileForProvider("omlx", profiles)?.name).toBe("macos-omlx-balanced");
		expect(recommendModelProfileForProvider("grok-build", profiles)?.name).toBe("grok-build-pro");
		expect(recommendModelProfileForProvider("cursor", profiles)?.name).toBe("cursor-medium");
		expect(recommendModelProfileForProvider("alibaba-token-plan", profiles)?.name).toBe(
			"alibaba-token-plan-balanced",
		);
		expect(getModelProfilePresentation("alibaba-token-plan-balanced")).toEqual({
			displayName: "Balanced",
			providerGroup: "ALIBABA TOKEN PLAN",
		});
		expect(getModelProfilePresentation("alibaba-token-plan-pro")).toEqual({
			displayName: "Pro",
			providerGroup: "ALIBABA TOKEN PLAN",
		});
		expect(getModelProfilePresentation("alibaba-token-plan-qwenmaxxing")).toEqual({
			displayName: "QwenMaxxing",
			providerGroup: "ALIBABA TOKEN PLAN",
		});
		expect(getModelProfilePresentation("alibaba-token-plan-qwen-deepseek")).toEqual({
			displayName: "Qwen + DeepSeek",
			providerGroup: "ALIBABA TOKEN PLAN",
		});
		expect(getModelProfilePresentation("alibaba-token-plan-glm-deepseek")).toEqual({
			displayName: "GLM + DeepSeek",
			providerGroup: "ALIBABA TOKEN PLAN",
		});
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

	test("Cursor tiers use distinct current model IDs without inert effort suffixes", () => {
		const eco = builtinMapping("cursor-eco");
		const medium = builtinMapping("cursor-medium");
		const pro = builtinMapping("cursor-pro");

		expect(new Set(Object.values(eco))).toEqual(new Set(["cursor/composer-2.5"]));
		expect(medium).not.toEqual(eco);
		expect(pro).not.toEqual(medium);
		expect(medium.executor).toBe("cursor/composer-2.5-fast");
		expect(medium.critic).toBe("cursor/composer-2.5-fast");
		expect(new Set(Object.values(pro))).toEqual(new Set(["cursor/composer-2.5-fast"]));
		for (const mapping of [eco, medium, pro]) {
			for (const selector of Object.values(mapping)) expect(selector).not.toContain(":");
		}
	});

	test("built-in minimax profiles resolve to the canonical MiniMax-M3 id (issue #3896)", () => {
		const minimaxProfiles = BUILTIN_MODEL_PROFILES.filter(profile =>
			profile.requiredProviders.includes("minimax-code"),
		);
		expect(minimaxProfiles.map(profile => profile.name)).toEqual(["minimax-eco", "minimax-medium", "minimax-pro"]);
		for (const profile of minimaxProfiles) {
			for (const role of roles) {
				const selector = profile.modelMapping[role];
				expect(selector).toBeDefined();
				const parsed = parseModelString(selectorHead(selector) ?? "");
				expect(parsed?.provider).toBe("minimax-code");
				expect(parsed?.id).toBe("MiniMax-M3");
			}
		}
		expect(JSON.stringify(BUILTIN_MODEL_PROFILES)).not.toContain("minimax-v3");
		expect(JSON.stringify(BUILTIN_MODEL_PROFILES)).not.toContain("minimax-m3");
	});

	test("Alibaba Token Plan profiles route their intended roles", () => {
		expect(builtinMapping("alibaba-token-plan-balanced")).toEqual({
			default: "alibaba-token-plan/qwen3.8-max-preview:medium",
			executor: "alibaba-token-plan/deepseek-v4-pro:xhigh",
			planner: "alibaba-token-plan/glm-5.2:high",
			critic: "alibaba-token-plan/glm-5.2:high",
			architect: "alibaba-token-plan/qwen3.8-max-preview:xhigh",
		});
		expect(builtinMapping("alibaba-token-plan-pro")).toEqual({
			default: "alibaba-token-plan/qwen3.8-max-preview:medium",
			executor: "alibaba-token-plan/deepseek-v4-flash-0731:max",
			planner: "alibaba-token-plan/glm-5.2:high",
			critic: "alibaba-token-plan/glm-5.2:xhigh",
			architect: "alibaba-token-plan/qwen3.8-max-preview:xhigh",
		});
		expect(builtinMapping("alibaba-token-plan-qwenmaxxing")).toEqual({
			default: "alibaba-token-plan/qwen3.8-max-preview:medium",
			executor: "alibaba-token-plan/qwen3.8-max-preview:low",
			planner: "alibaba-token-plan/qwen3.8-max-preview:medium",
			critic: "alibaba-token-plan/qwen3.8-max-preview:xhigh",
			architect: "alibaba-token-plan/qwen3.8-max-preview:xhigh",
		});
		expect(builtinMapping("alibaba-token-plan-qwen-deepseek")).toEqual({
			default: "alibaba-token-plan/qwen3.8-max:high",
			executor: "alibaba-token-plan/deepseek-v4-flash-0731:high",
			planner: "alibaba-token-plan/deepseek-v4-flash-0731:max",
			critic: "alibaba-token-plan/qwen3.8-max:xhigh",
			architect: "alibaba-token-plan/qwen3.8-max:xhigh",
		});
		expect(builtinMapping("alibaba-token-plan-glm-deepseek")).toEqual({
			default: "alibaba-token-plan/glm-5.2:high",
			executor: "alibaba-token-plan/deepseek-v4-flash-0731:high",
			planner: "alibaba-token-plan/deepseek-v4-flash-0731:max",
			critic: "alibaba-token-plan/glm-5.2:xhigh",
			architect: "alibaba-token-plan/glm-5.2:xhigh",
		});
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
