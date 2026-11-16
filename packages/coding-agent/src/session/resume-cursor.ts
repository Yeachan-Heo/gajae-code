import type { FileEntry, SessionEntry } from "./session-manager";

export const RESUME_CURSOR_CUSTOM_TYPE = "gjc.resume_cursor";
export const OWNER_ENROLL_CUSTOM_TYPE = "gjc.owner_enroll";
export const RESUME_CURSOR_MAX_SUPERSEDES = 256;

export interface ResumeCursorData {
	v: 1;
	bind: string;
	op: string;
	idx: number;
	member: string;
	reason: "pin" | "explicit" | "fork_init";
	supersedes: string[];
}

export interface OwnerEnrollData {
	v: 1;
	bind: string;
	member: string;
	runtime: string;
	pid: number;
	processIncarnation: string;
	hostId: string;
	epoch: string;
}

export type ResumeCheckpointKind = "recorded" | "tail_unambiguous" | "empty" | "legacy_tail" | "ambiguous" | "invalid";

export interface SdkResumeCheckpoint {
	kind: ResumeCheckpointKind;
	headerId: string;
	leafEntryId: string | null;
	conversationLeafId: string | null;
	cursorEntryId?: string;
	candidates?: string[];
	candidateCount: number;
	snapshotDigest: string;
	authority: "none";
}

/** Only the fields consumed by the shared resume reducer; no conversational payload. */
export interface ResumeGraphHeader {
	type: "session";
	id: string;
	timestamp: string;
	cwd: string;
	/** Optional version is preserved, but not interpreted or validated by this reducer. */
	version?: unknown;
}

export interface ResumeGraphEntry {
	type: SessionEntry["type"];
	id: string;
	parentId: string | null;
	timestamp: string;
	customType?: string;
	data?: unknown;
}

export type ResumeGraphRecord = ResumeGraphHeader | ResumeGraphEntry;

export interface ResumeGraphReduction {
	checkpoint: SdkResumeCheckpoint;
	markerEvidence: Array<{ entryId: string; data: OwnerEnrollData }>;
	diagnostics: Array<{ entryId: string; reason: string }>;
	executableEntries: ResumeGraphEntry[];
}

export interface ResumeTranscriptReduction extends ResumeGraphReduction {
	executableEntries: SessionEntry[];
}

const executableTypes = new Set<SessionEntry["type"]>([
	"message",
	"thinking_level_change",
	"model_change",
	"service_tier_change",
	"compaction",
	"branch_summary",
	"custom",
	"custom_message",
	"label",
	"ttsr_injection",
	"mcp_tool_selection",
	"discovered_builtin_tool_selection",
	"session_init",
	"mode_change",
	"configured_model_chain",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResumeGraphHeader(value: unknown): value is ResumeGraphHeader {
	return (
		isRecord(value) &&
		value.type === "session" &&
		typeof value.id === "string" &&
		value.id.length > 0 &&
		typeof value.timestamp === "string" &&
		typeof value.cwd === "string"
	);
}

function isResumeGraphEntry(value: unknown): value is ResumeGraphEntry {
	return (
		isRecord(value) &&
		executableTypes.has(value.type as SessionEntry["type"]) &&
		typeof value.id === "string" &&
		value.id.length > 0 &&
		typeof value.timestamp === "string" &&
		(value.parentId === null || typeof value.parentId === "string") &&
		((value.type !== "custom" && value.type !== "custom_message") || typeof value.customType === "string")
	);
}

/**
 * Project one resolved record without reading or retaining its conversational payload.
 * Physical patch records must first pass through the shared session parser.
 * Malformed reserved data is retained so the reducer can report its normal diagnostics.
 */
export function projectResumeGraphRecord(value: unknown): ResumeGraphRecord {
	if (isResumeGraphHeader(value)) {
		return {
			type: "session",
			id: value.id,
			timestamp: value.timestamp,
			cwd: value.cwd,
			...("version" in value ? { version: value.version } : {}),
		};
	}
	if (!isResumeGraphEntry(value)) {
		throw new Error(isRecord(value) && value.type === "session" ? "invalid_header" : "unsupported_entry_shape");
	}
	return {
		type: value.type,
		id: value.id,
		parentId: value.parentId,
		timestamp: value.timestamp,
		...(value.type === "custom" || value.type === "custom_message" ? { customType: value.customType } : {}),
		...(isResumeMetadata(value) ? { data: value.data } : {}),
	};
}

/** Reserved custom entries are metadata even when their payload is malformed. */
export function isResumeMetadata(entry: ResumeGraphEntry): boolean {
	return (
		entry.type === "custom" &&
		(entry.customType === RESUME_CURSOR_CUSTOM_TYPE || entry.customType === OWNER_ENROLL_CUSTOM_TYPE)
	);
}

function isCursorData(
	value: unknown,
	headerId: string,
	earlierExecutable: ReadonlyMap<string, ResumeGraphEntry>,
): value is ResumeCursorData {
	if (
		!isRecord(value) ||
		value.v !== 1 ||
		value.bind !== headerId ||
		typeof value.op !== "string" ||
		typeof value.idx !== "number" ||
		!Number.isInteger(value.idx) ||
		value.idx < 0 ||
		typeof value.member !== "string" ||
		(value.reason !== "pin" && value.reason !== "explicit" && value.reason !== "fork_init") ||
		!Array.isArray(value.supersedes) ||
		value.supersedes.length > RESUME_CURSOR_MAX_SUPERSEDES
	) {
		return false;
	}
	const seen = new Set<string>();
	for (const id of value.supersedes) {
		if (typeof id !== "string" || seen.has(id) || !earlierExecutable.has(id)) return false;
		seen.add(id);
	}
	return true;
}

function isOwnerData(value: unknown, headerId: string): value is OwnerEnrollData {
	return (
		isRecord(value) &&
		value.v === 1 &&
		value.bind === headerId &&
		typeof value.member === "string" &&
		typeof value.runtime === "string" &&
		typeof value.pid === "number" &&
		Number.isFinite(value.pid) &&
		typeof value.processIncarnation === "string" &&
		typeof value.hostId === "string" &&
		typeof value.epoch === "string"
	);
}

/**
 * Reduces a resolved transcript without clocks, I/O, or ownership inference.
 * snapshotDigest must describe the caller's complete raw snapshot, including marker bytes;
 * it is deliberately opaque here, not recomputed from the contracted graph.
 */
export function reduceResumeTranscript(
	entries: readonly FileEntry[],
	snapshotDigest: string,
): ResumeTranscriptReduction;
export function reduceResumeTranscript(
	entries: readonly ResumeGraphRecord[],
	snapshotDigest: string,
): ResumeGraphReduction;
export function reduceResumeTranscript(
	entries: readonly ResumeGraphRecord[],
	snapshotDigest: string,
): ResumeGraphReduction {
	const diagnostics: ResumeGraphReduction["diagnostics"] = [];
	let headerId = "";
	const invalid = (entryId: string, reason: string): ResumeGraphReduction => {
		diagnostics.push({ entryId, reason });
		return {
			checkpoint: {
				kind: "invalid",
				headerId,
				leafEntryId: null,
				conversationLeafId: null,
				candidates: [],
				candidateCount: 0,
				snapshotDigest,
				authority: "none",
			},
			markerEvidence: [],
			diagnostics,
			executableEntries: [],
		};
	};
	if (!Array.isArray(entries)) return invalid("", "unsupported_entries_shape");
	const headers = entries.filter((entry): entry is ResumeGraphHeader => isRecord(entry) && entry.type === "session");
	if (typeof headers[0]?.id === "string") headerId = headers[0].id;
	if (headers.length !== 1) return invalid(headerId, headers.length === 0 ? "missing_header" : "multiple_headers");
	const header = headers[0];
	if (entries[0] !== header || !isResumeGraphHeader(header)) {
		return invalid(headerId, "invalid_header");
	}

	// Validate the original graph, including inert metadata edges. Earlier-only parents
	// also rule out self-links and cycles without a recursive traversal.
	const seenIds = new Set<string>([headerId]);
	for (let index = 1; index < entries.length; index++) {
		const entry = entries[index];
		if (!isResumeGraphEntry(entry)) {
			return invalid(isRecord(entry) && typeof entry.id === "string" ? entry.id : "", "unsupported_entry_shape");
		}
		if (seenIds.has(entry.id)) return invalid(entry.id, "duplicate_id");
		if (entry.parentId !== null && (entry.parentId === headerId || !seenIds.has(entry.parentId))) {
			return invalid(entry.id, "missing_or_forward_parent");
		}
		seenIds.add(entry.id);
	}

	const executableEntries: ResumeGraphEntry[] = [];
	const markerEvidence: ResumeGraphReduction["markerEvidence"] = [];
	const executableById = new Map<string, ResumeGraphEntry>();
	const contractedId = new Map<string, string | null>();
	const parentsWithChildren = new Set<string>();
	const cursorIds = new Set<string>();
	const superseded = new Set<string>();
	for (let index = 1; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.type === "session") return invalid(entry.id, "unsupported_entry_shape");
		const parentId = entry.parentId === null ? null : contractedId.get(entry.parentId)!;
		if (entry.type === "custom" && isResumeMetadata(entry)) {
			if (entry.customType === OWNER_ENROLL_CUSTOM_TYPE) {
				if (isOwnerData(entry.data, headerId)) markerEvidence.push({ entryId: entry.id, data: entry.data });
				else diagnostics.push({ entryId: entry.id, reason: "invalid_owner_enroll" });
				contractedId.set(entry.id, parentId);
				continue;
			}
			if (!isCursorData(entry.data, headerId, executableById)) {
				diagnostics.push({ entryId: entry.id, reason: "invalid_resume_cursor" });
				contractedId.set(entry.id, parentId);
				continue;
			}
			cursorIds.add(entry.id);
			for (const id of entry.data.supersedes) superseded.add(id);
		}
		const projected = entry.parentId === parentId ? entry : { ...entry, parentId };
		executableEntries.push(projected);
		executableById.set(entry.id, projected);
		contractedId.set(entry.id, entry.id);
		if (parentId !== null) parentsWithChildren.add(parentId);
	}
	const candidates = executableEntries
		.filter(entry => !parentsWithChildren.has(entry.id) && !superseded.has(entry.id))
		.map(entry => entry.id);
	if (executableEntries.length > 0 && candidates.length === 0) return invalid("", "no_active_candidates");

	let kind: ResumeCheckpointKind = "empty";
	let leafEntryId: string | null = null;
	let conversationLeafId: string | null = null;
	let cursorEntryId: string | undefined;
	if (candidates.length === 1) {
		kind = "tail_unambiguous";
		leafEntryId = candidates[0];
	} else if (candidates.length > 1) {
		kind = cursorIds.size === 0 ? "legacy_tail" : "ambiguous";
		if (kind === "legacy_tail") leafEntryId = candidates[candidates.length - 1];
	}
	let ancestorId = leafEntryId;
	while (ancestorId !== null) {
		const ancestor = executableById.get(ancestorId)!;
		if (cursorEntryId === undefined && cursorIds.has(ancestor.id)) cursorEntryId = ancestor.id;
		if (
			conversationLeafId === null &&
			(ancestor.type === "message" ||
				ancestor.type === "custom_message" ||
				ancestor.type === "compaction" ||
				ancestor.type === "branch_summary")
		) {
			conversationLeafId = ancestor.id;
		}
		ancestorId = ancestor.parentId;
	}
	if (kind === "tail_unambiguous" && cursorEntryId !== undefined) kind = "recorded";
	return {
		checkpoint: {
			kind,
			headerId,
			leafEntryId,
			conversationLeafId,
			...(cursorEntryId === undefined ? {} : { cursorEntryId }),
			candidates,
			candidateCount: candidates.length,
			snapshotDigest,
			authority: "none",
		},
		markerEvidence,
		diagnostics,
		executableEntries,
	};
}

export function resolveResumeCheckpoint(entries: readonly FileEntry[], snapshotDigest: string): SdkResumeCheckpoint;
export function resolveResumeCheckpoint(
	entries: readonly ResumeGraphRecord[],
	snapshotDigest: string,
): SdkResumeCheckpoint;
export function resolveResumeCheckpoint(
	entries: readonly ResumeGraphRecord[],
	snapshotDigest: string,
): SdkResumeCheckpoint {
	return reduceResumeTranscript(entries, snapshotDigest).checkpoint;
}
