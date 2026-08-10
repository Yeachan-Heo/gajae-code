import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "../../config/file-lock";
import { processIncarnation } from "./process-incarnation";
import {
	assertSupportedSnapshotVersion,
	assertSupportedStateVersion,
	SDK_STATE_VERSION,
	SESSION_INDEX_SNAPSHOT_VERSION,
	UnsupportedStateVersionError,
} from "./state-version";

export type SessionIndexEventType =
	| "host_registered"
	| "host_heartbeat"
	| "host_unregistered"
	| "lifecycle_started"
	| "lifecycle_terminal"
	| "session_closed"
	| "session_deleted"
	| "record_reconciled";

export type SessionActivityState = "active" | "idle";
/** Coalesced broker-owned heartbeat checkpoint (C2): state plus the observation time. */
export interface SessionActivity {
	state: SessionActivityState;
	at: number;
}
/** Events persisted without an OS process incarnation (v1/v2 era) are legacy provenance. */
export type SessionIdentityProvenance = "composite" | "legacy";
export type SessionTombstoneRule = "retain" | "expire";
/**
 * Injected retention policy (C3). The broker schedules compaction independently of
 * rotation; settings apply at the next scheduled compaction. `clock` drives both
 * retention expiry and heartbeat-freshness liveness reads.
 */
export interface RetentionPolicy {
	clock?: () => number;
	maxAgeMs?: number;
	maxRows?: number;
	tombstoneRule?: SessionTombstoneRule;
}
export interface SessionIndexEvent {
	version: typeof SDK_STATE_VERSION;
	indexSeq: number;
	type: SessionIndexEventType;
	sessionId: string;
	locator: { repo: string; stateRoot: string };
	endpointGeneration: number;
	pid: number;
	/**
	 * OS start incarnation of `pid`, published by the host that owns that pid. A
	 * pid is reusable, so teardown needs this binding to prove the pid is still
	 * the same process; keeping it here, in broker-owned storage, is what lets
	 * that proof outlive the session's own workspace.
	 */
	processIncarnation?: string;
	endpointMtimeMs?: number;
	lifecycleRequestId?: string;
	terminalUncertain?: boolean;
	/** OS process incarnation (C1); absent on legacy v1/v2 events. */
	hostIncarnation?: string;
	/** Present on host_heartbeat checkpoints (C2). */
	activity?: SessionActivity;
	ts: number;
	checksum: string;
}
export interface IndexedSession {
	sessionId: string;
	locator: { repo: string; stateRoot: string };
	endpointGeneration: number;
	pid: number;
	/** OS start incarnation of `pid` as published by its own host at registration. */
	processIncarnation?: string;
	endpointMtimeMs?: number;
	live: boolean;
	indexSeq: number;
	lifecycleRequestId?: string;
	terminalUncertain?: boolean;
	hostIncarnation?: string;
	identityProvenance: SessionIdentityProvenance;
	activity?: SessionActivity;
	/** Wall-clock timestamp of the latest admitted heartbeat, when one exists. */
	lastHeartbeatAt?: number;
	/** True when the same sessionId maps to more than one stateRoot (cross-repo duplicate). */
	ambiguous: boolean;
	/** True when the identity's latest event is host_unregistered or session_closed (DR-1: stopped rows are retained). */
	terminal: boolean;
}
export interface SessionList {
	indexSeq: number;
	sessions: IndexedSession[];
	warnings: string[];
}

export interface SessionIndexDiagnosis {
	status: "healthy" | "corrupt" | "unsupported";
	validPrefixSeq: number;
	snapshotSeq: number;
	reason?: string;
}

export interface SessionIndexRepairResult extends SessionIndexDiagnosis {
	repaired: boolean;
	quarantinePath?: string;
}

interface SessionIndexScan {
	diagnosis: SessionIndexDiagnosis;
	snapshotEvents: SessionIndexEvent[];
	validLogEvents: SessionIndexEvent[];
	snapshotContents: Buffer | undefined;
	logContents: Buffer | undefined;
	unsupportedError?: UnsupportedStateVersionError;
}

/** Admission-fence rejection codes recorded in the durable index audit (C5/C4). */
export type SessionIndexAuditCode = "rejected_superseded_incarnation" | "rejected_after_tombstone";
export interface SessionIndexAuditRecord {
	version: typeof SDK_STATE_VERSION;
	code: SessionIndexAuditCode;
	/** indexSeq of the rejected event (unique per record; used for idempotent dedupe). */
	indexSeq: number;
	sessionId: string;
	endpointGeneration: number;
	stateRoot: string;
	hostIncarnation?: string;
	supersededByIncarnation?: string;
	/** indexSeq of the superseding registration, or of the tombstone for post-delete rejections. */
	supersededByIndexSeq: number;
	ts: number;
}

const canonical = (event: Omit<SessionIndexEvent, "checksum">) => JSON.stringify(event);
export const sessionIndexChecksum = (event: Omit<SessionIndexEvent, "checksum">) =>
	createHash("sha256").update(canonical(event)).digest("hex");
const dirFor = (agentDir: string) => path.join(agentDir, "sdk", "sessions");
const logFor = (agentDir: string) => path.join(dirFor(agentDir), "index.jsonl");
const snapshotFor = (agentDir: string) => path.join(dirFor(agentDir), "index.snapshot.json");
const auditFor = (agentDir: string) => path.join(dirFor(agentDir), "index-audit.jsonl");
const ROTATE_BYTES = 4 * 1024 * 1024;
/** Coalesced heartbeat checkpoint rate cap (C2): at most one per session per minute. */
export const SESSION_HEARTBEAT_INTERVAL_MS = 60_000;
export const DEFAULT_SESSION_RETENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_SESSION_RETENTION_MAX_ROWS = 25_000;

/** Identity tuple: (sessionId, generation, stateRoot). Registration authority is per tuple. */
const tupleKey = (event: SessionIndexEvent) =>
	`${event.sessionId}\u0000${event.endpointGeneration}\u0000${event.locator.stateRoot}`;
/** Composite identity (C1): (sessionId, generation, process incarnation, stateRoot). */
const effectiveIncarnation = (event: SessionIndexEvent) => event.hostIncarnation ?? event.processIncarnation;
const identityKey = (event: SessionIndexEvent) => `${tupleKey(event)}\u0000${effectiveIncarnation(event) ?? ""}`;

interface ResolvedRetentionPolicy {
	clock: () => number;
	maxAgeMs: number;
	maxRows: number;
	tombstoneRule: SessionTombstoneRule;
}
const resolvePolicy = (policy: RetentionPolicy): ResolvedRetentionPolicy => ({
	clock: policy.clock ?? Date.now,
	maxAgeMs: policy.maxAgeMs ?? DEFAULT_SESSION_RETENTION_MAX_AGE_MS,
	maxRows: policy.maxRows ?? DEFAULT_SESSION_RETENTION_MAX_ROWS,
	tombstoneRule: policy.tombstoneRule ?? "retain",
});

interface RejectedEvent {
	code: SessionIndexAuditCode;
	event: SessionIndexEvent;
	supersededByIncarnation: string | undefined;
	supersededByIndexSeq: number;
}
interface Admission {
	admitted: SessionIndexEvent[];
	rejected: RejectedEvent[];
}

/**
 * Broker admission fence (C5), applied before reduction over the total order of
 * checksum-chained indexSeq. Rule A: per (sessionId, generation, stateRoot) tuple the
 * latest host_registered event is the incarnation authority; every event of a different
 * incarnation is rejected (`rejected_superseded_incarnation`). This is a whole-log
 * function so replay and snapshot replay re-derive the same admission order
 * (supersession survives compaction). Rule B: after an admitted `session_deleted`
 * tombstone, non-registration events of identities anchored to pre-delete registrations
 * are rejected (`rejected_after_tombstone`), so a deleted session cannot be resurrected
 * by stale old-host events, while registrations after the tombstone lift it.
 */
function admitEvents(events: SessionIndexEvent[]): Admission {
	const authoritative = new Map<string, { incarnation: string | undefined; indexSeq: number }>();
	for (const event of events) {
		if (event.type !== "host_registered") continue;
		const key = tupleKey(event);
		const current = authoritative.get(key);
		if (current === undefined || event.indexSeq > current.indexSeq) {
			authoritative.set(key, { incarnation: event.hostIncarnation, indexSeq: event.indexSeq });
		}
	}
	const admitted: SessionIndexEvent[] = [];
	const rejected: RejectedEvent[] = [];
	for (const event of events) {
		const authority = authoritative.get(tupleKey(event));
		if (
			authority !== undefined &&
			authority.incarnation !== undefined &&
			event.hostIncarnation !== undefined &&
			event.hostIncarnation !== authority.incarnation
		) {
			rejected.push({
				code: "rejected_superseded_incarnation",
				event,
				supersededByIncarnation: authority.incarnation,
				supersededByIndexSeq: authority.indexSeq,
			});
			continue;
		}
		admitted.push(event);
	}
	const tombstoneSeq = new Map<string, number>();
	for (const event of admitted) {
		if (event.type !== "session_deleted") continue;
		const previous = tombstoneSeq.get(event.sessionId);
		if (previous === undefined || event.indexSeq > previous) tombstoneSeq.set(event.sessionId, event.indexSeq);
	}
	if (tombstoneSeq.size === 0) return { admitted, rejected };
	const anchorSeqByIdentity = new Map<string, number>();
	const postTombstone: SessionIndexEvent[] = [];
	for (const event of admitted) {
		const key = identityKey(event);
		const tombstone = tombstoneSeq.get(event.sessionId);
		if (event.type === "host_registered") anchorSeqByIdentity.set(key, event.indexSeq);
		if (tombstone === undefined || event.indexSeq <= tombstone) {
			postTombstone.push(event);
			continue;
		}
		if (event.type === "host_registered") {
			postTombstone.push(event);
			continue;
		}
		const anchor = anchorSeqByIdentity.get(key);
		if (anchor === undefined || anchor <= tombstone) {
			rejected.push({
				code: "rejected_after_tombstone",
				event,
				supersededByIncarnation: undefined,
				supersededByIndexSeq: tombstone,
			});
			continue;
		}
		postTombstone.push(event);
	}
	return { admitted: postTombstone, rejected };
}

/** Pure rejection ledger derived from the event stream (C5 audit, idempotent by indexSeq). */
function auditRecords(events: SessionIndexEvent[], ts: number): SessionIndexAuditRecord[] {
	const { rejected } = admitEvents(events);
	return rejected.map(rejection => ({
		version: SDK_STATE_VERSION,
		code: rejection.code,
		indexSeq: rejection.event.indexSeq,
		sessionId: rejection.event.sessionId,
		endpointGeneration: rejection.event.endpointGeneration,
		stateRoot: rejection.event.locator.stateRoot,
		...(rejection.event.hostIncarnation !== undefined ? { hostIncarnation: rejection.event.hostIncarnation } : {}),
		...(rejection.supersededByIncarnation !== undefined
			? { supersededByIncarnation: rejection.supersededByIncarnation }
			: {}),
		supersededByIndexSeq: rejection.supersededByIndexSeq,
		ts,
	}));
}

/**
 * Total-order projection (C5/C6): operate only on admitted events keyed by composite
 * identity; the cross-identity winner per sessionId is the admitted event with the
 * highest (generation, indexSeq); only `session_deleted` hides a row (DR-1 retains
 * stopped/terminal credential-free rows so inspect/offline tail can work). Heartbeats
 * inherit locator/endpoint metadata from their identity's prior event. Liveness (C2)
 * requires a heartbeat observed within 2x the checkpoint interval AND a live host:
 * a missing heartbeat (e.g. after a broker restart) is unknown, never fresh forever.
 */
function reduceEvents(events: SessionIndexEvent[], now: number): IndexedSession[] {
	const { admitted } = admitEvents(events);
	const latestByIdentity = new Map<string, SessionIndexEvent>();
	const latestHeartbeatByIdentity = new Map<string, SessionIndexEvent>();
	for (const event of admitted) {
		const key = identityKey(event);
		if (event.type === "host_heartbeat") {
			latestHeartbeatByIdentity.set(key, event);
			continue;
		}
		const previous = latestByIdentity.get(key);
		if (previous === undefined || event.indexSeq > previous.indexSeq) latestByIdentity.set(key, event);
	}
	const winner = new Map<string, { gen: number; seq: number; identity: string }>();
	const roots = new Map<string, Set<string>>();
	for (const event of admitted) {
		let group = roots.get(event.sessionId);
		if (group === undefined) {
			group = new Set();
			roots.set(event.sessionId, group);
		}
		group.add(event.locator.stateRoot);
		if (event.type === "host_heartbeat") continue;
		const current = winner.get(event.sessionId);
		if (
			current === undefined ||
			event.endpointGeneration > current.gen ||
			(event.endpointGeneration === current.gen && event.indexSeq > current.seq)
		) {
			winner.set(event.sessionId, {
				gen: event.endpointGeneration,
				seq: event.indexSeq,
				identity: identityKey(event),
			});
		}
	}
	const sessions: IndexedSession[] = [];
	for (const [sessionId, chosen] of winner) {
		const latest = latestByIdentity.get(chosen.identity);
		if (latest === undefined) continue;
		const terminal = latest.type === "host_unregistered" || latest.type === "session_closed";
		if (latest.type === "session_deleted") continue;
		const heartbeat = latestHeartbeatByIdentity.get(chosen.identity);
		const pidAlive = alive(latest.pid);
		const heartbeatFresh = heartbeat !== undefined && now - heartbeat.ts < 2 * SESSION_HEARTBEAT_INTERVAL_MS;
		const recordedIncarnation = effectiveIncarnation(latest);
		const currentIncarnation = recordedIncarnation === undefined ? undefined : processIncarnation(latest.pid);
		const incarnationMatches = currentIncarnation !== undefined && currentIncarnation === recordedIncarnation;
		sessions.push({
			sessionId,
			locator: latest.locator,
			endpointGeneration: latest.endpointGeneration,
			pid: latest.pid,
			processIncarnation: latest.processIncarnation,
			endpointMtimeMs: latest.endpointMtimeMs,
			lifecycleRequestId: latest.lifecycleRequestId,
			terminalUncertain: latest.type === "lifecycle_terminal" || latest.terminalUncertain === true,
			indexSeq: latest.indexSeq,
			hostIncarnation: latest.hostIncarnation,
			identityProvenance: recordedIncarnation === undefined ? "legacy" : "composite",
			activity: heartbeat?.activity,
			lastHeartbeatAt: heartbeat?.ts,
			ambiguous: (roots.get(sessionId)?.size ?? 0) > 1,
			terminal,
			live: !terminal && pidAlive && heartbeatFresh && incarnationMatches,
		});
	}
	return sessions;
}

// Global launch bursts may queue behind legitimate long index transactions. Keep
// this bounded at one minute while the shared lock's exact dead-owner recovery runs.
const SESSION_INDEX_LOCK_OPTIONS = { retries: 600, retryDelayMs: 100 } as const;

function withSessionIndexLock<T>(agentDir: string, callback: () => Promise<T>): Promise<T> {
	return withFileLock(logFor(agentDir), callback, SESSION_INDEX_LOCK_OPTIONS);
}
function isValidSnapshot(snapshot: unknown): snapshot is { indexSeq: number; events: SessionIndexEvent[] } {
	if (!snapshot || typeof snapshot !== "object") return false;
	const { indexSeq, events } = snapshot as { indexSeq?: unknown; events?: unknown };
	if (typeof indexSeq !== "number" || !Number.isSafeInteger(indexSeq) || indexSeq < 0) return false;
	if (!Array.isArray(events)) return false;
	if (events.length === 0) return indexSeq === 0;
	// Accept strictly-increasing indexSeq (gaps allowed after compaction), preserving
	// each event's original checksum. The old contiguous 1..N format is a special case.
	let previous = 0;
	for (const event of events) {
		if (!event || typeof event !== "object") return false;
		const { checksum, ...unsigned } = event as SessionIndexEvent;
		if (typeof event.indexSeq !== "number" || !Number.isSafeInteger(event.indexSeq)) return false;
		if (event.indexSeq <= previous) return false;
		if (checksum !== sessionIndexChecksum(unsigned)) return false;
		previous = event.indexSeq;
	}
	return previous === indexSeq;
}

/**
 * Compact the event history for a snapshot without renumbering: clients hold indexSeq
 * across calls, so retained events keep their original indexSeq and checksum. Stopped
 * and terminal identities are retained (DR-1: only `session_deleted` hides a row), so
 * inspect/offline tail keep working across compaction; superseded heartbeats collapse
 * to the latest per surviving composite identity, the global-max indexSeq always stays
 * as the chain anchor, then the injected retention policy applies per session
 * (whole-session eviction keeps the projection deterministic: a dropped session
 * contributes no events to re-derive). Tombstone rule "retain" exempts deleted sessions
 * from age/row eviction (C4 audit evidence retained); "expire" evicts them like any
 * other session.
 */
function compactEvents(events: SessionIndexEvent[], policy: ResolvedRetentionPolicy): SessionIndexEvent[] {
	if (events.length === 0) return events;
	const maxIndexSeq = events[events.length - 1]!.indexSeq;
	const latestByIdentity = new Map<string, SessionIndexEvent>();
	const latestHeartbeatByIdentity = new Map<string, number>();
	for (const event of events) {
		const key = identityKey(event);
		const previous = latestByIdentity.get(key);
		if (previous === undefined || event.indexSeq > previous.indexSeq) latestByIdentity.set(key, event);
		if (event.type === "host_heartbeat") {
			const current = latestHeartbeatByIdentity.get(key);
			if (current === undefined || event.indexSeq > current) latestHeartbeatByIdentity.set(key, event.indexSeq);
		}
	}
	const now = policy.clock();
	const sessionLatest = new Map<string, SessionIndexEvent>();
	for (const event of events) {
		const previous = sessionLatest.get(event.sessionId);
		if (previous === undefined || event.indexSeq > previous.indexSeq) sessionLatest.set(event.sessionId, event);
	}
	const expiredSessions = new Set<string>();
	for (const [sessionId, latest] of sessionLatest) {
		if (latest.indexSeq === maxIndexSeq) continue;
		const deleted = latest.type === "session_deleted";
		if (policy.tombstoneRule === "retain" && deleted) continue;
		if (latest.ts < now - policy.maxAgeMs) expiredSessions.add(sessionId);
	}
	const kept: SessionIndexEvent[] = [];
	for (const event of events) {
		if (event.indexSeq === maxIndexSeq) {
			kept.push(event);
			continue;
		}
		if (event.type === "host_heartbeat" && latestHeartbeatByIdentity.get(identityKey(event)) !== event.indexSeq)
			continue;
		if (expiredSessions.has(event.sessionId)) continue;
		kept.push(event);
	}
	if (policy.maxRows >= 1 && kept.length > policy.maxRows) {
		const keptLatest = new Map<string, SessionIndexEvent>();
		for (const event of kept) {
			const previous = keptLatest.get(event.sessionId);
			if (previous === undefined || event.indexSeq > previous.indexSeq) keptLatest.set(event.sessionId, event);
		}
		const anchorSession = kept.find(event => event.indexSeq === maxIndexSeq)?.sessionId;
		const candidates = [...keptLatest.entries()]
			.filter(([sessionId]) => sessionId !== anchorSession)
			.filter(([, latest]) => !(policy.tombstoneRule === "retain" && latest.type === "session_deleted"))
			.sort((a, b) => a[1].indexSeq - b[1].indexSeq);
		let result = kept;
		for (const [sessionId] of candidates) {
			if (result.length <= policy.maxRows) break;
			result = result.filter(event => event.sessionId !== sessionId);
		}
		return result;
	}
	return kept;
}

async function appendSync(file: string, value: string): Promise<void> {
	const h = await fs.open(file, "a", 0o600);
	let failure: { error: unknown } | undefined;
	try {
		const data = Buffer.from(`${value}\n`);
		for (let offset = 0; offset < data.length; ) {
			const { bytesWritten } = await h.write(data, offset, data.length - offset);
			if (bytesWritten <= 0) throw new Error("Unable to append session index entry");
			offset += bytesWritten;
		}
		await h.sync();
	} catch (error) {
		failure = { error };
	}
	try {
		await h.close();
	} catch (error) {
		// Bun may report EBADF when concurrent child-pipe teardown has already
		// released a fully written and fsynced append handle. The descriptor is
		// closed in that case; every other close failure remains fatal.
		if ((error as NodeJS.ErrnoException).code !== "EBADF" && failure === undefined) failure = { error };
	}
	if (failure !== undefined) throw failure.error;
}

async function syncDirectory(file: string): Promise<void> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(path.dirname(file), "r");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) return;
		throw error;
	}
	try {
		await handle.sync();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES")) throw error;
	} finally {
		await handle.close();
	}
}

async function writeAndSync(file: string, contents: Buffer | string): Promise<void> {
	const handle = await fs.open(file, "w", 0o600);
	try {
		await handle.writeFile(contents);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function replaceAtomically(file: string, contents: Buffer | string): Promise<void> {
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeAndSync(temporary, contents);
		await fs.rename(temporary, file);
		await syncDirectory(file);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

interface SessionIndexOpenGroup {
	promise: Promise<void>;
	closed: boolean;
}
export class SessionIndex {
	static #operations = new Map<string, Promise<void>>();
	static #openGroups = new Map<string, SessionIndexOpenGroup>();
	#agentDir: string;
	#policy: ResolvedRetentionPolicy;
	#events: SessionIndexEvent[] = [];
	#warnings: string[] = [];
	#logOffset = 0;
	#corruptSuffix = false;
	/** indexSeqs already recorded in the durable audit; null until lazily seeded. */
	#auditedSeq: Set<number> | null = null;
	constructor(agentDir: string, policy: RetentionPolicy = {}) {
		this.#agentDir = agentDir;
		this.#policy = resolvePolicy(policy);
	}
	static #enqueue<T>(indexPath: string, operation: () => Promise<T>): Promise<T> {
		const previous = SessionIndex.#operations.get(indexPath) ?? Promise.resolve();
		const promise = previous.catch(() => {}).then(operation);
		const completion = promise.then(
			() => {},
			() => {},
		);
		SessionIndex.#operations.set(indexPath, completion);
		void completion.then(() => {
			if (SessionIndex.#operations.get(indexPath) === completion) SessionIndex.#operations.delete(indexPath);
		});
		return promise;
	}
	async open(): Promise<this> {
		const indexPath = path.resolve(logFor(this.#agentDir));
		let group = SessionIndex.#openGroups.get(indexPath);
		if (!group || group.closed) {
			group = { promise: Promise.resolve(), closed: false };
			SessionIndex.#openGroups.set(indexPath, group);
			group.promise = SessionIndex.#enqueue(indexPath, () => this.#prepareOpenGroup(indexPath, group!));
		}
		await group.promise;
		await SessionIndex.#enqueue(indexPath, () => withSessionIndexLock(this.#agentDir, () => this.#replayUnderLock()));
		return this;
	}
	async #prepareOpenGroup(indexPath: string, group: SessionIndexOpenGroup): Promise<void> {
		try {
			await fs.mkdir(dirFor(this.#agentDir), { recursive: true, mode: 0o700 });
			await fs.chmod(dirFor(this.#agentDir), 0o700);
		} finally {
			group.closed = true;
			if (SessionIndex.#openGroups.get(indexPath) === group) SessionIndex.#openGroups.delete(indexPath);
		}
	}
	async replay(): Promise<void> {
		const indexPath = path.resolve(logFor(this.#agentDir));
		await SessionIndex.#enqueue(indexPath, () => withSessionIndexLock(this.#agentDir, () => this.#replayUnderLock()));
	}
	async #replayUnderLock(): Promise<void> {
		const scan = await this.#scan();
		if (scan.diagnosis.status === "unsupported") throw scan.unsupportedError!;
		this.#events = [...scan.snapshotEvents, ...scan.validLogEvents];
		this.#warnings = [];
		this.#logOffset = scan.logContents?.length ?? 0;
		this.#corruptSuffix = scan.diagnosis.status === "corrupt";
		if (scan.diagnosis.reason === "invalid snapshot") this.#warnings.push("Invalid session index snapshot");
		if (this.#corruptSuffix) this.#warnings.push("Corrupt session index entry; replay truncated");
		await this.#writeAuditUnderLock();
	}
	/** Seed the audit dedupe set once, then append records for newly-rejected events. */
	async #writeAuditUnderLock(): Promise<void> {
		if (this.#auditedSeq === null) {
			this.#auditedSeq = new Set();
			try {
				const contents = await fs.readFile(auditFor(this.#agentDir), "utf8");
				for (const line of contents.split("\n")) {
					if (!line) continue;
					try {
						const record = JSON.parse(line) as Partial<SessionIndexAuditRecord>;
						if (typeof record.indexSeq === "number") this.#auditedSeq.add(record.indexSeq);
					} catch {
						// Best-effort dedupe seed; a corrupt audit row never blocks the index.
					}
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		const pending = auditRecords(this.#events, this.#policy.clock()).filter(
			record => !this.#auditedSeq!.has(record.indexSeq),
		);
		if (pending.length === 0) return;
		await appendSync(auditFor(this.#agentDir), pending.map(record => JSON.stringify(record)).join("\n"));
		for (const record of pending) this.#auditedSeq.add(record.indexSeq);
	}
	async #scan(): Promise<SessionIndexScan> {
		let snapshotContents: Buffer | undefined;
		let logContents: Buffer | undefined;
		let snapshotEvents: SessionIndexEvent[] = [];
		let snapshotSeq = 0;
		let trustedSnapshotSeq = 0;
		let invalidSnapshot = false;
		let unsupportedError: UnsupportedStateVersionError | undefined;
		try {
			snapshotContents = await fs.readFile(snapshotFor(this.#agentDir));
			const snapshot = JSON.parse(snapshotContents.toString("utf8")) as {
				version?: number;
				indexSeq?: unknown;
				events?: unknown;
			};
			if (typeof snapshot.indexSeq === "number" && Number.isSafeInteger(snapshot.indexSeq) && snapshot.indexSeq >= 0)
				snapshotSeq = snapshot.indexSeq;
			assertSupportedSnapshotVersion(snapshotFor(this.#agentDir), snapshot);
			const supportedEvents: SessionIndexEvent[] = [];
			if (Array.isArray(snapshot.events)) {
				try {
					for (const event of snapshot.events) {
						assertSupportedStateVersion(snapshotFor(this.#agentDir), event);
						supportedEvents.push(event as SessionIndexEvent);
					}
				} catch (error) {
					if (!(error instanceof UnsupportedStateVersionError)) throw error;
					unsupportedError = error;
					snapshotEvents = supportedEvents;
				}
			}
			if (!unsupportedError) {
				if (!isValidSnapshot(snapshot)) invalidSnapshot = true;
				else {
					snapshotEvents = snapshot.events;
					trustedSnapshotSeq = snapshot.indexSeq;
				}
			}
		} catch (error) {
			if (error instanceof UnsupportedStateVersionError) unsupportedError = error;
			else if ((error as NodeJS.ErrnoException).code !== "ENOENT") invalidSnapshot = true;
		}
		try {
			logContents = await fs.readFile(logFor(this.#agentDir));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const validLogEvents: SessionIndexEvent[] = [];
		let corrupt = invalidSnapshot;
		let logCorrupt = false;
		let tailStarted = false;
		let historicalLast: number | undefined;
		let expected = trustedSnapshotSeq + 1;
		if (logContents) {
			const text = logContents.toString("utf8");
			const lines = text.split("\n");
			const terminal = lines.pop();
			for (const line of lines) {
				if (!line) continue;
				try {
					const event = JSON.parse(line) as SessionIndexEvent;
					assertSupportedStateVersion(logFor(this.#agentDir), event);
					const { checksum, ...unsigned } = event;
					if (checksum !== sessionIndexChecksum(unsigned)) {
						corrupt = true;
						logCorrupt = true;
						continue;
					}
					if (!tailStarted && !invalidSnapshot && event.indexSeq <= trustedSnapshotSeq) {
						if (
							!Number.isSafeInteger(event.indexSeq) ||
							event.indexSeq <= 0 ||
							(historicalLast !== undefined && event.indexSeq !== historicalLast + 1)
						) {
							corrupt = true;
							logCorrupt = true;
						} else {
							historicalLast = event.indexSeq;
						}
						continue;
					}
					tailStarted = true;
					if (historicalLast !== undefined && historicalLast !== trustedSnapshotSeq) {
						corrupt = true;
						logCorrupt = true;
					}
					if (event.indexSeq !== expected) {
						corrupt = true;
						logCorrupt = true;
					} else if (!logCorrupt) {
						validLogEvents.push(event);
						expected++;
					}
				} catch (error) {
					if (error instanceof UnsupportedStateVersionError) {
						const verifiedSnapshotPrefix = snapshotEvents.at(-1)?.indexSeq ?? trustedSnapshotSeq;
						const validPrefixSeq = validLogEvents.at(-1)?.indexSeq ?? verifiedSnapshotPrefix;
						return {
							diagnosis: { status: "unsupported", validPrefixSeq, snapshotSeq, reason: error.message },
							snapshotEvents,
							validLogEvents,
							snapshotContents,
							logContents,
							unsupportedError: error,
						};
					}
					corrupt = true;
					logCorrupt = true;
				}
			}
			if (historicalLast !== undefined && !tailStarted && historicalLast !== trustedSnapshotSeq) {
				corrupt = true;
				logCorrupt = true;
			}
			if (terminal !== "") {
				corrupt = true;
				logCorrupt = true;
			}
		}
		const verifiedSnapshotPrefix = snapshotEvents.at(-1)?.indexSeq ?? trustedSnapshotSeq;
		const validPrefixSeq = validLogEvents.at(-1)?.indexSeq ?? verifiedSnapshotPrefix;
		return {
			diagnosis: {
				status: unsupportedError ? "unsupported" : corrupt ? "corrupt" : "healthy",
				validPrefixSeq,
				snapshotSeq,
				reason:
					unsupportedError?.message ??
					(invalidSnapshot ? "invalid snapshot" : corrupt ? "invalid log sequence" : undefined),
			},
			snapshotEvents,
			validLogEvents,
			snapshotContents,
			logContents,
			unsupportedError,
		};
	}
	async diagnose(): Promise<SessionIndexDiagnosis> {
		const indexPath = path.resolve(logFor(this.#agentDir));
		return await SessionIndex.#enqueue(indexPath, async () => {
			const exists = await Promise.all(
				[snapshotFor(this.#agentDir), logFor(this.#agentDir)].map(async file => {
					try {
						await fs.stat(file);
						return true;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
						throw error;
					}
				}),
			);
			if (!exists.some(Boolean)) return { status: "healthy", validPrefixSeq: 0, snapshotSeq: 0 };
			return await withSessionIndexLock(this.#agentDir, async () => (await this.#scan()).diagnosis);
		});
	}
	async repair(): Promise<SessionIndexRepairResult> {
		const indexPath = path.resolve(logFor(this.#agentDir));
		return await SessionIndex.#enqueue(indexPath, async () => {
			await fs.mkdir(dirFor(this.#agentDir), { recursive: true, mode: 0o700 });
			return await withSessionIndexLock(this.#agentDir, async () => {
				const scan = await this.#scan();
				if (scan.diagnosis.status === "unsupported") return { ...scan.diagnosis, repaired: false };
				if (scan.diagnosis.status === "healthy") return { ...scan.diagnosis, repaired: false };
				const quarantineBase = path.join(dirFor(this.#agentDir), "quarantine");
				await fs.mkdir(quarantineBase, { recursive: true, mode: 0o700 });
				await syncDirectory(quarantineBase);
				const quarantinePath = path.join(quarantineBase, `repair-${Date.now()}-${process.pid}-${randomUUID()}`);
				await fs.mkdir(quarantinePath, { mode: 0o700 });
				await syncDirectory(quarantinePath);
				if (scan.snapshotContents)
					await writeAndSync(path.join(quarantinePath, "index.snapshot.json"), scan.snapshotContents);
				if (scan.logContents) await writeAndSync(path.join(quarantinePath, "index.jsonl"), scan.logContents);
				await syncDirectory(path.join(quarantinePath, "index.jsonl"));
				const events = [...scan.snapshotEvents, ...scan.validLogEvents];
				const snapshot = JSON.stringify({
					version: SESSION_INDEX_SNAPSHOT_VERSION,
					indexSeq: scan.diagnosis.validPrefixSeq,
					events,
				});
				const log = scan.validLogEvents.map(event => JSON.stringify(event)).join("\n");
				await replaceAtomically(snapshotFor(this.#agentDir), snapshot);
				await replaceAtomically(logFor(this.#agentDir), log ? `${log}\n` : "");
				await this.#replayUnderLock();
				return { ...scan.diagnosis, repaired: true, quarantinePath };
			});
		});
	}
	async #tailUnderLock(snapshotSeq = this.indexSeq, allowResync = true): Promise<void> {
		let data: Buffer;
		try {
			const handle = await fs.open(logFor(this.#agentDir), "r");
			try {
				const stat = await handle.stat();
				if (stat.size < this.#logOffset) {
					if (allowResync) await this.#replayUnderLock();
					else this.#warn("Session index log was truncated");
					return;
				}
				data = Buffer.alloc(stat.size - this.#logOffset);
				if (data.length) await handle.read(data, 0, data.length, this.#logOffset);
			} finally {
				await handle.close();
			}
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
			throw e;
		}
		const lastNewline = data.lastIndexOf(0x0a);
		const consumed = data.subarray(0, lastNewline + 1);
		this.#logOffset += consumed.length;
		const hasUnterminatedSuffix = data.length > consumed.length;
		let corrupt = false;
		for (const line of consumed.toString("utf8").split("\n")) {
			if (!line) continue;
			let event: SessionIndexEvent;
			try {
				event = JSON.parse(line) as SessionIndexEvent;
				assertSupportedStateVersion(logFor(this.#agentDir), event);
			} catch (error) {
				if (error instanceof UnsupportedStateVersionError) throw error;
				corrupt = true;
				continue;
			}
			if (corrupt || event.indexSeq <= snapshotSeq) continue;
			const { checksum, ...unsigned } = event;
			if (checksum !== sessionIndexChecksum(unsigned) || event.indexSeq !== this.indexSeq + 1) corrupt = true;
			else this.#events.push(event);
		}
		if (hasUnterminatedSuffix) corrupt = true;
		if (corrupt) {
			this.#corruptSuffix = true;
			this.#warn("Corrupt session index entry; replay truncated");
			if (allowResync) await this.#replayUnderLock();
		}
	}
	#warn(message: string): void {
		if (!this.#warnings.includes(message)) this.#warnings.push(message);
	}

	async refresh(): Promise<void> {
		const indexPath = path.resolve(logFor(this.#agentDir));
		await SessionIndex.#enqueue(indexPath, () =>
			withSessionIndexLock(this.#agentDir, () => this.#refreshUnderLock()),
		);
	}
	async #refreshUnderLock(): Promise<void> {
		await this.#tailUnderLock();
		await this.#writeAuditUnderLock();
	}
	get indexSeq(): number {
		return this.#events.at(-1)?.indexSeq ?? 0;
	}
	async append(
		input: Omit<SessionIndexEvent, "version" | "indexSeq" | "checksum" | "ts"> &
			Partial<Pick<SessionIndexEvent, "ts">>,
	): Promise<SessionIndexEvent> {
		const indexPath = path.resolve(logFor(this.#agentDir));
		return await SessionIndex.#enqueue(indexPath, async () => {
			await fs.mkdir(dirFor(this.#agentDir), { recursive: true, mode: 0o700 });
			return await withSessionIndexLock(this.#agentDir, async () => {
				await this.#replayUnderLock();
				if (this.#corruptSuffix)
					throw new Error(
						"Cannot append to corrupt session index log; run `gjc gc --repair-session-index` to quarantine evidence and retain the valid prefix",
					);
				const unsigned: Omit<SessionIndexEvent, "checksum"> = {
					...input,
					version: SDK_STATE_VERSION,
					indexSeq: this.indexSeq + 1,
					ts: input.ts ?? Date.now(),
				};
				// Use the registration's durable process identity when supplied; otherwise
				// derive one from the OS. Legacy records remain explicitly unbound.
				if (unsigned.hostIncarnation === undefined && Number.isSafeInteger(unsigned.pid) && unsigned.pid > 0) {
					unsigned.hostIncarnation = unsigned.processIncarnation ?? processIncarnation(unsigned.pid);
				}
				const event: SessionIndexEvent = { ...unsigned, checksum: sessionIndexChecksum(unsigned) };
				await appendSync(logFor(this.#agentDir), JSON.stringify(event));
				await this.#refreshUnderLock();
				if ((await fs.stat(logFor(this.#agentDir))).size >= ROTATE_BYTES) await this.#rotate();
				return event;
			});
		});
	}

	/** Hold the canonical index lock across an authority-sensitive operation. */
	async withLocked<T>(callback: () => Promise<T>): Promise<T> {
		const indexPath = path.resolve(logFor(this.#agentDir));
		return await SessionIndex.#enqueue(indexPath, async () => {
			try {
				await fs.stat(dirFor(this.#agentDir));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return await callback();
				throw error;
			}
			return await withSessionIndexLock(this.#agentDir, async () => {
				await this.#replayUnderLock();
				if (this.#corruptSuffix) throw new Error("Cannot use corrupt session index for artifact reclamation");
				return await callback();
			});
		});
	}
	async snapshot(): Promise<void> {
		const indexPath = path.resolve(logFor(this.#agentDir));
		await SessionIndex.#enqueue(indexPath, () =>
			withSessionIndexLock(this.#agentDir, () => this.#snapshotUnderLock()),
		);
	}
	async #snapshotUnderLock(): Promise<void> {
		await this.#replayUnderLock();
		const file = snapshotFor(this.#agentDir);
		let current: unknown;
		try {
			current = JSON.parse(await fs.readFile(file, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
		}
		if (isValidSnapshot(current) && current.indexSeq > this.indexSeq) return;
		const tmp = `${file}.${process.pid}.tmp`;
		await fs.writeFile(
			tmp,
			JSON.stringify({
				version: SESSION_INDEX_SNAPSHOT_VERSION,
				indexSeq: this.indexSeq,
				events: compactEvents(this.#events, this.#policy),
			}),
			{
				mode: 0o600,
			},
		);
		const h = await fs.open(tmp, "r");
		try {
			await h.sync();
		} finally {
			await h.close();
		}
		await fs.rename(tmp, file);
		await syncDirectory(file);
	}
	/**
	 * Broker-scheduled compaction (C3), independent of rotation size: applies the
	 * injected retention policy to a fresh snapshot and truncates the log.
	 */
	async compact(): Promise<void> {
		const indexPath = path.resolve(logFor(this.#agentDir));
		await SessionIndex.#enqueue(indexPath, () =>
			withFileLock(logFor(this.#agentDir), async () => {
				await this.#replayUnderLock();
				await this.#rotate();
			}),
		);
	}
	async #rotate(): Promise<void> {
		await this.#snapshotUnderLock();
		const file = logFor(this.#agentDir);
		const temporary = `${file}.${process.pid}.tmp`;
		await fs.writeFile(temporary, "", { mode: 0o600 });
		await fs.rename(temporary, file);
		await syncDirectory(file);
		this.#logOffset = 0;
	}

	listSessions(): SessionList {
		return {
			indexSeq: this.indexSeq,
			sessions: reduceEvents(this.#events, this.#policy.clock()),
			warnings: this.#warnings,
		};
	}

	/**
	 * Production coalesced heartbeat checkpoint pass (C2): appends one
	 * `host_heartbeat` per session at most once per {@link SESSION_HEARTBEAT_INTERVAL_MS}.
	 * The pass observes liveness the same way the projection does — the host process
	 * must be alive and, for composite identities, still carry the recorded OS process
	 * incarnation (a reused PID is never checkpointed). Stopped/terminal rows and rows
	 * whose heartbeat is still fresh are skipped. After a broker restart, sessions whose
	 * host survived are re-observed as live on the first pass; sessions whose host died
	 * while the broker was down keep their stale or missing heartbeat and read as
	 * unknown/not-live (never fresh forever). Returns the number of checkpoints written.
	 */
	async checkpointLiveHeartbeats(now = Date.now()): Promise<number> {
		const indexPath = path.resolve(logFor(this.#agentDir));
		return await SessionIndex.#enqueue(indexPath, async () => {
			await fs.mkdir(dirFor(this.#agentDir), { recursive: true, mode: 0o700 });
			return await withFileLock(logFor(this.#agentDir), async () => {
				await this.#replayUnderLock();
				if (this.#corruptSuffix) return 0;
				const events: SessionIndexEvent[] = [];
				const rows = reduceEvents(this.#events, now);
				for (const row of rows) {
					if (row.terminal) continue;
					if (row.lastHeartbeatAt !== undefined && now - row.lastHeartbeatAt < SESSION_HEARTBEAT_INTERVAL_MS)
						continue;
					if (!alive(row.pid)) continue;
					const recordedIncarnation = row.hostIncarnation ?? row.processIncarnation;
					if (recordedIncarnation === undefined) continue;
					const current = processIncarnation(row.pid);
					if (current === undefined || current !== recordedIncarnation) continue;
					const unsigned: Omit<SessionIndexEvent, "checksum"> = {
						version: SDK_STATE_VERSION,
						indexSeq: this.indexSeq + events.length + 1,
						type: "host_heartbeat",
						sessionId: row.sessionId,
						locator: row.locator,
						endpointGeneration: row.endpointGeneration,
						pid: row.pid,
						...(row.processIncarnation === undefined ? {} : { processIncarnation: row.processIncarnation }),
						...(row.hostIncarnation === undefined ? {} : { hostIncarnation: row.hostIncarnation }),
						activity: { state: "active", at: now },
						ts: now,
					};
					events.push({ ...unsigned, checksum: sessionIndexChecksum(unsigned) });
				}
				if (events.length === 0) return 0;
				for (const event of events) await appendSync(logFor(this.#agentDir), JSON.stringify(event));
				await this.#refreshUnderLock();
				if ((await fs.stat(logFor(this.#agentDir))).size >= ROTATE_BYTES) await this.#rotate();
				return events.length;
			});
		});
	}

	hostUnregisteredAfter(
		registration: Pick<
			IndexedSession,
			"sessionId" | "endpointGeneration" | "pid" | "indexSeq" | "lifecycleRequestId"
		>,
	): { indexSeq: number; lifecycleRequestId?: string } | undefined {
		const lifecycleRequestId = registration.lifecycleRequestId;
		const event = this.#events.findLast(
			item =>
				item.type === "host_unregistered" &&
				item.indexSeq > registration.indexSeq &&
				item.sessionId === registration.sessionId &&
				item.endpointGeneration === registration.endpointGeneration &&
				item.pid === registration.pid &&
				(lifecycleRequestId === undefined || item.lifecycleRequestId === lifecycleRequestId),
		);
		return event
			? {
					indexSeq: event.indexSeq,
					...(lifecycleRequestId ? { lifecycleRequestId } : {}),
				}
			: undefined;
	}

	findHostRegistration(
		sessionId: string,
		endpointGeneration: number,
		pid: number,
		lifecycleRequestId?: string,
	): IndexedSession | undefined {
		const event = this.#events.findLast(
			item =>
				item.type === "host_registered" &&
				item.sessionId === sessionId &&
				item.endpointGeneration === endpointGeneration &&
				item.pid === pid &&
				(lifecycleRequestId === undefined || item.lifecycleRequestId === lifecycleRequestId),
		);
		return event
			? {
					sessionId: event.sessionId,
					locator: event.locator,
					endpointGeneration: event.endpointGeneration,
					pid: event.pid,
					processIncarnation: event.processIncarnation,
					endpointMtimeMs: event.endpointMtimeMs,
					lifecycleRequestId: event.lifecycleRequestId,
					terminalUncertain: false,
					indexSeq: event.indexSeq,
					hostIncarnation: event.hostIncarnation,
					identityProvenance: event.hostIncarnation === undefined ? "legacy" : "composite",
					ambiguous: false,
					live: alive(event.pid),
					terminal: false,
				}
			: undefined;
	}

	hasHostRegistrationForLifecycle(sessionId: string, pid: number, lifecycleRequestId: string): boolean {
		return this.#events.some(
			event =>
				event.type === "host_registered" &&
				event.sessionId === sessionId &&
				event.pid === pid &&
				event.lifecycleRequestId === lifecycleRequestId,
		);
	}
}
