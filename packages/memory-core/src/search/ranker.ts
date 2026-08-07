import { invalidInput, type MemoryResult } from "../errors";

export type RankRetrievalStage = "map-route" | "metadata" | "heading" | "lexical" | "fuzzy";
export type RankVolatility = "stable" | "volatile" | "historical";

export interface RankComponentScores {
	readonly stage?: number;
	readonly metadata?: number;
	readonly heading?: number;
	readonly lexical?: number;
	readonly fuzzy?: number;
}

export interface RankCandidate {
	readonly uri: string;
	readonly stage?: RankRetrievalStage;
	readonly stages?: readonly RankRetrievalStage[];
	readonly stageScore?: number;
	readonly metadataScore?: number;
	readonly headingScore?: number;
	readonly lexicalScore?: number;
	readonly fuzzyScore?: number;
	readonly componentScores?: RankComponentScores;
	readonly authority?: string | number;
	readonly authorityTier?: string | number;
	readonly scope?: string | number;
	readonly scopeKind?: string | number;
	readonly freshness?: string | number;
	readonly freshnessScore?: number;
	readonly updatedAt?: string;
	readonly volatility?: RankVolatility | string | number;
}

export interface RankContext {
	readonly asOf: string;
	readonly stageWeights?: Partial<Readonly<Record<RankRetrievalStage, number>>>;
	readonly authorityWeights?: Readonly<Record<string, number>>;
	readonly scopeWeights?: Readonly<Record<string, number>>;
	readonly volatilityWeights?: Readonly<Record<string, number>>;
	readonly freshnessHalfLifeDays?: number;
}

export interface RankFactorBreakdown {
	readonly stage: number;
	readonly metadata: number;
	readonly heading: number;
	readonly lexical: number;
	readonly fuzzy: number;
	readonly authority: number;
	readonly scope: number;
	readonly freshness: number;
	readonly volatility: number;
	readonly weightedSignal: number;
	readonly contextMultiplier: number;
}

export interface RankedCandidate {
	readonly uri: string;
	readonly score: number;
	readonly factors: RankFactorBreakdown;
}

export const RANK_SCORE_SCALE = 1_000_000;

const AS_OF_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const DAY_MS = 86_400_000;
const DEFAULT_SIGNAL_WEIGHTS = Object.freeze({ stage: 0.3, metadata: 0.2, heading: 0.15, lexical: 0.2, fuzzy: 0.15 });
const DEFAULT_STAGE_VALUES: Readonly<Record<RankRetrievalStage, number>> = Object.freeze({
	"map-route": 1,
	metadata: 0.85,
	heading: 0.75,
	lexical: 0.65,
	fuzzy: 0.55,
});
const DEFAULT_AUTHORITY_VALUES: Readonly<Record<string, number>> = Object.freeze({
	"user-confirmed": 1,
	"repository-reviewed": 0.9,
	"project-config": 0.8,
	"tool-verified": 0.7,
	"session-observed": 0.6,
	"model-inferred": 0.4,
	unverified: 0.1,
});
const DEFAULT_SCOPE_VALUES: Readonly<Record<string, number>> = Object.freeze({
	global: 0.5,
	project: 0.75,
	session: 1,
});
const DEFAULT_VOLATILITY_VALUES: Readonly<Record<string, number>> = Object.freeze({
	stable: 1,
	historical: 0.85,
	volatile: 0.65,
});

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function invalid(detail: string): MemoryResult<never> {
	return invalidInput(`ranker: ${detail}`);
}

function parseAsOf(asOf: string): MemoryResult<number> {
	if (!AS_OF_PATTERN.test(asOf)) return invalid("asOf must be strict UTC ISO-8601");
	const milliseconds = Date.parse(asOf);
	return Number.isFinite(milliseconds) ? { ok: true, value: milliseconds } : invalid("asOf is not a valid timestamp");
}

function normalizedNumeric(value: number, detail: string): MemoryResult<number> {
	if (!Number.isFinite(value) || value < 0) return invalid(`non-finite ${detail}`);
	if (value <= 1) return { ok: true, value };
	if (value <= RANK_SCORE_SCALE) return { ok: true, value: value / RANK_SCORE_SCALE };
	return invalid(`${detail} exceeds score scale`);
}

function weightValue(
	weights: Readonly<Record<string, number>> | undefined,
	key: string,
	fallback: number,
): MemoryResult<number> {
	const value = weights?.[key] ?? fallback;
	if (!Number.isFinite(value) || value < 0) return invalid(`non-finite weight for ${key}`);
	return { ok: true, value: Math.min(1, value) };
}

function componentValue(value: number | undefined, detail: string): MemoryResult<number> {
	return value === undefined ? { ok: true, value: 0 } : normalizedNumeric(value, detail);
}

function stageValue(candidate: RankCandidate, context: RankContext): MemoryResult<number> {
	const explicit = candidate.componentScores?.stage ?? candidate.stageScore;
	if (explicit !== undefined) return componentValue(explicit, "stage score");
	const stages = candidate.stages ?? (candidate.stage === undefined ? [] : [candidate.stage]);
	if (stages.length === 0) return { ok: true, value: 0 };
	let best = 0;
	for (const stage of stages) {
		const defaultValue = DEFAULT_STAGE_VALUES[stage];
		if (defaultValue === undefined) return invalid(`unknown retrieval stage ${stage}`);
		const value = context.stageWeights?.[stage] ?? defaultValue;
		if (!Number.isFinite(value) || value < 0) return invalid(`non-finite stage weight for ${stage}`);
		best = Math.max(best, Math.min(1, value));
	}
	return { ok: true, value: best };
}

function authorityValue(candidate: RankCandidate, context: RankContext): MemoryResult<number> {
	const value = candidate.authority ?? candidate.authorityTier;
	if (typeof value === "number") return normalizedNumeric(value, "authority score");
	const key = (value ?? "unverified").normalize("NFC").toLowerCase();
	return weightValue(context.authorityWeights, key, DEFAULT_AUTHORITY_VALUES[key] ?? 0);
}

function scopeValue(candidate: RankCandidate, context: RankContext): MemoryResult<number> {
	const value = candidate.scope ?? candidate.scopeKind;
	if (typeof value === "number") return normalizedNumeric(value, "scope score");
	const key = (value ?? "global").normalize("NFC").toLowerCase();
	return weightValue(context.scopeWeights, key, DEFAULT_SCOPE_VALUES[key] ?? 0);
}

function freshnessValue(
	candidate: RankCandidate,
	context: RankContext,
	asOfMilliseconds: number,
): MemoryResult<number> {
	const direct = candidate.freshnessScore;
	if (direct !== undefined) return normalizedNumeric(direct, "freshness score");
	const freshness = candidate.freshness ?? candidate.updatedAt;
	if (freshness === undefined) return { ok: true, value: 0.5 };
	if (typeof freshness === "number") return normalizedNumeric(freshness, "freshness score");
	if (!AS_OF_PATTERN.test(freshness)) return invalid("freshness timestamp must be strict UTC ISO-8601");
	const updatedMilliseconds = Date.parse(freshness);
	if (!Number.isFinite(updatedMilliseconds)) return invalid("freshness timestamp is not valid");
	const halfLife = context.freshnessHalfLifeDays ?? 30;
	if (!Number.isFinite(halfLife) || halfLife <= 0) return invalid("freshness half-life must be positive and finite");
	const ageDays = Math.max(0, asOfMilliseconds - updatedMilliseconds) / DAY_MS;
	const score = Math.exp(-ageDays / halfLife);
	if (!Number.isFinite(score)) return invalid("non-finite freshness score");
	return { ok: true, value: Math.max(0, Math.min(1, score)) };
}

function volatilityValue(candidate: RankCandidate, context: RankContext): MemoryResult<number> {
	const value = candidate.volatility;
	if (typeof value === "number") {
		const normalized = normalizedNumeric(value, "volatility score");
		if (!normalized.ok) return normalized;
		return { ok: true, value: Math.min(1, normalized.value) };
	}
	const key = (value ?? "stable").normalize("NFC").toLowerCase();
	return weightValue(context.volatilityWeights, key, DEFAULT_VOLATILITY_VALUES[key] ?? 0);
}

function rankOne(
	candidate: RankCandidate,
	context: RankContext,
	asOfMilliseconds: number,
): MemoryResult<RankedCandidate> {
	const uri = candidate.uri.normalize("NFC");
	if (uri.length === 0) return invalid("candidate URI must not be empty");
	const stage = stageValue(candidate, context);
	if (!stage.ok) return stage;
	const metadata = componentValue(candidate.componentScores?.metadata ?? candidate.metadataScore, "metadata score");
	if (!metadata.ok) return metadata;
	const heading = componentValue(candidate.componentScores?.heading ?? candidate.headingScore, "heading score");
	if (!heading.ok) return heading;
	const lexical = componentValue(candidate.componentScores?.lexical ?? candidate.lexicalScore, "lexical score");
	if (!lexical.ok) return lexical;
	const fuzzy = componentValue(candidate.componentScores?.fuzzy ?? candidate.fuzzyScore, "fuzzy score");
	if (!fuzzy.ok) return fuzzy;
	const authority = authorityValue(candidate, context);
	if (!authority.ok) return authority;
	const scope = scopeValue(candidate, context);
	if (!scope.ok) return scope;
	const freshness = freshnessValue(candidate, context, asOfMilliseconds);
	if (!freshness.ok) return freshness;
	const volatility = volatilityValue(candidate, context);
	if (!volatility.ok) return volatility;

	const weightedSignal =
		stage.value * DEFAULT_SIGNAL_WEIGHTS.stage +
		metadata.value * DEFAULT_SIGNAL_WEIGHTS.metadata +
		heading.value * DEFAULT_SIGNAL_WEIGHTS.heading +
		lexical.value * DEFAULT_SIGNAL_WEIGHTS.lexical +
		fuzzy.value * DEFAULT_SIGNAL_WEIGHTS.fuzzy;
	const contextMultiplier = authority.value * scope.value * freshness.value * volatility.value;
	const rawScore = weightedSignal * contextMultiplier;
	if (!Number.isFinite(weightedSignal) || !Number.isFinite(contextMultiplier) || !Number.isFinite(rawScore)) {
		return invalid(`non-finite ranking state for ${uri}`);
	}
	const score = Math.round(Math.max(0, Math.min(1, rawScore)) * RANK_SCORE_SCALE);
	if (!Number.isInteger(score) || score < 0 || score > RANK_SCORE_SCALE)
		return invalid(`invalid ranked score for ${uri}`);
	return {
		ok: true,
		value: Object.freeze({
			uri,
			score,
			factors: Object.freeze({
				stage: stage.value,
				metadata: metadata.value,
				heading: heading.value,
				lexical: lexical.value,
				fuzzy: fuzzy.value,
				authority: authority.value,
				scope: scope.value,
				freshness: freshness.value,
				volatility: volatility.value,
				weightedSignal,
				contextMultiplier,
			}),
		}),
	};
}

/** Deterministically combine retrieval signals and metadata without resolving conflicts. */
export function rankCandidates(
	candidates: readonly RankCandidate[],
	context: RankContext,
): MemoryResult<RankedCandidate[]> {
	if (!Array.isArray(candidates)) return invalid("candidates must be an array");
	const asOf = parseAsOf(context.asOf);
	if (!asOf.ok) return asOf;
	const ranked: RankedCandidate[] = [];
	const seenUris = new Set<string>();
	for (const candidate of candidates) {
		const normalizedUri = candidate.uri.normalize("NFC");
		if (seenUris.has(normalizedUri)) return invalid(`duplicate candidate URI ${normalizedUri}`);
		seenUris.add(normalizedUri);
		const result = rankOne(candidate, context, asOf.value);
		if (!result.ok) return result;
		ranked.push(result.value);
	}
	ranked.sort((left, right) => right.score - left.score || compareUtf8(left.uri, right.uri));
	return { ok: true, value: ranked };
}
