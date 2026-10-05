import * as path from "node:path";
import type { SessionStorageFileIdentity } from "../session-storage";
import {
	assertSessionRoot,
	EMPTY_PAYLOAD_SHA256,
	parseTaskArtifactOwnerDeletionEvidence,
	parseTaskArtifactOwnerLocator,
	parseTaskArtifactOwnerRetirementContinuation,
	parseTaskArtifactOwnerRetirementOutcome,
	type TaskArtifactOwnerDeletionEvidence,
	type TaskArtifactOwnerLocator,
	type TaskArtifactOwnerRetirementContinuation,
	type TaskArtifactOwnerRetirementOutcome,
	type TaskArtifactOwnerStorageContext,
} from "../task-artifact-owner-codec";

export type ManagedGcSessionRetirementState = "prepared" | "artifacts_removed" | "owner_pending" | "owner_retired";

export interface ManagedGcSessionRetirementTarget {
	readonly transcriptPath: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly transcriptIdentity: SessionStorageFileIdentity;
	readonly taskArtifactOwnerLocator: TaskArtifactOwnerLocator;
}

export interface ManagedGcSessionRetirementReceipt extends ManagedGcSessionRetirementTarget {
	readonly state: ManagedGcSessionRetirementState;
	readonly taskArtifactOwnerDeletionEvidence: TaskArtifactOwnerDeletionEvidence;
	readonly artifactsRemoved?: true;
	readonly ownerRetirementAttempt?: number;
	readonly taskArtifactOwnerRetirementOutcome?: TaskArtifactOwnerRetirementOutcome;
	readonly taskArtifactOwnerRetirementContinuation?: TaskArtifactOwnerRetirementContinuation;
	readonly taskArtifactOwnerPayloadRetired?: true;
	readonly taskArtifactOwnerNamespaceRetained?: true;
	readonly taskArtifactOwnerRetired?: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function managedGcRetirementIdentityRecord(identity: SessionStorageFileIdentity): Record<string, unknown> {
	return {
		dev: identity.dev.toString(),
		ino: identity.ino.toString(),
		nlink: identity.nlink?.toString(),
		size: identity.size,
		mtimeNs: identity.mtimeNs.toString(),
		sha256: identity.sha256,
	};
}

export function sameIdentity(left: SessionStorageFileIdentity, right: SessionStorageFileIdentity): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.sha256 === right.sha256
	);
}

export function managedGcRetirementIdentityValue(value: unknown): SessionStorageFileIdentity {
	if (!isRecord(value)) throw new Error("task_artifact_owner_continuation_corrupt");
	if (
		Object.keys(value).length !== 6 ||
		!["dev", "ino", "nlink", "size", "mtimeNs", "sha256"].every(key => key in value) ||
		typeof value.dev !== "string" ||
		!/^(0|[1-9][0-9]*)$/u.test(value.dev) ||
		typeof value.ino !== "string" ||
		!/^(0|[1-9][0-9]*)$/u.test(value.ino) ||
		typeof value.nlink !== "string" ||
		!/^(0|[1-9][0-9]*)$/u.test(value.nlink) ||
		value.nlink !== "1" ||
		typeof value.size !== "number" ||
		!Number.isSafeInteger(value.size) ||
		value.size < 0 ||
		typeof value.mtimeNs !== "string" ||
		!/^(0|-?[1-9][0-9]*)$/u.test(value.mtimeNs) ||
		typeof value.sha256 !== "string" ||
		!/^[0-9a-f]{64}$/u.test(value.sha256)
	)
		throw new Error("task_artifact_owner_continuation_corrupt");
	return {
		dev: BigInt(value.dev),
		ino: BigInt(value.ino),
		nlink: BigInt(value.nlink),
		size: value.size,
		mtimeNs: BigInt(value.mtimeNs),
		sha256: value.sha256,
	};
}

function validateTarget(
	ownerContext: TaskArtifactOwnerStorageContext,
	target: ManagedGcSessionRetirementTarget,
): { locator: TaskArtifactOwnerLocator; identity: SessionStorageFileIdentity } {
	if (
		!target ||
		typeof target.transcriptPath !== "string" ||
		typeof target.sessionId !== "string" ||
		typeof target.cwd !== "string"
	)
		throw new Error("task_artifact_owner_continuation_authority_mismatch");
	assertSessionRoot(ownerContext);
	const relativeTranscript = path.relative(ownerContext.sessionsRoot, target.transcriptPath);
	if (
		target.sessionId.length === 0 ||
		!path.isAbsolute(target.transcriptPath) ||
		path.resolve(target.transcriptPath) !== target.transcriptPath ||
		relativeTranscript === "" ||
		path.isAbsolute(relativeTranscript) ||
		relativeTranscript === ".." ||
		relativeTranscript.startsWith(`..${path.sep}`)
	)
		throw new Error("task_artifact_owner_continuation_authority_mismatch");
	let locator: TaskArtifactOwnerLocator | undefined;
	try {
		locator = parseTaskArtifactOwnerLocator(target.taskArtifactOwnerLocator);
	} catch {
		throw new Error("task_artifact_owner_continuation_authority_mismatch");
	}
	if (!locator) throw new Error("task_artifact_owner_continuation_authority_mismatch");
	let identity: SessionStorageFileIdentity;
	try {
		identity = managedGcRetirementIdentityValue(managedGcRetirementIdentityRecord(target.transcriptIdentity));
	} catch {
		throw new Error("task_artifact_owner_continuation_identity_invalid");
	}
	if (
		identity.nlink !== 1n ||
		identity.size < 0 ||
		!Number.isSafeInteger(identity.size) ||
		!/^[0-9a-f]{64}$/u.test(identity.sha256)
	)
		throw new Error("task_artifact_owner_continuation_identity_invalid");
	return { locator, identity };
}

/**
 * Strictly decode one persisted managed-GC receipt. A decoded `owner_retired` outcome is persisted DTO data only;
 * this pure parser does not verify current filesystem state, payload destruction, or writer quiescence. A future
 * journal reader must perform the live physical-retirement proof for the relevant state before treating it as done.
 */
export function parseManagedGcRetirementReceipt(
	value: unknown,
	scopeDigest: string,
	ownerContext: TaskArtifactOwnerStorageContext,
	target: ManagedGcSessionRetirementTarget,
): ManagedGcSessionRetirementReceipt {
	if (!isRecord(value)) throw new Error("task_artifact_owner_continuation_corrupt");
	const { locator: targetLocator, identity: targetIdentity } = validateTarget(ownerContext, target);
	const record = value;
	const state = record.state;
	const commonKeys = [
		"schemaVersion",
		"state",
		"scope",
		"transcriptPath",
		"sessionId",
		"cwd",
		"transcriptIdentity",
		"taskArtifactOwnerDeletionEvidence",
	];
	const outcomeValue = record.taskArtifactOwnerRetirementOutcome;
	const outcomeKind = isRecord(outcomeValue) ? outcomeValue.kind : undefined;
	const expectedKeys =
		state === "prepared"
			? commonKeys
			: state === "artifacts_removed"
				? [...commonKeys, "artifactsRemoved"]
				: state === "owner_pending"
					? [
							...commonKeys,
							"ownerRetirementAttempt",
							"artifactsRemoved",
							"taskArtifactOwnerRetirementOutcome",
							"taskArtifactOwnerRetirementContinuation",
							...(outcomeKind === "payload_retired"
								? ["taskArtifactOwnerPayloadRetired", "taskArtifactOwnerNamespaceRetained"]
								: []),
						]
					: state === "owner_retired"
						? [
								...commonKeys,
								"artifactsRemoved",
								"taskArtifactOwnerRetired",
								"taskArtifactOwnerRetirementOutcome",
							]
						: undefined;
	if (
		!expectedKeys ||
		Object.keys(record).length !== expectedKeys.length ||
		!expectedKeys.every(key => key in record) ||
		record.schemaVersion !== 1 ||
		record.scope !== scopeDigest ||
		record.transcriptPath !== target.transcriptPath ||
		record.sessionId !== target.sessionId ||
		record.cwd !== target.cwd ||
		(state !== "prepared" && record.artifactsRemoved !== true) ||
		(state === "owner_retired" && record.taskArtifactOwnerRetired !== true) ||
		(state === "owner_pending" &&
			(!Number.isSafeInteger(record.ownerRetirementAttempt) || (record.ownerRetirementAttempt as number) < 1))
	)
		throw new Error("task_artifact_owner_continuation_mismatch");
	const identity = managedGcRetirementIdentityValue(record.transcriptIdentity);
	if (!sameIdentity(identity, targetIdentity)) throw new Error("task_artifact_owner_continuation_transcript_replaced");
	let evidence: TaskArtifactOwnerDeletionEvidence;
	try {
		evidence = parseTaskArtifactOwnerDeletionEvidence(record.taskArtifactOwnerDeletionEvidence);
	} catch {
		throw new Error("task_artifact_owner_continuation_evidence_corrupt");
	}
	if (evidence.sessionId !== target.sessionId || JSON.stringify(evidence.locator) !== JSON.stringify(targetLocator))
		throw new Error("task_artifact_owner_continuation_locator_mismatch");
	let outcome: TaskArtifactOwnerRetirementOutcome | undefined;
	if (state === "owner_pending" || state === "owner_retired") {
		outcome = parseTaskArtifactOwnerRetirementOutcome(ownerContext, evidence, outcomeValue);
		if (
			(state === "owner_pending" && outcome.kind === "completed") ||
			(state === "owner_retired" && outcome.kind !== "completed")
		)
			throw new Error("task_artifact_owner_continuation_outcome_mismatch");
		if (outcome.kind !== "completed") {
			let receiptContinuation: TaskArtifactOwnerRetirementContinuation;
			try {
				receiptContinuation = parseTaskArtifactOwnerRetirementContinuation(
					ownerContext,
					evidence,
					record.taskArtifactOwnerRetirementContinuation,
				);
			} catch {
				throw new Error("task_artifact_owner_continuation_outcome_mismatch");
			}
			if (JSON.stringify(receiptContinuation) !== JSON.stringify(outcome.continuation))
				throw new Error("task_artifact_owner_continuation_outcome_mismatch");
			if (
				(outcome.kind === "payload_retired" &&
					(record.taskArtifactOwnerPayloadRetired !== true ||
						record.taskArtifactOwnerNamespaceRetained !== true)) ||
				(outcome.kind !== "payload_retired" &&
					("taskArtifactOwnerPayloadRetired" in record || "taskArtifactOwnerNamespaceRetained" in record))
			)
				throw new Error("task_artifact_owner_continuation_outcome_mismatch");
		}
	}
	return {
		state: state as ManagedGcSessionRetirementState,
		transcriptPath: target.transcriptPath,
		sessionId: target.sessionId,
		cwd: target.cwd,
		transcriptIdentity: identity,
		taskArtifactOwnerLocator: targetLocator,
		taskArtifactOwnerDeletionEvidence: evidence,
		...(state !== "prepared" ? { artifactsRemoved: true as const } : {}),
		...(state === "owner_pending" ? { ownerRetirementAttempt: record.ownerRetirementAttempt as number } : {}),
		...(outcome ? { taskArtifactOwnerRetirementOutcome: outcome } : {}),
		...(outcome && outcome.kind !== "completed"
			? { taskArtifactOwnerRetirementContinuation: outcome.continuation }
			: {}),
		...(outcome?.kind === "payload_retired"
			? { taskArtifactOwnerPayloadRetired: true as const, taskArtifactOwnerNamespaceRetained: true as const }
			: {}),
		...(state === "owner_retired" ? { taskArtifactOwnerRetired: true as const } : {}),
	};
}

/** Check only monotone DTO history; this does not establish physical cleanup or current authority. */
export function continuationExtendsPrevious(
	previous: TaskArtifactOwnerRetirementContinuation,
	next: TaskArtifactOwnerRetirementContinuation,
): boolean {
	const previousTree = previous.retainedTreeSnapshot;
	const nextTree = next.retainedTreeSnapshot;
	if (
		previous.parentIdentity.dev !== next.parentIdentity.dev ||
		previous.parentIdentity.ino !== next.parentIdentity.ino ||
		previousTree.rootDev !== nextTree.rootDev ||
		previousTree.rootIno !== nextTree.rootIno ||
		nextTree.entries.length > previousTree.entries.length
	)
		return false;
	const previousEntries = new Map(previousTree.entries.map(entry => [entry.relativePath, entry]));
	for (const entry of nextTree.entries) {
		const old = previousEntries.get(entry.relativePath);
		if (
			!old ||
			old.kind !== entry.kind ||
			old.dev !== entry.dev ||
			old.ino !== entry.ino ||
			old.nlink !== entry.nlink
		)
			return false;
		if (
			entry.kind === "file" &&
			!(
				(entry.size === old.size && entry.sha256 === old.sha256) ||
				(entry.size === "0" && entry.sha256 === EMPTY_PAYLOAD_SHA256)
			)
		)
			return false;
		if (entry.kind !== "file" && entry.size !== old.size) return false;
	}
	for (const key of [
		"detachedPaths",
		"nativeCodes",
		"retainedSuccessorPaths",
		"retainedPlaceholderPaths",
		"retainedUnknownPaths",
		"windowsErrorCodes",
	] as const) {
		const oldValues = previous[key] ?? [];
		const nextValues = next[key] ?? [];
		if (!oldValues.every(item => nextValues.includes(item))) return false;
	}
	return previous.payloadDurable !== true || next.payloadDurable === true;
}
