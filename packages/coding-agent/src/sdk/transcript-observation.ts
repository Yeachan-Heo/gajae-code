import type { AgentMessage } from "@gajae-code/agent-core";
import { isBlobRef } from "../session/blob-store";
import { reduceResumeTranscript, type SdkResumeCheckpoint } from "../session/resume-cursor";
import {
	buildSessionContext,
	getSessionMessageEntryId,
	parseSessionEntries,
	SessionManager,
} from "../session/session-manager";
import type { ResumeSessionIdentity } from "./session-readonly/storage";

export type EmbeddedTranscriptMessageObservation =
	| { readonly kind: "content"; readonly entryId: string | null }
	| { readonly kind: "unresolved"; readonly entryId: string | null; readonly reason: "resident_payload_unavailable" };

export interface EmbeddedTranscriptObservation {
	readonly kind: "observed";
	readonly identity: ResumeSessionIdentity;
	readonly checkpoint: SdkResumeCheckpoint;
	/** No execution branch is inferred for legacy or ambiguous transcripts. */
	readonly selectionRequired: boolean;
	/** Resolved persisted messages only; consult messageObservations for the total ordered view. */
	readonly messages: AgentMessage[];
	readonly messageObservations: EmbeddedTranscriptMessageObservation[];
	readonly unresolvedCount: number;
}
export type EmbeddedTranscriptObservationResult =
	| EmbeddedTranscriptObservation
	| {
			readonly kind: "refused";
			readonly reason: string;
	  };

function containsResidentReference(value: unknown): boolean {
	if (typeof value === "string") return isBlobRef(value);
	if (!value || typeof value !== "object") return false;
	return Object.values(value).some(containsResidentReference);
}

/** Exact descriptor-bound disk observation. Never constructs a manager or admits an owner. */
export function observeEmbeddedTranscript(input: {
	readonly file: string;
	readonly cwd: string;
	readonly sessionId: string;
}): EmbeddedTranscriptObservationResult {
	const captured = SessionManager.captureTranscriptStrict(input.file);
	if (captured.kind !== "captured") return { kind: "refused", reason: captured.reason };
	const snapshot = captured.snapshot;
	try {
		const entries = parseSessionEntries(new TextDecoder("utf-8", { fatal: true }).decode(snapshot.materialize()));
		const header = entries[0];
		if (header?.type !== "session" || header.id !== input.sessionId || header.cwd !== input.cwd)
			return { kind: "refused", reason: "context_mismatch" };
		const reduction = reduceResumeTranscript(entries, snapshot.identity.sha256);
		const checkpoint = reduction.checkpoint;
		if (checkpoint.kind === "invalid") return { kind: "refused", reason: "invalid_checkpoint" };
		const selectionRequired = checkpoint.kind === "legacy_tail" || checkpoint.kind === "ambiguous";
		const context = selectionRequired
			? []
			: buildSessionContext(reduction.executableEntries, checkpoint.leafEntryId, undefined, header.id).messages;
		const messages: AgentMessage[] = [];
		const messageObservations: EmbeddedTranscriptMessageObservation[] = [];
		let unresolvedCount = 0;
		for (const message of context) {
			const entryId = getSessionMessageEntryId(message) ?? null;
			if (containsResidentReference(message)) {
				messageObservations.push({ kind: "unresolved", entryId, reason: "resident_payload_unavailable" });
				unresolvedCount++;
			} else {
				messageObservations.push({ kind: "content", entryId });
				messages.push(message);
			}
		}
		if (snapshot.revalidate().kind !== "valid") return { kind: "refused", reason: "stale_snapshot" };
		return {
			kind: "observed",
			identity: { ...snapshot.identity },
			checkpoint,
			selectionRequired,
			messages,
			messageObservations,
			unresolvedCount,
		};
	} catch {
		return { kind: "refused", reason: "stale_snapshot" };
	} finally {
		snapshot.close();
	}
}
