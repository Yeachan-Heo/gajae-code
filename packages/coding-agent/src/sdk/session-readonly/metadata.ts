import * as fs from "node:fs/promises";
import * as os from "node:os";
import type { Message, TextContent } from "@gajae-code/ai/core";
import {
	CURRENT_SESSION_VERSION,
	type HeaderPatchRecord,
	isHeaderPatchRecord,
	parseStoredSessionEntries,
	type StoredSessionPatchRecord,
} from "./format";
import { FileSessionReader, type SessionStorageReader, type SessionStorageStat } from "./storage";

export interface SessionMetadata {
	path: string;
	id: string;
	/** Working directory where the session was started. Empty string for old sessions. */
	cwd: string;
	title?: string;
	starred: boolean;
	/** Path to the parent session (if this session was forked). */
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	/** True when messageCount was counted from only the bounded list prefix. */
	messageCountIsEstimate?: boolean;
	/** File size in bytes on disk; used for compact list rendering. */
	size: number;
	firstMessage: string;
	allMessagesText: string;
}

/** Native callers retain their own recap enrichment and picker identity association. */
export type SessionMetadataEnricher = (session: SessionMetadata, stats: SessionStorageStat) => Promise<void>;

function extractTextFromContent(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join(" ");
}

export const SESSION_LIST_PREFIX_BYTES = 4096;
// Reverse-scan chunk for trailing header patches. Sized independently of the
// 4 KiB prefix buffer: the scan walks back to BOF whenever a field stays
// unresolved (#3633), which is the common case because most transcripts carry
// no header_patch at all. A 4 KiB chunk turned that walk into one read syscall
// per 4 KiB of transcript and defeated OS readahead, so listing cost scaled
// with total transcript bytes on every resume.
const SESSION_LIST_TRAILING_PATCH_BYTES = 64 * 1024;
const SESSION_LIST_PARALLEL_THRESHOLD = 64;
const SESSION_LIST_MAX_WORKERS = 16;
const sessionListPrefixDecoder = new TextDecoder("utf-8", { fatal: false });

export async function readSessionListPrefix(
	file: string,
	storage: SessionStorageReader,
	buffer: Buffer,
): Promise<string> {
	if (!(storage instanceof FileSessionReader)) {
		return storage.readTextPrefix(file, buffer.byteLength);
	}

	const handle = await fs.open(file, "r");
	try {
		const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
		return sessionListPrefixDecoder.decode(buffer.subarray(0, bytesRead));
	} finally {
		await handle.close();
	}
}

export async function readSessionListTrailingPatches(
	file: string,
	storage: SessionStorageReader,
	includeStarred: boolean,
): Promise<HeaderPatchRecord["patch"][]> {
	if (!(storage instanceof FileSessionReader)) {
		const content = await storage.readText(file);
		const entries = parseStoredSessionEntries(content);
		const header = entries[0] as SessionListHeader | undefined;
		return header?.type === "session"
			? [{ cwd: header.cwd, title: header.title, ...(includeStarred ? { starred: header.starred } : {}) }]
			: [];
	}

	const size = storage.statSync(file).size;
	if (size <= SESSION_LIST_PREFIX_BYTES) return [];
	const latest: HeaderPatchRecord["patch"] = {};
	let position = size;
	// Reverse-scan from EOF in fixed chunks. Stop once every requested mutable list field
	// resolves so recent patches stay cheap. Continue past the historical 16 KiB
	// window when a field is still missing so a buried but canonically valid
	// header_patch remains listable without a full sequential JSONL parse (#3633).
	// Chunks that cannot contain a header_patch marker skip JSON parsing.
	//
	// The scan owns its buffer instead of borrowing the caller's 4 KiB prefix.
	// A transcript with no header_patch at all — the common case — cannot be
	// recognized as such without reaching BOF, so the chunk size sets how many
	// read syscalls a resume costs per transcript byte.
	let trailingFragment = Buffer.alloc(0);
	const chunkSize = Math.min(size, SESSION_LIST_TRAILING_PATCH_BYTES);
	const buffer = Buffer.allocUnsafe(chunkSize);
	const headerPatchMarker = Buffer.from("header_patch");
	const handle = await fs.open(file, "r");
	try {
		while (
			position > 0 &&
			(latest.cwd === undefined || latest.title === undefined || (includeStarred && latest.starred === undefined))
		) {
			const start = Math.max(0, position - chunkSize);
			const length = position - start;
			const { bytesRead } = await handle.read(buffer, 0, length, start);
			const combined = Buffer.concat([buffer.subarray(0, bytesRead), trailingFragment]);
			let complete = combined;
			if (start > 0) {
				const firstNewline = combined.indexOf(0x0a);
				if (firstNewline === -1) {
					trailingFragment = combined;
					position = start;
					continue;
				}
				trailingFragment = combined.subarray(0, firstNewline);
				complete = combined.subarray(firstNewline + 1);
			}
			// Marker may straddle the discarded partial first line; still parse when
			// the raw chunk or carried fragment could hold a header_patch record.
			const mayContainPatch =
				complete.includes(headerPatchMarker) ||
				buffer.subarray(0, bytesRead).includes(headerPatchMarker) ||
				trailingFragment.includes(headerPatchMarker);
			if (mayContainPatch) {
				const lines = complete.toString("utf8").split("\n");
				for (let index = lines.length - 1; index >= 0; index--) {
					const line = lines[index];
					if (!line?.includes("header_patch")) continue;
					try {
						const record = JSON.parse(line) as StoredSessionPatchRecord;
						if (!isHeaderPatchRecord(record)) continue;
						if (latest.cwd === undefined && typeof record.patch.cwd === "string") latest.cwd = record.patch.cwd;
						if (latest.title === undefined && typeof record.patch.title === "string")
							latest.title = record.patch.title;
						if (includeStarred && latest.starred === undefined && typeof record.patch.starred === "boolean")
							latest.starred = record.patch.starred;
					} catch {
						// Ignore malformed or partial records exactly as the canonical loader does.
					}
				}
			}
			position = start;
		}
		return latest.cwd === undefined && latest.title === undefined && latest.starred === undefined ? [] : [latest];
	} finally {
		await handle.close();
	}
}

export function applySessionListHeaderPatch(header: SessionListHeader, patch: HeaderPatchRecord["patch"]): void {
	if (typeof patch.cwd === "string") header.cwd = patch.cwd;
	if (typeof patch.title === "string") header.title = patch.title;
	if (typeof patch.starred === "boolean") header.starred = patch.starred;
}

function decodeJsonStringFragment(value: string): string {
	const safeValue = value.endsWith("\\") ? value.slice(0, -1) : value;
	try {
		return JSON.parse(`"${safeValue}"`) as string;
	} catch {
		return safeValue
			.replace(/\\n/g, "\n")
			.replace(/\\r/g, "\r")
			.replace(/\\t/g, "\t")
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\");
	}
}

function extractStringProperty(source: string, name: string, startIndex = 0): string | undefined {
	const propertyIndex = source.indexOf(`"${name}"`, startIndex);
	if (propertyIndex === -1) return undefined;
	const colonIndex = source.indexOf(":", propertyIndex + name.length + 2);
	if (colonIndex === -1) return undefined;
	let valueIndex = colonIndex + 1;
	while (valueIndex < source.length) {
		const char = source.charCodeAt(valueIndex);
		if (char !== 32 && char !== 9 && char !== 10 && char !== 13) break;
		valueIndex++;
	}
	if (source.charCodeAt(valueIndex) !== 34) return undefined;
	const valueStart = valueIndex + 1;
	let escaped = false;
	for (let i = valueStart; i < source.length; i++) {
		const char = source.charCodeAt(i);
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === 92) {
			escaped = true;
			continue;
		}
		if (char === 34) return decodeJsonStringFragment(source.slice(valueStart, i));
	}
	return decodeJsonStringFragment(source.slice(valueStart));
}

function extractTopLevelPrimitiveProperty(source: string, name: string): string | undefined {
	let depth = 0;
	let latest: string | undefined;
	for (let index = 0; index < source.length; index++) {
		const char = source.charCodeAt(index);
		if (char === 0x7b || char === 0x5b) {
			depth++;
			continue;
		}
		if (char === 0x7d || char === 0x5d) {
			depth--;
			continue;
		}
		if (char !== 0x22) continue;
		const keyStart = index;
		let escaped = false;
		for (index++; index < source.length; index++) {
			const stringChar = source.charCodeAt(index);
			if (escaped) {
				escaped = false;
				continue;
			}
			if (stringChar === 0x5c) {
				escaped = true;
				continue;
			}
			if (stringChar === 0x22) break;
		}
		if (index >= source.length || depth !== 1) continue;
		let key: unknown;
		try {
			key = JSON.parse(source.slice(keyStart, index + 1));
		} catch {
			continue;
		}
		if (key !== name) continue;
		let valueStart = index + 1;
		while (valueStart < source.length && /\s/.test(source[valueStart]!)) valueStart++;
		if (source.charCodeAt(valueStart) !== 0x3a) continue;
		valueStart++;
		while (valueStart < source.length && /\s/.test(source[valueStart]!)) valueStart++;
		let valueEnd = valueStart;
		while (
			valueEnd < source.length &&
			source[valueEnd] !== "," &&
			source[valueEnd] !== "}" &&
			!/\s/.test(source[valueEnd]!)
		)
			valueEnd++;
		latest = source.slice(valueStart, valueEnd);
		index = valueEnd - 1;
	}
	return latest;
}

function extractTopLevelIntegerProperty(source: string, name: string): number | undefined {
	const token = extractTopLevelPrimitiveProperty(source, name);
	if (token === undefined || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) return undefined;
	const value = Number(token);
	return Number.isSafeInteger(value) ? value : undefined;
}

function extractTopLevelBooleanProperty(source: string, name: string): boolean | undefined {
	const token = extractTopLevelPrimitiveProperty(source, name);
	if (token === "true") return true;
	if (token === "false") return false;
	return undefined;
}

function countMessageMarkers(content: string): number {
	let count = 0;
	let index = 0;
	while (index < content.length) {
		const typeIndex = content.indexOf('"type"', index);
		if (typeIndex === -1) break;
		const colonIndex = content.indexOf(":", typeIndex + 6);
		if (colonIndex === -1) break;
		const type = extractStringProperty(content, "type", typeIndex);
		if (type === "message") count++;
		index = colonIndex + 1;
	}
	return count;
}

function extractFirstUserMessageFromPrefix(content: string): string | undefined {
	const roleIndex = content.indexOf('"role"');
	if (roleIndex === -1) return undefined;
	let index = roleIndex;
	while (index !== -1) {
		const role = extractStringProperty(content, "role", index);
		if (role === "user")
			return extractStringProperty(content, "content", index) ?? extractStringProperty(content, "text", index);
		index = content.indexOf('"role"', index + 6);
	}
	return undefined;
}

export interface SessionListHeader {
	type: "session";
	id: string;
	version?: number;
	cwd?: string;
	title?: string;
	starredPatchVersion?: 1;
	starred?: boolean;
	parentSession?: string;
	timestamp?: string;
}

function parseSessionListHeader(
	content: string,
	entries: Array<Record<string, unknown>>,
): SessionListHeader | undefined {
	const firstLineEnd = content.indexOf("\n");
	const firstLine = firstLineEnd === -1 ? content : content.slice(0, firstLineEnd);
	const inlineStarred = extractTopLevelBooleanProperty(firstLine, "starred");
	const starredPatchVersion = extractTopLevelIntegerProperty(firstLine, "starredPatchVersion") === 1 ? 1 : undefined;
	const parsedHeader = entries[0];
	if (parsedHeader?.type === "session" && typeof parsedHeader.id === "string") {
		return {
			type: "session",
			id: parsedHeader.id,
			version: typeof parsedHeader.version === "number" ? parsedHeader.version : undefined,
			cwd: typeof parsedHeader.cwd === "string" ? parsedHeader.cwd : undefined,
			title: typeof parsedHeader.title === "string" ? parsedHeader.title : undefined,
			starredPatchVersion: parsedHeader.starredPatchVersion === 1 ? 1 : starredPatchVersion,
			starred: typeof parsedHeader.starred === "boolean" ? parsedHeader.starred : inlineStarred,
			parentSession: typeof parsedHeader.parentSession === "string" ? parsedHeader.parentSession : undefined,
			timestamp: typeof parsedHeader.timestamp === "string" ? parsedHeader.timestamp : undefined,
		};
	}
	if (extractStringProperty(firstLine, "type") !== "session") return undefined;
	const id = extractStringProperty(firstLine, "id");
	if (!id) return undefined;
	return {
		type: "session",
		id,
		version: extractTopLevelIntegerProperty(firstLine, "version"),
		cwd: extractStringProperty(firstLine, "cwd"),
		title: extractStringProperty(firstLine, "title"),
		starred: inlineStarred,
		starredPatchVersion,
		parentSession: extractStringProperty(firstLine, "parentSession"),
		timestamp: extractStringProperty(firstLine, "timestamp"),
	};
}

function getSessionListWorkerCount(fileCount: number): number {
	if (fileCount <= SESSION_LIST_PARALLEL_THRESHOLD) return 1;
	return Math.min(
		SESSION_LIST_MAX_WORKERS,
		os.availableParallelism(),
		Math.ceil(fileCount / SESSION_LIST_PARALLEL_THRESHOLD),
	);
}

async function collectSessionFromFile(
	file: string,
	storage: SessionStorageReader,
	buffer: Buffer,
	enrich?: SessionMetadataEnricher,
): Promise<SessionMetadata | undefined> {
	try {
		const content = await readSessionListPrefix(file, storage, buffer);
		const entries = parseStoredSessionEntries(content).map(entry => entry as unknown as Record<string, unknown>);
		const header = parseSessionListHeader(content, entries);
		if (!header) return undefined;
		if (header.starredPatchVersion !== 1) header.starred = undefined;
		if (typeof header.version === "number" && header.version >= 4 && header.version <= CURRENT_SESSION_VERSION) {
			for (const patch of await readSessionListTrailingPatches(file, storage, header.starredPatchVersion === 1))
				applySessionListHeaderPatch(header, patch);
		}
		let parsedMessageCount = 0;
		let firstMessage = "";
		const allMessages: string[] = [];
		let shortSummary: string | undefined;
		for (let i = 1; i < entries.length; i++) {
			const entry = entries[i] as { type?: string; message?: Message; shortSummary?: string };
			if (entry.type === "compaction" && typeof entry.shortSummary === "string") shortSummary = entry.shortSummary;
			if (entry.type === "message" && entry.message) {
				parsedMessageCount++;
				if (entry.message.role === "user" || entry.message.role === "assistant") {
					const textContent = extractTextFromContent(entry.message.content);
					if (textContent) {
						allMessages.push(textContent);
						if (!firstMessage && entry.message.role === "user") firstMessage = textContent;
					}
				}
			}
		}
		firstMessage ||= extractFirstUserMessageFromPrefix(content) ?? "";
		const messageCount = Math.max(parsedMessageCount, countMessageMarkers(content));
		const stats = storage.statSync(file);
		const session: SessionMetadata = {
			path: file,
			id: header.id,
			cwd: header.cwd ?? "",
			title: header.title ?? shortSummary,
			starred: header.starred === true,
			parentSessionPath: header.parentSession,
			created: new Date(header.timestamp ?? ""),
			modified: stats.mtime,
			messageCount,
			messageCountIsEstimate: stats.size > SESSION_LIST_PREFIX_BYTES,
			size: stats.size,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: allMessages.length > 0 ? allMessages.join(" ") : firstMessage,
		};
		if (enrich) await enrich(session, stats);
		return session;
	} catch {
		return undefined;
	}
}

async function collectSessionsFromFileStride(
	files: readonly string[],
	storage: SessionStorageReader,
	startIndex: number,
	stride: number,
	enrich?: SessionMetadataEnricher,
): Promise<SessionMetadata[]> {
	const sessions: SessionMetadata[] = [];
	const buffer = Buffer.allocUnsafe(SESSION_LIST_PREFIX_BYTES);
	for (let i = startIndex; i < files.length; i += stride) {
		const session = await collectSessionFromFile(files[i], storage, buffer, enrich);
		if (session) sessions.push(session);
	}
	return sessions;
}

/** Inspect already-selected transcript paths without persistence, repair, locking, or native manager construction. */
export async function readSessionMetadata(
	files: readonly string[],
	storage: SessionStorageReader = new FileSessionReader(),
	enrich?: SessionMetadataEnricher,
): Promise<SessionMetadata[]> {
	const workerCount = getSessionListWorkerCount(files.length);
	const sessions =
		workerCount === 1
			? await collectSessionsFromFileStride(files, storage, 0, 1, enrich)
			: (
					await Promise.all(
						Array.from({ length: workerCount }, (_, workerIndex) =>
							collectSessionsFromFileStride(files, storage, workerIndex, workerCount, enrich),
						),
					)
				).flat();
	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return sessions;
}
