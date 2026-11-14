import { parseJsonlLenient } from "@gajae-code/utils";

/**
 * Version 5 separates persisted MCP and discovered-built-in selection authority.
 * Version 4 patch records remain readable; older writers must not edit v5 sessions.
 */
export const CURRENT_SESSION_VERSION = 5;

export interface MutableSessionHeaderFields {
	/** Auto-generated title from the first message, unless explicitly renamed. */
	title?: string;
	titleSource?: "auto" | "user";
	cwd?: string;
	starred?: boolean;
}

/** Structural fields used by the shared parser, not Native runtime entry types. */
export interface StoredSessionRecord extends MutableSessionHeaderFields {
	type: string;
	id: string;
	version?: number;
	starredPatchVersion?: 1;
	message?: unknown;
	patch?: unknown;
	entryId?: string;
}

/** Append-only replacement for mutable fields on the session header. */
export interface HeaderPatchRecord {
	type: "header_patch";
	patch: Partial<MutableSessionHeaderFields>;
}

/** Append-only replacement for replay metadata on one existing session entry. */
export interface EntryPatchRecord<TMessage = unknown> {
	type: "entry_patch";
	entryId: string;
	patch: { message?: TMessage };
}

export type StoredSessionPatchRecord = HeaderPatchRecord | EntryPatchRecord;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSupportedSessionVersion(version: unknown): boolean {
	return (
		version === undefined ||
		(typeof version === "number" && Number.isInteger(version) && version <= CURRENT_SESSION_VERSION)
	);
}

export function isHeaderPatchRecord(
	record: StoredSessionRecord | StoredSessionPatchRecord,
): record is HeaderPatchRecord {
	if (
		record.type !== "header_patch" ||
		!isRecord(record.patch) ||
		!Object.keys(record).every(key => key === "type" || key === "patch")
	)
		return false;
	const keys = Object.keys(record.patch);
	if (!keys.every(key => key === "cwd" || key === "title" || key === "titleSource" || key === "starred")) return false;
	const { cwd, title, titleSource, starred } = record.patch;
	return (
		(cwd === undefined || typeof cwd === "string") &&
		(title === undefined || typeof title === "string") &&
		(titleSource === undefined || titleSource === "auto" || titleSource === "user") &&
		(starred === undefined || typeof starred === "boolean")
	);
}

export function applyHeaderPatch(
	header: MutableSessionHeaderFields & { starredPatchVersion?: 1 },
	patch: HeaderPatchRecord["patch"],
): void {
	if (patch.cwd !== undefined) header.cwd = patch.cwd;
	if (patch.title !== undefined) header.title = patch.title;
	if (patch.titleSource !== undefined) header.titleSource = patch.titleSource;
	if (header.starredPatchVersion === 1 && patch.starred !== undefined) header.starred = patch.starred;
}

export function isEntryPatchRecord<TMessage = unknown>(
	record: StoredSessionRecord | HeaderPatchRecord | EntryPatchRecord<TMessage>,
): record is EntryPatchRecord<TMessage> {
	return (
		record.type === "entry_patch" &&
		typeof record.entryId === "string" &&
		isRecord(record.patch) &&
		Object.keys(record).every(key => key === "type" || key === "entryId" || key === "patch") &&
		Object.keys(record.patch).every(key => key === "message") &&
		(record.patch.message === undefined || isRecord(record.patch.message))
	);
}

/** Apply the existing append-only record normalization once for every consumer. */
export function buildStoredSessionEntries<T extends StoredSessionRecord>(
	records: Array<T | StoredSessionPatchRecord>,
): T[] {
	const rawHeader = records.find((record): record is T => record.type === "session");
	if (!isSupportedSessionVersion(rawHeader?.version)) {
		throw new Error(`Unsupported session version: ${String(rawHeader?.version)}`);
	}
	const entries: T[] = [];
	const entriesById = new Map<string, T>();
	let header: T | undefined;
	for (const record of records) {
		if (record.type === "header_patch") {
			if (header?.version !== undefined && header.version >= 4 && isHeaderPatchRecord(record))
				applyHeaderPatch(header, record.patch);
			continue;
		}
		if (record.type === "entry_patch") {
			if (header?.version !== undefined && header.version >= 4 && isEntryPatchRecord(record)) {
				const entry = entriesById.get(record.entryId);
				if (entry?.type === "message" && record.patch.message) entry.message = record.patch.message;
			}
			continue;
		}
		// Both patch variants were consumed above; remaining records retain the caller's entry type.
		entries.push(record as T);
		if (record.type === "session") header ??= record;
		else entriesById.set((record as T).id, record as T);
	}
	return entries;
}

export function parseStoredSessionEntries<T extends StoredSessionRecord = StoredSessionRecord>(content: string): T[] {
	const records = parseJsonlLenient<T | StoredSessionPatchRecord>(content);
	return buildStoredSessionEntries(records);
}
