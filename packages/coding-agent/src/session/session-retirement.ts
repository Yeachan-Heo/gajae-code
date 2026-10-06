import * as crypto from "node:crypto";
import * as path from "node:path";
import * as util from "node:util";

import { toError } from "@gajae-code/utils";
import type {
	ManagedGcSessionRetirementReceipt,
	ManagedGcSessionRetirementTarget,
} from "./internal/managed-gc-retirement-codec";
import {
	bindManagedGcSessionRetirementTarget,
	type ManagedScope,
	managedGcProtocolScopeInspectorForScope,
	publishManagedGcSessionRetirementReceipt,
	readManagedGcSessionRetirementReceiptReadOnly,
	taskArtifactOwnerStorageContextForScope,
} from "./internal/managed-session-scope";
import { captureTaskArtifactOwnerDeletionEvidence } from "./internal/task-artifact-owner-access";
import {
	hasSiblingTaskArtifactOwnerTranscript,
	taskArtifactOwnerLocatorFromTranscriptBytes,
} from "./internal/task-artifact-owner-transcript";
import {
	type FileSessionStorage,
	SessionDeleteVerificationError,
	type SessionStorageFileIdentity,
	type SessionStorageSnapshot,
	type VerifiedSessionDeleteTarget,
} from "./session-storage";
import { parseFirstJsonlLine } from "./session-transcript-header";
import type {
	TaskArtifactOwnerDeletionEvidence,
	TaskArtifactOwnerLocator,
	TaskArtifactOwnerRetirementContinuation,
	TaskArtifactOwnerRetirementOutcome,
	TaskArtifactOwnerStorageContext,
} from "./task-artifact-owner-codec";
import {
	retireTaskArtifactOwner,
	verifyTaskArtifactOwnerPhysicalRetirement,
	verifyTaskArtifactOwnerRetirementContinuation,
} from "./task-artifact-owner-retirement";

export interface SessionRetirementContinuation {
	readonly managedScope: ManagedScope;
}

/**
 * Outcome of a disk-retention retirement attempt.
 *
 * `kept` means the transcript survived and nothing of the session was
 * destroyed, with the exact reason so `gjc gc --disk` can report it.
 * `cleanup_pending` means the delete authority already detached or removed the
 * session's artifact tree (or quarantined the transcript) before it stopped:
 * the record survives, the session does not, and a caller must NOT report that
 * as an ordinary keep.
 */
export type SessionRetirementOutcome =
	| { kind: "retired"; taskArtifactOwnerRetired?: true }
	| { kind: "kept"; reason: string }
	| {
			kind: "cleanup_pending";
			reason: string;
			phase?: "artifacts" | "transcript";
			taskArtifactOwnerDeletionEvidence?: TaskArtifactOwnerDeletionEvidence;
			taskArtifactOwnerRetirementOutcome?: TaskArtifactOwnerRetirementOutcome;
			taskArtifactOwnerRetirementContinuation?: TaskArtifactOwnerRetirementContinuation;
			taskArtifactOwnerPayloadRetired?: true;
			taskArtifactOwnerNamespaceRetained?: true;
			taskArtifactOwnerRetired?: true;
	  };

/** A retirement that cleared every precondition the retention pass itself owns. */
type SessionRetirementPlan =
	| {
			kind: "retirable";
			target: VerifiedSessionDeleteTarget;
			artifactsPresent: boolean;
			taskArtifactOwnerLocator?: TaskArtifactOwnerLocator;
			gcContinuationReceipt?: ManagedGcSessionRetirementReceipt;
	  }
	| { kind: "owner_shared"; reason: string; gcContinuationReceipt?: ManagedGcSessionRetirementReceipt }
	| { kind: "cleanup_pending"; reason: string; gcContinuationReceipt: ManagedGcSessionRetirementReceipt }
	| { kind: "kept"; reason: string };

type OwnerRetirementFields = {
	taskArtifactOwnerDeletionEvidence?: TaskArtifactOwnerDeletionEvidence;
	taskArtifactOwnerRetirementOutcome?: TaskArtifactOwnerRetirementOutcome;
	taskArtifactOwnerRetirementContinuation?: TaskArtifactOwnerRetirementContinuation;
	taskArtifactOwnerPayloadRetired?: true;
	taskArtifactOwnerNamespaceRetained?: true;
	taskArtifactOwnerRetired?: true;
};

export type SessionRetirementProbeOutcome =
	| Extract<SessionRetirementOutcome, { kind: "cleanup_pending" }>
	| {
			kind: "retirable";
			taskArtifactOwnerDeletionEvidence?: TaskArtifactOwnerDeletionEvidence;
			taskArtifactOwnerRetirementOutcome?: TaskArtifactOwnerRetirementOutcome;
			taskArtifactOwnerRetired?: true;
			taskArtifactOwnerRetirementContinuation?: TaskArtifactOwnerRetirementContinuation;
			taskArtifactOwnerPayloadRetired?: true;
			taskArtifactOwnerNamespaceRetained?: true;
	  }
	| { kind: "kept"; reason: string };

function isWithinPath(root: string, target: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function sameTranscriptIdentity(left: SessionStorageFileIdentity, right: SessionStorageFileIdentity): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.sha256 === right.sha256
	);
}

function sameManagedGcTarget(left: ManagedGcSessionRetirementTarget, right: ManagedGcSessionRetirementTarget): boolean {
	return (
		left.transcriptPath === right.transcriptPath &&
		left.sessionId === right.sessionId &&
		left.cwd === right.cwd &&
		sameTranscriptIdentity(left.transcriptIdentity, right.transcriptIdentity) &&
		util.isDeepStrictEqual(left.taskArtifactOwnerLocator, right.taskArtifactOwnerLocator)
	);
}

function sameEvidence(left: TaskArtifactOwnerDeletionEvidence, right: TaskArtifactOwnerDeletionEvidence): boolean {
	return util.isDeepStrictEqual(left, right);
}

function targetFromReceipt(receipt: ManagedGcSessionRetirementReceipt): ManagedGcSessionRetirementTarget {
	return {
		transcriptPath: receipt.transcriptPath,
		sessionId: receipt.sessionId,
		cwd: receipt.cwd,
		transcriptIdentity: receipt.transcriptIdentity,
		taskArtifactOwnerLocator: receipt.taskArtifactOwnerLocator,
	};
}

function ownerOutcomeFields(
	evidence: TaskArtifactOwnerDeletionEvidence,
	outcome: TaskArtifactOwnerRetirementOutcome | undefined,
	ownerRetired: boolean,
): OwnerRetirementFields {
	return {
		taskArtifactOwnerDeletionEvidence: evidence,
		...(outcome ? { taskArtifactOwnerRetirementOutcome: outcome } : {}),
		...(outcome && outcome.kind !== "completed"
			? { taskArtifactOwnerRetirementContinuation: outcome.continuation }
			: {}),
		...(outcome?.kind === "payload_retired"
			? { taskArtifactOwnerPayloadRetired: true as const, taskArtifactOwnerNamespaceRetained: true as const }
			: {}),
		...(ownerRetired ? { taskArtifactOwnerRetired: true as const } : {}),
	};
}

function planRetirementOutcome(
	plan: Extract<SessionRetirementPlan, { kind: "retirable" }>,
): SessionRetirementProbeOutcome {
	const receipt = plan.gcContinuationReceipt;
	const outcome = receipt?.taskArtifactOwnerRetirementOutcome;
	return {
		kind: "retirable",
		...(receipt ? { taskArtifactOwnerDeletionEvidence: receipt.taskArtifactOwnerDeletionEvidence } : {}),
		...(outcome ? { taskArtifactOwnerRetirementOutcome: outcome } : {}),
		...(receipt?.state === "owner_retired" ? { taskArtifactOwnerRetired: true as const } : {}),
		...(outcome && outcome.kind !== "completed"
			? { taskArtifactOwnerRetirementContinuation: outcome.continuation }
			: {}),
		...(outcome?.kind === "payload_retired"
			? { taskArtifactOwnerPayloadRetired: true as const, taskArtifactOwnerNamespaceRetained: true as const }
			: {}),
	};
}

/**
 * Evaluate the preconditions retirement owns — the transcript must be readable
 * and carry a usable session header — and bind the delete target to the exact
 * bytes just read. Nothing here mutates the store.
 */
async function planSessionRetirement(
	storage: FileSessionStorage,
	sessionsRoot: string,
	transcriptPath: string,
	continuation?: SessionRetirementContinuation,
): Promise<SessionRetirementPlan> {
	let snapshot: SessionStorageSnapshot;
	try {
		snapshot = storage.readSnapshotSync(transcriptPath);
	} catch (err) {
		return { kind: "kept", reason: `transcript_unreadable: ${toError(err).message}` };
	}

	const header = parseFirstJsonlLine(snapshot.bytes);
	if (header?.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") {
		return { kind: "kept", reason: "transcript_header_unusable" };
	}

	// The verified delete authority only unlinks a single-link transcript, so a
	// hard-linked one can never be retired. Refusing here keeps the dry run from
	// promising bytes prune cannot release, and — because this runs before the
	// artifact phase — keeps a doomed retirement from destroying its artifacts.
	if (snapshot.stat.nlink === undefined || snapshot.stat.nlink !== 1n) {
		return { kind: "kept", reason: "transcript_not_single_link" };
	}

	let ownerLocator: TaskArtifactOwnerLocator | undefined;
	try {
		ownerLocator = taskArtifactOwnerLocatorFromTranscriptBytes(snapshot.bytes, header.id);
	} catch (error) {
		return { kind: "kept", reason: `task_artifact_owner_locator_invalid: ${toError(error).message}` };
	}

	let ownerContext: TaskArtifactOwnerStorageContext | undefined;
	let ownerEvidence: TaskArtifactOwnerDeletionEvidence | undefined;
	let gcContinuationReceipt: ManagedGcSessionRetirementReceipt | undefined;
	let managedTarget: ManagedGcSessionRetirementTarget | undefined;
	let partialReceipt: ManagedGcSessionRetirementReceipt | undefined;
	const continuationRefusal = (reason: string): SessionRetirementPlan =>
		partialReceipt
			? { kind: "cleanup_pending", reason, gcContinuationReceipt: partialReceipt }
			: { kind: "kept", reason };
	if (ownerLocator) {
		if (!continuation) return { kind: "kept", reason: "task_artifact_owner_context_missing" };
		try {
			ownerContext = taskArtifactOwnerStorageContextForScope(continuation.managedScope);
			if (path.resolve(ownerContext.sessionsRoot) !== path.resolve(sessionsRoot))
				return { kind: "kept", reason: "task_artifact_owner_root_mismatch" };
			managedTarget = bindManagedGcSessionRetirementTarget(continuation.managedScope, transcriptPath);
			const snapshotIdentity: SessionStorageFileIdentity = {
				dev: snapshot.stat.dev,
				ino: snapshot.stat.ino,
				nlink: snapshot.stat.nlink,
				size: snapshot.stat.size,
				mtimeNs: snapshot.stat.mtimeNs,
				sha256: crypto.createHash("sha256").update(snapshot.bytes).digest("hex"),
			};
			if (
				managedTarget.sessionId !== header.id ||
				managedTarget.cwd !== header.cwd ||
				!sameTranscriptIdentity(managedTarget.transcriptIdentity, snapshotIdentity) ||
				!util.isDeepStrictEqual(managedTarget.taskArtifactOwnerLocator, ownerLocator)
			)
				return { kind: "kept", reason: "task_artifact_owner_continuation_transcript_replaced" };
			gcContinuationReceipt = await readManagedGcSessionRetirementReceiptReadOnly(
				continuation.managedScope,
				transcriptPath,
			);
			if (gcContinuationReceipt) {
				if (!sameManagedGcTarget(gcContinuationReceipt, managedTarget))
					return { kind: "kept", reason: "task_artifact_owner_continuation_transcript_replaced" };
				if (gcContinuationReceipt.artifactsRemoved) partialReceipt = gcContinuationReceipt;
				ownerEvidence = gcContinuationReceipt.taskArtifactOwnerDeletionEvidence;
				if (!ownerEvidence) return continuationRefusal("task_artifact_owner_continuation_evidence_missing");
				if (gcContinuationReceipt.state === "prepared" || gcContinuationReceipt.state === "artifacts_removed") {
					const currentEvidence = captureTaskArtifactOwnerDeletionEvidence(ownerContext, header.id, ownerLocator);
					if (!currentEvidence || !sameEvidence(currentEvidence, ownerEvidence))
						return continuationRefusal("task_artifact_owner_continuation_evidence_mismatch");
				} else if (gcContinuationReceipt.state === "owner_pending") {
					const outcome = gcContinuationReceipt.taskArtifactOwnerRetirementOutcome;
					if (!outcome || outcome.kind === "completed")
						return continuationRefusal("task_artifact_owner_continuation_outcome_mismatch");
					verifyTaskArtifactOwnerRetirementContinuation(ownerContext, ownerEvidence, outcome.continuation);
				} else {
					const outcome = gcContinuationReceipt.taskArtifactOwnerRetirementOutcome;
					if (outcome?.kind !== "completed")
						return continuationRefusal("task_artifact_owner_continuation_outcome_mismatch");
					verifyTaskArtifactOwnerPhysicalRetirement(ownerContext, ownerEvidence, outcome);
				}
			} else {
				ownerEvidence = captureTaskArtifactOwnerDeletionEvidence(ownerContext, header.id, ownerLocator);
				if (!ownerEvidence) return { kind: "kept", reason: "task_artifact_owner_continuation_evidence_missing" };
			}
			if (
				await hasSiblingTaskArtifactOwnerTranscript(
					storage,
					transcriptPath,
					ownerLocator,
					ownerContext,
					managedGcProtocolScopeInspectorForScope(continuation.managedScope),
				)
			)
				return {
					kind: "owner_shared",
					reason: "task_artifact_owner_shared_with_sibling_transcript",
					...(gcContinuationReceipt ? { gcContinuationReceipt } : {}),
				};
		} catch (error) {
			return continuationRefusal(`task_artifact_owner_continuation_invalid: ${toError(error).message}`);
		}
	}

	const directory = path.dirname(transcriptPath);
	return {
		kind: "retirable",
		artifactsPresent: storage.existsSync(transcriptPath.slice(0, -".jsonl".length)),
		...(ownerLocator ? { taskArtifactOwnerLocator: ownerLocator } : {}),
		...(gcContinuationReceipt ? { gcContinuationReceipt } : {}),
		target: {
			...(ownerContext ? { taskArtifactOwnerStorageContext: ownerContext } : {}),
			...(ownerEvidence ? { taskArtifactOwnerDeletionEvidence: ownerEvidence } : {}),
			...(ownerLocator ? { deferTaskArtifactOwnerRetirement: true as const } : {}),
			sessionsRoot,
			transcriptPath,
			sessionId: header.id,
			cwd: header.cwd,
			transcriptIdentity: {
				dev: snapshot.stat.dev,
				ino: snapshot.stat.ino,
				nlink: snapshot.stat.nlink,
				size: snapshot.stat.size,
				mtimeNs: snapshot.stat.mtimeNs,
				sha256: crypto.createHash("sha256").update(snapshot.bytes).digest("hex"),
			},
			plannedArtifactsPath: path.join(directory, `.gjc-delete-gc-${crypto.randomUUID()}-artifacts`),
			plannedTranscriptPath: path.join(directory, `.gjc-delete-gc-${crypto.randomUUID()}-transcript`),
		},
	};
}

/**
 * Non-mutating projection of {@link retireSessionTranscript}: would the
 * retention pass's own preconditions let this transcript be retired at all?
 *
 * `gjc gc --disk` runs it so a dry run reports the verdict a prune would reach
 * instead of promising bytes the delete authority will refuse to release. The
 * authority's verdict (containment, identity, artifact tree) is deliberately
 * not predicted here — it is re-derived against live state at delete time.
 */
export async function probeSessionRetirement(
	storage: FileSessionStorage,
	sessionsRoot: string,
	transcriptPath: string,
	continuation?: SessionRetirementContinuation,
): Promise<SessionRetirementProbeOutcome> {
	const plan = await planSessionRetirement(storage, sessionsRoot, transcriptPath, continuation);
	if (plan.kind === "kept") return plan;
	if (plan.kind === "owner_shared" || plan.kind === "cleanup_pending") {
		const receipt = plan.gcContinuationReceipt;
		if (!receipt?.artifactsRemoved) return { kind: "kept", reason: plan.reason };
		return cleanupPending(
			plan.reason,
			receipt.taskArtifactOwnerDeletionEvidence,
			receipt.taskArtifactOwnerRetirementOutcome,
			receipt.state === "owner_retired",
		);
	}
	return planRetirementOutcome(plan);
}

/**
 * A transcript that survives after its artifacts are already gone is not a
 * benign keep: the session is half-destroyed and the caller has to surface it.
 */
function retirementIncomplete(artifactsRemoved: boolean, reason: string): SessionRetirementOutcome {
	return artifactsRemoved ? { kind: "cleanup_pending", reason } : { kind: "kept", reason };
}

function cleanupPending(
	reason: string,
	evidence: TaskArtifactOwnerDeletionEvidence,
	outcome: TaskArtifactOwnerRetirementOutcome | undefined,
	ownerRetired: boolean,
	phase: "artifacts" | "transcript" = "artifacts",
): Extract<SessionRetirementOutcome, { kind: "cleanup_pending" }> {
	return { kind: "cleanup_pending", reason, phase, ...ownerOutcomeFields(evidence, outcome, ownerRetired) };
}

function errorMessage(error: unknown): string {
	if (!(error instanceof AggregateError)) return toError(error).message;
	const details = [...error.errors].map(cause => toError(cause).message).join("; ");
	return details ? `${error.message}: ${details}` : error.message;
}

type ManagedGcOwnerProgress =
	| { kind: "owner_retired"; receipt: ManagedGcSessionRetirementReceipt; outcome: TaskArtifactOwnerRetirementOutcome }
	| { kind: "owner_pending"; receipt: ManagedGcSessionRetirementReceipt; outcome: TaskArtifactOwnerRetirementOutcome };

async function advanceManagedGcOwnerRetirement(
	scope: ManagedScope,
	receipt: ManagedGcSessionRetirementReceipt,
	context: TaskArtifactOwnerStorageContext,
	evidence: TaskArtifactOwnerDeletionEvidence,
): Promise<ManagedGcOwnerProgress> {
	if (receipt.state === "owner_retired") {
		const outcome = receipt.taskArtifactOwnerRetirementOutcome;
		if (outcome?.kind !== "completed") throw new Error("task_artifact_owner_continuation_outcome_mismatch");
		verifyTaskArtifactOwnerPhysicalRetirement(context, evidence, outcome);
		return { kind: "owner_retired", receipt, outcome };
	}
	if (receipt.state === "prepared") throw new Error("task_artifact_owner_continuation_state_order_invalid");
	// `artifacts_removed` is the durable authorization for the first native
	// scrub. Persist owner_pending only after that scrub returns its real proof;
	// a replay from owner_pending revalidates the prior continuation first.
	let previousContinuation: TaskArtifactOwnerRetirementContinuation | undefined;
	if (receipt.state === "owner_pending") {
		const previous = receipt.taskArtifactOwnerRetirementOutcome;
		if (!previous || previous.kind === "completed")
			throw new Error("task_artifact_owner_continuation_outcome_mismatch");
		previousContinuation = verifyTaskArtifactOwnerRetirementContinuation(context, evidence, previous.continuation);
	}
	const outcome = retireTaskArtifactOwner(context, evidence, previousContinuation);
	if (outcome.kind === "completed") {
		const retired = await publishManagedGcSessionRetirementReceipt(scope, {
			...targetFromReceipt(receipt),
			state: "owner_retired",
			taskArtifactOwnerDeletionEvidence: evidence,
			artifactsRemoved: true,
			taskArtifactOwnerRetirementOutcome: outcome,
			taskArtifactOwnerRetired: true,
		});
		return { kind: "owner_retired", receipt: retired, outcome: retired.taskArtifactOwnerRetirementOutcome! };
	}
	const pending = await publishManagedGcSessionRetirementReceipt(scope, {
		...targetFromReceipt(receipt),
		state: "owner_pending",
		taskArtifactOwnerDeletionEvidence: evidence,
		artifactsRemoved: true,
		taskArtifactOwnerRetirementOutcome: outcome,
		taskArtifactOwnerRetirementContinuation: outcome.continuation,
		...(outcome.kind === "payload_retired"
			? { taskArtifactOwnerPayloadRetired: true as const, taskArtifactOwnerNamespaceRetained: true as const }
			: {}),
	});
	return { kind: "owner_pending", receipt: pending, outcome: pending.taskArtifactOwnerRetirementOutcome! };
}

/** Resume journaled owner cleanup without broadening the captured tree authority. */
async function retireGcOwnerTranscript(
	storage: FileSessionStorage,
	plan: Extract<SessionRetirementPlan, { kind: "retirable" }>,
	continuation: SessionRetirementContinuation,
): Promise<SessionRetirementOutcome> {
	const target = plan.target;
	const ownerContext = target.taskArtifactOwnerStorageContext;
	const evidence = target.taskArtifactOwnerDeletionEvidence;
	const locator = plan.taskArtifactOwnerLocator;
	if (!ownerContext || !evidence || !locator)
		return { kind: "kept", reason: "task_artifact_owner_continuation_evidence_missing" };
	const receiptTarget: ManagedGcSessionRetirementTarget = {
		transcriptPath: target.transcriptPath,
		sessionId: target.sessionId,
		cwd: target.cwd,
		transcriptIdentity: target.transcriptIdentity,
		taskArtifactOwnerLocator: locator,
	};
	let receipt = plan.gcContinuationReceipt;
	let artifactsRemoved = receipt?.artifactsRemoved === true;
	let ownerOutcome = receipt?.taskArtifactOwnerRetirementOutcome;
	let ownerRetired = receipt?.state === "owner_retired";
	try {
		if (
			await hasSiblingTaskArtifactOwnerTranscript(
				storage,
				target.transcriptPath,
				locator,
				ownerContext,
				managedGcProtocolScopeInspectorForScope(continuation.managedScope),
			)
		)
			return artifactsRemoved
				? cleanupPending("task_artifact_owner_shared_with_sibling_transcript", evidence, ownerOutcome, ownerRetired)
				: { kind: "kept", reason: "task_artifact_owner_shared_with_sibling_transcript" };

		if (!receipt) {
			receipt = await publishManagedGcSessionRetirementReceipt(continuation.managedScope, {
				...receiptTarget,
				state: "prepared",
				taskArtifactOwnerDeletionEvidence: evidence,
			});
		}
		if (receipt.state === "prepared") {
			const artifactPhase = await storage.deleteSessionVerified(
				{
					...target,
					taskArtifactOwnerStorageContext: ownerContext,
					taskArtifactOwnerDeletionEvidence: evidence,
					deferTaskArtifactOwnerRetirement: true,
				},
				managedGcProtocolScopeInspectorForScope(continuation.managedScope),
			);
			if (artifactPhase.kind === "cleanup_pending") {
				return cleanupPending(
					`cleanup_pending_${artifactPhase.phase}: ${artifactPhase.error.message}`,
					evidence,
					ownerOutcome,
					ownerRetired,
					"artifacts",
				);
			}
			if (artifactPhase.kind !== "artifacts_removed") {
				return { kind: "kept", reason: "task_artifact_owner_continuation_artifact_phase_incomplete" };
			}
			artifactsRemoved = true;
			receipt = await publishManagedGcSessionRetirementReceipt(continuation.managedScope, {
				...receiptTarget,
				state: "artifacts_removed",
				taskArtifactOwnerDeletionEvidence: evidence,
				artifactsRemoved: true,
			});
		}
		if (
			await hasSiblingTaskArtifactOwnerTranscript(
				storage,
				target.transcriptPath,
				locator,
				ownerContext,
				managedGcProtocolScopeInspectorForScope(continuation.managedScope),
			)
		)
			return cleanupPending(
				"task_artifact_owner_shared_with_sibling_transcript",
				evidence,
				ownerOutcome,
				ownerRetired,
			);

		const progress = await advanceManagedGcOwnerRetirement(
			continuation.managedScope,
			receipt,
			ownerContext,
			evidence,
		);
		receipt = progress.receipt;
		ownerOutcome = progress.outcome;
		ownerRetired = progress.kind === "owner_retired";
		if (progress.kind === "owner_pending")
			return cleanupPending(
				progress.outcome.kind === "uncertain"
					? progress.outcome.reason
					: "task_artifact_owner_namespace_cleanup_pending",
				evidence,
				progress.outcome,
				false,
			);
		if (
			await hasSiblingTaskArtifactOwnerTranscript(
				storage,
				target.transcriptPath,
				locator,
				ownerContext,
				managedGcProtocolScopeInspectorForScope(continuation.managedScope),
			)
		)
			return cleanupPending("task_artifact_owner_shared_with_sibling_transcript", evidence, ownerOutcome, true);

		const deletion = await storage.deleteSessionVerified(
			{
				...target,
				taskArtifactOwnerStorageContext: ownerContext,
				taskArtifactOwnerDeletionEvidence: evidence,
				taskArtifactOwnerRetirementOutcome: ownerOutcome,
				taskArtifactOwnerRetired: true,
				deferTaskArtifactOwnerRetirement: true,
				artifactsRemoved: true,
			},
			managedGcProtocolScopeInspectorForScope(continuation.managedScope),
		);
		if (deletion.kind === "deleted") return { kind: "retired", taskArtifactOwnerRetired: true };
		if (deletion.kind === "cleanup_pending")
			return cleanupPending(
				`cleanup_pending_${deletion.phase}: ${deletion.error.message}`,
				evidence,
				ownerOutcome,
				true,
				deletion.phase === "transcript" ? "transcript" : "artifacts",
			);
		return cleanupPending("transcript_not_deleted", evidence, ownerOutcome, true, "transcript");
	} catch (error) {
		const reason = `gc_task_artifact_owner_continuation_failed: ${errorMessage(error)}`;
		return artifactsRemoved ? cleanupPending(reason, evidence, ownerOutcome, ownerRetired) : { kind: "kept", reason };
	}
}

export async function retireOrphanSessionTranscript(
	storage: FileSessionStorage,
	sessionsRoot: string,
	continuation: SessionRetirementContinuation,
	receipt: ManagedGcSessionRetirementReceipt,
): Promise<SessionRetirementOutcome> {
	const evidence = receipt.taskArtifactOwnerDeletionEvidence;
	let ownerOutcome = receipt.taskArtifactOwnerRetirementOutcome;
	let ownerRetired = receipt.state === "owner_retired";
	const artifactsRemoved = receipt.artifactsRemoved === true;
	try {
		const ownerContext = taskArtifactOwnerStorageContextForScope(continuation.managedScope);
		if (
			path.resolve(ownerContext.sessionsRoot) !== path.resolve(sessionsRoot) ||
			!path.isAbsolute(receipt.transcriptPath) ||
			path.resolve(receipt.transcriptPath) !== receipt.transcriptPath ||
			!isWithinPath(sessionsRoot, receipt.transcriptPath) ||
			path.dirname(receipt.transcriptPath) !== continuation.managedScope.directoryPath
		)
			return { kind: "kept", reason: "task_artifact_owner_continuation_authority_mismatch" };
		const currentReceipt = await readManagedGcSessionRetirementReceiptReadOnly(
			continuation.managedScope,
			receipt.transcriptPath,
		);
		if (!currentReceipt || !util.isDeepStrictEqual(currentReceipt, receipt))
			return { kind: "kept", reason: "task_artifact_owner_continuation_state_changed" };
		if (storage.existsSync(receipt.transcriptPath))
			return { kind: "kept", reason: "task_artifact_owner_orphan_transcript_reappeared" };
		if (receipt.state === "prepared")
			return cleanupPending("transcript_missing_before_artifact_phase", evidence, ownerOutcome, false, "transcript");
		if (
			await hasSiblingTaskArtifactOwnerTranscript(
				storage,
				receipt.transcriptPath,
				evidence.locator,
				ownerContext,
				managedGcProtocolScopeInspectorForScope(continuation.managedScope),
			)
		)
			return cleanupPending(
				"task_artifact_owner_shared_with_sibling_transcript",
				evidence,
				ownerOutcome,
				ownerRetired,
			);

		const progress = await advanceManagedGcOwnerRetirement(
			continuation.managedScope,
			receipt,
			ownerContext,
			evidence,
		);
		ownerOutcome = progress.outcome;
		ownerRetired = progress.kind === "owner_retired";
		if (progress.kind === "owner_pending")
			return cleanupPending(
				progress.outcome.kind === "uncertain"
					? progress.outcome.reason
					: "task_artifact_owner_namespace_cleanup_pending",
				evidence,
				progress.outcome,
				false,
			);
		return cleanupPending(
			"transcript_missing_without_verified_retirement",
			evidence,
			ownerOutcome,
			ownerRetired,
			"transcript",
		);
	} catch (error) {
		const reason = `gc_task_artifact_owner_continuation_failed: ${errorMessage(error)}`;
		return artifactsRemoved ? cleanupPending(reason, evidence, ownerOutcome, ownerRetired) : { kind: "kept", reason };
	}
}

/**
 * Retire one managed session transcript through the verified hard-delete
 * authority.
 *
 * This is the only supported way for a retention pass to remove a transcript:
 * identity, containment, header id/cwd, artifact tree and parent directory are
 * all re-verified inside {@link FileSessionStorage.deleteSessionVerified}, and
 * anything ambiguous fails closed as `kept` rather than deleting bytes. The
 * caller owns the retention policy; this function owns nothing but the delete
 * authority.
 */
export async function retireSessionTranscript(
	storage: FileSessionStorage,
	sessionsRoot: string,
	transcriptPath: string,
	continuation?: SessionRetirementContinuation,
): Promise<SessionRetirementOutcome> {
	const plan = await planSessionRetirement(storage, sessionsRoot, transcriptPath, continuation);
	if (plan.kind === "kept") return plan;
	if (plan.kind === "owner_shared" || plan.kind === "cleanup_pending") {
		const receipt = plan.gcContinuationReceipt;
		if (!receipt?.artifactsRemoved) return { kind: "kept", reason: plan.reason };
		return cleanupPending(
			plan.reason,
			receipt.taskArtifactOwnerDeletionEvidence,
			receipt.taskArtifactOwnerRetirementOutcome,
			receipt.state === "owner_retired",
		);
	}
	if (plan.taskArtifactOwnerLocator && continuation) return retireGcOwnerTranscript(storage, plan, continuation);

	let artifactsRemoved = false;
	try {
		// Phase 1 removes the sibling artifact directory (or proves it absent);
		// phase 2 unlinks the transcript only against the same bound identity.
		const artifacts = await storage.deleteSessionVerified(plan.target);
		if (artifacts.kind === "deleted") return { kind: "retired" };
		if (artifacts.kind === "cleanup_pending") {
			return { kind: "cleanup_pending", reason: `cleanup_pending_${artifacts.phase}: ${artifacts.error.message}` };
		}
		artifactsRemoved = plan.artifactsPresent;
		const deletion = await storage.deleteSessionVerified({ ...plan.target, artifactsRemoved: true });
		if (deletion.kind === "deleted") return { kind: "retired" };
		if (deletion.kind === "cleanup_pending") {
			return { kind: "cleanup_pending", reason: `cleanup_pending_${deletion.phase}: ${deletion.error.message}` };
		}
		return retirementIncomplete(artifactsRemoved, "transcript_not_deleted");
	} catch (err) {
		const error = toError(err);
		const kind = err instanceof SessionDeleteVerificationError ? err.kind : "error";
		return retirementIncomplete(artifactsRemoved, `verified_delete_rejected(${kind}): ${error.message}`);
	}
}
