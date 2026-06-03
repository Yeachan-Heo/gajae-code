/**
 * Deterministic baseline fixtures for the orchestration-token benchmark.
 *
 * These are fixed, hand-authored inputs (no recorded live sessions, no clock,
 * no randomness) so every metric, prefix-stability check, and spawn-gate
 * decision is reproducible in CI.
 */

import type { TokenLogEntry } from "./metrics";
import type { PrefixTurn } from "./prefix-stability";
import type { SpawnGateRequest } from "./spawn-gate";

/** A run with strong prompt-cache reuse (most input served from cache). */
export const TOKEN_LOG_HIGH_CACHE: readonly TokenLogEntry[] = [
	{
		subagentId: "root",
		turn: 1,
		at: "2026-01-01T00:00:00.000Z",
		input: 1000,
		output: 200,
		cacheRead: 0,
		cacheWrite: 1000,
		totalTokens: 2200,
		model: "test-model",
	},
	{
		subagentId: "root",
		turn: 2,
		at: "2026-01-01T00:01:00.000Z",
		input: 50,
		output: 150,
		cacheRead: 1000,
		cacheWrite: 0,
		totalTokens: 1200,
		model: "test-model",
	},
	{
		subagentId: "root",
		turn: 3,
		at: "2026-01-01T00:02:00.000Z",
		input: 50,
		output: 150,
		cacheRead: 1050,
		cacheWrite: 0,
		totalTokens: 1250,
		model: "test-model",
	},
];

/** A run with poor cache reuse (input re-sent uncached every turn). */
export const TOKEN_LOG_LOW_CACHE: readonly TokenLogEntry[] = [
	{
		subagentId: "root",
		turn: 1,
		at: "2026-01-01T00:00:00.000Z",
		input: 1000,
		output: 200,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 1200,
		model: "test-model",
	},
	{
		subagentId: "root",
		turn: 2,
		at: "2026-01-01T00:01:00.000Z",
		input: 1100,
		output: 150,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 1250,
		model: "test-model",
	},
];

/** Stable epoch: identical prefix/model/cacheKey, only appended content. */
export const PREFIX_STABLE: readonly PrefixTurn[] = [
	{ turn: 1, prefix: "SYSTEM+TOOLS", model: "test-model", cacheKey: "session-1" },
	{ turn: 2, prefix: "SYSTEM+TOOLS", model: "test-model", cacheKey: "session-1" },
	{ turn: 3, prefix: "SYSTEM+TOOLS", model: "test-model", cacheKey: "session-1" },
];

/** Violation: mid-epoch prefix mutation with no reset marker. */
export const PREFIX_MUTATION_FAIL: readonly PrefixTurn[] = [
	{ turn: 1, prefix: "SYSTEM+TOOLS", model: "test-model", cacheKey: "session-1" },
	{ turn: 2, prefix: "SYSTEM+TOOLS+EXTRA", model: "test-model", cacheKey: "session-1" },
];

/** Sanctioned: model switch carrying a deliberate reset marker opens a new epoch. */
export const MODEL_SWITCH_RESET: readonly PrefixTurn[] = [
	{ turn: 1, prefix: "SYSTEM+TOOLS", model: "test-model-a", cacheKey: "session-1" },
	{
		turn: 2,
		prefix: "SYSTEM+TOOLS",
		model: "test-model-b",
		cacheKey: "session-2",
		resetMarker: { reason: "deliberate-reset" },
	},
	{ turn: 3, prefix: "SYSTEM+TOOLS", model: "test-model-b", cacheKey: "session-2" },
];

/** Violation: mid-epoch model switch with no reset marker. */
export const MODEL_SWITCH_FAIL: readonly PrefixTurn[] = [
	{ turn: 1, prefix: "SYSTEM+TOOLS", model: "test-model-a", cacheKey: "session-1" },
	{ turn: 2, prefix: "SYSTEM+TOOLS", model: "test-model-b", cacheKey: "session-1" },
];

/** Batch at threshold: allowed without a plan. */
export const FANOUT_4_OK: SpawnGateRequest = { childCount: 4 };

/** Batch above threshold without a plan: rejected. */
export const FANOUT_5_REJECT: SpawnGateRequest = { childCount: 5 };

/** Batch above threshold with a complete plan: allowed. */
export const FANOUT_5_PLAN_OK: SpawnGateRequest = {
	childCount: 5,
	plan: {
		whyParallel: "five independent packages need isolated edits",
		whyNotLocal: "local search cannot apply cross-file edits in parallel",
		independence: "no shared files between children",
		expectedReceiptShape: "per-child status + changed-file list",
		maxInlineTokens: 2000,
	},
};
