/**
 * Fuzzy matching utilities.
 * Matches if all query characters appear in order (not necessarily consecutive).
 * Lower score = better match.
 */

export interface FuzzyMatch {
	matches: boolean;
	score: number;
}

const ALPHANUMERIC_SWAP_PENALTY = 5;

/** Same set as `/[\s\-_./:]/`: whitespace, `-`, `_`, `.`, `/`, `:`. */
function isBoundaryChar(code: number): boolean {
	if (code === 0x2d || code === 0x5f || code === 0x2e || code === 0x2f || code === 0x3a || code === 0x20) return true;
	if (code < 0x80) return code >= 0x09 && code <= 0x0d;
	return /\s/.test(String.fromCharCode(code));
}

function isSubsequence(queryLower: string, textLower: string): boolean {
	let queryIndex = 0;
	for (let i = 0; i < textLower.length && queryIndex < queryLower.length; i++) {
		if (textLower[i] === queryLower[queryIndex]) queryIndex++;
	}
	return queryIndex === queryLower.length;
}

/**
 * Score the best alignment of `queryLower` inside `textLower`.
 *
 * Per matched character at text index `i`:
 * - the k-th character of a consecutive run scores `-5 * k` (a match at index 0
 *   continues a virtual run from index -1);
 * - otherwise the gap since the previous match costs `2` per skipped character;
 * - a word-boundary position scores `-10`;
 * - every match costs `0.1 * i`.
 *
 * Matching each query character at its first occurrence (greedy) misses better
 * alignments later in the text: for "model", greedy scores
 * "src/modes/model-picker.ts" through "mode" in "modes" plus a long gap, so it
 * ranks below "src/mode-list.ts". Instead, `byRun[k * n + i]` holds the best
 * score with the current query character matched at `i` as the k-th character of
 * its run (k = 0: not consecutive), which finds the optimal alignment.
 */
function scoreMatch(queryLower: string, textLower: string): FuzzyMatch {
	const m = queryLower.length;
	const n = textLower.length;
	if (m === 0) {
		return { matches: true, score: 0 };
	}

	if (m > n || !isSubsequence(queryLower, textLower)) {
		return { matches: false, score: 0 };
	}

	const positionScore = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const isWordBoundary = i === 0 || isBoundaryChar(textLower.charCodeAt(i - 1));
		positionScore[i] = i * 0.1 - (isWordBoundary ? 10 : 0);
	}

	// A run of length k ending at i needs the last k text and query characters to
	// be equal, so `suffix[i]` (that common-suffix length) bounds the run states
	// at i. Each layer writes exactly the states 0..suffix[i] that the next layer
	// reads, so the buffers are never cleared and the work per layer is
	// O(n + sum of suffix lengths) rather than O(m · n).
	let byRun = new Float64Array((m + 1) * n);
	let nextByRun = new Float64Array((m + 1) * n);
	// `atIndex[i]`: best score over every run length with the current char at i.
	let atIndex = new Float64Array(n);
	let nextAtIndex = new Float64Array(n);
	let suffix = new Int32Array(n);
	let nextSuffix = new Int32Array(n);
	for (let i = 0; i < n; i++) {
		byRun[i] = Number.POSITIVE_INFINITY;
		atIndex[i] = Number.POSITIVE_INFINITY;
		if (textLower[i] !== queryLower[0]) continue;
		suffix[i] = 1;
		byRun[n + i] = Number.POSITIVE_INFINITY;
		if (i === 0) byRun[n] = positionScore[0]! - 5;
		else byRun[i] = positionScore[i]!;
		atIndex[i] = Math.min(byRun[i]!, byRun[n + i]!);
	}

	for (let q = 1; q < m; q++) {
		const char = queryLower[q];
		nextByRun[0] = Number.POSITIVE_INFINITY;
		nextAtIndex[0] = Number.POSITIVE_INFINITY;
		nextSuffix[0] = 0;
		// Smallest `atIndex[p] - 2 * p` over p <= i - 2, for the gap transition.
		let gapBase = Number.POSITIVE_INFINITY;
		for (let i = 1; i < n; i++) {
			if (i >= 2) gapBase = Math.min(gapBase, atIndex[i - 2]! - 2 * (i - 2));
			if (textLower[i] !== char) {
				nextByRun[i] = Number.POSITIVE_INFINITY;
				nextAtIndex[i] = Number.POSITIVE_INFINITY;
				nextSuffix[i] = 0;
				continue;
			}
			const previousSuffix = suffix[i - 1]!;
			nextSuffix[i] = previousSuffix + 1;
			let bestHere = gapBase + 2 * i - 2 + positionScore[i]!;
			nextByRun[i] = bestHere;
			for (let k = 0; k <= previousSuffix; k++) {
				const run = k + 1;
				const score = byRun[k * n + i - 1]! - run * 5 + positionScore[i]!;
				nextByRun[run * n + i] = score;
				if (score < bestHere) bestHere = score;
			}
			nextAtIndex[i] = bestHere;
		}
		[byRun, nextByRun] = [nextByRun, byRun];
		[atIndex, nextAtIndex] = [nextAtIndex, atIndex];
		[suffix, nextSuffix] = [nextSuffix, suffix];
	}

	let score = Number.POSITIVE_INFINITY;
	for (const value of atIndex) if (value < score) score = value;
	return { matches: true, score };
}

function buildAlphanumericSwapQueries(queryLower: string): string[] {
	const variants = new Set<string>();
	for (let i = 0; i < queryLower.length - 1; i++) {
		const current = queryLower[i];
		const next = queryLower[i + 1];
		const isAlphaNumSwap =
			(current && /[a-z]/.test(current) && next && /\d/.test(next)) ||
			(current && /\d/.test(current) && next && /[a-z]/.test(next));
		if (!isAlphaNumSwap) continue;
		const swapped = queryLower.slice(0, i) + next + current + queryLower.slice(i + 2);
		variants.add(swapped);
	}
	return [...variants];
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
	const queryLower = query.toLowerCase();
	const textLower = text.toLowerCase();

	const direct = scoreMatch(queryLower, textLower);
	if (direct.matches) {
		return direct;
	}

	let bestSwap: FuzzyMatch | null = null;
	for (const variant of buildAlphanumericSwapQueries(queryLower)) {
		const match = scoreMatch(variant, textLower);
		if (!match.matches) continue;
		const score = match.score + ALPHANUMERIC_SWAP_PENALTY;
		if (!bestSwap || score < bestSwap.score) {
			bestSwap = { matches: true, score };
		}
	}

	return bestSwap ?? direct;
}

/**
 * Filter and sort items by fuzzy match quality (best matches first).
 * Supports space-separated tokens: all tokens must match.
 */
export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
	if (!query.trim()) {
		return items;
	}

	const tokens = query
		.trim()
		.split(/\s+/)
		.filter(t => t.length > 0);

	if (tokens.length === 0) {
		return items;
	}

	const results: { item: T; totalScore: number }[] = [];

	for (const item of items) {
		const text = getText(item);
		let totalScore = 0;
		let allMatch = true;

		for (const token of tokens) {
			const match = fuzzyMatch(token, text);
			if (match.matches) {
				totalScore += match.score;
			} else {
				allMatch = false;
				break;
			}
		}

		if (allMatch) {
			results.push({ item, totalScore });
		}
	}

	results.sort((a, b) => a.totalScore - b.totalScore);
	return results.map(r => r.item);
}
