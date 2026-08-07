import { invalidInput, type MemoryResult } from "../errors";
import { tokenizeLexical } from "./lexical-search";

export interface HeadingSearchDocument {
	readonly uri: string;
	readonly sections: readonly {
		readonly heading: string;
		readonly slug: string;
		readonly startLine: number;
		readonly endLine: number;
		readonly content?: string;
	}[];
}

export interface HeadingSearchHit {
	readonly uri: string;
	readonly heading: string;
	readonly slug: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly score: number;
	readonly matchedTokens: readonly string[];
}

export interface HeadingSearchResult {
	readonly hits: readonly HeadingSearchHit[];
	readonly candidateCount: number;
}

const SCORE_SCALE = 1_000_000;

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left.normalize("NFC"), "utf8"), Buffer.from(right.normalize("NFC"), "utf8"));
}

function invalid(detail: string): MemoryResult<never> {
	return invalidInput(`heading search: ${detail}`);
}

function normalized(value: string): string {
	return value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function overlap(
	queryTokens: readonly string[],
	heading: string,
): { readonly score: number; readonly matchedTokens: readonly string[] } {
	const headingTokens = tokenizeLexical(heading);
	if (queryTokens.length === 0 || headingTokens.length === 0) return { score: 0, matchedTokens: [] };
	const headingSet = new Set(headingTokens);
	const matched = [...new Set(queryTokens.filter(token => headingSet.has(token)))].sort(compareUtf8);
	if (matched.length === 0) return { score: 0, matchedTokens: [] };
	const ratio = matched.length / Math.max(queryTokens.length, headingSet.size);
	return {
		score: Math.max(1, Math.min(SCORE_SCALE, Math.round(ratio * 900_000))),
		matchedTokens: Object.freeze(matched),
	};
}

/** Match query terms against section headings without reading or tokenizing body text. */
export function headingSearch(
	query: string,
	documents: readonly HeadingSearchDocument[],
): MemoryResult<HeadingSearchResult> {
	if (typeof query !== "string") return invalid("query must be a string");
	if (!Array.isArray(documents)) return invalid("documents must be an array");
	const canonicalQuery = normalized(query);
	const queryTokens = tokenizeLexical(canonicalQuery);
	if (queryTokens.length === 0) return invalid("query must contain at least one letter or number");
	const hits: HeadingSearchHit[] = [];
	const seenUris = new Set<string>();
	for (const document of documents) {
		if (document === null || typeof document !== "object" || Array.isArray(document))
			return invalid("document must be an object");
		if (typeof document.uri !== "string") return invalid("document URI must be a string");
		const uri = document.uri.normalize("NFC");
		if (uri.length === 0) return invalid("document URI must not be empty");
		if (seenUris.has(uri)) return invalid(`duplicate document URI ${uri}`);
		seenUris.add(uri);
		if (!Array.isArray(document.sections)) return invalid(`sections for ${uri} must be an array`);
		for (const section of document.sections) {
			if (section === null || typeof section !== "object" || Array.isArray(section))
				return invalid("section must be an object");
			if (
				typeof section.heading !== "string" ||
				typeof section.slug !== "string" ||
				!Number.isSafeInteger(section.startLine) ||
				!Number.isSafeInteger(section.endLine) ||
				section.startLine < 1 ||
				section.endLine < section.startLine
			) {
				return invalid(`section metadata for ${uri} is invalid`);
			}
			const heading = normalized(section.heading);
			const slug = normalized(section.slug);
			if (heading.length === 0 || slug.length === 0) continue;
			let score = 0;
			let matchedTokens: readonly string[] = [];
			if (canonicalQuery === heading || canonicalQuery === slug) {
				score = SCORE_SCALE;
				matchedTokens = Object.freeze(tokenizeLexical(heading).sort(compareUtf8));
			} else {
				const result = overlap(queryTokens, heading);
				score = result.score;
				matchedTokens = result.matchedTokens;
				if (score === 0) {
					const slugResult = overlap(queryTokens, slug);
					score = Math.round(slugResult.score * 0.95);
					matchedTokens = slugResult.matchedTokens;
				}
			}
			if (score <= 0) continue;
			hits.push(
				Object.freeze({
					uri,
					heading: section.heading.normalize("NFC"),
					slug: section.slug.normalize("NFC"),
					startLine: section.startLine,
					endLine: section.endLine,
					score: Math.max(0, Math.min(SCORE_SCALE, Math.round(score))),
					matchedTokens,
				}),
			);
		}
	}
	hits.sort(
		(left, right) =>
			right.score - left.score ||
			compareUtf8(left.uri, right.uri) ||
			left.startLine - right.startLine ||
			compareUtf8(left.slug, right.slug),
	);
	return {
		ok: true,
		value: Object.freeze({
			hits: Object.freeze(hits),
			candidateCount: documents.length,
		}),
	};
}
