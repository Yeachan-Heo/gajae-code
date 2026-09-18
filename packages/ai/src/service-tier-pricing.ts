import type { Usage } from "./types";

/**
 * Cost correction for requests served at a non-standard processing tier.
 *
 * Model catalogs carry standard-tier prices only. When a request is served at a
 * premium tier (OpenAI Fast mode / priority) or a discounted one (flex, billed
 * at Batch API rates), the real charge is a multiple of the catalog price and
 * `calculateCost` alone reports the wrong number.
 *
 * The multiplier is keyed on the tier the provider reports it *served*, never on
 * the tier that was requested. OpenAI's ramp rate limit downgrades a Fast
 * request to standard speed, charges standard rates, and reports
 * `service_tier: "default"`; the SDK documents this on the response field
 * itself ("This response value may be different from the value set in the
 * parameter"). Pricing off request intent would overcharge exactly those
 * requests.
 */

/** OpenAI flex: billed at Batch API rates, i.e. half of standard. */
const OPENAI_FLEX_MULTIPLIER = 0.5;

/** OpenAI Fast mode / priority: per-token premium over standard processing. */
const OPENAI_PRIORITY_MULTIPLIER = 2;

/**
 * `gpt-5.5` carries a steeper priority premium than the rest of the family.
 * Preserved from the Codex adapter's original table.
 */
const OPENAI_PRIORITY_MULTIPLIER_GPT_5_5 = 2.5;

/**
 * Scale the cost components of an already-priced `Usage` in place.
 *
 * `calculateCost` must have run first; this only rescales its output. A
 * multiplier of exactly 1 is a no-op, so standard-tier requests keep the catalog
 * figure untouched.
 */
export function applyServiceTierCostMultiplier(usage: Usage, multiplier: number): void {
	if (multiplier === 1) return;
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

/**
 * Multiplier for the tier OpenAI reports on the response/chunk object.
 *
 * `"default"` is the explicit standard-tier answer (including a ramp-rate
 * downgrade of a Fast request) and prices at 1. An absent or unrecognized value
 * also prices at 1: without a served-tier signal the catalog price is the only
 * defensible number, and inferring one from request intent is precisely what
 * overcharges a downgraded request.
 *
 * `"fast"` is accepted alongside `"priority"` because OpenAI renamed Priority
 * processing to Fast mode and both values are valid on the wire; GPT-5.6 and
 * earlier report `priority` for either spelling.
 */
export function getOpenAIServedTierMultiplier(modelId: string, servedTier: unknown): number {
	switch (servedTier) {
		case "flex":
			return OPENAI_FLEX_MULTIPLIER;
		case "priority":
		case "fast":
			return modelId === "gpt-5.5" ? OPENAI_PRIORITY_MULTIPLIER_GPT_5_5 : OPENAI_PRIORITY_MULTIPLIER;
		default:
			return 1;
	}
}
