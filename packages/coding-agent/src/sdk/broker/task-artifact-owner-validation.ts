import type { NativeExactUnlinkResult } from "@gajae-code/natives";
import {
	assertSessionRoot,
	parseTaskArtifactOwnerDeletionEvidence,
	parseTaskArtifactOwnerRetirementContinuation,
	parseTaskArtifactOwnerRetirementOutcome,
	type TaskArtifactOwnerDeletionEvidence,
	type TaskArtifactOwnerRetirementContinuation,
	type TaskArtifactOwnerRetirementOutcome,
	type TaskArtifactOwnerStorageContext,
} from "../../session/task-artifact-owner-codec";

export type BrokerCleanupPhase = "artifacts" | "transcript" | "metadata" | "lifecycle";

/** Exact owner-disposition wire shape. Evidence and continuation are supplied separately by cleanup replay. */
export type BrokerTaskArtifactOwnerRetirementDisposition =
	| { readonly kind: "completed"; readonly nativeOutcome?: NativeExactUnlinkResult }
	| {
			readonly kind: "payload_retired";
			readonly namespace: "retained";
			readonly nativeOutcome: NativeExactUnlinkResult;
	  }
	| { readonly kind: "cleanup_pending"; readonly nativeOutcome?: NativeExactUnlinkResult }
	| { readonly kind: "uncertain"; readonly reason: string; readonly nativeOutcome?: NativeExactUnlinkResult };

/** Owner-only projection of durable cleanup state accepted by the pure validator. */
export interface BrokerTaskArtifactOwnerCleanupFields {
	readonly taskArtifactOwnerDeletionEvidence?: unknown;
	readonly taskArtifactOwnerRetirementContinuation?: unknown;
	readonly taskArtifactOwnerRetirementOutcome?: unknown;
	readonly taskArtifactOwnerPayloadRetired?: unknown;
	readonly taskArtifactOwnerNamespaceRetained?: unknown;
	readonly taskArtifactOwnerRetired?: unknown;
	readonly taskArtifactOwnerTranscriptDeleted?: unknown;
	readonly taskArtifactOwnerCleanupError?: unknown;
}

/** Fully decoded owner-only cleanup state for an authorized session and phase. */
export interface BrokerTaskArtifactOwnerCleanupValidation {
	readonly deletionEvidence?: TaskArtifactOwnerDeletionEvidence;
	readonly retirementContinuation?: TaskArtifactOwnerRetirementContinuation;
	readonly retirementOutcome?: TaskArtifactOwnerRetirementOutcome;
	readonly payloadRetired?: true;
	readonly namespaceRetained?: true;
	readonly retired?: true;
	readonly transcriptDeleted?: true;
	readonly cleanupDiagnostic?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function invalidDisposition(): never {
	throw new Error("task_artifact_owner_retirement_disposition_invalid");
}

/**
 * Decode the owner-only wire disposition using its exact trusted evidence and continuation.
 * A decoded `completed` value is historical DTO data, not proof of physical retirement or writer closure.
 */
export function parseBrokerTaskArtifactOwnerRetirementDisposition(
	value: unknown,
	context: TaskArtifactOwnerStorageContext,
	evidence: TaskArtifactOwnerDeletionEvidence,
	continuation: TaskArtifactOwnerRetirementContinuation | undefined,
): TaskArtifactOwnerRetirementOutcome {
	assertSessionRoot(context);
	if (!isRecord(value)) return invalidDisposition();
	const kind = value.kind;
	let expectedKeys: readonly string[];
	switch (kind) {
		case "completed":
		case "cleanup_pending":
			expectedKeys = Object.hasOwn(value, "nativeOutcome") ? ["kind", "nativeOutcome"] : ["kind"];
			break;
		case "payload_retired":
			expectedKeys = ["kind", "namespace", "nativeOutcome"];
			break;
		case "uncertain":
			expectedKeys = Object.hasOwn(value, "nativeOutcome")
				? ["kind", "reason", "nativeOutcome"]
				: ["kind", "reason"];
			break;
		default:
			return invalidDisposition();
	}
	if (!hasExactKeys(value, expectedKeys)) return invalidDisposition();
	const reconstructed = {
		...value,
		evidence,
		...(continuation !== undefined ? { continuation } : {}),
	};
	return parseTaskArtifactOwnerRetirementOutcome(context, evidence, reconstructed);
}

function serializeNativeOutcome(outcome: NativeExactUnlinkResult): NativeExactUnlinkResult {
	return Object.freeze({
		ok: outcome.ok,
		...(outcome.code !== undefined ? { code: outcome.code } : {}),
		...(outcome.detachedPath !== undefined ? { detachedPath: outcome.detachedPath } : {}),
		...(outcome.retainedSuccessorPath !== undefined ? { retainedSuccessorPath: outcome.retainedSuccessorPath } : {}),
		...(outcome.retainedPlaceholderPath !== undefined
			? { retainedPlaceholderPath: outcome.retainedPlaceholderPath }
			: {}),
		...(outcome.retainedUnknownPath !== undefined ? { retainedUnknownPath: outcome.retainedUnknownPath } : {}),
		...(outcome.payloadDurable !== undefined ? { payloadDurable: outcome.payloadDurable } : {}),
		...(outcome.windowsErrorCode !== undefined ? { windowsErrorCode: outcome.windowsErrorCode } : {}),
	}) as NativeExactUnlinkResult;
}

/** Project an already validated internal outcome to the exact broker wire disposition. */
export function serializeBrokerTaskArtifactOwnerRetirementDisposition(
	outcome: TaskArtifactOwnerRetirementOutcome,
): BrokerTaskArtifactOwnerRetirementDisposition {
	switch (outcome.kind) {
		case "completed":
			return Object.freeze({
				kind: outcome.kind,
				...(outcome.nativeOutcome ? { nativeOutcome: serializeNativeOutcome(outcome.nativeOutcome) } : {}),
			});
		case "payload_retired":
			return Object.freeze({
				kind: outcome.kind,
				namespace: outcome.namespace,
				nativeOutcome: serializeNativeOutcome(outcome.nativeOutcome),
			});
		case "cleanup_pending":
			return Object.freeze({
				kind: outcome.kind,
				...(outcome.nativeOutcome ? { nativeOutcome: serializeNativeOutcome(outcome.nativeOutcome) } : {}),
			});
		case "uncertain":
			return Object.freeze({
				kind: outcome.kind,
				reason: outcome.reason,
				...(outcome.nativeOutcome ? { nativeOutcome: serializeNativeOutcome(outcome.nativeOutcome) } : {}),
			});
		default: {
			const exhaustive: never = outcome;
			throw new Error(`task_artifact_owner_retirement_outcome_unknown:${String(exhaustive)}`);
		}
	}
}

const OWNER_CLEANUP_KEYS = new Set([
	"taskArtifactOwnerDeletionEvidence",
	"taskArtifactOwnerRetirementContinuation",
	"taskArtifactOwnerRetirementOutcome",
	"taskArtifactOwnerPayloadRetired",
	"taskArtifactOwnerNamespaceRetained",
	"taskArtifactOwnerRetired",
	"taskArtifactOwnerTranscriptDeleted",
	"taskArtifactOwnerCleanupError",
]);

/**
 * Strictly decode the owner-field projection of cleanup state against trusted session, scope context, phase,
 * and artifact-removal state. Empty/legacy owner fields decode to an empty result. A decoded completion
 * remains historical data: any later effect must separately verify current physical absence, fresh scrub
 * proof, native success and current owner-parent/side-path authority before it mutates storage or transcripts.
 */
export function decodeBrokerTaskArtifactOwnerCleanupFields(
	value: unknown,
	context: TaskArtifactOwnerStorageContext,
	expectedSessionId: string,
	phase: BrokerCleanupPhase,
	artifactsRemoved: boolean | undefined,
): BrokerTaskArtifactOwnerCleanupValidation {
	assertSessionRoot(context);
	if (!isRecord(value) || Object.keys(value).some(key => !OWNER_CLEANUP_KEYS.has(key)))
		throw new Error("task_artifact_owner_cleanup_fields_invalid");
	if (expectedSessionId.length === 0 || (artifactsRemoved !== undefined && typeof artifactsRemoved !== "boolean"))
		throw new Error("task_artifact_owner_cleanup_fields_invalid");

	const has = (key: string) => Object.hasOwn(value, key);
	const trueFlag = (key: string): true | undefined => {
		if (!has(key)) return undefined;
		if (value[key] !== true) throw new Error("task_artifact_owner_cleanup_flags_invalid");
		return true;
	};
	let deletionEvidence: TaskArtifactOwnerDeletionEvidence | undefined;
	if (has("taskArtifactOwnerDeletionEvidence")) {
		deletionEvidence = parseTaskArtifactOwnerDeletionEvidence(value.taskArtifactOwnerDeletionEvidence);
		if (deletionEvidence.sessionId !== expectedSessionId)
			throw new Error("task_artifact_owner_cleanup_session_mismatch");
	}
	let retirementContinuation: TaskArtifactOwnerRetirementContinuation | undefined;
	if (has("taskArtifactOwnerRetirementContinuation")) {
		if (!deletionEvidence) throw new Error("task_artifact_owner_cleanup_evidence_missing");
		retirementContinuation = parseTaskArtifactOwnerRetirementContinuation(
			context,
			deletionEvidence,
			value.taskArtifactOwnerRetirementContinuation,
		);
	}
	let retirementOutcome: TaskArtifactOwnerRetirementOutcome | undefined;
	if (has("taskArtifactOwnerRetirementOutcome")) {
		if (!deletionEvidence) throw new Error("task_artifact_owner_cleanup_evidence_missing");
		retirementOutcome = parseBrokerTaskArtifactOwnerRetirementDisposition(
			value.taskArtifactOwnerRetirementOutcome,
			context,
			deletionEvidence,
			retirementContinuation,
		);
	}

	const payloadRetired = trueFlag("taskArtifactOwnerPayloadRetired");
	const namespaceRetained = trueFlag("taskArtifactOwnerNamespaceRetained");
	const retired = trueFlag("taskArtifactOwnerRetired");
	const transcriptDeleted = trueFlag("taskArtifactOwnerTranscriptDeleted");
	let cleanupDiagnostic: string | undefined;
	if (has("taskArtifactOwnerCleanupError")) {
		const diagnostic = value.taskArtifactOwnerCleanupError;
		if (typeof diagnostic !== "string" || diagnostic.length === 0 || diagnostic.length > 4096)
			throw new Error("task_artifact_owner_cleanup_diagnostic_invalid");
		cleanupDiagnostic = diagnostic;
	}

	if (
		(retired !== undefined && (payloadRetired !== undefined || namespaceRetained !== undefined)) ||
		(retired !== undefined && retirementOutcome?.kind !== "completed") ||
		(payloadRetired !== undefined) !== (namespaceRetained !== undefined) ||
		((retired !== undefined ||
			payloadRetired !== undefined ||
			namespaceRetained !== undefined ||
			transcriptDeleted !== undefined) &&
			(!deletionEvidence || !retirementOutcome)) ||
		(transcriptDeleted !== undefined &&
			(phase !== "artifacts" || artifactsRemoved !== true || retirementOutcome === undefined))
	)
		throw new Error("task_artifact_owner_cleanup_state_invalid");

	if (retirementOutcome) {
		if (
			(retired !== undefined && retirementOutcome.kind !== "completed") ||
			(retirementOutcome.kind === "completed" && retired === undefined) ||
			(payloadRetired !== undefined &&
				(retirementOutcome.kind !== "payload_retired" || retirementContinuation === undefined)) ||
			(retirementOutcome.kind === "payload_retired" && payloadRetired === undefined)
		)
			throw new Error("task_artifact_owner_cleanup_disposition_mismatch");
	}

	return Object.freeze({
		deletionEvidence,
		retirementContinuation,
		retirementOutcome,
		payloadRetired,
		namespaceRetained,
		retired,
		transcriptDeleted,
		cleanupDiagnostic,
	});
}
