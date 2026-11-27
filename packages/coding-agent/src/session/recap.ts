import {
	isPlainRecord,
	SESSION_RECAP_SCHEMA_VERSION,
	type SessionRecap,
	type SessionRecapRecord,
	validateSessionRecap,
} from "../sdk/session-recap";
import type { SessionEntry } from "./session-manager";

/** `customType` of the session custom entry that persists one model-generated recap. */
export const SESSION_RECAP_ENTRY = "session_recap";
/** Bound retained candidates in transcripts containing forged or repeated recap entries. */
export const SESSION_RECAP_MAX_CANDIDATES = 256;

/** Caller-supplied recap fields; the schema version is stamped by the store. */
export type SessionRecapInput = Omit<SessionRecap, "schemaVersion">;

export type SessionRecapRejection =
	/** Payload failed strict validation (shape, text bounds, control characters, timestamp). */
	| "invalid_payload"
	/** Source entry is the active-branch turn end but is not a final (`stop`) assistant message. */
	| "invalid_source"
	/** Request entry is not a user message that precedes the source on the active branch. */
	| "invalid_request"
	/** Source entry is not the last conversation entry of the active branch (turn moved on, branch changed, or unknown id). */
	| "source_not_current"
	/** The active branch already carries a recap for this source entry. */
	| "duplicate";

export type SessionRecapAppendPlan = { ok: true; data: SessionRecap } | { ok: false; reason: SessionRecapRejection };

export type SessionRecapAppendResult =
	| { status: "appended"; entryId: string }
	| { status: "rejected"; reason: SessionRecapRejection };

/**
 * Entry types that never change what the conversation says. A recap stays current
 * across them (cost/status custom entries, model switches, labels, compaction
 * bookkeeping). Every other entry type, including any future one, counts as
 * conversation progress and makes an earlier recap stale.
 */
const NON_CONVERSATION_ENTRY_TYPES: ReadonlySet<string> = new Set([
	"thinking_level_change",
	"model_change",
	"service_tier_change",
	"configured_model_chain",
	"compaction",
	"custom",
	"label",
	"ttsr_injection",
	"mcp_tool_selection",
	"discovered_builtin_tool_selection",
	"session_init",
	"mode_change",
]);

/**
 * The facts of one session entry that recap freshness depends on. Both the in-memory
 * branch (`toRecapLineageEntry`) and the readonly list reader (`classifyRecapRecord`)
 * reduce entries to this shape so a single walker decides what is current.
 */
export interface RecapLineageEntry {
	id: string;
	type: string;
	/** Present for `custom` entries. */
	customType?: string;
	/** Present for `custom` entries; unvalidated. */
	data?: unknown;
	/** Present for `message` entries. */
	role?: string;
	/** Present for assistant `message` entries. */
	stopReason?: string;
}

export function toRecapLineageEntry(entry: SessionEntry): RecapLineageEntry {
	if (entry.type === "custom") {
		return { id: entry.id, type: entry.type, customType: entry.customType, data: entry.data };
	}
	if (entry.type === "message") {
		const message = entry.message;
		return {
			id: entry.id,
			type: entry.type,
			role: message.role,
			...(message.role === "assistant" ? { stopReason: message.stopReason } : {}),
		};
	}
	return { id: entry.id, type: entry.type };
}

/**
 * Entry types the canonical resume gate (`hasStrictSessionSchema`) accepts. A record of any other
 * type makes the loader refuse the transcript, so the readonly reader never trusts one.
 */
const KNOWN_ENTRY_TYPES: ReadonlySet<string> = new Set([
	...NON_CONVERSATION_ENTRY_TYPES,
	"message",
	"custom_message",
	"branch_summary",
]);

/** Record types a transcript legitimately carries that are not session entries. */
const NON_ENTRY_RECORD_TYPES: ReadonlySet<string> = new Set(["session", "header_patch", "entry_patch"]);

/**
 * Outcome of reading one raw transcript record for recap purposes.
 * `invalid` means the record is not something the canonical loader accepts; a
 * reader that meets one on the branch it is walking must fail closed (no recap),
 * never skip it, or an earlier entry would be mistaken for the leaf.
 */
export type RecapRecordClassification =
	| { kind: "entry"; entry: RecapLineageEntry; parentId: string | null }
	| { kind: "skip" }
	| { kind: "invalid" };

const INVALID_RECORD: RecapRecordClassification = { kind: "invalid" };
const SKIP_RECORD: RecapRecordClassification = { kind: "skip" };

/**
 * Classify one parsed JSONL record. Mirrors the canonical resume gate's envelope (known entry
 * type, string `id`, `parentId` of `null` or string, string `timestamp`) plus the body fields
 * recap reads (`customType`, `message.role`), so a record the loader would reject is never
 * trusted here. Per-type bodies recap does not read are left to the loader.
 */
export function classifyRecapRecord(record: unknown): RecapRecordClassification {
	if (typeof record !== "object" || record === null || Array.isArray(record)) return INVALID_RECORD;
	const value = record as Record<string, unknown>;
	if (typeof value.type !== "string") return INVALID_RECORD;
	if (NON_ENTRY_RECORD_TYPES.has(value.type)) return SKIP_RECORD;
	if (!KNOWN_ENTRY_TYPES.has(value.type)) return INVALID_RECORD;
	if (typeof value.id !== "string" || value.id.length === 0) return INVALID_RECORD;
	if (value.parentId !== null && typeof value.parentId !== "string") return INVALID_RECORD;
	if (typeof value.timestamp !== "string") return INVALID_RECORD;
	const parentId = value.parentId;
	if (value.type === "custom") {
		if (typeof value.customType !== "string") return INVALID_RECORD;
		return {
			kind: "entry",
			entry: { id: value.id, type: value.type, customType: value.customType, data: value.data },
			parentId,
		};
	}
	if (value.type === "message") {
		const message = value.message;
		if (typeof message !== "object" || message === null || Array.isArray(message)) return INVALID_RECORD;
		const { role, stopReason } = message as Record<string, unknown>;
		if (typeof role !== "string") return INVALID_RECORD;
		return {
			kind: "entry",
			entry: {
				id: value.id,
				type: value.type,
				role,
				...(role === "assistant" && typeof stopReason === "string" ? { stopReason } : {}),
			},
			parentId,
		};
	}
	return { kind: "entry", entry: { id: value.id, type: value.type }, parentId };
}

function isFinalAssistantEntry(entry: RecapLineageEntry): boolean {
	return entry.type === "message" && entry.role === "assistant" && entry.stopReason === "stop";
}

function isRecapEntry(entry: RecapLineageEntry): boolean {
	return entry.type === "custom" && entry.customType === SESSION_RECAP_ENTRY;
}

interface TailScan {
	/** Nearest conversation entry from the leaf: the only entry a current recap can summarize. */
	anchor: RecapLineageEntry | undefined;
	/** Non-conversation entries between the anchor and the leaf, newest first. */
	trailing: RecapLineageEntry[];
}

function scanTail(newestFirst: Iterator<RecapLineageEntry>): TailScan {
	const trailing: RecapLineageEntry[] = [];
	for (let step = newestFirst.next(); !step.done; step = newestFirst.next()) {
		if (NON_CONVERSATION_ENTRY_TYPES.has(step.value.type)) {
			if (isRecapEntry(step.value)) trailing.push(step.value);
			continue;
		}
		return { anchor: step.value, trailing };
	}
	return { anchor: undefined, trailing };
}

/** Walk the remaining ancestors without retaining unrelated messages or ids. */
function hasUserRequest(entries: Iterator<RecapLineageEntry>, id: string): boolean {
	for (let step = entries.next(); !step.done; step = entries.next()) {
		const entry = step.value;
		if (entry.type === "message" && entry.role === "user" && entry.id === id) return true;
	}
	return false;
}

/**
 * Decide whether `input` may be committed to the active branch, given its entries
 * newest first (leaf first). Pure: the caller appends the returned payload.
 * Walk cost is bounded by the trailing non-conversation entries unless the request
 * id has to be located, which only continues through the summarized turn.
 */
export function planSessionRecapAppend(
	newestFirst: Iterator<RecapLineageEntry>,
	input: unknown,
): SessionRecapAppendPlan {
	if (!isPlainRecord(input) || "schemaVersion" in input) return { ok: false, reason: "invalid_payload" };
	const data = validateSessionRecap({ schemaVersion: SESSION_RECAP_SCHEMA_VERSION, ...input });
	if (!data) return { ok: false, reason: "invalid_payload" };
	const { anchor, trailing } = scanTail(newestFirst);
	if (!anchor || anchor.id !== data.sourceEntryId) return { ok: false, reason: "source_not_current" };
	if (!isFinalAssistantEntry(anchor)) return { ok: false, reason: "invalid_source" };
	for (const entry of trailing) {
		if (!isRecapEntry(entry)) continue;
		if (validateSessionRecap(entry.data)?.sourceEntryId === anchor.id) return { ok: false, reason: "duplicate" };
	}
	if (!hasUserRequest(newestFirst, data.requestEntryId)) return { ok: false, reason: "invalid_request" };
	return { ok: true, data };
}

/**
 * Push-style decision of which recap, if any, still describes a branch's last turn.
 * Feed it the branch newest first (leaf first) and stop once `done`; call `finish()`
 * when the branch ends first. Push-style so synchronous in-memory iteration and the
 * asynchronous readonly file reader share one implementation.
 *
 * A recap is current only while its source is the last conversation entry: any later
 * message, custom message, or branch summary makes it stale, and a recap on another
 * branch is never seen. Non-conversation entries (cost/status custom entries, the
 * recap entry itself) do not. Its request entry must be a user message ancestor of
 * the source. Results are detached copies of validated data.
 */
export class CurrentSessionRecapWalker {
	#phase: "tail" | "request" = "tail";
	#candidates: Array<SessionRecap & { entryId: string }> = [];
	readonly #userIds = new Set<string>();
	#done = false;
	#result: SessionRecapRecord | undefined;

	get done(): boolean {
		return this.#done;
	}

	push(entry: RecapLineageEntry): void {
		if (this.#done) return;
		if (this.#phase === "tail") {
			if (NON_CONVERSATION_ENTRY_TYPES.has(entry.type)) {
				if (isRecapEntry(entry)) {
					const data = validateSessionRecap(entry.data);
					if (data) this.#candidates.push({ ...data, entryId: entry.id });
					if (this.#candidates.length > SESSION_RECAP_MAX_CANDIDATES) {
						this.#candidates = [];
						this.#done = true;
					}
				}
				return;
			}
			this.#startRequestPhase(entry);
			return;
		}
		if (entry.type === "message" && entry.role === "user") {
			if (this.#candidates.some(candidate => candidate.requestEntryId === entry.id)) this.#userIds.add(entry.id);
			const first = this.#candidates[0];
			if (first && this.#userIds.has(first.requestEntryId)) this.#settle();
		}
	}

	/** Conclude after the branch ended; returns the current recap or `undefined`. */
	finish(): SessionRecapRecord | undefined {
		if (!this.#done) this.#settle();
		return this.#result;
	}

	#startRequestPhase(anchor: RecapLineageEntry): void {
		this.#candidates = isFinalAssistantEntry(anchor)
			? this.#candidates.filter(candidate => candidate.sourceEntryId === anchor.id)
			: [];
		this.#phase = "request";
		if (this.#candidates.length === 0) this.#done = true;
	}

	#settle(): void {
		const match = this.#candidates.find(candidate => this.#userIds.has(candidate.requestEntryId));
		if (match) this.#result = { ...match, source: "model" };
		this.#done = true;
	}
}

/**
 * Newest recap on the branch that still describes its last turn, given its entries
 * newest first (leaf first). See {@link CurrentSessionRecapWalker} for the contract.
 */
export function findCurrentSessionRecap(newestFirst: Iterator<RecapLineageEntry>): SessionRecapRecord | undefined {
	const walker = new CurrentSessionRecapWalker();
	for (let step = newestFirst.next(); !step.done && !walker.done; step = newestFirst.next()) walker.push(step.value);
	return walker.finish();
}
