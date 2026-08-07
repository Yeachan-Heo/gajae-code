import type { Api, Model } from "./types";

export interface CodexGpt56ContextCapPolicy {
	/**
	 * Usable prompt budget forced for the GPT-5.6 tier on the Codex product
	 * transport. The live OpenAI code backend metadata still reports the old
	 * 272K budget (or the total-window figure), so this is an explicit product
	 * override: the tier is forced to the enforced window regardless of what
	 * discovery reports.
	 */
	enforced: number;
}

export const CODEX_GPT_5_6_CONTEXT_CAP: CodexGpt56ContextCapPolicy = {
	enforced: 372_000,
};

/**
 * Generic usable prompt budget for OpenAI code backend models outside the
 * GPT-5.6 tier (e.g. gpt-5.5, gpt-5.4-codex, gpt-5.6-codex). Kept separate from
 * {@link CODEX_GPT_5_6_CONTEXT_CAP} so the forced 5.6-tier window never leaks
 * into unrelated Codex discovery rows.
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
	// Force the enforced window: the backend's current metadata under-reports
	// the GPT-5.6 tier budget, and stale smaller observations must not win.
	return policy.enforced;
}

export function applyFinalCodexGpt56ContextCap<TApi extends Api>(
	models: readonly Model<TApi>[],
	policy: CodexGpt56ContextCapPolicy = CODEX_GPT_5_6_CONTEXT_CAP,
): Model<TApi>[] {
	return models.map(model => {
		if (!isCodexGpt56Tier(model as Model<Api>) || !isCodexProductTransport(model as Model<Api>)) {
			return model;
		}
		return { ...model, contextWindow: policy.enforced };
	});
}

function isPositiveFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}
