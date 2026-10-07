import * as path from "node:path";
import * as util from "node:util";
import type { ResumeSessionIdentity } from "../session-manager";
import {
	FileSessionStorage,
	type SessionStorageSnapshot,
	type VerifiedSessionDeleteResult,
	type VerifiedSessionDeleteTarget,
} from "../session-storage";
import type { TaskArtifactOwnerDeletionEvidence, TaskArtifactOwnerStorageContext } from "../task-artifact-owner-codec";
import {
	parseTaskArtifactOwnerDeletionEvidence,
	parseTaskArtifactOwnerRetirementOutcome,
} from "../task-artifact-owner-codec";
import { retireTaskArtifactOwner, verifyTaskArtifactOwnerPhysicalRetirement } from "../task-artifact-owner-retirement";
import type {
	ManagedGcSessionRetirementReceipt,
	ManagedGcSessionRetirementTarget,
} from "./managed-gc-retirement-codec";
import type { ManagedGcProtocolScopeInspector } from "./managed-session-scope";
import { captureTaskArtifactOwnerDeletionEvidence } from "./task-artifact-owner-access";
import {
	hasSiblingTaskArtifactOwnerTranscript,
	taskArtifactOwnerLocatorFromTranscriptBytes,
} from "./task-artifact-owner-transcript";

export interface ManagedGcOwnerCleanupTarget {
	readonly path: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly identity: ResumeSessionIdentity;
	readonly taskArtifactOwnerDeletionEvidence?: TaskArtifactOwnerDeletionEvidence;
}

/** Authenticated receipt operations and fencing supplied by the prepared managed scope. */
export interface ManagedGcOwnerCleanupAuthority {
	readonly agentDir: string;
	readonly sessionsRoot: string;
	readonly directoryPath: string;
	readonly storageContext: TaskArtifactOwnerStorageContext;
	readonly inspectProtocol: ManagedGcProtocolScopeInspector;
	readonly assertOwned: () => void;
	readonly bindTarget: (transcriptPath: string) => ManagedGcSessionRetirementTarget;
	readonly readReceipt: (transcriptPath: string) => Promise<ManagedGcSessionRetirementReceipt | undefined>;
	readonly publishReceipt: (receipt: ManagedGcSessionRetirementReceipt) => Promise<ManagedGcSessionRetirementReceipt>;
	readonly findCompletedRetirement: (
		evidence: TaskArtifactOwnerDeletionEvidence,
		exceptTranscriptPath: string,
	) => Promise<
		| {
				scope: { readonly agentDir: string; readonly sessionsRoot: string; readonly directoryPath: string };
				receipt: ManagedGcSessionRetirementReceipt;
		  }
		| undefined
	>;
}

export type ManagedGcOwnerProgress = {
	readonly state: "none" | "owner_retired" | "payload_retired" | "pending";
	readonly message?: string;
};

export type ManagedGcOwnerDeleteFields = Pick<
	VerifiedSessionDeleteTarget,
	| "taskArtifactOwnerStorageContext"
	| "taskArtifactOwnerDeletionEvidence"
	| "taskArtifactOwnerRetirementOutcome"
	| "taskArtifactOwnerRetirementContinuation"
	| "taskArtifactOwnerPayloadRetired"
	| "taskArtifactOwnerNamespaceRetained"
	| "deferTaskArtifactOwnerRetirement"
	| "taskArtifactOwnerRetired"
>;

function deepSame(left: unknown, right: unknown): boolean {
	return util.isDeepStrictEqual(left, right);
}

function managedGcTargetMatchesCandidate(
	target: ManagedGcSessionRetirementTarget,
	candidate: ManagedGcOwnerCleanupTarget,
): boolean {
	return (
		target.transcriptPath === candidate.path &&
		target.sessionId === candidate.sessionId &&
		target.cwd === candidate.cwd &&
		target.transcriptIdentity.nlink === 1n &&
		target.transcriptIdentity.dev === candidate.identity.dev &&
		target.transcriptIdentity.ino === candidate.identity.ino &&
		target.transcriptIdentity.size === candidate.identity.size &&
		target.transcriptIdentity.mtimeNs === candidate.identity.mtimeNs &&
		target.transcriptIdentity.sha256 === candidate.identity.sha256
	);
}

function managedGcReceiptTarget(receipt: ManagedGcSessionRetirementReceipt): ManagedGcSessionRetirementTarget {
	return {
		transcriptPath: receipt.transcriptPath,
		sessionId: receipt.sessionId,
		cwd: receipt.cwd,
		transcriptIdentity: receipt.transcriptIdentity,
		taskArtifactOwnerLocator: receipt.taskArtifactOwnerDeletionEvidence.locator,
	};
}

export function hasUnsupportedLegacyOwnerTarget(scopeDirectory: string, target: ManagedGcOwnerCleanupTarget): boolean {
	if (path.dirname(target.path) === scopeDirectory) return false;
	if (target.taskArtifactOwnerDeletionEvidence) return true;
	let snapshot: SessionStorageSnapshot;
	try {
		snapshot = new FileSessionStorage().readSnapshotSync(target.path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	return taskArtifactOwnerLocatorFromTranscriptBytes(snapshot.bytes, target.sessionId) !== undefined;
}

export async function prepareManagedGcOwnerTarget<T extends ManagedGcOwnerCleanupTarget>(
	authority: ManagedGcOwnerCleanupAuthority,
	target: T,
): Promise<T & ManagedGcOwnerCleanupTarget> {
	if (path.dirname(target.path) !== authority.directoryPath) {
		if (hasUnsupportedLegacyOwnerTarget(authority.directoryPath, target))
			throw new Error("task_artifact_owner_legacy_scope_unsupported");
		return target;
	}
	const receipt = await authority.readReceipt(target.path);
	if (receipt) {
		if (
			!managedGcTargetMatchesCandidate(receipt, target) ||
			(target.taskArtifactOwnerDeletionEvidence &&
				!deepSame(target.taskArtifactOwnerDeletionEvidence, receipt.taskArtifactOwnerDeletionEvidence))
		)
			throw new Error("task_artifact_owner_continuation_evidence_mismatch");
		return { ...target, taskArtifactOwnerDeletionEvidence: receipt.taskArtifactOwnerDeletionEvidence };
	}
	if (target.taskArtifactOwnerDeletionEvidence) throw new Error("task_artifact_owner_continuation_state_missing");
	let snapshot: SessionStorageSnapshot;
	try {
		snapshot = new FileSessionStorage().readSnapshotSync(target.path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return target;
		throw error;
	}
	const locator = taskArtifactOwnerLocatorFromTranscriptBytes(snapshot.bytes, target.sessionId);
	if (!locator) return target;
	const bound = authority.bindTarget(target.path);
	if (!managedGcTargetMatchesCandidate(bound, target) || !deepSame(locator, bound.taskArtifactOwnerLocator))
		throw new Error("task_artifact_owner_continuation_transcript_replaced");
	const evidence = captureTaskArtifactOwnerDeletionEvidence(authority.storageContext, target.sessionId, locator);
	if (!evidence) throw new Error("task_artifact_owner_deletion_evidence_missing");
	const prepared = await authority.publishReceipt({
		...bound,
		state: "prepared",
		taskArtifactOwnerDeletionEvidence: evidence,
	});
	if (
		!deepSame(prepared.taskArtifactOwnerDeletionEvidence, evidence) ||
		!managedGcTargetMatchesCandidate(prepared, target)
	)
		throw new Error("task_artifact_owner_continuation_evidence_mismatch");
	return { ...target, taskArtifactOwnerDeletionEvidence: evidence };
}

export async function prepareManagedGcOwnerTargets<T extends ManagedGcOwnerCleanupTarget>(
	authority: ManagedGcOwnerCleanupAuthority,
	targets: readonly T[],
): Promise<(T & ManagedGcOwnerCleanupTarget)[]> {
	const prepared: (T & ManagedGcOwnerCleanupTarget)[] = [];
	for (const target of targets) prepared.push(await prepareManagedGcOwnerTarget(authority, target));
	return prepared;
}

export async function managedGcOwnerDeleteFields(
	authority: ManagedGcOwnerCleanupAuthority,
	target: ManagedGcOwnerCleanupTarget,
): Promise<ManagedGcOwnerDeleteFields> {
	if (path.dirname(target.path) !== authority.directoryPath) {
		if (hasUnsupportedLegacyOwnerTarget(authority.directoryPath, target))
			throw new Error("task_artifact_owner_legacy_scope_unsupported");
		return {};
	}
	const receipt = await authority.readReceipt(target.path);
	if (!receipt) {
		if (target.taskArtifactOwnerDeletionEvidence) throw new Error("task_artifact_owner_continuation_state_missing");
		return {};
	}
	if (
		!managedGcTargetMatchesCandidate(receipt, target) ||
		!deepSame(receipt.taskArtifactOwnerDeletionEvidence, target.taskArtifactOwnerDeletionEvidence)
	)
		throw new Error("task_artifact_owner_continuation_evidence_mismatch");
	const outcome = receipt.taskArtifactOwnerRetirementOutcome;
	return {
		taskArtifactOwnerStorageContext: authority.storageContext,
		taskArtifactOwnerDeletionEvidence: receipt.taskArtifactOwnerDeletionEvidence,
		deferTaskArtifactOwnerRetirement: true,
		...(outcome ? { taskArtifactOwnerRetirementOutcome: outcome } : {}),
		...(outcome && outcome.kind !== "completed"
			? { taskArtifactOwnerRetirementContinuation: outcome.continuation }
			: {}),
		...(outcome?.kind === "payload_retired"
			? { taskArtifactOwnerPayloadRetired: true as const, taskArtifactOwnerNamespaceRetained: true as const }
			: {}),
		...(receipt.state === "owner_retired" ? { taskArtifactOwnerRetired: true as const } : {}),
	};
}

export async function publishManagedGcArtifactsRemoved(
	authority: ManagedGcOwnerCleanupAuthority,
	target: ManagedGcOwnerCleanupTarget,
): Promise<ManagedGcSessionRetirementReceipt | undefined> {
	if (!target.taskArtifactOwnerDeletionEvidence) return undefined;
	const receipt = await authority.readReceipt(target.path);
	if (!receipt) throw new Error("task_artifact_owner_continuation_state_missing");
	if (!deepSame(receipt.taskArtifactOwnerDeletionEvidence, target.taskArtifactOwnerDeletionEvidence))
		throw new Error("task_artifact_owner_continuation_evidence_mismatch");
	if (receipt.state !== "prepared") return receipt;
	return authority.publishReceipt({
		...managedGcReceiptTarget(receipt),
		state: "artifacts_removed",
		taskArtifactOwnerDeletionEvidence: receipt.taskArtifactOwnerDeletionEvidence,
		artifactsRemoved: true,
	});
}

export async function retireManagedGcOwnerAfterArtifacts(
	authority: ManagedGcOwnerCleanupAuthority,
	target: ManagedGcOwnerCleanupTarget,
	tombstoneTargets: readonly ManagedGcOwnerCleanupTarget[],
): Promise<ManagedGcOwnerProgress> {
	if (!target.taskArtifactOwnerDeletionEvidence) return { state: "none" };
	const receipt = await publishManagedGcArtifactsRemoved(authority, target);
	if (!receipt) return { state: "none" };
	const evidence = receipt.taskArtifactOwnerDeletionEvidence;
	if (!evidence) throw new Error("task_artifact_owner_continuation_evidence_missing");
	authority.assertOwned();
	const sharedBefore = await hasSiblingTaskArtifactOwnerTranscript(
		new FileSessionStorage(),
		target.path,
		evidence.locator,
		authority.storageContext,
		authority.inspectProtocol,
	);
	authority.assertOwned();
	if (sharedBefore) return { state: "pending", message: "task_artifact_owner_shared_with_sibling_transcript" };
	if (receipt.state === "owner_retired") return { state: "owner_retired" };
	for (const sibling of tombstoneTargets) {
		if (
			sibling.path === target.path ||
			!sibling.taskArtifactOwnerDeletionEvidence ||
			!deepSame(sibling.taskArtifactOwnerDeletionEvidence, evidence)
		)
			continue;
		const siblingReceipt = await authority.readReceipt(sibling.path);
		const siblingOutcome = siblingReceipt?.taskArtifactOwnerRetirementOutcome;
		if (
			siblingReceipt?.state !== "owner_retired" ||
			siblingOutcome?.kind !== "completed" ||
			!deepSame(siblingReceipt.taskArtifactOwnerDeletionEvidence, evidence)
		)
			continue;
		const inherited = await authority.publishReceipt({
			...managedGcReceiptTarget(receipt),
			state: "owner_retired",
			taskArtifactOwnerDeletionEvidence: evidence,
			artifactsRemoved: true,
			taskArtifactOwnerRetirementOutcome: siblingOutcome,
			taskArtifactOwnerRetired: true,
		});
		if (inherited.state !== "owner_retired") throw new Error("task_artifact_owner_inheritance_pending");
		return { state: "owner_retired" };
	}
	const inherited = await authority.findCompletedRetirement(evidence, target.path);
	if (inherited) {
		if (
			inherited.scope.agentDir !== authority.agentDir ||
			inherited.scope.sessionsRoot !== authority.sessionsRoot ||
			inherited.scope.directoryPath === authority.directoryPath ||
			path.dirname(inherited.receipt.transcriptPath) !== inherited.scope.directoryPath ||
			inherited.receipt.transcriptPath === target.path ||
			inherited.receipt.state !== "owner_retired"
		)
			throw new Error("task_artifact_owner_continuation_authority_mismatch");
		const inheritedEvidence = parseTaskArtifactOwnerDeletionEvidence(
			inherited.receipt.taskArtifactOwnerDeletionEvidence,
		);
		if (!deepSame(inheritedEvidence, evidence)) throw new Error("task_artifact_owner_continuation_evidence_mismatch");
		const inheritedOutcome = parseTaskArtifactOwnerRetirementOutcome(
			authority.storageContext,
			evidence,
			inherited.receipt.taskArtifactOwnerRetirementOutcome,
		);
		if (inheritedOutcome.kind !== "completed") throw new Error("task_artifact_owner_physical_retirement_unverified");
		verifyTaskArtifactOwnerPhysicalRetirement(authority.storageContext, evidence, inheritedOutcome);
		authority.assertOwned();
		const sharedAfterInheritance = await hasSiblingTaskArtifactOwnerTranscript(
			new FileSessionStorage(),
			target.path,
			evidence.locator,
			authority.storageContext,
			authority.inspectProtocol,
		);
		authority.assertOwned();
		if (sharedAfterInheritance)
			return { state: "pending", message: "task_artifact_owner_shared_with_sibling_transcript" };
		const published = await authority.publishReceipt({
			...managedGcReceiptTarget(receipt),
			state: "owner_retired",
			taskArtifactOwnerDeletionEvidence: evidence,
			artifactsRemoved: true,
			taskArtifactOwnerRetirementOutcome: inheritedOutcome,
			taskArtifactOwnerRetired: true,
		});
		if (published.state !== "owner_retired") throw new Error("task_artifact_owner_inheritance_pending");
		return { state: "owner_retired" };
	}
	const previous = receipt.taskArtifactOwnerRetirementOutcome;
	const continuation = previous && previous.kind !== "completed" ? previous.continuation : undefined;
	authority.assertOwned();
	const outcome = retireTaskArtifactOwner(authority.storageContext, evidence, continuation);
	authority.assertOwned();
	if (outcome.kind === "completed") {
		await authority.publishReceipt({
			...managedGcReceiptTarget(receipt),
			state: "owner_retired",
			taskArtifactOwnerDeletionEvidence: evidence,
			artifactsRemoved: true,
			taskArtifactOwnerRetirementOutcome: outcome,
			taskArtifactOwnerRetired: true,
		});
		return { state: "owner_retired" };
	}
	await authority.publishReceipt({
		...managedGcReceiptTarget(receipt),
		state: "owner_pending",
		taskArtifactOwnerDeletionEvidence: evidence,
		artifactsRemoved: true,
		taskArtifactOwnerRetirementOutcome: outcome,
		taskArtifactOwnerRetirementContinuation: outcome.continuation,
		...(outcome.kind === "payload_retired"
			? { taskArtifactOwnerPayloadRetired: true as const, taskArtifactOwnerNamespaceRetained: true as const }
			: {}),
	});
	return outcome.kind === "payload_retired"
		? { state: "payload_retired", message: "task_artifact_owner_namespace_cleanup_pending" }
		: {
				state: "pending",
				message: outcome.kind === "uncertain" ? outcome.reason : "task_artifact_owner_namespace_cleanup_pending",
			};
}

export async function persistManagedGcStorageOwnerDisposition(
	authority: ManagedGcOwnerCleanupAuthority,
	target: ManagedGcOwnerCleanupTarget,
	deletion: Extract<VerifiedSessionDeleteResult, { kind: "cleanup_pending"; phase: "task_artifact_owner" }>,
): Promise<ManagedGcOwnerProgress> {
	const evidence = parseTaskArtifactOwnerDeletionEvidence(deletion.taskArtifactOwnerDeletionEvidence);
	if (!target.taskArtifactOwnerDeletionEvidence || !deepSame(evidence, target.taskArtifactOwnerDeletionEvidence))
		throw new Error("task_artifact_owner_continuation_evidence_mismatch");
	if (!deletion.artifactsRemoved) return { state: "pending", message: deletion.error.message };
	const receipt = await publishManagedGcArtifactsRemoved(authority, target);
	if (!receipt) throw new Error("task_artifact_owner_continuation_state_missing");
	const outcomeValue = deletion.taskArtifactOwnerRetirementOutcome;
	if (!outcomeValue) return { state: "pending", message: deletion.error.message };
	const outcome = parseTaskArtifactOwnerRetirementOutcome(authority.storageContext, evidence, outcomeValue);
	if (
		(deletion.taskArtifactOwnerRetired === true) !== (outcome.kind === "completed") ||
		(deletion.taskArtifactOwnerPayloadRetired === true) !== (outcome.kind === "payload_retired") ||
		(deletion.taskArtifactOwnerNamespaceRetained === true) !== (outcome.kind === "payload_retired") ||
		(outcome.kind !== "completed" &&
			!deepSame(deletion.taskArtifactOwnerRetirementContinuation, outcome.continuation))
	)
		throw new Error("task_artifact_owner_retirement_outcome_mismatch");
	if (outcome.kind === "completed") {
		await authority.publishReceipt({
			...managedGcReceiptTarget(receipt),
			state: "owner_retired",
			taskArtifactOwnerDeletionEvidence: evidence,
			artifactsRemoved: true,
			taskArtifactOwnerRetirementOutcome: outcome,
			taskArtifactOwnerRetired: true,
		});
		return { state: "owner_retired" };
	}
	await authority.publishReceipt({
		...managedGcReceiptTarget(receipt),
		state: "owner_pending",
		taskArtifactOwnerDeletionEvidence: evidence,
		artifactsRemoved: true,
		taskArtifactOwnerRetirementOutcome: outcome,
		taskArtifactOwnerRetirementContinuation: outcome.continuation,
		...(outcome.kind === "payload_retired"
			? { taskArtifactOwnerPayloadRetired: true as const, taskArtifactOwnerNamespaceRetained: true as const }
			: {}),
	});
	return outcome.kind === "payload_retired"
		? { state: "payload_retired", message: "task_artifact_owner_namespace_cleanup_pending" }
		: {
				state: "pending",
				message: outcome.kind === "uncertain" ? outcome.reason : "task_artifact_owner_namespace_cleanup_pending",
			};
}

export async function managedGcOwnerProgressBeforeDelete(
	authority: ManagedGcOwnerCleanupAuthority,
	target: ManagedGcOwnerCleanupTarget,
	tombstoneTargets: readonly ManagedGcOwnerCleanupTarget[],
	artifactsRemoved: boolean,
): Promise<ManagedGcOwnerProgress> {
	const evidence = target.taskArtifactOwnerDeletionEvidence;
	if (!evidence) return { state: "none" };
	const receipt = await authority.readReceipt(target.path);
	if (!receipt || !deepSame(receipt.taskArtifactOwnerDeletionEvidence, evidence))
		throw new Error("task_artifact_owner_continuation_state_missing");
	if (receipt.state === "prepared" && !artifactsRemoved) {
		authority.assertOwned();
		const shared = await hasSiblingTaskArtifactOwnerTranscript(
			new FileSessionStorage(),
			target.path,
			evidence.locator,
			authority.storageContext,
			authority.inspectProtocol,
		);
		authority.assertOwned();
		return shared
			? { state: "pending", message: "task_artifact_owner_shared_with_sibling_transcript" }
			: { state: "none" };
	}
	return retireManagedGcOwnerAfterArtifacts(authority, target, tombstoneTargets);
}

export async function taskArtifactOwnerTranscriptResult(
	authority: ManagedGcOwnerCleanupAuthority,
	target: ManagedGcOwnerCleanupTarget,
): Promise<"none" | "retired" | "payload_retired"> {
	if (path.dirname(target.path) !== authority.directoryPath) {
		if (hasUnsupportedLegacyOwnerTarget(authority.directoryPath, target))
			throw new Error("task_artifact_owner_legacy_scope_unsupported");
		return "none";
	}
	const receipt = await authority.readReceipt(target.path);
	if (!receipt) {
		if (target.taskArtifactOwnerDeletionEvidence) throw new Error("task_artifact_owner_continuation_state_missing");
		return "none";
	}
	if (!deepSame(receipt.taskArtifactOwnerDeletionEvidence, target.taskArtifactOwnerDeletionEvidence))
		throw new Error("task_artifact_owner_continuation_evidence_mismatch");
	if (receipt.state === "owner_retired") return "retired";
	return receipt.taskArtifactOwnerRetirementOutcome?.kind === "payload_retired" ? "payload_retired" : "none";
}

export interface ManagedGcOwnerTranscriptDeleteReceipt {
	readonly taskArtifactOwnerTranscriptDeleted?: true;
}

export async function persistManagedGcOwnerTranscriptDeletion<T extends ManagedGcOwnerTranscriptDeleteReceipt>(input: {
	target: ManagedGcOwnerCleanupTarget;
	fallback: T;
	deletion: Extract<VerifiedSessionDeleteResult, { kind: "deleted" }>;
	readLatest: () => T | undefined;
	nextReceipt: (latest: T) => T;
	publishPending: (receipt: T) => Promise<void>;
}): Promise<void> {
	if (!input.target.taskArtifactOwnerDeletionEvidence) return;
	if (input.deletion.taskArtifactOwnerTranscriptDeleted !== true)
		throw new Error("task_artifact_owner_transcript_deletion_unverified");
	const latest = input.readLatest() ?? input.fallback;
	if (latest.taskArtifactOwnerTranscriptDeleted) return;
	const next = input.nextReceipt(latest);
	await input.publishPending({ ...next, taskArtifactOwnerTranscriptDeleted: true as const });
}
