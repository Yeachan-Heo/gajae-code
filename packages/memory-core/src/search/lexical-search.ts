import { invalidInput, type MemoryResult } from "../errors";

export interface LexicalDocument {
	readonly uri: string;
	readonly text: string;
}

export interface LexicalSearchHit {
	readonly uri: string;
	readonly score: number;
	readonly matchedTokens: readonly string[];
}

export interface LexicalSearchResult {
	readonly hits: readonly LexicalSearchHit[];
	readonly candidateCount: number;
	readonly averageLength: number;
}

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
export const BM25_DELTA = 1;
export const SCORE_SCALE = 1_000_000;

interface SearchDocument {
	readonly uri: string;
	readonly tokens: readonly string[];
	readonly termFrequencies: ReadonlyMap<string, number>;
	readonly length: number;
}

interface ScoredDocument {
	readonly document: SearchDocument;
	readonly rawScore: number;
	readonly matchedTokens: readonly string[];
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function invalid(detail: string): MemoryResult<never> {
	return invalidInput(`lexical search: ${detail}`);
}

/** The shared M2 tokenizer: NFC, lowercase, Unicode letters/numbers, no stemming or stopwords. */
export function tokenizeLexical(value: string): string[] {
	if (typeof value !== "string") return [];
	const normalized = value.normalize("NFC").toLowerCase();
	return normalized.split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 0);
}

function buildDocument(document: LexicalDocument): MemoryResult<SearchDocument> {
	if (typeof document !== "object" || document === null || Array.isArray(document)) {
		return invalid("document must be an object");
	}
	if (typeof document.uri !== "string") return invalid("document URI must be a string");
	if (typeof document.text !== "string") return invalid("document text must be a string");
	const uri = document.uri.normalize("NFC");
	if (uri.length === 0) return invalid("document URI must not be empty");
	const tokens = tokenizeLexical(document.text);
	const termFrequencies = new Map<string, number>();
	for (const token of tokens) termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1);
	if (!Number.isFinite(tokens.length)) return invalid(`non-finite document length for ${uri}`);
	return {
		ok: true,
		value: Object.freeze({
			uri,
			tokens: Object.freeze(tokens),
			termFrequencies,
			length: tokens.length,
		}),
	};
}

function queryCounts(tokens: readonly string[]): ReadonlyMap<string, number> {
	const counts = new Map<string, number>();
	for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
	return counts;
}

function finitePositive(value: number, detail: string): MemoryResult<number> {
	return Number.isFinite(value) && value > 0 ? { ok: true, value } : invalid(detail);
}

/** Pure deterministic BM25 over the supplied candidate set only. */
export function lexicalSearch(query: string, documents: readonly LexicalDocument[]): MemoryResult<LexicalSearchResult> {
	if (typeof query !== "string") return invalid("query must be a string");
	if (!Array.isArray(documents)) return invalid("documents must be an array");
	const queryTokens = tokenizeLexical(query);
	if (queryTokens.length === 0) return invalid("query must contain at least one letter or number");
	const built: SearchDocument[] = [];
	const seenUris = new Set<string>();
	for (const document of documents) {
		const result = buildDocument(document);
		if (!result.ok) return result;
		if (seenUris.has(result.value.uri)) return invalid(`duplicate document URI ${result.value.uri}`);
		seenUris.add(result.value.uri);
		built.push(result.value);
	}
	if (built.length === 0) {
		return {
			ok: true,
			value: Object.freeze({ hits: Object.freeze([]), candidateCount: 0, averageLength: 0 }),
		};
	}

	const averageLength = built.reduce((sum, document) => sum + document.length, 0) / built.length;
	if (!Number.isFinite(averageLength) || averageLength <= 0) {
		if (built.every(document => document.length === 0)) {
			return {
				ok: true,
				value: Object.freeze({ hits: Object.freeze([]), candidateCount: built.length, averageLength: 0 }),
			};
		}
		return invalid("non-finite average document length");
	}

	const documentFrequencies = new Map<string, number>();
	for (const document of built) {
		for (const token of document.termFrequencies.keys()) {
			documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
		}
	}
	const counts = queryCounts(queryTokens);
	const scored: ScoredDocument[] = [];
	for (const document of built) {
		let rawScore = 0;
		const matchedTokens: string[] = [];
		for (const [token, queryCount] of counts) {
			const termFrequency = document.termFrequencies.get(token) ?? 0;
			if (termFrequency <= 0) continue;
			matchedTokens.push(token);
			const documentFrequency = documentFrequencies.get(token) ?? 0;
			const idf = Math.log(1 + (built.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
			const normalization = BM25_K1 * (1 - BM25_B + BM25_B * (document.length / averageLength));
			const termScore =
				queryCount * idf * ((termFrequency * (BM25_K1 + 1)) / (termFrequency + normalization) + BM25_DELTA);
			if (!Number.isFinite(idf) || !Number.isFinite(normalization) || !Number.isFinite(termScore)) {
				return invalid(`non-finite BM25 state for ${document.uri}`);
			}
			rawScore += termScore;
		}
		if (!Number.isFinite(rawScore)) return invalid(`non-finite BM25 score for ${document.uri}`);
		if (rawScore > 0) {
			scored.push({ document, rawScore, matchedTokens: Object.freeze(matchedTokens) });
		}
	}

	if (scored.length === 0) {
		return {
			ok: true,
			value: Object.freeze({ hits: Object.freeze([]), candidateCount: built.length, averageLength }),
		};
	}
	const maximumScoreResult = finitePositive(
		scored.reduce((maximum, item) => Math.max(maximum, item.rawScore), 0),
		"non-finite maximum BM25 score",
	);
	if (!maximumScoreResult.ok) return maximumScoreResult;
	const maximumScore = maximumScoreResult.value;

	const hits: LexicalSearchHit[] = [];
	for (const item of scored) {
		const normalizedScore = item.rawScore / maximumScore;
		if (!Number.isFinite(normalizedScore) || normalizedScore < 0 || normalizedScore > 1) {
			return invalid(`non-finite normalized BM25 score for ${item.document.uri}`);
		}
		const score = Math.round(normalizedScore * SCORE_SCALE);
		if (!Number.isInteger(score) || score < 0 || score > SCORE_SCALE) {
			return invalid(`invalid quantized BM25 score for ${item.document.uri}`);
		}
		hits.push({ uri: item.document.uri, score, matchedTokens: item.matchedTokens });
	}
	hits.sort((left, right) => right.score - left.score || compareUtf8(left.uri, right.uri));
	return {
		ok: true,
		value: Object.freeze({
			hits: Object.freeze(hits.map(hit => Object.freeze(hit))),
			candidateCount: built.length,
			averageLength,
		}),
	};
}
