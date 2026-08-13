/**
 * Compacted crash signature index.
 *
 * The index is **advisory, never authority**. It exists so `gjc crash report`
 * and the startup nudge can say "signature X happened 235 times since Aug 2"
 * without re-parsing a 500 KiB log. It can never authorize, suppress or
 * auto-target anything: a `reportedAt` stamp changes default highlighting, not
 * permission, and every submission is independently confirmed.
 *
 * Increments come from the append-only journal, not from this file, so a lost,
 * hostile or concurrently-rewritten index can never silently deflate counts —
 * it is rebuilt from the journal instead. A signature the journal never recorded
 * is adopted from the crash log's own identity-bearing records so the crash stays
 * reportable, but adoption creates the signature and counts the one record it
 * adopts; it never becomes a second source of increments.
 */
import { randomUUID } from "node:crypto";
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
} from "@gajae-code/utils";
import { withFileLock } from "../config/file-lock";
import { type LoadedCrashRecord, parseCrashRecords } from "./record-loader";

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
/** Newest log records kept per unseen signature as adoption fallbacks. */
const ADOPTION_CANDIDATES_PER_SIGNATURE = 4;
/** Timestamps outside this window are hostile-but-valid JSON and are rejected. */
const MIN_TIMESTAMP_MS = Date.UTC(2020, 0, 1);
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
/** Bounded read of the crash log when recomputing retained counts. */
const CRASH_LOG_SCAN_MAX_BYTES = 1024 * 1024;
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
	/**
	 * The crash-log record this signature was recovered from, when the journal
	 * never recorded it. Unlike `lastRecordId` it is never overwritten, so the
	 * adopted occurrence stays deduped even after later occurrences arrive.
	 */
	adoptedRecordId?: string;
	reportedAt?: number;
	reportedIssueUrl?: string;
	acknowledgedAt?: number;
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
	/**
	 * Fingerprints of reported or dismissed signatures that were evicted for
	 * capacity. Their crash-log records outlive them, and adoption must not turn
	 * one back into an unreported signature and re-offer a filed crash.
	 */
	dismissed: string[];
	signatures: Record<string, CrashSignatureEntry>;
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
		dismissed: [],
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
	"adoptedRecordId",
	"reportedAt",
	"reportedIssueUrl",
	"acknowledgedAt",
	"commentedIssues",
]);
const INDEX_KEYS = new Set([
	"version",
	"updatedAt",
	"lastNudgedAt",
	"overflow",
	"recentEventIds",
	"dismissed",
	"signatures",
]);
/** Fingerprints remembered as evicted-after-report, so adoption cannot undo a filing. */
/**
 * Fingerprints remembered as evicted-after-report.
 *
 * `pruneDismissed` already drops a dismissal as soon as the crash log stops
 * naming it, so this cap only binds when that many *distinct* signatures have
 * been filed, evicted, and still have records in the log window at the same
 * time. Four times the signature capacity costs about 17 KiB of the 256 KiB
 * index budget. Past that the oldest dismissal is dropped and its crash can be
 * re-offered once; see the note on `pruneDismissed`.
 */
const DISMISSED_FINGERPRINT_LIMIT = 4 * CRASH_INDEX_MAX_SIGNATURES;

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const RECORD_ID_PATTERN = /^[0-9a-f]{8,32}$/;
const SCOPED_RECORD_ID_PATTERN = /^[0-9a-f]{32}:[0-9a-f]{8,32}$/;
const CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f-\u009f]/g;

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
	if (
		raw.adoptedRecordId !== undefined &&
		(typeof raw.adoptedRecordId !== "string" || !RECORD_ID_PATTERN.test(raw.adoptedRecordId))
	)
		return undefined;
	if (raw.reportedAt !== undefined && !isTimestamp(raw.reportedAt, now)) return undefined;
	if (raw.acknowledgedAt !== undefined && !isTimestamp(raw.acknowledgedAt, now)) return undefined;
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
	if (raw.adoptedRecordId !== undefined) entry.adoptedRecordId = raw.adoptedRecordId;
	if (raw.reportedAt !== undefined) entry.reportedAt = raw.reportedAt;
	if (raw.reportedIssueUrl !== undefined) entry.reportedIssueUrl = raw.reportedIssueUrl;
	if (raw.acknowledgedAt !== undefined) entry.acknowledgedAt = raw.acknowledgedAt;
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
	if (
		!body.recentEventIds.every(
			id => typeof id === "string" && (RECORD_ID_PATTERN.test(id) || SCOPED_RECORD_ID_PATTERN.test(id)),
		)
	)
		return undefined;
	// Absent in an index written before adoption existed: an upgrade must not
	// quarantine a valid file and lose its history.
	const dismissed = body.dismissed ?? [];
	if (!Array.isArray(dismissed) || dismissed.length > DISMISSED_FINGERPRINT_LIMIT) return undefined;
	if (!dismissed.every(fingerprint => typeof fingerprint === "string" && CRASH_FINGERPRINT_PATTERN.test(fingerprint)))
		return undefined;
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
		dismissed: [...(dismissed as string[])],
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
	let victimRetained = Number.POSITIVE_INFINITY;
	for (const [fingerprint, entry] of Object.entries(index.signatures)) {
		// Unreported signatures are never evicted: losing them is exactly the
		// failure this feature exists to prevent.
		if (entry.reportedAt === undefined && entry.acknowledgedAt === undefined) continue;
		// A signature the crash log no longer names cannot be adopted back, so evicting
		// it needs no dismissal that outlives this compaction. Taking those victims
		// first keeps the bounded dismissal list for the signatures that actually need
		// it. This is a preference, not a refusal: refusing to evict a retained
		// signature would make the index reject a new — possibly unreported — one
		// instead, which is the failure eviction exists to avoid.
		const retained = entry.retainedCount > 0 ? 1 : 0;
		if (retained > victimRetained) continue;
		if (retained < victimRetained || entry.lastSeen < victimSeen) {
			victim = fingerprint;
			victimSeen = entry.lastSeen;
			victimRetained = retained;
		}
	}
	if (!victim) return false;
	delete index.signatures[victim];
	// An evicted signature is still named by the records the crash log holds, and
	// only a reported or dismissed signature is ever evictable. The eviction has to
	// outlive this compaction, or adoption would later recreate the signature
	// without the `reportedAt` that made it evictable — re-offering a filed crash.
	if (!index.dismissed.includes(victim)) index.dismissed.push(victim);
	// A dismissal is only load-bearing while the crash log can still name the
	// signature, and `pruneDismissed` drops it as soon as it cannot. This cap is the
	// backstop for the one case pruning cannot cover — a log the compactor could not
	// read — and is sized at the signature capacity because that is the most
	// signatures that can be evicted without a single new record being written.
	if (index.dismissed.length > DISMISSED_FINGERPRINT_LIMIT)
		index.dismissed.splice(0, index.dismissed.length - DISMISSED_FINGERPRINT_LIMIT);
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
	if (event.kind === "acknowledged") {
		if (!existing) return false;
		if (existing.acknowledgedAt !== undefined && existing.acknowledgedAt >= event.at) return false;
		existing.acknowledgedAt = event.at;
		return true;
	}

	// occurrence
	if (hasScopedOccurrenceId(index, event.fingerprint, event.recordId)) return false;
	if (existing) {
		// A record id names exactly one crash record. The record an entry was built
		// from is therefore never a second occurrence, and an adopted record stays
		// deduped for the entry's whole life — the bounded window cannot, and
		// `lastRecordId` is overwritten by every later occurrence.
		if (existing.lastRecordId === event.recordId || existing.adoptedRecordId === event.recordId) return false;
		existing.lifetimeCount += 1;
		existing.lastSeen = Math.max(existing.lastSeen, event.at);
		existing.firstSeen = Math.min(existing.firstSeen, event.at);
		existing.lastRecordId = event.recordId;
		if (event.messageClass) existing.messageClass = boundMessageClass(event.messageClass);
		rememberOccurrenceId(index, event.fingerprint, event.recordId);
		return true;
	}
	if (Object.keys(index.signatures).length >= CRASH_INDEX_MAX_SIGNATURES && !evictOne(index)) {
		// Nothing evictable: stop adding new entries and surface the overflow in
		// `gjc crash report` rather than dropping an unreported signature. The id is
		// deliberately not remembered: an occurrence that was refused was not counted,
		// and remembering it would suppress the same crash's later recovery from the
		// crash log once the index has room again.
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
	rememberOccurrenceId(index, event.fingerprint, event.recordId);
	return true;
}

/** Record a counted occurrence id in the bounded dedupe window. */
function rememberOccurrenceId(index: CrashIndex, fingerprint: string, recordId: string): void {
	index.recentEventIds.push(`${fingerprint}:${recordId}`);
	if (index.recentEventIds.length > RECENT_EVENT_ID_LIMIT)
		index.recentEventIds.splice(0, index.recentEventIds.length - RECENT_EVENT_ID_LIMIT);
}

function hasScopedOccurrenceId(index: CrashIndex, fingerprint: string, recordId: string): boolean {
	return index.recentEventIds.includes(`${fingerprint}:${recordId}`);
}

/**
 * Recompute retained counts from the crash log's identity markers.
 *
 * `lifetimeCount` accumulates from the journal and never decreases; the crash
 * log is capped and reset, so retained counts are re-derived from what the log
 * actually still holds. That separation keeps a log reset from deflating a
 * signature's history.
 *
 * Only structurally framed records count. A bare marker line — an identity line
 * with no record header above it — names a record that reporting could never
 * load, so counting it would let a rewritten log inflate a signature's history.
 * Record ids are deduped for the same reason.
 *
 * The count is capped at `lifetimeCount`, which the journal alone advances. The
 * cap is not cosmetic: `parseEntry` rejects `retainedCount > lifetimeCount`, so
 * a log that still holds more records than the journal ever counted would make
 * compaction write a file it must quarantine on the next read.
 */
function recomputeRetainedCounts(index: CrashIndex, records: readonly LoadedCrashRecord[]): void {
	for (const entry of Object.values(index.signatures)) entry.retainedCount = 0;
	const counted = new Set<string>();
	for (const record of records) {
		const identity = `${record.fingerprint}:${record.recordId}`;
		if (counted.has(identity)) continue;
		counted.add(identity);
		const entry = index.signatures[record.fingerprint];
		if (entry) entry.retainedCount += 1;
	}
	for (const entry of Object.values(index.signatures))
		entry.retainedCount = Math.min(entry.retainedCount, entry.lifetimeCount);
}

/**
 * Drop dismissals the crash log can no longer justify.
 *
 * A dismissal exists for exactly one reason: to stop adoption from recreating a
 * signature that eviction removed after it was filed. Adoption can only act on
 * records this same scan found, so once the log no longer names a fingerprint,
 * its dismissal protects nothing and only consumes a bounded slot that a
 * still-reachable signature may need.
 *
 * Tying the lifetime to the log rather than to a fixed count is what makes the
 * bound sound: the count-only cap could age out a dismissal while the record it
 * guarded was still in the log, and the next compaction would re-offer a crash
 * the user had already filed.
 *
 * Only called with records from a log the compactor actually read. A log that
 * could not be read is indistinguishable from an empty one here, and pruning on
 * that would discard every dismissal on a transient read error.
 *
 * The residual bound: when more than `DISMISSED_FINGERPRINT_LIMIT` distinct
 * signatures are filed, evicted, and still named by the log window at once, the
 * oldest dismissal is dropped and that crash can be adopted again as a new
 * signature — re-offering a report the user already filed. It is re-offered, not
 * lost, and the alternative is an unbounded list inside a byte-capped file.
 */
function pruneDismissed(index: CrashIndex, records: readonly LoadedCrashRecord[]): void {
	if (index.dismissed.length === 0) return;
	const named = new Set(records.map(record => record.fingerprint));
	index.dismissed = index.dismissed.filter(fingerprint => named.has(fingerprint));
}

/**
 * Adopt signatures for identity-bearing log records the index has never seen.
 *
 * The journal is the counter, but it is not the only witness: an append can
 * fail, the fatal path latches after one event per process, and a quarantined
 * index is rebuilt from a journal that compaction already consumed. In each
 * case a `gjc-crash-record.v1` record still names its own fingerprint, and
 * dropping it means the crash can never be reported at all.
 *
 * Only marker-bearing records are adopted — records written before that line
 * existed stay `unmatchable`, exactly as the loader promises.
 *
 * Adoption creates a signature; it does not become a second counter. Exactly
 * one record per newly seen fingerprint is adopted, the newest, and it counts
 * as the one occurrence it is. Every later occurrence of that signature is
 * counted by the journal as usual, and the adopted record's id enters the
 * occurrence dedupe window so a journal line merged after adoption — the record
 * written between this compaction's journal rotation and its log read — is
 * recognised as the same crash instead of being counted twice.
 *
 * Consequently a signature whose journal events were lost is reported with a
 * count that is a lower bound rather than the log's record count. Undercounting
 * a recovered signature is the deliberate trade: the journal stays the only
 * thing that advances a count, and the crash becomes reportable at all.
 */
function adoptLogOnlySignatures(index: CrashIndex, records: readonly LoadedCrashRecord[], now: number): void {
	// Fingerprints the journal already accounts for keep the journal as their only
	// counter; adoption applies to signatures the index has no record of at all.
	const journaled = new Set(Object.keys(index.signatures));
	const dismissed = new Set(index.dismissed);
	const candidates = new Map<string, { newest: LoadedCrashRecord[]; firstSeen: number }>();
	for (const record of records) {
		if (journaled.has(record.fingerprint) || dismissed.has(record.fingerprint)) continue;
		if (record.at === undefined || record.at < MIN_TIMESTAMP_MS || record.at > now + MAX_FUTURE_SKEW_MS) continue;
		if (!Number.isSafeInteger(record.fpv) || record.fpv < 1 || record.fpv > 999) continue;
		const previous = candidates.get(record.fingerprint);
		if (!previous) {
			candidates.set(record.fingerprint, { newest: [record], firstSeen: record.at });
			continue;
		}
		previous.firstSeen = Math.min(previous.firstSeen, record.at);
		// The last records in log order, so one unusable record — a message that only
		// fits before escaping, an unusable error name — cannot starve a signature
		// that another record of the same crash could still recover. Log order, not
		// header timestamps: `findLatestRecord` picks the record that renders the
		// report the same way, and a skewed header must not make the two disagree.
		previous.newest.unshift(record);
		if (previous.newest.length > ADOPTION_CANDIDATES_PER_SIGNATURE)
			previous.newest.length = ADOPTION_CANDIDATES_PER_SIGNATURE;
	}
	// Newest first: when the index cannot hold every unseen signature, the recent
	// crashes are the ones worth keeping.
	const ordered = [...candidates.values()].sort((a, b) => (b.newest[0]?.at ?? 0) - (a.newest[0]?.at ?? 0));
	for (const { newest, firstSeen } of ordered) {
		for (const record of newest) {
			if (hasScopedOccurrenceId(index, record.fingerprint, record.recordId)) continue;
			// Throwable text can contain a line that looks like an identity line, and the
			// loader ends a record at the first one. A record whose identity line is not
			// where the writer puts it therefore has an identity a crash message could
			// have chosen; refuse to create a signature from it.
			if (!record.wellTerminated) continue;
			// The log is arbitrary throwable text, but the index is written under a parser
			// that rejects control characters in any field: an escape sequence or tab in a
			// crash message would quarantine the whole file on the next read.
			const headline = record.headline.replace(CONTROL_CHARS_GLOBAL, " ");
			const separator = headline.indexOf(": ");
			const errorName = separator > 0 ? headline.slice(0, separator) : headline;
			if (errorName.length === 0 || Buffer.byteLength(errorName, "utf8") > 128) continue;
			const entry: CrashSignatureEntry = {
				fpv: record.fpv,
				errorName,
				messageClass: boundMessageClass(separator > 0 ? headline.slice(separator + 2) : ""),
				lifetimeCount: 1,
				retainedCount: 0,
				firstSeen: Math.min(firstSeen, record.at ?? firstSeen),
				lastSeen: record.at ?? firstSeen,
				lastRecordId: record.recordId,
				adoptedRecordId: record.recordId,
			};
			// The entry has to survive the strict parser that reads it back. A message of
			// quotes or backslashes stays under the raw byte cap but doubles when it is
			// serialized, and an index one byte over the entry cap is quarantined whole.
			if (Buffer.byteLength(JSON.stringify(entry), "utf8") > CRASH_INDEX_ENTRY_MAX_BYTES) continue;
			// Capacity is proved before the dedupe window is touched: a refused adoption
			// must not displace the occurrence id of a journaled record.
			if (Object.keys(index.signatures).length >= CRASH_INDEX_MAX_SIGNATURES && !evictOne(index)) {
				index.overflow = true;
				return;
			}
			// The bounded dedupe window is deliberately not touched: displacing a
			// journaled id there would let a replay count that crash twice. The adopted
			// id lives in `adoptedRecordId`, which `applyCrashEvent` checks, so this
			// record stays deduped for as long as the entry exists.
			index.signatures[record.fingerprint] = entry;
			break;
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

		const drained = await drainJournal(paths);
		for (const file of drained) {
			const contents = await readNoFollow(file, CRASH_JOURNAL_SCAN_MAX_BYTES);
			if (contents === undefined) continue;
			for (const line of contents.split("\n")) {
				const event = parseCrashEventLine(line);
				if (event) applyCrashEvent(index, event, now);
			}
		}

		// One bounded read and one parse serve both passes: adoption and the retained
		// recount must agree on exactly which records the log still holds.
		const crashLog = await readNoFollow(paths.crashLog, CRASH_LOG_SCAN_MAX_BYTES);
		const records = crashLog === undefined ? [] : parseCrashRecords(crashLog);
		if (crashLog !== undefined) pruneDismissed(index, records);
		adoptLogOnlySignatures(index, records, now);
		recomputeRetainedCounts(index, records);
		index.updatedAt = now;
		let serialized = `${JSON.stringify(index)}\n`;
		while (Buffer.byteLength(serialized, "utf8") > CRASH_INDEX_MAX_BYTES && evictOne(index)) {
			serialized = `${JSON.stringify(index)}\n`;
		}
		if (Buffer.byteLength(serialized, "utf8") > CRASH_INDEX_MAX_BYTES) {
			index.overflow = true;
			serialized = `${JSON.stringify(index)}\n`;
		}
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
	appendCrashEvent(event, paths.events);
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
