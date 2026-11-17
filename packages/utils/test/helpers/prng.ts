/**
 * Deterministic PRNGs for fixture generators and property tests.
 *
 * Two algorithms are used across the workspace test trees; they produce
 * different sequences and are not interchangeable:
 *
 * - `mulberry32` — the fixture/property corpus generator.
 * - `lcg32` / `lcgUnit` — the Numerical-Recipes LCG that older suites spelled
 *   `seededRandom` (float) or `mulberry32` (raw 32-bit state).
 */

/** Deterministic mulberry32 PRNG shared by fixture generators and property tests. */
export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Numerical-Recipes LCG emitting the raw 32-bit state; callers use `state % n`. */
export function lcg32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state;
	};
}

/** Same LCG scaled to `[0, 1)`; the former local `seededRandom` spelling. */
export function lcgUnit(seed: number): () => number {
	const next = lcg32(seed);
	return () => next() / 0x1_0000_0000;
}
