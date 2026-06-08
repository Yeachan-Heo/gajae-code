/** The hard, locked batch threshold enforced by the runtime gate. */
export const DEFAULT_SPAWN_THRESHOLD = 4;

/** The justification a large batch or reviewer-spawned explorer must supply to pass the hard gate. */
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

export interface ReviewerExploreGateRequest {
	/** Agent type/name doing the spawning, when known. */
	spawningAgentType?: string | null;
	/** Target agent type/name requested by the task call. */
	targetAgent: string;
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

export function findMissingPlanFields(plan: SpawnPlanReceipt | undefined): string[] {
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

export function decide(childCount: number, threshold: number, plan: SpawnPlanReceipt | undefined): SpawnGateDecision {
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

export function evaluateSpawnGate(request: SpawnGateRequest): SpawnGateDecision {
	return decide(request.childCount, DEFAULT_SPAWN_THRESHOLD, request.plan);
}

export function evaluateReviewerExploreGate(request: ReviewerExploreGateRequest): SpawnGateDecision {
	if (request.spawningAgentType !== "reviewer" || request.targetAgent !== "explore") {
		return {
			outcome: "allowed",
			reason: "reviewer->explore gate does not apply",
			planRequired: false,
			missingFields: [],
		};
	}

	const missingFields = findMissingPlanFields(request.plan);
	if (missingFields.length > 0) {
		return {
			outcome: "rejected",
			reason: `reviewer->explore spawn requires a complete spawn-plan receipt (${missingFields.join(", ")})`,
			planRequired: true,
			missingFields,
		};
	}

	return {
		outcome: "allowed",
		reason: "reviewer->explore spawn has a complete spawn-plan receipt",
		planRequired: true,
		missingFields: [],
	};
}
