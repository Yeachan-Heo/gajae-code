import type { Api, Model } from "./types";

export interface CodexGpt56ContextCapPolicy {
	fallback: number;
	ceiling: number;
}

export const CODEX_GPT_5_6_CONTEXT_CAP: CodexGpt56ContextCapPolicy = {
	// 372K is the currently enforced usable prompt budget for the OpenAI code
	// backend, but only for the GPT-5.6 tier (raised from 272K); discovery
	// metadata above it is a total-window figure that includes the output budget
	// and must not be trusted as input.
	fallback: 372_000,
	ceiling: 372_000,
};

/**
 * Generic usable prompt budget for OpenAI code backend models outside the
 * GPT-5.6 tier (e.g. gpt-5.5, gpt-5.4-codex, gpt-5.6-codex). Kept separate from
 * {@link CODEX_GPT_5_6_CONTEXT_CAP} so a future authority raise for the 5.6
 * tier never leaks a larger fallback into unrelated Codex discovery rows.
 */
export const CODEX_GENERIC_CONTEXT_WINDOW = 272_000;

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
	if (!isCodexGpt56Tier(model) || !isCodexProductTransport(model)) {
		// Non-5.6 rows keep the generic Codex prompt budget as their fallback;
		// live observations still pass through (the 272K pin for gpt-5.5 and
		// gpt-5.6-codex is applied later by the generated-catalog policy).
		return isPositiveFiniteNumber(rawContextWindow) ? rawContextWindow : CODEX_GENERIC_CONTEXT_WINDOW;
	}
	const observed = isPositiveFiniteNumber(rawContextWindow) ? rawContextWindow : policy.fallback;
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
