/**
 * Deterministic token-efficiency metrics.
 *
 * Every function here is pure and side-effect free: given the same input it
 * returns the same output, with no provider, network, clock, or filesystem
 * access. This is what lets the suite assert orchestration token efficiency in
 * CI without any live-model calls.
 */

/**
 * A single persisted per-turn / per-subagent token record.
 *
 * Structurally mirrors `TaskTokenLog` from
 * `@gajae-code/coding-agent` (`src/task/types.ts`). It is duplicated here so the
 * benchmark stays dependency-free and deterministic; `assertTokenLogShape`
 * guards against drift.
 */
export interface TokenLogEntry {
	subagentId: string;
	agent?: string;
	turn: number;
	at: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	contextTokens?: number;
	cost?: number;
	model?: string;
}

/** Deterministic aggregate token metrics over a set of token logs. */
export interface TokenMetrics {
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	/** cacheRead / (input + cacheRead); 0 when there is no input-class traffic. */
	cacheHitRate: number;
}

/**
 * Prompt-cache hit rate: cached input reads as a fraction of all input-class
 * tokens. Returns 0 when there is no input-class traffic (avoids NaN), so the
 * metric is always a finite number in [0, 1].
 */
export function cacheHitRate(input: number, cacheRead: number): number {
	const denominator = input + cacheRead;
	if (denominator <= 0) {
		return 0;
	}
	return cacheRead / denominator;
}

/** Aggregate a set of token logs into deterministic totals + cache-hit-rate. */
export function computeTokenMetrics(logs: readonly TokenLogEntry[]): TokenMetrics {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let totalTokens = 0;
	for (const log of logs) {
		inputTokens += log.input;
		outputTokens += log.output;
		cacheReadTokens += log.cacheRead;
		cacheWriteTokens += log.cacheWrite;
		totalTokens += log.totalTokens;
	}
	return {
		turns: logs.length,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalTokens,
		cacheHitRate: cacheHitRate(inputTokens, cacheReadTokens),
	};
}

/**
 * Receipt-to-artifact byte ratio: how small the model-facing receipt is
 * relative to the full artifact. Lower is better (less context spent on what a
 * receipt could convey). Returns 0 when the artifact is empty.
 */
export function receiptArtifactRatio(receiptBytes: number, artifactBytes: number): number {
	if (artifactBytes <= 0) {
		return 0;
	}
	return receiptBytes / artifactBytes;
}

/**
 * Estimated tokens cloned into a forked child context. A deterministic stand-in
 * for fork-context cost: `inheritedTokens` minus what a bounded mode would keep.
 * Never returns negative.
 */
export function forkClonedTokens(inheritedTokens: number, retainedTokens: number): number {
	return Math.max(0, inheritedTokens - retainedTokens);
}

const TOKEN_LOG_NUMERIC_KEYS = ["turn", "input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;

/**
 * Runtime guard that an arbitrary value is a structurally valid token log.
 * Used by fixtures and tests so malformed fixtures fail loudly instead of
 * silently skewing metrics, and to catch drift from the source-of-truth type.
 */
export function assertTokenLogShape(value: unknown): asserts value is TokenLogEntry {
	if (value === null || typeof value !== "object") {
		throw new TypeError("token log must be an object");
	}
	const record = value as Record<string, unknown>;
	if (typeof record.subagentId !== "string" || record.subagentId.length === 0) {
		throw new TypeError("token log requires a non-empty string subagentId");
	}
	if (typeof record.at !== "string" || record.at.length === 0) {
		throw new TypeError("token log requires a non-empty string at");
	}
	for (const key of TOKEN_LOG_NUMERIC_KEYS) {
		const numeric = record[key];
		if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric < 0) {
			throw new TypeError(`token log field ${key} must be a finite, non-negative number`);
		}
	}
}
