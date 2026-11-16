import * as crypto from "node:crypto";
import type { SdkResumeCheckpoint } from "./resume-cursor";

/** Data-only evidence contracts. None of these predicates dispatches lifecycle or storage effects. */
export interface ResumeFileIdentity {
	readonly dev: string;
	readonly ino: string;
}

export interface ResumePolicy {
	readonly kind: "exclusive_native" | "cooperative_tui";
	readonly memberKind: string;
	readonly rev: number;
	readonly authorityKey: string;
	readonly epoch: string;
}

export interface ResumeMemberBinding {
	readonly memberToken: string;
	readonly authorityKey: string;
	readonly epoch: string;
	readonly policy: ResumePolicy;
}

export interface ResumeGeneration {
	readonly fileEntriesIndex0: number;
	readonly entryRevision0: number;
}

export interface ResumePlan {
	readonly enroll: string | null;
	readonly selectionRequested: boolean;
	readonly cursorIds: readonly string[];
	readonly dependentIds: readonly string[];
	readonly target: string | null;
}

export interface ResumeManifestEntry {
	readonly id: string;
	readonly kind: "enroll" | "cursor" | "dependent";
	readonly parentId: string | null;
	readonly payloadDigest: string;
	readonly order: number;
}

export interface PendingResumeOp extends ResumeMemberBinding {
	readonly op: string;
	readonly plan: ResumePlan;
	readonly manifest: readonly ResumeManifestEntry[];
	/** Immutable intended continuation base; never inferred from the current resident leaf. */
	readonly CB: string | null;
	readonly g0: ResumeGeneration;
	readonly durabilityDebt: {
		readonly ids: readonly string[];
		readonly fileIdentity: ResumeFileIdentity;
		readonly lastError?: string;
		readonly attempts: number;
	};
}

export interface ResumeByteRange {
	readonly id: string;
	/** Physical entry index in this publication, not a cursor chunk index. */
	readonly idx: number;
	readonly start: number;
	readonly end: number;
	readonly hash: string;
}

export interface DurabilityProof {
	readonly kind: "sync_ok" | "backend_ack" | "final_drain_sync";
	readonly fileIdentity: ResumeFileIdentity;
	readonly namespaceSynced: boolean;
	readonly publicationId: string;
	readonly snapshotDigest: string;
	/** Allows an unchanged earlier publication to cover its ranges in an extended fresh snapshot. */
	readonly snapshotByteLength: number;
	readonly op: string;
	readonly idxs: readonly number[];
	readonly syncSeq: number;
	readonly ranges: readonly ResumeByteRange[];
}

export interface ResumeCapturedEntry {
	readonly id: string;
	readonly parentId: string | null;
	readonly payloadDigest: string;
	readonly order: number;
	readonly range: ResumeByteRange;
}

export interface ResumeFreshCapture {
	readonly kind: "captured";
	readonly bytes: Uint8Array;
	readonly fileIdentity: ResumeFileIdentity;
	readonly snapshotDigest: string;
	readonly fresh: boolean;
	readonly frozen: boolean;
	readonly drained: boolean;
	readonly entries: readonly ResumeCapturedEntry[];
	/** The real reducer result for these exact bytes, including durable cursor prefixes. */
	readonly reducerView: SdkResumeCheckpoint;
}

export interface ResumeReadFailure {
	readonly kind: "read_failed";
	readonly error: string;
}

export interface ResumeResidentEntry extends ResumeManifestEntry {
	readonly residentKind: "planned" | "dependent" | "retainedLocal" | "unexplained";
}

/** Issued by the registry adapter AFTER an authorized termination, never a request to terminate. */
export type ResumeTerminationAuthorization =
	| {
			readonly kind: "coordinator_abort";
			readonly registryIntentId: string;
			readonly coordinatorOpenToken: string;
			readonly ownership: "owned_pre";
			readonly runtimeHandoff: false;
	  }
	| {
			readonly kind: "consented_teardown";
			readonly registryIntentId: string;
			readonly stopAdmitting: true;
			readonly runtime: "not_published" | "stopped_joined";
	  };

export interface ResumeClosureEvidence {
	readonly authorization: ResumeTerminationAuthorization;
	readonly finalCaptureDigest: string;
	readonly preCloseSnapshotByteLength: number;
	readonly writerClosed: boolean;
	readonly drained: boolean;
	readonly writesRejected: boolean;
	readonly residentReleased: boolean;
	readonly publishedByFinalDrain: readonly string[];
}

/** Actual registry mutation receipt, distinct from permission returned by P_retire. */
export interface ResumeRetirementEvidence {
	readonly kind: "member_retired";
	readonly registryIntentId: string;
	readonly memberToken: string;
	readonly authorityKey: string;
	readonly epoch: string;
	readonly op: string;
	readonly finalCaptureDigest: string;
}

export type ResumeManagerEvidence =
	| {
			readonly kind: "live";
			readonly strictClosePending: false;
			readonly residentAttempt: "retained" | "discarded";
	  }
	| {
			readonly kind: "terminal";
			readonly closeOutcome: "in_flight" | "closed" | "close_failed_retryable" | "close_unknown" | "no_manager";
			readonly residentAttempt: "retained" | "discarded";
			readonly closure?: ResumeClosureEvidence;
	  };

export type ResumeCompletionRefusal =
	| "stale_snapshot"
	| "foreign_progress"
	| "unexplained_resident_branch"
	| "participation_lost"
	| "authority_changed"
	| "policy_mismatch"
	| "rewrite_required"
	| "durability_repair_unavailable"
	| "manager_closed"
	| "context_mismatch"
	| "termination_not_authorized";

/** Report-only dispatch information supplied by the lifecycle registry; never consulted as proof. */
export interface ResumeRouting {
	readonly contextFamily: "live" | "terminal";
	readonly context: "owned_pre" | "runtime" | "terminal";
	readonly closeOutcome:
		| "none_started"
		| "in_flight"
		| "closed"
		| "close_failed_retryable"
		| "close_unknown"
		| "no_manager";
	readonly invocation: "OPEN" | "RECON" | "TERM";
	readonly authorization: {
		readonly tokenValid: boolean;
		readonly terminationIntent: "none" | "coordinator_abort" | "consented_teardown";
		readonly intentValid: boolean;
		readonly refusal?: "termination_not_authorized" | "context_mismatch" | "manager_closed";
	};
	readonly action: "PROCEED" | "RETAIN_LIVE" | "TERMINATE" | "POST_READONLY";
	readonly completionResult: "n/a" | "success" | "refused" | "failed" | "partial";
	readonly readiness: {
		readonly prior: "ready" | "fenced" | "n/a";
		readonly current: "ready" | "fenced" | "n/a";
	};
}

export interface ResumeOperationEvidence {
	readonly pending: PendingResumeOp;
	readonly capture: ResumeFreshCapture | ResumeReadFailure;
	readonly proofs: readonly DurabilityProof[];
	readonly durabilityState: "proven" | "unproven" | "sync_failed" | "repair_failed" | "repair_unavailable";
	readonly lastError?: string;
	readonly manager: ResumeManagerEvidence;
	readonly retirement?: ResumeRetirementEvidence;
	readonly residentSuffix: readonly ResumeResidentEntry[];
	readonly residentTip: string | null;
	readonly preOpCommittedTail: string | null;
	/** Exact pre-operation prefix, captured at g0; prevents foreign file progress being explained away. */
	readonly preOpEntries: readonly ResumeManifestEntry[];
	readonly remainingConflict: readonly string[];
	readonly generation: { readonly gFreeze: ResumeGeneration; readonly gPublish: ResumeGeneration };
	readonly freezeId?: string;
	readonly debt: {
		readonly rewriteDebt: boolean;
		readonly heldQueueIds: readonly string[];
		readonly deferredPublicationIds: readonly string[];
		readonly heldReason?: "freeze_parked" | "persist_debt" | "rewrite_debt";
	};
	readonly readiness: {
		readonly writer: "usable" | "unusable";
		readonly currentBinding: ResumeMemberBinding | null;
		readonly localContextCurrent: boolean;
		readonly persistError?: { readonly errorRef: string; readonly repairedErrorRef?: string };
	};
	readonly context: "PRE" | "WARM" | "POST";
	readonly routing: ResumeRouting;
	readonly completionRefusal?: ResumeCompletionRefusal;
	readonly publishedAfterThaw: readonly string[];
}

export type ResumeManifestShape =
	| "manifest_complete"
	| "manifest_complete_with_remaining_conflict"
	| "enrolled_only"
	| "partial_chain"
	| "dependents_absent"
	| "dependents_partial"
	| "not_committed"
	| "unknown";
export type ResumeSuffixState = "none" | "published" | "held" | "unproven" | "lost";
export type ResumeOutcomeKind =
	| "committed"
	| "committed_with_remaining_conflict"
	| "suffix_incomplete"
	| "enrolled_only"
	| "partial_chain"
	| "dependents_absent"
	| "dependents_partial"
	| "not_committed"
	| "unknown";
export type ResumeUnknownReason =
	| "read_failed"
	| "gap"
	| "durability"
	| "resident_attempt_retained"
	| "stale_snapshot"
	| "unexplained_resident_branch";

export interface ResumeResidentReceipt {
	readonly id: string;
	readonly parentId: string | null;
	readonly digest: string;
	readonly kind: "planned" | "dependent" | "retainedLocal" | "unexplained";
	readonly state: "published_with_D" | "published_no_D" | "held" | "lost";
}

export interface ResumeCommitment {
	readonly selectionEffect: "none" | "marker_only" | "cursor_prefix" | "committed";
	readonly selectionCommitted: boolean;
	readonly durableCursorIds: readonly string[];
	readonly missingCursorIds: readonly string[];
	readonly reducerView: {
		readonly kind: SdkResumeCheckpoint["kind"];
		readonly candidates: readonly string[];
		readonly leaf: string | null;
	} | null;
	readonly manifestComplete: boolean;
	readonly suffixState: ResumeSuffixState;
	readonly heldIds: readonly string[];
	readonly unprovenIds: readonly string[];
	readonly lostResidentIds: readonly string[];
	readonly heldReason?: "freeze_parked" | "persist_debt" | "rewrite_debt";
	readonly operationComplete: boolean;
	readonly dependentsPresent: readonly string[];
	readonly dependentsMissing: readonly string[];
	readonly continueEligible: boolean;
}

export interface ResumeSelectionReceipt {
	readonly op: string;
	readonly plan: ResumePlan;
	readonly manifestShape: ResumeManifestShape;
	readonly presence: { readonly present: readonly string[]; readonly missing: readonly string[] };
	readonly durability: {
		readonly state: ResumeOperationEvidence["durabilityState"];
		readonly proof?: DurabilityProof;
		readonly proofs: readonly DurabilityProof[];
		readonly attempts: number;
		readonly lastError?: string;
	};
	readonly frontier: { readonly CF: string | null; readonly CB: string | null; readonly RT: string | null };
	readonly selectionAppendBase: string | null;
	readonly residentTip: string | null;
	readonly finalPublishedTip: string | null;
	readonly residentSuffix: readonly ResumeResidentReceipt[];
	readonly generation: {
		readonly g0: ResumeGeneration;
		readonly gFreeze: ResumeGeneration;
		readonly gPublish: ResumeGeneration;
	};
	readonly debt: {
		readonly missingPlanned: readonly string[];
		readonly retainedLocalIds: readonly string[];
		readonly rewriteDebt: boolean;
	};
	readonly policyPath: ResumePolicy["kind"];
	readonly freezeId?: string;
	readonly targetLeafId: string | null;
	readonly remainingConflict: readonly string[];
	readonly outcome: ResumeOutcomeKind;
	readonly completionRefusal?: ResumeCompletionRefusal;
	readonly commitment: ResumeCommitment;
	readonly routing: ResumeRouting;
	readonly finalClassification: {
		readonly outcome: ResumeOutcomeKind;
		readonly manifestShape: ResumeManifestShape;
		readonly suffixState: ResumeSuffixState;
		readonly durability: ResumeOperationEvidence["durabilityState"];
		readonly finalPublishedTip: string | null;
		readonly publishedByFinalDrain: readonly string[];
	};
	readonly terminalDisposition: {
		readonly kind: "retired" | "retained_live" | "retained_after_close";
		readonly reason: string;
		readonly receiptKind: ResumeOutcomeKind;
	};
	readonly finalEffects: {
		readonly publishedAfterThaw: readonly string[];
		readonly heldLocalIds: readonly string[];
		readonly lostResidentIds: readonly string[];
	};
}

interface ResumeOutcomeCommon {
	readonly context: "PRE" | "WARM" | "POST";
	readonly receipt: ResumeSelectionReceipt;
}

export type ResumeCheckpointOutcome = ResumeOutcomeCommon &
	(
		| { readonly kind: "committed" }
		| { readonly kind: "committed_with_remaining_conflict" }
		| { readonly kind: "enrolled_only" }
		| { readonly kind: "partial_chain" }
		| { readonly kind: "dependents_absent" }
		| { readonly kind: "dependents_partial" }
		| {
				readonly kind: "suffix_incomplete";
				readonly base: "committed" | "committed_with_remaining_conflict";
				readonly suffixState: "held" | "unproven" | "lost";
				readonly heldIds: readonly string[];
				readonly unprovenIds: readonly string[];
				readonly lostResidentIds: readonly string[];
		  }
		| {
				readonly kind: "not_committed";
				readonly reason: "discarded_after_final_drain" | "discarded_after_nonterminal_drain";
		  }
		| {
				readonly kind: "unknown";
				readonly reason: ResumeUnknownReason;
				readonly ids: readonly string[];
				readonly op: string;
				readonly pendingIds: readonly string[];
				readonly advisory: { readonly present: readonly string[]; readonly shape: ResumeManifestShape };
				readonly durability: ResumeSelectionReceipt["durability"];
		  }
	);

export interface ReconcileResult {
	readonly outcome: ResumeCheckpointOutcome;
	readonly receipt: ResumeSelectionReceipt;
	readonly refusal?: ResumeCompletionRefusal;
}

function digest(bytes: Uint8Array): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sameIdentity(a: ResumeFileIdentity, b: ResumeFileIdentity): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}

function validRange(range: ResumeByteRange, bytes: Uint8Array): boolean {
	return (
		Number.isSafeInteger(range.idx) &&
		range.idx >= 0 &&
		Number.isSafeInteger(range.start) &&
		Number.isSafeInteger(range.end) &&
		range.start >= 0 &&
		range.end > range.start &&
		range.end <= bytes.byteLength &&
		digest(bytes.subarray(range.start, range.end)) === range.hash
	);
}

/** Revalidates positive sync evidence against exact fresh bytes. Readability alone covers no ids. */
export function validateDurabilityProof(
	proof: DurabilityProof,
	pending: PendingResumeOp,
	capture: ResumeFreshCapture,
): readonly string[] {
	if (
		!capture.fresh ||
		digest(capture.bytes) !== capture.snapshotDigest ||
		!sameIdentity(proof.fileIdentity, capture.fileIdentity) ||
		!sameIdentity(pending.durabilityDebt.fileIdentity, capture.fileIdentity) ||
		!proof.namespaceSynced ||
		proof.op !== pending.op ||
		!proof.publicationId ||
		!Number.isSafeInteger(proof.syncSeq) ||
		proof.syncSeq < 1 ||
		!Number.isSafeInteger(proof.snapshotByteLength) ||
		proof.snapshotByteLength < 0 ||
		proof.snapshotByteLength > capture.bytes.byteLength ||
		digest(capture.bytes.subarray(0, proof.snapshotByteLength)) !== proof.snapshotDigest ||
		new Set(proof.idxs).size !== proof.idxs.length ||
		proof.idxs.length !== proof.ranges.length
	)
		return [];
	const covered: string[] = [];
	for (const range of proof.ranges) {
		const entry = capture.entries.find(candidate => candidate.id === range.id);
		if (
			!entry ||
			!proof.idxs.includes(range.idx) ||
			range.end > proof.snapshotByteLength ||
			!validRange(range, capture.bytes) ||
			entry.range.id !== range.id ||
			entry.range.idx !== range.idx ||
			entry.range.start !== range.start ||
			entry.range.end !== range.end ||
			entry.range.hash !== range.hash
		)
			return [];
		covered.push(range.id);
	}
	return new Set(covered).size === covered.length ? covered : [];
}

interface Analysis {
	shape: ResumeManifestShape;
	reason?: ResumeUnknownReason;
	present: string[];
	missing: string[];
	durable: Set<string>;
	suffix: ResumeResidentReceipt[];
	suffixState: ResumeSuffixState;
	commitment: ResumeCommitment;
	CF: string | null;
	finalPublishedTip: string | null;
	remainingConflict: readonly string[];
}

function remainingConflicts(e: ResumeOperationEvidence): readonly string[] {
	if (e.capture.kind !== "captured") return e.remainingConflict;
	const capture = e.capture;
	const entries = new Map(capture.entries.map(entry => [entry.id, entry]));
	const selected =
		e.pending.CB !== null && entries.has(e.pending.CB)
			? e.pending.CB
			: ([...e.pending.plan.cursorIds].reverse().find(id => entries.has(id)) ?? e.pending.plan.target);
	const remaining = new Set(e.remainingConflict);
	for (const candidate of capture.reducerView.candidates ?? []) {
		let id: string | null = candidate;
		const visited = new Set<string>();
		let selectedLineage = false;
		// Null is not a shared graph vertex: every hop must belong to this operation.
		let ownedNullLineage = selected === null && e.pending.CB === null && e.pending.plan.cursorIds.length === 0;
		while (id !== null && !visited.has(id)) {
			if (id === selected) {
				selectedLineage = true;
				break;
			}
			visited.add(id);
			const actual = entries.get(id);
			if (ownedNullLineage) {
				const planned = e.pending.manifest.find(entry => entry.id === id);
				const resident = e.residentSuffix.find(entry => entry.id === id);
				const expected = planned ?? (resident?.residentKind === "retainedLocal" ? resident : undefined);
				ownedNullLineage =
					actual !== undefined &&
					expected !== undefined &&
					sameEntry(expected, actual) &&
					validRange(actual.range, capture.bytes) &&
					(!resident ||
						(resident.residentKind !== "unexplained" &&
							sameEntry(resident, actual) &&
							(!planned || planned.order === resident.order)));
			}
			id = actual?.parentId ?? null;
		}
		if (!selectedLineage && !(id === null && ownedNullLineage)) remaining.add(candidate);
	}
	return [...remaining];
}

function sameEntry(
	expected: ResumeManifestEntry,
	actual: Pick<ResumeCapturedEntry, "id" | "parentId" | "payloadDigest">,
): boolean {
	return (
		expected.id === actual.id &&
		expected.parentId === actual.parentId &&
		expected.payloadDigest === actual.payloadDigest
	);
}

function finalClosedCapture(e: ResumeOperationEvidence): boolean {
	return (
		e.manager.kind === "terminal" &&
		e.manager.closeOutcome === "closed" &&
		e.manager.closure?.writerClosed === true &&
		e.manager.closure.drained &&
		e.capture.kind === "captured" &&
		e.capture.fresh &&
		e.capture.frozen &&
		e.capture.drained &&
		e.manager.closure.finalCaptureDigest === e.capture.snapshotDigest &&
		digest(e.capture.bytes) === e.capture.snapshotDigest
	);
}

function analyze(e: ResumeOperationEvidence): Analysis {
	const p = e.pending;
	const finalClosed = finalClosedCapture(e);
	const remainingConflict = remainingConflicts(e);
	const c = e.capture.kind === "captured" ? e.capture : null;
	const present = p.manifest.filter(entry => c?.entries.some(actual => actual.id === entry.id)).map(entry => entry.id);
	const missing = p.manifest.filter(entry => !present.includes(entry.id)).map(entry => entry.id);
	const durable = new Set<string>();
	if (c && e.durabilityState === "proven") {
		for (const proof of e.proofs) for (const id of validateDurabilityProof(proof, p, c)) durable.add(id);
	}
	let reason: ResumeUnknownReason | undefined;
	if (!c) reason = "read_failed";
	else if (
		!c.fresh ||
		!c.frozen ||
		!c.drained ||
		digest(c.bytes) !== c.snapshotDigest ||
		c.reducerView.snapshotDigest !== c.snapshotDigest ||
		!sameIdentity(p.durabilityDebt.fileIdentity, c.fileIdentity)
	)
		reason = "stale_snapshot";
	else {
		const plannedIds = [
			...(p.plan.enroll === null ? [] : [p.plan.enroll]),
			...p.plan.cursorIds,
			...p.plan.dependentIds,
		];
		if (
			new Set(plannedIds).size !== plannedIds.length ||
			plannedIds.length !== p.manifest.length ||
			p.manifest.some(
				(entry, index) =>
					entry.id !== plannedIds[index] ||
					entry.order !== index ||
					entry.kind !==
						(entry.id === p.plan.enroll
							? "enroll"
							: p.plan.cursorIds.includes(entry.id)
								? "cursor"
								: "dependent"),
			)
		)
			reason = "gap";
		if (c.reducerView.kind === "invalid") reason = "gap";
		const seen = new Set<string>();
		let lastEnd = 0;
		let lastOrder = -1;
		for (const entry of c.entries) {
			if (
				seen.has(entry.id) ||
				entry.id !== entry.range.id ||
				entry.order !== entry.range.idx ||
				entry.order <= lastOrder ||
				entry.range.start < lastEnd ||
				!validRange(entry.range, c.bytes)
			)
				reason = "gap";
			seen.add(entry.id);
			lastEnd = entry.range.end;
			lastOrder = entry.order;
		}
		const actualManifest = c.entries.filter(entry => plannedIds.includes(entry.id));
		if (actualManifest.some((entry, index) => !p.manifest[index] || !sameEntry(p.manifest[index], entry)))
			reason = "gap";
		if (
			e.preOpEntries.some((entry, index) => !c.entries[index] || !sameEntry(entry, c.entries[index])) ||
			c.entries.some(
				entry =>
					!e.preOpEntries.some(prior => prior.id === entry.id) &&
					!plannedIds.includes(entry.id) &&
					!e.residentSuffix.some(resident => resident.id === entry.id),
			)
		)
			reason = "gap";
	}
	let shape: ResumeManifestShape = "unknown";
	if (!reason) {
		if (p.manifest.length > 0 && present.length === 0) shape = "not_committed";
		else if (missing.length === 0)
			shape = remainingConflict.length === 0 ? "manifest_complete" : "manifest_complete_with_remaining_conflict";
		else {
			const cursors = p.plan.cursorIds.filter(id => present.includes(id)).length;
			const dependents = p.plan.dependentIds.filter(id => present.includes(id)).length;
			if (cursors < p.plan.cursorIds.length) shape = cursors === 0 ? "enrolled_only" : "partial_chain";
			else shape = dependents === 0 ? "dependents_absent" : "dependents_partial";
		}
	}
	const suffix: ResumeResidentReceipt[] = [];
	const accounted = new Set(c?.entries.map(entry => entry.id) ?? []);
	const residentIds = new Set<string>();
	let residentOrder = -1;
	for (const entry of e.residentSuffix) {
		const actual = c?.entries.find(candidate => candidate.id === entry.id);
		const planned = p.manifest.find(candidate => candidate.id === entry.id);
		if (
			entry.residentKind === "unexplained" ||
			residentIds.has(entry.id) ||
			entry.order <= residentOrder ||
			(entry.parentId !== null && !accounted.has(entry.parentId)) ||
			(planned && (!sameEntry(planned, entry) || planned.order !== entry.order)) ||
			(!planned && entry.residentKind !== "retainedLocal") ||
			(actual && !sameEntry(entry, actual))
		)
			reason ??= "unexplained_resident_branch";
		residentIds.add(entry.id);
		residentOrder = entry.order;
		accounted.add(entry.id);
		const state = actual
			? durable.has(entry.id)
				? "published_with_D"
				: "published_no_D"
			: finalClosed
				? "lost"
				: e.manager.kind === "live"
					? "held"
					: "published_no_D";
		suffix.push({
			id: entry.id,
			parentId: entry.parentId,
			digest: entry.payloadDigest,
			kind: entry.residentKind,
			state,
		});
	}
	// Missing staged manifest attempts are suffix debt even when a caller omits them from S.
	if (e.manager.residentAttempt === "retained") {
		for (const entry of p.manifest)
			if (missing.includes(entry.id) && !residentIds.has(entry.id)) {
				const state = e.manager.kind === "live" ? "held" : finalClosed ? "lost" : "published_no_D";
				suffix.push({
					id: entry.id,
					parentId: entry.parentId,
					digest: entry.payloadDigest,
					kind: entry.kind === "dependent" ? "dependent" : "planned",
					state,
				});
			}
	}
	if ([...e.debt.heldQueueIds, ...e.debt.deferredPublicationIds].some(id => !suffix.some(entry => entry.id === id)))
		reason ??= "unexplained_resident_branch";
	const heldIds = suffix.filter(entry => entry.state === "held").map(entry => entry.id);
	const unprovenIds = suffix.filter(entry => entry.state === "published_no_D").map(entry => entry.id);
	const lostResidentIds = suffix.filter(entry => entry.state === "lost").map(entry => entry.id);
	const suffixState: ResumeSuffixState = unprovenIds.length
		? "unproven"
		: heldIds.length
			? "held"
			: lostResidentIds.length
				? "lost"
				: suffix.length
					? "published"
					: "none";
	if (
		(suffixState === "none" || suffixState === "published") &&
		(e.debt.rewriteDebt || e.debt.heldQueueIds.length || e.debt.deferredPublicationIds.length)
	)
		reason ??= "resident_attempt_retained";
	if (!reason && shape === "not_committed") {
		const discarded =
			e.manager.residentAttempt === "discarded" &&
			!e.debt.rewriteDebt &&
			e.debt.heldQueueIds.length === 0 &&
			e.debt.deferredPublicationIds.length === 0 &&
			suffixState === "none";
		// A frozen live manager can prove an attempt was discarded without closing it.
		// Terminal cleanup still needs its fresh actual post-drain closure, never a PRE claim.
		const drained =
			e.manager.kind === "live" ||
			(finalClosed &&
				e.manager.closure?.residentReleased === true &&
				e.manager.closure.writesRejected &&
				e.manager.closure.drained);
		if (!discarded || !drained) reason = "resident_attempt_retained";
	}
	const structureValid = !reason;
	if (!reason && present.some(id => !durable.has(id))) reason = "durability";
	const valid = !reason;
	const durableCursorIds = p.plan.cursorIds.filter(id => structureValid && durable.has(id));
	const selectionCommitted =
		structureValid &&
		(p.plan.enroll === null || durable.has(p.plan.enroll)) &&
		durableCursorIds.length === p.plan.cursorIds.length;
	const manifestComplete = valid && missing.length === 0 && present.every(id => durable.has(id));
	const operationComplete =
		manifestComplete &&
		(suffixState === "none" || suffixState === "published") &&
		!e.debt.rewriteDebt &&
		e.debt.heldQueueIds.length === 0 &&
		e.debt.deferredPublicationIds.length === 0;
	const commitment: ResumeCommitment = {
		selectionEffect: selectionCommitted
			? "committed"
			: durableCursorIds.length
				? "cursor_prefix"
				: structureValid && p.plan.enroll !== null && durable.has(p.plan.enroll)
					? "marker_only"
					: "none",
		selectionCommitted,
		durableCursorIds,
		missingCursorIds: p.plan.cursorIds.filter(id => !durableCursorIds.includes(id)),
		reducerView: c
			? { kind: c.reducerView.kind, candidates: c.reducerView.candidates ?? [], leaf: c.reducerView.leafEntryId }
			: null,
		manifestComplete,
		suffixState,
		heldIds,
		unprovenIds,
		lostResidentIds,
		heldReason: e.debt.heldReason,
		operationComplete,
		dependentsPresent: p.plan.dependentIds.filter(id => structureValid && durable.has(id)),
		dependentsMissing: p.plan.dependentIds.filter(id => !structureValid || !durable.has(id)),
		continueEligible: false,
	};
	let CF = e.preOpCommittedTail;
	if (structureValid)
		for (const entry of p.manifest) {
			if (!durable.has(entry.id)) break;
			if (entry.kind !== "enroll") CF = entry.id;
		}
	let finalPublishedTip = CF;
	if (structureValid)
		for (const entry of suffix) {
			if (entry.state !== "published_with_D") break;
			if (entry.id !== p.plan.enroll) finalPublishedTip = entry.id;
		}
	return {
		shape,
		reason,
		present,
		missing,
		durable,
		suffix,
		suffixState,
		commitment,
		CF,
		finalPublishedTip,
		remainingConflict,
	};
}

function bindingMatches(p: PendingResumeOp, current: ResumeMemberBinding | null): boolean {
	return (
		current !== null &&
		current.memberToken === p.memberToken &&
		current.authorityKey === p.authorityKey &&
		current.epoch === p.epoch &&
		current.policy.kind === p.policy.kind &&
		current.policy.memberKind === p.policy.memberKind &&
		current.policy.rev === p.policy.rev &&
		current.policy.authorityKey === p.policy.authorityKey &&
		current.policy.epoch === p.policy.epoch &&
		p.policy.authorityKey === p.authorityKey &&
		p.policy.epoch === p.epoch
	);
}

function latch(e: ResumeOperationEvidence, a: Analysis): boolean {
	const error = e.readiness.persistError;
	return (
		!a.reason &&
		a.commitment.operationComplete &&
		e.manager.kind === "live" &&
		e.readiness.writer === "usable" &&
		e.readiness.localContextCurrent &&
		bindingMatches(e.pending, e.readiness.currentBinding) &&
		(!error ||
			(error.repairedErrorRef === error.errorRef &&
				e.proofs.length > 0 &&
				e.pending.durabilityDebt.ids.every(id => a.durable.has(id)) &&
				a.durable.size > 0))
	);
}

/** Writer readiness, independent of global cold-candidate conflicts. Does not clear an error itself. */
export function P_latch(evidence: ResumeOperationEvidence): boolean {
	return latch(evidence, analyze(evidence));
}

/** App-native Continue only; ordinary cooperative TUI turns are outside this predicate. */
export function P_continue(evidence: ResumeOperationEvidence): boolean {
	const analysis = analyze(evidence);
	return canContinue(evidence, analysis);
}

function canContinue(e: ResumeOperationEvidence, a: Analysis): boolean {
	return (
		latch(e, a) &&
		a.remainingConflict.length === 0 &&
		e.capture.kind === "captured" &&
		e.capture.reducerView.kind !== "invalid" &&
		e.capture.reducerView.kind !== "ambiguous" &&
		e.capture.reducerView.kind !== "legacy_tail"
	);
}

function finalDrainIds(e: ResumeOperationEvidence): readonly string[] {
	if (e.manager.kind !== "terminal" || !e.manager.closure || e.capture.kind !== "captured") return [];
	const closure = e.manager.closure;
	const own = new Set([...e.pending.manifest.map(entry => entry.id), ...e.residentSuffix.map(entry => entry.id)]);
	return [
		...new Set([
			...closure.publishedByFinalDrain,
			...e.capture.entries
				.filter(entry => own.has(entry.id) && entry.range.end > closure.preCloseSnapshotByteLength)
				.map(entry => entry.id),
		]),
	];
}

function retire(e: ResumeOperationEvidence, a: Analysis): boolean {
	if (
		e.manager.kind !== "terminal" ||
		e.manager.closeOutcome !== "closed" ||
		!e.manager.closure ||
		e.capture.kind !== "captured" ||
		a.reason ||
		e.debt.rewriteDebt ||
		e.debt.heldQueueIds.length ||
		e.debt.deferredPublicationIds.length
	)
		return false;
	const closure = e.manager.closure;
	const auth = closure.authorization;
	if (
		!auth.registryIntentId ||
		(auth.kind === "coordinator_abort" &&
			(!auth.coordinatorOpenToken || auth.ownership !== "owned_pre" || auth.runtimeHandoff !== false)) ||
		(auth.kind === "consented_teardown" &&
			(!auth.stopAdmitting || (auth.runtime !== "not_published" && auth.runtime !== "stopped_joined"))) ||
		!closure.writerClosed ||
		!closure.drained ||
		!closure.writesRejected ||
		!closure.residentReleased ||
		closure.finalCaptureDigest !== e.capture.snapshotDigest ||
		a.suffixState === "held" ||
		a.suffixState === "unproven"
	)
		return false;
	const ownPresent = [
		...a.present,
		...a.suffix.filter(entry => entry.state === "published_with_D").map(entry => entry.id),
	];
	if (ownPresent.some(id => !a.durable.has(id))) return false;
	const capture = e.capture;
	if (
		!Number.isSafeInteger(closure.preCloseSnapshotByteLength) ||
		closure.preCloseSnapshotByteLength < 0 ||
		closure.preCloseSnapshotByteLength > capture.bytes.byteLength
	)
		return false;
	for (const id of finalDrainIds(e)) {
		if (
			!ownPresent.includes(id) ||
			!e.proofs.some(
				proof =>
					proof.kind === "final_drain_sync" && validateDurabilityProof(proof, e.pending, capture).includes(id),
			)
		)
			return false;
	}
	return true;
}

/** Post-authorized-closure retirement permission only, never a decision to close or business success. */
export function P_retire(evidence: ResumeOperationEvidence): boolean {
	return retire(evidence, analyze(evidence));
}

export function classifyResumeOperation(evidence: ResumeOperationEvidence): ReconcileResult {
	const e = evidence;
	const a = analyze(e);
	const ready = latch(e, a);
	const retirementPermitted = retire(e, a);
	const r = e.retirement;
	const retired =
		retirementPermitted &&
		r !== undefined &&
		r.kind === "member_retired" &&
		r.op === e.pending.op &&
		r.memberToken === e.pending.memberToken &&
		r.authorityKey === e.pending.authorityKey &&
		r.epoch === e.pending.epoch &&
		e.manager.kind === "terminal" &&
		r.registryIntentId === e.manager.closure?.authorization.registryIntentId &&
		e.capture.kind === "captured" &&
		r.finalCaptureDigest === e.capture.snapshotDigest;
	const commitment: ResumeCommitment = { ...a.commitment, continueEligible: canContinue(e, a) };
	const base = a.remainingConflict.length ? "committed_with_remaining_conflict" : "committed";
	const kind: ResumeOutcomeKind = a.reason
		? "unknown"
		: a.shape === "manifest_complete" || a.shape === "manifest_complete_with_remaining_conflict"
			? a.suffixState === "none" || a.suffixState === "published"
				? base
				: "suffix_incomplete"
			: a.shape;
	const durability: ResumeSelectionReceipt["durability"] = {
		state:
			(a.reason === "durability" || a.suffixState === "unproven") && e.durabilityState === "proven"
				? "unproven"
				: e.durabilityState,
		proof: e.proofs[0],
		proofs: e.proofs,
		attempts: e.pending.durabilityDebt.attempts,
		lastError: e.lastError ?? e.pending.durabilityDebt.lastError,
	};
	const receipt: ResumeSelectionReceipt = {
		op: e.pending.op,
		plan: e.pending.plan,
		manifestShape: a.shape,
		presence: { present: a.present, missing: a.missing },
		durability,
		frontier: { CF: a.CF, CB: e.pending.CB, RT: e.residentTip },
		selectionAppendBase: e.pending.CB,
		residentTip: e.residentTip,
		finalPublishedTip: a.finalPublishedTip,
		residentSuffix: a.suffix,
		generation: { g0: e.pending.g0, ...e.generation },
		debt: {
			missingPlanned: a.missing,
			retainedLocalIds: e.residentSuffix
				.filter(entry => entry.residentKind === "retainedLocal")
				.map(entry => entry.id),
			rewriteDebt: e.debt.rewriteDebt,
		},
		policyPath: e.pending.policy.kind,
		freezeId: e.freezeId,
		targetLeafId: e.pending.plan.target,
		remainingConflict: a.remainingConflict,
		outcome: kind,
		completionRefusal: e.completionRefusal,
		commitment,
		routing: {
			...e.routing,
			readiness: {
				prior: e.routing.readiness.prior,
				current:
					e.manager.kind !== "live"
						? "n/a"
						: e.routing.authorization.refusal === "termination_not_authorized" ||
								e.routing.authorization.refusal === "context_mismatch"
							? e.routing.readiness.prior
							: ready
								? "ready"
								: "fenced",
			},
		},
		finalClassification: {
			outcome: kind,
			manifestShape: a.shape,
			suffixState: a.suffixState,
			durability: durability.state,
			finalPublishedTip: a.finalPublishedTip,
			publishedByFinalDrain: finalDrainIds(e),
		},
		terminalDisposition: {
			kind: e.manager.kind === "live" ? "retained_live" : retired ? "retired" : "retained_after_close",
			reason:
				e.manager.kind === "live"
					? "nonterminal_classification"
					: retired
						? "registry_retirement_recorded"
						: retirementPermitted
							? "retirement_permitted_not_applied"
							: "closure_or_durability_unresolved",
			receiptKind: kind,
		},
		finalEffects: {
			publishedAfterThaw: e.publishedAfterThaw,
			heldLocalIds: commitment.heldIds,
			lostResidentIds: commitment.lostResidentIds,
		},
	};
	const common: ResumeOutcomeCommon = { context: e.context, receipt };
	let outcome: ResumeCheckpointOutcome;
	if (kind === "unknown")
		outcome = {
			...common,
			kind,
			reason: a.reason ?? "gap",
			ids: a.present,
			op: e.pending.op,
			pendingIds: a.missing,
			advisory: { present: a.present, shape: a.shape },
			durability,
		};
	else if (kind === "not_committed")
		outcome = {
			...common,
			kind,
			reason: e.manager.kind === "live" ? "discarded_after_nonterminal_drain" : "discarded_after_final_drain",
		};
	else if (kind === "suffix_incomplete")
		outcome = {
			...common,
			kind,
			base,
			suffixState: a.suffixState === "held" || a.suffixState === "lost" ? a.suffixState : "unproven",
			heldIds: commitment.heldIds,
			unprovenIds: commitment.unprovenIds,
			lostResidentIds: commitment.lostResidentIds,
		};
	else if (kind === "committed") outcome = { ...common, kind };
	else if (kind === "committed_with_remaining_conflict") outcome = { ...common, kind };
	else if (kind === "enrolled_only") outcome = { ...common, kind };
	else if (kind === "partial_chain") outcome = { ...common, kind };
	else if (kind === "dependents_absent") outcome = { ...common, kind };
	else outcome = { ...common, kind };
	return { outcome, receipt, refusal: e.completionRefusal };
}
