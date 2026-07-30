import type { ModelManagerOptions } from "../model-manager";
import { Effort } from "../model-thinking";
import { KIRO_RUNTIME_URL, parseKiroAccessContext } from "../providers/kiro";
import type { Model, ThinkingConfig } from "../types";
import { fetchKiroModels } from "../utils/discovery/kiro";

const KIRO_MAX_OUTPUT_TOKENS = 32_000;
const KIRO_ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const STANDARD_LEVELS = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] as const;
const XHIGH_LEVELS = [...STANDARD_LEVELS, Effort.XHigh] as const;
const MAX_LEVELS = [...STANDARD_LEVELS, Effort.Max] as const;
const XHIGH_MAX_LEVELS = [...STANDARD_LEVELS, Effort.XHigh, Effort.Max] as const;
const GPT_5_6_LEVELS = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] as const;

function thinkingConfig(levels: readonly Effort[]): ThinkingConfig {
	const minLevel = levels[0];
	const maxLevel = levels.at(-1);
	if (!minLevel || !maxLevel) throw new Error("Kiro thinking levels must not be empty");
	return { mode: "effort", minLevel, maxLevel, levels };
}
const KIRO_MODEL_SPECS = [
	{ id: "auto", name: "Auto", contextWindow: 1_000_000, thinkingLevels: STANDARD_LEVELS },
	{ id: "claude-haiku-4.5", name: "Claude Haiku 4.5", contextWindow: 200_000, thinkingLevels: XHIGH_LEVELS },
	{ id: "claude-opus-4.5", name: "Claude Opus 4.5", contextWindow: 200_000, thinkingLevels: XHIGH_LEVELS },
	{ id: "claude-opus-4.6", name: "Claude Opus 4.6", contextWindow: 1_000_000, thinkingLevels: MAX_LEVELS },
	{ id: "claude-opus-4.7", name: "Claude Opus 4.7", contextWindow: 1_000_000, thinkingLevels: XHIGH_MAX_LEVELS },
	{ id: "claude-opus-5", name: "Claude Opus 5", contextWindow: 1_000_000, thinkingLevels: XHIGH_MAX_LEVELS },
	{ id: "claude-sonnet-4", name: "Claude Sonnet 4", contextWindow: 200_000, thinkingLevels: XHIGH_LEVELS },
	{ id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", contextWindow: 200_000, thinkingLevels: XHIGH_LEVELS },
	{ id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", contextWindow: 1_000_000, thinkingLevels: STANDARD_LEVELS },
	{ id: "claude-sonnet-5", name: "Claude Sonnet 5", contextWindow: 1_000_000, thinkingLevels: STANDARD_LEVELS },
	{ id: "deepseek-3.2", name: "DeepSeek 3.2", contextWindow: 164_000, thinkingLevels: STANDARD_LEVELS },
	{ id: "glm-5", name: "GLM-5", contextWindow: 200_000, thinkingLevels: XHIGH_LEVELS },
	{ id: "gpt-5.6-luna", name: "GPT 5.6 Luna", contextWindow: 272_000, thinkingLevels: GPT_5_6_LEVELS },
	{ id: "gpt-5.6-sol", name: "GPT 5.6 Sol", contextWindow: 272_000, thinkingLevels: GPT_5_6_LEVELS },
	{ id: "gpt-5.6-terra", name: "GPT 5.6 Terra", contextWindow: 272_000, thinkingLevels: GPT_5_6_LEVELS },
	{ id: "minimax-m2.1", name: "MiniMax M2.1", contextWindow: 196_000, thinkingLevels: XHIGH_LEVELS },
	{ id: "minimax-m2.5", name: "MiniMax M2.5", contextWindow: 196_000, thinkingLevels: XHIGH_LEVELS },
	{ id: "qwen3-coder-next", name: "Qwen3 Coder Next", contextWindow: 256_000, thinkingLevels: STANDARD_LEVELS },
] as const;

export const KIRO_STATIC_SEED: readonly Model<"kiro-streaming">[] = KIRO_MODEL_SPECS.map(
	({ thinkingLevels, ...spec }) => ({
		...spec,
		api: "kiro-streaming",
		provider: "kiro",
		baseUrl: KIRO_RUNTIME_URL,
		reasoning: true,
		thinking: thinkingConfig(thinkingLevels),
		input: ["text"],
		cost: KIRO_ZERO_COST,
		maxTokens: KIRO_MAX_OUTPUT_TOKENS,
	}),
);

export function kiroModelManagerOptions(config: { apiKey?: string }): ModelManagerOptions<"kiro-streaming"> {
	const access = config.apiKey ? parseKiroAccessContext(config.apiKey) : undefined;
	return {
		providerId: "kiro",
		staticModels: [...KIRO_STATIC_SEED],
		// A credential-supplied ARN is server-confirmed and authoritative.
		...(access
			? {
					fetchDynamicModels: () =>
						fetchKiroModels({
							accessToken: access.token,
							profileArn: access.profileArn,
						}),
				}
			: undefined),
	};
}
