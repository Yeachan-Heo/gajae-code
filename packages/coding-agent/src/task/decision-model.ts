/**
 * Wire contract for the subagent tier decision.
 *
 * Scope, deliberately narrow: the only decision modelled here is the tier
 * `choice` among `fast | balanced | strong`, consumed in `shadow` or `routing`
 * mode. This is **not** a complete implementation of #5842 — there is no `noul`
 * delegation decision and no advisory `hint` output, and neither is planned in
 * this change. #5842 stays open pending the owner's data-scope decision.
 */
export const DECISION_TIERS = ["fast", "balanced", "strong"] as const;
export type DecisionTier = (typeof DECISION_TIERS)[number];
export type DecisionCandidates = Readonly<Partial<Record<DecisionTier, string>>>;
export type DecisionProbabilities = Readonly<Partial<Record<DecisionTier, number>>>;

export interface DecisionRequest {
	readonly role: string;
	readonly assignment: string;
	readonly candidates: DecisionCandidates;
}

export interface DecisionResult {
	readonly choice: DecisionTier;
	readonly probabilities: DecisionProbabilities;
	readonly confidence: number;
	readonly reportedModel?: string;
}

export type DecisionErrorCode =
	| "aborted"
	| "timeout"
	| "no_candidate"
	| "invalid_configuration"
	| "credential_unavailable"
	| "auth_401"
	| "auth_403"
	| "http_error"
	| "response_too_large"
	| "invalid_json"
	| "invalid_candidate"
	| "invalid_probability"
	| "invalid_response"
	| "request_too_large"
	| "unavailable"
	| "transport_error";
export interface DecisionError {
	readonly code: DecisionErrorCode;
}
export type DecisionOutcome =
	| { readonly result: DecisionResult; readonly error?: undefined }
	| { readonly result?: undefined; readonly error: DecisionError };
export interface DecisionProvider {
	decide(request: DecisionRequest, options?: { readonly signal?: AbortSignal }): Promise<DecisionOutcome>;
}
export interface DecisionProviderConfig {
	readonly timeoutMs: number;
	readonly credentialSessionId?: string;
}

const MARKER = "…[truncated]";
const MAX_BYTES = 4096;
/** A role is an agent name, not free text. */
export const MAX_ROLE_BYTES = 256;
/** A tier candidate is a short description of when that tier applies. */
export const MAX_CANDIDATE_BYTES = 512;
/**
 * Ceiling on the whole serialized request.
 *
 * Bounding each field is not the same as bounding the request: the prompt, the
 * model alias and three candidates are all caller-influenced, and a provider —
 * remote and billable in Jev's case — must never be handed an unbounded body.
 */
export const MAX_REQUEST_BYTES = 16 * 1024;

export function truncateUtf8(value: string, maxBytes = MAX_BYTES): string {
	if (maxBytes <= 0) return "";
	const input = String(value);
	const encoder = new TextEncoder();
	const prefix = (text: string, budget: number): string => {
		let bytes = 0;
		let end = 0;
		for (const character of text) {
			bytes += encoder.encode(character).byteLength;
			if (bytes > budget) break;
			end += character.length;
		}
		return text.slice(0, end);
	};
	const bounded = prefix(input, maxBytes);
	if (bounded.length === input.length) return input;
	const markerBytes = encoder.encode(MARKER).byteLength;
	if (maxBytes < markerBytes) return prefix(MARKER, maxBytes);
	return prefix(bounded, maxBytes - markerBytes) + MARKER;
}

export function normalizeDecisionRequest(request: DecisionRequest): DecisionRequest {
	const candidates: Partial<Record<DecisionTier, string>> = {};
	for (const tier of DECISION_TIERS) {
		const description = request.candidates?.[tier];
		if (typeof description === "string" && description.length > 0)
			candidates[tier] = truncateUtf8(description, MAX_CANDIDATE_BYTES);
	}
	return Object.freeze({
		role: truncateUtf8(String(request.role), MAX_ROLE_BYTES),
		assignment: truncateUtf8(request.assignment),
		candidates: Object.freeze(candidates),
	});
}

export function validateDecisionResult(value: unknown, candidates: DecisionCandidates): DecisionResult | undefined {
	return validateDecisionResultDetailed(value, candidates).result;
}

export function validateDecisionResultDetailed(
	value: unknown,
	candidates: DecisionCandidates,
): { result?: DecisionResult; error?: "invalid_candidate" | "invalid_probability" | "invalid_response" } {
	if (!value || typeof value !== "object") return { error: "invalid_response" };
	const record = value as Record<string, unknown>;
	const present = DECISION_TIERS.filter(tier => Object.hasOwn(candidates, tier));
	if (present.length === 0 || typeof record.choice !== "string" || !present.includes(record.choice as DecisionTier))
		return { error: "invalid_candidate" };
	if (!record.probabilities || typeof record.probabilities !== "object") return { error: "invalid_probability" };
	const probabilities = record.probabilities as Record<string, unknown>;
	const normalized: Partial<Record<DecisionTier, number>> = {};
	let sum = 0;
	for (const tier of present) {
		const probability = probabilities[tier];
		if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1)
			return { error: "invalid_probability" };
		normalized[tier] = probability;
		sum += probability;
	}
	if (Object.keys(probabilities).some(key => !present.includes(key as DecisionTier)) || Math.abs(sum - 1) > 1e-6)
		return { error: "invalid_probability" };
	if (
		typeof record.confidence !== "number" ||
		!Number.isFinite(record.confidence) ||
		record.confidence < 0 ||
		record.confidence > 1
	)
		return { error: "invalid_response" };
	const reportedModel = typeof record.reportedModel === "string" ? record.reportedModel.slice(0, 256) : undefined;
	return {
		result: {
			choice: record.choice as DecisionTier,
			probabilities: Object.freeze(normalized),
			confidence: record.confidence,
			...(reportedModel ? { reportedModel } : {}),
		},
	};
}
