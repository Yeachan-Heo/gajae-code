/**
 * Cross-target conflict detection (jev-code addition).
 *
 * `detectReviewConflicts` in the sibling module pairs findings by exact
 * `targetId` equality and an incompatible-action table. That is fast, exact,
 * and blind in one direction: Architect saying "remove the retry wrapper in
 * module A" and Critic saying "add retry at the caller in module B" carry
 * different targetIds, so no conflict is derived and a plan reaches approval
 * holding a contradiction the gate exists to catch.
 *
 * This pass covers only what the table cannot see. The table stays the fast
 * path and is not modified.
 *
 * Failure policy: this is an ADDITIVE safety net over an existing exact check.
 * A missing API key, a network error, or a malformed answer must never block a
 * ralplan pass that would otherwise proceed, so every failure degrades to "no
 * extra conflicts found" and is reported in `skipped`/`errors` rather than
 * thrown. The exact check is unaffected either way.
 */

import { JevClient } from "@gajae-code/ai/core";
import {
	actionsAreIncompatible,
	type ReviewConflict,
	type ReviewFinding,
} from "./ralplan-review-conflicts";

/** Above this, the pair opens a conflict needing a disposition. */
export const DEFAULT_SEMANTIC_CONFLICT_THRESHOLD = 0.7;

/**
 * Bounded so a pathological pass cannot spend unbounded time or money. 12
 * architect findings against 10 critic findings is 120 pairs, comfortably
 * inside this.
 */
export const DEFAULT_MAX_PAIRS = 400;

export interface SemanticConflictOptions {
	client?: JevClient;
	threshold?: number;
	maxPairs?: number;
	/** Parallel in-flight requests. One subject per request, so pairs fan out. */
	concurrency?: number;
}

export interface SemanticConflictResult {
	conflicts: ReviewConflict[];
	/** Pairs actually sent. */
	evaluated: number;
	/** Why the pass did nothing, when it did nothing. */
	skipped?: "not_configured" | "no_candidate_pairs" | "pair_budget_exceeded";
	/** Per-pair failures. The pass still returns whatever succeeded. */
	errors: string[];
}

interface Pair {
	left: ReviewFinding;
	right: ReviewFinding;
}

/**
 * Cross-role pairs on DIFFERENT targets. Same-target pairs are the exact
 * check's business and are never re-judged here.
 *
 * `clarify` is excluded: it asks for information rather than prescribing work,
 * so it cannot contradict anything. The action table treats it the same way.
 */
export function candidateCrossTargetPairs(findings: readonly ReviewFinding[]): Pair[] {
	const pairs: Pair[] = [];
	for (let i = 0; i < findings.length; i++) {
		for (let j = i + 1; j < findings.length; j++) {
			const a = findings[i]!;
			const b = findings[j]!;
			if (a.sourceRole === b.sourceRole) continue;
			if (a.targetId === b.targetId) continue;
			if (a.action === "clarify" || b.action === "clarify") continue;
			const [left, right] = a.findingId <= b.findingId ? [a, b] : [b, a];
			pairs.push({ left, right });
		}
	}
	return pairs.sort((x, y) => x.left.findingId.localeCompare(y.left.findingId));
}

/**
 * A stable id that cannot collide with the exact check's
 * `conflict:<targetId>:<a>:<b>`, because findingIds cannot contain `:` in a
 * way that reproduces this prefix.
 */
export function semanticConflictId(left: ReviewFinding, right: ReviewFinding): string {
	return `conflict:semantic:${left.findingId}:${right.findingId}`;
}

/** One pair per request: several subjects in one state is the documented failure. */
function stateForPair(pair: Pair): Record<string, unknown> {
	return {
		finding_a: {
			role: pair.left.sourceRole,
			action: pair.left.action,
			target: pair.left.targetId,
			evidence: pair.left.evidence,
		},
		finding_b: {
			role: pair.right.sourceRole,
			action: pair.right.action,
			target: pair.right.targetId,
			evidence: pair.right.evidence,
		},
	};
}

const QUESTION = {
	type: "noul",
	instructions: {
		question:
			"Do `finding_a` and `finding_b` prescribe changes that cannot both be carried out in the same plan?",
		guidance: [
			"Answer about the prescribed work, not about the wording.",
			"They name different targets on purpose. Different targets are not by itself a conflict.",
			"A conflict means doing both leaves the plan incoherent or undoes one of them.",
			"Two findings that simply touch related code, or that could both be applied in sequence, are not in conflict.",
		],
	},
} as const;

async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await fn(items[index]!);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * Judge cross-target pairs and return the ones above threshold as conflicts in
 * the same shape the exact check produces, so `applyDispositions` and
 * `evaluateReviewJoinGate` handle them without changes.
 */
export async function detectSemanticReviewConflicts(
	findings: readonly ReviewFinding[],
	options: SemanticConflictOptions = {},
): Promise<SemanticConflictResult> {
	const client = options.client ?? new JevClient();
	const threshold = options.threshold ?? DEFAULT_SEMANTIC_CONFLICT_THRESHOLD;
	const maxPairs = options.maxPairs ?? DEFAULT_MAX_PAIRS;
	const concurrency = Math.max(1, options.concurrency ?? 12);

	if (!client.isConfigured()) return { conflicts: [], evaluated: 0, skipped: "not_configured", errors: [] };

	const pairs = candidateCrossTargetPairs(findings);
	if (pairs.length === 0) return { conflicts: [], evaluated: 0, skipped: "no_candidate_pairs", errors: [] };
	if (pairs.length > maxPairs) {
		return { conflicts: [], evaluated: 0, skipped: "pair_budget_exceeded", errors: [] };
	}

	const errors: string[] = [];
	const settled = await mapWithConcurrency(pairs, concurrency, async pair => {
		try {
			const response = await client.systemOne(stateForPair(pair), { conflicting: QUESTION });
			const answer = response.answers.conflicting;
			if (answer?.type !== "noul") {
				errors.push(`${semanticConflictId(pair.left, pair.right)}: unexpected answer shape`);
				return undefined;
			}
			return { pair, noul: answer.noul };
		} catch (error) {
			errors.push(`${semanticConflictId(pair.left, pair.right)}: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	});

	const conflicts: ReviewConflict[] = [];
	for (const entry of settled) {
		if (!entry || entry.noul < threshold) continue;
		const { left, right } = entry.pair;
		conflicts.push({
			conflictId: semanticConflictId(left, right),
			// The exact check keys conflicts by a shared target. These pairs have
			// none, so the field carries both, keeping the type unchanged while
			// staying honest about what was compared.
			targetId: `${left.targetId}|${right.targetId}`,
			findingIds: [left.findingId, right.findingId],
			actions: [left.action, right.action],
			sourceRoles: [left.sourceRole, right.sourceRole],
			status: "open",
		});
	}

	return {
		conflicts: conflicts.sort((x, y) => x.conflictId.localeCompare(y.conflictId)),
		evaluated: pairs.length,
		errors,
	};
}

/** Re-exported so callers importing this module can reuse the exact check. */
export { actionsAreIncompatible };
