/**
 * Compacted crash signature index.
 *
 * The index is **advisory, never authority**. It exists so `gjc crash report`
 * and the startup nudge can say "signature X happened 235 times since Aug 2"
 * without re-parsing a 500 KiB log. It can never authorize, suppress or
 * auto-target anything: a `reportedAt` stamp changes default highlighting, not
 * permission, and every submission is independently confirmed.
 *
 * Increments normally come from the append-only journal. When that write was
 * lost, compaction may recover a never-indexed signature only from a complete
 * v1 crash record whose fingerprint recomputes from its own diagnostic text.
 * Evicted reported or acknowledged signatures stay durably retired.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	appendCrashEvent,
	CRASH_FINGERPRINT_PATTERN,
	type CrashEvent,
	getCrashEventsPath,
	getCrashIndexPath,
	getCrashLogPath,
	isEnoent,
	parseCrashEventLine,
	parseCrashRecordMarker,
} from "@gajae-code/utils";
import { withFileLock } from "../config/file-lock";
import { type LoadedCrashRecord, parseRecoverableCrashRecords } from "./record-loader";

export const CRASH_INDEX_VERSION = 1;
/** Per-entry message preview cap. */
export const CRASH_INDEX_MESSAGE_MAX_BYTES = 512;
/** Per-entry serialized cap. */
export const CRASH_INDEX_ENTRY_MAX_BYTES = 1024;
/** Whole-index serialized cap. */
export const CRASH_INDEX_MAX_BYTES = 256 * 1024;
/** Entry-count cap; with the per-entry cap this keeps the file under the byte cap. */
export const CRASH_INDEX_MAX_SIGNATURES = 128;
/** How many `.corrupt-*` siblings are kept before the oldest are deleted. */
export const CRASH_INDEX_MAX_QUARANTINE = 3;
/** Dedupe window for occurrence ids, so a re-merged journal cannot double-count. */
const RECENT_EVENT_ID_LIMIT = 256;
/** Whole rotated-journal digests retained to make publish-before-delete replay idempotent. */
const RECENT_JOURNAL_DIGEST_LIMIT = 64;
/** Timestamps outside this window are hostile-but-valid JSON and are rejected. */
const MIN_TIMESTAMP_MS = Date.UTC(2020, 0, 1);
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
/** Bounded read of the crash log when recomputing retained counts. */
const CRASH_LOG_SCAN_MAX_BYTES = 1024 * 1024;
/** A complete retained record consumes more than 64 bytes, so this covers every distinct fingerprint in the scan. */
const CRASH_RETIRED_MAX_FINGERPRINTS = Math.ceil(CRASH_LOG_SCAN_MAX_BYTES / 64);
/**
 * Bounded read of a rotated journal. The journal is rotated away at every
 * compaction, so this only has to cover one startup interval; when a pathological
 * run does exceed it, the *newest* events are the ones kept.
 */
const CRASH_JOURNAL_SCAN_MAX_BYTES = 4 * 1024 * 1024;

export interface CrashSignatureEntry {
	fpv: number;
	errorName: string;
	messageClass: string;
	/** Occurrences ever journaled for this signature. Never decreases. */
	lifetimeCount: number;
	/** Occurrences whose record is still present in the current crash log. */
	retainedCount: number;
	firstSeen: number;
	lastSeen: number;
	lastRecordId: string;
	reportedAt?: number;
	reportedIssueUrl?: string;
	acknowledgedAt?: number;
	/** Epoch ms this signature was last accepted by the configured upstream. */
	relayedAt?: number;
	/** Occurrence record represented by the durable upstream watermark. */
	relayedRecordId?: string;
	/** Issues this install already "+1"ed, so re-invocations cannot spam comments. */
	commentedIssues?: string[];
}

export interface CrashIndex {
	version: number;
	updatedAt: number;
	/** Epoch ms of the last startup nudge, or 0. */
	lastNudgedAt: number;
	/** True when a new signature could not be stored because nothing was evictable. */
	overflow: boolean;
	recentEventIds: string[];
	recentJournalDigests: string[];
	/** Log-recovered occurrence ids awaiting a possibly delayed journal event. */
	recoveredRecordIds: string[];
	/** Reported or acknowledged signatures evicted from the index; never recovered from the log. */
	retiredFingerprints: string[];
	signatures: Record<string, CrashSignatureEntry>;
}

interface CrashRetiredIndex {
	version: number;
	fingerprints: string[];
	recoveredRecordIds: string[];
}

export interface CrashStatePaths {
	index: string;
	events: string;
	crashLog: string;
}

export function resolveCrashStatePaths(agentDir?: string): CrashStatePaths {
	return {
		index: getCrashIndexPath(agentDir),
		events: getCrashEventsPath(agentDir),
		crashLog: getCrashLogPath(agentDir),
	};
}

export function emptyCrashIndex(): CrashIndex {
	return {
		version: CRASH_INDEX_VERSION,
		updatedAt: 0,
		lastNudgedAt: 0,
		overflow: false,
		recentEventIds: [],
		recentJournalDigests: [],
		recoveredRecordIds: [],
		retiredFingerprints: [],
		signatures: Object.create(null) as Record<string, CrashSignatureEntry>,
	};
}

// ---------------------------------------------------------------------------
// Strict parsing
// ---------------------------------------------------------------------------

const ENTRY_KEYS = new Set([
	"fpv",
	"errorName",
	"messageClass",
	"lifetimeCount",
	"retainedCount",
	"firstSeen",
	"lastSeen",
	"lastRecordId",
	"reportedAt",
	"reportedIssueUrl",
	"acknowledgedAt",
	"relayedAt",
	"relayedRecordId",
	"commentedIssues",
]);
const INDEX_KEYS = new Set([
	"version",
	"updatedAt",
	"lastNudgedAt",
	"overflow",
	"recentEventIds",
	"recentJournalDigests",
	"recoveredRecordIds",
	"retiredFingerprints",
	"signatures",
]);

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

function isCleanString(value: unknown, maxBytes: number): value is string {
	return typeof value === "string" && !CONTROL_CHARS.test(value) && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function isTimestamp(value: unknown, now: number): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= MIN_TIMESTAMP_MS &&
		value <= now + MAX_FUTURE_SKEW_MS
	);
}

/** `JSON.parse` with a reviver that refuses prototype-polluting keys. */
function parseJsonNullProto(raw: string): unknown {
	return JSON.parse(raw, function reviver(key, value) {
		if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
		if (value && typeof value === "object" && !Array.isArray(value)) return Object.assign(Object.create(null), value);
		return value;
	}) as unknown;
}

function retiredIndexPath(indexPath: string): string {
	return `${indexPath}.retired`;
}

function parseRetiredIndex(raw: string): CrashRetiredIndex | undefined {
	let parsed: unknown;
	try {
		parsed = parseJsonNullProto(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const body = parsed as Record<string, unknown>;
	if (body.version !== CRASH_INDEX_VERSION || !Array.isArray(body.fingerprints)) return undefined;
	if (body.fingerprints.length > CRASH_RETIRED_MAX_FINGERPRINTS) return undefined;
	if (!body.fingerprints.every(value => typeof value === "string" && CRASH_FINGERPRINT_PATTERN.test(value)))
		return undefined;
	if (body.recoveredRecordIds !== undefined) {
		if (!Array.isArray(body.recoveredRecordIds) || body.recoveredRecordIds.length > CRASH_RETIRED_MAX_FINGERPRINTS)
			return undefined;
		if (!body.recoveredRecordIds.every(value => typeof value === "string" && /^[0-9a-f]{8,32}$/.test(value)))
			return undefined;
	}
	return {
		version: CRASH_INDEX_VERSION,
		fingerprints: [...body.fingerprints],
		recoveredRecordIds: [...((body.recoveredRecordIds as string[] | undefined) ?? [])],
	};
}

function parseEntry(value: unknown, now: number): CrashSignatureEntry | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	for (const key of Object.keys(raw)) if (!ENTRY_KEYS.has(key)) return undefined;
	if (typeof raw.fpv !== "number" || !Number.isSafeInteger(raw.fpv) || raw.fpv < 1 || raw.fpv > 999) return undefined;
	if (!isCleanString(raw.errorName, 128)) return undefined;
	if (!isCleanString(raw.messageClass, CRASH_INDEX_MESSAGE_MAX_BYTES)) return undefined;
	if (!isCount(raw.lifetimeCount) || !isCount(raw.retainedCount)) return undefined;
	if (raw.retainedCount > raw.lifetimeCount) return undefined;
	if (!isTimestamp(raw.firstSeen, now) || !isTimestamp(raw.lastSeen, now)) return undefined;
	if (raw.lastSeen < raw.firstSeen) return undefined;
	if (typeof raw.lastRecordId !== "string" || !/^[0-9a-f]{8,32}$/.test(raw.lastRecordId)) return undefined;
	if (raw.reportedAt !== undefined && !isTimestamp(raw.reportedAt, now)) return undefined;
	if (raw.acknowledgedAt !== undefined && !isTimestamp(raw.acknowledgedAt, now)) return undefined;
	if (raw.relayedAt !== undefined && !isTimestamp(raw.relayedAt, now)) return undefined;
	if (
		raw.relayedRecordId !== undefined &&
		(typeof raw.relayedRecordId !== "string" || !/^[0-9a-f]{8,32}$/.test(raw.relayedRecordId))
	)
		return undefined;
	if (raw.reportedIssueUrl !== undefined && !isCleanString(raw.reportedIssueUrl, 256)) return undefined;
	if (raw.commentedIssues !== undefined) {
		if (!Array.isArray(raw.commentedIssues) || raw.commentedIssues.length > 32) return undefined;
		if (!raw.commentedIssues.every(url => isCleanString(url, 256))) return undefined;
	}
	const entry: CrashSignatureEntry = {
		fpv: raw.fpv,
		errorName: raw.errorName,
		messageClass: raw.messageClass,
		lifetimeCount: raw.lifetimeCount,
		retainedCount: raw.retainedCount,
		firstSeen: raw.firstSeen,
		lastSeen: raw.lastSeen,
		lastRecordId: raw.lastRecordId,
	};
	if (raw.reportedAt !== undefined) entry.reportedAt = raw.reportedAt;
	if (raw.reportedIssueUrl !== undefined) entry.reportedIssueUrl = raw.reportedIssueUrl;
	if (raw.acknowledgedAt !== undefined) entry.acknowledgedAt = raw.acknowledgedAt;
	if (raw.relayedAt !== undefined) entry.relayedAt = raw.relayedAt;
	if (raw.relayedRecordId !== undefined) entry.relayedRecordId = raw.relayedRecordId;
	if (raw.commentedIssues !== undefined) entry.commentedIssues = [...(raw.commentedIssues as string[])];
	if (Buffer.byteLength(JSON.stringify(entry), "utf8") > CRASH_INDEX_ENTRY_MAX_BYTES) return undefined;
	return entry;
}

/**
 * Strict index parse. Any deviation — unknown key, wrong alphabet, control
 * character, out-of-range timestamp, count overflow — rejects the whole file so
 * it is quarantined and rebuilt from the journal rather than trusted.
 */
export function parseCrashIndex(raw: string, now: number = Date.now()): CrashIndex | undefined {
	if (Buffer.byteLength(raw, "utf8") > CRASH_INDEX_MAX_BYTES) return undefined;
	let parsed: unknown;
	try {
		parsed = parseJsonNullProto(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const body = parsed as Record<string, unknown>;
	for (const key of Object.keys(body)) if (!INDEX_KEYS.has(key)) return undefined;
	if (body.version !== CRASH_INDEX_VERSION) return undefined;
	if (!isTimestamp(body.updatedAt, now)) return undefined;
	if (body.lastNudgedAt !== 0 && !isTimestamp(body.lastNudgedAt, now)) return undefined;
	if (typeof body.overflow !== "boolean") return undefined;
	if (!Array.isArray(body.recentEventIds) || body.recentEventIds.length > RECENT_EVENT_ID_LIMIT) return undefined;
	if (!body.recentEventIds.every(id => typeof id === "string" && /^[0-9a-f]{8,32}$/.test(id))) return undefined;
	if (body.recentJournalDigests !== undefined) {
		if (!Array.isArray(body.recentJournalDigests) || body.recentJournalDigests.length > RECENT_JOURNAL_DIGEST_LIMIT)
			return undefined;
		if (!body.recentJournalDigests.every(digest => typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest)))
			return undefined;
	}
	if (body.recoveredRecordIds !== undefined) {
		if (!Array.isArray(body.recoveredRecordIds) || body.recoveredRecordIds.length > CRASH_RETIRED_MAX_FINGERPRINTS)
			return undefined;
		if (!body.recoveredRecordIds.every(id => typeof id === "string" && /^[0-9a-f]{8,32}$/.test(id))) return undefined;
	}
	if (body.retiredFingerprints !== undefined) {
		if (!Array.isArray(body.retiredFingerprints) || body.retiredFingerprints.length > CRASH_INDEX_MAX_SIGNATURES)
			return undefined;
		if (
			!body.retiredFingerprints.every(
				fingerprint => typeof fingerprint === "string" && CRASH_FINGERPRINT_PATTERN.test(fingerprint),
			)
		)
			return undefined;
	}
	if (!body.signatures || typeof body.signatures !== "object" || Array.isArray(body.signatures)) return undefined;

	const signatures = Object.create(null) as Record<string, CrashSignatureEntry>;
	const rawSignatures = body.signatures as Record<string, unknown>;
	const fingerprints = Object.keys(rawSignatures);
	if (fingerprints.length > CRASH_INDEX_MAX_SIGNATURES) return undefined;
	for (const fingerprint of fingerprints) {
		if (!CRASH_FINGERPRINT_PATTERN.test(fingerprint)) return undefined;
		const entry = parseEntry(rawSignatures[fingerprint], now);
		if (!entry) return undefined;
		signatures[fingerprint] = entry;
	}
	return {
		version: CRASH_INDEX_VERSION,
		updatedAt: body.updatedAt,
		lastNudgedAt: body.lastNudgedAt as number,
		overflow: body.overflow,
		recentEventIds: [...(body.recentEventIds as string[])],
		recentJournalDigests: [...((body.recentJournalDigests as string[] | undefined) ?? [])],
		recoveredRecordIds: [...((body.recoveredRecordIds as string[] | undefined) ?? [])],
		retiredFingerprints: [...((body.retiredFingerprints as string[] | undefined) ?? [])],
		signatures,
	};
}

// ---------------------------------------------------------------------------
// No-follow IO
// ---------------------------------------------------------------------------

const NOFOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;

/** Read a file refusing to traverse a symlink at the final component. */
async function readNoFollow(target: string, maxBytes: number): Promise<string | undefined> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(target, fs.constants.O_RDONLY | NOFOLLOW);
		const stat = await handle.stat();
		if (!stat.isFile()) return undefined;
		const length = Math.min(stat.size, maxBytes);
		const buffer = Buffer.allocUnsafe(length);
		await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
		return buffer.toString("utf8");
	} catch (error) {
		if (isEnoent(error)) return undefined;
		return undefined;
	} finally {
		await handle?.close().catch(() => {});
	}
}

async function writeAtomic(target: string, contents: string): Promise<void> {
	const temp = `${target}.tmp.${process.pid}.${randomUUID()}`;
	try {
		await fs.writeFile(temp, contents, { mode: 0o600, flag: "wx" });
		await fs.rename(temp, target);
	} catch (error) {
		await fs.rm(temp, { force: true }).catch(() => {});
		throw error;
	}
}

async function quarantineIndex(indexPath: string, now: number): Promise<string | undefined> {
	const target = `${indexPath}.corrupt-${now}`;
	try {
		await fs.rename(indexPath, target);
	} catch {
		return undefined;
	}
	try {
		const dir = path.dirname(indexPath);
		const base = `${path.basename(indexPath)}.corrupt-`;
		const siblings = (await fs.readdir(dir)).filter(name => name.startsWith(base)).sort();
		for (const stale of siblings.slice(0, Math.max(0, siblings.length - CRASH_INDEX_MAX_QUARANTINE))) {
			await fs.rm(path.join(dir, stale), { force: true }).catch(() => {});
		}
	} catch {}
	return target;
}

async function readRetiredIndex(indexPath: string): Promise<CrashRetiredIndex | undefined> {
	const target = retiredIndexPath(indexPath);
	const raw = await readNoFollow(target, CRASH_LOG_SCAN_MAX_BYTES);
	if (raw !== undefined) return parseRetiredIndex(raw);
	return (await crashLogExists(target)) === false
		? { version: CRASH_INDEX_VERSION, fingerprints: [], recoveredRecordIds: [] }
		: undefined;
}

async function crashLogExists(crashLogPath: string): Promise<boolean | undefined> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(crashLogPath, fs.constants.O_RDONLY | NOFOLLOW);
		const stat = await handle.stat();
		return stat.isFile() ? true : undefined;
	} catch (error) {
		if (isEnoent(error)) return false;
		return undefined;
	} finally {
		await handle?.close().catch(() => {});
	}
}

async function pruneRetiredFingerprints(index: CrashIndex, crashLogPath: string): Promise<void> {
	if (index.retiredFingerprints.length === 0) return;
	const contents = await readNoFollow(crashLogPath, CRASH_LOG_SCAN_MAX_BYTES);
	if (contents === undefined) {
		if ((await crashLogExists(crashLogPath)) === false) index.retiredFingerprints = [];
		return;
	}
	const retained = new Set(parseRecoverableCrashRecords(contents).map(record => record.fingerprint));
	index.retiredFingerprints = index.retiredFingerprints.filter(fingerprint => retained.has(fingerprint));
	const retainedIds = new Set(parseRecoverableCrashRecords(contents).map(record => record.recordId));
	index.recoveredRecordIds = index.recoveredRecordIds.filter(recordId => retainedIds.has(recordId));
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function boundMessageClass(value: string): string {
	if (Buffer.byteLength(value, "utf8") <= CRASH_INDEX_MESSAGE_MAX_BYTES) return value;
	const bytes = Buffer.from(value, "utf8");
	let end = CRASH_INDEX_MESSAGE_MAX_BYTES;
	while (end > 0 && (bytes[end - 1] & 0xc0) === 0x80) end--;
	if (end > 0 && (bytes[end - 1] ?? 0) >= 0xc0) end--;
	return bytes.subarray(0, end).toString("utf8");
}

function evictOne(index: CrashIndex): boolean {
	let victim: string | undefined;
	let victimSeen = Number.POSITIVE_INFINITY;
	for (const [fingerprint, entry] of Object.entries(index.signatures)) {
		// Unreported signatures are never evicted: losing them is exactly the
		// failure this feature exists to prevent.
		// relayedAt is deliberately not an eviction input.
		if (entry.reportedAt === undefined && entry.acknowledgedAt === undefined) continue;
		if (entry.lastSeen < victimSeen) {
			victim = fingerprint;
			victimSeen = entry.lastSeen;
		}
	}
	if (!victim) return false;
	if (!index.retiredFingerprints.includes(victim)) {
		if (index.retiredFingerprints.length >= CRASH_RETIRED_MAX_FINGERPRINTS) return false;
		index.retiredFingerprints.push(victim);
	}
	delete index.signatures[victim];
	return true;
}

/** Apply one journal event to the in-memory index. Returns whether it changed anything. */
export function applyCrashEvent(index: CrashIndex, event: CrashEvent, now: number): boolean {
	if (event.at > now + MAX_FUTURE_SKEW_MS || event.at < MIN_TIMESTAMP_MS) return false;
	if (event.kind === "nudged") {
		if (event.at <= index.lastNudgedAt) return false;
		index.lastNudgedAt = event.at;
		return true;
	}
	const existing = index.signatures[event.fingerprint];
	if (event.kind === "reported") {
		if (!existing) return false;
		if (event.commented) {
			const commented = existing.commentedIssues ?? [];
			if (commented.includes(event.issueUrl)) return false;
			existing.commentedIssues = [...commented, event.issueUrl].slice(-32);
			return true;
		}
		if (existing.reportedAt !== undefined && existing.reportedAt >= event.at) return false;
		existing.reportedAt = event.at;
		existing.reportedIssueUrl = event.issueUrl;
		return true;
	}
	if (event.kind === "relayed") {
		if (!existing) return false;
		if (existing.relayedRecordId === event.recordId) return false;
		existing.relayedAt = event.at;
		existing.relayedRecordId = event.recordId;
		return true;
	}
	if (event.kind === "acknowledged") {
		if (!existing) return false;
		if (existing.acknowledgedAt !== undefined && existing.acknowledgedAt >= event.at) return false;
		existing.acknowledgedAt = event.at;
		return true;
	}

	// occurrence
	// Clear before deduplication: a replayed occurrence after main-index publish
	// but before retirement-sidecar publish must still supersede a stale tombstone.
	index.retiredFingerprints = index.retiredFingerprints.filter(fingerprint => fingerprint !== event.fingerprint);
	if (index.recoveredRecordIds.includes(event.recordId)) {
		index.recoveredRecordIds = index.recoveredRecordIds.filter(recordId => recordId !== event.recordId);
		return false;
	}
	if (index.recentEventIds.includes(event.recordId)) return false;
	index.recentEventIds.push(event.recordId);
	if (index.recentEventIds.length > RECENT_EVENT_ID_LIMIT)
		index.recentEventIds.splice(0, index.recentEventIds.length - RECENT_EVENT_ID_LIMIT);
	// A journal occurrence is newer authority than a prior eviction tombstone.
	// Clear it before capacity eviction so a full retirement ledger cannot block
	// the signature's explicit revival.
	if (existing) {
		existing.lifetimeCount += 1;
		existing.firstSeen = Math.min(existing.firstSeen, event.at);
		if (event.at >= existing.lastSeen) {
			existing.lastSeen = event.at;
			existing.lastRecordId = event.recordId;
			if (event.messageClass) existing.messageClass = boundMessageClass(event.messageClass);
		}
		return true;
	}
	if (Object.keys(index.signatures).length >= CRASH_INDEX_MAX_SIGNATURES && !evictOne(index)) {
		// Nothing evictable: stop adding new entries and surface the overflow in
		// `gjc crash report` rather than dropping an unreported signature.
		index.overflow = true;
		return false;
	}
	index.signatures[event.fingerprint] = {
		fpv: event.fpv,
		errorName: event.errorName,
		messageClass: boundMessageClass(event.messageClass),
		lifetimeCount: 1,
		retainedCount: 0,
		firstSeen: event.at,
		lastSeen: event.at,
		lastRecordId: event.recordId,
	};
	return true;
}

/**
 * Recover never-indexed signatures from bound records, then recompute retained counts.
 *
 * Journal counts remain authoritative for known signatures. A never-seen
 * signature is admitted only from complete v1 records that recompute to their
 * marker fingerprint; its initial lifetime is the number of distinct retained
 * record ids. Repeated compaction cannot add those records again.
 *
 * The count is held at `lifetimeCount`, which `parseEntry` requires it not to
 * exceed. The log can hold more records than the journal counted — a fatal whose
 * journal append failed, or that spent the per-process latch, still writes its
 * record — and without this the compactor would write an index its own reader
 * quarantines whole on the next read.
 */
async function recoverAndRecomputeRetainedCounts(index: CrashIndex, crashLogPath: string, now: number): Promise<void> {
	for (const entry of Object.values(index.signatures)) entry.retainedCount = 0;
	const contents = await readNoFollow(crashLogPath, CRASH_LOG_SCAN_MAX_BYTES);
	if (contents === undefined) return;
	const retainedRecordIds = new Set<string>();
	for (const line of contents.split("\n")) {
		const marker = parseCrashRecordMarker(line);
		if (!marker) continue;
		if (retainedRecordIds.has(marker.recordId)) continue;
		retainedRecordIds.add(marker.recordId);
		const entry = index.signatures[marker.fingerprint];
		if (entry && entry.retainedCount < entry.lifetimeCount) entry.retainedCount += 1;
	}
	const recordsByFingerprint = new Map<string, LoadedCrashRecord[]>();
	const seenRecordIds = new Set<string>();
	for (const record of parseRecoverableCrashRecords(contents)) {
		if (seenRecordIds.has(record.recordId)) continue;
		seenRecordIds.add(record.recordId);
		const records = recordsByFingerprint.get(record.fingerprint) ?? [];
		records.push(record);
		recordsByFingerprint.set(record.fingerprint, records);
	}
	for (const [fingerprint, records] of recordsByFingerprint) {
		const oldest = records.reduce((candidate, record) => (record.at < candidate.at ? record : candidate));
		const newest = records.reduce((candidate, record) => (record.at >= candidate.at ? record : candidate));
		if (!oldest || !newest) continue;
		let entry = index.signatures[fingerprint];
		if (!entry) {
			if (index.retiredFingerprints.includes(fingerprint)) continue;
			if (oldest.at < MIN_TIMESTAMP_MS || newest.at > now + MAX_FUTURE_SKEW_MS) continue;
			if (Object.keys(index.signatures).length >= CRASH_INDEX_MAX_SIGNATURES && !evictOne(index)) {
				index.overflow = true;
				continue;
			}
			entry = {
				fpv: newest.fpv,
				errorName: newest.errorName,
				messageClass: boundMessageClass(newest.messageClass),
				lifetimeCount: records.length,
				retainedCount: records.length,
				firstSeen: oldest.at,
				lastSeen: newest.at,
				lastRecordId: newest.recordId,
			};
			index.signatures[fingerprint] = entry;
			for (const record of records) {
				if (!index.recoveredRecordIds.includes(record.recordId)) index.recoveredRecordIds.push(record.recordId);
				if (index.recentEventIds.includes(record.recordId)) continue;
				index.recentEventIds.push(record.recordId);
				if (index.recentEventIds.length > RECENT_EVENT_ID_LIMIT)
					index.recentEventIds.splice(0, index.recentEventIds.length - RECENT_EVENT_ID_LIMIT);
			}
		}
	}
}

async function drainJournal(paths: CrashStatePaths): Promise<string[]> {
	const dir = path.dirname(paths.events);
	const base = `${path.basename(paths.events)}.compacting-`;
	const pending: string[] = [];
	try {
		for (const name of await fs.readdir(dir)) if (name.startsWith(base)) pending.push(path.join(dir, name));
	} catch {}
	pending.sort();
	const rotated = `${paths.events}.compacting-${Date.now()}-${process.pid}`;
	try {
		await fs.rename(paths.events, rotated);
		pending.push(rotated);
	} catch {
		// No journal to rotate; leftovers from a crashed compaction still apply.
	}
	return pending;
}

export interface CompactCrashIndexOptions {
	paths?: CrashStatePaths;
	now?: number;
}

/**
 * Merge journal events into the index under the cross-process file lock.
 *
 * Bounded and idempotent: the journal is rotated aside before it is read (so a
 * concurrent fatal append lands in a fresh file rather than being lost to a
 * truncate), occurrence ids are deduped, and a crashed compaction's leftover
 * file is picked up by the next run.
 */
export async function compactCrashIndex(options: CompactCrashIndexOptions = {}): Promise<CrashIndex> {
	const paths = options.paths ?? resolveCrashStatePaths();
	const now = options.now ?? Date.now();
	await fs.mkdir(path.dirname(paths.index), { recursive: true, mode: 0o700 });
	return withFileLock(paths.index, async () => {
		const raw = await readNoFollow(paths.index, CRASH_INDEX_MAX_BYTES + 1);
		let index = raw === undefined ? emptyCrashIndex() : parseCrashIndex(raw, now);
		if (!index) {
			await quarantineIndex(paths.index, now);
			index = emptyCrashIndex();
		}
		const retired = await readRetiredIndex(paths.index);
		if (retired === undefined) throw new Error("Crash retirement ledger is unreadable");
		for (const fingerprint of retired.fingerprints) {
			if (!index.retiredFingerprints.includes(fingerprint)) index.retiredFingerprints.push(fingerprint);
		}
		for (const recordId of retired.recoveredRecordIds) {
			if (!index.recoveredRecordIds.includes(recordId)) index.recoveredRecordIds.push(recordId);
		}
		await pruneRetiredFingerprints(index, paths.crashLog);

		const drained = await drainJournal(paths);
		for (const file of drained) {
			const contents = await readNoFollow(file, CRASH_JOURNAL_SCAN_MAX_BYTES);
			if (contents === undefined) continue;
			const digest = createHash("sha256").update(contents).digest("hex");
			if (index.recentJournalDigests.includes(digest)) {
				// A batch replay after main-index publish still heals a stale retirement
				// sidecar, but must not reapply counts or other state transitions.
				for (const line of contents.split("\n")) {
					const event = parseCrashEventLine(line);
					if (event?.kind === "occurrence")
						index.retiredFingerprints = index.retiredFingerprints.filter(
							fingerprint => fingerprint !== event.fingerprint,
						);
				}
				continue;
			}
			for (const line of contents.split("\n")) {
				const event = parseCrashEventLine(line);
				if (event) applyCrashEvent(index, event, now);
			}
			index.recentJournalDigests.push(digest);
			if (index.recentJournalDigests.length > RECENT_JOURNAL_DIGEST_LIMIT)
				index.recentJournalDigests.splice(0, index.recentJournalDigests.length - RECENT_JOURNAL_DIGEST_LIMIT);
		}

		await recoverAndRecomputeRetainedCounts(index, paths.crashLog, now);
		index.updatedAt = now;
		const serializeIndex = (): string =>
			`${JSON.stringify({ ...index, retiredFingerprints: [], recoveredRecordIds: [] })}\n`;
		let serialized = serializeIndex();
		while (Buffer.byteLength(serialized, "utf8") > CRASH_INDEX_MAX_BYTES && evictOne(index)) {
			serialized = serializeIndex();
		}
		if (Buffer.byteLength(serialized, "utf8") > CRASH_INDEX_MAX_BYTES) {
			index.overflow = true;
			serialized = serializeIndex();
		}
		await writeAtomic(
			retiredIndexPath(paths.index),
			`${JSON.stringify({ version: CRASH_INDEX_VERSION, fingerprints: index.retiredFingerprints, recoveredRecordIds: index.recoveredRecordIds })}\n`,
		);
		await fs.rm(paths.index, { force: true });
		await writeAtomic(paths.index, serialized);
		for (const file of drained) await fs.rm(file, { force: true }).catch(() => {});
		return index;
	});
}

/** Read the index without compacting. Missing or invalid files read as empty. */
export async function readCrashIndex(paths: CrashStatePaths = resolveCrashStatePaths()): Promise<CrashIndex> {
	const raw = await readNoFollow(paths.index, CRASH_INDEX_MAX_BYTES + 1);
	if (raw === undefined) return emptyCrashIndex();
	return parseCrashIndex(raw) ?? emptyCrashIndex();
}

/**
 * Record a state change through the journal, then compact.
 *
 * Writing through the journal (rather than editing the index directly) is what
 * makes concurrent writers safe: two processes stamping `reportedAt` at the
 * same moment both land an event, and the compactor merges them.
 */
export async function recordCrashStateEvent(
	event: CrashEvent,
	options: CompactCrashIndexOptions = {},
): Promise<CrashIndex> {
	const paths = options.paths ?? resolveCrashStatePaths();
	await fs.mkdir(path.dirname(paths.events), { recursive: true, mode: 0o700 });
	if (!appendCrashEvent(event, paths.events)) throw new Error("Crash state journal append failed");
	return compactCrashIndex({ paths, now: options.now });
}

export interface CrashSignatureView extends CrashSignatureEntry {
	fingerprint: string;
}

/** Signatures newest-first, which is the order both the CLI and the nudge use. */
export function listCrashSignatures(index: CrashIndex): CrashSignatureView[] {
	return Object.entries(index.signatures)
		.map(([fingerprint, entry]) => ({ fingerprint, ...entry }))
		.sort((a, b) => b.lastSeen - a.lastSeen);
}
