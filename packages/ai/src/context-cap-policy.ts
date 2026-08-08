import type { Api, Model } from "./types";

/**
 * Codex GPT-5.6 OAuth context-window policy.
 *
 * Authoritative source and ownership path
 * ---------------------------------------
 * The authenticated Codex backend discovery endpoint (`GET {base}/codex/models`
 * with an OAuth bearer token) is the authoritative runtime source of Codex OAuth
 * model context-window metadata (`models[].context_window`). OpenAI owns that
 * value; GJC consumes it read-only via `fetchCodexModels` and must not silently
 * invent a larger limit without upstream evidence.
 *
 * This bundled policy is a client-side conservative guard, not a primary source.
 * It exists because OpenAI temporarily reverted the GPT-5.6 Sol product context
 * limit from 372K to 272K on 2026-07-13 (staff announcement quoted in
 * gajae-code issues #2240 / #2260), while planning to restore 372K later.
 * `ceiling` must only be raised with an upstream evidence citation; an
 * unverified report that "372K is live again" is not sufficient.
 *
 * Precedence (highest -> lowest)
 * ------------------------------
 * 1. Explicit user per-model override (`contextWindow` in `modelOverrides`).
 *    The model registry merges it into `model.contextWindow` before this cap and
 *    passes it here; it is honored when a positive finite number, with
 *    diagnostics emitted at the registry. Never silently discarded.
 * 2. Live OAuth discovery metadata (`context_window`), capped at `ceiling`.
 * 3. Bundled conservative `fallback`, used when discovery metadata is
 *    absent or invalid.
 */
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

/**
 * Applies the final Codex GPT-5.6 context ceiling, honoring explicit user
 * overrides.
 *
 * `userContextWindowOverrides` maps lowercased model ids to the user's explicit
 * `contextWindow` value (already merged into `model.contextWindow` by the model
 * registry). A tier model present with a positive finite value keeps its value
 * even above `enforced` — the user's explicit, diagnosed choice. Every other tier
 * model is forced to `enforced`, so a stale larger live/cached observation
 * (e.g. a pre-rollback 373K cache) cannot resurface without an override.
 */
export function applyFinalCodexGpt56ContextCap<TApi extends Api>(
	models: readonly Model<TApi>[],
	policy: CodexGpt56ContextCapPolicy = CODEX_GPT_5_6_CONTEXT_CAP,
	userContextWindowOverrides: ReadonlyMap<string, number> = new Map(),
): Model<TApi>[] {
	return models.map(model => {
		if (!isCodexGpt56Tier(model as Model<Api>) || !isCodexProductTransport(model as Model<Api>)) {
			return model;
		}
		const userOverride = userContextWindowOverrides.get(model.id.toLowerCase());
		if (userOverride !== undefined && isPositiveFiniteNumber(userOverride)) {
			return model;
		}
		return { ...model, contextWindow: policy.enforced };
	});
}

function isPositiveFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}
