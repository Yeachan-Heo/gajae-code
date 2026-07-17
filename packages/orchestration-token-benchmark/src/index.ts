/**
 * `@gajae-code/orchestration-token-benchmark`
 *
 * A deterministic, internal (NOT user-facing) benchmark for orchestration token
 * efficiency. It measures token metrics, prompt-prefix stability, and spawn-gate
 * decisions from fixed fixtures with no provider, network, or live-model calls,
 * so improvements and regressions are provable in CI.
 */

export {
	type DefaultReductionBenchmarkEvidence,
	type DefaultReductionDecision,
	type DefaultReductionEvidence,
	type DefaultReductionHumanApprovalEvidence,
	evaluateDefaultReduction,
} from "./default-reduction-gate";
export {
	APPLIED_DEFAULT_REDUCTIONS,
	type AppliedDefaultReduction,
	HELD_DEFAULT_REDUCTIONS,
	type HeldDefaultReduction,
} from "./default-reductions.ledger";
export {
	type DeltaReport,
	LIVE_DEFAULT_CANDIDATE_FIXTURE_PAIRS,
	LIVE_RUNNER_SCHEMA_VERSION,
	type LiveRunDelta,
	LiveRunnerError,
	type LiveRunnerFixturePair,
	type LiveRunnerOptions,
	type LiveRunRegression,
	type LiveRunReport,
	type LiveRunTotals,
	type RunOneBinaryOptions,
	renderMarkdownReport,
	runLiveComparison,
	runOneBinary,
} from "./live-runner";
export {
	assertTokenLogShape,
	cacheHitRate,
	computeTokenMetrics,
	forkClonedTokens,
	receiptArtifactRatio,
	type TokenLogEntry,
	type TokenMetrics,
} from "./metrics";
export {
	checkPrefixStability,
	hashPrefix,
	type PrefixResetMarker,
	type PrefixStabilityResult,
	type PrefixTurn,
	type PrefixViolation,
	type PrefixViolationKind,
} from "./prefix-stability";
export {
	DEFAULT_SPAWN_THRESHOLD,
	evaluateSpawnGate,
	evaluateSpawnGateAtThreshold,
	type SpawnGateDecision,
	type SpawnGateOutcome,
	type SpawnGateRequest,
	type SpawnPlanReceipt,
} from "./spawn-gate";

import * as fixtures from "./fixtures";
import { computeTokenMetrics, type TokenMetrics } from "./metrics";
import { checkPrefixStability, type PrefixStabilityResult } from "./prefix-stability";
import { evaluateSpawnGate, type SpawnGateDecision } from "./spawn-gate";

export interface BenchmarkReport {
	tokenMetrics: {
		highCache: TokenMetrics;
		lowCache: TokenMetrics;
	};
	prefixStability: {
		stable: PrefixStabilityResult;
		mutationFail: PrefixStabilityResult;
		modelSwitchReset: PrefixStabilityResult;
	};
	spawnGate: {
		fanout4: SpawnGateDecision;
		fanout5Reject: SpawnGateDecision;
		fanout5PlanOk: SpawnGateDecision;
	};
}

/**
 * Run the full deterministic benchmark over the baseline fixtures and return a
 * structured report. Pure: identical output on every run.
 */
export function runOrchestrationTokenBenchmark(): BenchmarkReport {
	return {
		tokenMetrics: {
			highCache: computeTokenMetrics(fixtures.TOKEN_LOG_HIGH_CACHE),
			lowCache: computeTokenMetrics(fixtures.TOKEN_LOG_LOW_CACHE),
		},
		prefixStability: {
			stable: checkPrefixStability(fixtures.PREFIX_STABLE),
			mutationFail: checkPrefixStability(fixtures.PREFIX_MUTATION_FAIL),
			modelSwitchReset: checkPrefixStability(fixtures.MODEL_SWITCH_RESET),
		},
		spawnGate: {
			fanout4: evaluateSpawnGate(fixtures.FANOUT_4_OK),
			fanout5Reject: evaluateSpawnGate(fixtures.FANOUT_5_REJECT),
			fanout5PlanOk: evaluateSpawnGate(fixtures.FANOUT_5_PLAN_OK),
		},
	};
}

if (import.meta.main) {
	const report = runOrchestrationTokenBenchmark();
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
