import { spawn as childProcessSpawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { withFileLock } from "../../config/file-lock";
import type { Settings } from "../../config/settings";
import type { DaemonRuntimeInfo } from "../../daemon/control-types";
import { resolveGjcRuntimeSpawnInfo } from "../../daemon/runtime";
import { type ChatEffect, ChatEffectJournal, type ChatEffectLease } from "./chat-effect-journal";
import { getNotificationConfig, isTelegramConfigured, tokenFingerprint } from "./config";
import { parseInThreadConfigCommand, parseRichToggleCommand, parseTelegramControlCommand } from "./config-commands";
import { daemonPaths, HEARTBEAT_TTL_MS } from "./daemon-paths";
import {
	buildCompactChoiceGrid,
	code,
	splitTelegramHtml,
	TELEGRAM_MESSAGE_LIMIT,
	TELEGRAM_PARSE_MODE,
} from "./html-format";
import type {
	SessionCloseTarget,
	SessionCreateTarget,
	SessionLifecycleRequest,
	SessionLifecycleResponse,
	SessionResumeTarget,
} from "./index";
import {
	formatLifecycleOutcome,
	isLifecycleCommandLikeText,
	isLifecycleCommandText,
	lifecycleUsage,
	parseLifecycleCommand,
	validateLifecycleTarget,
} from "./lifecycle-commands";
import {
	attachLifecycleControl,
	buildOrchestratorDeps,
	type ControlServerLike,
	createNativeControlServer,
	type LifecycleControlServer,
	type LifecycleControlServerFactory,
} from "./lifecycle-control-runtime";
import { NotificationOperatorRuntime, OperatorBackoffPolicy, OperatorEventRouter } from "./operator-runtime";
import { RateLimitPool } from "./rate-limit-pool";
import { listRecentSessions } from "./recent-activity";
import { ReplySentStore } from "./reply-sent-store";
import { DraftStreamState, deliverDraft, shouldStreamDraft } from "./rich-draft";
import { deliverRichActionWithFallback, deliverRichWithFallback, shouldPromoteRich } from "./rich-render";
import {
	type AliasTable,
	buildActionMarkdown,
	buildActionMessage,
	type CallbackRoute,
	createAliasTable,
	readEndpoint,
	routeInboundUpdate,
} from "./telegram-reference";
import { decideThreadedInbound, type InboundAttachment } from "./threaded-inbound";
import { renderThreadedFrame, type ThreadedSend } from "./threaded-render";
import { TopicRegistry, type TopicRegistryState } from "./topic-registry";

export type EnsureDaemonResult = "owner_spawned" | "attached" | "disabled" | "blocked" | "deferred";

export interface DaemonState {
	pid: number;
	ownerId: string;
	tokenFingerprint: string;
	chatId: string;
	startedAt: number;
	heartbeatAt: number;
	roots: string[];
	version: 1;
	/**
	 * Operational daemon generation of the process that owns the lock, distinct
	 * from the persisted state-schema {@link DaemonState.version}. It records the
	 * wire generation ({@link DAEMON_GENERATION}) the owning daemon speaks so a
	 * freshly-upgraded host can detect — and reload — a still-live pre-upgrade
	 * daemon whose schema version is unchanged. Absent on pre-generation state.
	 */
	generation?: number;
	stoppedAt?: number;
}
export interface TelegramDaemonFs {
	mkdir(path: string, opts?: fs.MakeDirectoryOptions): Promise<void>;
	readFile(path: string, encoding: BufferEncoding): Promise<string>;
	writeFile(path: string, data: string, opts?: fs.WriteFileOptions): Promise<void>;
	rename(oldPath: string, newPath: string): Promise<void>;
	unlink(path: string): Promise<void>;
	open(path: string, flags: string, mode?: number): Promise<{ close(): Promise<void>; sync?(): Promise<void> }>;
	readdir(path: string): Promise<string[]>;
	chmod(path: string, mode: number): Promise<void>;
	/**
	 * Optional realpath resolver. Existing roots and the longest existing ancestor
	 * of a missing root are canonicalized so symlink workspaces collapse to one
	 * stable identity before and after directory creation. Every non-ENOENT
	 * resolution failure is ambiguous and fails closed.
	 */
	realpath?(path: string): Promise<string>;
}

export interface SpawnResult {
	unref?: () => void;
}

export interface TelegramDaemonDeps {
	fs?: TelegramDaemonFs;
	now?: () => number;
	pid?: number;
	pidAlive?: (pid: number) => boolean;
	spawn?: (
		command: string,
		args: string[],
		opts: { detached: boolean; stdio: "ignore"; logPath?: string },
	) => SpawnResult;
	execPath?: string;
	randomId?: () => string;
	/**
	 * Signal delivery + poll timing for the stale-generation reload handoff in
	 * {@link ensureTelegramDaemonRunning}. Defaults use real signals/timers; tests
	 * inject them to drive the handoff deterministically.
	 */
	sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
	sleep?: (ms: number) => Promise<void>;
	waitStepMs?: number;
}

export const HEARTBEAT_INTERVAL_MS = 5_000;
export { HEARTBEAT_TTL_MS };
export const DAEMON_VERSION = 1;
/** Capability token advertised when the server supports app-level ping/pong. */
export const CLIENT_PING_PONG_CAPABILITY = "client_ping_pong";
/** Protocol version the daemon advertises in its ClientHello. */
export const NOTIFICATION_PROTOCOL_VERSION = 3;
/** Capability required for typed controls and semantic Selected acknowledgement frames. */
export const ASK_SELECTED_ACK_CAPABILITY = "ask_selected_ack_v1";
export const ASK_CONTROLS_CAPABILITY = "ask_controls_v1";
/**
 * Operational generation the current daemon build speaks, persisted into
 * {@link DaemonState.generation} on ownership acquisition. It is tied to the
 * wire {@link NOTIFICATION_PROTOCOL_VERSION} so any protocol bump (which is what
 * gates capabilities like {@link ASK_SELECTED_ACK_CAPABILITY}) also bumps the
 * generation, letting a freshly-upgraded host recognise an older, still-live
 * daemon and reload it instead of silently attaching to it. Distinct from the
 * persisted schema {@link DAEMON_VERSION}, which did not change across #1999.
 */
export const DAEMON_GENERATION = NOTIFICATION_PROTOCOL_VERSION;

const nodeFs: TelegramDaemonFs = fs.promises as unknown as TelegramDaemonFs;

/**
 * Durably persist a `/rich` toggle. A real {@link Settings} exposes
 * `flushOrThrow()`, which rejects on a failed config.yml write (its `set()` is a
 * fire-and-forget whose background save swallows errors). The lightweight daemon
 * settings has no `flushOrThrow` — its `set()` already wrote durably and throws
 * on failure — so its plain `flush()` no-op drain is sufficient.
 */
async function flushRichToggleSettings(settings: Settings): Promise<void> {
	if (typeof settings.flushOrThrow === "function") {
		await settings.flushOrThrow();
		return;
	}
	await settings.flush();
}
const RATE_LIMIT_FLUSH_INTERVAL_MS = 1_000;
// How often the daemon rescans for newly-started sessions. This MUST run
// independently of the Telegram getUpdates long-poll (up to 25s): otherwise a
// session that starts mid-poll is not connected until the poll returns, so its
// buffered ask is delivered up to 25s late — or never, if the user answers the
// local ask first (which clears the buffered ask).
const SESSION_SCAN_INTERVAL_MS = 1_000;
// Transient Telegram API delivery is retried this many times before giving up.
const BOT_API_RETRY_ATTEMPTS = 3;
// Backoff after a failed getUpdates long-poll so a persistent outage does not
// busy-loop the daemon.
const POLL_BACKOFF_MS = 1_000;
// Telegram clears a chat action after ~5s; refresh slightly sooner to keep the
// typing indicator alive while the agent is busy.
const TYPING_REFRESH_INTERVAL_MS = 4_000;
// Native reactions used as a two-stage delivery double-check on inbound thread
// messages: queued on receipt, consumed once a turn picks the message up.
const QUEUED_REACTION = "👀";
const PENDING_TOPIC_FRAME_LIMIT = 20;
const SEEN_UPDATE_ID_LIMIT = 1_000;
const ORPHAN_TOPIC_GRACE_MS = 60_000;
// Bounded AbortSignal timeout for a single deleteForumTopic call so a stalled
// provider I/O cannot hang the daemon or hold a deletion claim indefinitely.
const TOPIC_DELETE_TIMEOUT_MS = 15_000;
const CONSUMED_REACTION = "✅";

function splitTelegramPlainText(text: string, max = TELEGRAM_MESSAGE_LIMIT): string[] {
	if (text.length <= max) return [text];
	const chunks: string[] = [];
	let out = "";
	for (const ch of text) {
		if (out.length + ch.length > max) {
			chunks.push(out);
			out = "";
		}
		out += ch;
	}
	if (out) chunks.push(out);
	return chunks;
}
function endpointGenerationKey(url: string, token: string): string {
	return `${url}\0${token}`;
}

function topicRenameApplied(response: unknown): boolean {
	return !!response && typeof response === "object" && (response as { ok?: unknown }).ok === true;
}

/**
 * Whether `err` is a transient network failure worth retrying. Telegram API
 * calls over HTTP/2 occasionally surface mid-stream `ECONNRESET` (and similar)
 * that the global h2 fallback does not catch; treating these as fatal drops ask
 * notifications and (in the polling loop) crashes the daemon.
 */
function isTransientNetworkError(err: unknown): boolean {
	const code = (err as { code?: unknown } | null)?.code;
	if (typeof code === "string") {
		const transient = new Set([
			"ECONNRESET",
			"ECONNREFUSED",
			"ETIMEDOUT",
			"EPIPE",
			"ENOTFOUND",
			"EAI_AGAIN",
			"UND_ERR_SOCKET",
			"ConnectionClosed",
			"ConnectionReset",
			"ConnectionRefused",
			"ConnectionTimeout",
			"FailedToOpenSocket",
		]);
		if (transient.has(code)) return true;
	}
	const message = (err as { message?: unknown } | null)?.message;
	return (
		typeof message === "string" &&
		/socket connection was closed|econnreset|fetch failed|network|timed out|terminated/i.test(message)
	);
}

/** `fetch` with bounded retries on transient network failures. */
async function fetchWithRetry(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	sleep: (ms: number) => Promise<void>,
	attempts: number = BOT_API_RETRY_ATTEMPTS,
): Promise<Response> {
	let lastErr: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await fetchImpl(url, init);
		} catch (err) {
			lastErr = err;
			if (!isTransientNetworkError(err) || attempt === attempts - 1) throw err;
			await sleep(200 * 2 ** attempt);
		}
	}
	throw lastErr;
}

export { type DaemonPaths, daemonPaths } from "./daemon-paths";

/**
 * Attach session-lifecycle control (create/close/resume) to the running daemon.
 *
 * Wires an already-started, authenticated control server to the lifecycle
 * orchestrator with real daemon-side effects (tmux launcher / force-close /
 * resume), a durable fsynced idempotency ledger + audit JSONL under the agent
 * notifications dir, and strict paired-chat gating. The control server itself
 * (NotificationControlServer) is owned/started by the daemon process; this
 * function only connects it to policy. Returns the orchestrator deps for tests.
 */
export function startDaemonLifecycleControl(input: {
	controlServer: ControlServerLike;
	pairedChatId: string;
	agentDir: string;
	env?: NodeJS.ProcessEnv;
}): void {
	const deps = buildOrchestratorDeps({
		pairedChatId: input.pairedChatId,
		agentNotificationsDir: daemonPaths(input.agentDir).dir,
		sessionsRoot: path.join(input.agentDir, "sessions"),
		env: input.env,
	});
	attachLifecycleControl(input.controlServer, deps);
}

async function ensureDir(fsImpl: TelegramDaemonFs, dir: string): Promise<void> {
	await fsImpl.mkdir(dir, { recursive: true, mode: 0o700 });
	await fsImpl.chmod(dir, 0o700).catch(() => undefined);
}

async function readJson<T>(fsImpl: TelegramDaemonFs, file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await fsImpl.readFile(file, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function writeJsonAtomic(fsImpl: TelegramDaemonFs, file: string, data: unknown): Promise<void> {
	const dir = path.dirname(file);
	const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		await fsImpl.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		await fsImpl.chmod(tmp, 0o600).catch(() => undefined);
		// Fsync the temp file (data) and, after the atomic rename, the parent
		// directory (directory entry) so a crash never leaves a half-written or
		// unlinked file. Mirrors the ConversationStore durability contract; the
		// optional sync() is absent only on injected test fs implementations.
		const fileHandle = await fsImpl.open(tmp, "r");
		try {
			await fileHandle.sync?.();
		} finally {
			await fileHandle.close();
		}
		await fsImpl.rename(tmp, file);
		const dirHandle = await fsImpl.open(dir, "r");
		try {
			await dirHandle.sync?.();
		} finally {
			await dirHandle.close();
		}
	} catch (error) {
		await fsImpl.unlink(tmp).catch(() => undefined);
		throw error;
	}
}

async function tryOpenWx(fsImpl: TelegramDaemonFs, file: string): Promise<boolean> {
	try {
		const handle = await fsImpl.open(file, "wx", 0o600);
		await handle.close();
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

/**
 * Per-session registration lease. Refreshed with a fresh random `leaseId` on
 * every {@link registerNotificationRoot} so a same-session re-registration
 * invalidates any orphan candidate an older registration established. The
 * daemon never reaps a topic whose candidate lease no longer matches the live
 * lease — a fresh registration (session restart) cancels a stale reap.
 */
interface SessionLease {
	leaseId: string;
	refreshedAt: number;
}

/**
 * Per-session orphan-topic deletion candidate. Recorded on the first confirmed
 * continuous absence; a topic is reaped only once this candidate has survived
 * {@link ORPHAN_TOPIC_GRACE_MS} from `observedAt` AND its lease still matches
 * the live session lease (no intervening registration/publication).
 */
interface OrphanCandidate {
	observedAt: number;
	leaseId: string;
	topicId: string;
}

/**
 * Validated, decision-only view over the raw notification-roots registry. The
 * raw object is carried verbatim through every read-modify-write so unknown,
 * legacy, or unrelated fields survive; only strictly-valid entries populate the
 * decision maps — ambiguous/malformed/legacy state never authorizes a deletion.
 */
interface RootsRegistryView {
	raw: Record<string, unknown>;
	roots: string[];
	sessions: Map<string, string>;
	sessionLeases: Map<string, SessionLease>;
	orphanCandidates: Map<string, OrphanCandidate>;
}
/**
 * Per-session absence evidence derived from a session's MAPPED root during a
 * roots scan (F001). Decides whether an absence candidate may be created or
 * continued: only `absent`/`missing` authorize it; `present` clears it, and
 * `ambiguous` (unreadable/malformed mapped root) clears/defers it so an
 * unreadable root can never be mistaken for confirmed absence.
 */
type SessionAbsenceEvidence = { kind: "present" } | { kind: "absent" } | { kind: "missing" } | { kind: "ambiguous" };

/** Non-empty string scalar: every registry id (leaseId, map key) must be one. */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** Non-negative safe-integer scalar: every registry timestamp must be one. */
function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Canonical positive safe-integer string scalar: every candidate topicId must
 * be one. Rejects zero, negatives, fractions, leading zeros, whitespace,
 * exponents, and any non-digit, so a malformed candidate id can never match a
 * live topic record and authorize a destructive delete.
 */
function isCanonicalTopicId(value: unknown): value is string {
	if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return false;
	return Number.isSafeInteger(Number(value));
}
/** True only for a definitive "no such file or directory" filesystem error. */
function isENOENTError(err: unknown): boolean {
	return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function parseRootsList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const roots: string[] = [];
	for (const entry of value) if (typeof entry === "string" && entry.length > 0) roots.push(entry);
	return roots;
}

function parseStringRecord(value: unknown): Map<string, string> {
	const map = new Map<string, string>();
	if (!value || typeof value !== "object" || Array.isArray(value)) return map;
	for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
		if (isNonEmptyString(key) && typeof val === "string") map.set(key, val);
	}
	return map;
}

function parseSessionLeases(value: unknown): Map<string, SessionLease> {
	const map = new Map<string, SessionLease>();
	if (!value || typeof value !== "object" || Array.isArray(value)) return map;
	for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
		if (!isNonEmptyString(key) || !val || typeof val !== "object" || Array.isArray(val)) continue;
		const lease = val as { leaseId?: unknown; refreshedAt?: unknown };
		if (!isNonEmptyString(lease.leaseId) || !isNonNegativeSafeInteger(lease.refreshedAt)) continue;
		map.set(key, { leaseId: lease.leaseId, refreshedAt: lease.refreshedAt });
	}
	return map;
}

function parseOrphanCandidates(value: unknown): Map<string, OrphanCandidate> {
	const map = new Map<string, OrphanCandidate>();
	if (!value || typeof value !== "object" || Array.isArray(value)) return map;
	for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
		if (!isNonEmptyString(key) || !val || typeof val !== "object" || Array.isArray(val)) continue;
		const candidate = val as { observedAt?: unknown; leaseId?: unknown; topicId?: unknown };
		if (
			!isNonNegativeSafeInteger(candidate.observedAt) ||
			!isNonEmptyString(candidate.leaseId) ||
			!isCanonicalTopicId(candidate.topicId)
		)
			continue;
		map.set(key, {
			observedAt: candidate.observedAt,
			leaseId: candidate.leaseId,
			topicId: candidate.topicId,
		});
	}
	return map;
}

async function readRootsRegistry(fsImpl: TelegramDaemonFs, rootsFile: string): Promise<RootsRegistryView> {
	const parsed = await readJson<unknown>(fsImpl, rootsFile);
	const raw: Record<string, unknown> =
		parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : {};
	return {
		raw,
		roots: parseRootsList(raw.roots),
		sessions: parseStringRecord(raw.sessions),
		sessionLeases: parseSessionLeases(raw.sessionLeases),
		orphanCandidates: parseOrphanCandidates(raw.orphanCandidates),
	};
}

/**
 * Persist the raw roots registry verbatim; only the schema `version` is
 * normalized. Every other key — known or unknown, well-formed or legacy — is
 * carried through untouched so unknown registry fields survive every write.
 */
async function persistRootsRegistry(
	fsImpl: TelegramDaemonFs,
	rootsFile: string,
	raw: Record<string, unknown>,
): Promise<void> {
	raw.version = 1;
	await writeJsonAtomic(fsImpl, rootsFile, raw);
}

/** Return the live raw object held at `key`, or a fresh object when the field is
 * absent or not a plain object. Callers mutate it in place and reassign it. */
function rawObjectField(raw: Record<string, unknown>, key: string): Record<string, unknown> {
	const existing = raw[key];
	return existing && typeof existing === "object" && !Array.isArray(existing)
		? (existing as Record<string, unknown>)
		: {};
}

function addRawRoot(raw: Record<string, unknown>, root: string): void {
	const existing = raw.roots;
	const arr = Array.isArray(existing) ? existing : [];
	if (arr.indexOf(root) !== -1) return;
	const next = arr.slice();
	next.push(root);
	raw.roots = next;
}

function setRawSessionMapping(raw: Record<string, unknown>, sessionId: string, root: string): void {
	const map = rawObjectField(raw, "sessions");
	map[sessionId] = root;
	raw.sessions = map;
}

function setRawLease(raw: Record<string, unknown>, sessionId: string, lease: SessionLease): void {
	const map = rawObjectField(raw, "sessionLeases");
	map[sessionId] = { leaseId: lease.leaseId, refreshedAt: lease.refreshedAt };
	raw.sessionLeases = map;
}

function deleteRawLease(raw: Record<string, unknown>, sessionId: string): boolean {
	const map = rawObjectField(raw, "sessionLeases");
	if (!(sessionId in map)) return false;
	delete map[sessionId];
	raw.sessionLeases = map;
	return true;
}
/** Remove a session→root mapping verbatim; returns whether it existed. */
function deleteRawSessionMapping(raw: Record<string, unknown>, sessionId: string): boolean {
	const map = rawObjectField(raw, "sessions");
	if (!(sessionId in map)) return false;
	delete map[sessionId];
	raw.sessions = map;
	return true;
}

function deleteRawRootIfUnreferenced(raw: Record<string, unknown>, root: string): boolean {
	const sessions = raw.sessions;
	if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) return false;
	if (Object.values(sessions as Record<string, unknown>).some(value => value === root)) return false;
	if (!Array.isArray(raw.roots)) return false;
	const next = raw.roots.filter(value => value !== root);
	if (next.length === raw.roots.length) return false;
	raw.roots = next;
	return true;
}

function setRawCandidate(raw: Record<string, unknown>, sessionId: string, candidate: OrphanCandidate): void {
	const map = rawObjectField(raw, "orphanCandidates");
	map[sessionId] = {
		observedAt: candidate.observedAt,
		leaseId: candidate.leaseId,
		topicId: candidate.topicId,
	};
	raw.orphanCandidates = map;
}

function deleteRawCandidate(raw: Record<string, unknown>, sessionId: string): boolean {
	const map = rawObjectField(raw, "orphanCandidates");
	if (!(sessionId in map)) return false;
	delete map[sessionId];
	raw.orphanCandidates = map;
	return true;
}

/**
 * Run a roots-registry mutation under the bounded host-wide roots file lock. The
 * lock is held ONLY for the read-modify-write (bounded retries); callers MUST
 * NOT perform root inventory reads, pool flushes, or network calls inside
 * `mutate` — those run lock-free so a stalled deletion never blocks the host.
 */
async function mutateRootsRegistry(
	fsImpl: TelegramDaemonFs,
	rootsFile: string,
	mutate: (view: RootsRegistryView) => boolean,
): Promise<void> {
	await withFileLock(
		rootsFile,
		async () => {
			const view = await readRootsRegistry(fsImpl, rootsFile);
			if (mutate(view)) await persistRootsRegistry(fsImpl, rootsFile, view.raw);
		},
		{ staleMs: 10_000 },
	);
}

/** Effect kind + id for a per-session telegram forum-topic deletion claim. */
const TELEGRAM_TOPIC_DELETE_KIND = "telegram.topic_delete";
/** Lease a deletion claim long enough for a bounded remote delete + crash window. */
const TELEGRAM_DELETION_LEASE_MS = 60_000;
const TELEGRAM_DELETION_RETRY_MS = 1_000;

function topicDeleteEffectId(sessionId: string, topicId: string, leaseId: string): string {
	// Scope terminal effects to the exact registration generation. Reusing a
	// session or topic id under a fresh lease must never inherit an old terminal
	// deletion record.
	return `${TELEGRAM_TOPIC_DELETE_KIND}:${sessionId}:${topicId}:${leaseId}`;
}
/** Payload of a telegram topic-delete effect. Provider identifiers only. */
interface TelegramTopicDeletePayload {
	chatId: string;
	topicId: string;
	/**
	 * Persisted registration lease this deletion was authorized under. Crash
	 * replay and selective roots compaction validate it so a fresh registration
	 * (different lease) is never compacted or short-circuited.
	 */
	leaseId: string;
}
function isTelegramTopicDeletePayload(value: unknown): value is TelegramTopicDeletePayload {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const payload = value as Partial<TelegramTopicDeletePayload>;
	return isNonEmptyString(payload.chatId) && isCanonicalTopicId(payload.topicId) && isNonEmptyString(payload.leaseId);
}
/** True while a topic deletion has not completed local crash reconciliation. */
async function hasUnreconciledDeletionClaim(agentDir: string, sessionId: string): Promise<boolean> {
	const journal = new ChatEffectJournal({ agentDir, transport: "telegram" });
	const effects = await journal.list();
	return effects.some(
		e =>
			e.transport === "telegram" &&
			e.kind === TELEGRAM_TOPIC_DELETE_KIND &&
			e.sessionId === sessionId &&
			(e.state !== "terminal" || !e.receipt?.status?.startsWith("reconciled")),
	);
}
class TelegramDeletionInProgressError extends Error {}

function telegramAdmissionLockPath(agentDir: string, sessionId: string): string {
	const key = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
	return path.join(daemonPaths(agentDir).dir, `telegram-admission-${key}`);
}

export async function registerNotificationRoot(input: {
	settings: Settings;
	cwd: string;
	sessionId: string;
	fs?: TelegramDaemonFs;
	now?: () => number;
	randomId?: () => string;
}): Promise<{ root: string; leaseId: string }> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	await ensureDir(fsImpl, paths.dir);
	// Canonicalize the workspace first so a not-yet-created state directory still
	// inherits realpath identity from a symlinked workspace. Canonicalize the full
	// root again when it already exists (including a symlinked state directory).
	const root = await canonicalNotificationRoot(fsImpl, input.cwd);
	const now = input.now ?? Date.now;
	// A FRESH leaseId on every registration is the registration generation: it
	// invalidates any orphan candidate an older registration established, so a
	// session restart cancels a stale reap. Idempotent re-registrations refresh
	// the same lease slot under the bounded roots lock.
	const leaseId = input.randomId?.() ?? crypto.randomBytes(12).toString("base64url");
	const refreshedAt = now();
	if (!isNonEmptyString(leaseId) || !isNonNegativeSafeInteger(refreshedAt)) {
		throw new Error("Telegram notification root registration requires a valid lease");
	}
	let deletionInProgress = false;
	await withFileLock(
		telegramAdmissionLockPath(input.settings.getAgentDir(), input.sessionId),
		async () => {
			if (await hasUnreconciledDeletionClaim(input.settings.getAgentDir(), input.sessionId)) {
				deletionInProgress = true;
				return;
			}
			await mutateRootsRegistry(fsImpl, paths.roots, view => {
				addRawRoot(view.raw, root);
				setRawSessionMapping(view.raw, input.sessionId, root);
				setRawLease(view.raw, input.sessionId, { leaseId, refreshedAt });
				return true;
			});
		},
		{ staleMs: 10_000 },
	);
	if (deletionInProgress) throw new TelegramDeletionInProgressError();
	// Return the exact admission identity (canonical root + lease) so callers
	// propagate the bound generation rather than re-reading an unbound current
	// registry value later.
	return { root, leaseId };
}

function notificationRootForCwd(cwd: string): string {
	return path.join(cwd, ".gjc", "state");
}
/**
 * Canonicalize an authority path through its longest existing ancestor, so a
 * workspace/state directory that is created after registration retains the
 * same identity (including `/var`→`/private/var`-style host aliases). Every
 * non-ENOENT resolution failure is ambiguous and fails closed.
 */
async function canonicalizePath(fsImpl: TelegramDaemonFs, target: string): Promise<string> {
	const lexical = path.resolve(target);
	const realpath = fsImpl.realpath;
	if (!realpath) return lexical;
	const missingParts: string[] = [];
	let cursor = lexical;
	while (true) {
		try {
			const canonicalAncestor = await realpath(cursor);
			return path.join(canonicalAncestor, ...missingParts);
		} catch (error) {
			if (!isENOENTError(error)) throw error;
			const parent = path.dirname(cursor);
			if (parent === cursor) return lexical;
			missingParts.unshift(path.basename(cursor));
			cursor = parent;
		}
	}
}

async function canonicalNotificationRoot(fsImpl: TelegramDaemonFs, cwd: string): Promise<string> {
	const canonicalCwd = await canonicalizePath(fsImpl, cwd);
	return canonicalizePath(fsImpl, notificationRootForCwd(canonicalCwd));
}

/**
 * Admission identity bound immutably to a connected {@link SessionSocket} at
 * connect time. The close/delete path uses these bound values and NEVER
 * re-reads the current registry, so a predecessor socket cannot be upgraded by
 * a successor registration's lease/root.
 */
interface SessionAdmissionIdentity {
	/** Realpath-equivalent root this socket was admitted under. */
	canonicalRoot: string;
	/** Registration lease stamped at admission (registration generation). */
	leaseId: string;
}

function ownerIdentityMatches(state: DaemonState, tokenFingerprint: string, chatId: string): boolean {
	return state.tokenFingerprint === tokenFingerprint && state.chatId === chatId;
}

function liveOwnerUsesDifferentIdentity(input: {
	state: DaemonState | undefined;
	tokenFingerprint: string;
	chatId: string;
	pidAlive: (pid: number) => boolean;
}): boolean {
	const { state } = input;
	return Boolean(
		state &&
			state.version === DAEMON_VERSION &&
			!ownerIdentityMatches(state, input.tokenFingerprint, input.chatId) &&
			input.pidAlive(state.pid),
	);
}

export function isFreshLiveOwner(input: {
	state: DaemonState | undefined;
	now: number;
	tokenFingerprint: string;
	chatId: string;
	pidAlive: (pid: number) => boolean;
}): boolean {
	const { state } = input;
	return Boolean(
		state &&
			state.version === DAEMON_VERSION &&
			ownerIdentityMatches(state, input.tokenFingerprint, input.chatId) &&
			input.now - state.heartbeatAt <= HEARTBEAT_TTL_MS &&
			input.pidAlive(state.pid),
	);
}

export async function acquireDaemonOwnership(input: {
	settings: Settings;
	roots?: string[];
	tokenFingerprint: string;
	chatId: string;
	fs?: TelegramDaemonFs;
	now?: () => number;
	pid?: number;
	pidAlive?: (pid: number) => boolean;
	randomId?: () => string;
}): Promise<{
	acquired: boolean;
	ownerId?: string;
	attached?: boolean;
	blocked?: boolean;
	reason?: "identity_mismatch";
	reloadRequired?: boolean;
}> {
	const fsImpl = input.fs ?? nodeFs;
	const now = input.now ?? Date.now;
	const pid = input.pid ?? process.pid;
	const pidAlive = input.pidAlive ?? defaultPidAlive;
	const paths = daemonPaths(input.settings.getAgentDir());
	await ensureDir(fsImpl, paths.dir);
	const ownerId = input.randomId?.() ?? `${pid}-${now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	const roots = input.roots ?? (await readJson<{ roots?: string[] }>(fsImpl, paths.roots))?.roots ?? [];

	// A fresh, identity-matching live owner running an OLDER generation than this
	// build cannot serve our newer wire frames; signal a reload instead of a
	// silent attach. Newer/equal generations attach as before (no downgrade).
	const attachDecision = (
		state: DaemonState | undefined,
	): { acquired: false; attached: boolean; reloadRequired?: boolean } | undefined => {
		if (
			!isFreshLiveOwner({
				state,
				now: now(),
				tokenFingerprint: input.tokenFingerprint,
				chatId: input.chatId,
				pidAlive,
			})
		) {
			return undefined;
		}
		return (state?.generation ?? 0) < DAEMON_GENERATION
			? { acquired: false, attached: false, reloadRequired: true }
			: { acquired: false, attached: true };
	};
	const existing = await readJson<DaemonState>(fsImpl, paths.state);
	if (
		liveOwnerUsesDifferentIdentity({
			state: existing,
			tokenFingerprint: input.tokenFingerprint,
			chatId: input.chatId,
			pidAlive,
		})
	) {
		return { acquired: false, blocked: true, reason: "identity_mismatch" };
	}
	const existingDecision = attachDecision(existing);
	if (existingDecision) return existingDecision;
	if (await tryOpenWx(fsImpl, paths.lock)) {
		await writeJsonAtomic(fsImpl, paths.state, {
			pid,
			ownerId,
			tokenFingerprint: input.tokenFingerprint,
			chatId: input.chatId,
			startedAt: now(),
			heartbeatAt: now(),
			roots,
			version: DAEMON_VERSION,
			generation: DAEMON_GENERATION,
		} satisfies DaemonState);
		return { acquired: true, ownerId };
	}
	const afterLock = await readJson<DaemonState>(fsImpl, paths.state);
	if (
		liveOwnerUsesDifferentIdentity({
			state: afterLock,
			tokenFingerprint: input.tokenFingerprint,
			chatId: input.chatId,
			pidAlive,
		})
	) {
		return { acquired: false, blocked: true, reason: "identity_mismatch" };
	}
	const afterLockDecision = attachDecision(afterLock);
	if (afterLockDecision) return afterLockDecision;
	if (!afterLock) return { acquired: false, attached: true };
	if (!(await tryOpenWx(fsImpl, paths.steal))) return { acquired: false, attached: true };
	try {
		const rechecked = await readJson<DaemonState>(fsImpl, paths.state);
		const recheckedDecision = attachDecision(rechecked);
		if (recheckedDecision) return recheckedDecision;
		if (
			liveOwnerUsesDifferentIdentity({
				state: rechecked,
				tokenFingerprint: input.tokenFingerprint,
				chatId: input.chatId,
				pidAlive,
			})
		) {
			return { acquired: false, blocked: true, reason: "identity_mismatch" };
		}
		if (rechecked && pidAlive(rechecked.pid)) {
			return { acquired: false, attached: true };
		}
		await fsImpl.unlink(paths.lock).catch(() => undefined);
		if (!(await tryOpenWx(fsImpl, paths.lock))) return { acquired: false, attached: true };
		await writeJsonAtomic(fsImpl, paths.state, {
			pid,
			ownerId,
			tokenFingerprint: input.tokenFingerprint,
			chatId: input.chatId,
			startedAt: now(),
			heartbeatAt: now(),
			roots,
			version: DAEMON_VERSION,
			generation: DAEMON_GENERATION,
		} satisfies DaemonState);
		return { acquired: true, ownerId };
	} finally {
		await fsImpl.unlink(paths.steal).catch(() => undefined);
	}
}

export async function renewDaemonHeartbeat(input: {
	settings: Settings;
	ownerId: string;
	fs?: TelegramDaemonFs;
	now?: () => number;
	pid?: number;
}): Promise<boolean> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	const state = await readJson<DaemonState>(fsImpl, paths.state);
	if (!state || state.ownerId !== input.ownerId) return false;
	await writeJsonAtomic(fsImpl, paths.state, {
		...state,
		pid: input.pid ?? state.pid,
		heartbeatAt: (input.now ?? Date.now)(),
	});
	return true;
}

export async function releaseDaemonOwnership(input: {
	settings: Settings;
	ownerId: string;
	fs?: TelegramDaemonFs;
	now?: () => number;
}): Promise<void> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	const state = await readJson<DaemonState>(fsImpl, paths.state);
	if (state?.ownerId !== input.ownerId) return;
	await writeJsonAtomic(fsImpl, paths.state, { ...state, stoppedAt: (input.now ?? Date.now)() });
	await fsImpl.unlink(paths.lock).catch(() => undefined);
}

/** Read the persisted daemon ownership state (or undefined when absent). */
export async function readDaemonState(
	settings: Settings,
	fs: TelegramDaemonFs = nodeFs,
): Promise<DaemonState | undefined> {
	return readJson<DaemonState>(fs, daemonPaths(settings.getAgentDir()).state);
}

/** Read the persisted notification roots list. */
export async function readDaemonRoots(settings: Settings, fs: TelegramDaemonFs = nodeFs): Promise<string[]> {
	const roots = await readJson<{ roots?: string[] }>(fs, daemonPaths(settings.getAgentDir()).roots);
	return roots?.roots ?? [];
}

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** True for AbortError-shaped rejections raised when an in-flight fetch is aborted. */
function isAbortError(err: unknown): boolean {
	return err instanceof Error && (err.name === "AbortError" || /\baborted\b/i.test(err.message));
}

function defaultDaemonSpawn(
	command: string,
	args: string[],
	opts: { detached: boolean; stdio: "ignore"; logPath?: string },
): SpawnResult {
	// Redirect the detached daemon's stdout/stderr to a log file so failures
	// (e.g. a rejected sendMessage) are diagnosable instead of vanishing.
	let stdio: "ignore" | ["ignore", number, number] = opts.stdio;
	if (opts.logPath) {
		try {
			fs.mkdirSync(path.dirname(opts.logPath), { recursive: true, mode: 0o700 });
			const fd = fs.openSync(opts.logPath, "a", 0o600);
			stdio = ["ignore", fd, fd];
		} catch {
			// Fall back to ignoring output if the log file cannot be opened.
		}
	}
	const child = childProcessSpawn(command, args, { detached: opts.detached, stdio });
	// Best-effort autostart: a spawn failure must never crash the host session.
	child.on("error", () => undefined);
	return { unref: () => child.unref() };
}

export interface TelegramSpawnOwnerInput {
	settings: Settings;
	roots?: string[];
	tokenFingerprint: string;
	chatId: string;
}

export interface TelegramSpawnOwnerResult {
	result: EnsureDaemonResult;
	ownerId?: string;
	runtime: DaemonRuntimeInfo;
	warnings: string[];
	/**
	 * Set when ownership was NOT acquired because a still-live owner is running an
	 * older daemon generation. The caller must hand off via a reload rather than
	 * attach; see {@link ensureTelegramDaemonRunning}.
	 */
	reloadRequired?: boolean;
}

/**
 * Build the detached spawn command/args for the daemon-internal entrypoint.
 * Source mode prepends the entry script so the respawn loads edited source;
 * a compiled binary self-spawns its own subcommand directly.
 */
export function buildTelegramDaemonSpawnArgs(input: { execPath?: string; ownerId: string; agentDir: string }): {
	command: string;
	args: string[];
	runtime: DaemonRuntimeInfo;
} {
	const rt = resolveGjcRuntimeSpawnInfo(input.execPath ?? process.execPath);
	const args = [
		...rt.argsPrefix,
		"notify",
		"daemon-internal",
		"--owner-id",
		input.ownerId,
		"--agent-dir",
		input.agentDir,
	];
	const runtime: DaemonRuntimeInfo = {
		mode: rt.mode,
		execPath: rt.execPath,
		reloadPicksUpSourceEdits: rt.reloadPicksUpSourceEdits,
		warning: rt.warning,
	};
	return { command: rt.execPath, args, runtime };
}

/**
 * Acquire ownership for the given Telegram identity and, if acquired, spawn a
 * fresh detached daemon process. Does NOT register notification roots; callers
 * that own a session (autostart) register roots separately, while reload reuses
 * already-persisted roots.
 */
export async function spawnTelegramDaemonOwner(
	input: TelegramSpawnOwnerInput,
	deps: TelegramDaemonDeps = {},
): Promise<TelegramSpawnOwnerResult> {
	const agentDir = input.settings.getAgentDir();
	const execPath = deps.execPath ?? process.execPath;
	const ownership = await acquireDaemonOwnership({
		settings: input.settings,
		roots: input.roots,
		tokenFingerprint: input.tokenFingerprint,
		chatId: input.chatId,
		fs: deps.fs,
		now: deps.now,
		pid: deps.pid,
		pidAlive: deps.pidAlive,
		randomId: deps.randomId,
	});
	// One source of truth for runtime detection + spawn args (no duplicate resolve).
	const { command, args, runtime } = buildTelegramDaemonSpawnArgs({
		execPath,
		ownerId: ownership.ownerId ?? "",
		agentDir,
	});
	if (!ownership.acquired) {
		if (ownership.blocked) {
			return {
				result: "blocked",
				runtime,
				warnings: ["live telegram daemon uses a different bot token or chat; refusing to attach"],
			};
		}
		return { result: "attached", runtime, warnings: [], reloadRequired: ownership.reloadRequired };
	}
	const spawnImpl = deps.spawn ?? defaultDaemonSpawn;
	const child = spawnImpl(command, args, {
		detached: true,
		stdio: "ignore",
		logPath: path.join(daemonPaths(agentDir).dir, "daemon.log"),
	});
	child?.unref?.();
	return { result: "owner_spawned", ownerId: ownership.ownerId, runtime, warnings: [] };
}

export async function ensureTelegramDaemonRunning(
	input: {
		settings: Settings;
		cwd: string;
		sessionId: string;
		/**
		 * Synchronous callback invoked with the exact registration identity
		 * `{canonicalRoot, leaseId}` immediately after the registration lease is
		 * committed, BEFORE this function returns. The caller uses it to stamp the
		 * immutable publication identity onto the endpoint file so the daemon
		 * binds endpoint-carried identity rather than inferring a lease from the
		 * registry. Not invoked when registration is deferred/blocked/disabled.
		 */
		onRegistered?: (identity: { canonicalRoot: string; leaseId: string }) => void;
	},
	deps: TelegramDaemonDeps = {},
): Promise<EnsureDaemonResult> {
	const cfg = getNotificationConfig(input.settings);
	if (!isTelegramConfigured(cfg)) return "disabled";
	const agentDir = input.settings.getAgentDir();
	// Use the same two-step canonical state-root identity as registration.
	const fsImpl = deps.fs ?? nodeFs;
	const root = await canonicalNotificationRoot(fsImpl, input.cwd);
	const fp = tokenFingerprint(cfg.botToken);

	// An unresolved claim must have a daemon owner available to finish crash
	// reconciliation, but the caller must not publish a fresh endpoint yet.
	if (await hasUnreconciledDeletionClaim(agentDir, input.sessionId)) {
		const recoveryOwner = await spawnTelegramDaemonOwner(
			{ settings: input.settings, roots: [root], tokenFingerprint: fp, chatId: cfg.chatId },
			deps,
		);
		if (recoveryOwner.result === "blocked") {
			logger.warn(`notifications: failed to ensure Telegram daemon: ${recoveryOwner.warnings.join("; ")}`);
			return "blocked";
		}
		if (recoveryOwner.reloadRequired) await reloadStaleGenerationOwner(input.settings, deps);
		logger.warn(
			`notifications: deferring Telegram daemon registration for ${input.sessionId}: topic deletion reconciliation in progress`,
		);
		return "deferred";
	}

	const spawned = await spawnTelegramDaemonOwner(
		{ settings: input.settings, roots: [root], tokenFingerprint: fp, chatId: cfg.chatId },
		deps,
	);
	if (spawned.result === "blocked") {
		logger.warn(`notifications: failed to ensure Telegram daemon: ${spawned.warnings.join("; ")}`);
		return spawned.result;
	}
	// Commit the registration lease only after ownership/attachment succeeds and
	// before the caller publishes its SDK endpoint. A mismatched live owner must
	// not leave behind a root or lease that can later authorize cleanup.
	try {
		const registration = await registerNotificationRoot({ ...input, fs: deps.fs });
		// Propagate the exact admission identity synchronously so the caller
		// stamps it onto the endpoint file BEFORE any broker registration or
		// identity frame. The daemon binds this endpoint-carried identity, never
		// inferring a lease from the current registry.
		input.onRegistered?.({ canonicalRoot: registration.root, leaseId: registration.leaseId });
	} catch (error) {
		if (error instanceof TelegramDeletionInProgressError) return "deferred";
		throw error;
	}
	if (spawned.reloadRequired) {
		// The replacement daemon reads the registration committed above.
		await reloadStaleGenerationOwner(input.settings, deps);
		return "owner_spawned";
	}
	return spawned.result;
}

/**
 * Reload a still-live owner running an older daemon generation through the
 * cooperative SIGTERM/control handoff. Lazily imports the controller to avoid a
 * static import cycle (the controller module imports ownership helpers here).
 */
async function reloadStaleGenerationOwner(settings: Settings, deps: TelegramDaemonDeps): Promise<void> {
	const { TelegramDaemonController } = await import("./telegram-daemon-control");
	const controller = new TelegramDaemonController(settings, {
		fs: deps.fs,
		now: deps.now,
		pidAlive: deps.pidAlive,
		sendSignal: deps.sendSignal,
		spawn: deps.spawn,
		execPath: deps.execPath,
		ownerPid: deps.pid,
		randomId: deps.randomId,
		sleep: deps.sleep,
		waitStepMs: deps.waitStepMs,
	});
	await controller.reload();
}

export interface BotApi {
	call(method: string, body: unknown, opts?: { signal?: AbortSignal; noRetry?: boolean }): Promise<unknown>;
}

export interface TelegramTransportOptions {
	botToken: string;
	apiBase?: string;
	fetchImpl?: typeof fetch;
	setTimeoutImpl?: typeof setTimeout;
}

/** Telegram Bot API transport: HTTP JSON/multipart details stay out of daemon orchestration. */
export class TelegramBotTransport implements BotApi {
	#opts: TelegramTransportOptions;

	constructor(opts: TelegramTransportOptions) {
		this.#opts = opts;
	}

	async call(method: string, body: unknown, opts?: { signal?: AbortSignal; noRetry?: boolean }): Promise<unknown> {
		const apiBase = this.#opts.apiBase ?? "https://api.telegram.org";
		const url = `${apiBase}/bot${this.#opts.botToken}/${method}`;
		const fetchImpl = this.#opts.fetchImpl ?? fetch;
		const setTimeoutImpl = this.#opts.setTimeoutImpl ?? setTimeout;
		const sleep = (ms: number) => new Promise<void>(resolve => setTimeoutImpl(resolve, ms));
		// sendPhoto with base64 bytes must be a multipart upload (Telegram does
		// not accept base64 in JSON). Other methods stay JSON.
		const photoBody = body as { photo?: unknown; mime?: unknown } | null;
		if (method === "sendPhoto" && photoBody && typeof photoBody.photo === "string") {
			const b = body as {
				chat_id: unknown;
				message_thread_id?: unknown;
				photo: string;
				mime?: string;
				caption?: string;
				parse_mode?: string;
			};
			const form = new FormData();
			form.set("chat_id", String(b.chat_id));
			if (b.message_thread_id !== undefined) form.set("message_thread_id", String(b.message_thread_id));
			if (b.caption) form.set("caption", b.caption);
			if (b.parse_mode) form.set("parse_mode", String(b.parse_mode));
			form.set("photo", new Blob([Buffer.from(b.photo, "base64")], { type: b.mime ?? "image/png" }), "image");
			const res = await fetchWithRetry(
				fetchImpl,
				url,
				{ method: "POST", body: form, signal: opts?.signal },
				sleep,
				opts?.noRetry ? 1 : undefined,
			);
			return res.json();
		}
		const docBody = body as { document?: unknown } | null;
		if (method === "sendDocument" && docBody && typeof docBody.document === "string") {
			const b = body as {
				chat_id: unknown;
				message_thread_id?: unknown;
				document: string;
				mime?: string;
				fileName?: string;
				caption?: string;
				parse_mode?: string;
			};
			const form = new FormData();
			form.set("chat_id", String(b.chat_id));
			if (b.message_thread_id !== undefined) form.set("message_thread_id", String(b.message_thread_id));
			if (b.caption) form.set("caption", b.caption);
			if (b.parse_mode) form.set("parse_mode", String(b.parse_mode));
			form.set(
				"document",
				new Blob([Buffer.from(b.document, "base64")], { type: b.mime ?? "application/octet-stream" }),
				b.fileName ?? "file",
			);
			const res = await fetchWithRetry(
				fetchImpl,
				url,
				{ method: "POST", body: form, signal: opts?.signal },
				sleep,
				opts?.noRetry ? 1 : undefined,
			);
			return res.json();
		}
		const res = await fetchWithRetry(
			fetchImpl,
			url,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: opts?.signal,
			},
			sleep,
			opts?.noRetry ? 1 : undefined,
		);
		return res.json();
	}
}

type PairedChatPrivacy = "private" | "non-private" | "indeterminate";

export type TelegramUpdateOutcome = "consumed" | "retry";

export interface TelegramUpdatePollerOptions {
	botApi: BotApi;
	runtime: NotificationOperatorRuntime;
	backoff: OperatorBackoffPolicy;
	processUpdate: (update: unknown) => Promise<TelegramUpdateOutcome>;
}

/** Owns getUpdates offset, conflict backoff, and per-update error isolation. */
export class TelegramUpdatePoller {
	#offset = 0;
	#opts: TelegramUpdatePollerOptions;

	constructor(opts: TelegramUpdatePollerOptions) {
		this.#opts = opts;
	}

	async pollOnce(signal?: AbortSignal): Promise<number> {
		let body: {
			ok?: boolean;
			error_code?: number;
			description?: string;
			result?: Array<{ update_id: number } & Record<string, unknown>>;
		};
		try {
			body = (await this.#opts.botApi.call(
				"getUpdates",
				{ offset: this.#offset, timeout: 25, allowed_updates: ["message", "callback_query"] },
				{ signal },
			)) as typeof body;
		} catch (err) {
			// A cooperative stop aborts the in-flight long poll; treat as a clean wake.
			if (isAbortError(err)) return 0;
			// A transient Telegram API failure must never crash the daemon.
			logger.error("notifications daemon: getUpdates failed", { error: String(err) });
			await this.#opts.runtime.sleep(POLL_BACKOFF_MS, signal);
			return 0;
		}
		// Telegram allows only one active getUpdates poller per bot. A 409 means
		// another poller is live; back off boundedly instead of hot-looping.
		if (body && body.ok === false && (body.error_code === 409 || /409|conflict/i.test(body.description ?? ""))) {
			const backoffMs = this.#opts.backoff.next();
			logger.error(
				`notifications daemon: Telegram getUpdates 409 conflict (${body.description ?? "no description"}); backing off ${backoffMs}ms`,
			);
			await this.#opts.runtime.sleep(backoffMs, signal);
			return 0;
		}
		this.#opts.backoff.reset();
		for (const update of body.result ?? []) {
			try {
				const outcome = await this.#opts.processUpdate(update);
				if (outcome === "retry") {
					await this.#opts.runtime.sleep(this.#opts.backoff.next(), signal);
					break;
				}
				this.#offset = update.update_id + 1;
			} catch (err) {
				logger.error("notifications daemon: handleTelegramUpdate failed", { error: String(err) });
				this.#offset = update.update_id + 1;
			}
		}
		return body.result?.length ?? 0;
	}
}

/** Mutable dispatch state shared by session frames and inbound Telegram updates. */
export class TelegramEventDispatchState {
	readonly busy = new Set<string>();
	readonly inboundReactions = new Map<number, { messageId: number; sessionId: string; generation: number }>();
	readonly seenUpdateIds = new Set<number>();
}

/**
 * Cooperative control seam for the daemon run loop. Implemented by the
 * daemon-internal CLI / controller against the owner-scoped control-request
 * file so the daemon does not import the control module directly.
 */
export interface DaemonControlHooks {
	/** Returns true when a stop/reload has been requested for this owner. */
	shouldStop(ownerId: string): Promise<boolean>;
	/** Clear a consumed control request (best-effort). */
	clear?(ownerId: string): Promise<void>;
}

export interface TelegramDaemonOptions {
	settings: Settings;
	ownerId: string;
	botToken: string;
	chatId: string;
	apiBase?: string;
	fetchImpl?: typeof fetch;
	fs?: TelegramDaemonFs;
	WebSocketImpl?: typeof WebSocket;
	now?: () => number;
	setTimeoutImpl?: typeof setTimeout;
	clearTimeoutImpl?: typeof clearTimeout;
	setIntervalImpl?: typeof setInterval;
	clearIntervalImpl?: typeof clearInterval;
	idleTimeoutMs?: number;
	scanIntervalMs?: number;
	pid?: number;
	/** Liveness probe for skipping dead-PID endpoint records in {@link TelegramNotificationDaemon.scanRoots}. */
	pidAlive?: (pid: number) => boolean;
	botApi?: BotApi;
	control?: DaemonControlHooks;
	/**
	 * Factory for the session-lifecycle control server. Defaults to the real
	 * native NotificationControlServer; tests inject a fake to verify the
	 * owner-bound start/stop lifecycle without a socket. When `undefined` AND no
	 * default applies (e.g. lifecycle control disabled), no control server starts.
	 */
	createLifecycleControlServer?: LifecycleControlServerFactory | null;
	/** Rich text promotion (enabled by default; see rich-render.ts). */
	rich?: { enabled: boolean };
	/** Opt-in rich-draft streaming of live turn previews (off by default; see rich-draft.ts). */
	richDraft?: { enabled: boolean };
	/**
	 * Per-session Telegram forum-topic naming. `nameTemplate` supports the
	 * `{repo}`, `{branch}`, and `{title}` placeholders; unset preserves the
	 * built-in `{repo}/{branch} - {title}` composition and its fallbacks.
	 */
	topics?: { nameTemplate?: string };
	/**
	 * Bounded AbortSignal timeout (ms) for a single `deleteForumTopic` call.
	 * Defaults to {@link TOPIC_DELETE_TIMEOUT_MS}. Injectable so tests drive the
	 * deletion-timeout seam deterministically.
	 */
	topicDeleteTimeoutMs?: number;
	/**
	 * Injectable durable deletion-claim journal (per-session topic-delete state
	 * machine). Defaults to a {@link ChatEffectJournal} rooted at the canonical
	 * `agentDir/sdk/daemons/telegram` store. Tests inject a shared journal to
	 * assert crash-replay and terminal compaction.
	 */
	deletionJournal?: ChatEffectJournal;
}

interface SessionSocket {
	sessionId: string;
	token: string;
	/** Exact endpoint incarnation (`url + token`) bound at admission. */
	endpointKey: string;
	/**
	 * Canonical (realpath-equivalent) root this socket was admitted under.
	 * Bound at connect time from the session's mapped registry root; the close
	 * path revalidates against the CURRENT mapped root and revokes on mismatch.
	 */
	canonicalRoot: string;
	/**
	 * Registration lease bound at admission. The close/delete path uses this
	 * immutable value and never re-reads the current registry lease, so a
	 * predecessor socket cannot delete/compact under a successor lease.
	 */
	leaseId: string;
	ws: WebSocket;
	pending: Map<string, { sessionId: string; actionId: string }>;
	/** True once the server advertised the `client_ping_pong` capability. */
	capable: boolean;
	/** Timestamp (via opts.now) of the last received pong; seeds the TTL window. */
	lastPongAt: number;
	/** Nonce of the most recent in-flight ping, if any. */
	awaitingNonce: string | undefined;
	/** Per-session liveness interval handle (only set for capable sessions). */
	pingTimer: ReturnType<typeof setInterval> | undefined;
	/** Correlation id for the startup replay barrier. */
	replayId: string;
	/** Queues live frames until startup replay is applied. */
	replayPending: boolean;
	replayQueue: Record<string, unknown>[];
}

interface PendingThreadedFrame {
	send: ThreadedSend;
	msg: Record<string, unknown>;
}

type SelectedAckOutcome =
	| { status: "delivered"; messageId: number }
	| { status: "failed"; reason: "route_missing" | "expired" | "cancelled" | "telegram_rejected" }
	| { status: "unknown"; reason: "transport_ambiguous" | "shutdown" };

interface SelectedAckQueueItem {
	pendingKey: string;
	cacheKey: string;
	itemId: string;
	requestId: string;
	commitKey: string;
	session: SessionSocket;
	state: "queued" | "dispatching" | "sending";
	controller?: AbortController;
	followers: Array<{ pendingKey: string; requestId: string; commitKey: string }>;
}

interface TelegramQueuePayload {
	send: ThreadedSend;
	topicId?: string;
	selectedAck?: SelectedAckQueueItem;
	/**
	 * Per-session topic generation stamped at admission time (F002). Every
	 * delivery revalidates this against the live generation before any provider
	 * call; a frame whose generation no longer matches (topic fenced for
	 * deletion or regenerated) is dropped. Absent for flat (non-topic) sends.
	 */
	topicGeneration?: number;
}

export class TelegramNotificationDaemon {
	readonly aliasTable: AliasTable;
	readonly messageRoutes = new Map<string | number, CallbackRoute | Omit<CallbackRoute, "answer">>();
	/** Telegram message id backing each streamed `${sessionId}:${coalesceKey}`, for in-place edits. */
	private readonly liveMessages = new Map<string, number>();
	readonly sessions = new Map<string, SessionSocket>();
	private readonly runtime: NotificationOperatorRuntime;
	private readonly sessionRouter: OperatorEventRouter<SessionSocket>;
	private readonly pollConflictBackoff = new OperatorBackoffPolicy({ initialMs: 500, maxMs: 5_000 });
	private readonly loopBackoff = new OperatorBackoffPolicy({ initialMs: 250, maxMs: 4_000 });
	private running = false;
	private readonly fsImpl: TelegramDaemonFs;
	private readonly botApi: BotApi;
	private readonly providerBotApi: BotApi;
	private readonly topicOperations = new Map<string, number>();
	private readonly topicOperationWaiters = new Map<string, Set<() => void>>();
	private readonly closingSessions = new Set<string>();
	private readonly topicCreations = new Map<string, Promise<string | undefined>>();
	private readonly topics = new TopicRegistry();
	/** Serializes registry snapshots so an older atomic write cannot overwrite newer rename state. */
	private topicsPersistQueue: Promise<void> = Promise.resolve();
	/** Daemon edit attempts that can race an accepted user service message. */
	private readonly daemonRenameAttempts = new Map<string, number>();
	private readonly selectedAckPending = new Map<string, SelectedAckQueueItem>();
	private readonly pool: RateLimitPool<TelegramQueuePayload>;
	private readonly poller: TelegramUpdatePoller;
	private readonly dispatchState = new TelegramEventDispatchState();
	/** Original markdown of rich messages we sent (chat+message_id), for restoring reply context on inbound replies. */
	private readonly replyStore: ReplySentStore;
	/** Per-session debounce + monotonic draft-id state for opt-in draft streaming. */
	private readonly draftStream = new DraftStreamState();
	/** Identity-bearing sessions by repo/branch surface, used to avoid transient duplicate topics. */
	private readonly topicOwnerByIdentity = new Map<string, string>();
	/** Non-identity frames held until identity creates the correct thread. */
	private readonly pendingThreadedFrames = new Map<string, PendingThreadedFrame[]>();
	/** Endpoint generation tombstones for sessions that already sent session_closed. */
	private readonly closedEndpointKeys = new Map<string, string>();
	/**
	 * Per-session send-admission fence state (F002). `liveTopicGeneration` holds
	 * the generation stamped on the currently-live topic; a frame is admitted
	 * only while its stamped generation still matches it. `fencedTopicGeneration`
	 * records the generation being deleted so the fence is observable while a
	 * deletion is in flight; once deletion completes both are cleared, and a
	 * resumed topic receives a fresh generation a late enqueue can never match.
	 */
	private readonly liveTopicGeneration = new Map<string, number>();
	private readonly fencedTopicGeneration = new Map<string, number>();
	private readonly fencedTopicIds = new Set<string>();
	private topicGenerationCounter = 0;
	/** Per-session 429 retry_after backoff deadline (ms via opts.now). Seeded from
	 * the DURABLY persisted deletion-effect receipt on re-entry/restart so a
	 * crash never forgets an outstanding `retry_after` before re-calling the
	 * provider. See {@link performTopicDeletion}. */
	private readonly deletionRetryAfter = new Map<string, number>();
	/**
	 * Durable, fsynced per-session topic-deletion claim journal (F003/F004).
	 * Defaults to the canonical `agentDir/sdk/daemons/telegram` store; injectable
	 * for deterministic crash-replay/compaction tests.
	 */
	private readonly deletionJournal: ChatEffectJournal;
	/** True once the daemon has nudged the user to enable Threaded Mode. */
	private threadedFallbackNoticeSent = false;
	/** Sessions whose identity header was already sent flat (Threaded Mode off). */
	private readonly flatIdentitySent = new Set<string>();
	/** Cached result of whether the paired chat is a private chat (flat-fallback gate). */
	private pairedChatPrivate: boolean | undefined;
	/** Bot username from getMe, cached once at owner startup for group/forum command targeting. */
	private botUsername: string | undefined;
	/** Sessions whose agent loop is currently busy (drives the typing indicator). */
	private get busy(): Set<string> {
		return this.dispatchState.busy;
	}
	/** Inbound update id → originating Telegram message, for delivery reactions. */
	private get inboundReactions(): Map<number, { messageId: number; sessionId: string; generation: number }> {
		return this.dispatchState.inboundReactions;
	}
	/**
	 * The owner-bound session-lifecycle control server (create/close/resume).
	 * Started in {@link run} after ownership is confirmed (so exactly one owner
	 * ever runs one), stopped in run()'s finally on any exit path.
	 */
	private controlServer: LifecycleControlServer | undefined;
	/** True while lifecycle control is active, so the loop keeps polling at idle. */
	private lifecycleControlActive = false;
	/** Control token (in-memory) the loopback client presents; never persisted/logged. */
	private controlToken: string | undefined;
	/** Loopback WS client to the daemon's own control endpoint (Option A real wire path). */
	private controlClient: WebSocket | undefined;
	/** Pending lifecycle responses awaiting a control-endpoint reply, by requestId. */
	private readonly pendingLifecycle = new Map<
		string,
		{ resolve: (r: SessionLifecycleResponse) => void; timer: ReturnType<typeof setTimeout> }
	>();
	/** Monotonic counter for unique lifecycle request ids. */
	private lifecycleSeq = 0;
	/** Attempt tombstones live for the daemon lifetime so a commit key can never send twice. */
	private readonly selectedAckCache = new Map<string, SelectedAckOutcome>();
	private cacheSelectedAck(cacheKey: string, outcome: SelectedAckOutcome): void {
		this.selectedAckCache.set(cacheKey, outcome);
	}

	private getCachedSelectedAck(cacheKey: string): SelectedAckOutcome | undefined {
		return this.selectedAckCache.get(cacheKey);
	}
	private finishSelectedAck(item: SelectedAckQueueItem, outcome: SelectedAckOutcome): void {
		if (this.selectedAckPending.get(item.pendingKey) !== item) return;
		this.selectedAckPending.delete(item.pendingKey);
		for (const follower of item.followers) this.selectedAckPending.delete(follower.pendingKey);
		this.cacheSelectedAck(item.cacheKey, outcome);
		if (item.session.ws.readyState === WebSocket.OPEN) {
			for (const result of [{ requestId: item.requestId, commitKey: item.commitKey }, ...item.followers]) {
				item.session.ws.send(
					JSON.stringify({
						type: "ask_selected_ack_result",
						requestId: result.requestId,
						commitKey: result.commitKey,
						outcome,
					}),
				);
			}
		}
	}

	/**
	 * Cooperatively stop the daemon: set the stop flag and abort the in-flight
	 * long poll so the run loop wakes immediately instead of waiting out the
	 * ~25s getUpdates timeout. Safe to call from a signal handler.
	 */
	requestStop(_reason?: "reload" | "stop" | "signal"): void {
		for (const item of new Set(this.selectedAckPending.values())) {
			if (item.state === "queued") this.pool.removeById(item.itemId);
			else item.controller?.abort();
			this.finishSelectedAck(item, { status: "unknown", reason: "shutdown" });
		}
		this.runtime.requestStop();
		this.running = false;
	}

	/**
	 * Start the owner-bound lifecycle control server and wire it to the
	 * orchestrator. Called from {@link run} ONLY after ownership is confirmed, so
	 * exactly one owner ever starts exactly one control server (no second poller
	 * / 409). A control-server failure degrades gracefully: the daemon keeps
	 * serving notifications without lifecycle control. Returns true when started.
	 */
	private async startLifecycleControl(): Promise<boolean> {
		const factory =
			this.opts.createLifecycleControlServer === null
				? undefined
				: (this.opts.createLifecycleControlServer ?? createNativeControlServer);
		if (!factory) return false;
		let server: LifecycleControlServer | undefined;
		try {
			// High-entropy, in-memory control token (never persisted raw / logged).
			const token = crypto.randomBytes(32).toString("base64url");
			const agentDir = this.opts.settings.getAgentDir();
			server = factory({ token, ownerId: this.opts.ownerId, agentDir });
			const deps = buildOrchestratorDeps({
				pairedChatId: this.opts.chatId,
				agentNotificationsDir: daemonPaths(agentDir).dir,
				sessionsRoot: path.join(agentDir, "sessions"),
			});
			// Register the lifecycle-request handler BEFORE start(): the native
			// control server captures the callback at start time, so wiring must
			// precede start or forwarded requests never reach the orchestrator.
			attachLifecycleControl(server, deps);
			const endpoint = (await server.start()) as { url?: string } | undefined;
			this.controlServer = server;
			this.controlToken = token;
			// Option A: connect a loopback WS client to our own control endpoint so
			// parsed /session_* commands traverse the real authenticated wire path.
			// Mark control active ONLY after the client is open, so a first-poll
			// /session_create never races a still-CONNECTING socket.
			const opened = endpoint?.url ? await this.connectControlClient(endpoint.url, token) : false;
			this.lifecycleControlActive = opened;
			if (!opened) {
				logger.warn("notifications: lifecycle control client did not open; lifecycle commands disabled");
			}
			return opened;
		} catch (e) {
			// Never let lifecycle-control startup kill the notifications daemon.
			// Stop any partially-started server so it cannot leak.
			try {
				server?.stop();
			} catch {
				// best-effort
			}
			logger.warn(`notifications: lifecycle control failed to start: ${String(e)}`);
			this.controlServer = undefined;
			this.lifecycleControlActive = false;
			return false;
		}
	}

	/** Stop the lifecycle control server (idempotent); called from run()'s finally. */
	private stopLifecycleControl(): void {
		this.lifecycleControlActive = false;
		this.controlToken = undefined;
		const client = this.controlClient;
		this.controlClient = undefined;
		try {
			client?.close();
		} catch {
			// best-effort
		}
		// Reject any in-flight lifecycle requests so callers do not hang.
		for (const [requestId, pending] of this.pendingLifecycle) {
			clearTimeout(pending.timer);
			pending.resolve({
				type: "session_lifecycle_error",
				requestId,
				status: "error",
				reason: "terminal_uncertain",
				message: "control server stopped",
			});
		}
		this.pendingLifecycle.clear();
		const server = this.controlServer;
		this.controlServer = undefined;
		try {
			server?.stop();
		} catch (e) {
			logger.warn(`notifications: lifecycle control failed to stop cleanly: ${String(e)}`);
		}
	}

	/**
	 * Connect the loopback control client and resolve responses by requestId.
	 * Resolves true once the socket is OPEN (bounded), false on error/timeout, so
	 * the caller only marks lifecycle control active when commands can be sent.
	 */
	private connectControlClient(url: string, token: string): Promise<boolean> {
		return new Promise<boolean>(resolve => {
			let settled = false;
			const finish = (ok: boolean) => {
				if (settled) return;
				settled = true;
				resolve(ok);
			};
			try {
				const WsCtor = this.opts.WebSocketImpl ?? WebSocket;
				const client = new WsCtor(`${url}/?token=${encodeURIComponent(token)}`);
				this.controlClient = client;
				const openTimer = (this.opts.setTimeoutImpl ?? setTimeout)(() => finish(false), 5_000);
				client.addEventListener("open", () => {
					clearTimeout(openTimer);
					finish(true);
				});
				client.addEventListener("error", () => {
					clearTimeout(openTimer);
					finish(false);
				});
				client.addEventListener("message", (ev: MessageEvent) => {
					let msg: SessionLifecycleResponse;
					try {
						msg = JSON.parse(String((ev as { data: unknown }).data)) as SessionLifecycleResponse;
					} catch {
						return;
					}
					const requestId = (msg as { requestId?: string }).requestId;
					if (!requestId) return;
					const pending = this.pendingLifecycle.get(requestId);
					if (!pending) return;
					clearTimeout(pending.timer);
					this.pendingLifecycle.delete(requestId);
					pending.resolve(msg);
				});
			} catch (e) {
				logger.warn(`notifications: lifecycle control client failed to connect: ${String(e)}`);
				finish(false);
			}
		});
	}

	/** Send a lifecycle frame over the loopback client and await the response. */
	private submitLifecycleFrame(frame: SessionLifecycleRequest): Promise<SessionLifecycleResponse> {
		return new Promise<SessionLifecycleResponse>(resolve => {
			const client = this.controlClient;
			if (!client || client.readyState !== WebSocket.OPEN) {
				resolve({
					type: "session_lifecycle_error",
					requestId: frame.requestId,
					status: "error",
					reason: "terminal_uncertain",
					message: "lifecycle control unavailable",
				});
				return;
			}
			const timer = (this.opts.setTimeoutImpl ?? setTimeout)(() => {
				this.pendingLifecycle.delete(frame.requestId);
				resolve({
					type: "session_lifecycle_error",
					requestId: frame.requestId,
					status: "error",
					reason: "readiness_timeout",
					message: "lifecycle request timed out",
				});
			}, 120_000);
			this.pendingLifecycle.set(frame.requestId, { resolve, timer });
			try {
				client.send(JSON.stringify(frame));
			} catch (e) {
				clearTimeout(timer);
				this.pendingLifecycle.delete(frame.requestId);
				resolve({
					type: "session_lifecycle_error",
					requestId: frame.requestId,
					status: "error",
					reason: "terminal_uncertain",
					message: `lifecycle send failed: ${String(e)}`,
				});
			}
		});
	}

	private nextLifecycleRequestId(): string {
		this.lifecycleSeq += 1;
		return `tg-${this.opts.ownerId}-${this.lifecycleSeq}-${crypto.randomBytes(4).toString("hex")}`;
	}

	/** Build an authenticated lifecycle frame from a parsed command + identity. */
	private buildLifecycleFrame(
		parsed:
			| { kind: "create"; target: SessionCreateTarget; modelPreset?: string }
			| { kind: "close"; target: SessionCloseTarget }
			| { kind: "resume"; target: SessionResumeTarget },
		updateId: number,
	): SessionLifecycleRequest {
		const requestId = this.nextLifecycleRequestId();
		const token = this.controlToken ?? "";
		const chatId = this.opts.chatId;
		if (parsed.kind === "create") {
			return {
				type: "session_create",
				requestId,
				lifecycleRequestId: requestId,
				intendedSessionId: `s${crypto.randomBytes(6).toString("hex")}`,
				updateId,
				chatId,
				token,
				target: parsed.target,
				modelPreset: parsed.modelPreset,
			};
		}
		if (parsed.kind === "close") {
			return { type: "session_close", requestId, updateId, chatId, token, target: parsed.target, force: true };
		}
		return { type: "session_resume", requestId, updateId, chatId, token, target: parsed.target };
	}

	/**
	 * Handle a paired-chat /session_* command: validate (shared validator),
	 * route to the control endpoint, and reply with the outcome. Returns true
	 * when the message was a lifecycle command (so the caller stops processing).
	 */
	private async handleLifecycleCommand(
		text: string | undefined,
		updateId: number | undefined,
		threadId: number | undefined,
		commandCtx: { chatType?: string; botUsername?: string },
	): Promise<boolean> {
		if (!isLifecycleCommandText(text, commandCtx)) return false;
		if (!(await this.pairedChatIsPrivate())) return true;
		const reply = async (body: string): Promise<void> => {
			for (const text of splitTelegramPlainText(body)) {
				await this.botApi
					.call("sendMessage", {
						chat_id: this.opts.chatId,
						...(threadId !== undefined ? { message_thread_id: threadId } : {}),
						text,
					})
					.catch(() => undefined);
			}
		};
		const replyHtml = async (body: string): Promise<void> => {
			for (const text of splitTelegramHtml(body)) {
				await this.botApi
					.call("sendMessage", {
						chat_id: this.opts.chatId,
						...(threadId !== undefined ? { message_thread_id: threadId } : {}),
						text,
						parse_mode: TELEGRAM_PARSE_MODE,
					})
					.catch(() => undefined);
			}
		};

		const parsed = parseLifecycleCommand(text, commandCtx);
		if (parsed.kind === "none") return false;
		if (!this.lifecycleControlActive) {
			await reply("Session lifecycle control is not available right now.");
			return true;
		}
		if (updateId !== undefined && this.dispatchState.seenUpdateIds.has(updateId)) return true;
		if (updateId !== undefined) await this.rememberSeenUpdateId(updateId);

		if (parsed.kind === "usage" || parsed.kind === "reject") {
			await reply(parsed.message);
			return true;
		}
		if (parsed.kind === "recent") {
			const recent = listRecentSessions({
				sessionsRoot: path.join(this.opts.settings.getAgentDir(), "sessions"),
				limit: 10,
				includeInternal: false,
			});
			const body = recent.length
				? recent.map(e => `• ${code(e.sessionId)}${e.path ? ` (${code(e.path)})` : ""}`).join("\n")
				: "No recent sessions.";
			await replyHtml(body);
			return true;
		}

		// Defensive shared-validator pre-check before any effect.
		const verb =
			parsed.kind === "create" ? "session_create" : parsed.kind === "close" ? "session_close" : "session_resume";
		const valid = validateLifecycleTarget(verb, parsed.target);
		if (!valid.ok) {
			await reply(`${valid.message}\n\n${lifecycleUsage()}`);
			return true;
		}

		const frame = this.buildLifecycleFrame(parsed, updateId ?? Date.now());
		const response = await this.submitLifecycleFrame(frame);
		await reply(this.formatLifecycleResponse(response));
		return true;
	}

	private async refreshBotIdentity(): Promise<void> {
		try {
			const response = (await this.botApi.call("getMe", {})) as { result?: { username?: unknown } };
			const username = response.result?.username;
			this.botUsername =
				typeof username === "string" && username.trim() ? username.trim().replace(/^@/, "") : undefined;
		} catch {
			this.botUsername = undefined;
		}
	}

	/** Map a lifecycle response/error to a user-facing message (G010 surfacing). */
	private formatLifecycleResponse(r: SessionLifecycleResponse): string {
		return formatLifecycleOutcome(r);
	}

	constructor(private readonly opts: TelegramDaemonOptions) {
		this.fsImpl = opts.fs ?? nodeFs;
		this.deletionJournal =
			opts.deletionJournal ??
			new ChatEffectJournal({ agentDir: opts.settings.getAgentDir(), transport: "telegram", now: opts.now });
		this.replyStore = new ReplySentStore({ agentDir: opts.settings.getAgentDir(), fs: opts.fs });
		this.aliasTable = createAliasTable();
		this.providerBotApi =
			opts.botApi ??
			new TelegramBotTransport({
				botToken: opts.botToken,
				apiBase: opts.apiBase,
				fetchImpl: opts.fetchImpl,
				setTimeoutImpl: opts.setTimeoutImpl,
			});
		this.botApi = {
			call: (method, body, callOpts) => this.callGuardedBotApi(method, body, callOpts),
		};
		this.runtime = new NotificationOperatorRuntime({
			now: opts.now,
			setTimeoutImpl: opts.setTimeoutImpl,
			clearTimeoutImpl: opts.clearTimeoutImpl,
			setIntervalImpl: opts.setIntervalImpl,
			clearIntervalImpl: opts.clearIntervalImpl,
		});
		this.sessionRouter = this.createSessionRouter();
		this.pool = new RateLimitPool<{ send: ThreadedSend; topicId?: string }>({ now: opts.now });
		this.poller = new TelegramUpdatePoller({
			botApi: this.botApi,
			runtime: this.runtime,
			backoff: this.pollConflictBackoff,
			processUpdate: update => this.processTelegramUpdate(update),
		});
	}
	private beginTopicOperation(sessionId: string, generation: number): (() => void) | undefined {
		if (this.fencedTopicGeneration.has(sessionId) || this.liveTopicGeneration.get(sessionId) !== generation) {
			return undefined;
		}
		this.topicOperations.set(sessionId, (this.topicOperations.get(sessionId) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const remaining = (this.topicOperations.get(sessionId) ?? 1) - 1;
			if (remaining > 0) {
				this.topicOperations.set(sessionId, remaining);
				return;
			}
			this.topicOperations.delete(sessionId);
			const waiters = this.topicOperationWaiters.get(sessionId);
			this.topicOperationWaiters.delete(sessionId);
			for (const resolve of waiters ?? []) resolve();
		};
	}

	private async drainTopicOperations(sessionId: string): Promise<void> {
		if ((this.topicOperations.get(sessionId) ?? 0) === 0) return;
		await new Promise<void>(resolve => {
			const waiters = this.topicOperationWaiters.get(sessionId) ?? new Set<() => void>();
			waiters.add(resolve);
			this.topicOperationWaiters.set(sessionId, waiters);
		});
	}

	private async callGuardedBotApi(
		method: string,
		body: unknown,
		callOpts?: { signal?: AbortSignal; noRetry?: boolean },
	): Promise<unknown> {
		const threadId =
			body && typeof body === "object" && !Array.isArray(body)
				? (body as { message_thread_id?: unknown }).message_thread_id
				: undefined;
		if (threadId === undefined) return this.providerBotApi.call(method, body, callOpts);
		const sessionId = this.topics.sessionForTopic(String(threadId));
		if (!sessionId) {
			if (this.fencedTopicIds.has(String(threadId))) throw new Error("Telegram topic is fenced");
			return this.providerBotApi.call(method, body, callOpts);
		}
		const generation = this.admissionGeneration(sessionId);
		if (generation === undefined) throw new Error("Telegram topic is fenced");
		const release = this.beginTopicOperation(sessionId, generation);
		if (!release) throw new Error("Telegram topic is fenced");
		try {
			return await this.providerBotApi.call(method, body, callOpts);
		} finally {
			release();
		}
	}

	private createSessionRouter(): OperatorEventRouter<SessionSocket> {
		return new OperatorEventRouter<SessionSocket>()
			.add({
				name: "hello",
				matches: msg => msg.type === "hello",
				handle: (session, msg) => {
					const caps = Array.isArray(msg.capabilities) ? msg.capabilities : [];
					if (caps.includes(CLIENT_PING_PONG_CAPABILITY)) {
						session.capable = true;
						this.startLiveness(session);
					}
				},
			})
			.add({
				name: "ask-selected-ack",
				matches: msg => msg.type === "ask_selected_ack_request",
				handle: async (session, msg) => {
					const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
					const commitKey = typeof msg.commitKey === "string" ? msg.commitKey : undefined;
					const mode = msg.mode === "live" || msg.mode === "recovery" ? msg.mode : undefined;
					const deadlineAt = typeof msg.deadlineAt === "number" ? msg.deadlineAt : undefined;
					if (!requestId || !commitKey || !mode || !deadlineAt) return;
					const cacheKey = `${session.sessionId}\0${commitKey}`;
					const cached = this.getCachedSelectedAck(cacheKey);
					if (cached) {
						session.ws.send(
							JSON.stringify({ type: "ask_selected_ack_result", requestId, commitKey, outcome: cached }),
						);
						return;
					}
					const finishImmediately = (outcome: SelectedAckOutcome): void => {
						this.cacheSelectedAck(cacheKey, outcome);
						if (session.ws.readyState === WebSocket.OPEN) {
							session.ws.send(
								JSON.stringify({ type: "ask_selected_ack_result", requestId, commitKey, outcome }),
							);
						}
					};
					if (deadlineAt <= this.runtime.now()) {
						finishImmediately({ status: "failed", reason: "expired" });
						return;
					}
					if (mode === "live" && (typeof msg.actionId !== "string" || !session.pending.has(msg.actionId))) {
						finishImmediately({ status: "failed", reason: "route_missing" });
						return;
					}
					const topicId = this.topics.get(session.sessionId)?.topicId;
					if (mode === "recovery" && (!topicId || msg.sessionId !== session.sessionId)) {
						finishImmediately({ status: "failed", reason: "route_missing" });
						return;
					}
					// F002: a threaded Selected ack must carry the live topic generation;
					// a fenced (mid-delete) topic cannot receive it.
					const topicGeneration = topicId ? this.admissionGeneration(session.sessionId) : undefined;
					if (topicId && topicGeneration === undefined) {
						finishImmediately({ status: "failed", reason: "route_missing" });
						return;
					}
					const existing = [...new Set(this.selectedAckPending.values())].find(item => item.cacheKey === cacheKey);
					if (existing) {
						if (
							existing.requestId === requestId ||
							existing.followers.some(follower => follower.requestId === requestId)
						)
							return;
						const pendingKey = `${session.endpointKey}\0${requestId}`;
						existing.followers.push({ pendingKey, requestId, commitKey });
						this.selectedAckPending.set(pendingKey, existing);
						return;
					}
					const pendingKey = `${session.endpointKey}\0${requestId}`;
					if (this.selectedAckPending.has(pendingKey)) return;
					const item: SelectedAckQueueItem = {
						pendingKey,
						cacheKey,
						itemId: `selected-ack:${session.endpointKey}:${requestId}`,
						requestId,
						commitKey,
						session,
						state: "queued",
						followers: [],
					};
					this.selectedAckPending.set(pendingKey, item);
					this.pool.submit({
						sessionId: session.sessionId,
						lane: "ask",
						itemId: item.itemId,
						deadlineAt,
						payload: {
							send: { method: "sendMessage", lane: "ask", text: "Selected!" },
							topicId,
							selectedAck: item,
							...(topicGeneration !== undefined ? { topicGeneration } : {}),
						},
					});
					await this.flushPool();
				},
			})
			.add({
				name: "ask-selected-ack-cancel",
				matches: msg => msg.type === "ask_selected_ack_cancel",
				handle: (session, msg) => {
					const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
					const commitKey = typeof msg.commitKey === "string" ? msg.commitKey : undefined;
					if (!requestId || !commitKey) return;
					const item = this.selectedAckPending.get(`${session.endpointKey}\0${requestId}`);
					if (!item || item.commitKey !== commitKey) return;
					if (item.requestId !== requestId) {
						item.followers = item.followers.filter(follower => follower.requestId !== requestId);
						this.selectedAckPending.delete(`${session.endpointKey}\0${requestId}`);
						if (session.ws.readyState === WebSocket.OPEN) {
							session.ws.send(
								JSON.stringify({
									type: "ask_selected_ack_result",
									requestId,
									commitKey,
									outcome: { status: "failed", reason: "cancelled" },
								}),
							);
						}
						return;
					}
					if (item.followers.length > 0) {
						const promoted = item.followers.shift()!;
						this.selectedAckPending.delete(item.pendingKey);
						item.pendingKey = promoted.pendingKey;
						item.requestId = promoted.requestId;
						item.commitKey = promoted.commitKey;
						if (session.ws.readyState === WebSocket.OPEN) {
							session.ws.send(
								JSON.stringify({
									type: "ask_selected_ack_result",
									requestId,
									commitKey,
									outcome: { status: "failed", reason: "cancelled" },
								}),
							);
						}
						return;
					}
					if (item.state !== "sending") {
						this.pool.removeById(item.itemId);
						this.finishSelectedAck(item, { status: "failed", reason: "cancelled" });
						return;
					}
					item.controller?.abort();
					this.finishSelectedAck(item, { status: "unknown", reason: "transport_ambiguous" });
				},
			})
			.add({
				name: "pong",
				matches: msg => msg.type === "pong",
				handle: (session, msg) => {
					if (typeof msg.nonce === "string" && msg.nonce === session.awaitingNonce) {
						session.awaitingNonce = undefined;
						session.lastPongAt = this.runtime.now();
					}
				},
			})
			.add({
				name: "activity",
				matches: msg => msg.type === "activity",
				handle: async (session, msg) => {
					if (msg.state === "busy") {
						this.busy.add(session.sessionId);
						await this.sendTyping(session.sessionId);
					} else {
						this.busy.delete(session.sessionId);
					}
				},
			})
			.add({
				name: "inbound_ack",
				matches: msg => msg.type === "inbound_ack" && typeof msg.updateId === "number",
				handle: async (_session, msg) => {
					const target = this.inboundReactions.get(msg.updateId as number);
					if (target && msg.state === "consumed") {
						this.inboundReactions.delete(msg.updateId as number);
						await this.setReaction(target.sessionId, target.messageId, CONSUMED_REACTION, target.generation);
					}
				},
			})
			.add({
				name: "session_closed",
				matches: msg => msg.type === "session_closed",
				handle: async session => {
					this.closingSessions.add(session.sessionId);
					this.busy.delete(session.sessionId);
					this.closedEndpointKeys.set(session.sessionId, session.endpointKey);
					await this.topicCreations.get(session.sessionId)?.catch(() => undefined);
					// Close-path deletion authority uses ONLY the socket's BOUND
					// admission lease (canonicalRoot, leaseId, endpoint incarnation
					// stamped from the endpoint file at admission). NEVER re-read the
					// current registry lease. A predecessor socket bound to an older
					// lease cannot delete/compact under a successor lease: the durable
					// performTopicDeletion path re-validates the bound lease against
					// the live registry under the admission lock and short-circuits as
					// "superseded" when they differ (no provider deletion, no
					// compaction, no generation restoration).
					const closeLeaseId = session.leaseId;
					if (isNonEmptyString(closeLeaseId)) {
						await this.deleteTopic(session.sessionId, closeLeaseId);
					}
					this.dropSession(session, "session_closed");
				},
			});
	}

	async loadAliases(): Promise<void> {
		const raw = await readJson<unknown>(this.fsImpl, daemonPaths(this.opts.settings.getAgentDir()).aliases);
		if (raw) this.aliasTable.load(raw);
	}

	async persistAliases(): Promise<void> {
		const paths = daemonPaths(this.opts.settings.getAgentDir());
		await ensureDir(this.fsImpl, paths.dir);
		await writeJsonAtomic(this.fsImpl, paths.aliases, this.aliasTable.serialize());
	}

	async loadSeenUpdateIds(): Promise<void> {
		const raw = await readJson<{ updateIds?: unknown }>(
			this.fsImpl,
			daemonPaths(this.opts.settings.getAgentDir()).seenUpdates,
		);
		this.dispatchState.seenUpdateIds.clear();
		const updateIds = Array.isArray(raw?.updateIds) ? raw.updateIds : [];
		for (const updateId of updateIds) {
			if (Number.isSafeInteger(updateId) && Number(updateId) >= 0) {
				this.dispatchState.seenUpdateIds.add(Number(updateId));
			}
		}
		this.pruneSeenUpdateIds();
	}

	async persistSeenUpdateIds(): Promise<void> {
		const paths = daemonPaths(this.opts.settings.getAgentDir());
		await ensureDir(this.fsImpl, paths.dir);
		await writeJsonAtomic(this.fsImpl, paths.seenUpdates, {
			version: 1,
			updateIds: [...this.dispatchState.seenUpdateIds].slice(-SEEN_UPDATE_ID_LIMIT),
		});
	}

	private pruneSeenUpdateIds(): void {
		let extra = this.dispatchState.seenUpdateIds.size - SEEN_UPDATE_ID_LIMIT;
		if (extra <= 0) return;
		for (const updateId of this.dispatchState.seenUpdateIds) {
			this.dispatchState.seenUpdateIds.delete(updateId);
			extra -= 1;
			if (extra <= 0) break;
		}
	}

	private async rememberSeenUpdateId(updateId: number): Promise<void> {
		if (!Number.isSafeInteger(updateId) || updateId < 0) return;
		this.dispatchState.seenUpdateIds.add(updateId);
		this.pruneSeenUpdateIds();
		try {
			await this.persistSeenUpdateIds();
		} catch (err) {
			logger.warn(`notifications: failed to persist Telegram update id ${updateId}: ${String(err)}`);
		}
	}

	async scanRoots(): Promise<void> {
		await this.reconcileDeletionJournal();
		const paths = daemonPaths(this.opts.settings.getAgentDir());
		// F001: per-root/per-session evidence replaces the global all-roots-readable
		// veto. Each registered root is classified independently — `readable`,
		// `missing` (ENOENT only), or `ambiguous` (any other readdir error) — and
		// each session's absence evidence is derived from ITS MAPPED root only, so
		// an unrelated unreadable root never blocks another session. Malformed or
		// unreadable matching endpoint files are tracked as protective (ambiguous)
		// evidence so they can never be mistaken for confirmed absence.
		const view = await readRootsRegistry(this.fsImpl, paths.roots);
		// Canonicalize the inventory view as one identity graph before scanning.
		// This also handles registries written by older versions: a still-live
		// symlink root and its real path collapse in memory, and session mappings
		// that point at the legacy alias follow the same canonical root. Resolution
		// failures remain lexical so the later root read classifies them ambiguous.
		const canonicalByRegisteredRoot = new Map<string, string>();
		const canonicalRoots: string[] = [];
		const unresolvedCanonicalRoots = new Set<string>();
		for (const registeredRoot of view.roots) {
			let canonicalRoot = registeredRoot;
			try {
				canonicalRoot = await canonicalizePath(this.fsImpl, registeredRoot);
			} catch {
				// Preserve unresolved authority as a distinct root, but mark it
				// ambiguous even when its directory can still be enumerated.
				unresolvedCanonicalRoots.add(canonicalRoot);
			}
			canonicalByRegisteredRoot.set(registeredRoot, canonicalRoot);
			if (!canonicalRoots.includes(canonicalRoot)) canonicalRoots.push(canonicalRoot);
		}
		view.roots = canonicalRoots;
		for (const [sessionId, mappedRoot] of view.sessions) {
			view.sessions.set(sessionId, canonicalByRegisteredRoot.get(mappedRoot) ?? mappedRoot);
		}
		const pidAlive = this.opts.pidAlive ?? defaultPidAlive;
		const rootStatus = new Map<string, "readable" | "missing" | "ambiguous">();
		// root -> (sessionId -> endpoint classification) for readable roots only.
		const rootSessionFiles = new Map<string, Map<string, "live" | "stale" | "malformed">>();
		// sessionId -> live endpoint records collected across ALL readable roots.
		// Each entry carries the immutable publication identity stamped onto the
		// endpoint file by the session server. The daemon binds THIS identity
		// (never inferring a lease from the registry); it only validates the
		// carried identity against the current registry to detect stale endpoints.
		const liveBySession = new Map<
			string,
			Array<{ canonicalRoot: string; leaseId: string; url: string; token: string }>
		>();
		const liveEndpointSessions = new Set<string>();
		// Sessions whose endpoint identity is ambiguous (missing/malformed/mismatched
		// carried identity, duplicate across roots, or conflicting identity). Fail-
		// closed: never connect, never first-wins, never authorizes cleanup.
		const ambiguousSessions = new Set<string>();
		for (const root of view.roots) {
			if (unresolvedCanonicalRoots.has(root)) {
				rootStatus.set(root, "ambiguous");
				continue;
			}
			const dir = path.join(root, "sdk");
			let files: string[];
			try {
				files = await this.fsImpl.readdir(dir);
			} catch (err) {
				// Definitively missing (ENOENT) counts as confirmed absence for a
				// mapped session; every other readdir error is ambiguous and must
				// withhold/defer that root's sessions only.
				rootStatus.set(root, isENOENTError(err) ? "missing" : "ambiguous");
				continue;
			}
			rootStatus.set(root, "readable");
			const fileMap = new Map<string, "live" | "stale" | "malformed">();
			for (const file of files.filter(item => item.endsWith(".json"))) {
				const sessionId = path.basename(file, ".json");
				if (this.fencedTopicGeneration.has(sessionId)) {
					const connected = this.sessions.get(sessionId);
					if (connected) this.dropSession(connected, "topic_deletion_pending");
					fileMap.set(sessionId, "stale");
					continue;
				}
				try {
					const endpoint = readEndpoint(path.join(dir, file));
					// Explicit stale/dead endpoint files are absence evidence the
					// candidate reconciliation below may reap through the grace
					// window; reconnecting them would chase a dead, token-bearing
					// record forever.
					if (endpoint.stale || (endpoint.pid !== undefined && !pidAlive(endpoint.pid))) {
						fileMap.set(sessionId, "stale");
						continue;
					}
					// The endpoint MUST carry immutable publication identity
					// (canonicalRoot + leaseId). A live endpoint missing either is
					// malformed/ambiguous: the daemon never infers a lease from the
					// registry. This also fails-closed for the predecessor race:
					// an endpoint carrying a stale lease is rejected below as
					// mismatched.
					if (!isNonEmptyString(endpoint.canonicalRoot) || !isNonEmptyString(endpoint.leaseId)) {
						fileMap.set(sessionId, "malformed");
						ambiguousSessions.add(sessionId);
						continue;
					}
					const mappedRoot = view.sessions.get(sessionId);
					const currentLease = view.sessionLeases.get(sessionId)?.leaseId;
					if (
						mappedRoot !== root ||
						endpoint.canonicalRoot !== root ||
						currentLease === undefined ||
						endpoint.leaseId !== currentLease
					) {
						fileMap.set(sessionId, "malformed");
						ambiguousSessions.add(sessionId);
						continue;
					}
					fileMap.set(sessionId, "live");
					liveEndpointSessions.add(sessionId);
					const entries = liveBySession.get(sessionId) ?? [];
					entries.push({
						canonicalRoot: endpoint.canonicalRoot,
						leaseId: endpoint.leaseId,
						url: endpoint.url,
						token: endpoint.token,
					});
					liveBySession.set(sessionId, entries);
				} catch {
					// Malformed/unreadable matching endpoint file: protective
					// evidence. It must NOT be treated as absence.
					fileMap.set(sessionId, "malformed");
					ambiguousSessions.add(sessionId);
				}
			}
			rootSessionFiles.set(root, fileMap);
		}
		// Duplicate/conflicting identity is ambiguous and non-authorizing: a
		// session with live endpoints carrying different publication identities
		// (canonicalRoot + leaseId) can never prove which belongs to the fresh
		// registration. Fail closed — disconnect/revoke any stale attached
		// control, and never first-wins.
		for (const [sessionId, entries] of liveBySession) {
			const distinctIdentity = new Set(
				entries.map(
					entry => `${entry.canonicalRoot}\0${entry.leaseId}\0${endpointGenerationKey(entry.url, entry.token)}`,
				),
			);
			if (distinctIdentity.size > 1) {
				ambiguousSessions.add(sessionId);
				const connected = this.sessions.get(sessionId);
				if (connected) this.dropSession(connected, "ambiguous_duplicate_endpoint");
			}
		}
		// Revalidation: every connected socket is checked against the CURRENT
		// registry identity every scan. A successor registration (different
		// lease) revokes the stale socket and any pending/session control. This
		// is the immutable revalidation contract: current registry values cannot
		// retroactively upgrade an old socket. The socket's BOUND lease (stamped
		// from the endpoint file at admission) is compared against the live
		// registry lease — a mismatch means a successor registration won.
		const toRevoke: Array<{ sock: SessionSocket; reason: string }> = [];
		for (const [sessionId, sock] of this.sessions) {
			if (this.fencedTopicGeneration.has(sessionId)) continue;
			if (ambiguousSessions.has(sessionId)) continue; // already revoked above
			const currentLease = view.sessionLeases.get(sessionId)?.leaseId;
			const mappedRoot = view.sessions.get(sessionId);
			const matchingEndpoint = liveBySession
				.get(sessionId)
				?.some(
					entry =>
						entry.canonicalRoot === sock.canonicalRoot &&
						entry.leaseId === sock.leaseId &&
						endpointGenerationKey(entry.url, entry.token) === sock.endpointKey,
				);
			if (
				!isNonEmptyString(sock.leaseId) ||
				!isNonEmptyString(sock.canonicalRoot) ||
				currentLease !== sock.leaseId ||
				mappedRoot !== sock.canonicalRoot ||
				matchingEndpoint !== true
			) {
				toRevoke.push({ sock, reason: "admission_identity_mismatch" });
			}
		}
		for (const { sock, reason } of toRevoke) this.dropSession(sock, reason);
		// Admission: only a live endpoint carrying immutable publication identity
		// (canonicalRoot + leaseId) that MATCHES the current registry lease may
		// connect/protect the topic. The daemon binds the ENDPOINT-CARRIED
		// identity (never inferring from the registry), and validates it against
		// the registry to reject stale predecessor endpoints whose lease no longer
		// matches the fresh registration. This closes the predecessor race: a
		// fresh registry lease with a predecessor endpoint file remaining is
		// mismatched → ambiguous → never connects.
		for (const [sessionId, entries] of liveBySession) {
			if (ambiguousSessions.has(sessionId)) continue;
			if (this.fencedTopicGeneration.has(sessionId)) continue;
			if (this.sessions.has(sessionId)) continue; // already connected + revalidated
			const entry = entries[0]!;
			const currentLease = view.sessionLeases.get(sessionId)?.leaseId;
			const mappedRoot = view.sessions.get(sessionId);
			if (
				currentLease === undefined ||
				mappedRoot === undefined ||
				entry.leaseId !== currentLease ||
				entry.canonicalRoot !== mappedRoot
			) {
				ambiguousSessions.add(sessionId);
				continue;
			}
			const endpointKey = endpointGenerationKey(entry.url, entry.token);
			if (this.closedEndpointKeys.get(sessionId) === endpointKey) continue;
			this.closedEndpointKeys.delete(sessionId);
			// Bind the ENDPOINT-CARRIED identity (immutable for the socket lifetime).
			this.connectSession(sessionId, entry.url, entry.token, {
				canonicalRoot: entry.canonicalRoot,
				leaseId: entry.leaseId,
			});
		}
		// Derive per-session absence evidence from each session's MAPPED root.
		const absenceEvidence = new Map<string, SessionAbsenceEvidence>();
		for (const sessionId of this.topics.sessionIds()) {
			// Ambiguous identity withholds/withholds cleanup: never reap.
			if (ambiguousSessions.has(sessionId)) {
				absenceEvidence.set(sessionId, { kind: "ambiguous" });
				continue;
			}
			if (this.sessions.has(sessionId) || liveEndpointSessions.has(sessionId)) {
				absenceEvidence.set(sessionId, { kind: "present" });
				continue;
			}
			const mappedRoot = view.sessions.get(sessionId);
			if (!mappedRoot) {
				absenceEvidence.set(sessionId, { kind: "ambiguous" });
				continue;
			}
			const status = rootStatus.get(mappedRoot);
			if (status === "missing") {
				absenceEvidence.set(sessionId, { kind: "missing" });
			} else if (status !== "readable") {
				// Unreadable (ambiguous) mapped root, or a registered root no
				// longer present in the registry list: defer, never reap.
				absenceEvidence.set(sessionId, { kind: "ambiguous" });
			} else {
				const file = rootSessionFiles.get(mappedRoot)?.get(sessionId);
				absenceEvidence.set(
					sessionId,
					file === "live"
						? { kind: "present" }
						: file === "malformed"
							? { kind: "ambiguous" }
							: { kind: "absent" }, // no file, or explicit stale/dead evidence
				);
			}
		}
		await this.reconcileOrphanCandidates(view, absenceEvidence);
	}

	private async sessionAdmissionIsCurrent(session: SessionSocket): Promise<boolean> {
		if (!isNonEmptyString(session.canonicalRoot) || !isNonEmptyString(session.leaseId)) return false;
		const view = await readRootsRegistry(this.fsImpl, daemonPaths(this.opts.settings.getAgentDir()).roots);
		if (
			view.sessions.get(session.sessionId) !== session.canonicalRoot ||
			view.sessionLeases.get(session.sessionId)?.leaseId !== session.leaseId
		) {
			return false;
		}
		try {
			const endpoint = readEndpoint(path.join(session.canonicalRoot, "sdk", `${session.sessionId}.json`));
			return (
				endpoint.canonicalRoot === session.canonicalRoot &&
				endpoint.leaseId === session.leaseId &&
				endpointGenerationKey(endpoint.url, endpoint.token) === session.endpointKey
			);
		} catch {
			return false;
		}
	}

	private async sendToCurrentSession(session: SessionSocket, frame: Record<string, unknown>): Promise<boolean> {
		if (this.sessions.get(session.sessionId) !== session) return false;
		if (!(await this.sessionAdmissionIsCurrent(session))) {
			if (this.sessions.get(session.sessionId) === session) {
				this.dropSession(session, "admission_identity_mismatch");
			}
			return false;
		}
		if (this.sessions.get(session.sessionId) !== session || session.ws.readyState !== WebSocket.OPEN) {
			return false;
		}
		try {
			session.ws.send(JSON.stringify(frame));
			return true;
		} catch {
			return false;
		}
	}

	connectSession(sessionId: string, url: string, token: string, identity: SessionAdmissionIdentity): void {
		this.closingSessions.delete(sessionId);
		const WS = this.opts.WebSocketImpl ?? WebSocket;
		const ws = new WS(`${url}/?token=${encodeURIComponent(token)}`);
		const endpointKey = endpointGenerationKey(url, token);
		this.closedEndpointKeys.delete(sessionId);
		const session: SessionSocket = {
			sessionId,
			token,
			endpointKey,
			// Bind the admission identity (canonical root + registration lease)
			// immutably to this socket. The token IS the endpoint incarnation: it is
			// freshly minted per endpoint publication, so (canonicalRoot, sessionId,
			// leaseId, token) is the exact admission tuple. The close/delete path
			// uses these bound values and never re-reads the current registry, so a
			// predecessor socket cannot be upgraded by a successor registration.
			canonicalRoot: identity.canonicalRoot,
			leaseId: identity.leaseId,
			ws,
			pending: new Map(),
			capable: false,
			lastPongAt: 0,
			awaitingNonce: undefined,
			pingTimer: undefined,
			replayId: `telegram-startup-replay:${sessionId}`,
			replayPending: false,
			replayQueue: [],
		};
		this.sessions.set(sessionId, session);
		// Bidirectional capability advertisement: announce client_ping_pong once the
		// socket is open. Sent on "open" only — a real WHATWG WebSocket cannot send
		// while CONNECTING — and liveness starts only after a capable ServerHello.
		ws.addEventListener("open", () => {
			session.replayPending = true;
			session.replayQueue = [];
			const replayCursor = this.topics.replayCursor(sessionId);
			void (async () => {
				if (this.sessions.get(sessionId) !== session || !(await this.sessionAdmissionIsCurrent(session))) {
					this.dropSession(session, "admission_identity_mismatch");
					return;
				}
				if (session.ws.readyState === WebSocket.OPEN) {
					try {
						session.ws.send(
							JSON.stringify({
								type: "hello",
								protocolVersion: NOTIFICATION_PROTOCOL_VERSION,
								capabilities: [
									CLIENT_PING_PONG_CAPABILITY,
									ASK_CONTROLS_CAPABILITY,
									ASK_SELECTED_ACK_CAPABILITY,
								],
							}),
						);
					} catch {}
					try {
						session.ws.send(
							JSON.stringify({
								type: "event_replay",
								id: session.replayId,
								sinceGeneration: replayCursor?.generation ?? 1,
								sinceSeq: replayCursor?.seq ?? 0,
							}),
						);
					} catch {}
				}
				void this.ensureTopic(sessionId, this.topicNameFor(sessionId, {})).catch(() => undefined);
			})().catch(err => {
				logger.error("notifications daemon: endpoint admission check failed", { error: String(err) });
				this.dropSession(session, "admission_check_failed");
			});
		});
		ws.addEventListener("message", ev => {
			void (async () => {
				if (this.sessions.get(sessionId) !== session || !(await this.sessionAdmissionIsCurrent(session))) {
					this.dropSession(session, "admission_identity_mismatch");
					return;
				}
				await this.handleSessionMessage(session, JSON.parse(String(ev.data)));
			})().catch(err => {
				logger.error("notifications daemon: handleSessionMessage failed", { error: String(err) });
			});
		});
		ws.addEventListener("close", () => {
			this.dropSession(session, "socket_closed");
		});
	}

	/**
	 * Start ack-based liveness for a session whose server advertised the
	 * `client_ping_pong` capability. Each interval drops the session when no pong
	 * has arrived within the TTL (the half-open case the socket never signals via
	 * `close`), otherwise sends a fresh application-level ping. The timer is bound
	 * to this exact session object.
	 */
	private startLiveness(session: SessionSocket): void {
		if (session.pingTimer) return;
		const setIntervalImpl = this.opts.setIntervalImpl ?? setInterval;
		const now = () => this.runtime.now();
		session.lastPongAt = now();
		session.pingTimer = setIntervalImpl(() => {
			if (this.sessions.get(session.sessionId) !== session) return;
			const t = now();
			if (t - session.lastPongAt >= HEARTBEAT_TTL_MS) {
				this.dropSession(session, "liveness_timeout");
				return;
			}
			if (session.ws.readyState === WebSocket.OPEN) {
				const nonce = `${session.sessionId}:${t}:${Math.random().toString(36).slice(2)}`;
				session.awaitingNonce = nonce;
				try {
					session.ws.send(JSON.stringify({ type: "ping", nonce }));
				} catch {}
			}
		}, HEARTBEAT_INTERVAL_MS);
	}

	/**
	 * Idempotent, identity-guarded session teardown. Clears the liveness timer,
	 * removes the map entry only when it still points at this exact session object
	 * (so a delayed old close cannot delete a replacement), and best-effort closes
	 * the socket. `scanRoots()` then reconnects the session.
	 */
	private dropSession(session: SessionSocket, reason: string): void {
		const clearIntervalImpl = this.opts.clearIntervalImpl ?? clearInterval;
		if (session.pingTimer) {
			clearIntervalImpl(session.pingTimer);
			session.pingTimer = undefined;
		}
		const isCurrentSession = this.sessions.get(session.sessionId) === session;
		if (isCurrentSession || reason === "session_closed") {
			this.deleteMessageRoutes(session.sessionId);
		}
		if (isCurrentSession) {
			this.sessions.delete(session.sessionId);
		}
		for (const item of new Set(this.selectedAckPending.values())) {
			if (item.session !== session) continue;
			if (item.state === "queued") this.pool.removeById(item.itemId);
			else item.controller?.abort();
			this.finishSelectedAck(item, { status: "unknown", reason: "transport_ambiguous" });
		}
		if (session.ws.readyState !== WebSocket.CLOSED) {
			try {
				session.ws.close();
			} catch {}
		}
	}

	private deleteMessageRoutes(sessionId: string, actionId?: string): void {
		for (const [messageId, route] of this.messageRoutes.entries()) {
			if (route.sessionId === sessionId && (actionId === undefined || route.actionId === actionId)) {
				this.messageRoutes.delete(messageId);
			}
		}
	}

	private static readonly THREADED_FRAMES = new Set([
		"identity_header",
		"context_update",
		"turn_stream",
		"image_attachment",
		"file_attachment",
		"config_update",
		"control_command_result",
	]);

	private topicNameFor(sessionId: string, msg: { title?: unknown; repo?: unknown; branch?: unknown }): string {
		const repo = typeof msg?.repo === "string" && msg.repo ? msg.repo : undefined;
		const branch = typeof msg?.branch === "string" && msg.branch ? msg.branch : undefined;
		const title = typeof msg?.title === "string" && msg.title ? msg.title : undefined;
		// A configured `nameTemplate` (e.g. "{title} · {repo}/{branch}") wins only
		// when every placeholder it references resolves for this session; otherwise
		// we fall through to the built-in composition so provisional/edge names
		// (missing title, repo, or branch) never render with dangling separators.
		const templated = this.renderTopicNameTemplate({ repo, branch, title });
		if (templated !== undefined) return templated;
		// Name the topic "{repo}/{branch}" before a session title exists, then
		// "{repo}/{branch} - {title}" once it does. Fall back to the session id
		// only when no repo identity is available.
		const base = repo ? (branch ? `${repo}/${branch}` : repo) : undefined;
		if (base) return title ? `${base} - ${title}` : base;
		if (title) return title;
		return `GJC ${sessionId.slice(-6)}`;
	}

	/**
	 * Render the operator-configured topic name template, or `undefined` when no
	 * usable template applies so the caller uses the built-in composition. The
	 * template is honored only if it is non-blank AND every placeholder it
	 * references (`{repo}`, `{branch}`, `{title}`) has a value for this session,
	 * which preserves the default title/repo/branch fallbacks and prevents
	 * half-filled names with dangling separators. Unknown placeholders are left
	 * verbatim.
	 */
	private renderTopicNameTemplate(values: { repo?: string; branch?: string; title?: string }): string | undefined {
		const template = this.opts.topics?.nameTemplate?.trim();
		if (!template) return undefined;
		let missing = false;
		const rendered = template.replace(/\{(repo|branch|title)\}/g, (_match, key: "repo" | "branch" | "title") => {
			const value = values[key];
			if (!value) {
				missing = true;
				return "";
			}
			return value;
		});
		if (missing) return undefined;
		const trimmed = rendered.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}

	private topicIdentityKey(msg: { repo?: unknown; branch?: unknown }): string | undefined {
		const repo = typeof msg?.repo === "string" && msg.repo.trim() ? msg.repo.trim() : undefined;
		if (!repo) return undefined;
		const branch = typeof msg?.branch === "string" && msg.branch.trim() ? msg.branch.trim() : "";
		return `${repo}\0${branch}`;
	}

	private topicIdentityBase(msg: { repo?: unknown; branch?: unknown }): string | undefined {
		const repo = typeof msg?.repo === "string" && msg.repo.trim() ? msg.repo.trim() : undefined;
		if (!repo) return undefined;
		const branch = typeof msg?.branch === "string" && msg.branch.trim() ? msg.branch.trim() : undefined;
		return branch ? `${repo}/${branch}` : repo;
	}

	private topicOwnerForIdentity(msg: { repo?: unknown; branch?: unknown }): string | undefined {
		const identityKey = this.topicIdentityKey(msg);
		const remembered = identityKey ? this.topicOwnerByIdentity.get(identityKey) : undefined;
		if (remembered && this.topics.get(remembered)) return remembered;
		if (!identityKey) return undefined;
		const base = this.topicIdentityBase(msg);
		for (const sessionId of this.topics.sessionIds()) {
			const topic = this.topics.get(sessionId);
			const nameMatchesLegacyIdentity =
				base !== undefined && (topic?.name === base || topic?.name?.startsWith(`${base} - `));
			if (topic?.identityKey === identityKey || nameMatchesLegacyIdentity) {
				this.topicOwnerByIdentity.set(identityKey, sessionId);
				return sessionId;
			}
		}
		return undefined;
	}

	private sessionCanClaimIdentity(session: SessionSocket, msg: { repo?: unknown; branch?: unknown }): boolean {
		const current = this.sessions.get(session.sessionId);
		if (current) return current === session;
		const ownerId = this.topicOwnerForIdentity(msg);
		return !ownerId || ownerId === session.sessionId;
	}

	private async submitThreadedFrame(sessionId: string, send: ThreadedSend, topicId: string): Promise<void> {
		// F002 admission fence: stamp the live topic generation and reject once the
		// topic is fenced for deletion. A post-fence enqueue reads an undefined
		// generation and returns, so it can never target the old topic.
		const topicGeneration = this.admissionGeneration(sessionId);
		if (topicGeneration === undefined) return;
		this.pool.submit({
			sessionId,
			lane: send.lane,
			coalesceKey: send.coalesceKey,
			payload: { send, topicId, topicGeneration },
		});
		await this.flushPool();
	}

	private async existingTopicForPrivateChat(sessionId: string): Promise<string | undefined> {
		if (!(await this.pairedChatIsPrivate())) return undefined;
		return this.topics.get(sessionId)?.topicId;
	}

	/** Best-effort re-assertion for a durable user-owned topic name. */
	private async reconcileUserTopicName(sessionId: string, topicId: string): Promise<void> {
		if ((this.daemonRenameAttempts.get(sessionId) ?? 0) > 0) return;
		let userName = this.topics.userNameToReconcile(sessionId);
		while (userName) {
			try {
				const response = await this.botApi.call("editForumTopic", {
					chat_id: this.opts.chatId,
					message_thread_id: Number(topicId),
					name: userName,
				});
				if (!topicRenameApplied(response)) return;
				const latestUserName = this.topics.userOwnedName(sessionId);
				if (latestUserName === userName) {
					if (this.topics.markUserNameReconciled(sessionId, userName)) {
						try {
							await this.persistTopics();
						} catch {
							this.topics.markUserNamePending(sessionId, userName);
						}
					}
					return;
				}
				userName = this.topics.userNameToReconcile(sessionId);
			} catch {
				// Keep the durable pending flag so the next identity frame retries.
				return;
			}
		}
	}

	private rememberPendingThreadedFrame(sessionId: string, send: ThreadedSend, msg: Record<string, unknown>): void {
		const frames = this.pendingThreadedFrames.get(sessionId) ?? [];
		frames.push({ send, msg });
		if (frames.length > PENDING_TOPIC_FRAME_LIMIT) frames.shift();
		this.pendingThreadedFrames.set(sessionId, frames);
	}

	private async flushPendingThreadedFrames(sessionId: string, topicId: string): Promise<void> {
		const frames = this.pendingThreadedFrames.get(sessionId);
		if (!frames || frames.length === 0) return;
		this.pendingThreadedFrames.delete(sessionId);
		for (const frame of frames) await this.submitThreadedFrame(sessionId, frame.send, topicId);
	}

	/**
	 * Resolve (creating once via `createForumTopic`) the forum topic for a
	 * session. On capability failure (e.g. Threaded Mode off) this returns
	 * `undefined`; callers then flat-deliver to a private paired chat (with a
	 * one-time nudge) or drop fail-closed for a non-private chat.
	 */
	private async ensureTopic(sessionId: string, name: string): Promise<string | undefined> {
		if (this.closingSessions.has(sessionId)) return undefined;
		if (!(await this.pairedChatIsPrivate())) return undefined;
		if (this.closingSessions.has(sessionId) || this.fencedTopicGeneration.has(sessionId)) return undefined;
		const existing = this.topics.get(sessionId);
		if (existing) {
			this.ensureLiveTopicGeneration(sessionId);
			return existing.topicId;
		}
		const pending = this.topicCreations.get(sessionId);
		if (pending) return pending;

		const creation = (async (): Promise<string | undefined> => {
			try {
				const rec = await this.topics.getOrCreateTopic(
					sessionId,
					async () => {
						const res = (await this.botApi.call("createForumTopic", {
							chat_id: this.opts.chatId,
							name,
						})) as { result?: { message_thread_id?: number } };
						const tid = res.result?.message_thread_id;
						if (tid === undefined || tid === null) throw new Error("createForumTopic: no message_thread_id");
						return String(tid);
					},
					this.opts.now,
					name,
				);
				await this.persistTopics();
				if (!this.closingSessions.has(sessionId)) this.ensureLiveTopicGeneration(sessionId);
				return rec.topicId;
			} catch {
				return undefined;
			}
		})();
		this.topicCreations.set(sessionId, creation);
		try {
			return await creation;
		} finally {
			if (this.topicCreations.get(sessionId) === creation) this.topicCreations.delete(sessionId);
		}
	}

	/** Assign a live generation for a topic that has none yet (created/resumed),
	 * without disturbing an existing live generation or a fenced one. */
	private ensureLiveTopicGeneration(sessionId: string): void {
		if (this.liveTopicGeneration.has(sessionId)) return;
		if (this.fencedTopicGeneration.has(sessionId)) return;
		this.assignTopicGeneration(sessionId);
	}

	private topicPastOrphanGrace(sessionId: string): boolean {
		const record = this.topics.get(sessionId);
		if (!record) return false;
		// Strictly validate createdAt before it contributes to destructive grace.
		// TopicRegistry only checks `typeof === "number"`, so it normalizes a
		// missing/legacy value to 0 and passes through NaN/Infinity/negative/
		// out-of-range values — any of which could make a malformed record look
		// long-past-grace and authorize a false reap. Fail closed unless createdAt
		// is a positive safe-integer timestamp not in the future.
		const createdAt = record.createdAt;
		const now = this.runtime.now();
		if (!isNonNegativeSafeInteger(createdAt) || createdAt <= 0 || createdAt > now) return false;
		return now - createdAt >= ORPHAN_TOPIC_GRACE_MS;
	}

	/**
	 * The generation a NEW send for `sessionId` would be stamped with (F002), or
	 * `undefined` when the session has no live topic or its topic is fenced for
	 * deletion — admission then rejects the send.
	 */
	private admissionGeneration(sessionId: string): number | undefined {
		if (this.closingSessions.has(sessionId)) return undefined;
		if (this.fencedTopicGeneration.has(sessionId)) return undefined;
		return this.liveTopicGeneration.get(sessionId);
	}

	/** Assign a fresh live generation for a created/resumed topic (F002). */
	private assignTopicGeneration(sessionId: string): number {
		const next = ++this.topicGenerationCounter;
		this.liveTopicGeneration.set(sessionId, next);
		this.fencedTopicGeneration.delete(sessionId);
		const topicId = this.topics.get(sessionId)?.topicId;
		if (topicId) this.fencedTopicIds.delete(topicId);
		return next;
	}

	/**
	 * Best-effort, crash-safe delete of a session topic. The send admission fence
	 * is raised FIRST (no late submitThreadedFrame/continuation can target the
	 * topic), queued items are cancelled, the pool is drained OUTSIDE any
	 * registry lock, then the remote delete runs through the durable deletion
	 * claim (fsynced intent before the call, terminal recorded before local
	 * forgetting). `leaseId` is the persisted registration lease this deletion is
	 * authorized under; it scopes the topic-specific effect and selective roots
	 * compaction so a fresh registration (different lease) is never compacted. A
	 * topic left by an uncertain/429 delete keeps its fence and is retried by the
	 * next scan; a resumed session receives a fresh generation.
	 */
	private async deleteTopic(sessionId: string, leaseId: string): Promise<void> {
		if (!isNonEmptyString(leaseId)) return;
		const record = this.topics.get(sessionId);
		if (!record || !isCanonicalTopicId(record.topicId)) return;
		// FENCE: invalidate the live generation so new submits/requeues are
		// rejected and every in-flight delivery revalidates and skips. A
		// post-fence enqueue cannot target the old topic: admissionGeneration()
		// is undefined while fenced, so it is stamped with a later generation.
		this.fencedTopicGeneration.set(sessionId, this.liveTopicGeneration.get(sessionId) ?? 0);
		this.liveTopicGeneration.delete(sessionId);
		this.fencedTopicIds.add(record.topicId);
		// CANCEL queued sends for this session before deleting the topic;
		// otherwise rate-limited frames can flush into a deleted topic or across
		// resume.
		const removed = this.pool.removeWhere(item => item.sessionId === sessionId);
		for (const item of removed) {
			if (item.payload.selectedAck)
				this.finishSelectedAck(item.payload.selectedAck, { status: "failed", reason: "cancelled" });
		}
		// DRAIN outside registry locks: let any in-flight flush complete. Granted
		// items revalidate against the (now-removed) live generation and skip.
		await this.flushPool();
		await this.drainTopicOperations(sessionId);
		// DELETE via the durable claim. Terminal remote success is recorded before
		// local forgetting; an uncertain/429 outcome retains the claim for retry.
		const generation = this.fencedTopicGeneration.get(sessionId) ?? 0;
		const outcome = await this.performTopicDeletion(sessionId, record.topicId, generation, leaseId);
		if (outcome === "terminal") {
			this.finalizeTopicDeletion(sessionId);
			await this.persistTopics().catch(() => undefined);
			// Selective roots compaction: remove ONLY the exact matching
			// candidate/lease/session mapping. A fresh registration whose lease
			// differs survives (re-read durably under the roots lock).
			await this.compactRootsAfterDeletion(sessionId, record.topicId, leaseId);
			await this.deletionJournal.updateTerminalReceipt<TelegramTopicDeletePayload>(
				topicDeleteEffectId(sessionId, record.topicId, leaseId),
				{ provider: "telegram", status: "reconciled" },
			);
		} else if (outcome === "superseded" && this.topics.get(sessionId)?.topicId === record.topicId) {
			this.assignTopicGeneration(sessionId);
		}
	}

	/**
	 * Establish/reuse the durable deletion claim, call `deleteForumTopic` with
	 * `noRetry` and a bounded AbortSignal, and record terminal/uncertain state.
	 * Returns "terminal" when the topic is confirmed deleted (or already
	 * deleted), "uncertain" when the call must be retried (429/abort/transport).
	 * `leaseId` is recorded in the payload so crash replay and compaction can
	 * validate exact session/topic/lease; the effect id is topic-scoped so a
	 * terminal record for a superseded topic never applies here.
	 */
	private async performTopicDeletion(
		sessionId: string,
		topicId: string,
		generation: number,
		leaseId: string,
	): Promise<"terminal" | "uncertain" | "superseded"> {
		const effectId = topicDeleteEffectId(sessionId, topicId, leaseId);
		const payload: TelegramTopicDeletePayload = { chatId: this.opts.chatId, topicId, leaseId };
		let lease: ChatEffectLease | undefined;
		let terminal = false;
		let superseded = false;
		await withFileLock(
			telegramAdmissionLockPath(this.opts.settings.getAgentDir(), sessionId),
			async () => {
				const roots = await readRootsRegistry(this.fsImpl, daemonPaths(this.opts.settings.getAgentDir()).roots);
				if (roots.sessionLeases.get(sessionId)?.leaseId !== leaseId) {
					superseded = true;
					return;
				}

				let existing = await this.deletionJournal.read<TelegramTopicDeletePayload>(effectId);
				if (
					existing &&
					(existing.transport !== "telegram" ||
						existing.kind !== TELEGRAM_TOPIC_DELETE_KIND ||
						existing.sessionId !== sessionId ||
						!isTelegramTopicDeletePayload(existing.payload) ||
						existing.payload.chatId !== payload.chatId ||
						existing.payload.topicId !== payload.topicId ||
						existing.payload.leaseId !== payload.leaseId)
				) {
					return;
				}
				const now = this.runtime.now();
				const memRetryUntil = this.deletionRetryAfter.get(sessionId);
				if (memRetryUntil !== undefined && now < memRetryUntil) return;
				const durableRetryAt = existing?.receipt?.retryAt;
				if (typeof durableRetryAt === "number" && Number.isFinite(durableRetryAt) && now < durableRetryAt) {
					this.deletionRetryAfter.set(sessionId, durableRetryAt);
					return;
				}
				if (existing?.state === "terminal") {
					terminal = true;
					return;
				}

				if (!existing) {
					const created = await this.deletionJournal.enqueueAndClaim<TelegramTopicDeletePayload>(
						{
							id: effectId,
							kind: TELEGRAM_TOPIC_DELETE_KIND,
							transport: "telegram",
							sessionId,
							endpointGeneration: generation,
							payload,
						},
						this.opts.ownerId,
						TELEGRAM_DELETION_LEASE_MS,
					);
					if (created) {
						existing = created;
						lease = { owner: this.opts.ownerId, epoch: created.epoch };
					}
				}
				if (!lease && existing) {
					const claimed = await this.deletionJournal.claim<TelegramTopicDeletePayload>(
						effectId,
						this.opts.ownerId,
						TELEGRAM_DELETION_LEASE_MS,
					);
					if (claimed?.state === "leased") {
						lease = { owner: this.opts.ownerId, epoch: claimed.epoch };
					}
				}
			},
			{ staleMs: 10_000 },
		);
		if (terminal) return "terminal";
		if (superseded) return "superseded";
		if (!lease) return "uncertain";
		const result = await this.callDeleteForumTopic(topicId);
		if (result.outcome === "deleted") {
			await this.deletionJournal.record(effectId, lease, "terminal", {
				provider: "telegram",
				status: "deleted",
			});
			this.deletionRetryAfter.delete(sessionId);
			return "terminal";
		}
		// Persist retry_after DURABLY so it survives a restart: record the absolute
		// deadline on the receipt and seed the in-memory backoff for this run.
		const retryAt =
			typeof result.retryAfterSec === "number" && result.retryAfterSec > 0
				? this.runtime.now() + result.retryAfterSec * 1000
				: this.runtime.now() + TELEGRAM_DELETION_RETRY_MS;
		this.deletionRetryAfter.set(sessionId, retryAt);
		await this.deletionJournal.record(effectId, lease, "uncertain", {
			provider: "telegram",
			status: result.retryAfterSec ? `retry_after:${result.retryAfterSec}` : "uncertain",
			retryAt,
		});
		return "uncertain";
	}

	/**
	 * Call `deleteForumTopic` once with `noRetry` and a bounded AbortSignal.
	 * Honors Telegram `parameters.retry_after` and reconciles an already-applied
	 * delete (topic/message-thread not found) as success.
	 */
	private async callDeleteForumTopic(
		topicId: string,
	): Promise<{ outcome: "deleted" | "uncertain"; retryAfterSec?: number }> {
		const controller = new AbortController();
		const timeoutMs = this.opts.topicDeleteTimeoutMs ?? TOPIC_DELETE_TIMEOUT_MS;
		const timer = (this.opts.setTimeoutImpl ?? setTimeout)(() => controller.abort(), timeoutMs);
		try {
			const res = (await this.providerBotApi.call(
				"deleteForumTopic",
				{ chat_id: this.opts.chatId, message_thread_id: Number(topicId) },
				{ signal: controller.signal, noRetry: true },
			)) as {
				ok?: boolean;
				error_code?: number;
				description?: string;
				parameters?: { retry_after?: unknown };
			};
			if (res?.ok === true) return { outcome: "deleted" };
			const description = String(res?.description ?? "");
			// Already-applied delete (topic/thread no longer exists) reconciles as success.
			if (
				res?.ok === false &&
				/not found|already deleted|message thread not found|topic deleted/i.test(description)
			) {
				return { outcome: "deleted" };
			}
			// 429 rate limit: honor retry_after, retain uncertain for re-attempt.
			if (res?.ok === false && (res.error_code === 429 || res.parameters?.retry_after !== undefined)) {
				const retryAfter = Number(res.parameters?.retry_after);
				return {
					outcome: "uncertain",
					retryAfterSec: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
				};
			}
			return { outcome: "uncertain" };
		} catch {
			// Abort/network/transport error: retain uncertain; a later scan retries.
			return { outcome: "uncertain" };
		} finally {
			(this.opts.clearTimeoutImpl ?? clearTimeout)(timer);
		}
	}

	/**
	 * Local cleanup after a confirmed terminal deletion: remove the topic record,
	 * its live-message index, identity ownership, pending frames, and generation.
	 * Selective: only the exact session is compacted (F005). Safe to call from
	 * crash replay for a terminal claim WITHOUT re-calling Telegram.
	 */
	private finalizeTopicDeletion(sessionId: string): void {
		this.topics.delete(sessionId);
		for (const k of [...this.liveMessages.keys()]) {
			if (k.startsWith(`${sessionId}:`)) this.liveMessages.delete(k);
		}
		this.topicOwnerByIdentity.forEach((ownerSessionId, identityKey) => {
			if (ownerSessionId === sessionId) this.topicOwnerByIdentity.delete(identityKey);
		});
		this.pendingThreadedFrames.delete(sessionId);
		this.liveTopicGeneration.delete(sessionId);
		this.fencedTopicGeneration.delete(sessionId);
	}

	/**
	 * F001 continuous-absence reconciliation driven by per-session MAPPED-root
	 * evidence. A `present` OR `ambiguous` session (connected, live endpoint, or
	 * an unreadable/malformed mapped root that cannot confirm absence) clears any
	 * candidate so a fresh grace window restarts once the ambiguity resolves; an
	 * unrelated unreadable root only withholds ITS own sessions. Only `absent`/
	 * `missing` evidence — under a VALID lease and a strictly-valid createdAt —
	 * may create/continue a candidate, and a candidate is reaped only once it has
	 * survived the grace window AND its lease still matches the live lease. The
	 * durable reap (network call) runs OUTSIDE the roots lock.
	 */
	private async reconcileOrphanCandidates(
		view: RootsRegistryView,
		absenceEvidence: Map<string, SessionAbsenceEvidence>,
	): Promise<void> {
		const now = this.runtime.now();
		const paths = daemonPaths(this.opts.settings.getAgentDir());
		for (const sessionId of this.topics.sessionIds()) {
			const evidence = absenceEvidence.get(sessionId);
			const candidate = view.orphanCandidates.get(sessionId);
			// Present OR ambiguous evidence must never authorize a reap: clear any
			// candidate so the grace window restarts once presence/ambiguity
			// resolves. (No evidence ⇒ unmapped session ⇒ defer fail-closed.)
			if (!evidence || evidence.kind === "present" || evidence.kind === "ambiguous") {
				if (candidate)
					await mutateRootsRegistry(this.fsImpl, paths.roots, v => deleteRawCandidate(v.raw, sessionId));
				continue;
			}
			// Absence confirmed (absent/missing). A valid lease is REQUIRED to
			// create or continue a candidate: a missing/invalid lease never
			// authorizes a reap, so clear any stale candidate instead.
			const lease = view.sessionLeases.get(sessionId);
			if (!lease) {
				if (candidate)
					await mutateRootsRegistry(this.fsImpl, paths.roots, v => deleteRawCandidate(v.raw, sessionId));
				continue;
			}
			const record = this.topics.get(sessionId);
			if (!record) continue;
			if (!this.topicPastOrphanGrace(sessionId)) continue;
			// Skip while a 429 retry_after backoff is in effect.
			const retryUntil = this.deletionRetryAfter.get(sessionId);
			if (retryUntil !== undefined && now < retryUntil) continue;
			if (!candidate) {
				// First confirmed continuous absence: record a candidate.
				await mutateRootsRegistry(this.fsImpl, paths.roots, v => {
					setRawCandidate(v.raw, sessionId, {
						observedAt: now,
						leaseId: lease.leaseId,
						topicId: record.topicId,
					});
					return true;
				});
				continue;
			}
			if (candidate.leaseId !== lease.leaseId || candidate.topicId !== record.topicId) {
				// A fresh registration or changed topic invalidates the prior
				// observation. Require a complete new continuous-absence window.
				await mutateRootsRegistry(this.fsImpl, paths.roots, v => {
					setRawCandidate(v.raw, sessionId, {
						observedAt: now,
						leaseId: lease.leaseId,
						topicId: record.topicId,
					});
					return true;
				});
				continue;
			}
			if (now - candidate.observedAt < ORPHAN_TOPIC_GRACE_MS) continue;
			// Reap through the fenced, durable deletion path. The live lease
			// authorizes the deletion and scopes selective roots compaction.
			await this.deleteTopic(sessionId, lease.leaseId);
		}
	}

	/**
	 * F004 crash reconciliation of the durable deletion journal, run once at
	 * startup after topics are loaded. It validates EXACT session/topic/lease for
	 * every effect: a terminal claim completes local cleanup WITHOUT calling
	 * Telegram again and compacts roots for its exact lease; a nonterminal claim
	 * for a superseded topic/gone topic is terminalized; otherwise the remote
	 * delete is re-attempted (honoring the durable retry_after).
	 */
	private async reconcileDeletionJournal(): Promise<void> {
		const effects = (await this.deletionJournal.list()).filter(
			(e): e is ChatEffect<TelegramTopicDeletePayload> =>
				e.transport === "telegram" &&
				e.kind === TELEGRAM_TOPIC_DELETE_KIND &&
				isTelegramTopicDeletePayload(e.payload) &&
				(e.state !== "terminal" || !e.receipt?.status?.startsWith("reconciled")),
		);
		for (const effect of effects) {
			const sessionId = effect.sessionId;
			if (!sessionId || effect.payload.chatId !== this.opts.chatId) continue;
			const payload = effect.payload;
			const record = this.topics.get(sessionId);
			const roots = await readRootsRegistry(this.fsImpl, daemonPaths(this.opts.settings.getAgentDir()).roots);
			const currentLease = roots.sessionLeases.get(sessionId)?.leaseId;
			const leaseMatches = currentLease === undefined || currentLease === payload.leaseId;

			if (effect.state === "terminal") {
				this.fencedTopicIds.add(payload.topicId);
				if (leaseMatches && record?.topicId === payload.topicId) {
					this.finalizeTopicDeletion(sessionId);
					await this.persistTopics().catch(() => undefined);
				}
				if (leaseMatches) {
					await this.compactRootsAfterDeletion(sessionId, payload.topicId, payload.leaseId);
				}
				await this.deletionJournal.updateTerminalReceipt(effect.id, {
					provider: "telegram",
					status: leaseMatches ? "reconciled" : "reconciled_superseded",
				});
				continue;
			}

			// Never replay a nonterminal delete against a different registration
			// generation. Terminalizing it releases the admission barrier without a
			// second provider call.
			if (!currentLease || currentLease !== payload.leaseId || record?.topicId !== payload.topicId) {
				await this.deletionJournal
					.terminalize(effect.id, { provider: "telegram", status: "reconciled_superseded" })
					.catch(() => undefined);
				continue;
			}
			this.fencedTopicGeneration.set(
				sessionId,
				this.liveTopicGeneration.get(sessionId) ?? effect.endpointGeneration,
			);
			this.liveTopicGeneration.delete(sessionId);
			this.fencedTopicIds.add(payload.topicId);
			const outcome = await this.performTopicDeletion(
				sessionId,
				record.topicId,
				effect.endpointGeneration,
				payload.leaseId,
			);
			if (outcome === "terminal") {
				this.finalizeTopicDeletion(sessionId);
				await this.persistTopics().catch(() => undefined);
				await this.compactRootsAfterDeletion(sessionId, record.topicId, payload.leaseId);
				await this.deletionJournal.updateTerminalReceipt(effect.id, {
					provider: "telegram",
					status: "reconciled",
				});
			}
		}
	}
	/**
	 * Selective local-roots compaction after a confirmed (terminal) deletion.
	 * Removes ONLY the exact matching candidate/lease/session mapping for the
	 * deleted topic + lease, re-read durably under the roots lock so a fresh
	 * registration (different lease) or a different topic survives untouched.
	 */
	private async compactRootsAfterDeletion(sessionId: string, topicId: string, leaseId: string): Promise<void> {
		const paths = daemonPaths(this.opts.settings.getAgentDir());
		await mutateRootsRegistry(this.fsImpl, paths.roots, v => {
			const candidate = v.orphanCandidates.get(sessionId);
			if (candidate && candidate.topicId === topicId && candidate.leaseId === leaseId) {
				deleteRawCandidate(v.raw, sessionId);
			}
			const lease = v.sessionLeases.get(sessionId);
			if (leaseId && lease && lease.leaseId === leaseId) {
				const root = v.sessions.get(sessionId);
				deleteRawLease(v.raw, sessionId);
				deleteRawSessionMapping(v.raw, sessionId);
				if (root) deleteRawRootIfUnreferenced(v.raw, root);
			}
			return true;
		});
	}

	private persistTopics(): Promise<void> {
		const pending = this.topicsPersistQueue.then(async () => {
			const paths = daemonPaths(this.opts.settings.getAgentDir());
			await ensureDir(this.fsImpl, paths.dir);
			await writeJsonAtomic(this.fsImpl, path.join(paths.dir, "telegram-topics.json"), this.topics.serialize());
		});
		this.topicsPersistQueue = pending.catch(() => undefined);
		return pending;
	}

	async loadTopics(): Promise<void> {
		const paths = daemonPaths(this.opts.settings.getAgentDir());
		const raw = await readJson<TopicRegistryState>(this.fsImpl, path.join(paths.dir, "telegram-topics.json"));
		// Restore the full serialized registry (topicId + identitySent + name) so a
		// fresh daemon after reload does not resend identity headers or lose renames.
		if (raw && typeof raw === "object") this.topics.load(raw);
		// Assign a fresh per-session admission generation to every restored topic.
		// The rate-limit pool is in-memory only, so a restart has no stale queued
		// frames; each live topic starts a new generation its first send adopts.
		for (const sessionId of this.topics.sessionIds()) this.ensureLiveTopicGeneration(sessionId);
	}

	/** Download a Telegram file by its file_path (from getFile) into memory. */
	private async downloadTelegramFile(filePath: string): Promise<Buffer | undefined> {
		const apiBase = this.opts.apiBase ?? "https://api.telegram.org";
		const fetchImpl = this.opts.fetchImpl ?? fetch;
		// `filePath` is remote metadata from getFile; reject suspicious segments
		// (traversal/absolute/backslash) and percent-encode each component before
		// composing the download URL.
		if (filePath.includes("..") || filePath.startsWith("/") || filePath.includes("\\")) {
			logger.warn("notifications: rejecting suspicious Telegram file_path");
			return undefined;
		}
		const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
		const url = `${apiBase}/file/bot${this.opts.botToken}/${encodedPath}`;
		try {
			const res = await fetchImpl(url);
			if (!res.ok) return undefined;
			return Buffer.from(await res.arrayBuffer());
		} catch (e) {
			logger.warn(`notifications: file download failed: ${String(e)}`);
			return undefined;
		}
	}

	/**
	 * Per-session private temp directories (mode 0700) holding inbound non-image
	 * attachments. Keyed by session id and reused across transient reconnects;
	 * removed when the daemon stops (see {@link cleanupAllAttachmentDirs}).
	 */
	private readonly attachmentDirs = new Map<string, string>();

	/** Lazily create a private, unguessable 0700 temp dir for `sessionId`. */
	private async ensureAttachmentDir(sessionId: string): Promise<string> {
		const existing = this.attachmentDirs.get(sessionId);
		if (existing) return existing;
		// mkdtemp creates a directory with an unguessable suffix and 0700 perms;
		// chmod defensively in case of an unusual platform/umask.
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-telegram-"));
		await fs.promises.chmod(dir, 0o700).catch(() => undefined);
		this.attachmentDirs.set(sessionId, dir);
		return dir;
	}

	/** Remove all per-session attachment directories. Called on daemon shutdown. */
	private async cleanupAllAttachmentDirs(): Promise<void> {
		const dirs = [...this.attachmentDirs.values()];
		this.attachmentDirs.clear();
		await Promise.all(dirs.map(dir => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined)));
	}

	/**
	 * Resolve an inbound attachment to inline image bytes (forwarded as images) or
	 * a securely-saved file path note (non-images). Non-image bytes are written
	 * into a private per-session temp dir (0700) under an unguessable name via an
	 * exclusive 0600 create (`wx`), so the files are not world-readable and the
	 * write never follows a pre-existing symlink. The directory is removed when the
	 * daemon stops. Returns base64 images to inline plus human-readable file notes
	 * to append to the injected text.
	 */
	private async resolveInboundAttachment(
		att: InboundAttachment,
		sessionId: string,
	): Promise<{ images: { data: string; mime?: string }[]; fileNotes: string[] }> {
		const images: { data: string; mime?: string }[] = [];
		const fileNotes: string[] = [];
		const label = att.fileName ?? att.kind;
		try {
			const got = (await this.botApi.call("getFile", { file_id: att.fileId })) as {
				result?: { file_path?: unknown };
			};
			const filePath = typeof got?.result?.file_path === "string" ? got.result.file_path : undefined;
			if (!filePath) {
				fileNotes.push(`[attachment unavailable: ${label}]`);
				return { images, fileNotes };
			}
			const bytes = await this.downloadTelegramFile(filePath);
			if (!bytes) {
				fileNotes.push(`[attachment download failed: ${label}]`);
				return { images, fileNotes };
			}
			const isImage = att.kind === "photo" || (typeof att.mime === "string" && att.mime.startsWith("image/"));
			if (isImage) {
				images.push({ data: bytes.toString("base64"), mime: att.mime ?? "image/jpeg" });
			} else {
				const safeBase =
					(att.fileName?.trim() || path.basename(filePath) || `${att.kind}-${att.fileId}`)
						.replace(/[^\w.-]+/g, "_") // drop path separators and unusual chars
						.replace(/\.\.+/g, "_") // neutralize any ".." traversal-looking runs
						.replace(/^[.-]+/, "_") // no leading dot/hyphen
						.slice(-128) || "file";
				const dir = await this.ensureAttachmentDir(sessionId);
				// Unguessable, non-colliding name inside the private 0700 dir; the
				// exclusive 0600 create (`wx`) refuses to follow a pre-existing file/symlink.
				const dest = path.join(dir, `${crypto.randomBytes(8).toString("hex")}-${safeBase}`);
				await fs.promises.writeFile(dest, bytes, { flag: "wx", mode: 0o600 });
				fileNotes.push(`[user attached a file, saved to ${dest}${att.mime ? ` (${att.mime})` : ""}]`);
			}
		} catch (e) {
			logger.warn(`notifications: inbound attachment failed: ${String(e)}`);
			fileNotes.push(`[attachment error: ${label}]`);
		}
		return { images, fileNotes };
	}

	/**
	 * Serialize all pool flushes. Every caller (`submitThreadedFrame`, the flat
	 * fallback, the drain timer's `void this.flushPool()`, topic teardown) goes
	 * through one promise chain, so two flushes never interleave — a live send can
	 * never be in-flight while a finalized flush reads `liveMessages` and decides
	 * to post a fresh (duplicate) final. Errors are swallowed so one failed flush
	 * never poisons the queue (each flush is already best-effort internally).
	 */
	private flushChain: Promise<void> = Promise.resolve();
	private flushPool(): Promise<void> {
		const next = this.flushChain.then(() => this.flushPoolInner());
		this.flushChain = next.catch(() => {});
		return next;
	}

	/** Drain the shared rate-limit pool and deliver each granted send to its topic. */
	private async flushPoolInner(): Promise<void> {
		const { granted: batch, expired } = this.pool.drainWithExpired();
		for (const expiredItem of expired) {
			if (expiredItem.payload.selectedAck) {
				this.finishSelectedAck(expiredItem.payload.selectedAck, { status: "failed", reason: "expired" });
			}
		}
		// Within a batch a finalized frame supersedes any still-queued live frame for
		// the same streamed message (finalized outranks live), so drop the stale live
		// edit — otherwise the authoritative final text could be overwritten by an
		// older partial delivered right after it.
		const finalizedKeys = new Set<string>();
		for (const item of batch) {
			if (item.lane === "finalized" && item.coalesceKey !== undefined) {
				finalizedKeys.add(`${item.sessionId}:${item.coalesceKey}`);
			}
		}
		// Cross-batch protection: also purge any live frame still QUEUED for a
		// message whose finalized frame is in this batch, so a stale live edit can
		// never be delivered on a later drain after the authoritative final.
		if (finalizedKeys.size > 0) {
			this.pool.removeWhere(
				it =>
					it.lane === "live" &&
					it.coalesceKey !== undefined &&
					finalizedKeys.has(`${it.sessionId}:${it.coalesceKey}`),
			);
		}
		for (const item of batch) {
			// F002: revalidate the stamped topic generation before any provider call.
			// A frame whose generation no longer matches the live topic (fenced for
			// deletion or regenerated) is dropped. Flat (non-topic) sends carry no
			// generation and are never gated here.
			const stampedGen = item.payload.topicGeneration;
			if (typeof stampedGen === "number" && stampedGen !== this.liveTopicGeneration.get(item.sessionId)) continue;
			const selectedAck = item.payload.selectedAck;
			if (selectedAck) {
				const { topicId } = item.payload;
				selectedAck.state = "dispatching";
				const controller = new AbortController();
				selectedAck.controller = controller;
				const routeAvailable = !topicId || (await this.pairedChatIsPrivate());
				if (this.selectedAckPending.get(selectedAck.pendingKey) !== selectedAck) continue;
				if (!routeAvailable) {
					this.finishSelectedAck(selectedAck, { status: "failed", reason: "route_missing" });
					continue;
				}
				if (item.deadlineAt !== undefined && item.deadlineAt <= this.runtime.now()) {
					this.finishSelectedAck(selectedAck, { status: "failed", reason: "expired" });
					continue;
				}
				selectedAck.state = "sending";
				const remaining = Math.max(0, (item.deadlineAt ?? this.runtime.now()) - this.runtime.now());
				const timer = (this.opts.setTimeoutImpl ?? setTimeout)(
					() => controller.abort(),
					Math.min(8_000, remaining),
				);
				try {
					const response = (await this.botApi.call(
						"sendMessage",
						{
							chat_id: this.opts.chatId,
							...(topicId ? { message_thread_id: Number(topicId) } : {}),
							text: "Selected!",
						},
						{ signal: controller.signal, noRetry: true },
					)) as { ok?: unknown; result?: { message_id?: unknown } };
					this.finishSelectedAck(
						selectedAck,
						response.ok === true && typeof response.result?.message_id === "number"
							? { status: "delivered", messageId: response.result.message_id }
							: { status: "failed", reason: "telegram_rejected" },
					);
				} catch {
					this.finishSelectedAck(selectedAck, { status: "unknown", reason: "transport_ambiguous" });
				} finally {
					(this.opts.clearTimeoutImpl ?? clearTimeout)(timer);
				}
				continue;
			}
			const { send, topicId } = item.payload;
			if (topicId && !(await this.pairedChatIsPrivate())) continue;
			// Threaded topic when available; otherwise deliver flat to the paired chat.
			const threadField = topicId ? { message_thread_id: Number(topicId) } : {};
			const ckey = send.editable ? item.coalesceKey : undefined;
			const editKey = ckey !== undefined ? `${item.sessionId}:${ckey}` : undefined;
			if (item.lane === "live" && editKey && finalizedKeys.has(editKey)) continue;
			try {
				// Draft streaming (opt-in, off by default): stream a live turn frame as a
				// best-effort rich-draft preview, debounced to >=1.5s per session through
				// this same rate-limited drain; a finalized frame ends the turn's draft
				// window. Entirely inert when richDraft is off (the enabled gate /
				// shouldStreamDraft fail closed), so off-state HTML request bodies stay
				// byte-identical.
				if (this.opts.richDraft?.enabled === true && this.opts.rich?.enabled !== false) {
					if (send.lane === "finalized" && send.method === "sendMessage") {
						this.draftStream.reset(item.sessionId);
					} else if (
						shouldStreamDraft({
							enabled: this.opts.richDraft.enabled,
							send,
						})
					) {
						const draftId = this.draftStream.tryClaim(item.sessionId, this.opts.now?.() ?? Date.now());
						if (draftId !== undefined) {
							await deliverDraft(
								this.botApi,
								{ chat_id: this.opts.chatId, ...threadField },
								draftId,
								send.richDraftMarkdown!,
								logger,
							);
						}
					}
				}
				if (send.method === "sendPhoto" && send.photoBase64) {
					// Real photo upload (the default botApi multiparts base64 -> file).
					await this.botApi.call("sendPhoto", {
						chat_id: this.opts.chatId,
						...threadField,
						photo: send.photoBase64,
						mime: send.mime,
						caption: send.text,
						parse_mode: TELEGRAM_PARSE_MODE,
					});
				} else if (send.method === "sendDocument" && send.documentBase64) {
					await this.botApi.call("sendDocument", {
						chat_id: this.opts.chatId,
						...threadField,
						document: send.documentBase64,
						mime: send.mime,
						fileName: send.fileName,
						caption: send.text,
						parse_mode: TELEGRAM_PARSE_MODE,
					});
				} else if (send.text) {
					// Rich pre-branch: promote stable non-editable finalized text to a fresh
					// sendRichMessage when enabled. Off/miss falls through to the unchanged
					// upstream edit/send path, so off behavior is byte-identical.
					if (
						shouldPromoteRich({
							enabled: this.opts.rich?.enabled !== false,
							send,
						})
					) {
						const sendHtmlFallback = async () => {
							// Fairness: this frame consumed exactly one token, so send only the
							// first HTML chunk now and requeue any continuations as their own
							// non-editable, HTML-only pool items (rich markers stripped) — same
							// per-token discipline as the non-rich split path.
							const chunks = splitTelegramHtml(send.text!);
							await this.botApi.call("sendMessage", {
								chat_id: this.opts.chatId,
								...threadField,
								text: chunks[0]!,
								parse_mode: TELEGRAM_PARSE_MODE,
							});
							for (let i = 1; i < chunks.length; i++) {
								this.pool.submit({
									sessionId: item.sessionId,
									lane: item.lane,
									payload: {
										send: {
											...send,
											method: "sendMessage",
											text: chunks[i]!,
											editable: false,
											coalesceKey: undefined,
											photoBase64: undefined,
											documentBase64: undefined,
											richMarkdown: undefined,
											richDraftMarkdown: undefined,
											richClass: undefined,
										},
										topicId,
										topicGeneration: item.payload.topicGeneration,
									},
								});
							}
						};
						const richMessageId = await deliverRichWithFallback(
							this.botApi,
							{ chat_id: this.opts.chatId, ...threadField },
							send,
							sendHtmlFallback,
							logger,
						);
						// Index the sent rich message so an inbound reply to it can restore
						// the original markdown as context (Telegram does not echo it back).
						if (richMessageId !== undefined) {
							await this.replyStore.record({
								chatId: this.opts.chatId,
								messageId: richMessageId,
								text: send.richMarkdown!,
							});
						}
					} else {
						const chunks = splitTelegramHtml(send.text);
						const existingId = editKey ? this.liveMessages.get(editKey) : undefined;
						let firstMessageId: number | undefined;
						if (editKey && existingId !== undefined) {
							// Edit the existing streamed message in place with the first chunk
							// so a finalized turn never leaves a stale live preview. A LOCAL
							// try/catch keeps a failed edit from aborting the continuation
							// requeue below; "message is not modified" is a success (the message
							// already shows this text); a missing/deleted backing message (or a
							// transport error) resends so the first chunk is never lost.
							let edited = false;
							const release =
								typeof stampedGen === "number"
									? this.beginTopicOperation(item.sessionId, stampedGen)
									: () => {};
							if (!release) continue;
							try {
								const res = (await this.providerBotApi.call("editMessageText", {
									chat_id: this.opts.chatId,
									message_id: existingId,
									text: chunks[0],
									parse_mode: TELEGRAM_PARSE_MODE,
								})) as { ok?: boolean; description?: string } | null;
								edited = res?.ok !== false || /not modified/i.test(String(res?.description ?? ""));
							} catch {
								edited = false;
							} finally {
								release();
							}
							if (edited) {
								firstMessageId = existingId;
							} else {
								const res = (await this.botApi.call("sendMessage", {
									chat_id: this.opts.chatId,
									...threadField,
									text: chunks[0]!,
									parse_mode: TELEGRAM_PARSE_MODE,
								})) as { result?: { message_id?: number } };
								firstMessageId = res?.result?.message_id;
							}
						} else {
							// No streamed message to edit: a single granted slot maps to a
							// single Telegram send.
							const res = (await this.botApi.call("sendMessage", {
								chat_id: this.opts.chatId,
								...threadField,
								text: chunks[0]!,
								parse_mode: TELEGRAM_PARSE_MODE,
							})) as { result?: { message_id?: number } };
							firstMessageId = res?.result?.message_id;
						}
						// Continuation chunks are FINALIZED-lane only. A live preview is a
						// single edit-safe chunk (its authoritative full text arrives with the
						// finalized frame), so a split live frame never fans out into stale,
						// non-coalesced continuation messages. Finalized continuations are
						// fresh, non-editable, HTML-only sends (rich markers stripped) so they
						// can never be re-promoted to a duplicate sendRichMessage.
						if (item.lane !== "live") {
							for (let i = 1; i < chunks.length; i++) {
								this.pool.submit({
									sessionId: item.sessionId,
									lane: item.lane,
									payload: {
										send: {
											...send,
											method: "sendMessage",
											text: chunks[i]!,
											editable: false,
											coalesceKey: undefined,
											photoBase64: undefined,
											documentBase64: undefined,
											richMarkdown: undefined,
											richDraftMarkdown: undefined,
											richClass: undefined,
										},
										topicId,
										topicGeneration: item.payload.topicGeneration,
									},
								});
							}
						}
						if (editKey && ckey !== undefined && firstMessageId !== undefined) {
							this.recordLiveMessage(item.sessionId, ckey, firstMessageId);
						}
					}
				}
			} catch {
				// Best-effort: a failed send/edit must never stop the daemon.
			}
		}
	}

	/**
	 * Track the Telegram message id backing a streamed `(sessionId, coalesceKey)`
	 * so later live/finalized frames edit it in place. Evicts this session's stale
	 * same-category entries (e.g. prior turns) so the map stays bounded.
	 */
	private recordLiveMessage(sessionId: string, coalesceKey: string, messageId: number): void {
		const mapKey = `${sessionId}:${coalesceKey}`;
		const category = coalesceKey.split(":")[0] ?? "";
		const prefix = `${sessionId}:${category}:`;
		for (const k of [...this.liveMessages.keys()]) {
			if (k !== mapKey && k.startsWith(prefix)) this.liveMessages.delete(k);
		}
		this.liveMessages.set(mapKey, messageId);
	}

	/**
	 * Threaded Mode is unavailable (the bot owner has not enabled forum topics in
	 * @BotFather, so `createForumTopic` fails). Deliver the rendered frame flat to
	 * the paired chat instead of dropping it, and nudge the user once. Flat delivery
	 * is gated on the paired chat being a private chat: for a group/supergroup/channel
	 * (e.g. a legacy or hand-edited `chatId`) we keep dropping fail-closed so session
	 * content never lands in a shared chat. Identity headers are sent at most once per
	 * session in flat mode.
	 */
	private async deliverFlatFallback(sessionId: string, send: ThreadedSend): Promise<void> {
		if (!(await this.pairedChatIsPrivate())) return;
		await this.notifyThreadedFallback();
		if (send.identity && this.flatIdentitySent.has(sessionId)) return;
		this.pool.submit({ sessionId, lane: send.lane, coalesceKey: send.coalesceKey, payload: { send } });
		await this.flushPool();
		if (send.identity) this.flatIdentitySent.add(sessionId);
	}

	/**
	 * Resolve (and cache definitive resolution of) whether the paired `chatId` is
	 * a private chat. Topic and flat delivery are only safe in a private DM; an
	 * indeterminate `getChat` result fails closed for this attempt and is retried
	 * later.
	 */
	private async resolvePairedChatPrivacy(): Promise<PairedChatPrivacy> {
		if (this.pairedChatPrivate !== undefined) return this.pairedChatPrivate ? "private" : "non-private";
		try {
			const res = (await this.botApi.call("getChat", { chat_id: this.opts.chatId })) as {
				ok?: unknown;
				result?: { type?: unknown };
			};
			if (res?.ok !== true) {
				logger.warn("notifications: getChat privacy check indeterminate (non-success response)");
				return "indeterminate";
			}
			if (res.result?.type === "private") {
				this.pairedChatPrivate = true;
				return "private";
			}
			if (res.result?.type === "group" || res.result?.type === "supergroup" || res.result?.type === "channel") {
				this.pairedChatPrivate = false;
				return "non-private";
			}
			logger.warn("notifications: getChat privacy check indeterminate (missing or invalid chat type)");
			return "indeterminate";
		} catch {
			logger.warn("notifications: getChat privacy check indeterminate (request failed)");
			return "indeterminate";
		}
	}

	/** Keep existing outbound callers fail-closed for indeterminate privacy. */
	private async pairedChatIsPrivate(): Promise<boolean> {
		return (await this.resolvePairedChatPrivacy()) === "private";
	}

	/** Tell the user once (per daemon run) how to enable Threaded Mode. */
	private async notifyThreadedFallback(): Promise<void> {
		if (this.threadedFallbackNoticeSent || !(await this.pairedChatIsPrivate())) return;
		this.threadedFallbackNoticeSent = true;
		try {
			await this.botApi.call("sendMessage", {
				chat_id: this.opts.chatId,
				text: "Flat Telegram private chat supports outbound notifications and inline ask buttons only. Enable Threaded Mode in @BotFather > Bot Settings > Threads Settings for free-text replies and session commands.",
				parse_mode: TELEGRAM_PARSE_MODE,
			});
		} catch {
			// Best-effort nudge; never block delivery.
		}
	}

	private startFlushTimer(): void {
		this.runtime.startInterval("telegram-flush", RATE_LIMIT_FLUSH_INTERVAL_MS, () => {
			if (!this.running || this.pool.pending === 0) return;
			void this.flushPool();
		});
	}

	private stopFlushTimer(): void {
		this.runtime.stopInterval("telegram-flush");
	}

	/** Run a root scan, guarding against overlapping scans from the timer + loop. */
	private async runScan(): Promise<void> {
		await this.runtime.runExclusive("telegram-scan", async () => {
			await this.scanRoots();
		});
	}

	private startScanTimer(): void {
		this.runtime.startInterval("telegram-scan", this.opts.scanIntervalMs ?? SESSION_SCAN_INTERVAL_MS, () => {
			if (!this.running) return;
			void this.runScan();
		});
	}

	private stopScanTimer(): void {
		this.runtime.stopInterval("telegram-scan");
	}

	/** Send a single `typing` chat action into a busy session's topic (best-effort). */
	private async sendTyping(sessionId: string): Promise<void> {
		const topicId = this.topics.get(sessionId)?.topicId;
		if (!topicId || !(await this.pairedChatIsPrivate())) return;
		try {
			await this.botApi.call("sendChatAction", {
				chat_id: this.opts.chatId,
				message_thread_id: Number(topicId),
				action: "typing",
			});
		} catch {
			// Best-effort: a failed chat action must never stop the daemon.
		}
	}

	/** Set a native reaction on an inbound thread message (best-effort). */
	private async setReaction(
		sessionId: string,
		messageId: number,
		emoji: string,
		generation = this.admissionGeneration(sessionId),
	): Promise<void> {
		if (generation === undefined || !(await this.pairedChatIsPrivate())) return;
		const release = this.beginTopicOperation(sessionId, generation);
		if (!release) return;
		try {
			await this.providerBotApi.call("setMessageReaction", {
				chat_id: this.opts.chatId,
				message_id: messageId,
				reaction: [{ type: "emoji", emoji }],
			});
		} catch {
			// Best-effort: reactions may be disallowed in the chat; never throw.
		} finally {
			release();
		}
	}

	private startTypingTimer(): void {
		this.runtime.startInterval("telegram-typing", TYPING_REFRESH_INTERVAL_MS, () => {
			if (!this.running || this.busy.size === 0) return;
			for (const sessionId of this.busy) void this.sendTyping(sessionId);
		});
	}

	private stopTypingTimer(): void {
		this.runtime.stopInterval("telegram-typing");
	}

	async handleSessionMessage(session: SessionSocket, msg: any): Promise<void> {
		if (session.replayPending) {
			const matchingReplay = msg?.type === "event_replay_result" && msg.id === session.replayId;
			if (!matchingReplay) {
				session.replayQueue.push(msg as Record<string, unknown>);
				return;
			}
			session.replayPending = false;
			const replayValid =
				Number.isSafeInteger(msg.generation) &&
				msg.generation >= 1 &&
				Number.isSafeInteger(msg.lastSeq) &&
				msg.lastSeq >= 0 &&
				Array.isArray(msg.events);
			const replayed: Record<string, unknown>[] = replayValid
				? (msg.events as unknown[]).flatMap((event: unknown): Record<string, unknown>[] => {
						if (!event || typeof event !== "object" || Array.isArray(event)) return [];
						const envelope = event as Record<string, unknown>;
						const payload = envelope.payload;
						return [
							payload && typeof payload === "object" && !Array.isArray(payload)
								? (payload as Record<string, unknown>)
								: envelope,
						];
					})
				: [];
			// Replay restores durable attachment state only. Live notification effects
			// (turn streams, context updates, lifecycle messages) may already have been
			// delivered before a reconnect and must never be rendered a second time.
			const identityIndex = replayed.findLastIndex(frame => frame.type === "identity_header");
			const currentGeneration = identityIndex < 0 ? replayed : replayed.slice(identityIndex);
			const latestIdentity = identityIndex < 0 ? undefined : replayed[identityIndex];
			const latestActions = new Map<string, Record<string, unknown>>();
			for (const frame of currentGeneration) {
				if ((frame.type === "action_needed" || frame.type === "action_resolved") && typeof frame.id === "string")
					latestActions.set(frame.id, frame);
			}
			const replayState = [...(latestIdentity ? [latestIdentity] : []), ...latestActions.values()];
			const replayCounts = new Map<string, number>();
			for (const frame of replayState) {
				const fingerprint = JSON.stringify(frame);
				replayCounts.set(fingerprint, (replayCounts.get(fingerprint) ?? 0) + 1);
				await this.handleSessionMessage(session, frame);
			}
			const queued = session.replayQueue.splice(0);
			for (const frame of queued) {
				const fingerprint = JSON.stringify(frame);
				const remaining = replayCounts.get(fingerprint) ?? 0;
				if (remaining > 0) {
					if (remaining === 1) replayCounts.delete(fingerprint);
					else replayCounts.set(fingerprint, remaining - 1);
					continue;
				}
				await this.handleSessionMessage(session, frame);
			}
			if (replayValid && this.topics.markReplayCursor(session.sessionId, msg.generation, msg.lastSeq))
				await this.persistTopics();
			return;
		}
		if (msg?.type === "event_replay_result") return;
		if (await this.sessionRouter.dispatch(session, msg as Record<string, unknown>)) return;
		if (typeof msg?.type === "string" && TelegramNotificationDaemon.THREADED_FRAMES.has(msg.type)) {
			const send = renderThreadedFrame(msg);
			if (!send) return;
			const existingTopic = await this.existingTopicForPrivateChat(session.sessionId);
			if (!send.identity && !existingTopic && !this.flatIdentitySent.has(session.sessionId)) {
				this.rememberPendingThreadedFrame(session.sessionId, send, msg as Record<string, unknown>);
				return;
			}
			if (send.identity && !this.sessionCanClaimIdentity(session, msg)) {
				const ownerId = this.topicOwnerForIdentity(msg);
				const ownerTopic = ownerId ? this.topics.get(ownerId) : undefined;
				if (ownerId && ownerId !== session.sessionId && ownerTopic) {
					await this.flushPendingThreadedFrames(session.sessionId, ownerTopic.topicId);
					return;
				}
			}
			const topicId =
				existingTopic ?? (await this.ensureTopic(session.sessionId, this.topicNameFor(session.sessionId, msg)));
			if (!topicId) {
				await this.deliverFlatFallback(session.sessionId, send);
				return;
			}
			if (send.identity) {
				const identityKey = this.topicIdentityKey(msg);
				if (identityKey) {
					this.topicOwnerByIdentity.set(identityKey, session.sessionId);
					if (this.topics.markIdentityKey(session.sessionId, identityKey)) await this.persistTopics();
				}
				// Explicit Telegram-side user renames own the topic title. Pending user
				// reconciliation runs before daemon identity naming, so retries and daemon
				// restarts cannot silently replace the preserved name.
				await this.reconcileUserTopicName(session.sessionId, topicId);
				const name = this.topicNameFor(session.sessionId, msg);
				if (this.topics.needsRename(session.sessionId, name)) {
					this.daemonRenameAttempts.set(
						session.sessionId,
						(this.daemonRenameAttempts.get(session.sessionId) ?? 0) + 1,
					);
					try {
						const response = await this.botApi.call("editForumTopic", {
							chat_id: this.opts.chatId,
							message_thread_id: Number(topicId),
							name,
						});
						if (topicRenameApplied(response)) this.topics.markNameApplied(session.sessionId, name);
					} catch {
						// Best-effort rename; leave daemon-owned names unchanged so a
						// later identity frame retries.
					} finally {
						const remaining = (this.daemonRenameAttempts.get(session.sessionId) ?? 1) - 1;
						if (remaining > 0) this.daemonRenameAttempts.set(session.sessionId, remaining);
						else {
							this.daemonRenameAttempts.delete(session.sessionId);
							await this.reconcileUserTopicName(session.sessionId, topicId);
						}
					}
				}
				// Send the full bulleted identity header EXACTLY ONCE per topic.
				if (this.topics.needsIdentity(session.sessionId)) {
					await this.submitThreadedFrame(session.sessionId, send, topicId);
					this.topics.markIdentitySent(session.sessionId);
				}
				await this.flushPendingThreadedFrames(session.sessionId, topicId);
				await this.persistTopics();
				return;
			}
			await this.submitThreadedFrame(session.sessionId, send, topicId);
			return;
		}
		if (msg.type === "action_needed" && msg.id) {
			if (msg.kind === "ask") session.pending.set(msg.id, { sessionId: session.sessionId, actionId: msg.id });
			const topicId = await this.ensureTopic(session.sessionId, this.topicNameFor(session.sessionId, msg));
			if (!topicId) {
				// Fail closed for non-private chats; only nudge + flat-deliver in a private DM.
				if (!(await this.pairedChatIsPrivate())) return;
				await this.notifyThreadedFallback();
			}
			const threadField = topicId ? { message_thread_id: Number(topicId) } : {};
			const controls: Array<{
				id: "navigation_forward";
				kind: "navigation";
				label: "Next" | "Done";
				enabled: boolean;
			}> = Array.isArray(msg.controls)
				? msg.controls.filter(
						(
							control: unknown,
						): control is {
							id: "navigation_forward";
							kind: "navigation";
							label: "Next" | "Done";
							enabled: boolean;
						} =>
							!!control &&
							typeof control === "object" &&
							(control as { id?: unknown }).id === "navigation_forward" &&
							(control as { kind?: unknown }).kind === "navigation" &&
							((control as { label?: unknown }).label === "Next" ||
								(control as { label?: unknown }).label === "Done") &&
							(control as { enabled?: unknown }).enabled === true,
					)
				: [];
			const rendered = buildActionMessage({
				kind: msg.kind ?? "ask",
				id: msg.id,
				question: msg.question,
				options: msg.options,
				controls,
				summary: msg.summary,
			});
			const options = Array.isArray(msg.options) ? msg.options : [];
			const inline_keyboard = [
				...buildCompactChoiceGrid(options, (i: number) =>
					this.aliasTable.put({ sessionId: session.sessionId, actionId: msg.id, answer: i }),
				),
				...controls.map(control => [
					{
						text: control.label,
						callback_data: this.aliasTable.put({
							sessionId: session.sessionId,
							actionId: msg.id,
							answer: { controlId: control.id },
						}),
					},
				]),
			];
			// HTML delivery: one sendMessage per chunk, keyboard on the last chunk;
			// returns the last chunk's message_id (the reply-routable message).
			const sendHtmlChunks = async (): Promise<number | undefined> => {
				const chunks = splitTelegramHtml(rendered.text);
				let result: { result?: { message_id?: number } } = {};
				for (let i = 0; i < chunks.length; i++) {
					result = (await this.botApi.call("sendMessage", {
						chat_id: this.opts.chatId,
						...threadField,
						text: chunks[i]!,
						parse_mode: TELEGRAM_PARSE_MODE,
						...(i === chunks.length - 1 && inline_keyboard.length ? { reply_markup: { inline_keyboard } } : {}),
					})) as { result?: { message_id?: number } };
				}
				return result.result?.message_id;
			};
			const kind = msg.kind === "idle" ? "idle" : "ask";
			if (this.opts.rich?.enabled !== false) {
				// Rich (default on): promote to sendRichMessage with a top-level
				// reply_markup (probe-confirmed). Any miss falls back to the HTML loop.

				const outcome = await deliverRichActionWithFallback(
					this.botApi,
					{ chat_id: this.opts.chatId, ...threadField },
					{
						markdown: buildActionMarkdown({
							kind,
							question: msg.question,
							options: msg.options,
							summary: msg.summary,
						}),
						replyMarkup: kind === "ask" && inline_keyboard.length ? { inline_keyboard } : undefined,
						requireMessageId: kind === "ask",
					},
					sendHtmlChunks,
					logger,
				);
				// Only asks are reply-routable; idle pings register no route.
				if (kind === "ask" && outcome.messageId !== undefined)
					this.messageRoutes.set(String(outcome.messageId), { sessionId: session.sessionId, actionId: msg.id });
			} else {
				// Off: byte-identical to the pre-rich HTML path.
				const messageId = await sendHtmlChunks();
				// Only asks are reply-routable; idle pings register no route (parity
				// with the rich branch and correct even in the byte-identical off path).
				if (kind === "ask" && messageId !== undefined)
					this.messageRoutes.set(String(messageId), { sessionId: session.sessionId, actionId: msg.id });
			}
			await this.persistAliases();
		} else if (msg.type === "action_resolved" && msg.id) {
			session.pending.delete(msg.id);
			this.deleteMessageRoutes(session.sessionId, msg.id);
			for (const [alias, route] of this.aliasTable.entries()) {
				if (route.sessionId === session.sessionId && route.actionId === msg.id) this.aliasTable.delete(alias);
			}
			await this.persistAliases();
		}
	}

	private async answerCallbackQueryBestEffort(callbackId: unknown, text?: string): Promise<void> {
		if (typeof callbackId !== "string") return;
		try {
			await this.botApi.call("answerCallbackQuery", {
				callback_query_id: callbackId,
				...(text === undefined ? {} : { text }),
			});
		} catch {
			// Telegram callback acknowledgements only dismiss the client-side spinner;
			// they must never block the already-validated local reply path.
		}
	}

	private async sendStaleGuidance(callbackId: unknown): Promise<void> {
		await this.answerCallbackQueryBestEffort(callbackId, "Button is stale");
		if (!(await this.pairedChatIsPrivate())) return;
		await this.botApi.call("sendMessage", {
			chat_id: this.opts.chatId,
			text: "This button is stale after notification daemon restart. Please answer locally in the GJC session or wait for a fresh notification.",
			parse_mode: TELEGRAM_PARSE_MODE,
		});
	}

	/** Consume Telegram forum-topic rename service messages before text routing. */
	private async handleForumTopicEdited(update: unknown): Promise<"not-topic" | TelegramUpdateOutcome> {
		const parsed = update as {
			update_id?: unknown;
			message?: {
				chat?: { id?: unknown };
				from?: { id?: unknown; is_bot?: unknown };
				message_thread_id?: unknown;
				forum_topic_edited?: { name?: unknown };
			};
		};
		const message = parsed.message;
		if (!message?.forum_topic_edited) return "not-topic";
		const updateId = parsed.update_id;
		if (typeof updateId !== "number" || !Number.isSafeInteger(updateId) || updateId < 0) return "consumed";
		if (this.dispatchState.seenUpdateIds.has(updateId)) return "consumed";
		const configuredUserId = Number(this.opts.chatId);
		if (
			!Number.isSafeInteger(configuredUserId) ||
			typeof message.chat?.id !== "number" ||
			message.chat.id !== configuredUserId ||
			message.from?.id !== configuredUserId ||
			message.from?.is_bot !== false
		)
			return "consumed";
		const privacy = await this.resolvePairedChatPrivacy();
		if (privacy === "indeterminate") return "retry";
		if (privacy !== "private") return "consumed";
		const threadId = message.message_thread_id;
		if (typeof threadId !== "number" || !Number.isSafeInteger(threadId)) return "consumed";
		const sessionId = this.topics.sessionForTopic(String(threadId));
		if (!sessionId) return "consumed";
		const name = message.forum_topic_edited.name;
		if (typeof name !== "string" || name.trim().length === 0) return "consumed";
		const result = this.topics.markUserName(sessionId, name, updateId);
		if (result === "stale") {
			await this.rememberSeenUpdateId(updateId);
			return "consumed";
		}
		if (result === "duplicate") {
			try {
				await this.persistTopics();
			} catch {
				return "retry";
			}
			await this.reconcileUserTopicName(sessionId, String(threadId));
			await this.rememberSeenUpdateId(updateId);
			return "consumed";
		}
		try {
			await this.persistTopics();
		} catch {
			return "retry";
		}
		await this.reconcileUserTopicName(sessionId, String(threadId));
		await this.rememberSeenUpdateId(updateId);
		return "consumed";
	}

	private async processTelegramUpdate(update: unknown): Promise<TelegramUpdateOutcome> {
		const topicOutcome = await this.handleForumTopicEdited(update);
		if (topicOutcome !== "not-topic") return topicOutcome;
		try {
			await this.handleTelegramUpdate(update);
		} catch (err) {
			logger.error("notifications daemon: handleTelegramUpdate failed", { error: String(err) });
		}
		return "consumed";
	}

	async handleTelegramUpdate(update: unknown): Promise<void> {
		if ((await this.handleForumTopicEdited(update)) !== "not-topic") return;
		// Session-lifecycle command (/session_*): handled ONLY from the paired chat,
		// gated before any arg parsing or side effect, and routed through the control
		// endpoint. Must run before threaded-injection so commands are not treated as
		// session input.
		{
			const m = (update as { update_id?: number; message?: Record<string, unknown> }).message;
			const chat = m?.chat as { id?: unknown; type?: unknown } | undefined;
			const chatId = chat?.id;
			const chatType = typeof chat?.type === "string" ? chat.type : undefined;
			const cmdText = typeof m?.text === "string" ? m.text : undefined;
			const commandCtx = { chatType, botUsername: this.botUsername };
			if (m !== undefined && String(chatId) === String(this.opts.chatId)) {
				if (chatType !== undefined && chatType !== "private" && isLifecycleCommandLikeText(cmdText)) return;
				if (isLifecycleCommandText(cmdText, commandCtx)) {
					const updateId = (update as { update_id?: number }).update_id;
					const threadId = typeof m.message_thread_id === "number" ? (m.message_thread_id as number) : undefined;
					if (await this.handleLifecycleCommand(cmdText, updateId, threadId, commandCtx)) return;
				}
			}
		}
		// Rich-message toggle (/rich on|off): daemon-local delivery policy, NOT a
		// session config forward. Handled at paired-chat pre-routing, before threaded
		// injection and independent of any session WebSocket, so it works even when
		// no session is connected and never becomes an ask answer.
		{
			const m = (update as { update_id?: number; message?: Record<string, unknown> }).message;
			const chat = m?.chat as { id?: unknown } | undefined;
			const cmdText = typeof m?.text === "string" ? m.text : undefined;
			const rawFirst = cmdText?.trim().split(/\s+/)[0]?.toLowerCase();
			// Fail-closed: intercept ANY "/rich" or "/rich@<anything>" form (Telegram
			// appends @botname in groups; the bot username may be unknown if getMe
			// failed) so a rich command is never leaked into threaded injection / an
			// ask answer. Argument validity is decided by parseRichToggleCommand below.
			const isRichCommand = rawFirst?.split("@")[0] === "/rich";
			if (m !== undefined && String(chat?.id) === String(this.opts.chatId) && isRichCommand) {
				// Fail-closed: /rich mutates global config, so honor it ONLY in a PRIVATE
				// paired chat — the same contract as session delivery and lifecycle
				// commands. A group/supergroup chatId (legacy or hand-edited) must never
				// let an arbitrary chat member toggle the owner's notification config.
				if (!(await this.pairedChatIsPrivate())) return;
				const updateId = (update as { update_id?: number }).update_id;
				// Dedupe redelivered updates so a toggle+confirmation runs at most once.
				if (typeof updateId === "number") {
					if (this.dispatchState.seenUpdateIds.has(updateId)) return;
					await this.rememberSeenUpdateId(updateId);
				}
				const threadField =
					typeof m.message_thread_id === "number" ? { message_thread_id: m.message_thread_id as number } : {};
				const reply = async (body: string): Promise<void> => {
					try {
						await this.botApi.call("sendMessage", {
							chat_id: this.opts.chatId,
							...threadField,
							text: body,
							parse_mode: TELEGRAM_PARSE_MODE,
						});
					} catch {
						// Best-effort confirmation; never block on the notice.
					}
				};
				const desired = parseRichToggleCommand(cmdText ?? "");
				if (desired === undefined) {
					await reply("Usage: /rich on|off");
					return;
				}
				try {
					await this.opts.settings.set("notifications.telegram.rich.enabled", desired);
					// Confirm success only after a DURABLE write. The real Settings.set is
					// a synchronous fire-and-forget whose queued save (Settings.#saveNow)
					// swallows write errors, and Settings.flush() inherits that — neither
					// rejects on a failed config.yml write. flushOrThrow() rethrows the
					// durable-write failure so it lands in the catch below (in-memory
					// isolated Settings short-circuit and never throw). The lightweight
					// daemon settings has no flushOrThrow: its set() already wrote durably
					// (and throws on failure), so its flush() is only a no-op drain.
					await flushRichToggleSettings(this.opts.settings);
				} catch (err) {
					logger.warn(
						`notifications: /rich settings write failed (${err instanceof Error ? err.message : String(err)}); runtime unchanged`,
					);
					await reply("Rich messages: unchanged (settings write failed)");
					return;
				}
				this.opts.rich = { enabled: desired };
				await reply(desired ? "Rich messages: on" : "Rich messages: off");
				return;
			}
		}
		// Threaded injection: a free-text message in a known topic (not a button
		// tap and not a reply to a specific ask message) injects a user turn or an
		// in-thread config command. Fail-closed: paired chat + known topic +
		// update_id dedupe are all enforced by decideThreadedInbound.
		const raw = update as {
			callback_query?: unknown;
			message?: { reply_to_message?: { message_id?: unknown } };
		};
		// A reply to a known ask message routes to that ask (below). Any OTHER
		// message in a topic (plain text, or a reply to a non-ask message) is a
		// free-text injection. Previously replies bypassed injection entirely.
		const replyTo = raw.message?.reply_to_message?.message_id;
		const isAskReply =
			replyTo !== undefined && (this.messageRoutes.has(String(replyTo)) || this.messageRoutes.has(Number(replyTo)));
		if (!raw.callback_query && !isAskReply) {
			const inbound = decideThreadedInbound(update as never, {
				pairedChatId: this.opts.chatId,
				topicToSession: t => this.topics.sessionForTopic(t),
				isDuplicate: id => this.dispatchState.seenUpdateIds.has(id),
			});
			if (inbound.kind === "duplicate") return;
			if (inbound.kind === "inject") {
				const session = this.sessions.get(inbound.sessionId);
				if (session?.ws.readyState === WebSocket.OPEN && (await this.sessionAdmissionIsCurrent(session))) {
					const attachmentResult = inbound.attachment
						? await this.resolveInboundAttachment(inbound.attachment, inbound.sessionId)
						: undefined;
					const images = attachmentResult?.images ?? [];
					const fileNotes = attachmentResult?.fileNotes ?? [];
					const hasMedia = images.length > 0 || fileNotes.length > 0;
					const baseInjectedText = [inbound.text, ...fileNotes].filter(Boolean).join("\n");
					// A reply to a rich message we sent (not an ask route) loses its original
					// text: Telegram does not echo it in reply_to_message. Restore it from the
					// reply index as a labeled context prefix; a miss leaves the turn unchanged.
					const repliedOriginal =
						typeof replyTo === "number"
							? this.replyStore.lookup({ chatId: this.opts.chatId, messageId: replyTo })
							: undefined;
					const injectedText = repliedOriginal
						? `> replied-to message:\n${repliedOriginal}\n\n${baseInjectedText}`
						: baseInjectedText;
					const control = hasMedia
						? { kind: "none" as const }
						: parseTelegramControlCommand(inbound.text, this.botUsername);
					if (control.kind !== "none") {
						await this.rememberSeenUpdateId(inbound.updateId);
						const sendControlNotice = async (body: string): Promise<void> => {
							try {
								await this.botApi.call("sendMessage", {
									chat_id: this.opts.chatId,
									message_thread_id: Number(inbound.threadId),
									text: body,
									parse_mode: TELEGRAM_PARSE_MODE,
								});
							} catch {
								// Best-effort control feedback; never convert to user input.
							}
						};
						if (control.kind === "ignored") return;
						if (control.kind === "invalid") {
							await sendControlNotice(control.usage);
							return;
						}
						if (
							!(await this.sendToCurrentSession(session, {
								type: "control_command",
								sessionId: inbound.sessionId,
								token: session.token,
								requestId: `tg:${inbound.updateId}`,
								updateId: inbound.updateId,
								threadId: inbound.threadId,
								command: control.command,
							}))
						) {
							await sendControlNotice("Session control unavailable: session is disconnected.");
						}
						return;
					}
					const cfg = hasMedia ? undefined : parseInThreadConfigCommand(inbound.text);
					// A plain (non-config) message while an ask is pending for this session
					// answers that ask as free-input — instead of starting a new user turn.
					// Telegram asks always accept custom text (the SDK maps a string answer
					// to the ask's custom-input slot), so route the latest pending ask here.
					const pendingAsk = cfg || hasMedia ? undefined : [...session.pending.values()].at(-1);
					if (pendingAsk) {
						if (
							!(await this.sendToCurrentSession(session, {
								type: "reply",
								id: pendingAsk.actionId,
								answer: inbound.text,
								token: session.token,
							}))
						) {
							return;
						}
						await this.rememberSeenUpdateId(inbound.updateId);
						if (inbound.messageId !== undefined) {
							await this.setReaction(inbound.sessionId, inbound.messageId, QUEUED_REACTION);
						}
						return;
					}
					if (
						!(await this.sendToCurrentSession(
							session,
							cfg
								? { type: "config_command", sessionId: inbound.sessionId, token: session.token, ...cfg }
								: {
										type: "user_message",
										sessionId: inbound.sessionId,
										text: injectedText,
										token: session.token,
										updateId: inbound.updateId,
										threadId: inbound.threadId,
										images,
									},
						))
					) {
						return;
					}
					await this.rememberSeenUpdateId(inbound.updateId);
					// User turns get a native delivery double-check: queued on receipt,
					// flipped to consumed when the session acks the turn that picks it
					// up. Config commands are not user turns and get no reaction.
					if (!cfg && inbound.messageId !== undefined) {
						const generation = this.admissionGeneration(inbound.sessionId);
						if (generation !== undefined) {
							this.inboundReactions.set(inbound.updateId, {
								messageId: inbound.messageId,
								sessionId: inbound.sessionId,
								generation,
							});
							await this.setReaction(inbound.sessionId, inbound.messageId, QUEUED_REACTION, generation);
						}
					}
				} else if (session) {
					this.dropSession(session, "admission_identity_mismatch");
				}
				return;
			}
		}
		const callbackId = (update as { callback_query?: { id?: unknown } }).callback_query?.id;
		const decision = routeInboundUpdate(update, {
			aliasTable: this.aliasTable,
			messageRoutes: this.messageRoutes,
			pairedChatId: this.opts.chatId,
		});
		if (decision.kind === "reply") {
			const session = this.sessions.get(decision.sessionId);
			const admissionCurrent = session ? await this.sessionAdmissionIsCurrent(session) : false;
			if (session && !admissionCurrent) this.dropSession(session, "admission_identity_mismatch");
			if (
				session?.ws.readyState !== WebSocket.OPEN ||
				!session.pending.has(decision.actionId) ||
				!admissionCurrent
			) {
				await this.sendStaleGuidance(callbackId);
				return;
			}
			if (
				!(await this.sendToCurrentSession(session, {
					type: "reply",
					id: decision.actionId,
					answer: decision.answer,
					token: session.token,
				}))
			) {
				await this.sendStaleGuidance(callbackId);
				return;
			}
			await this.answerCallbackQueryBestEffort(callbackId);
		} else if (decision.kind === "stale") {
			await this.sendStaleGuidance(callbackId);
		}
	}

	async pollOnce(signal?: AbortSignal): Promise<number> {
		return this.poller.pollOnce(signal);
	}

	/** Sync the bot's Telegram command menu to what the daemon actually handles. */
	async registerBotCommands(): Promise<void> {
		try {
			await this.botApi.call("setMyCommands", {
				commands: [
					{ command: "verbose", description: "Mirror full tool output + reasoning in this thread" },
					{ command: "lean", description: "Mirror assistant text + tool names only (default)" },
					{ command: "redact", description: "Toggle redaction of streamed content: /redact <on|off>" },
					{ command: "rich", description: "Toggle rich Telegram delivery: /rich <on|off>" },
					{ command: "reasoning", description: "Show or change reasoning effort in this session" },
					{ command: "usage", description: "Show provider/local usage for this session" },
					{ command: "context", description: "Show current context usage for this session" },
					{ command: "compact", description: "Compact this session: /compact [instructions]" },
					{ command: "session_create", description: "Create a GJC session: path, worktree, or dir [--mpreset]" },
					{ command: "session_recent", description: "List recent GJC sessions" },
					{ command: "session_close", description: "Close a GJC-managed session" },
					{ command: "session_resume", description: "Resume or reattach a session" },
				],
			});
		} catch {
			// Best-effort: a failed command-menu sync must never stop the daemon.
		}
	}

	async run(): Promise<void> {
		this.running = await renewDaemonHeartbeat({
			settings: this.opts.settings,
			ownerId: this.opts.ownerId,
			fs: this.fsImpl,
			now: this.opts.now,
			pid: this.opts.pid ?? process.pid,
		});
		if (!this.running) return;
		this.runtime.start();
		try {
			await this.refreshBotIdentity();
			await this.registerBotCommands();
			await this.loadAliases();
			await this.loadTopics();
			// F004: reconcile the durable deletion journal before scanning so a
			// crash-completed (terminal) deletion finishes local cleanup without
			// calling Telegram again, and a nonterminal claim is re-attempted.
			await this.reconcileDeletionJournal();
			await this.loadSeenUpdateIds();
			await this.replyStore.load();
			await this.runScan();
			this.startFlushTimer();
			this.startScanTimer();
			this.startTypingTimer();
			// Owner-only: start the session-lifecycle control server now that
			// ownership is confirmed (singleton-safe). Best-effort; degrades.
			await this.startLifecycleControl();
			let idleSince = this.runtime.now();
			while (this.running) {
				if (await this.controlStopRequested()) break;
				if (
					!(await renewDaemonHeartbeat({
						settings: this.opts.settings,
						ownerId: this.opts.ownerId,
						fs: this.fsImpl,
						now: this.opts.now,
						pid: this.opts.pid ?? process.pid,
					}))
				)
					break;
				await this.runScan();
				if (await this.controlStopRequested()) break;
				const idleElapsed = this.runtime.now() - idleSince >= (this.opts.idleTimeoutMs ?? 60_000);
				if (this.sessions.size > 0) {
					idleSince = this.runtime.now();
				} else if (idleElapsed) {
					// Zero sessions past the idle window: exit so the owner does not run
					// forever. An active session resets the idle window above.
					break;
				}
				// Poll getUpdates whenever the daemon owns the token — even with zero
				// sessions and no lifecycle control — so daemon-local commands (/rich,
				// /session_*) are always received until idle-exit.
				const activePoll = this.runtime.createAbortController();
				try {
					await this.pollOnce(activePoll.signal);
					this.loopBackoff.reset();
				} catch (e) {
					// A transient getUpdates/network failure must not kill the daemon.
					// Back off (bounded, below the heartbeat TTL) and keep renewing
					// ownership at the loop top.
					const backoffMs = this.loopBackoff.next();
					logger.warn(`notifications: getUpdates failed, backing off ${backoffMs}ms: ${String(e)}`);
					await this.runtime.sleep(backoffMs);
					continue;
				} finally {
					this.runtime.clearAbortController(activePoll);
				}
				if (await this.controlStopRequested()) break;
				await this.runtime.sleep(10);
			}
		} finally {
			this.runtime.stop();
			this.stopFlushTimer();
			this.stopScanTimer();
			this.stopTypingTimer();
			this.stopLifecycleControl();
			await this.cleanupAllAttachmentDirs();
			// Persist durable state before releasing ownership so a fresh daemon
			// (e.g. after reload) reloads aliases/topics seamlessly.
			await this.persistAliases().catch(() => undefined);
			await this.persistTopics().catch(() => undefined);
			await this.persistSeenUpdateIds().catch(() => undefined);
			await this.opts.control?.clear?.(this.opts.ownerId).catch(() => undefined);
			await releaseDaemonOwnership({
				settings: this.opts.settings,
				ownerId: this.opts.ownerId,
				fs: this.fsImpl,
				now: this.opts.now,
			});
		}
	}

	/** True when a signal-driven stop or an owner-scoped control request asks the loop to exit. */
	private async controlStopRequested(): Promise<boolean> {
		if (this.runtime.stopRequested) return true;
		if (!this.opts.control) return false;
		try {
			return await this.opts.control.shouldStop(this.opts.ownerId);
		} catch {
			return false;
		}
	}
}
