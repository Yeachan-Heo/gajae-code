/**
 * operate(goal) — autonomous owner-driven lifecycle (M9) integrating the recovery loop (M6).
 *
 * start -> submit(single-flight) -> [observe -> classify -> recover]* -> finalize(evidence-gated).
 * Destructive recovery (restart-clean/preserve-delta/fallback) writes a valid `vanish` receipt
 * BEFORE acting; dirty/unknown deltas are preserved, never clean-restarted. The loop is bounded
 * by `maxIterations` and the per-classification retry budgets.
 *
 * External effects (RPC, observation, validation/git/gh) are injected so the whole lifecycle is
 * unit/e2e-testable with a fake harness.
 */
import { randomBytes } from "node:crypto";
import { type FinalizeChecks, type FinalizeResult, runFinalize, type ValidationCommandSpec } from "./finalize";
import { type PreserveResult, preserveDirtyWorktree } from "./preserve";
import {
	buildReceipt,
	type ReceiptSubject,
	requiresVanishBeforeAction,
	type VanishEvidence,
	validateReceipt,
} from "./receipts";
import { type HarnessSessionTransport, singleFlightAccept } from "./session-transport";
import { writeReceiptImmutable } from "./storage";
import {
	DEFAULT_RETRY_BUDGET,
	type HarnessLifecycle,
	type Observation,
	type RecoveryClassification,
	type RetryBudget,
	type Severity,
} from "./types";

export interface OperateOptions {
	root: string;
	sessionId: string;
	workspace: string;
	branch: string;
	transport: HarnessSessionTransport;
	/** Factory used to recreate an SDK transport on restart recovery. Defaults to reusing `transport`. */
	transportFactory?: () => HarnessSessionTransport;
	/** Bounded observation provider (scripted in tests; real = git + SDK session state). */
	observe: () => Promise<Observation>;
	/** Real dirty-worktree preservation; injectable for tests. Defaults to git stash/diff capture. */
	preserve?: (workspace: string) => PreserveResult;
	finalizeChecks: FinalizeChecks;
	validationCommands?: ValidationCommandSpec[];
	retryBudget?: Partial<RetryBudget>;
	acceptanceTimeoutMs?: number;
	maxIterations?: number;
	/** Injected event emitter. Production owner calls must pass the lease-guarded single-writer #emit. */
	emit: (severity: Severity, kind: string, evidence: Record<string, unknown>) => Promise<void>;
	clock?: () => number;
}

export interface OperateResult {
	completed: boolean;
	lifecycle: HarnessLifecycle;
	iterations: number;
	classifications: RecoveryClassification[];
	vanishReceiptIds: string[];
	finalize?: FinalizeResult;
	blockers: string[];
}

export async function operate(goal: string, opts: OperateOptions): Promise<OperateResult> {
	const budget: RetryBudget = { ...DEFAULT_RETRY_BUDGET, ...opts.retryBudget };
	const acceptanceTimeoutMs = opts.acceptanceTimeoutMs ?? 30_000;
	const maxIterations = opts.maxIterations ?? 10;
	const subject: ReceiptSubject = { workspace: opts.workspace, branch: opts.branch, head: null, commit: null };
	const classifications: RecoveryClassification[] = [];
	const vanishReceiptIds: string[] = [];
	const blockers: string[] = [];

	let transport = opts.transport;

	const now = (): string => new Date(opts.clock ? opts.clock() : Date.now()).toISOString();
	let lifecycle: HarnessLifecycle = "started";
	const emit = opts.emit;

	const writeVanish = async (obs: Observation, classification: RecoveryClassification): Promise<boolean> => {
		const dirty = obs.gitDelta === "dirty" || obs.gitDelta === "unknown";
		let untrackedManifest: VanishEvidence["untrackedManifest"] = [];
		let stashRef: string | null = null;
		let snapshotComplete = true;
		let gitStatusPorcelain = obs.observedSignals.join(",");
		if (dirty) {
			const preserve = opts.preserve ?? preserveDirtyWorktree;
			const p = preserve(opts.workspace);
			untrackedManifest = p.untrackedManifest;
			stashRef = p.stashRef;
			snapshotComplete = p.snapshotComplete;
			gitStatusPorcelain = `tracked-diff-sha:${p.trackedDiffSha256};untracked:${p.untrackedManifest.length};stash:${p.stashRef ?? "none"}`;
		}
		const evidence: VanishEvidence = {
			classification,
			gitDelta: obs.gitDelta,
			gitStatusPorcelain,
			untrackedManifest,
			preservation: dirty && stashRef ? "stash" : "snapshot",
			stashRef,
			snapshotComplete,
			forbiddenActions: dirty ? ["restart-clean", "delete", "reset"] : [],
		};
		const receipt = buildReceipt<VanishEvidence>({
			receiptId: `vanish-${Date.now()}-${randomBytes(4).toString("hex")}`,
			sessionId: opts.sessionId,
			family: "vanish",
			source: "operate",
			subject,
			evidence,
			createdAt: now(),
		});
		const outcome = validateReceipt(receipt);
		await writeReceiptImmutable(opts.root, opts.sessionId, "vanish", receipt.receiptId, receipt);
		vanishReceiptIds.push(receipt.receiptId);
		await emit(outcome.valid ? "critical" : "warn", "vanish_receipt", { classification, valid: outcome.valid });
		return outcome.valid;
	};

	const submit = async (): Promise<boolean> => {
		const acc = await singleFlightAccept(transport, goal, acceptanceTimeoutMs);
		await emit(acc.accepted ? "info" : "warn", acc.accepted ? "prompt_accepted" : "prompt_not_accepted", {
			reason: acc.reason,
		});
		return acc.accepted;
	};

	await emit("info", "operate_started", { goal });
	let accepted = await submit();
	lifecycle = accepted ? "observing" : "submitted";
	let iterations = 0;

	while (iterations < maxIterations) {
		iterations++;
		const obs = await opts.observe();
		const decision = classifyRecoveryLocal(obs, budget, accepted);
		classifications.push(decision.classification);
		await emit(decision.severity, `classified:${decision.classification}`, { reason: decision.reason });

		if (decision.classification === "continue") {
			if (obs.observedSignals.includes("completed") || obs.lifecycle === "finalizing") {
				lifecycle = "finalizing";
				break;
			}
			continue;
		}

		// Destructive/recovery actions require a valid vanish receipt first.
		if (requiresVanishBeforeAction(decision.classification)) {
			const safe = await writeVanish(obs, decision.classification);
			if (!safe) {
				lifecycle = "blocked";
				blockers.push("invalid-vanish-receipt");
				break;
			}
		}

		if (decision.classification === "reinject-prompt") {
			budget.reinjectPrompt = Math.max(0, budget.reinjectPrompt - 1);
			accepted = await submit();
		} else if (decision.classification === "restart-clean") {
			budget.zeroDeltaVanish = Math.max(0, budget.zeroDeltaVanish - 1);
			transport = opts.transportFactory ? opts.transportFactory() : transport;
			accepted = await submit();
		} else if (decision.classification === "restart-preserve-delta") {
			budget.dirtyVanishPreserve = Math.max(0, budget.dirtyVanishPreserve - 1);
			transport = opts.transportFactory ? opts.transportFactory() : transport;
			accepted = await submit();
		} else if (decision.classification === "fallback-codex-exec") {
			lifecycle = "blocked";
			blockers.push("fallback-codex-exec-requested");
			break;
		} else if (decision.classification === "human-check") {
			lifecycle = "blocked";
			blockers.push("human-check-required");
			break;
		}
	}

	if (lifecycle === "blocked") {
		await emit("critical", "operate_blocked", { blockers });
		return { completed: false, lifecycle, iterations, classifications, vanishReceiptIds, blockers };
	}

	// B3: never finalize on loop-exhaustion — require an explicit observed completion.
	if (lifecycle !== "finalizing") {
		blockers.push("no-observed-completion");
		await emit("critical", "operate_blocked", { blockers });
		return { completed: false, lifecycle: "blocked", iterations, classifications, vanishReceiptIds, blockers };
	}

	const finalize = await runFinalize({
		root: opts.root,
		sessionId: opts.sessionId,
		workspace: opts.workspace,
		branch: opts.branch,
		requireTests: true,
		requireCommit: true,
		requirePr: true,
		validationCommands: opts.validationCommands,
		checks: opts.finalizeChecks,
		clock: opts.clock,
	});
	await emit(finalize.completed ? "info" : "critical", "operate_finalized", {
		completed: finalize.completed,
		blockers: finalize.blockers,
	});
	return {
		completed: finalize.completed,
		lifecycle: finalize.completed ? "completed" : "blocked",
		iterations,
		classifications,
		vanishReceiptIds,
		finalize,
		blockers: finalize.blockers,
	};
}

// Local import indirection keeps the classifier dependency explicit at the call site.
import { classifyRecovery } from "./classifier";
import type { RecoveryDecision } from "./types";

function classifyRecoveryLocal(obs: Observation, budget: RetryBudget, acceptedPromptActive: boolean): RecoveryDecision {
	return classifyRecovery({ observation: obs, retryBudget: budget, acceptedPromptActive });
}
