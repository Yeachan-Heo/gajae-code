/**
 * Proof that a fork or branch of a shared session can be built from its committed
 * transcript without writing the source. Pure: callers supply the committed bytes, the
 * ids this opener holds, the resident source entries and the legacy serialiser.
 */
import * as crypto from "node:crypto";
import { CURRENT_SESSION_VERSION, parseStoredSessionEntries } from "../../sdk/session-readonly/format";
import { sanitizeRehydratedOpenAIResponsesAssistantMessage } from "../messages";
import type { FileEntry, SessionEntry } from "../session-manager";

/** Why a fork or branch of a shared session cannot be built from its committed transcript. */
export type GraphSuccessorRefusal =
	| "publication-in-flight"
	| "not-admitted"
	| "unknown-entry"
	| "large-session"
	| "old-format"
	| "unreadable"
	| "foreign-entry"
	| "uncommitted"
	| "content-mismatch"
	| "changed"
	| "busy";

const REFUSAL_TEXT: Record<GraphSuccessorRefusal, string> = {
	"publication-in-flight": "a save to this session is still in progress",
	"not-admitted": "this session does not allow it right now",
	"unknown-entry": "the selected message is not in this session",
	"large-session": "this session is too large to fork safely",
	"old-format": "this session file uses an older format",
	unreadable: "the session file could not be read",
	"foreign-entry": "another gjc process has written to this session",
	uncommitted: "part of this branch has not been saved to the session file",
	"content-mismatch": "the saved session file does not match the loaded session",
	changed: "the session file changed while the fork was prepared",
	busy: "another gjc process is writing to this session",
};

/** The user-facing refusal message for `reason`. */
export function graphSuccessorRefusalMessage(reason: GraphSuccessorRefusal): string {
	return `Cannot fork this session: ${REFUSAL_TEXT[reason]}.`;
}

/** The load-time projection applied to every entry read back from a transcript. */
export function sanitizeLoadedSessionEntryReplayMetadata(entry: SessionEntry): SessionEntry {
	if (entry.type === "message" && entry.message.role === "assistant") {
		entry.message = sanitizeRehydratedOpenAIResponsesAssistantMessage(entry.message);
	}
	return entry;
}

/**
 * Whether a committed transcript entry and the legacy serialisation of a resident entry
 * are the same entry for a successor: JSON-equal as they stand, or equal once both have
 * had the load-time projection applied. Resume strips OpenAI Responses replay metadata
 * in memory without rewriting a managed transcript; a live session keeps it on both sides.
 */
export function committedEntryMatchesResident(committed: FileEntry, serializedResident: FileEntry): boolean {
	if (Bun.deepEquals(committed, serializedResident)) return true;
	if (committed.type === "session" || serializedResident.type === "session") return false;
	const project = (entry: SessionEntry) => sanitizeLoadedSessionEntryReplayMetadata(structuredClone(entry));
	return Bun.deepEquals(project(committed), project(serializedResident));
}

/**
 * Prove the committed transcript is this opener's own graph and each source entry is
 * committed as this opener holds it. Requires this session at the current version; no
 * entry id outside `ownIds` (a peer's sibling is foreign; id-less patch lines are
 * applied, not counted); every source entry committed and matching
 * ({@link committedEntryMatchesResident}). Returns the successor's source lines (the
 * legacy serialisation) and the digest of the bytes proven, or the refusal.
 */
export function proveOwnCommittedGraph(input: {
	bytes: Uint8Array;
	sessionId: string;
	ownIds: ReadonlySet<string>;
	sourceEntries: readonly SessionEntry[];
	serialize: (entry: SessionEntry) => FileEntry;
	onMismatch?: (entryId: string) => void;
}): { lines: string[]; digest: string } | GraphSuccessorRefusal {
	let committed: FileEntry[];
	try {
		committed = parseStoredSessionEntries<FileEntry>(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes));
	} catch {
		return "unreadable";
	}
	const header = committed[0];
	if (header?.type !== "session" || header.id !== input.sessionId) return "unreadable";
	if (header.version !== CURRENT_SESSION_VERSION) return "old-format";
	const byId = new Map<string, SessionEntry>();
	for (const entry of committed) {
		if (entry.type === "session" || typeof entry.id !== "string") continue;
		if (!input.ownIds.has(entry.id)) return "foreign-entry";
		byId.set(entry.id, entry);
	}
	const lines: string[] = [];
	for (const entry of input.sourceEntries) {
		const line = byId.get(entry.id);
		if (!line) return "uncommitted";
		const serialized = JSON.parse(JSON.stringify(input.serialize(entry))) as FileEntry;
		if (!committedEntryMatchesResident(line, serialized)) {
			input.onMismatch?.(entry.id);
			return "content-mismatch";
		}
		lines.push(JSON.stringify(serialized));
	}
	return { lines, digest: crypto.createHash("sha256").update(input.bytes).digest("hex") };
}
