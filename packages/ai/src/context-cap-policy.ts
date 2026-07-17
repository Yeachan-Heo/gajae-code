import type { Api, Model } from "./types";

export interface CodexGpt56ContextCapPolicy {
	fallback: number;
	ceiling: number;
}

export const CODEX_GPT_5_6_CONTEXT_CAP: CodexGpt56ContextCapPolicy = {
	fallback: 272_000,
	ceiling: 272_000,
};

const CODEX_GPT_5_6_MODEL_IDS: ReadonlySet<string> = new Set([
	"gpt-5.6",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
]);

export function isCodexProductTransport(model: Pick<Model<Api>, "api" | "provider">): boolean {
	return model.provider === "openai-codex" || model.api === "openai-codex-responses";
}

export function isCodexGpt56Tier(model: Pick<Model<Api>, "id">): boolean {
	return CODEX_GPT_5_6_MODEL_IDS.has(model.id.toLowerCase());
}

export function resolveCodexGpt56DiscoveryContext(
	model: Pick<Model<Api>, "api" | "id" | "provider">,
	rawContextWindow: unknown,
	policy: CodexGpt56ContextCapPolicy = CODEX_GPT_5_6_CONTEXT_CAP,
): number {
	const observed = isPositiveFiniteNumber(rawContextWindow) ? rawContextWindow : policy.fallback;
	if (!isCodexGpt56Tier(model) || !isCodexProductTransport(model)) {
		return observed;
	}
	return Math.min(observed, policy.ceiling);
}

export function applyFinalCodexGpt56ContextCap<TApi extends Api>(
	models: readonly Model<TApi>[],
	policy: CodexGpt56ContextCapPolicy = CODEX_GPT_5_6_CONTEXT_CAP,
): Model<TApi>[] {
	return models.map(model => {
		if (
			!isCodexGpt56Tier(model as Model<Api>) ||
			!isCodexProductTransport(model as Model<Api>) ||
			!isPositiveFiniteNumber(model.contextWindow) ||
			model.contextWindow <= policy.ceiling
		) {
			return model;
		}
		return { ...model, contextWindow: policy.ceiling };
	});
}

function isPositiveFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}
