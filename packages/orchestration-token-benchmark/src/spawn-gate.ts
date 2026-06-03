/**
 * Deterministic spawn-plan gate decision function.
 *
 * Pure model of the hard spawn gate: batches above the hard threshold are
 * rejected unless a complete spawn-plan receipt is supplied. This module makes
 * no spawning decisions itself; it only evaluates a request, so it can be unit
 * tested and used by the benchmark without touching the task runtime.
 *
 * The runtime contract is HARD: `evaluateSpawnGate` always enforces
 * {@link DEFAULT_SPAWN_THRESHOLD} and exposes no override, so a caller cannot
 * raise the boundary to skip the receipt. Threshold sweeps for benchmark
 * scenarios use the clearly-labeled, benchmark-only
 * {@link evaluateSpawnGateAtThreshold}; that helper never represents the
 * enforced runtime gate.
 */

/** The hard, locked batch threshold enforced by the runtime gate. */
export const DEFAULT_SPAWN_THRESHOLD = 4;

/** The justification a large batch must supply to pass the hard gate. */
export interface SpawnPlanReceipt {
	whyParallel: string;
	whyNotLocal: string;
	independence: string;
	expectedReceiptShape: string;
	maxInlineTokens: number;
}

export interface SpawnGateRequest {
	/** Number of children the batch wants to spawn. */
	childCount: number;
	/** The spawn-plan receipt, when provided. */
	plan?: SpawnPlanReceipt;
}

export type SpawnGateOutcome = "allowed" | "rejected";

export interface SpawnGateDecision {
	outcome: SpawnGateOutcome;
	/** Human-readable reason, suitable for a blocked-result message. */
	reason: string;
	/** Whether a plan was required for this request. */
	planRequired: boolean;
	/** Missing plan field names when rejected for an incomplete plan. */
	missingFields: readonly string[];
}

const REQUIRED_STRING_FIELDS = ["whyParallel", "whyNotLocal", "independence", "expectedReceiptShape"] as const;

function findMissingPlanFields(plan: SpawnPlanReceipt | undefined): string[] {
	if (plan === undefined) {
		return [...REQUIRED_STRING_FIELDS, "maxInlineTokens"];
	}
	const missing: string[] = [];
	for (const field of REQUIRED_STRING_FIELDS) {
		const value = plan[field];
		if (typeof value !== "string" || value.trim().length === 0) {
			missing.push(field);
		}
	}
	if (
		typeof plan.maxInlineTokens !== "number" ||
		!Number.isFinite(plan.maxInlineTokens) ||
		plan.maxInlineTokens <= 0
	) {
		missing.push("maxInlineTokens");
	}
	return missing;
}

function decide(childCount: number, threshold: number, plan: SpawnPlanReceipt | undefined): SpawnGateDecision {
	if (!Number.isInteger(childCount) || childCount < 0) {
		throw new RangeError("childCount must be a non-negative integer");
	}
	if (!Number.isInteger(threshold) || threshold < 1) {
		throw new RangeError("threshold must be a positive integer");
	}

	const planRequired = childCount > threshold;
	if (!planRequired) {
		return {
			outcome: "allowed",
			reason: `batch of ${childCount} is at or below threshold ${threshold}`,
			planRequired: false,
			missingFields: [],
		};
	}

	const missingFields = findMissingPlanFields(plan);
	if (missingFields.length > 0) {
		return {
			outcome: "rejected",
			reason: `batch of ${childCount} exceeds threshold ${threshold} and the spawn-plan receipt is ${
				plan === undefined ? "missing" : `incomplete (${missingFields.join(", ")})`
			}`,
			planRequired: true,
			missingFields,
		};
	}

	return {
		outcome: "allowed",
		reason: `batch of ${childCount} exceeds threshold ${threshold} and a complete spawn-plan receipt was provided`,
		planRequired: true,
		missingFields: [],
	};
}

/**
 * Evaluate a spawn request against the HARD runtime gate.
 *
 * The threshold is locked at {@link DEFAULT_SPAWN_THRESHOLD} and cannot be
 * overridden; every batch with `childCount > DEFAULT_SPAWN_THRESHOLD` requires a
 * complete {@link SpawnPlanReceipt}. A missing or incomplete plan is rejected.
 */
export function evaluateSpawnGate(request: SpawnGateRequest): SpawnGateDecision {
	return decide(request.childCount, DEFAULT_SPAWN_THRESHOLD, request.plan);
}

/**
 * Benchmark-only threshold sweep. NOT the enforced runtime gate: it lets the
 * deterministic benchmark explore alternative thresholds (e.g. to recommend a
 * tuned N) without representing what the runtime enforces. Production code must
 * use {@link evaluateSpawnGate}.
 */
export function evaluateSpawnGateAtThreshold(
	childCount: number,
	threshold: number,
	plan?: SpawnPlanReceipt,
): SpawnGateDecision {
	return decide(childCount, threshold, plan);
}
