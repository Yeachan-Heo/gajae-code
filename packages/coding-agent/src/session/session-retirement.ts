import * as crypto from "node:crypto";
import * as path from "node:path";

import { toError } from "@gajae-code/utils";
import {
	type FileSessionStorage,
	SessionDeleteVerificationError,
	type SessionStorageSnapshot,
	type VerifiedSessionDeleteTarget,
} from "./session-storage";
import { parseFirstJsonlLine } from "./session-transcript-header";

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
	| { kind: "retired" }
	| { kind: "kept"; reason: string }
	| { kind: "cleanup_pending"; reason: string };

/** A retirement that cleared every precondition the retention pass itself owns. */
type SessionRetirementPlan =
	| { kind: "retirable"; target: VerifiedSessionDeleteTarget; artifactsPresent: boolean }
	| { kind: "kept"; reason: string };

/**
 * Evaluate the preconditions retirement owns — the transcript must be readable
 * and carry a usable session header — and bind the delete target to the exact
 * bytes just read. Nothing here mutates the store.
 */
function planSessionRetirement(
	storage: FileSessionStorage,
	sessionsRoot: string,
	transcriptPath: string,
): SessionRetirementPlan {
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
	// artifact phase — keeps a doomed retirement from destroying the artifact
	// tree of a session whose transcript will survive anyway.
	if (snapshot.stat.nlink === undefined || snapshot.stat.nlink !== 1n) {
		return { kind: "kept", reason: "transcript_not_single_link" };
	}

	const directory = path.dirname(transcriptPath);
	return {
		kind: "retirable",
		artifactsPresent: storage.existsSync(transcriptPath.slice(0, -".jsonl".length)),
		target: {
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
export function probeSessionRetirement(
	storage: FileSessionStorage,
	sessionsRoot: string,
	transcriptPath: string,
): { kind: "retirable" } | { kind: "kept"; reason: string } {
	const plan = planSessionRetirement(storage, sessionsRoot, transcriptPath);
	return plan.kind === "retirable" ? { kind: "retirable" } : plan;
}

/**
 * A transcript that survives after its artifacts are already gone is not a
 * benign keep: the session is half-destroyed and the caller has to surface it.
 */
function retirementIncomplete(artifactsRemoved: boolean, reason: string): SessionRetirementOutcome {
	return artifactsRemoved ? { kind: "cleanup_pending", reason } : { kind: "kept", reason };
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
): Promise<SessionRetirementOutcome> {
	const plan = planSessionRetirement(storage, sessionsRoot, transcriptPath);
	if (plan.kind === "kept") return plan;

	let artifactsRemoved = false;
	try {
		// Phase 1 removes the sibling artifact directory (or proves it absent);
		// phase 2 unlinks the transcript only against the same bound identity.
		const artifacts = await storage.deleteSessionVerified(plan.target);
		if (artifacts.kind === "deleted") return { kind: "retired" };
		if (artifacts.kind === "cleanup_pending") {
			return { kind: "cleanup_pending", reason: `cleanup_pending_${artifacts.phase}: ${artifacts.error.message}` };
		}
		// Phase 1 is durable: whatever artifact tree the session had is gone, so
		// every later refusal leaves a record without its artifacts.
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
