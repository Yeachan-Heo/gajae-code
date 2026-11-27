import { describe, expect, it } from "bun:test";
import { fuzzyMatch } from "../src/fuzzy";

// Reference scorer: enumerates every alignment of the query in the text and
// applies the documented per-character rules, with the original word-boundary
// regex as the oracle for the boundary predicate.
const WORD_BOUNDARY = /[\s\-_./:]/;

function exhaustiveBestScore(queryLower: string, textLower: string): number {
	let best = Number.POSITIVE_INFINITY;
	const visit = (queryIndex: number, lastMatch: number, run: number, score: number): void => {
		if (queryIndex === queryLower.length) {
			best = Math.min(best, score);
			return;
		}
		for (let i = lastMatch + 1; i < textLower.length; i++) {
			if (textLower[i] !== queryLower[queryIndex]) continue;
			let next = score;
			let nextRun = 0;
			if (lastMatch === i - 1) {
				nextRun = run + 1;
				next -= nextRun * 5;
			} else if (lastMatch >= 0) {
				next += (i - lastMatch - 1) * 2;
			}
			if (i === 0 || WORD_BOUNDARY.test(textLower[i - 1]!)) next -= 10;
			next += i * 0.1;
			visit(queryIndex + 1, i, nextRun, next);
		}
	};
	visit(0, -1, 0, 0);
	return best;
}

describe("fuzzyMatch alignment", () => {
	it("scores generated query/text pairs exactly like an exhaustive alignment search", () => {
		let state = 0x7417;
		const next = () => {
			state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
			return state / 4_294_967_296;
		};
		// Repeated letters force competing alignments; every boundary class is present.
		// No digits, so the alphanumeric-swap fallback never runs and only the direct
		// alignment is compared.
		const textAlphabet = "abmod- /._:\t ";
		const queryAlphabet = "abmod";
		const pick = (alphabet: string, length: number) =>
			Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");

		let matched = 0;
		for (let iteration = 0; iteration < 5_000; iteration++) {
			const text = pick(textAlphabet, 1 + Math.floor(next() * 12));
			const query = pick(queryAlphabet, 1 + Math.floor(next() * 5));
			const expected = exhaustiveBestScore(query, text);
			const actual = fuzzyMatch(query, text);

			expect(actual.matches).toBe(expected !== Number.POSITIVE_INFINITY);
			if (!actual.matches) continue;
			matched++;
			expect(actual.score).toBeCloseTo(expected, 9);
		}
		// Guard against a generator that stops producing matches.
		expect(matched).toBeGreaterThan(500);
	});

	it("scores long generated texts like a memoized search over every alignment state", () => {
		// On long texts position and gap costs can outweigh match bonuses, so an
		// alignment that wrongly skips query characters can beat the real one; short
		// texts cannot expose that. Exhaustive enumeration is too slow here, so the
		// reference memoizes the same rules over (query index, last match, run).
		let state = 0x5eed;
		const next = () => {
			state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
			return state / 4_294_967_296;
		};
		const textAlphabet = "abmod- /._:";
		const queryAlphabet = "abmod";
		const pick = (alphabet: string, length: number) =>
			Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");

		const memoizedBestScore = (queryLower: string, textLower: string): number => {
			const memo = new Map<number, number>();
			const n = textLower.length;
			const m = queryLower.length;
			// Best score for query[queryIndex..] given the previous match and run length.
			const best = (queryIndex: number, lastMatch: number, run: number): number => {
				if (queryIndex === m) return 0;
				const key = (queryIndex * (n + 1) + lastMatch + 1) * (m + 2) + run;
				const cached = memo.get(key);
				if (cached !== undefined) return cached;
				let result = Number.POSITIVE_INFINITY;
				for (let i = lastMatch + 1; i < n; i++) {
					if (textLower[i] !== queryLower[queryIndex]) continue;
					let cost = i * 0.1;
					let nextRun = 0;
					if (lastMatch === i - 1) {
						nextRun = run + 1;
						cost -= nextRun * 5;
					} else if (lastMatch >= 0) {
						cost += (i - lastMatch - 1) * 2;
					}
					if (i === 0 || WORD_BOUNDARY.test(textLower[i - 1]!)) cost -= 10;
					result = Math.min(result, cost + best(queryIndex + 1, i, nextRun));
				}
				memo.set(key, result);
				return result;
			};
			return best(0, -1, 0);
		};

		let matched = 0;
		for (let iteration = 0; iteration < 1_500; iteration++) {
			const text = pick(textAlphabet, 20 + Math.floor(next() * 61));
			const query = pick(queryAlphabet, 2 + Math.floor(next() * 7));
			const expected = memoizedBestScore(query, text);
			const actual = fuzzyMatch(query, text);

			expect(actual.matches).toBe(expected !== Number.POSITIVE_INFINITY);
			if (!actual.matches) continue;
			matched++;
			expect(actual.score).toBeCloseTo(expected, 9);
		}
		expect(matched).toBeGreaterThan(500);
	});

	it("treats exactly the original boundary characters as word boundaries for every UTF-16 code unit", () => {
		for (let code = 0; code <= 0xffff; code++) {
			const text = `${String.fromCharCode(code)}b`;
			const textLower = text.toLowerCase();
			// Skip code units whose lowercase form is or contains the query letter.
			if (textLower.indexOf("b") !== textLower.length - 1) continue;
			const actual = fuzzyMatch("b", text);
			const expected = exhaustiveBestScore("b", textLower);
			if (Math.abs(actual.score - expected) > 1e-9) {
				throw new Error(
					`boundary mismatch at U+${code.toString(16).padStart(4, "0")}: ${actual.score} vs ${expected}`,
				);
			}
		}
	});
});
