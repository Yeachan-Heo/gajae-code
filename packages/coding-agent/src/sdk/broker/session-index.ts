import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { logger, resolveEquivalentPath } from "@gajae-code/utils";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import { withFileLock } from "../../config/file-lock";
import { repo } from "../../utils/git";
import { processIncarnation } from "./process-incarnation";
import {
	assertSupportedSessionIndexEventVersion,
	assertSupportedSnapshotVersion,
	SDK_STATE_VERSION,
	SESSION_INDEX_EVENT_VERSION,
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
export interface SessionIndexObservationDeps {
	/** Test seam for an exact retained process-identity observation. */
	retainProcess?: (
		pid: number,
	) => SessionIndexProcessObservation | undefined | Promise<SessionIndexProcessObservation | undefined>;
}
export interface SessionIndexProcessObservation {
	readonly incarnation: string;
	readonly isRunning: () => boolean;
}
/**
 * Canonical location facts for one SDK session.
 *
 * `cwd` is always a realpath-canonicalized directory. `worktreeRoot` is the
 * canonical Git worktree root when `cwd` is in a worktree, otherwise `null`.
 * `stateRoot` retains its host-provided authority spelling and is never derived
 * from either canonical path.
 */
export type SessionLocatorV2 = {
	cwd: string;
	worktreeRoot: string | null;
	stateRoot: string;
};

/** Durable master-role facts. `attestationEpoch` is opaque random broker state. */
export type MasterRoleAttestationV2 = {
	version: 2;
	ownerSessionId: string;
	launchPid: number;
	launchProcessIncarnation: string;
	role: "master";
	attestationEpoch: string;
};

export function newMasterAttestationEpoch(): string {
	return randomBytes(32).toString("base64url");
}

/** Canonicalize a cwd without making an unavailable path a launch failure. */
export async function canonicalSessionCwd(cwd: string): Promise<string> {
	try {
		return await fs.realpath(cwd);
	} catch {
		return path.resolve(cwd);
	}
}

/** Resolve the canonical worktree root; non-Git and probe failures are `null`. */
export async function sessionWorktreeRoot(cwd: string): Promise<string | null> {
	try {
		const repository = await repo.resolve(cwd);
		return repository ? await canonicalSessionCwd(repository.repoRoot) : null;
	} catch {
		return null;
	}
}

/** Build the only permitted locator shape for a newly registered session. */
export async function resolveSessionLocator(cwd: string, stateRoot: string): Promise<SessionLocatorV2> {
	const canonicalCwd = await canonicalSessionCwd(cwd);
	return { cwd: canonicalCwd, worktreeRoot: await sessionWorktreeRoot(canonicalCwd), stateRoot };
}

function sessionLocatorV2(locator: unknown): locator is SessionLocatorV2 {
	if (typeof locator !== "object" || locator === null || Array.isArray(locator)) return false;
	const keys = Object.keys(locator);
	if (keys.length !== 3 || !keys.every(key => key === "cwd" || key === "worktreeRoot" || key === "stateRoot"))
		return false;
	return (
		typeof (locator as { cwd?: unknown }).cwd === "string" &&
		(locator as { cwd: string }).cwd.length > 0 &&
		(typeof (locator as { worktreeRoot?: unknown }).worktreeRoot === "string" ||
			(locator as { worktreeRoot?: unknown }).worktreeRoot === null) &&
		typeof (locator as { stateRoot?: unknown }).stateRoot === "string" &&
		(locator as { stateRoot: string }).stateRoot.length > 0
	);
}
export interface SessionIndexEvent {
	version: typeof SDK_STATE_VERSION | typeof SESSION_INDEX_EVENT_VERSION;
	indexSeq: number;
	type: SessionIndexEventType;
	sessionId: string;
	locator: SessionLocatorV2;
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
	/** Immutable endpoint file identity captured by the broker at registration. */
	endpointFileId?: string;
	lifecycleRequestId?: string;
	terminalUncertain?: boolean;
	/** OS process incarnation (C1); absent on legacy v1/v2 events. */
	hostIncarnation?: string;
	/** Present on host_heartbeat checkpoints (C2). */
	activity?: SessionActivity;
	masterRole?: MasterRoleAttestationV2;
	ts: number;
	checksum: string;
}
export interface IndexedSession {
	sessionId: string;
	locator: SessionLocatorV2;
	endpointGeneration: number;
	pid: number;
	/** OS start incarnation of `pid` as published by its own host at registration. */
	processIncarnation?: string;
	endpointMtimeMs?: number;
	/** Immutable endpoint file identity captured by the broker at registration. */
	endpointFileId?: string;
	live: boolean;
	indexSeq: number;
	lifecycleRequestId?: string;
	terminalUncertain?: boolean;
	hostIncarnation?: string;
	identityProvenance: SessionIdentityProvenance;
	activity?: SessionActivity;
	/** Wall-clock timestamp of the latest admitted heartbeat, when one exists. */
	lastHeartbeatAt?: number;
	masterRole?: MasterRoleAttestationV2;
	/** True when more than one unresolved authority-fencing state-root identity claims this session id. */
	ambiguous: boolean;
	/** True when the identity's latest event is terminal (DR-1 retains stopped rows for inspection/offline tail). */
	terminal: boolean;
}

/** A session can grant endpoint or lifecycle authority only when one authority-fencing state root claims its id. */
export function isSessionAuthorityEligible(session: Pick<IndexedSession, "ambiguous">): boolean {
	return session.ambiguous !== true;
}
export interface SessionList {
	indexSeq: number;
	sessions: IndexedSession[];
	warnings: string[];
}

export type SessionGenerationIndexStatus =
	| {
			status: "current";
			observedIndexSeq: number;
			evidenceIndexSeq: number;
	  }
	| {
			status: "retired";
			observedIndexSeq: number;
			evidenceIndexSeq: number;
			event: "host_unregistered" | "session_closed" | "session_deleted";
	  }
	| {
			status: "replaced";
			observedIndexSeq: number;
			evidenceIndexSeq: number;
			currentGeneration: number;
	  }
	| {
			status: "unknown";
			observedIndexSeq: number;
			reason:
				| "index_incomplete"
				| "session_not_observed"
				| "generation_not_observed"
				| "generation_reused"
				| "ambiguous_authority"
				| "proof_expired"
				| "reconciliation_incomplete";
	  };

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
export type SessionIndexAuditCode =
	| "rejected_superseded_incarnation"
	| "rejected_after_tombstone"
	| "rejected_legacy_locator";
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
/**
 * Idle-poll change stamp over the two index files (#4689). A polling reader
 * that has already replayed the index must be able to prove "nothing changed"
 * with two stats instead of re-acquiring the machine-global lock and
 * re-parsing the whole log every cycle.
 *
 * Timestamps alone are NOT a durable-equality proof: on a coarse-resolution
 * filesystem a same-size write inside one tick reports identical `mtimeMs` and
 * `ctimeMs` (measured: ~98% of back-to-back same-size rewrites collide on
 * both). The stamp is therefore anchored on the two fields the cooperative
 * writer protocol cannot leave untouched:
 *   - append (`appendSync`) always grows `size`;
 *   - rename-replace (`replaceAtomically`, used for snapshots and rotation)
 *     always installs a new inode, so `ino` changes even when the replacement
 *     has an identical byte length (measured: 0/3000 inode collisions).
 * `mtimeMs`/`ctimeMs` are retained as an extra signal for foreign in-place
 * edits that keep both size and inode, which the writer protocol never does.
 */
interface SessionIndexFileStamp {
	readonly exists: boolean;
	readonly size: number;
	/**
	 * Kept as `bigint` so a 64-bit inode / Windows file id above
	 * `Number.MAX_SAFE_INTEGER` cannot collapse onto another id and make a real
	 * replacement read as unchanged (#4730 review).
	 */
	readonly ino: bigint;
	readonly mtimeMs: number;
	readonly ctimeMs: number;
}
interface SessionIndexChangeStamp {
	readonly log: SessionIndexFileStamp;
	readonly snapshot: SessionIndexFileStamp;
}
async function statIndexFile(file: string): Promise<SessionIndexFileStamp> {
	try {
		const stat = await fs.stat(file, { bigint: true });
		return {
			exists: true,
			size: Number(stat.size),
			ino: stat.ino,
			mtimeMs: Number(stat.mtimeMs),
			ctimeMs: Number(stat.ctimeMs),
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { exists: false, size: 0, ino: 0n, mtimeMs: 0, ctimeMs: 0 };
		throw error;
	}
}
async function readIndexChangeStamp(agentDir: string): Promise<SessionIndexChangeStamp> {
	const [log, snapshot] = await Promise.all([statIndexFile(logFor(agentDir)), statIndexFile(snapshotFor(agentDir))]);
	return { log, snapshot };
}
function sameIndexChangeStamp(a: SessionIndexChangeStamp, b: SessionIndexChangeStamp): boolean {
	return (
		a.log.exists === b.log.exists &&
		a.log.size === b.log.size &&
		a.log.ino === b.log.ino &&
		a.log.mtimeMs === b.log.mtimeMs &&
		a.log.ctimeMs === b.log.ctimeMs &&
		a.snapshot.exists === b.snapshot.exists &&
		a.snapshot.size === b.snapshot.size &&
		a.snapshot.ino === b.snapshot.ino &&
		a.snapshot.mtimeMs === b.snapshot.mtimeMs &&
		a.snapshot.ctimeMs === b.snapshot.ctimeMs
	);
}
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

function hasSessionLocatorV2(event: SessionIndexEvent): boolean {
	return sessionLocatorV2(event.locator);
}

function legacyLocatorDiagnostic(event: SessionIndexEvent): string {
	return `Session ${event.sessionId} has a legacy locator row and must re-register.`;
}

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
	const rejected: RejectedEvent[] = [];
	for (const event of events) {
		if (!hasSessionLocatorV2(event)) {
			rejected.push({
				code: "rejected_legacy_locator",
				event,
				supersededByIncarnation: undefined,
				supersededByIndexSeq: event.indexSeq,
			});
			continue;
		}
		if (event.type !== "host_registered") continue;
		const key = tupleKey(event);
		const current = authoritative.get(key);
		if (current === undefined || event.indexSeq > current.indexSeq) {
			authoritative.set(key, { incarnation: event.hostIncarnation, indexSeq: event.indexSeq });
		}
	}
	const admitted: SessionIndexEvent[] = [];
	for (const event of events) {
		if (!hasSessionLocatorV2(event)) continue;
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
		stateRoot: hasSessionLocatorV2(rejection.event) ? rejection.event.locator.stateRoot : "unknown",
		...(rejection.event.hostIncarnation !== undefined ? { hostIncarnation: rejection.event.hostIncarnation } : {}),
		...(rejection.supersededByIncarnation !== undefined
			? { supersededByIncarnation: rejection.supersededByIncarnation }
			: {}),
		supersededByIndexSeq: rejection.supersededByIndexSeq,
		ts,
	}));
}

interface SessionIdentityState {
	identity: string;
	latest: SessionIndexEvent;
	heartbeat: SessionIndexEvent | undefined;
}

interface SessionIndexProjection {
	identities: IndexedSession[];
	sessions: IndexedSession[];
}

function isTerminalEvent(event: SessionIndexEvent): boolean {
	return event.type === "host_unregistered" || event.type === "session_closed" || event.type === "session_deleted";
}

function isUnresolvedEvent(event: SessionIndexEvent): boolean {
	return !isTerminalEvent(event);
}

/**
 * True only for the proven direct-session GC fence row: the `host_registered`
 * event `main.ts` appends at endpoint generation 0 with the agent dir itself as
 * the state root. It has never published an endpoint and can never be attached
 * by SessionRouter (which requires a positive generation and a readable
 * endpoint), so it must not fence a real endpoint root into ambiguity —
 * otherwise every interactive session reads ambiguous and no chat daemon can
 * attach anything.
 *
 * The locator is required provenance, not decoration. Without it any admitted
 * generation-0 `host_registered` from a foreign root would silently stop
 * fencing, which is fail-open relative to the symmetric fence. Generation 0 is
 * also emitted by `recordTerminalUncertain` as an unproven `lifecycle_terminal`
 * claim, and malformed generations are not proof of anything: everything that
 * is not this exact shape keeps fencing (C5/C6).
 *
 * The comparison is symlink-equivalent because the writer and the reader can
 * legitimately spell the same agent dir differently (one via a symlink, one via
 * its realpath). A plain `path.resolve` match would reject the genuine fence
 * row under a symlinked agent dir and re-fence every session — the exact
 * outage this predicate exists to prevent. `rootIdentity` resolves a stateRoot
 * string once per scan so repeated sessions sharing one root never re-run
 * `realpath` on the same spelling.
 */
function isDirectSessionGcFenceRow(
	event: SessionIndexEvent,
	agentDirIdentity: string,
	rootIdentity: (stateRoot: string) => string,
): boolean {
	return (
		event.type === "host_registered" &&
		event.endpointGeneration === 0 &&
		rootIdentity(event.locator.stateRoot) === agentDirIdentity
	);
}

function preferredIdentity(states: Iterable<SessionIdentityState>): SessionIdentityState | undefined {
	let preferred: SessionIdentityState | undefined;
	for (const state of states) {
		if (
			preferred === undefined ||
			state.latest.endpointGeneration > preferred.latest.endpointGeneration ||
			(state.latest.endpointGeneration === preferred.latest.endpointGeneration &&
				state.latest.indexSeq > preferred.latest.indexSeq)
		)
			preferred = state;
	}
	return preferred;
}

function projectIdentity(
	state: SessionIdentityState,
	ambiguous: boolean,
	now: number,
	probedIncarnations?: ReadonlyMap<string, string | undefined>,
): IndexedSession {
	const { latest, heartbeat } = state;
	const terminal = isTerminalEvent(latest);
	const terminalUncertain = latest.type === "lifecycle_terminal" || latest.terminalUncertain === true;
	const pidAlive = alive(latest.pid);
	// Liveness evidence is host-written: a checkpointed heartbeat, or the
	// `host_registered` event the host appended itself. Counting registration
	// closes the up-to-one-interval window where a just-registered session
	// would read not-live before the first C2 pass — without weakening the
	// pid-reuse fence, because the incarnation match below is still required.
	// Broker-written events (reconciliation, terminal records) are not host
	// evidence and never refresh liveness.
	const evidenceTs = Math.max(heartbeat?.ts ?? 0, latest.type === "host_registered" ? latest.ts : 0);
	const heartbeatFresh = evidenceTs > 0 && now - evidenceTs < 2 * SESSION_HEARTBEAT_INTERVAL_MS;
	const recordedIncarnation = effectiveIncarnation(latest);
	// OS incarnation probes are never taken while the machine-global index lock is
	// held (#4544): callers that already probed pass the observation in, and
	// unlocked callers probe directly. On Windows a probe can spawn powershell.exe
	// — an unbounded OS operation a machine-global critical section must not await.
	// Dead pids are additionally never probed: the probe exists to fence pid reuse
	// for a LIVE process, and for a dead pid it can only return undefined while
	// costing a powershell.exe spawn per stale registration on Windows.
	const probeKey = `${latest.sessionId}\u0000${latest.endpointGeneration}\u0000${latest.pid}`;
	const currentIncarnation =
		recordedIncarnation === undefined || !pidAlive
			? undefined
			: probedIncarnations !== undefined
				? probedIncarnations.get(probeKey)
				: processIncarnation(latest.pid);
	const incarnationMatches = currentIncarnation !== undefined && currentIncarnation === recordedIncarnation;
	return {
		sessionId: latest.sessionId,
		locator: latest.locator,
		endpointGeneration: latest.endpointGeneration,
		pid: latest.pid,
		processIncarnation: latest.processIncarnation,
		endpointMtimeMs: latest.endpointMtimeMs,
		endpointFileId: latest.endpointFileId,
		lifecycleRequestId: latest.lifecycleRequestId,
		terminalUncertain,
		indexSeq: latest.indexSeq,
		hostIncarnation: latest.hostIncarnation,
		masterRole: latest.masterRole,
		identityProvenance: recordedIncarnation === undefined ? "legacy" : "composite",
		activity: heartbeat?.activity,
		lastHeartbeatAt: heartbeat?.ts,
		ambiguous,
		terminal,
		live:
			isSessionAuthorityEligible({ ambiguous }) &&
			!terminal &&
			!terminalUncertain &&
			pidAlive &&
			heartbeatFresh &&
			incarnationMatches,
	};
}

/**
 * Total-order projection (C5/C6): first retain every current composite-identity
 * row, then select one public row per session. More than one unresolved
 * authority-fencing state root fences authority; the direct-session GC fence
 * row never fences, but still survives as public authority when it is the only
 * unresolved root left. Once exactly one authority-fencing root remains, its
 * current identity becomes the public authority even when a terminated identity
 * from another root has a higher generation. Heartbeats inherit
 * locator/endpoint metadata from their identity's prior event.
 */
function reduceEvents(
	events: SessionIndexEvent[],
	now: number,
	agentDir: string,
	probedIncarnations?: ReadonlyMap<string, string | undefined>,
): SessionIndexProjection {
	// Resolved once: the fence-row check runs per root, and only this side of the
	// comparison is ours to normalize.
	const agentDirIdentity = resolveEquivalentPath(agentDir);
	// Sessions routinely share one stateRoot spelling (agent dir, worktree, ...);
	// resolve each distinct spelling once per scan instead of per root so the
	// symlink-equivalence check stays a cheap map hit on every repeated session.
	const rootIdentities = new Map<string, string>();
	const rootIdentity = (stateRoot: string): string => {
		let identity = rootIdentities.get(stateRoot);
		if (identity === undefined) {
			identity = resolveEquivalentPath(stateRoot);
			rootIdentities.set(stateRoot, identity);
		}
		return identity;
	};
	const { admitted } = admitEvents(events);
	const latestByIdentity = new Map<string, SessionIndexEvent>();
	const latestHeartbeatByIdentity = new Map<string, SessionIndexEvent>();
	for (const event of admitted) {
		const identity = identityKey(event);
		if (event.type === "host_heartbeat") {
			latestHeartbeatByIdentity.set(identity, event);
			continue;
		}
		const previous = latestByIdentity.get(identity);
		if (previous === undefined || event.indexSeq > previous.indexSeq) latestByIdentity.set(identity, event);
	}
	const statesBySession = new Map<string, SessionIdentityState[]>();
	const rootsBySession = new Map<string, Map<string, SessionIdentityState[]>>();
	for (const [identity, latest] of latestByIdentity) {
		const state: SessionIdentityState = { identity, latest, heartbeat: latestHeartbeatByIdentity.get(identity) };
		let states = statesBySession.get(latest.sessionId);
		if (states === undefined) {
			states = [];
			statesBySession.set(latest.sessionId, states);
		}
		states.push(state);
		let roots = rootsBySession.get(latest.sessionId);
		if (roots === undefined) {
			roots = new Map<string, SessionIdentityState[]>();
			rootsBySession.set(latest.sessionId, roots);
		}
		let rootStates = roots.get(latest.locator.stateRoot);
		if (rootStates === undefined) {
			rootStates = [];
			roots.set(latest.locator.stateRoot, rootStates);
		}
		rootStates.push(state);
	}
	// Two views of the same roots. `fencingRoots` holds the roots that may claim
	// authority: more than one fences the session, and exactly one is the sole
	// surviving authority. `unresolvedRoots` additionally holds the
	// direct-session GC fence row, which never fences and only becomes public
	// authority when no fencing root is left at all.
	const unresolvedRoots = new Map<string, Map<string, SessionIdentityState[]>>();
	const fencingRoots = new Map<string, Map<string, SessionIdentityState[]>>();
	for (const [sessionId, roots] of rootsBySession) {
		for (const [root, rootStates] of roots) {
			const current = preferredIdentity(rootStates);
			if (!current || !isUnresolvedEvent(current.latest)) continue;
			let unresolved = unresolvedRoots.get(sessionId);
			if (unresolved === undefined) {
				unresolved = new Map<string, SessionIdentityState[]>();
				unresolvedRoots.set(sessionId, unresolved);
			}
			unresolved.set(root, rootStates);
			if (isDirectSessionGcFenceRow(current.latest, agentDirIdentity, rootIdentity)) continue;
			let fencing = fencingRoots.get(sessionId);
			if (fencing === undefined) {
				fencing = new Map<string, SessionIdentityState[]>();
				fencingRoots.set(sessionId, fencing);
			}
			fencing.set(root, rootStates);
		}
	}
	const identities: IndexedSession[] = [];
	const sessions: IndexedSession[] = [];
	for (const [sessionId, states] of statesBySession) {
		const fencing = fencingRoots.get(sessionId);
		const unresolved = unresolvedRoots.get(sessionId);
		const ambiguous = (fencing?.size ?? 0) > 1;
		for (const state of states) identities.push(projectIdentity(state, ambiguous, now, probedIncarnations));
		const defaultAuthority = preferredIdentity(states);
		if (defaultAuthority === undefined || defaultAuthority.latest.type === "session_deleted") continue;
		let authority = defaultAuthority;
		// A sole fencing root outranks any terminated identity from another root,
		// including a higher-generation one. Only when nothing can claim authority
		// does a lone GC fence row become the public survivor.
		const survivingRoots = fencing?.size === 1 ? fencing : (fencing?.size ?? 0) === 0 ? unresolved : undefined;
		if (survivingRoots?.size === 1) {
			const onlyRoot = survivingRoots.values().next().value;
			const survivingAuthority = onlyRoot ? preferredIdentity(onlyRoot) : undefined;
			if (survivingAuthority !== undefined) authority = survivingAuthority;
		}
		sessions.push(projectIdentity(authority, ambiguous, now, probedIncarnations));
	}
	return { identities, sessions };
}

// Global launch bursts may queue behind legitimate long index transactions. Keep
// this bounded at one minute while the shared lock's exact dead-owner recovery runs.
const SESSION_INDEX_LOCK_OPTIONS = { retries: 600, retryDelayMs: 100 } as const;

/**
 * Observation window for one locked index transaction (#4544). This never times
 * out or interrupts the holder — the machine-global lock's safety (never steal
 * from a live owner) depends on holders finishing — it only names the operation
 * still running once the window elapses, so a wedged Windows sync-family await
 * is attributable from logs instead of surfacing as a bare 600-attempt
 * lock-exhaustion crash on every later launch.
 */
const SESSION_INDEX_OP_SLOW_MS = 10_000;
/**
 * How long a completed incarnation-probe batch stays trustworthy while the
 * heartbeat pass acquires the machine-global index lock (#4544 review). A pid
 * can exit and be reused while the pass queues behind another holder, and
 * `alive(pid)` alone would see the reused pid while the observation still
 * matched the dead process. Beyond this bound the cycle writes no heartbeat
 * (fail-closed); the OS is never probed under the lock. The bound only needs
 * to cover an uncontended acquisition plus scheduler jitter — real contention
 * queues for the retry delay (100ms) or far longer.
 *
 * Both freshness bounds are measured on the MONOTONIC clock
 * (`performance.now()`), never `Date.now()`: a backward wall-clock step
 * (manual clock fix, NTP slew, VM snapshot restore) would make a wall-clock
 * interval negative and pass the bound, consuming an arbitrarily stale
 * observation batch. Monotonic time never steps backward, so the fail-closed
 * guarantee cannot be defeated by the system clock moving.
 */
const SESSION_INDEX_PROBE_FRESHNESS_MS = 50;
/**
 * The same trust bound re-checked AFTER the locked replay (#4544 review):
 * replay re-reads the whole log (up to the 4 MiB rotation bound) and fsyncs
 * pending audit rows, so a large index or a slow Windows sync-family await can
 * stretch the interval between the probe batch and the heartbeat write past
 * the acquisition bound above. A pid can exit and be reused across that
 * awaited replay; consuming the cached observation then would checkpoint the
 * replacement process as the dead row. The replay bound therefore covers the
 * full locked replay cost envelope of a healthy machine instead of scheduler
 * jitter alone; anything slower still fails closed (no heartbeat this cycle)
 * and the next pass re-probes from scratch.
 */
const SESSION_INDEX_REPLAY_FRESHNESS_MS = 2_000;
/** Maximum distinct live identity probes admitted by one public status query. */
const SESSION_GENERATION_PROBE_LIMIT = 32;

/**
 * One locked session-index transaction (#4544): every critical section over the
 * machine-global lock runs through this single choke point, so (a) the operation
 * is named in a slow-operation warning when it holds the lock beyond the
 * observation window and (b) the lock budget cannot silently drift per call
 * site.
 */
function withSessionIndexLock<T>(operation: string, agentDir: string, callback: () => Promise<T>): Promise<T> {
	return withFileLock(
		logFor(agentDir),
		async () => {
			// Armed only once the lock is actually held: queueing time behind another
			// legitimate holder must not be attributed to this operation.
			const note = setTimeout(
				() => logger.warn(`sdk broker: session index "${operation}" still holds the index lock after 10s`),
				SESSION_INDEX_OP_SLOW_MS,
			);
			// A diagnostic timer must never keep the process alive on an exit path
			// that races the 10s window; fast paths always clear it in `finally`.
			note.unref?.();
			try {
				return await callback();
			} finally {
				clearTimeout(note);
			}
		},
		SESSION_INDEX_LOCK_OPTIONS,
	);
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
	let syncError: unknown;
	try {
		await handle.sync();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES")) syncError = error;
	}
	try {
		await handle.close();
	} catch (closeError) {
		if (syncError) throw new AggregateError([syncError, closeError], "session-index directory sync and close failed");
		throw closeError;
	}
	if (syncError) throw syncError;
}

async function writeAndSync(file: string, contents: Buffer | string): Promise<void> {
	const handle = await fs.open(file, "w", 0o600);
	let writeError: unknown;
	try {
		await handle.writeFile(contents);
		await handle.sync();
	} catch (error) {
		writeError = error;
	}
	try {
		await handle.close();
	} catch (closeError) {
		if (writeError) throw new AggregateError([writeError, closeError], "session-index write and close failed");
		throw closeError;
	}
	if (writeError) throw writeError;
}

async function replaceAtomically(file: string, contents: Buffer | string): Promise<void> {
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
	let primaryError: unknown;
	try {
		await writeAndSync(temporary, contents);
		await fs.rename(temporary, file);
		await syncDirectory(file);
	} catch (error) {
		primaryError = error;
	}
	let cleanupError: unknown;
	try {
		await fs.rm(temporary, { force: true });
	} catch (error) {
		cleanupError = error;
	}
	if (primaryError && cleanupError)
		throw new AggregateError([primaryError, cleanupError], "session-index replace and cleanup failed");
	if (primaryError) throw primaryError;
	if (cleanupError) throw cleanupError;
}

function alive(pid: number): boolean {
	if (process.platform === "win32") {
		try {
			// Bun's signal-0 probe is not a reliable Windows liveness authority for a
			// detached child: it can report a non-live process even while the child
			// has already published its endpoint. Use the native process handle, which
			// is also the source of the process-incarnation fence, and fail closed when
			// the handle cannot be opened.
			return nativeProcessBindings().Process.fromPid(pid)?.status() === "running";
		} catch {
			return false;
		}
	}
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

type SessionIdentityExpectation = {
	sessionId: string;
	stateRoot: string;
	endpointGeneration: number;
	pid: number;
	processIncarnation?: string;
	hostIncarnation?: string;
	endpointMtimeMs?: number;
	endpointFileId?: string;
	lifecycleRequestId?: string;
};

function sameSessionTuple(
	event: SessionIndexEvent,
	expected: SessionIdentityExpectation,
	expectedRoot: string,
): boolean {
	return (
		event.sessionId === expected.sessionId &&
		event.endpointGeneration === expected.endpointGeneration &&
		resolveEquivalentPath(event.locator.stateRoot) === expectedRoot
	);
}

function sameSessionIdentity(
	event: SessionIndexEvent,
	expected: SessionIdentityExpectation,
	expectedRoot: string,
): boolean {
	return (
		sameSessionTuple(event, expected, expectedRoot) &&
		event.pid === expected.pid &&
		event.processIncarnation === expected.processIncarnation &&
		event.hostIncarnation === expected.hostIncarnation &&
		event.endpointMtimeMs === expected.endpointMtimeMs &&
		event.endpointFileId === expected.endpointFileId &&
		event.lifecycleRequestId === expected.lifecycleRequestId
	);
}

function supersededAtForIdentity(
	events: readonly SessionIndexEvent[],
	expected: SessionIdentityExpectation,
): number | undefined {
	const expectedRoot = resolveEquivalentPath(expected.stateRoot);
	const targetRegistration = events.findLast(
		event => event.type === "host_registered" && sameSessionIdentity(event, expected, expectedRoot),
	);
	const targetAnchor =
		targetRegistration?.indexSeq ??
		events.find(event => sameSessionIdentity(event, expected, expectedRoot))?.indexSeq;
	if (targetAnchor === undefined) return undefined;
	return events
		.filter(
			event =>
				event.type === "host_registered" &&
				sameSessionTuple(event, expected, expectedRoot) &&
				!sameSessionIdentity(event, expected, expectedRoot) &&
				event.indexSeq > targetAnchor,
		)
		.map(event => event.indexSeq)
		.sort((a, b) => a - b)[0];
}

function followsApplicableTombstone(
	events: readonly SessionIndexEvent[],
	candidate: SessionIndexEvent,
	expected: SessionIdentityExpectation,
	expectedRoot: string,
): boolean {
	const tombstone = events.findLast(
		event =>
			event.type === "session_deleted" &&
			event.indexSeq < candidate.indexSeq &&
			sameSessionIdentity(event, expected, expectedRoot),
	);
	if (tombstone === undefined) return false;
	const reRegistration = events.findLast(
		event =>
			event.type === "host_registered" &&
			event.indexSeq < candidate.indexSeq &&
			sameSessionIdentity(event, expected, expectedRoot),
	);
	return reRegistration === undefined || reRegistration.indexSeq < tombstone.indexSeq;
}

export class SessionIndex {
	static #operations = new Map<string, Promise<void>>();
	static #openGroups = new Map<string, SessionIndexOpenGroup>();
	#agentDir: string;
	#policy: ResolvedRetentionPolicy;
	#observationDeps: SessionIndexObservationDeps;
	#events: SessionIndexEvent[] = [];
	#warnings: string[] = [];
	#logOffset = 0;
	#corruptSuffix = false;
	/**
	 * Last change stamp observed by a completed locked pass (#4689); lets the
	 * polling refresh path prove "index unchanged" with two stats.
	 */
	#changeStamp: SessionIndexChangeStamp | undefined;
	/** indexSeqs already recorded in the durable audit; null until lazily seeded. */
	#auditedSeq: Set<number> | null = null;
	constructor(agentDir: string, policy: RetentionPolicy = {}, observationDeps: SessionIndexObservationDeps = {}) {
		this.#agentDir = agentDir;
		this.#policy = resolvePolicy(policy);
		this.#observationDeps = observationDeps;
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
		await SessionIndex.#enqueue(indexPath, () =>
			withSessionIndexLock("replay", this.#agentDir, () => this.#replayUnderLock()),
		);
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
		await SessionIndex.#enqueue(indexPath, () =>
			withSessionIndexLock("replay", this.#agentDir, () => this.#replayUnderLock()),
		);
	}
	/**
	 * Polling-path refresh (#4689): when both index files carry the exact change
	 * stamp of the last completed locked pass, the in-memory projection is
	 * already current and the locked rescan is skipped entirely — this is what
	 * keeps an idle SessionRouter reconcile (2s cadence) from re-parsing and
	 * re-checksumming the whole index forever. An append committed before the
	 * stat always changes the stamp, so a miss is impossible; a change landing
	 * after the stat is seen on the next poll, the same TOCTOU envelope a
	 * locked read has. A corrupt suffix never takes the fast path: re-scanning
	 * preserves the existing re-diagnosis behavior. Returns true when state was
	 * reloaded. Authority revalidation that needs the strongest available
	 * snapshot inside an already-locked write (append, unregister) keeps using
	 * the exact locked paths.
	 */
	async refreshIfChanged(): Promise<boolean> {
		if (this.#changeStamp !== undefined && !this.#corruptSuffix) {
			const stamp = await readIndexChangeStamp(this.#agentDir);
			if (sameIndexChangeStamp(this.#changeStamp, stamp)) return false;
			// A possible change is re-classified UNDER the lock (#4689 review):
			// writers mutate these files only while holding it, so the locked
			// observation is atomic with the tail/replay it selects. The
			// unlocked stamp above is only the cheap "definitely unchanged" cut.
			const indexPath = path.resolve(logFor(this.#agentDir));
			await SessionIndex.#enqueue(indexPath, () =>
				withSessionIndexLock("poll-refresh", this.#agentDir, () => this.#refreshOrReplayUnderLock()),
			);
			return true;
		}
		await this.open();
		await this.refresh();
		return true;
	}
	/**
	 * Locked change classification (#4689). Append-only log growth with an
	 * untouched snapshot tails from the last offset; anything else — in-place
	 * rewrite, truncation, rotation, snapshot replacement, existence
	 * transitions, or an append/compact interleaving that outran the unlocked
	 * pre-check — takes the full replay. Metadata cannot prove prefix identity
	 * against a writer that rewrites history in place while growing the file;
	 * that boundary is the cooperative locked-writer protocol, which never
	 * does that (appendSync, or rename-replace with a fresh snapshot).
	 */
	async #refreshOrReplayUnderLock(): Promise<void> {
		const stamp = await readIndexChangeStamp(this.#agentDir);
		const prior = this.#changeStamp;
		// Append-only growth with an untouched snapshot tails from the last
		// offset; anything else replays in full.
		// The inode is load-bearing on BOTH files here (#4730 review): tailing is
		// only sound if this is the SAME log file grown in place and the SAME
		// snapshot file. A rename-over installs a new inode while size and
		// timestamps can all still match, so without these two comparisons a log
		// that grew while the snapshot was replaced by a same-size, same-timestamp
		// file would be misclassified as append-only, and the reader would tail
		// from its last offset while caching a stale compacted projection.
		if (
			prior?.log.exists &&
			stamp.log.exists &&
			stamp.log.ino === prior.log.ino &&
			stamp.log.size > prior.log.size &&
			stamp.snapshot.exists === prior.snapshot.exists &&
			stamp.snapshot.ino === prior.snapshot.ino &&
			stamp.snapshot.size === prior.snapshot.size &&
			stamp.snapshot.mtimeMs === prior.snapshot.mtimeMs &&
			stamp.snapshot.ctimeMs === prior.snapshot.ctimeMs
		)
			await this.#tailUnderLock();
		else await this.#replayUnderLock();
		// #replayUnderLock recaptures the stamp itself; the tail path needs it
		// captured here (refresh() does this via #refreshUnderLock).
		this.#changeStamp = await readIndexChangeStamp(this.#agentDir);
	}
	async #replayUnderLock(): Promise<void> {
		const scan = await this.#scan();
		if (scan.diagnosis.status === "unsupported") throw scan.unsupportedError!;
		this.#events = [...scan.snapshotEvents, ...scan.validLogEvents];
		this.#warnings = [];
		for (const event of this.#events) {
			if (!hasSessionLocatorV2(event)) this.#warn(legacyLocatorDiagnostic(event));
		}
		this.#logOffset = scan.logContents?.length ?? 0;
		this.#corruptSuffix = scan.diagnosis.status === "corrupt";
		if (scan.diagnosis.reason === "invalid snapshot") this.#warnings.push("Invalid session index snapshot");
		if (this.#corruptSuffix) this.#warnings.push("Corrupt session index entry; replay truncated");
		await this.#writeAuditUnderLock();
		this.#changeStamp = await readIndexChangeStamp(this.#agentDir);
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
						assertSupportedSessionIndexEventVersion(snapshotFor(this.#agentDir), event);
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
					assertSupportedSessionIndexEventVersion(logFor(this.#agentDir), event);
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
			return await withSessionIndexLock("diagnose", this.#agentDir, async () => (await this.#scan()).diagnosis);
		});
	}
	async repair(): Promise<SessionIndexRepairResult> {
		const indexPath = path.resolve(logFor(this.#agentDir));
		return await SessionIndex.#enqueue(indexPath, async () => {
			await fs.mkdir(dirFor(this.#agentDir), { recursive: true, mode: 0o700 });
			return await withSessionIndexLock("repair", this.#agentDir, async () => await this.#repairUnderLock());
		});
	}
	async #repairUnderLock(): Promise<SessionIndexRepairResult> {
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
		// Repair republishes the surviving history as the new snapshot, so it must
		// apply the same retention the ordinary snapshot path applies. Writing the
		// raw survivor set instead let one repair of a long-lived index restore an
		// unbounded snapshot, and every later locked transaction then re-parsed that
		// whole history while holding the index lock — the broker burns CPU and
		// unrelated launches time out waiting for the lock.
		const events = compactEvents([...scan.snapshotEvents, ...scan.validLogEvents], this.#policy);
		const snapshot = JSON.stringify({
			version: SESSION_INDEX_SNAPSHOT_VERSION,
			indexSeq: scan.diagnosis.validPrefixSeq,
			events,
		});
		await replaceAtomically(snapshotFor(this.#agentDir), snapshot);
		// The republished snapshot already carries the full surviving history (after
		// compaction), so the log must be truncated to match: leaving the original
		// events in place keeps every subsequent #scan() parsing them under the lock
		// — the same starvation the compaction above is meant to end. This mirrors
		// #rotate(), which writes an empty log after snapshotting.
		await replaceAtomically(logFor(this.#agentDir), "");
		await this.#replayUnderLock();
		return { ...scan.diagnosis, repaired: true, quarantinePath };
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
				assertSupportedSessionIndexEventVersion(logFor(this.#agentDir), event);
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
			withSessionIndexLock("refresh", this.#agentDir, () => this.#refreshUnderLock()),
		);
	}
	async #refreshUnderLock(): Promise<void> {
		// A newly constructed reader has no replay cursor. Refresh must still load
		// snapshot-carried authority before tailing the empty log; otherwise a cold
		// router starting after compaction projects no sessions until a later append.
		if (this.#events.length === 0 && this.#logOffset === 0) await this.#replayUnderLock();
		else await this.#tailUnderLock();
		await this.#writeAuditUnderLock();
		// #tailUnderLock may delegate to #replayUnderLock (which re-captures);
		// capturing here covers the tail-only and missing-log paths.
		this.#changeStamp = await readIndexChangeStamp(this.#agentDir);
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
			// Own-pid incarnation derivation runs BEFORE the lock (#4544): on Windows
			// the probe can spawn powershell.exe, and the machine-global index lock
			// must not be held across an unbounded OS spawn. It cannot race anything —
			// this process's own pid is fixed for its lifetime.
			let ownIncarnation: string | undefined;
			if (
				input.hostIncarnation === undefined &&
				input.pid === process.pid &&
				Number.isSafeInteger(input.pid) &&
				input.pid > 0
			)
				ownIncarnation = input.processIncarnation ?? processIncarnation(input.pid);
			return await withSessionIndexLock("append", this.#agentDir, async () => {
				await this.#replayUnderLock();
				if (this.#corruptSuffix) {
					// A corrupt suffix used to hard-fail every append until a human ran
					// `gjc gc --repair-session-index` — but the writers that corrupt the
					// log (typically a stale long-lived broker signing events against an
					// outdated in-memory indexSeq) keep appending, so the operator-run
					// repair was re-corrupted within minutes and delegated session
					// launches stayed dead indefinitely. Run the same quarantine-backed
					// repair inline instead: evidence is preserved under
					// sessions/quarantine, the valid prefix is republished, and this
					// append proceeds against the repaired index.
					const repair = await this.#repairUnderLock();
					if (this.#corruptSuffix)
						throw new Error(
							"Cannot append to corrupt session index log; automatic repair did not converge — run `gjc gc --repair-session-index` to quarantine evidence and retain the valid prefix",
						);
					logger.warn(
						`sdk broker: session index self-repaired before append (${repair.reason ?? "corrupt suffix"}); evidence quarantined at ${repair.quarantinePath ?? "unknown"}`,
					);
				}
				const unsigned: Omit<SessionIndexEvent, "checksum"> = {
					...input,
					version: SESSION_INDEX_EVENT_VERSION,
					indexSeq: this.indexSeq + 1,
					ts: input.ts ?? Date.now(),
				};
				if (unsigned.type === "host_unregistered") {
					const registration = this.#events.findLast(
						event =>
							event.type === "host_registered" &&
							event.sessionId === unsigned.sessionId &&
							event.endpointGeneration === unsigned.endpointGeneration &&
							event.pid === unsigned.pid &&
							resolveEquivalentPath(event.locator.stateRoot) ===
								resolveEquivalentPath(unsigned.locator.stateRoot) &&
							(unsigned.lifecycleRequestId === undefined ||
								event.lifecycleRequestId === unsigned.lifecycleRequestId),
					);
					if (registration) {
						if (unsigned.endpointMtimeMs === undefined) unsigned.endpointMtimeMs = registration.endpointMtimeMs;
						if (unsigned.endpointFileId === undefined) unsigned.endpointFileId = registration.endpointFileId;
					}
				}
				// The host's own OS identity was derived before the lock above;
				// broker-authored events for another process carry the registration's
				// persisted binding instead.
				if (ownIncarnation !== undefined && unsigned.hostIncarnation === undefined)
					unsigned.hostIncarnation = ownIncarnation;
				const event: SessionIndexEvent = { ...unsigned, checksum: sessionIndexChecksum(unsigned) };
				await appendSync(logFor(this.#agentDir), JSON.stringify(event));
				await this.#refreshUnderLock();
				if ((await fs.stat(logFor(this.#agentDir))).size >= ROTATE_BYTES) await this.#rotate();
				return event;
			});
		});
	}
	async unregisterIfCurrent(expected: IndexedSession): Promise<boolean> {
		const indexPath = path.resolve(logFor(this.#agentDir));
		return await SessionIndex.#enqueue(indexPath, async () => {
			await fs.mkdir(dirFor(this.#agentDir), { recursive: true, mode: 0o700 });
			// OS incarnation probes run BEFORE the machine-global lock is taken
			// (#4544 review round 5): this pass projects every composite identity
			// to find the current authority row, and an unlocked projection probes
			// the OS once per identity — on Windows that can spawn powershell.exe,
			// which a machine-global critical section must never await. The
			// unregister decision below never consults the projected `live` flag —
			// it compares persisted identity fields against the replayed events —
			// so the pre-lock observations cannot change the outcome either way;
			// they exist only so the locked projection performs no OS probes.
			const probed = new Map<string, string | undefined>();
			for (const row of reduceEvents(this.#events, this.#policy.clock(), this.#agentDir).identities) {
				const recordedIncarnation = row.hostIncarnation ?? row.processIncarnation;
				if (recordedIncarnation === undefined || !alive(row.pid)) continue;
				probed.set(`${row.sessionId}\u0000${row.endpointGeneration}\u0000${row.pid}`, processIncarnation(row.pid));
			}
			return await withSessionIndexLock("conditional unregister", this.#agentDir, async () => {
				await this.#replayUnderLock();
				if (this.#corruptSuffix) throw new Error("Cannot conditionally unregister from a corrupt session index");
				const identities = this.listSessionIdentities(probed);
				const current = identities.find(
					session =>
						session.sessionId === expected.sessionId &&
						session.endpointGeneration === expected.endpointGeneration &&
						session.pid === expected.pid &&
						session.endpointMtimeMs === expected.endpointMtimeMs &&
						session.endpointFileId === expected.endpointFileId &&
						session.lifecycleRequestId === expected.lifecycleRequestId &&
						session.processIncarnation === expected.processIncarnation &&
						(session.hostIncarnation ?? session.processIncarnation) ===
							(expected.hostIncarnation ?? expected.processIncarnation) &&
						resolveEquivalentPath(session.locator.cwd) === resolveEquivalentPath(expected.locator.cwd) &&
						path.resolve(session.locator.stateRoot) === path.resolve(expected.locator.stateRoot),
				);
				let currentRoot: IndexedSession | undefined;
				for (const session of identities) {
					if (
						session.sessionId !== expected.sessionId ||
						session.terminal ||
						resolveEquivalentPath(session.locator.cwd) !== resolveEquivalentPath(expected.locator.cwd) ||
						path.resolve(session.locator.stateRoot) !== path.resolve(expected.locator.stateRoot)
					)
						continue;
					if (
						currentRoot === undefined ||
						session.endpointGeneration > currentRoot.endpointGeneration ||
						(session.endpointGeneration === currentRoot.endpointGeneration &&
							session.indexSeq > currentRoot.indexSeq)
					)
						currentRoot = session;
				}
				if (
					!current ||
					current !== currentRoot ||
					current.terminal ||
					current.terminalUncertain ||
					this.hostUnregisteredAfter(expected)
				)
					return false;
				const unsigned: Omit<SessionIndexEvent, "checksum"> = {
					version: SESSION_INDEX_EVENT_VERSION,
					indexSeq: this.indexSeq + 1,
					ts: Date.now(),
					type: "host_unregistered",
					sessionId: expected.sessionId,
					locator: expected.locator,
					endpointGeneration: expected.endpointGeneration,
					pid: expected.pid,
					...(expected.endpointFileId === undefined ? {} : { endpointFileId: expected.endpointFileId }),
					...(expected.processIncarnation === undefined
						? {}
						: { processIncarnation: expected.processIncarnation }),
					...(expected.hostIncarnation === undefined ? {} : { hostIncarnation: expected.hostIncarnation }),
					...(expected.endpointMtimeMs === undefined ? {} : { endpointMtimeMs: expected.endpointMtimeMs }),
					...(expected.lifecycleRequestId === undefined
						? {}
						: { lifecycleRequestId: expected.lifecycleRequestId }),
				};
				const event: SessionIndexEvent = { ...unsigned, checksum: sessionIndexChecksum(unsigned) };
				await appendSync(logFor(this.#agentDir), JSON.stringify(event));
				await this.#refreshUnderLock();
				if ((await fs.stat(logFor(this.#agentDir))).size >= ROTATE_BYTES) await this.#rotate();
				return true;
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
			return await withSessionIndexLock("authority operation", this.#agentDir, async () => {
				await this.#replayUnderLock();
				if (this.#corruptSuffix) throw new Error("Cannot use corrupt session index for artifact reclamation");
				return await callback();
			});
		});
	}
	async snapshot(): Promise<void> {
		const indexPath = path.resolve(logFor(this.#agentDir));
		await SessionIndex.#enqueue(indexPath, () =>
			withSessionIndexLock("snapshot", this.#agentDir, () => this.#snapshotUnderLock()),
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
		await replaceAtomically(
			file,
			JSON.stringify({
				version: SESSION_INDEX_SNAPSHOT_VERSION,
				indexSeq: this.indexSeq,
				events: compactEvents(this.#events, this.#policy),
			}),
		);
	}
	/**
	 * Broker-scheduled compaction (C3), independent of rotation size: applies the
	 * injected retention policy to a fresh snapshot and truncates the log.
	 */
	async compact(): Promise<void> {
		const indexPath = path.resolve(logFor(this.#agentDir));
		await SessionIndex.#enqueue(indexPath, () =>
			withSessionIndexLock("compact", this.#agentDir, async () => {
				await this.#replayUnderLock();
				await this.#rotate();
			}),
		);
	}
	async #rotate(): Promise<void> {
		await this.#snapshotUnderLock();
		const file = logFor(this.#agentDir);
		await replaceAtomically(file, "");
		this.#logOffset = 0;
		// Sync in-memory state with the compacted snapshot while the lock is
		// held: without this the instance keeps pre-compaction events and a
		// fresh change stamp, so later refreshIfChanged() polls would never
		// observe the compaction (#4689 review).
		await this.#replayUnderLock();
	}

	listSessions(): SessionList {
		return {
			indexSeq: this.indexSeq,
			sessions: reduceEvents(this.#events, this.#policy.clock(), this.#agentDir).sessions,
			warnings: this.#warnings,
		};
	}

	/**
	 * Credential-free proof for one exact public endpoint generation.
	 *
	 * A strictly newer live generation proves replacement only when this
	 * generation was itself observed. Otherwise terminal evidence wins only when
	 * the retained index history positively records it for the exact generation. Missing,
	 * ambiguous, reused, corrupt, or merely non-live state remains unknown.
	 */
	async generationStatus(sessionId: string, endpointGeneration: number): Promise<SessionGenerationIndexStatus> {
		const indexPath = path.resolve(logFor(this.#agentDir));
		const retainProcess =
			this.#observationDeps.retainProcess ??
			((pid: number): SessionIndexProcessObservation | undefined => {
				const reference = nativeProcessBindings().Process.fromPid(pid);
				return reference
					? { incarnation: reference.incarnation, isRunning: () => reference.status() === "running" }
					: undefined;
			});
		for (let attempt = 0; attempt < 3; attempt++) {
			const plan = await SessionIndex.#enqueue(indexPath, () =>
				withSessionIndexLock("generation reconciliation plan", this.#agentDir, async () => {
					await this.#replayUnderLock();
					const latestByIdentity = new Map<string, SessionIndexEvent>();
					for (const event of admitEvents(this.#events).admitted) {
						if (event.sessionId !== sessionId || event.type === "host_heartbeat") continue;
						const key = identityKey(event);
						const previous = latestByIdentity.get(key);
						if (previous === undefined || event.indexSeq > previous.indexSeq) latestByIdentity.set(key, event);
					}
					const registrations = new Map<string, number>();
					for (const event of latestByIdentity.values()) {
						if (!isUnresolvedEvent(event) || effectiveIncarnation(event) === undefined) continue;
						registrations.set(`${event.sessionId}\u0000${event.endpointGeneration}\u0000${event.pid}`, event.pid);
					}
					return {
						indexSeq: this.indexSeq,
						registrations:
							registrations.size <= SESSION_GENERATION_PROBE_LIMIT ? [...registrations.entries()] : undefined,
					};
				}),
			);
			if (plan.registrations === undefined)
				return {
					status: "unknown",
					observedIndexSeq: plan.indexSeq,
					reason: "reconciliation_incomplete",
				};
			// Opening a retained process reference may perform platform work, so it
			// must never run while the machine-global index lock is held. The retained
			// handle binds the exact process incarnation and is checked for running
			// status only after the second locked replay; PID reuse cannot make the old
			// handle refer to the successor. A writer racing either cut causes a bounded
			// retry rather than stale classification.
			const retained = new Map<string, SessionIndexProcessObservation | undefined>();
			for (const [key, pid] of plan.registrations) retained.set(key, await retainProcess(pid));
			const result = await SessionIndex.#enqueue(indexPath, () =>
				withSessionIndexLock("generation reconciliation commit", this.#agentDir, async () => {
					await this.#replayUnderLock();
					if (this.indexSeq !== plan.indexSeq) return undefined;
					const probed = new Map<string, string | undefined>();
					for (const [key, observation] of retained)
						probed.set(key, observation?.isRunning() === true ? observation.incarnation : undefined);
					return this.#generationStatusFromEvents(sessionId, endpointGeneration, probed);
				}),
			);
			if (result !== undefined) return result;
		}
		return { status: "unknown", observedIndexSeq: this.indexSeq, reason: "reconciliation_incomplete" };
	}

	#generationStatusFromEvents(
		sessionId: string,
		endpointGeneration: number,
		probedIncarnations: ReadonlyMap<string, string | undefined>,
	): SessionGenerationIndexStatus {
		const observedIndexSeq = this.indexSeq;
		if (this.#corruptSuffix || this.#warnings.length > 0)
			return { status: "unknown", observedIndexSeq, reason: "index_incomplete" };

		const rawSessionEvents = this.#events.filter(event => event.sessionId === sessionId);
		if (rawSessionEvents.length === 0) return { status: "unknown", observedIndexSeq, reason: "session_not_observed" };
		const rawGenerationEvents = rawSessionEvents.filter(event => event.endpointGeneration === endpointGeneration);
		if (rawGenerationEvents.length === 0)
			return { status: "unknown", observedIndexSeq, reason: "generation_not_observed" };

		const admitted = admitEvents(this.#events).admitted;
		const generationEvents = admitted.filter(
			event => event.sessionId === sessionId && event.endpointGeneration === endpointGeneration,
		);
		if (generationEvents.length === 0)
			return { status: "unknown", observedIndexSeq, reason: "reconciliation_incomplete" };
		const projection = reduceEvents(admitted, this.#policy.clock(), this.#agentDir, probedIncarnations);
		const current = projection.sessions.find(session => session.sessionId === sessionId);
		if (current?.terminalUncertain)
			return { status: "unknown", observedIndexSeq, reason: "reconciliation_incomplete" };
		if (current && !isSessionAuthorityEligible(current))
			return { status: "unknown", observedIndexSeq, reason: "ambiguous_authority" };

		const registrations = rawGenerationEvents.filter(event => event.type === "host_registered");
		const latestByIdentity = new Map<string, SessionIndexEvent>();
		for (const event of rawGenerationEvents) {
			if (event.type === "host_heartbeat") continue;
			const key = identityKey(event);
			const previous = latestByIdentity.get(key);
			if (previous === undefined || event.indexSeq > previous.indexSeq) latestByIdentity.set(key, event);
		}
		const unresolvedRoots = new Set<string>();
		for (const event of registrations) {
			const latest = latestByIdentity.get(identityKey(event));
			if (latest && isUnresolvedEvent(latest)) unresolvedRoots.add(resolveEquivalentPath(event.locator.stateRoot));
		}
		const authorityKeys = new Set<string>();
		for (const event of registrations) {
			const latest = latestByIdentity.get(identityKey(event));
			// A terminal identity from a historical root no longer claims authority.
			// A terminal identity on the surviving root still participates: a new
			// incarnation reusing the same numeric generation on that root must remain
			// unknown. Cross-root ambiguity itself is classified by the projection
			// above, which follows the same surviving-root rules as Router authority.
			const root = resolveEquivalentPath(event.locator.stateRoot);
			if (!latest || (!isUnresolvedEvent(latest) && !unresolvedRoots.has(root))) continue;
			const incarnation = event.hostIncarnation ?? event.processIncarnation;
			const authority =
				incarnation === undefined
					? `legacy:${event.pid}:${event.endpointMtimeMs ?? "unknown"}`
					: `composite:${incarnation}`;
			authorityKeys.add(`${root}\u0000${authority}`);
		}
		if (authorityKeys.size > 1) return { status: "unknown", observedIndexSeq, reason: "generation_reused" };
		const registration = registrations.at(-1);
		const registrationIncarnation = registration?.hostIncarnation ?? registration?.processIncarnation;
		if (!registration || registrationIncarnation === undefined)
			return { status: "unknown", observedIndexSeq, reason: "reconciliation_incomplete" };
		if (
			rawSessionEvents.some(
				event =>
					event.type === "host_registered" &&
					event.indexSeq > registration.indexSeq &&
					event.endpointGeneration < endpointGeneration,
			)
		)
			return { status: "unknown", observedIndexSeq, reason: "generation_reused" };

		if (current?.live) {
			if (current.endpointGeneration === endpointGeneration)
				return {
					status: "current",
					observedIndexSeq,
					evidenceIndexSeq: current.indexSeq,
				};
			if (current.endpointGeneration > endpointGeneration)
				return {
					status: "replaced",
					observedIndexSeq,
					evidenceIndexSeq: current.indexSeq,
					currentGeneration: current.endpointGeneration,
				};
			return { status: "unknown", observedIndexSeq, reason: "generation_reused" };
		}
		const latestExact = generationEvents.findLast(event => event.type !== "host_heartbeat");
		if (
			latestExact?.type === "host_unregistered" ||
			latestExact?.type === "session_closed" ||
			latestExact?.type === "session_deleted"
		) {
			const terminalIncarnation = latestExact.hostIncarnation ?? latestExact.processIncarnation;
			if (latestExact.ts < this.#policy.clock() - this.#policy.maxAgeMs)
				return { status: "unknown", observedIndexSeq, reason: "proof_expired" };
			if (
				terminalIncarnation !== registrationIncarnation ||
				latestExact.pid !== registration.pid ||
				resolveEquivalentPath(latestExact.locator.stateRoot) !==
					resolveEquivalentPath(registration.locator.stateRoot)
			)
				return { status: "unknown", observedIndexSeq, reason: "reconciliation_incomplete" };
			return {
				status: "retired",
				observedIndexSeq,
				evidenceIndexSeq: latestExact.indexSeq,
				event: latestExact.type,
			};
		}

		return { status: "unknown", observedIndexSeq, reason: "reconciliation_incomplete" };
	}
	/**
	 * Broker-internal current composite-identity rows. Unlike {@link listSessions},
	 * this retains losing roots so an exact dead registration can be retired without
	 * disturbing the surviving authority.
	 */
	listSessionIdentities(probedIncarnations?: ReadonlyMap<string, string | undefined>): IndexedSession[] {
		return reduceEvents(this.#events, this.#policy.clock(), this.#agentDir, probedIncarnations).identities;
	}

	/** Reconstructs a receipt-bound identity even when admission superseded it. */
	findHistoricalSessionIdentity(expected: {
		sessionId: string;
		stateRoot: string;
		endpointGeneration: number;
		pid: number;
		processIncarnation?: string;
		hostIncarnation?: string;
		endpointMtimeMs?: number;
		endpointFileId?: string;
		lifecycleRequestId?: string;
	}): IndexedSession | undefined {
		const expectedRoot = resolveEquivalentPath(expected.stateRoot);
		const supersededAt = supersededAtForIdentity(this.#events, expected);
		const matching = this.#events.filter(
			event =>
				(supersededAt === undefined || event.indexSeq < supersededAt) &&
				sameSessionIdentity(event, expected, expectedRoot),
		);
		const latest = matching.findLast(event => event.type !== "host_heartbeat");
		if (latest === undefined) return undefined;
		return projectIdentity(
			{
				identity: identityKey(latest),
				latest,
				heartbeat: matching.findLast(event => event.type === "host_heartbeat"),
			},
			false,
			this.#policy.clock(),
		);
	}

	/** Returns the latest identity-bound terminal event, if retained. */
	findSessionTerminalEvidence(
		expected: Pick<
			IndexedSession,
			| "sessionId"
			| "locator"
			| "endpointGeneration"
			| "pid"
			| "processIncarnation"
			| "hostIncarnation"
			| "endpointMtimeMs"
			| "endpointFileId"
			| "lifecycleRequestId"
		>,
	): { type: "host_unregistered" | "session_closed" | "session_deleted"; indexSeq: number } | undefined {
		const expectedRoot = resolveEquivalentPath(expected.locator.stateRoot);
		const expectedIncarnation = expected.hostIncarnation ?? expected.processIncarnation;
		const supersededAt = supersededAtForIdentity(this.#events, {
			sessionId: expected.sessionId,
			stateRoot: expected.locator.stateRoot,
			endpointGeneration: expected.endpointGeneration,
			pid: expected.pid,
			processIncarnation: expected.processIncarnation,
			hostIncarnation: expected.hostIncarnation,
			endpointMtimeMs: expected.endpointMtimeMs,
			endpointFileId: expected.endpointFileId,
			lifecycleRequestId: expected.lifecycleRequestId,
		});
		const event = this.#events.findLast(
			event =>
				(event.type === "host_unregistered" ||
					event.type === "session_closed" ||
					event.type === "session_deleted") &&
				(event.hostIncarnation ?? event.processIncarnation) === expectedIncarnation &&
				(supersededAt === undefined || event.indexSeq < supersededAt) &&
				!followsApplicableTombstone(
					this.#events,
					event,
					{
						sessionId: expected.sessionId,
						stateRoot: expected.locator.stateRoot,
						endpointGeneration: expected.endpointGeneration,
						pid: expected.pid,
						processIncarnation: expected.processIncarnation,
						hostIncarnation: expected.hostIncarnation,
						endpointMtimeMs: expected.endpointMtimeMs,
						endpointFileId: expected.endpointFileId,
						lifecycleRequestId: expected.lifecycleRequestId,
					},
					expectedRoot,
				) &&
				sameSessionIdentity(
					event,
					{
						sessionId: expected.sessionId,
						stateRoot: expected.locator.stateRoot,
						endpointGeneration: expected.endpointGeneration,
						pid: expected.pid,
						processIncarnation: expected.processIncarnation,
						hostIncarnation: expected.hostIncarnation,
						endpointMtimeMs: expected.endpointMtimeMs,
						endpointFileId: expected.endpointFileId,
						lifecycleRequestId: expected.lifecycleRequestId,
					},
					expectedRoot,
				),
		);
		return event &&
			(event.type === "host_unregistered" || event.type === "session_closed" || event.type === "session_deleted")
			? { type: event.type, indexSeq: event.indexSeq }
			: undefined;
	}

	/** Returns the latest identity-bound session_closed evidence, even after a tombstone. */
	findSessionClosedEvidence(
		expected: Pick<
			IndexedSession,
			| "sessionId"
			| "locator"
			| "endpointGeneration"
			| "pid"
			| "processIncarnation"
			| "hostIncarnation"
			| "endpointMtimeMs"
			| "endpointFileId"
			| "lifecycleRequestId"
		>,
	): number | undefined {
		const expectedRoot = resolveEquivalentPath(expected.locator.stateRoot);
		const supersededAt = supersededAtForIdentity(this.#events, {
			sessionId: expected.sessionId,
			stateRoot: expected.locator.stateRoot,
			endpointGeneration: expected.endpointGeneration,
			pid: expected.pid,
			processIncarnation: expected.processIncarnation,
			hostIncarnation: expected.hostIncarnation,
			endpointMtimeMs: expected.endpointMtimeMs,
			endpointFileId: expected.endpointFileId,
			lifecycleRequestId: expected.lifecycleRequestId,
		});
		return this.#events.findLast(
			event =>
				event.type === "session_closed" &&
				(supersededAt === undefined || event.indexSeq < supersededAt) &&
				!followsApplicableTombstone(
					this.#events,
					event,
					{
						sessionId: expected.sessionId,
						stateRoot: expected.locator.stateRoot,
						endpointGeneration: expected.endpointGeneration,
						pid: expected.pid,
						processIncarnation: expected.processIncarnation,
						hostIncarnation: expected.hostIncarnation,
						endpointMtimeMs: expected.endpointMtimeMs,
						endpointFileId: expected.endpointFileId,
						lifecycleRequestId: expected.lifecycleRequestId,
					},
					expectedRoot,
				) &&
				sameSessionIdentity(
					event,
					{
						sessionId: expected.sessionId,
						stateRoot: expected.locator.stateRoot,
						endpointGeneration: expected.endpointGeneration,
						pid: expected.pid,
						processIncarnation: expected.processIncarnation,
						hostIncarnation: expected.hostIncarnation,
						endpointMtimeMs: expected.endpointMtimeMs,
						endpointFileId: expected.endpointFileId,
						lifecycleRequestId: expected.lifecycleRequestId,
					},
					expectedRoot,
				),
		)?.indexSeq;
	}

	/**
	 * Production coalesced heartbeat checkpoint pass (C2): appends one
	 * `host_heartbeat` per session at most once per {@link SESSION_HEARTBEAT_INTERVAL_MS}.
	 * The pass observes liveness the same way the projection does — the host process
	 * must be alive and, for composite identities, still carry the recorded OS process
	 * incarnation (a reused PID is never checkpointed). Stopped, terminal, and ambiguous rows
	 * and rows whose heartbeat is still fresh are skipped. After a broker restart, sessions whose
	 * host survived are re-observed as live on the first pass; sessions whose host died
	 * while the broker was down keep their stale or missing heartbeat and read as
	 * unknown/not-live (never fresh forever). Returns the number of checkpoints written.
	 */
	async checkpointLiveHeartbeats(now = Date.now()): Promise<number> {
		const indexPath = path.resolve(logFor(this.#agentDir));
		return await SessionIndex.#enqueue(indexPath, async () => {
			// An absent index holds no registration to checkpoint, so this pass must read
			// it as "nothing to do" instead of creating one. Recreating the directory
			// resurrects a state root its owner already retired: the broker's 5s
			// publication watch would rebuild a removed agent dir after shutdown.
			try {
				await fs.stat(dirFor(this.#agentDir));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
				throw error;
			}
			// OS incarnation probes run BEFORE the machine-global lock is taken
			// (#4544): on Windows a probe can spawn powershell.exe, and holding the
			// index lock across an unbounded OS spawn starves every later launch.
			// The probe reads only the last replayed history to pick WHICH pids are
			// worth observing. The observations are then bound to the instant the
			// probe batch COMPLETED: if anything delays this pass past that instant —
			// lock contention queueing behind another holder, or simply time — the
			// observation set is discarded and this cycle writes no heartbeat. A pid
			// can exit and be reused in that window, and `alive(pid)` alone would see
			// the reused pid while a stale observation still matched the dead
			// process, checkpointing the wrong host. Failing closed is the only
			// revalidation that never probes the OS under the lock: the next pass
			// re-probes from scratch.
			const probed = new Map<string, string | undefined>();
			for (const row of reduceEvents(this.#events, now, this.#agentDir).sessions) {
				if (!isSessionAuthorityEligible(row) || row.terminal || row.terminalUncertain) continue;
				if (row.lastHeartbeatAt !== undefined && now - row.lastHeartbeatAt < SESSION_HEARTBEAT_INTERVAL_MS)
					continue;
				if (!alive(row.pid)) continue;
				const recordedIncarnation = row.hostIncarnation ?? row.processIncarnation;
				if (recordedIncarnation === undefined) continue;
				probed.set(`${row.sessionId}\u0000${row.endpointGeneration}\u0000${row.pid}`, processIncarnation(row.pid));
			}
			const probedAt = performance.now();
			return await withSessionIndexLock("heartbeat checkpoint", this.#agentDir, async () => {
				// Contended or delayed acquisition invalidates the observation set:
				// never trust identity evidence gathered meaningfully before the
				// lock was held. The checkpoint is skipped this cycle (fail-closed);
				// the OS is never probed while the machine-global lock is held. The
				// bound tolerates scheduler jitter on an uncontended acquisition —
				// which is the only path where the evidence is trustworthy.
				if (performance.now() - probedAt > SESSION_INDEX_PROBE_FRESHNESS_MS) return 0;
				await this.#replayUnderLock();
				// Recheck AFTER the awaited replay too (#4544 review round 4): the
				// replay re-reads the whole log (up to the 4 MiB rotation bound) and
				// fsyncs pending audit rows, so the probe→write interval can stretch
				// well past the acquisition bound above while the lock is held. The
				// same pid-reuse window exists across that awaited replay; consuming
				// the cached observation then would checkpoint the replacement
				// process as the dead row. The replay bound covers the full locked
				// replay cost envelope of a healthy machine; anything slower fails
				// closed (no heartbeat this cycle) and the next pass re-probes.
				if (performance.now() - probedAt > SESSION_INDEX_REPLAY_FRESHNESS_MS) return 0;
				if (this.#corruptSuffix) return 0;
				const events: SessionIndexEvent[] = [];
				const rows = reduceEvents(this.#events, now, this.#agentDir, probed).sessions;
				for (const row of rows) {
					if (!isSessionAuthorityEligible(row) || row.terminal || row.terminalUncertain) continue;
					if (row.lastHeartbeatAt !== undefined && now - row.lastHeartbeatAt < SESSION_HEARTBEAT_INTERVAL_MS)
						continue;
					if (!alive(row.pid)) continue;
					const recordedIncarnation = row.hostIncarnation ?? row.processIncarnation;
					if (recordedIncarnation === undefined) continue;
					const current = probed.get(`${row.sessionId}\u0000${row.endpointGeneration}\u0000${row.pid}`);
					if (current === undefined || current !== recordedIncarnation) continue;
					const unsigned: Omit<SessionIndexEvent, "checksum"> = {
						version: SESSION_INDEX_EVENT_VERSION,
						indexSeq: this.indexSeq + events.length + 1,
						type: "host_heartbeat",
						sessionId: row.sessionId,
						locator: row.locator,
						endpointGeneration: row.endpointGeneration,
						pid: row.pid,
						...(row.processIncarnation === undefined ? {} : { processIncarnation: row.processIncarnation }),
						...(row.hostIncarnation === undefined ? {} : { hostIncarnation: row.hostIncarnation }),
						...(row.masterRole === undefined ? {} : { masterRole: row.masterRole }),
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
			| "sessionId"
			| "locator"
			| "endpointGeneration"
			| "pid"
			| "endpointMtimeMs"
			| "endpointFileId"
			| "indexSeq"
			| "lifecycleRequestId"
			| "hostIncarnation"
			| "processIncarnation"
		>,
	): { indexSeq: number; lifecycleRequestId?: string } | undefined {
		const lifecycleRequestId = registration.lifecycleRequestId;
		const incarnation = registration.hostIncarnation ?? registration.processIncarnation;
		const event = this.#events.findLast(
			item =>
				item.type === "host_unregistered" &&
				item.indexSeq > registration.indexSeq &&
				item.sessionId === registration.sessionId &&
				item.endpointGeneration === registration.endpointGeneration &&
				item.pid === registration.pid &&
				((item.endpointMtimeMs === undefined && item.endpointFileId === undefined) ||
					(item.endpointMtimeMs === registration.endpointMtimeMs &&
						item.endpointFileId === registration.endpointFileId)) &&
				resolveEquivalentPath(item.locator.cwd) === resolveEquivalentPath(registration.locator.cwd) &&
				path.resolve(item.locator.stateRoot) === path.resolve(registration.locator.stateRoot) &&
				(lifecycleRequestId === undefined || item.lifecycleRequestId === lifecycleRequestId) &&
				(incarnation === undefined || (item.hostIncarnation ?? item.processIncarnation) === incarnation),
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
					endpointFileId: event.endpointFileId,
					lifecycleRequestId: event.lifecycleRequestId,
					terminalUncertain: false,
					indexSeq: event.indexSeq,
					hostIncarnation: event.hostIncarnation,
					masterRole: event.masterRole,
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
