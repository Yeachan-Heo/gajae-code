import { AsyncLocalStorage } from "node:async_hooks";
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
import { getNotificationConfig, isTelegramConfigured, tokenFingerprint } from "./config";
import { parseInThreadConfigCommand, parseRichToggleCommand, parseTelegramControlCommand } from "./config-commands";
import { daemonPaths, HEARTBEAT_TTL_MS } from "./daemon-paths";
import { sanitizeDiagnostic } from "./notification-service";
import { DAEMON_GENERATION, NOTIFICATION_PROTOCOL_VERSION } from "./telegram-daemon-contract";
import { withTelegramSetupLease } from "./telegram-setup";

export { DAEMON_GENERATION, NOTIFICATION_PROTOCOL_VERSION } from "./telegram-daemon-contract";

import {
	buildButtonGrid,
	buildCompactChoiceGrid,
	code,
	markdownToTelegramHtml,
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
import type { OrchestratorDeps } from "./lifecycle-orchestrator";
import { NotificationOperatorRuntime, OperatorBackoffPolicy, OperatorEventRouter } from "./operator-runtime";
import { RateLimitPool } from "./rate-limit-pool";
import { listRecentSessions } from "./recent-activity";
import { ReplySentStore } from "./reply-sent-store";
import { DraftStreamState, deliverDraft, shouldStreamDraft } from "./rich-draft";
import {
	deliverRichActionWithFallback,
	deliverRichWithFallback,
	isBtwRichEligible,
	shouldPromoteRich,
} from "./rich-render";
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

export type EnsureDaemonResult = "owner_spawned" | "attached" | "disabled" | "blocked";
/** Detailed result for orchestration that must distinguish a #2028 handoff from a fresh spawn. */
export type EnsureTelegramDaemonDetailedResult = "spawned" | "reloaded" | "attached" | "disabled" | "blocked_identity";

export interface DaemonState {
	pid: number;
	ownerId: string;
	tokenFingerprint: string;
	chatId: string;
	startedAt: number;
	heartbeatAt: number;
	roots: string[];
	/**
	 * Present only for the Windows source-launch handoff. `pid` starts as this
	 * short-lived launcher PID and may be rebound exactly once to the daemon PID.
	 */
	launcherPid?: number;
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
	open(path: string, flags: string, mode?: number): Promise<{ close(): Promise<void> }>;
	readdir(path: string): Promise<string[]>;
	chmod(path: string, mode: number): Promise<void>;
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
	/** Injectable platform seam for source-linked Windows daemon spawning. */
	platform?: NodeJS.Platform;
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
/** Capability required for typed controls and semantic Selected acknowledgement frames. */
export const ASK_SELECTED_ACK_CAPABILITY = "ask_selected_ack_v1";
export const ASK_CONTROLS_CAPABILITY = "ask_controls_v1";
/** Capability required for tool lifecycle and reasoning-summary frames. */
export const TOOL_ACTIVITY_CAPABILITY = "tool_activity_v1";

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
const CONSUMED_REACTION = "✅";
const MODEL_CALLBACK_PREFIX = "m:";
const MODEL_CHOICE_TTL_MS = 10 * 60 * 1_000;
const BTW_PENDING_TTL_MS = 300_000;
const BTW_MAX_PENDING = 256;
const BTW_SHUTDOWN_JOIN_MS = 1_000;
const BTW_USAGE_TEXT = "Usage: /btw <question>";
const BTW_CAPACITY_TEXT = "Too many /btw questions are pending. Wait for one to finish and try again.";
export const BTW_QUESTION_MAX_UNICODE_SCALARS = 4_096;
export const BTW_QUESTION_MAX_UTF8_BYTES = 16_384;
const BTW_QUESTION_LIMIT_TEXT = "Question must be at most 4096 Unicode scalar values and 16384 UTF-8 bytes.";
type ParsedBtwCommand = { kind: "question"; question: string } | { kind: "ignored" };
class ThreadedModeCapabilityRefusal extends Error {}

/** Only an explicit Bot API capability refusal may enable flat private-chat delivery. */
function isThreadedModeCapabilityRefusal(response: unknown): boolean {
	if (!response || typeof response !== "object") return false;
	const { ok, description } = response as { ok?: unknown; description?: unknown };
	return (
		ok === false &&
		typeof description === "string" &&
		/(?:threaded mode|forum topics? (?:is|are) (?:disabled|not enabled)|(?:not allowed|not permitted|cannot|can't) create forum topics?)/i.test(
			description,
		)
	);
}

function parseBtwCommand(text: string, botUsername?: string): ParsedBtwCommand | undefined {
	const trimmed = text.trim();
	const [rawCommand] = trimmed.split(/\s+/, 1);
	if (!rawCommand) return undefined;
	const command = rawCommand.toLowerCase();
	if (command === "/btw") return { kind: "question", question: trimmed.slice(rawCommand.length).trim() };
	const match = /^\/btw@([^@]+)$/.exec(command);
	if (!match) return command.startsWith("/btw") ? { kind: "question", question: "" } : undefined;
	if (!botUsername || match[1] !== botUsername.toLowerCase()) return { kind: "ignored" };
	return { kind: "question", question: trimmed.slice(rawCommand.length).trim() };
}
function isValidBtwQuestion(question: string): boolean {
	if (Buffer.byteLength(question, "utf8") > BTW_QUESTION_MAX_UTF8_BYTES) return false;
	let scalarCount = 0;
	for (const _scalar of question) {
		scalarCount++;
		if (scalarCount > BTW_QUESTION_MAX_UNICODE_SCALARS) return false;
	}
	return true;
}
const MODEL_BUTTON_LABEL_MAX_BYTES = 48;
const SENSITIVE_MODEL_LABEL =
	/(?:\b(?:https?|wss?):\/\/|\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b|\b(?:api[-_ ]?key|access[-_ ]?token|bearer|secret|password|account(?:\s*id)?|email|exception|stack trace)\b|\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b)/i;

/** Inline-keyboard labels are plain text, bounded, and stripped of visual control characters. */
function safeModelButtonLabel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value
		.replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized) return undefined;
	if (SENSITIVE_MODEL_LABEL.test(normalized)) return undefined;
	if (Buffer.byteLength(normalized, "utf8") <= MODEL_BUTTON_LABEL_MAX_BYTES) return normalized;

	const marker = "…";
	const markerBytes = Buffer.byteLength(marker, "utf8");
	let label = "";
	let labelBytes = 0;
	for (const char of normalized) {
		const charBytes = Buffer.byteLength(char, "utf8");
		if (labelBytes + charBytes + markerBytes > MODEL_BUTTON_LABEL_MAX_BYTES) break;
		label += char;
		labelBytes += charBytes;
	}
	return `${label}${marker}`;
}

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
export function endpointAuthorityDigest(url: string, token: string, connectionIdentity?: string): string {
	// Discovery supplies the authenticated endpoint; normalize presentation-only
	// URL differences before deriving authority, but never trust a client frame.
	const parsed = new URL(url);
	parsed.hash = "";
	parsed.search = "";
	parsed.hostname = parsed.hostname.toLowerCase();
	if (
		((parsed.protocol === "http:" || parsed.protocol === "ws:") && parsed.port === "80") ||
		((parsed.protocol === "https:" || parsed.protocol === "wss:") && parsed.port === "443")
	)
		parsed.port = "";
	return crypto
		.createHash("sha256")
		.update(`${parsed.toString()}\0${token}\0${connectionIdentity ?? ""}`, "utf8")
		.digest("hex");
}

function endpointGenerationKey(url: string, token: string): string {
	return endpointAuthorityDigest(url, token);
}

function topicRenameApplied(response: unknown): boolean {
	return !!response && typeof response === "object" && (response as { ok?: unknown }).ok === true;
}
function topicDeleteSettled(response: unknown): boolean {
	if (!response || typeof response !== "object") return false;
	const result = response as { ok?: unknown; description?: unknown };
	if (result.ok === true) return true;
	if (typeof result.description !== "string") return false;
	return /(?:TOPIC_ID_INVALID|message thread not found)/i.test(result.description);
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
export function deriveLifecycleAuditRedactionKey(botToken: string): Uint8Array {
	return crypto.createHmac("sha256", botToken).update("gjc.lifecycle.audit.v2.key", "utf8").digest();
}

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
	auditRedactionKey: Uint8Array;
	env?: NodeJS.ProcessEnv;
}): OrchestratorDeps {
	const deps = buildOrchestratorDeps({
		pairedChatId: input.pairedChatId,
		agentNotificationsDir: daemonPaths(input.agentDir).dir,
		agentDir: input.agentDir,
		sessionsRoot: path.join(input.agentDir, "sessions"),
		auditRedactionKey: input.auditRedactionKey,
		env: input.env,
	});
	attachLifecycleControl(input.controlServer, deps);
	return deps;
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
	const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	await fsImpl.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
	await fsImpl.chmod(tmp, 0o600).catch(() => undefined);
	await fsImpl.rename(tmp, file);
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
function validDaemonPid(pid: unknown): pid is number {
	return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

async function tryCreateOwnershipLock(
	fsImpl: TelegramDaemonFs,
	file: string,
	initialization: { pid: number; startedAt: number },
): Promise<boolean> {
	try {
		await fsImpl.writeFile(file, `${JSON.stringify(initialization)}\n`, { mode: 0o600, flag: "wx" });
		await fsImpl.chmod(file, 0o600).catch(() => undefined);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

export async function registerNotificationRoot(input: {
	settings: Settings;
	cwd: string;
	sessionId: string;
	fs?: TelegramDaemonFs;
}): Promise<string> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	await ensureDir(fsImpl, paths.dir);
	const root = notificationRootForCwd(input.cwd);
	await withFileLock(
		paths.roots,
		async () => {
			const current =
				(await readJson<{ roots?: string[]; sessions?: Record<string, string> }>(fsImpl, paths.roots)) ?? {};
			const roots = new Set(current.roots ?? []);
			roots.add(root);
			await writeJsonAtomic(fsImpl, paths.roots, {
				version: 1,
				roots: Array.from(roots).sort(),
				sessions: { ...(current.sessions ?? {}), [input.sessionId]: root },
			});
		},
		{ staleMs: 10_000 },
	);
	return root;
}

export interface UnregisterNotificationRootResult {
	root: string;
	remainingRoots: number;
}

/** Remove one session's Telegram scan root without disturbing other live session roots. */
export async function unregisterNotificationRoot(input: {
	settings: Settings;
	cwd: string;
	sessionId: string;
	fs?: TelegramDaemonFs;
}): Promise<UnregisterNotificationRootResult> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	const root = notificationRootForCwd(input.cwd);
	await ensureDir(fsImpl, paths.dir);
	let remainingRoots = 0;
	await withFileLock(
		paths.roots,
		async () => {
			const current = await readJson<{ roots?: string[]; sessions?: Record<string, string> }>(fsImpl, paths.roots);
			if (!current) return;
			const sessions = { ...(current.sessions ?? {}) };
			delete sessions[input.sessionId];
			const rootStillReferenced = Object.values(sessions).includes(root);
			const roots = (current.roots ?? []).filter(candidate => candidate !== root || rootStillReferenced);
			remainingRoots = roots.length;
			await writeJsonAtomic(fsImpl, paths.roots, {
				version: 1,
				roots: Array.from(new Set(roots)).sort(),
				sessions,
			});
		},
		{ staleMs: 10_000 },
	);
	return { root, remainingRoots };
}

function notificationRootForCwd(cwd: string): string {
	return path.join(cwd, ".gjc", "state");
}

function validBotToken(token: unknown): token is string {
	return typeof token === "string" && token.length > 0;
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
			state.stoppedAt === undefined &&
			!ownerIdentityMatches(state, input.tokenFingerprint, input.chatId) &&
			validDaemonPid(state.pid) &&
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
			state.stoppedAt === undefined &&
			ownerIdentityMatches(state, input.tokenFingerprint, input.chatId) &&
			input.now - state.heartbeatAt <= HEARTBEAT_TTL_MS &&
			validDaemonPid(state.pid) &&
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
	/** Permit one Windows source launcher PID to daemon PID handoff. */
	allowPidRebind?: boolean;
	/** A caller-supplied opaque owner identity, used when the launcher PID is not durable. */
	ownerId?: string;
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
	if (!validDaemonPid(pid)) return { acquired: false, attached: true };
	const pidAlive = input.pidAlive ?? defaultPidAlive;
	const paths = daemonPaths(input.settings.getAgentDir());
	await ensureDir(fsImpl, paths.dir);
	const ownerId =
		input.ownerId ?? input.randomId?.() ?? `${pid}-${now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	const roots = input.roots ?? (await readJson<{ roots?: string[] }>(fsImpl, paths.roots))?.roots ?? [];
	return withFileLock(paths.ownership, async () => {
		const lockIsPositivelyStale = async (): Promise<boolean> => {
			let initialization: { pid?: unknown; startedAt?: unknown } | undefined;
			try {
				initialization = await readJson<{ pid?: unknown; startedAt?: unknown }>(fsImpl, paths.lock);
			} catch {
				// Legacy daemons wrote an empty lock file. With no live state to
				// identify an owner, malformed metadata must not wedge startup.
				return true;
			}
			if (!initialization) return true;
			if (
				!validDaemonPid(initialization.pid) ||
				typeof initialization.startedAt !== "number" ||
				!Number.isFinite(initialization.startedAt)
			)
				return true;
			return now() - initialization.startedAt > HEARTBEAT_TTL_MS && !pidAlive(initialization.pid);
		};
		const ownershipIsPositivelyStale = async (state: DaemonState | undefined): Promise<boolean> => {
			if (state?.stoppedAt !== undefined) return true;
			if (state && validDaemonPid(state.pid)) return !pidAlive(state.pid);
			return await lockIsPositivelyStale();
		};
		const writeState = async (): Promise<void> => {
			const timestamp = now();
			await writeJsonAtomic(fsImpl, paths.state, {
				pid,
				ownerId,
				tokenFingerprint: input.tokenFingerprint,
				chatId: input.chatId,
				startedAt: timestamp,
				heartbeatAt: timestamp,
				roots,
				version: DAEMON_VERSION,
				generation: DAEMON_GENERATION,
				...(input.allowPidRebind ? { launcherPid: pid } : {}),
			} satisfies DaemonState);
		};
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
		const rejectLiveDifferentIdentity = (state: DaemonState | undefined) =>
			liveOwnerUsesDifferentIdentity({
				state,
				tokenFingerprint: input.tokenFingerprint,
				chatId: input.chatId,
				pidAlive,
			});
		const existing = await readJson<DaemonState>(fsImpl, paths.state);
		if (rejectLiveDifferentIdentity(existing)) {
			return { acquired: false, blocked: true, reason: "identity_mismatch" } as const;
		}
		const existingDecision = attachDecision(existing);
		if (existingDecision) return existingDecision;
		const createdAt = now();
		if (await tryCreateOwnershipLock(fsImpl, paths.lock, { pid, startedAt: createdAt })) {
			await writeState();
			return { acquired: true, ownerId };
		}
		const afterLock = await readJson<DaemonState>(fsImpl, paths.state);
		if (rejectLiveDifferentIdentity(afterLock)) {
			return { acquired: false, blocked: true, reason: "identity_mismatch" } as const;
		}
		const afterLockDecision = attachDecision(afterLock);
		if (afterLockDecision) return afterLockDecision;
		if (!afterLock && !(await lockIsPositivelyStale())) return { acquired: false, attached: true };
		if (!(await tryOpenWx(fsImpl, paths.steal))) return { acquired: false, attached: true };
		try {
			const rechecked = await readJson<DaemonState>(fsImpl, paths.state);
			const recheckedDecision = attachDecision(rechecked);
			if (recheckedDecision) return recheckedDecision;
			if (rejectLiveDifferentIdentity(rechecked)) {
				return { acquired: false, blocked: true, reason: "identity_mismatch" } as const;
			}
			if (
				rechecked &&
				rechecked.stoppedAt === undefined &&
				validDaemonPid(rechecked.pid) &&
				pidAlive(rechecked.pid)
			) {
				return { acquired: false, attached: true };
			}
			if (!rechecked && !(await lockIsPositivelyStale())) {
				return { acquired: false, attached: true };
			}
			if (!(await ownershipIsPositivelyStale(rechecked))) {
				return { acquired: false, attached: true };
			}
			await fsImpl.unlink(paths.lock).catch(() => undefined);
			if (!(await tryCreateOwnershipLock(fsImpl, paths.lock, { pid, startedAt: createdAt }))) {
				return { acquired: false, attached: true };
			}
			await writeState();
			return { acquired: true, ownerId };
		} finally {
			await fsImpl.unlink(paths.steal).catch(() => undefined);
		}
	});
}

export async function renewDaemonHeartbeat(input: {
	settings: Settings;
	ownerId: string;
	/** Bind a daemon heartbeat to the Telegram identity that acquired the lock. */
	tokenFingerprint: string;
	chatId: string;
	/** Require the current daemon PID after the launcher-to-daemon PID rebind. */
	pid: number;
	fs?: TelegramDaemonFs;
	now?: () => number;
}): Promise<boolean> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	return withFileLock(paths.ownership, async () => {
		const state = await readJson<DaemonState>(fsImpl, paths.state);
		if (
			!state ||
			state.stoppedAt !== undefined ||
			typeof input.tokenFingerprint !== "string" ||
			typeof input.chatId !== "string" ||
			!Number.isSafeInteger(input.pid) ||
			input.pid <= 0 ||
			state.ownerId !== input.ownerId ||
			!ownerIdentityMatches(state, input.tokenFingerprint, input.chatId)
		)
			return false;
		if (!validDaemonPid(state.pid)) return false;
		if (state.pid !== input.pid && (!validDaemonPid(state.launcherPid) || state.pid !== state.launcherPid))
			return false;
		await writeJsonAtomic(fsImpl, paths.state, {
			...state,
			pid: input.pid,
			heartbeatAt: (input.now ?? Date.now)(),
		});
		return true;
	});
}

export async function releaseDaemonOwnership(input: {
	settings: Settings;
	ownerId: string;
	/** Bind release to the Telegram identity that acquired the lock. */
	tokenFingerprint: string;
	chatId: string;
	/** Require the current daemon PID after the launcher-to-daemon PID rebind. */
	pid: number;
	fs?: TelegramDaemonFs;
	now?: () => number;
}): Promise<void> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	await withFileLock(paths.ownership, async () => {
		const state = await readJson<DaemonState>(fsImpl, paths.state);
		if (
			!state ||
			state.ownerId !== input.ownerId ||
			!ownerIdentityMatches(state, input.tokenFingerprint, input.chatId) ||
			state.pid !== input.pid
		)
			return;
		await writeJsonAtomic(fsImpl, paths.state, { ...state, stoppedAt: (input.now ?? Date.now)() });
		await fsImpl.unlink(paths.lock).catch(() => undefined);
	});
}

/** Read the persisted daemon ownership state (or undefined when absent). */
export async function readDaemonState(
	settings: Pick<Settings, "getAgentDir">,
	fs: TelegramDaemonFs = nodeFs,
): Promise<DaemonState | undefined> {
	return readJson<DaemonState>(fs, daemonPaths(settings.getAgentDir()).state);
}

/** Read the persisted notification roots list. */
export async function readDaemonRoots(
	settings: Pick<Settings, "getAgentDir">,
	fs: TelegramDaemonFs = nodeFs,
): Promise<string[]> {
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
	const runtimeInfo = resolveGjcRuntimeSpawnInfo(execPath);
	// On Windows, a source-linked Bun/Node detached child can begin after its
	// short-lived CLI parent has exited. Keep the owner id opaque so the
	// daemon-internal launcher does not mistake that parent PID for its owner;
	// the daemon rebinds state.pid and validates token/chat below.
	const ownerId =
		runtimeInfo.mode === "source" && (deps.platform ?? process.platform) === "win32"
			? `daemon-${deps.randomId?.() ?? crypto.randomUUID()}`
			: undefined;
	const ownership = await acquireDaemonOwnership({
		settings: input.settings,
		roots: input.roots,
		tokenFingerprint: input.tokenFingerprint,
		chatId: input.chatId,
		fs: deps.fs,
		now: deps.now,
		pid: deps.pid,
		pidAlive: deps.pidAlive,
		randomId: ownerId ? undefined : deps.randomId,
		ownerId,
		allowPidRebind: true,
	});
	// Build args from the shared runtime resolver.
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

/**
 * Ensure a configured daemon owns this session root, preserving ownership safety
 * while exposing whether a #2028 generation handoff was required.
 */
export async function ensureTelegramDaemonRunningDetailed(
	input: { settings: Settings; cwd: string; sessionId: string },
	deps: TelegramDaemonDeps = {},
): Promise<EnsureTelegramDaemonDetailedResult> {
	const cfg = getNotificationConfig(input.settings);
	if (!isTelegramConfigured(cfg)) return "disabled";
	return await withTelegramSetupLease(cfg.botToken, async () => {
		const root = notificationRootForCwd(input.cwd);
		const fp = tokenFingerprint(cfg.botToken);
		const spawned = await spawnTelegramDaemonOwner(
			{ settings: input.settings, roots: [root], tokenFingerprint: fp, chatId: cfg.chatId },
			deps,
		);
		if (spawned.result === "blocked") {
			logger.warn(`notifications: failed to ensure Telegram daemon: ${spawned.warnings.join("; ")}`);
			return "blocked_identity";
		}
		if (spawned.reloadRequired) {
			await registerNotificationRoot({ ...input, fs: deps.fs });
			await reloadStaleGenerationOwner(input.settings, deps);
			return "reloaded";
		}
		await registerNotificationRoot({ ...input, fs: deps.fs });
		return spawned.result === "owner_spawned" ? "spawned" : "attached";
	});
}

/**
 * Legacy compatibility mapping for callers that only distinguish ownership from
 * attachment. New orchestration should use {@link ensureTelegramDaemonRunningDetailed}.
 */
export async function ensureTelegramDaemonRunning(
	input: { settings: Settings; cwd: string; sessionId: string },
	deps: TelegramDaemonDeps = {},
): Promise<EnsureDaemonResult> {
	const result = await ensureTelegramDaemonRunningDetailed(input, deps);
	switch (result) {
		case "spawned":
		case "reloaded":
			return "owner_spawned";
		case "attached":
			return "attached";
		case "disabled":
			return "disabled";
		case "blocked_identity":
			return "blocked";
	}
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

export type TelegramPollResult =
	| { kind: "success"; updateCount: number }
	| { kind: "aborted" }
	| { kind: "getUpdates_failed"; error: string }
	| { kind: "api_failure"; errorCode?: number; description: string }
	| { kind: "conflict"; description: string; backoffMs: number };

export interface TelegramUpdatePollerOptions {
	botApi: BotApi;
	runtime: NotificationOperatorRuntime;
	backoff: OperatorBackoffPolicy;
	processUpdate: (update: unknown) => Promise<TelegramUpdateOutcome>;
	health?: TelegramPollHealth;
}

type TelegramPollHealthStatus = "healthy" | "getUpdates_failed" | "api_failure" | "conflict";

export class TelegramPollHealth {
	#status: TelegramPollHealthStatus = "healthy";
	#suppressedCount = 0;

	record(result: TelegramPollResult): void {
		if (result.kind === "aborted") return;
		if (result.kind === "success") {
			if (this.#status !== "healthy") {
				logger.info("notifications daemon: Telegram getUpdates recovered", {
					from: this.#status,
					suppressedCount: this.#suppressedCount,
					updateCount: result.updateCount,
				});
			}
			this.#status = "healthy";
			this.#suppressedCount = 0;
			return;
		}

		const previousStatus = this.#status;
		if (previousStatus === result.kind) {
			this.#suppressedCount += 1;
			return;
		}

		const suppressedCount = this.#suppressedCount;
		this.#status = result.kind;
		this.#suppressedCount = 0;
		if (result.kind === "conflict") {
			logger.error("notifications daemon: Telegram getUpdates 409 conflict", {
				description: result.description,
				backoffMs: result.backoffMs,
				previousStatus,
				suppressedCount,
			});
			return;
		}
		if (result.kind === "api_failure") {
			logger.error("notifications daemon: Telegram getUpdates API failed", {
				errorCode: result.errorCode,
				description: result.description,
				previousStatus,
				suppressedCount,
			});
			return;
		}

		logger.error("notifications daemon: getUpdates failed", {
			error: result.error,
			previousStatus,
			suppressedCount,
		});
	}
}

/** Owns getUpdates offset, conflict backoff, and per-update error isolation. */
export class TelegramUpdatePoller {
	#offset = 0;
	#opts: TelegramUpdatePollerOptions;
	#health: TelegramPollHealth;

	constructor(opts: TelegramUpdatePollerOptions) {
		this.#opts = opts;
		this.#health = opts.health ?? new TelegramPollHealth();
	}

	async pollOnce(signal?: AbortSignal): Promise<number> {
		const result = await this.pollOnceResult(signal);
		this.#health.record(result);
		return result.kind === "success" ? result.updateCount : 0;
	}

	async pollOnceResult(signal?: AbortSignal): Promise<TelegramPollResult> {
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
			if (isAbortError(err)) return { kind: "aborted" };
			// A transient Telegram API failure must never crash the daemon.
			await this.#opts.runtime.sleep(POLL_BACKOFF_MS, signal);
			return { kind: "getUpdates_failed", error: sanitizeDiagnostic(String(err)) };
		}
		// Telegram allows only one active getUpdates poller per bot. A 409 means
		// another poller is live; back off boundedly instead of hot-looping.
		if (body && body.ok === false && (body.error_code === 409 || /409|conflict/i.test(body.description ?? ""))) {
			const backoffMs = this.#opts.backoff.next();
			await this.#opts.runtime.sleep(backoffMs, signal);
			return { kind: "conflict", description: sanitizeDiagnostic(body.description ?? "no description"), backoffMs };
		}
		if (body?.ok !== true || !Array.isArray(body.result)) {
			await this.#opts.runtime.sleep(POLL_BACKOFF_MS, signal);
			return {
				kind: "api_failure",
				errorCode: typeof body?.error_code === "number" ? body.error_code : undefined,
				description: sanitizeDiagnostic(body?.description ?? "Malformed getUpdates response"),
			};
		}
		this.#opts.backoff.reset();
		let malformedSeen = false;
		for (const update of body.result) {
			// A single malformed update_id must not wedge the poller. Skip the
			// bad entry (surfaced below as an api_failure health signal) while
			// still processing valid updates and advancing the offset past them,
			// so one poisoned item cannot stall an otherwise-valid stream.
			if (!Number.isSafeInteger(update?.update_id)) {
				malformedSeen = true;
				continue;
			}
			try {
				const outcome = await this.#opts.processUpdate(update);
				if (outcome === "retry") {
					await this.#opts.runtime.sleep(this.#opts.backoff.next(), signal);
					break;
				}
				this.#offset = update.update_id + 1;
			} catch (err) {
				logger.error("notifications daemon: handleTelegramUpdate failed", {
					error: sanitizeDiagnostic(String(err)),
				});
				this.#offset = update.update_id + 1;
			}
		}
		if (malformedSeen) {
			await this.#opts.runtime.sleep(POLL_BACKOFF_MS, signal);
			return { kind: "api_failure", description: "Malformed getUpdates response" };
		}
		return { kind: "success", updateCount: body.result.length };
	}
}

/** Mutable dispatch state shared by session frames and inbound Telegram updates. */
export class TelegramEventDispatchState {
	readonly busy = new Set<string>();
	readonly inboundReactions = new Map<number, { messageId: number }>();
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
	btw?: { enabled: boolean };
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
	/**
	 * Test seam for observing the exact production lifecycle dependency input.
	 * Production defaults to {@link buildOrchestratorDeps}.
	 */
	createLifecycleOrchestratorDeps?: (input: {
		pairedChatId: string;
		agentNotificationsDir: string;
		sessionsRoot: string;
		auditRedactionKey: Uint8Array;
	}) => OrchestratorDeps;
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
}

interface SessionSocket {
	/** Immutable key of the transport endpoint that owns this socket. */
	sessionId: string;
	/** Current logical session carried by valid threaded frames on this transport. */
	logicalSessionId: string;
	token: string;
	endpointKey: string;
	endpointDigest: string;
	hostGeneration: number;
	ws: WebSocket;
	pending: Map<string, { sessionId: string; actionId: string }>;
	/** True once the server advertised the `client_ping_pong` capability. */
	capable: boolean;
	ephemeralCapable: boolean;
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

interface ModelChoiceRoute {
	/** Exact transport socket that rendered this choice. */
	session: SessionSocket;
	/** Logical session current when this choice was rendered. */
	sessionId: string;
	selector: string;
	expiresAt: number;
}

interface RenderedModelChoice {
	selector: string;
	label: string;
}

interface TopicAuthorityLease {
	sessionId: string;
	topicId: string;
	authorityEpoch: number;
}

interface PendingThreadedFrame {
	send: ThreadedSend;
	msg: Record<string, unknown>;
}

type SelectedAckOutcome =
	| { status: "delivered"; messageId: number }
	| { status: "failed"; reason: "route_missing" | "expired" | "cancelled" | "telegram_rejected" }
	| { status: "unknown"; reason: "transport_ambiguous" | "shutdown" };
type BtwQueuedDeliveryOutcome = "accepted" | "not_delivered" | "uncertain" | "stale" | "partial_accepted";

interface BtwQueuedDelivery {
	pending: PendingBtwTurn;
	body: Record<string, unknown>;
	signal: AbortSignal;
	isAuthoritative: () => boolean;
	finish: (outcome: BtwQueuedDeliveryOutcome) => void;
}

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
	topicLease?: TopicAuthorityLease;
	selectedAck?: SelectedAckQueueItem;
	btwDelivery?: BtwQueuedDelivery;
}

interface PendingBtwTurn {
	/** Immutable transport/topic ownership key. */
	transportSessionId: string;
	/** Logical session id supplied to the session endpoint. */
	logicalSessionId: string;
	endpointDigest: string;
	generation: number;
	question: string;
	messageId: number;
	threadId: string;
	updateId: number;
	expiresAt: number;
}
interface PendingBtwDelivery {
	pending: PendingBtwTurn;
	/** The owning session changed while this terminal Bot API call was in flight. */
	invalidated: boolean;
	/** Whether a definitive authority loss should emit the session-unavailable reply. */
	terminalizeOnInvalidation: boolean;
	controller: AbortController;
	finished: Promise<void>;
	finish: () => void;
}

class TelegramEffectSupervisor {
	#stopping = false;
	readonly #abort = new AbortController();
	readonly #terminalContext = new AsyncLocalStorage<boolean>();
	readonly #pending = new Set<Promise<unknown>>();

	call(
		api: BotApi,
		method: string,
		body: unknown,
		opts?: { signal?: AbortSignal; noRetry?: boolean },
	): Promise<unknown> {
		const terminal = this.#terminalContext.getStore() === true;
		if (this.#stopping && !terminal)
			return Promise.reject(Object.assign(new Error("Daemon is stopping"), { name: "AbortError" }));
		const signal = terminal
			? opts?.signal
			: opts?.signal
				? AbortSignal.any([this.#abort.signal, opts.signal])
				: this.#abort.signal;
		return this.track(api.call(method, body, { ...opts, signal }));
	}

	track<T>(effect: Promise<T>): Promise<T> {
		this.#pending.add(effect);
		void effect.then(
			() => this.#pending.delete(effect),
			() => this.#pending.delete(effect),
		);
		return effect;
	}

	get stopping(): boolean {
		return this.#stopping;
	}

	beginShutdown(): void {
		this.#stopping = true;
		this.#abort.abort("daemon_shutdown");
	}

	allowTerminal<T>(effect: () => Promise<T>): Promise<T> {
		return this.#terminalContext.run(true, () => this.track(effect()));
	}

	async join(deadlineMs: number): Promise<boolean> {
		const expiresAt = Date.now() + deadlineMs;
		while (this.#pending.size > 0) {
			const remaining = expiresAt - Date.now();
			if (remaining <= 0) return false;
			await Promise.race([
				Promise.allSettled([...this.#pending]),
				new Promise<void>(resolve => setTimeout(resolve, remaining)),
			]);
		}
		return true;
	}
}

export class TelegramNotificationDaemon {
	readonly aliasTable: AliasTable;
	readonly messageRoutes = new Map<string | number, CallbackRoute | Omit<CallbackRoute, "answer">>();
	/** Telegram message id backing each streamed `${sessionId}:${coalesceKey}`, for in-place edits. */
	private readonly liveMessages = new Map<string, number>();
	readonly sessions = new Map<string, SessionSocket>();
	/** Ephemeral aliases for model choices; deliberately never serialized across daemon restarts. */
	#modelChoiceAliases = new Map<string, ModelChoiceRoute>();

	private readonly runtime: NotificationOperatorRuntime;
	private readonly sessionRouter: OperatorEventRouter<SessionSocket>;
	private readonly pollConflictBackoff = new OperatorBackoffPolicy({ initialMs: 500, maxMs: 5_000 });
	private readonly loopBackoff = new OperatorBackoffPolicy({ initialMs: 250, maxMs: 4_000 });
	private running = false;
	private readonly fsImpl: TelegramDaemonFs;
	private readonly botApi: BotApi;
	private readonly effects = new TelegramEffectSupervisor();
	private readonly topics = new TopicRegistry();
	/** Serializes registry snapshots so an older atomic write cannot overwrite newer rename state. */
	private topicsPersistQueue: Promise<void> = Promise.resolve();
	/** Daemon edit attempts that can race an accepted user service message. */
	private readonly daemonRenameAttempts = new Map<string, number>();
	private readonly selectedAckPending = new Map<string, SelectedAckQueueItem>();
	#pendingBtwTurns = new Map<string, PendingBtwTurn>();
	#btwTerminalDeliveries = new Map<string, PendingBtwDelivery>();
	#btwTerminalTombstones = new Map<
		string,
		{ sessionId: string; updateId: number; messageId: number; threadId: string; expiresAt: number }
	>();
	#stoppingBtw = false;
	readonly #btwDeliveryAbort = new AbortController();
	readonly #deliveryAbort = new AbortController();
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
	private get inboundReactions(): Map<number, { messageId: number }> {
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
		this.effects.beginShutdown();
		for (const item of new Set(this.selectedAckPending.values())) {
			if (item.state === "queued") this.pool.removeById(item.itemId);
			else item.controller?.abort();
			this.finishSelectedAck(item, { status: "unknown", reason: "shutdown" });
		}
		this.#stoppingBtw = true;
		for (const delivery of this.#btwTerminalDeliveries.values()) {
			delivery.invalidated = true;
			delivery.controller.abort("daemon_shutdown");
		}
		this.#deliveryAbort.abort();
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
			const deps = (this.opts.createLifecycleOrchestratorDeps ?? buildOrchestratorDeps)({
				pairedChatId: this.opts.chatId,
				agentNotificationsDir: daemonPaths(agentDir).dir,
				agentDir,
				sessionsRoot: path.join(agentDir, "sessions"),
				auditRedactionKey: deriveLifecycleAuditRedactionKey(
					(() => {
						if (!validBotToken(this.opts.botToken)) throw new Error("invalid Telegram bot token");
						return this.opts.botToken;
					})(),
				),
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
			const recent = await listRecentSessions({
				cwd: process.cwd(),
				agentDir: this.opts.settings.getAgentDir(),
				limit: 10,
				includeInternal: false,
				allWorkspaces: true,
			});
			const body =
				recent.kind === "error"
					? `Recent sessions could not be verified: ${recent.message}`
					: recent.entries.length
						? recent.entries.map(e => `• ${code(e.sessionId)}${e.path ? ` (${code(e.path)})` : ""}`).join("\n")
						: "No recent sessions.";
			await replyHtml(
				recent.kind === "complete" && recent.warnings.length ? `${body}\n\n${recent.warnings.join("\n")}` : body,
			);
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
		this.replyStore = new ReplySentStore({ agentDir: opts.settings.getAgentDir(), fs: opts.fs });
		this.aliasTable = createAliasTable();
		const rawBotApi =
			opts.botApi ??
			new TelegramBotTransport({
				botToken: opts.botToken,
				apiBase: opts.apiBase,
				fetchImpl: opts.fetchImpl,
				setTimeoutImpl: opts.setTimeoutImpl,
			});
		this.botApi = {
			call: (method, body, callOpts) => this.effects.call(rawBotApi, method, body, callOpts),
		};
		this.runtime = new NotificationOperatorRuntime({
			now: opts.now,
			setTimeoutImpl: opts.setTimeoutImpl,
			clearTimeoutImpl: opts.clearTimeoutImpl,
			setIntervalImpl: opts.setIntervalImpl,
			clearIntervalImpl: opts.clearIntervalImpl,
		});
		this.sessionRouter = this.createSessionRouter();
		this.pool = new RateLimitPool<TelegramQueuePayload>({ now: opts.now });
		this.poller = new TelegramUpdatePoller({
			botApi: this.botApi,
			runtime: this.runtime,
			backoff: this.pollConflictBackoff,
			processUpdate: update => this.processTelegramUpdate(update),
		});
	}

	private createSessionRouter(): OperatorEventRouter<SessionSocket> {
		return new OperatorEventRouter<SessionSocket>()
			.add({
				name: "hello",
				matches: msg => msg.type === "hello",
				handle: (session, msg) => {
					const caps = Array.isArray(msg.capabilities) ? msg.capabilities : [];
					if (caps.includes("ephemeral_turn_v1")) session.ephemeralCapable = true;
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
					const topicLease = this.topicAuthorityLeaseFromRegistry(session.sessionId);
					if (
						this.topics.get(session.sessionId)?.authorityState === "delete_pending" ||
						(mode === "recovery" && (!topicLease || msg.sessionId !== session.sessionId))
					) {
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
					this.submitPool({
						sessionId: session.sessionId,
						lane: "ask",
						itemId: item.itemId,
						deadlineAt,
						payload: {
							send: { method: "sendMessage", lane: "ask", text: "Selected!" },
							topicLease,
							selectedAck: item,
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
						await this.setReaction(target.messageId, CONSUMED_REACTION);
					}
				},
			})
			.add({
				name: "session_closed",
				matches: msg => msg.type === "session_closed",
				handle: async session => {
					this.busy.delete(session.sessionId);
					this.closedEndpointKeys.set(session.sessionId, session.endpointKey);
					await this.#terminalizeBtwTurnsForSession(session, true);
					await this.deleteTopic(session.sessionId);
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
	private async reserveSeenUpdateId(updateId: number): Promise<boolean> {
		if (!Number.isSafeInteger(updateId) || updateId < 0) return false;
		const candidate = new Set(this.dispatchState.seenUpdateIds);
		candidate.add(updateId);
		while (candidate.size > SEEN_UPDATE_ID_LIMIT) candidate.delete(candidate.values().next().value!);
		try {
			const paths = daemonPaths(this.opts.settings.getAgentDir());
			await ensureDir(this.fsImpl, paths.dir);
			await writeJsonAtomic(this.fsImpl, paths.seenUpdates, {
				version: 1,
				updateIds: [...candidate],
			});
		} catch {
			logger.warn("notifications: Telegram update state publication failed");
			return false;
		}
		this.dispatchState.seenUpdateIds.clear();
		for (const seenId of candidate) this.dispatchState.seenUpdateIds.add(seenId);
		return true;
	}

	async scanRoots(): Promise<void> {
		const paths = daemonPaths(this.opts.settings.getAgentDir());
		const rootState = await readJson<{ roots?: string[] }>(this.fsImpl, paths.roots);
		const endpointSessionIds = new Set<string>();
		let allRootsReadable = true;
		for (const root of rootState?.roots ?? []) {
			const dir = path.join(root, "sdk");
			let files: string[];
			try {
				files = await this.fsImpl.readdir(dir);
			} catch {
				allRootsReadable = false;
				continue;
			}
			for (const file of files.filter(item => item.endsWith(".json"))) {
				const sessionId = path.basename(file, ".json");
				endpointSessionIds.add(sessionId);
				try {
					const endpoint = readEndpoint(path.join(dir, file));
					// Validate endpoint ownership even for an already-connected socket.
					// A hard-killed owner can leave both its endpoint file and socket map
					// entry behind; skipping the read in that case permanently preserves
					// the stale Telegram topic.
					const pidAlive = this.opts.pidAlive ?? defaultPidAlive;
					if (endpoint.stale || (endpoint.pid !== undefined && !pidAlive(endpoint.pid))) {
						const connected = this.sessions.get(sessionId);
						if (connected) this.dropSession(connected, "endpoint_owner_dead");
						else this.#terminalizeBtwTurnsForTransportSession(sessionId);
						await this.observeOrphanedTopic(sessionId);
						continue;
					}
					if (this.topics.clearOrphaned(sessionId)) await this.persistTopics();
					const endpointKey = endpointGenerationKey(endpoint.url, endpoint.token);
					const connected = this.sessions.get(sessionId);
					if (connected) {
						if (connected.endpointKey !== endpointKey)
							this.connectSession(sessionId, endpoint.url, endpoint.token);
						continue;
					}
					if (this.closedEndpointKeys.get(sessionId) === endpointKey) continue;
					this.closedEndpointKeys.delete(sessionId);
					this.connectSession(sessionId, endpoint.url, endpoint.token);
				} catch {}
			}
		}
		if (allRootsReadable) {
			for (const sessionId of this.topics.sessionIds()) {
				if (!this.sessions.has(sessionId) && !endpointSessionIds.has(sessionId)) {
					this.#terminalizeBtwTurnsForTransportSession(sessionId);
					await this.observeOrphanedTopic(sessionId);
				}
			}
		}
	}

	connectSession(sessionId: string, url: string, token: string): void {
		const WS = this.opts.WebSocketImpl ?? WebSocket;
		const ws = new WS(`${url}/?token=${encodeURIComponent(token)}`);
		const endpointKey = endpointGenerationKey(url, token);
		const endpointDigest = endpointAuthorityDigest(url, token);
		this.closedEndpointKeys.delete(sessionId);
		const existing = this.sessions.get(sessionId);
		if (existing) {
			this.dropSession(
				existing,
				existing.endpointDigest === endpointDigest ? "same_authority_replaced" : "authority_replaced",
			);
		} else {
			this.#terminalizeBtwTurnsForEndpointReplacement(sessionId, endpointDigest);
		}
		this.#clearModelChoiceAliases(sessionId);

		const session: SessionSocket = {
			sessionId,
			logicalSessionId: sessionId,

			token,
			endpointKey,
			endpointDigest,
			hostGeneration: 0,
			ws,
			pending: new Map(),
			capable: false,
			ephemeralCapable: false,
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
								TOOL_ACTIVITY_CAPABILITY,
								"ephemeral_turn_v1",
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
			// Eagerly create the session's Telegram topic as soon as it connects, so
			// a thread exists the moment a notifications-enabled session is live —
			// not lazily on the first delivered frame (which only arrives once the
			// user sends a prompt). A provisional "GJC <id>" name is used; the
			// identity_header frame renames it to "{repo}/{branch} - {title}" later.
			void this.ensureTopic(sessionId, this.topicNameFor(sessionId, {})).catch(() => undefined);
		});
		ws.addEventListener("message", ev => {
			// Identity guard: a delayed frame from a superseded socket must not act
			// through the replacement session.
			if (this.sessions.get(sessionId) !== session) return;
			void this.handleSessionMessage(session, JSON.parse(String(ev.data))).catch(err => {
				// Surface frame-handling failures (e.g. a rejected ask sendMessage) to
				// the daemon log instead of an invisible unhandled rejection.
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
		if (reason === "socket_closed" || reason === "same_authority_replaced") {
			this.#invalidateBtwDeliveriesForSession(session);
		} else {
			void this.#terminalizeBtwTurnsForSession(session).catch(() => undefined);
		}
		const isCurrentSession = this.sessions.get(session.sessionId) === session;
		if (isCurrentSession || reason === "session_closed") {
			this.deleteMessageRoutes(session.sessionId);
		}
		if (isCurrentSession) {
			this.#clearModelChoiceAliasesForSocket(session);
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

	#purgeBtwTombstones(): void {
		const now = this.opts.now?.() ?? Date.now();
		for (const [requestId, tombstone] of this.#btwTerminalTombstones)
			if (tombstone.expiresAt <= now) this.#btwTerminalTombstones.delete(requestId);
	}
	#finishQueuedBtwDeliveries(pending: PendingBtwTurn, outcome: BtwQueuedDeliveryOutcome): void {
		for (const item of this.pool.removeWhere(item => item.payload.btwDelivery?.pending === pending)) {
			item.payload.btwDelivery?.finish(outcome);
		}
	}
	#takeBtwTurn(requestId: string, pending: PendingBtwTurn): boolean {
		if (this.#pendingBtwTurns.get(requestId) !== pending) return false;
		this.#pendingBtwTurns.delete(requestId);
		this.#btwTerminalTombstones.set(requestId, {
			sessionId: pending.logicalSessionId,
			updateId: pending.updateId,
			messageId: pending.messageId,
			threadId: pending.threadId,
			expiresAt: (this.opts.now?.() ?? Date.now()) + BTW_PENDING_TTL_MS,
		});
		while (this.#pendingBtwTurns.size + this.#btwTerminalTombstones.size > BTW_MAX_PENDING)
			this.#btwTerminalTombstones.delete(this.#btwTerminalTombstones.keys().next().value!);
		return true;
	}
	#invalidateBtwDeliveriesForSession(session: SessionSocket): void {
		for (const delivery of this.#btwTerminalDeliveries.values()) {
			const pending = delivery.pending;
			if (
				pending.transportSessionId !== session.sessionId ||
				pending.logicalSessionId !== this.#logicalSessionId(session) ||
				pending.endpointDigest !== session.endpointDigest ||
				pending.generation !== session.hostGeneration
			)
				continue;
			delivery.invalidated = true;
			this.#finishQueuedBtwDeliveries(pending, "stale");
		}
	}
	#terminalizeBtwTurnsForEndpointReplacement(sessionId: string, endpointDigest: string): void {
		for (const [requestId, pending] of this.#pendingBtwTurns) {
			if (pending.transportSessionId !== sessionId || pending.endpointDigest === endpointDigest) continue;
			void this.#terminalizeBtwTurn(requestId, pending).catch(() => undefined);
		}
	}
	#terminalizeBtwTurnsForTransportSession(sessionId: string): void {
		for (const [requestId, pending] of this.#pendingBtwTurns) {
			if (pending.transportSessionId !== sessionId) continue;
			void this.#terminalizeBtwTurn(requestId, pending).catch(() => undefined);
		}
	}
	#terminalizeBtwTurnsForGenerationChange(session: SessionSocket): void {
		for (const [requestId, pending] of this.#pendingBtwTurns) {
			if (
				pending.transportSessionId !== session.sessionId ||
				pending.endpointDigest !== session.endpointDigest ||
				pending.logicalSessionId !== this.#logicalSessionId(session) ||
				pending.generation === session.hostGeneration
			)
				continue;
			void this.#terminalizeBtwTurn(requestId, pending).catch(() => undefined);
		}
	}
	#resumeBtwTurnsForSession(session: SessionSocket): void {
		if (!session.ephemeralCapable || session.hostGeneration < 1 || session.ws.readyState !== WebSocket.OPEN) return;
		const logicalSessionId = this.#logicalSessionId(session);
		const now = this.opts.now?.() ?? Date.now();
		for (const [requestId, pending] of this.#pendingBtwTurns) {
			if (pending.expiresAt <= now) {
				this.#pendingBtwTurns.delete(requestId);
				continue;
			}
			if (
				pending.transportSessionId !== session.sessionId ||
				pending.logicalSessionId !== logicalSessionId ||
				pending.endpointDigest !== session.endpointDigest ||
				pending.generation !== session.hostGeneration
			)
				continue;
			this.#sendPendingBtwTurn(session, requestId, pending);
		}
	}
	#sendPendingBtwTurn(session: SessionSocket, requestId: string, pending: PendingBtwTurn): boolean {
		try {
			session.ws.send(
				JSON.stringify({
					type: "ephemeral_turn",
					sessionId: pending.logicalSessionId,
					question: pending.question,
					token: session.token,
					requestId,
					updateId: pending.updateId,
					threadId: pending.threadId,
					messageId: pending.messageId,
				}),
			);
			return true;
		} catch {
			return false;
		}
	}
	async #terminalizeBtwTurnsForSession(session: SessionSocket, waitForInFlight = false): Promise<void> {
		const terminalizations: Promise<void>[] = [];
		for (const [requestId, pending] of this.#pendingBtwTurns) {
			if (
				pending.transportSessionId !== session.sessionId ||
				pending.logicalSessionId !== this.#logicalSessionId(session) ||
				pending.endpointDigest !== session.endpointDigest ||
				pending.generation !== session.hostGeneration
			)
				continue;
			const terminalization = this.#terminalizeBtwTurn(requestId, pending, false, waitForInFlight);
			if (waitForInFlight) terminalizations.push(terminalization);
			else void terminalization.catch(() => undefined);
		}
		if (waitForInFlight) await Promise.all(terminalizations);
	}
	async #terminalizeBtwTurn(
		requestId: string,
		pending: PendingBtwTurn,
		allowWhileStopping = false,
		waitForInFlight = false,
		signal?: AbortSignal,
	): Promise<void> {
		const delivery = this.#btwTerminalDeliveries.get(requestId);
		if (delivery?.pending === pending) {
			delivery.invalidated = true;
			delivery.terminalizeOnInvalidation = true;
			this.#finishQueuedBtwDeliveries(pending, "stale");
			if (allowWhileStopping || waitForInFlight) await delivery.finished;
			return;
		}
		if (this.#stoppingBtw && !allowWhileStopping) return;
		if (!this.#takeBtwTurn(requestId, pending)) return;
		try {
			await this.#sendBtwMessage({
				threadId: pending.threadId,
				messageId: pending.messageId,
				text: "This /btw question stopped because the GJC session closed or changed. Reopen it and try again.",
				allowWhileStopping,
				signal,
			});
		} catch {
			logger.warn("notifications: /btw session-unavailable delivery failed");
		}
	}
	async #sendBtwMessage(input: {
		threadId: string;
		messageId: number;
		text: string;
		parseMode?: typeof TELEGRAM_PARSE_MODE;
		allowWhileStopping?: boolean;
		signal?: AbortSignal;
	}): Promise<unknown> {
		if ((!input.allowWhileStopping && this.#stoppingBtw) || this.#btwDeliveryAbort.signal.aborted) return undefined;
		const signals = [this.#btwDeliveryAbort.signal, AbortSignal.timeout(30_000)];
		if (input.signal) signals.unshift(input.signal);
		return this.botApi.call(
			"sendMessage",
			{
				chat_id: this.opts.chatId,
				message_thread_id: Number(input.threadId),
				reply_parameters: { message_id: input.messageId },
				text: input.text,
				...(input.parseMode ? { parse_mode: input.parseMode } : {}),
			},
			{
				noRetry: true,
				signal: AbortSignal.any(signals),
			},
		);
	}
	async #queueBtwFallbackChunk(input: {
		requestId: string;
		chunkIndex: number;
		pending: PendingBtwTurn;
		body: Record<string, unknown>;
		signal: AbortSignal;
		isAuthoritative: () => boolean;
	}): Promise<BtwQueuedDeliveryOutcome> {
		if (input.signal.aborted) return "uncertain";
		const result = Promise.withResolvers<BtwQueuedDeliveryOutcome>();
		let settled = false;
		const finish = (outcome: BtwQueuedDeliveryOutcome): void => {
			if (settled) return;
			settled = true;
			result.resolve(outcome);
		};
		const itemId = `btw-delivery:${input.requestId}:${input.chunkIndex}`;
		const delivery: BtwQueuedDelivery = {
			pending: input.pending,
			body: input.body,
			signal: input.signal,
			isAuthoritative: input.isAuthoritative,
			finish,
		};
		const abort = (): void => {
			const removed = this.pool.removeById(itemId);
			if (removed?.payload.btwDelivery === delivery) finish("uncertain");
		};
		input.signal.addEventListener("abort", abort, { once: true });
		try {
			const handle = this.pool.submit({
				sessionId: input.pending.transportSessionId,
				lane: "finalized",
				itemId,
				payload: {
					send: { method: "sendMessage", lane: "finalized", text: String(input.body.text ?? "") },
					btwDelivery: delivery,
				},
			});
			if (input.signal.aborted) abort();
			else await this.flushPool();
			await handle.settled;
			return await result.promise;
		} catch {
			const removed = this.pool.removeById(itemId);
			if (removed?.payload.btwDelivery === delivery) finish("uncertain");
			return "uncertain";
		} finally {
			input.signal.removeEventListener("abort", abort);
		}
	}

	async #drainBtwTurns(): Promise<void> {
		this.#stoppingBtw = true;
		const shutdownController = new AbortController();
		const shutdownDeadline = Promise.withResolvers<void>();
		const shutdownTimer = setTimeout(() => {
			shutdownController.abort("daemon_shutdown_timeout");
			shutdownDeadline.resolve();
		}, BTW_SHUTDOWN_JOIN_MS);
		for (const delivery of this.#btwTerminalDeliveries.values()) {
			delivery.invalidated = true;
			delivery.controller.abort("daemon_shutdown");
		}
		const deliveryJoins = [...this.#btwTerminalDeliveries.values()].map(delivery => delivery.finished);

		const terminalizations: Promise<void>[] = [];
		for (const [requestId, pending] of this.#pendingBtwTurns) {
			if (shutdownController.signal.aborted) break;
			if (this.#btwTerminalDeliveries.has(requestId)) continue;
			const session = this.sessions.get(pending.transportSessionId);
			if (
				session &&
				session.ws.readyState === WebSocket.OPEN &&
				session.endpointDigest === pending.endpointDigest &&
				session.hostGeneration === pending.generation &&
				this.#logicalSessionId(session) === pending.logicalSessionId
			) {
				try {
					session.ws.send(
						JSON.stringify({
							type: "ephemeral_turn_cancel",
							sessionId: pending.logicalSessionId,
							token: session.token,
							requestId,
							updateId: pending.updateId,
							messageId: pending.messageId,
							threadId: pending.threadId,
							reason: "daemon_shutdown",
						}),
					);
				} catch {}
			}
			terminalizations.push(this.#terminalizeBtwTurn(requestId, pending, true, false, shutdownController.signal));
		}
		await Promise.race([Promise.allSettled([...deliveryJoins, ...terminalizations]), shutdownDeadline.promise]);
		clearTimeout(shutdownTimer);
		shutdownController.abort("daemon_shutdown");
		this.#btwDeliveryAbort.abort();
		this.#btwTerminalTombstones.clear();
		for (const item of this.pool.removeWhere(() => true)) item.payload.btwDelivery?.finish("uncertain");
	}

	private deleteMessageRoutes(sessionId: string, actionId?: string): void {
		for (const [messageId, route] of this.messageRoutes.entries()) {
			if (route.sessionId === sessionId && (actionId === undefined || route.actionId === actionId)) {
				this.messageRoutes.delete(messageId);
			}
		}
	}

	#logicalSessionId(session: SessionSocket): string {
		return session.logicalSessionId ?? session.sessionId;
	}

	#clearModelChoiceAliases(sessionId: string): void {
		for (const [alias, route] of this.#modelChoiceAliases) {
			if (route.sessionId === sessionId) this.#modelChoiceAliases.delete(alias);
		}
	}

	#clearModelChoiceAliasesForSocket(session: SessionSocket): void {
		for (const [alias, route] of this.#modelChoiceAliases) {
			if (route.session === session) this.#modelChoiceAliases.delete(alias);
		}
	}

	#sweepExpiredModelChoiceAliases(): void {
		const now = this.runtime.now();
		for (const [alias, route] of this.#modelChoiceAliases) {
			if (route.expiresAt <= now) this.#modelChoiceAliases.delete(alias);
		}
	}

	#putModelChoiceAlias(route: Omit<ModelChoiceRoute, "expiresAt">): string {
		this.#sweepExpiredModelChoiceAliases();
		let alias: string;
		do {
			alias = `${MODEL_CALLBACK_PREFIX}${crypto.randomBytes(16).toString("base64url")}`;
		} while (this.#modelChoiceAliases.has(alias));
		this.#modelChoiceAliases.set(alias, { ...route, expiresAt: this.runtime.now() + MODEL_CHOICE_TTL_MS });
		return alias;
	}

	/**
	 * Coalesce-key categories whose entries are concurrent and independently keyed
	 * (one live message per key), so {@link recordLiveMessage} must NOT evict
	 * same-category siblings. `tool:<toolCallId>` bubbles from parallel tools each
	 * own their own message and finalize independently.
	 */
	static readonly #CONCURRENT_LIVE_CATEGORIES = new Set(["tool"]);

	private static readonly THREADED_FRAMES = new Set([
		"identity_header",
		"context_update",
		"turn_stream",
		"image_attachment",
		"file_attachment",
		"config_update",
		"control_command_result",
		"tool_activity",
		"reasoning_summary",
	]);

	/** Rekey model controls before a valid server-threaded frame can render or route output. */
	#updateLogicalSessionForThreadedFrame(session: SessionSocket, msg: Record<string, unknown>): void {
		if (
			typeof msg.type !== "string" ||
			!TelegramNotificationDaemon.THREADED_FRAMES.has(msg.type) ||
			typeof msg.sessionId !== "string" ||
			!msg.sessionId.trim() ||
			msg.sessionId === this.#logicalSessionId(session) ||
			(msg.type !== "config_update" && !renderThreadedFrame(msg))
		)
			return;
		void this.#terminalizeBtwTurnsForSession(session).catch(() => undefined);
		this.#clearModelChoiceAliasesForSocket(session);
		this.#clearModelChoiceAliases(msg.sessionId);
		session.logicalSessionId = msg.sessionId;
	}

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
		const rememberedTopic = remembered ? this.topics.get(remembered) : undefined;
		if (remembered && rememberedTopic && rememberedTopic.authorityState !== "delete_pending") return remembered;
		if (!identityKey) return undefined;
		const base = this.topicIdentityBase(msg);
		for (const sessionId of this.topics.sessionIds()) {
			const topic = this.topics.get(sessionId);
			if (topic?.authorityState === "delete_pending") continue;
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

	private async submitThreadedFrame(
		sessionId: string,
		send: ThreadedSend,
		topicLease: TopicAuthorityLease,
	): Promise<void> {
		this.submitPool({
			sessionId,
			lane: send.lane,
			coalesceKey: send.coalesceKey,
			payload: { send, topicLease },
		});
		await this.flushPool();
	}

	private async existingTopicForPrivateChat(sessionId: string): Promise<string | undefined> {
		return (await this.topicAuthorityLease(sessionId))?.topicId;
	}

	private async topicAuthorityLease(sessionId: string): Promise<TopicAuthorityLease | undefined> {
		if (!(await this.pairedChatIsPrivate())) return undefined;
		return this.topicAuthorityLeaseFromRegistry(sessionId);
	}

	private topicAuthorityLeaseFromRegistry(sessionId: string): TopicAuthorityLease | undefined {
		const topic = this.topics.get(sessionId);
		if (!topic || topic.authorityState === "delete_pending") return undefined;
		return { sessionId, topicId: topic.topicId, authorityEpoch: topic.authorityEpoch ?? 0 };
	}

	private topicLeaseIsCurrent(lease: TopicAuthorityLease): boolean {
		const topic = this.topics.get(lease.sessionId);
		return (
			topic?.authorityState !== "delete_pending" &&
			topic?.topicId === lease.topicId &&
			(topic.authorityEpoch ?? 0) === lease.authorityEpoch
		);
	}

	/** Best-effort re-assertion for a durable user-owned topic name. */
	private async reconcileUserTopicName(topicLease: TopicAuthorityLease): Promise<void> {
		const { sessionId } = topicLease;
		if ((this.daemonRenameAttempts.get(sessionId) ?? 0) > 0) return;
		let userName = this.topics.userNameToReconcile(sessionId);
		while (userName) {
			try {
				if (!this.topicLeaseIsCurrent(topicLease)) return;
				const response = await this.botApi.call("editForumTopic", {
					chat_id: this.opts.chatId,
					message_thread_id: Number(topicLease.topicId),
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

	private async flushPendingThreadedFrames(sessionId: string, topicLease: TopicAuthorityLease): Promise<void> {
		const frames = this.pendingThreadedFrames.get(sessionId);
		if (!frames || frames.length === 0) return;
		this.pendingThreadedFrames.delete(sessionId);
		for (const frame of frames) await this.submitThreadedFrame(sessionId, frame.send, topicLease);
	}

	/**
	 * Resolve (creating once via `createForumTopic`) the forum topic for a
	 * session. On capability failure (e.g. Threaded Mode off) this returns
	 * `undefined`; callers then flat-deliver to a private paired chat (with a
	 * one-time nudge) or drop fail-closed for a non-private chat.
	 */
	private async ensureTopic(sessionId: string, name: string): Promise<string | undefined> {
		if (!(await this.pairedChatIsPrivate())) return undefined;
		const existing = this.topics.get(sessionId);
		if (existing?.authorityState === "delete_pending") return undefined;
		if (existing) return existing.topicId;
		try {
			const rec = await this.topics.getOrCreateTopic(
				sessionId,
				async () => {
					const res = await this.botApi.call("createForumTopic", {
						chat_id: this.opts.chatId,
						name,
					});
					if (isThreadedModeCapabilityRefusal(res)) throw new ThreadedModeCapabilityRefusal();
					const tid = (res as { result?: { message_thread_id?: unknown } }).result?.message_thread_id;
					if (typeof tid !== "number" || !Number.isSafeInteger(tid) || tid <= 0)
						throw new Error("createForumTopic: invalid message_thread_id");
					return String(tid);
				},
				this.opts.now,
				// The create winner records the name it actually used; callers that
				// merely JOIN an in-flight create must not overwrite it locally, or a
				// later identity rename would be wrongly skipped (topic stuck at the
				// provisional name on Telegram).
				name,
			);
			await this.persistTopics();
			return rec.topicId;
		} catch (err) {
			if (err instanceof ThreadedModeCapabilityRefusal) return undefined;
			logger.warn(
				`notifications: Telegram topic creation failed: ${sanitizeDiagnostic(String(err), this.opts.botToken)}`,
			);
			throw err;
		}
	}

	private topicPastOrphanGrace(sessionId: string): boolean {
		const orphanedAt = this.topics.get(sessionId)?.orphanedAt;
		return orphanedAt !== undefined && this.runtime.now() - orphanedAt >= ORPHAN_TOPIC_GRACE_MS;
	}

	private async observeOrphanedTopic(sessionId: string): Promise<void> {
		if (this.topics.markOrphaned(sessionId, this.runtime.now())) await this.persistTopics();
		if (!this.topicPastOrphanGrace(sessionId)) return;
		await this.deleteTopic(sessionId);
	}

	/** Best-effort delete of a session topic once its local notification endpoint shuts down. */
	private async deleteTopic(sessionId: string): Promise<void> {
		let record = this.topics.beginDelete(sessionId);
		// Persist even an absent-record fence: it revokes a create that was admitted
		// before close but has not yet committed its topic record.
		await this.persistTopics();
		if (!record) {
			await this.topics.awaitInflight(sessionId);
			record = this.topics.get(sessionId);
			// A remotely accepted revoked create installs a delete_pending record while
			// its caller rejects; durably retain it before compensating remotely.
			await this.persistTopics();
			if (!record) return;
		}
		const removed = this.pool.removeWhere(item => item.sessionId === sessionId);
		for (const item of removed) {
			if (item.payload.selectedAck)
				this.finishSelectedAck(item.payload.selectedAck, { status: "failed", reason: "cancelled" });
			item.payload.btwDelivery?.finish("stale");
		}
		try {
			await this.flushPool();
			const res = (await this.botApi.call("deleteForumTopic", {
				chat_id: this.opts.chatId,
				message_thread_id: Number(record.topicId),
			})) as { ok?: boolean };
			if (!topicDeleteSettled(res)) return;
			this.topics.settleDelete(sessionId, record.topicId);
			for (const k of [...this.liveMessages.keys()]) if (k.startsWith(`${sessionId}:`)) this.liveMessages.delete(k);
			this.topicOwnerByIdentity.forEach((ownerSessionId, identityKey) => {
				if (ownerSessionId === sessionId) this.topicOwnerByIdentity.delete(identityKey);
			});
			this.pendingThreadedFrames.delete(sessionId);
			await this.persistTopics();
		} catch {
			// Retain the persisted delete fence on transport ambiguity.
		}
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
			logger.warn(`notifications: file download failed: ${sanitizeDiagnostic(String(e))}`);
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
	private submitPool(item: Parameters<RateLimitPool<TelegramQueuePayload>["submit"]>[0]): boolean {
		if (this.effects.stopping) return false;
		this.pool.submit(item);
		return true;
	}

	private async flushPoolInner(): Promise<void> {
		const { granted: batch, expired } = this.pool.drainWithExpired();
		for (const expiredItem of expired) {
			if (expiredItem.payload.selectedAck) {
				this.finishSelectedAck(expiredItem.payload.selectedAck, { status: "failed", reason: "expired" });
			}
			expiredItem.payload.btwDelivery?.finish("not_delivered");
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
			const btwDelivery = item.payload.btwDelivery;
			if (btwDelivery) {
				if (!btwDelivery.isAuthoritative()) {
					btwDelivery.finish("stale");
					this.pool.settle(item.itemId!, "removed");
					continue;
				}
				if (btwDelivery.signal.aborted) {
					btwDelivery.finish("uncertain");
					this.pool.settle(item.itemId!, "ambiguous");
					continue;
				}
				try {
					const response = await this.botApi.call("sendMessage", btwDelivery.body, {
						noRetry: true,
						signal: btwDelivery.signal,
					});
					const accepted = response && typeof response === "object" && (response as { ok?: unknown }).ok === true;
					const rejected = response && typeof response === "object" && (response as { ok?: unknown }).ok === false;
					btwDelivery.finish(accepted ? "accepted" : rejected ? "not_delivered" : "uncertain");
					this.pool.settle(item.itemId!, accepted ? "accepted" : rejected ? "rejected" : "ambiguous");
				} catch {
					btwDelivery.finish("uncertain");
					this.pool.settle(item.itemId!, "ambiguous");
				}
				continue;
			}
			const selectedAck = item.payload.selectedAck;
			if (selectedAck) {
				const { topicLease } = item.payload;
				selectedAck.state = "dispatching";
				const controller = new AbortController();
				selectedAck.controller = controller;
				const routeAvailable =
					(await this.pairedChatIsPrivate()) && (!topicLease || this.topicLeaseIsCurrent(topicLease));
				if (this.selectedAckPending.get(selectedAck.pendingKey) !== selectedAck) {
					this.pool.settle(item.itemId!, "removed");
					continue;
				}
				if (!routeAvailable) {
					this.finishSelectedAck(selectedAck, { status: "failed", reason: "route_missing" });
					this.pool.settle(item.itemId!, "rejected");
					continue;
				}
				if (item.deadlineAt !== undefined && item.deadlineAt <= this.runtime.now()) {
					this.finishSelectedAck(selectedAck, { status: "failed", reason: "expired" });
					this.pool.settle(item.itemId!, "expired");
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
							...(topicLease ? { message_thread_id: Number(topicLease.topicId) } : {}),
							text: "Selected!",
						},
						{ signal: controller.signal, noRetry: true },
					)) as { ok?: unknown; result?: { message_id?: unknown } };
					const messageId = response.result?.message_id;
					const delivered = response.ok === true && typeof messageId === "number";
					this.finishSelectedAck(
						selectedAck,
						delivered ? { status: "delivered", messageId } : { status: "failed", reason: "telegram_rejected" },
					);
					this.pool.settle(item.itemId!, delivered ? "accepted" : "rejected");
				} catch {
					this.finishSelectedAck(selectedAck, { status: "unknown", reason: "transport_ambiguous" });
					this.pool.settle(item.itemId!, "ambiguous");
				} finally {
					(this.opts.clearTimeoutImpl ?? clearTimeout)(timer);
				}
				continue;
			}
			const { send, topicLease } = item.payload;
			if (topicLease && !this.topicLeaseIsCurrent(topicLease)) {
				this.pool.settle(item.itemId!, "rejected");
				continue;
			}
			const topicId = topicLease?.topicId;
			if (topicId && !(await this.pairedChatIsPrivate())) {
				this.pool.settle(item.itemId!, "rejected");
				continue;
			}
			if (topicLease && !this.topicLeaseIsCurrent(topicLease)) {
				this.pool.settle(item.itemId!, "rejected");
				continue;
			}
			// Threaded topic when available; otherwise deliver flat to the paired chat.
			const threadField = topicId ? { message_thread_id: Number(topicId) } : {};
			const ckey = send.editable ? item.coalesceKey : undefined;
			const editKey = ckey !== undefined ? `${item.sessionId}:${ckey}` : undefined;
			if (item.lane === "live" && editKey && finalizedKeys.has(editKey)) {
				this.pool.settle(item.itemId!, "removed");
				continue;
			}
			let disposition: "accepted" | "ambiguous" | "rejected" = "accepted";
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
				if (topicLease && !this.topicLeaseIsCurrent(topicLease)) {
					disposition = "rejected";
					continue;
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
							if (topicLease && !this.topicLeaseIsCurrent(topicLease)) return;
							await this.botApi.call("sendMessage", {
								chat_id: this.opts.chatId,
								...threadField,
								text: chunks[0]!,
								parse_mode: TELEGRAM_PARSE_MODE,
							});
							for (let i = 1; i < chunks.length; i++) {
								this.submitPool({
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
										topicLease,
									},
								});
							}
						};
						const richMessageId = await deliverRichWithFallback(
							this.botApi,
							{ chat_id: this.opts.chatId, ...threadField },
							send,
							AbortSignal.any([this.#deliveryAbort.signal, AbortSignal.timeout(30_000)]),
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
							try {
								const res = (await this.botApi.call("editMessageText", {
									chat_id: this.opts.chatId,
									message_id: existingId,
									text: chunks[0],
									parse_mode: TELEGRAM_PARSE_MODE,
								})) as { ok?: boolean; description?: string } | null;
								edited = res?.ok !== false || /not modified/i.test(String(res?.description ?? ""));
							} catch {
								edited = false;
							}
							if (edited) {
								firstMessageId = existingId;
							} else if (!topicLease || this.topicLeaseIsCurrent(topicLease)) {
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
								this.submitPool({
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
										topicLease,
									},
								});
							}
						}
						if (editKey && ckey !== undefined && firstMessageId !== undefined && !send.terminal) {
							this.recordLiveMessage(item.sessionId, ckey, firstMessageId);
						}
					}
				}
			} catch {
				// Best-effort: a failed send/edit must never stop the daemon.
				disposition = "ambiguous";
			} finally {
				this.pool.settle(item.itemId!, disposition);
				// A terminal tool frame owns the end of this coalescing key even when both
				// edit and fallback delivery fail. Retaining the old message id would leak
				// one entry per failure and let a later reused key edit stale Telegram state.
				if (send.terminal && editKey) this.liveMessages.delete(editKey);
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
		// Single-slot categories (rolling turn/context/reasoning previews) evict prior
		// same-category entries to stay bounded. Concurrent categories such as
		// `tool:<toolCallId>` key each in-flight item independently: parallel tools each
		// own a distinct bubble, so evicting same-category siblings would orphan a
		// still-open tool's message id and leave a stale "started" bubble that its
		// terminal frame can no longer edit in place.
		if (!TelegramNotificationDaemon.#CONCURRENT_LIVE_CATEGORIES.has(category)) {
			const prefix = `${sessionId}:${category}:`;
			for (const k of [...this.liveMessages.keys()]) {
				if (k !== mapKey && k.startsWith(prefix)) this.liveMessages.delete(k);
			}
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
		this.submitPool({ sessionId, lane: send.lane, coalesceKey: send.coalesceKey, payload: { send } });
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
	private async renewOwnershipHeartbeat(): Promise<boolean> {
		return renewDaemonHeartbeat({
			settings: this.opts.settings,
			ownerId: this.opts.ownerId,
			tokenFingerprint: tokenFingerprint(this.opts.botToken),
			chatId: this.opts.chatId,
			fs: this.fsImpl,
			now: this.opts.now,
			pid: this.opts.pid ?? process.pid,
		});
	}

	/**
	 * Ownership must be renewed independently of Telegram's 25-second long poll:
	 * the ownership TTL is shorter than a single poll request.
	 */
	private startOwnershipHeartbeatTimer(): void {
		this.runtime.startInterval("telegram-owner-heartbeat", HEARTBEAT_INTERVAL_MS, () => {
			if (!this.running) return;
			void this.runtime
				.runExclusive("telegram-owner-heartbeat", async () => {
					if (!(await this.renewOwnershipHeartbeat())) this.runtime.requestStop();
				})
				.catch(err => {
					logger.warn(`notifications: ownership heartbeat failed: ${sanitizeDiagnostic(String(err))}`);
				});
		});
	}

	private stopOwnershipHeartbeatTimer(): void {
		this.runtime.stopInterval("telegram-owner-heartbeat");
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
		const topicLease = await this.topicAuthorityLease(sessionId);
		if (!topicLease || !this.topicLeaseIsCurrent(topicLease)) return;
		const topicId = topicLease.topicId;
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
	private async setReaction(messageId: number, emoji: string): Promise<void> {
		if (!(await this.pairedChatIsPrivate())) return;
		try {
			await this.botApi.call("setMessageReaction", {
				chat_id: this.opts.chatId,
				message_id: messageId,
				reaction: [{ type: "emoji", emoji }],
			});
		} catch {
			// Best-effort: reactions may be disallowed in the chat; never throw.
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

	/** Render successful `/model` lists as session-bound, one-shot inline choices. */
	async #renderModelChoices(session: SessionSocket, msg: Record<string, unknown>): Promise<boolean> {
		const logicalSessionId = this.#logicalSessionId(session);
		if (
			msg.type !== "control_command_result" ||
			msg.status !== "ok" ||
			msg.sessionId !== logicalSessionId ||
			!Array.isArray(msg.modelChoices) ||
			this.sessions.get(session.sessionId) !== session
		)
			return false;

		const choices: RenderedModelChoice[] = [];
		for (const choice of msg.modelChoices) {
			if (!choice || typeof choice !== "object") continue;
			const { selector, label } = choice as { selector?: unknown; label?: unknown };
			const safeLabel = safeModelButtonLabel(label);
			if (typeof selector !== "string" || !selector.trim() || !safeLabel) continue;
			choices.push({ selector, label: safeLabel });
		}
		if (choices.length === 0) return false;

		const rendered = renderThreadedFrame({ ...msg, type: "control_command_result" });
		if (!rendered?.text) return false;
		const topicId =
			(await this.existingTopicForPrivateChat(session.sessionId)) ??
			(await this.ensureTopic(session.sessionId, this.topicNameFor(session.sessionId, msg)));
		const topicLease = await this.topicAuthorityLease(session.sessionId);
		if (!topicId || !topicLease || topicLease.topicId !== topicId) return false;

		// Each logical session owns only its most recently rendered menu.
		this.#clearModelChoiceAliases(logicalSessionId);
		const aliases = choices.map(choice =>
			this.#putModelChoiceAlias({ session, sessionId: logicalSessionId, selector: choice.selector }),
		);
		const inline_keyboard = buildButtonGrid(
			choices.map(choice => choice.label),
			index => aliases[index]!,
		);
		if (!this.topicLeaseIsCurrent(topicLease)) return false;
		try {
			const response = await this.botApi.call("sendMessage", {
				chat_id: this.opts.chatId,
				message_thread_id: Number(topicId),
				text: rendered.text,
				parse_mode: TELEGRAM_PARSE_MODE,
				reply_markup: { inline_keyboard },
			});
			if (response && typeof response === "object" && (response as { ok?: unknown }).ok === false) {
				for (const alias of aliases) this.#modelChoiceAliases.delete(alias);
				logger.warn("notifications: failed to send model selection keyboard");
				return false;
			}
		} catch {
			for (const alias of aliases) this.#modelChoiceAliases.delete(alias);
			logger.warn("notifications: failed to send model selection keyboard");
			return false;
		}
		return true;
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
			if (replayValid) {
				session.hostGeneration = msg.generation;
			}
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
			if (replayValid) {
				this.#terminalizeBtwTurnsForGenerationChange(session);
				this.#resumeBtwTurnsForSession(session);
				if (this.topics.markReplayCursor(session.sessionId, msg.generation, msg.lastSeq))
					await this.persistTopics();
			}
			return;
		}
		if (msg?.type === "event_replay_result") return;
		if (msg && typeof msg === "object") this.#updateLogicalSessionForThreadedFrame(session, msg);
		if (await this.sessionRouter.dispatch(session, msg as Record<string, unknown>)) return;
		if (await this.#renderModelChoices(session, msg as Record<string, unknown>)) return;

		if (msg?.type === "ephemeral_turn_result") {
			const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
			if (!requestId) return;
			this.#purgeBtwTombstones();
			const tombstone = this.#btwTerminalTombstones.get(requestId);
			if (
				tombstone &&
				tombstone.sessionId === msg.sessionId &&
				tombstone.updateId === msg.updateId &&
				tombstone.messageId === msg.messageId &&
				tombstone.threadId === msg.threadId
			)
				return;
			if (tombstone) return;
			const pending = this.#pendingBtwTurns.get(requestId);
			if (!pending || pending.expiresAt <= (this.opts.now?.() ?? Date.now())) {
				this.#pendingBtwTurns.delete(requestId);
				return;
			}
			const logicalSessionId = this.#logicalSessionId(session);
			if (
				msg.sessionId !== logicalSessionId ||
				pending.logicalSessionId !== logicalSessionId ||
				pending.transportSessionId !== session.sessionId ||
				this.sessions.get(session.sessionId) !== session ||
				pending.endpointDigest !== session.endpointDigest ||
				pending.generation !== session.hostGeneration ||
				msg.threadId !== pending.threadId ||
				msg.updateId !== pending.updateId ||
				msg.messageId !== pending.messageId ||
				this.topics.sessionForTopic(pending.threadId) !== pending.transportSessionId
			)
				return;
			if (
				msg.status !== "ok" &&
				msg.status !== "busy" &&
				msg.status !== "timeout" &&
				msg.status !== "cancelled" &&
				msg.status !== "session_unavailable" &&
				msg.status !== "failed"
			)
				return;
			if (msg.status === "ok" && typeof msg.text !== "string") return;
			if (this.#stoppingBtw || this.#btwTerminalDeliveries.has(requestId)) return;
			const finished = Promise.withResolvers<void>();
			const terminalDelivery: PendingBtwDelivery = {
				pending,
				invalidated: false,
				terminalizeOnInvalidation: false,
				controller: new AbortController(),
				finished: finished.promise,
				finish: finished.resolve,
			};
			this.#btwTerminalDeliveries.set(requestId, terminalDelivery);
			let deliveryOutcome: "accepted" | "not_delivered" | "uncertain" | "partial_accepted" = "not_delivered";
			try {
				if (msg.status !== "ok") {
					const text =
						msg.status === "busy"
							? "Two /btw questions are already running. Wait for one to finish."
							: msg.status === "timeout"
								? "This /btw question timed out after 120 seconds. Send it again to retry."
								: msg.status === "cancelled" || msg.status === "session_unavailable"
									? "This /btw question stopped because the GJC session closed or changed. Reopen it and try again."
									: "This /btw question failed. Send it again to retry.";
					try {
						const response = await this.#sendBtwMessage({
							threadId: pending.threadId,
							messageId: pending.messageId,
							text,
							signal: terminalDelivery.controller.signal,
						});
						deliveryOutcome =
							response && typeof response === "object" && (response as { ok?: unknown }).ok === true
								? "accepted"
								: response && typeof response === "object" && (response as { ok?: unknown }).ok === false
									? "not_delivered"
									: "uncertain";
					} catch {
						deliveryOutcome = "uncertain";
						logger.warn("notifications: /btw status delivery failed");
					}
					return;
				}
				const markdown = msg.text;
				const isAuthoritative = (): boolean =>
					!this.#stoppingBtw &&
					this.sessions.get(session.sessionId) === session &&
					session.ws.readyState === WebSocket.OPEN &&
					pending.endpointDigest === session.endpointDigest &&
					pending.generation === session.hostGeneration &&
					pending.logicalSessionId === this.#logicalSessionId(session) &&
					pending.transportSessionId === session.sessionId &&
					requestId === msg.requestId &&
					pending.logicalSessionId === msg.sessionId &&
					pending.messageId === msg.messageId &&
					pending.threadId === msg.threadId &&
					pending.updateId === msg.updateId &&
					this.topics.sessionForTopic(pending.threadId) === pending.transportSessionId;
				const signal = AbortSignal.any([
					this.#btwDeliveryAbort.signal,
					terminalDelivery.controller.signal,
					AbortSignal.timeout(30_000),
				]);
				const deliver = async (
					method: "sendMessage" | "sendRichMessage",
					body: unknown,
				): Promise<"accepted" | "rejected" | "uncertain" | "stale"> => {
					if (!isAuthoritative()) return "stale";
					try {
						const response = await this.botApi.call(method, body, { noRetry: true, signal });
						if (!response || typeof response !== "object") return "uncertain";
						if ((response as { ok?: unknown }).ok === true) return "accepted";
						if ((response as { ok?: unknown }).ok === false) return "rejected";
						return "uncertain";
					} catch {
						return "uncertain";
					}
				};
				const html = markdownToTelegramHtml(markdown);
				const fallback = async (): Promise<typeof deliveryOutcome> => {
					let acceptedChunks = 0;
					for (const [index, text] of splitTelegramHtml(html).entries()) {
						const outcome = await this.#queueBtwFallbackChunk({
							requestId,
							chunkIndex: index,
							pending,
							signal,
							isAuthoritative,
							body: {
								chat_id: this.opts.chatId,
								message_thread_id: Number(pending.threadId),
								...(index === 0 ? { reply_parameters: { message_id: pending.messageId } } : {}),
								text,
								parse_mode: TELEGRAM_PARSE_MODE,
							},
						});
						if (outcome === "accepted") {
							acceptedChunks++;
							continue;
						}
						if (outcome === "partial_accepted" || acceptedChunks > 0) return "partial_accepted";
						return outcome === "uncertain" ? "uncertain" : "not_delivered";
					}
					return "accepted";
				};
				if (this.opts.rich?.enabled !== false && isBtwRichEligible(markdown)) {
					const outcome = await deliver("sendRichMessage", {
						chat_id: this.opts.chatId,
						message_thread_id: Number(pending.threadId),
						reply_parameters: { message_id: pending.messageId },
						rich_message: { markdown, skip_entity_detection: true },
					});
					deliveryOutcome =
						outcome === "accepted"
							? "accepted"
							: outcome === "rejected"
								? await fallback()
								: outcome === "uncertain"
									? "uncertain"
									: "not_delivered";
				} else {
					deliveryOutcome = await fallback();
				}
			} finally {
				if (this.#btwTerminalDeliveries.get(requestId) === terminalDelivery) {
					this.#btwTerminalDeliveries.delete(requestId);
				}
				try {
					// Unknown transport outcomes stay single-attempt to avoid duplicate Telegram replies.
					if (terminalDelivery.invalidated && deliveryOutcome === "not_delivered") {
						if (terminalDelivery.terminalizeOnInvalidation)
							await this.#terminalizeBtwTurn(requestId, pending, this.#stoppingBtw);
					} else {
						// Any accepted chunk is already a user-visible terminal sequence. Tombstone
						// it even when a later chunk fails so invalidation cannot append a second
						// session-unavailable reply.
						this.#takeBtwTurn(requestId, pending);
					}
				} finally {
					terminalDelivery.finish();
				}
			}
			return;
		}
		if (typeof msg?.type === "string" && TelegramNotificationDaemon.THREADED_FRAMES.has(msg.type)) {
			const send = renderThreadedFrame(msg);
			if (!send) return;
			const existingTopic = await this.existingTopicForPrivateChat(session.sessionId);
			if (this.topics.get(session.sessionId)?.authorityState === "delete_pending") return;
			if (!send.identity && !existingTopic && !this.flatIdentitySent.has(session.sessionId)) {
				this.rememberPendingThreadedFrame(session.sessionId, send, msg as Record<string, unknown>);
				return;
			}
			if (send.identity && !this.sessionCanClaimIdentity(session, msg)) {
				const ownerId = this.topicOwnerForIdentity(msg);
				const ownerLease = ownerId ? await this.topicAuthorityLease(ownerId) : undefined;
				if (ownerId && ownerId !== session.sessionId && ownerLease) {
					await this.flushPendingThreadedFrames(session.sessionId, ownerLease);
					return;
				}
			}
			const topicId =
				existingTopic ?? (await this.ensureTopic(session.sessionId, this.topicNameFor(session.sessionId, msg)));
			const topicLease = await this.topicAuthorityLease(session.sessionId);
			if (!topicId || !topicLease || topicLease.topicId !== topicId) {
				if (this.topics.get(session.sessionId)?.authorityState === "delete_pending") return;
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
				await this.reconcileUserTopicName(topicLease);
				const name = this.topicNameFor(session.sessionId, msg);
				if (this.topics.needsRename(session.sessionId, name)) {
					this.daemonRenameAttempts.set(
						session.sessionId,
						(this.daemonRenameAttempts.get(session.sessionId) ?? 0) + 1,
					);
					try {
						if (!this.topicLeaseIsCurrent(topicLease)) return;
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
							await this.reconcileUserTopicName(topicLease);
						}
					}
				}
				// Send the full bulleted identity header EXACTLY ONCE per topic.
				if (this.topics.needsIdentity(session.sessionId)) {
					await this.submitThreadedFrame(session.sessionId, send, topicLease);
					this.topics.markIdentitySent(session.sessionId);
				}
				await this.flushPendingThreadedFrames(session.sessionId, topicLease);
				await this.persistTopics();
				return;
			}
			await this.submitThreadedFrame(session.sessionId, send, topicLease);
			return;
		}
		if (msg.type === "action_needed" && msg.id) {
			if (msg.kind === "ask") session.pending.set(msg.id, { sessionId: session.sessionId, actionId: msg.id });
			if (this.topics.get(session.sessionId)?.authorityState === "delete_pending") return;
			const topicId = await this.ensureTopic(session.sessionId, this.topicNameFor(session.sessionId, msg));
			const topicLease = topicId ? this.topicAuthorityLeaseFromRegistry(session.sessionId) : undefined;
			if (topicId && (!topicLease || topicLease.topicId !== topicId)) return;
			if (!topicId) {
				// Fail closed for non-private chats; only nudge + flat-deliver in a private DM.
				if (!(await this.pairedChatIsPrivate())) return;
				await this.notifyThreadedFallback();
			}
			const threadField = topicLease ? { message_thread_id: Number(topicLease.topicId) } : {};
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
					if (topicLease && !this.topicLeaseIsCurrent(topicLease)) return undefined;
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

				if (topicLease && !this.topicLeaseIsCurrent(topicLease)) return;
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
					},
					AbortSignal.any([this.#deliveryAbort.signal, AbortSignal.timeout(30_000)]),
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

	/** Claim and forward one session-bound model alias before acknowledging its callback. */
	async #handleModelChoiceCallback(update: unknown, callbackId: unknown): Promise<boolean> {
		const callback = (
			update as {
				callback_query?: { data?: unknown; message?: { chat?: { id?: unknown } } };
			}
		).callback_query;
		const alias = callback?.data;
		if (typeof alias !== "string" || !alias.startsWith(MODEL_CALLBACK_PREFIX)) return false;
		this.#sweepExpiredModelChoiceAliases();
		if (String(callback?.message?.chat?.id) !== String(this.opts.chatId)) {
			await this.answerCallbackQueryBestEffort(callbackId, "Not authorized");
			return true;
		}
		if (!(await this.pairedChatIsPrivate())) {
			await this.answerCallbackQueryBestEffort(callbackId, "Not authorized");
			return true;
		}

		const route = this.#modelChoiceAliases.get(alias);
		if (!route) {
			await this.#sendModelStaleGuidance(callbackId);
			return true;
		}
		const session = route.session;
		if (
			this.sessions.get(session.sessionId) !== session ||
			this.#logicalSessionId(session) !== route.sessionId ||
			session.ws.readyState !== WebSocket.OPEN
		) {
			this.#modelChoiceAliases.delete(alias);
			await this.#sendModelStaleGuidance(callbackId);
			return true;
		}

		// Delete before send so a duplicate tap can only become stale, never duplicate a control command.
		this.#modelChoiceAliases.delete(alias);
		const updateId = (update as { update_id?: unknown }).update_id;
		const safeUpdateId =
			typeof updateId === "number" && Number.isSafeInteger(updateId) && updateId >= 0 ? updateId : undefined;
		try {
			session.ws.send(
				JSON.stringify({
					type: "control_command",
					sessionId: route.sessionId,
					token: session.token,
					requestId: safeUpdateId === undefined ? `tg:model:${alias}` : `tg:model:${safeUpdateId}`,
					...(safeUpdateId === undefined ? {} : { updateId: safeUpdateId }),
					command: { name: "model", action: "set", selector: route.selector },
				}),
			);
		} catch {
			await this.#sendModelStaleGuidance(callbackId);
			return true;
		}
		await this.answerCallbackQueryBestEffort(callbackId);
		return true;
	}

	async #sendModelStaleGuidance(callbackId: unknown): Promise<void> {
		const text = "Button is stale. Run /model again.";
		await this.answerCallbackQueryBestEffort(callbackId, text);
		if (!(await this.pairedChatIsPrivate())) return;
		try {
			await this.botApi.call("sendMessage", {
				chat_id: this.opts.chatId,
				text,
				parse_mode: TELEGRAM_PARSE_MODE,
			});
		} catch {
			// Best-effort stale guidance must not reject a callback.
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
			const topicLease = this.topicAuthorityLeaseFromRegistry(sessionId);
			if (topicLease) await this.reconcileUserTopicName(topicLease);
			await this.rememberSeenUpdateId(updateId);
			return "consumed";
		}
		try {
			await this.persistTopics();
		} catch {
			return "retry";
		}
		const topicLease = this.topicAuthorityLeaseFromRegistry(sessionId);
		if (topicLease) await this.reconcileUserTopicName(topicLease);
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
			message?: { text?: unknown; reply_to_message?: { message_id?: unknown } };
		};
		// A reply to a known ask message routes to that ask (below). Any OTHER
		// message in a topic (plain text, or a reply to a non-ask message) is a
		// free-text injection. Previously replies bypassed injection entirely.
		const replyTo = raw.message?.reply_to_message?.message_id;
		const reservedBtw =
			typeof raw.message?.text === "string" ? parseBtwCommand(raw.message.text, this.botUsername) : undefined;
		const isAskReply =
			replyTo !== undefined && (this.messageRoutes.has(String(replyTo)) || this.messageRoutes.has(Number(replyTo)));
		const directControl =
			typeof raw.message?.text === "string"
				? parseTelegramControlCommand(raw.message.text, this.botUsername)
				: ({ kind: "none" } as const);
		const interceptAskControl = isAskReply && directControl.kind !== "none";
		if (!raw.callback_query && (!isAskReply || interceptAskControl || reservedBtw !== undefined)) {
			const inbound = decideThreadedInbound(update as never, {
				pairedChatId: this.opts.chatId,
				topicToSession: t => this.topics.sessionForTopic(t),
				isDuplicate: id => this.dispatchState.seenUpdateIds.has(id),
			});
			if (inbound.kind === "duplicate") return;
			if (inbound.kind === "inject") {
				if (!(await this.pairedChatIsPrivate())) return;
				const preliminaryControl = inbound.attachment
					? { kind: "none" as const }
					: parseTelegramControlCommand(inbound.text, this.botUsername);
				if (preliminaryControl.kind === "ignored") return;
				const session = this.sessions.get(inbound.sessionId);
				if (preliminaryControl.kind === "invalid" && session?.ws.readyState !== WebSocket.OPEN) return;
				if (preliminaryControl.kind === "command" && session?.ws.readyState !== WebSocket.OPEN) {
					if (await this.reserveSeenUpdateId(inbound.updateId)) {
						try {
							await this.botApi.call("sendMessage", {
								chat_id: this.opts.chatId,
								message_thread_id: Number(inbound.threadId),
								text: "Session control unavailable: this local GJC session is disconnected.",
							});
						} catch {
							logger.warn("notifications: unavailable-control notice delivery failed");
						}
					}
					return;
				}
				const reservedBtw = parseBtwCommand(inbound.text, this.botUsername);
				if (reservedBtw?.kind === "ignored") {
					await this.rememberSeenUpdateId(inbound.updateId);
					return;
				}
				if (reservedBtw?.kind === "question" && (!reservedBtw.question || inbound.attachment)) {
					if (!(await this.reserveSeenUpdateId(inbound.updateId))) return;
					await this.#sendBtwMessage({
						threadId: inbound.threadId,
						messageId: inbound.messageId,
						text: BTW_USAGE_TEXT,
					});
					return;
				}
				if (reservedBtw?.kind === "question" && this.opts.btw?.enabled === false) {
					if (!(await this.reserveSeenUpdateId(inbound.updateId))) return;
					await this.#sendBtwMessage({
						threadId: inbound.threadId,
						messageId: inbound.messageId,
						text: "Telegram /btw is disabled in local settings.",
					});
					return;
				}
				if (reservedBtw?.kind === "question" && session?.ws.readyState !== WebSocket.OPEN) {
					if (!(await this.reserveSeenUpdateId(inbound.updateId))) return;
					await this.#sendBtwMessage({
						threadId: inbound.threadId,
						messageId: inbound.messageId,
						text: "Restart this GJC session to enable /btw.",
					});
					return;
				}
				if (session?.ws.readyState === WebSocket.OPEN) {
					const attachmentResult = inbound.attachment
						? await this.resolveInboundAttachment(inbound.attachment, inbound.sessionId)
						: undefined;
					const images = attachmentResult?.images ?? [];
					const fileNotes = attachmentResult?.fileNotes ?? [];
					const hasMedia = inbound.attachment !== undefined || images.length > 0 || fileNotes.length > 0;
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
					const btw = parseBtwCommand(inbound.text, this.botUsername);
					if (btw?.kind === "ignored") {
						await this.rememberSeenUpdateId(inbound.updateId);
						return;
					}
					if (btw?.kind === "question") {
						const btwQuestion = btw.question;
						if (!btwQuestion || hasMedia) {
							if (!(await this.reserveSeenUpdateId(inbound.updateId))) return;
							await this.#sendBtwMessage({
								threadId: inbound.threadId,
								messageId: inbound.messageId,
								text: BTW_USAGE_TEXT,
							});
							return;
						}
						if (!isValidBtwQuestion(btwQuestion)) {
							try {
								await this.#sendBtwMessage({
									threadId: inbound.threadId,
									messageId: inbound.messageId,
									text: BTW_QUESTION_LIMIT_TEXT,
								});
							} catch {
								logger.warn("notifications: /btw question-limit delivery failed");
							}
							await this.reserveSeenUpdateId(inbound.updateId);
							return;
						}
						if (this.opts.btw?.enabled === false) {
							if (!(await this.reserveSeenUpdateId(inbound.updateId))) return;
							await this.#sendBtwMessage({
								threadId: inbound.threadId,
								messageId: inbound.messageId,
								text: "Telegram /btw is disabled in local settings.",
							});
							return;
						}
						if (!session.ephemeralCapable || session.hostGeneration < 1) {
							if (!(await this.reserveSeenUpdateId(inbound.updateId))) return;
							await this.#sendBtwMessage({
								threadId: inbound.threadId,
								messageId: inbound.messageId,
								text: "Restart this GJC session to enable /btw.",
							});
							return;
						}
						this.#purgeBtwTombstones();
						for (const [id, pending] of this.#pendingBtwTurns) {
							if (pending.expiresAt <= (this.opts.now?.() ?? Date.now())) this.#pendingBtwTurns.delete(id);
						}
						if (!Number.isSafeInteger(inbound.messageId) || inbound.messageId <= 0) return;
						while (
							this.#pendingBtwTurns.size + this.#btwTerminalTombstones.size >= BTW_MAX_PENDING &&
							this.#btwTerminalTombstones.size > 0
						) {
							this.#btwTerminalTombstones.delete(this.#btwTerminalTombstones.keys().next().value!);
						}
						if (this.#pendingBtwTurns.size >= BTW_MAX_PENDING) {
							if (!(await this.reserveSeenUpdateId(inbound.updateId))) return;
							await this.#sendBtwMessage({
								threadId: inbound.threadId,
								messageId: inbound.messageId,
								text: BTW_CAPACITY_TEXT,
							});
							return;
						}
						const transportSessionId = session.sessionId;
						const logicalSessionId = this.#logicalSessionId(session);
						const requestId = `btw:${crypto.randomUUID()}`;
						if (!(await this.reserveSeenUpdateId(inbound.updateId))) return;
						const pending: PendingBtwTurn = {
							transportSessionId,
							logicalSessionId,
							endpointDigest: session.endpointDigest,
							generation: session.hostGeneration,
							question: btwQuestion,
							messageId: inbound.messageId,
							threadId: inbound.threadId,
							updateId: inbound.updateId,
							expiresAt: (this.opts.now?.() ?? Date.now()) + BTW_PENDING_TTL_MS,
						};
						this.#pendingBtwTurns.set(requestId, pending);
						if (!this.#sendPendingBtwTurn(session, requestId, pending)) {
							this.#pendingBtwTurns.delete(requestId);
							await this.#sendBtwMessage({
								threadId: inbound.threadId,
								messageId: inbound.messageId,
								text: "Unable to start /btw because this GJC session disconnected. Reopen the session and try again.",
							});
							return;
						}
						return;
					}
					const control = hasMedia ? { kind: "none" as const } : preliminaryControl;
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
						if (control.kind === "invalid") {
							await sendControlNotice(control.usage);
							return;
						}
						if (session?.ws.readyState !== WebSocket.OPEN) {
							await sendControlNotice("Session control unavailable: session is disconnected.");
							return;
						}
						session.ws.send(
							JSON.stringify({
								type: "control_command",
								sessionId: this.#logicalSessionId(session),
								token: session.token,
								requestId: `tg:${inbound.updateId}`,
								updateId: inbound.updateId,
								threadId: inbound.threadId,
								command: control.command,
							}),
						);
						return;
					}
					const cfg = hasMedia ? undefined : parseInThreadConfigCommand(inbound.text);
					// A plain (non-config) message while an ask is pending for this session
					// answers that ask as free-input — instead of starting a new user turn.
					// Telegram asks always accept custom text (the SDK maps a string answer
					// to the ask's custom-input slot), so route the latest pending ask here.
					const pendingAsk = cfg || hasMedia ? undefined : [...session.pending.values()].at(-1);
					if (pendingAsk) {
						session.ws.send(
							JSON.stringify({
								type: "reply",
								id: pendingAsk.actionId,
								answer: inbound.text,
								token: session.token,
							}),
						);
						await this.rememberSeenUpdateId(inbound.updateId);
						if (inbound.messageId !== undefined) await this.setReaction(inbound.messageId, QUEUED_REACTION);
						return;
					}
					session.ws.send(
						JSON.stringify(
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
						),
					);
					await this.rememberSeenUpdateId(inbound.updateId);
					// User turns get a native delivery double-check: queued on receipt,
					// flipped to consumed when the session acks the turn that picks it
					// up. Config commands are not user turns and get no reaction.
					if (!cfg && inbound.messageId !== undefined) {
						this.inboundReactions.set(inbound.updateId, { messageId: inbound.messageId });
						await this.setReaction(inbound.messageId, QUEUED_REACTION);
					}
				}
				return;
			}
		}
		const callbackId = (update as { callback_query?: { id?: unknown } }).callback_query?.id;
		if (await this.#handleModelChoiceCallback(update, callbackId)) return;
		const decision = routeInboundUpdate(update, {
			aliasTable: this.aliasTable,
			messageRoutes: this.messageRoutes,
			pairedChatId: this.opts.chatId,
		});
		if (decision.kind === "reply") {
			const session = this.sessions.get(decision.sessionId);
			if (session?.ws.readyState !== WebSocket.OPEN || !session.pending.has(decision.actionId)) {
				await this.sendStaleGuidance(callbackId);
				return;
			}
			session.ws.send(
				JSON.stringify({ type: "reply", id: decision.actionId, answer: decision.answer, token: session.token }),
			);
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
					{
						command: "verbose",
						description: "Mirror bounded tool-owned summaries + provider-displayable reasoning summaries",
					},
					{ command: "lean", description: "Mirror assistant text + tool names only (default)" },
					{ command: "redact", description: "Toggle redaction of streamed content: /redact <on|off>" },
					{ command: "rich", description: "Toggle rich Telegram delivery: /rich <on|off>" },
					{ command: "reasoning", description: "Show or change reasoning effort in this session" },
					{ command: "usage", description: "Show provider/local usage for this session" },
					{ command: "model", description: "Select a model for this session" },
					{ command: "context", description: "Show current context usage for this session" },
					{ command: "compact", description: "Compact this session: /compact [instructions]" },
					{ command: "btw", description: "Ask an ephemeral side question in this session" },
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
		// Runtime callers can bypass TypeScript's option type. Do not derive an
		// ownership identity from absent credentials; lifecycle startup still owns
		// cleanup of a factory-created server on this fail-closed path.
		if (!validBotToken(this.opts.botToken)) {
			await this.startLifecycleControl();
			return;
		}
		this.running = await renewDaemonHeartbeat({
			settings: this.opts.settings,
			ownerId: this.opts.ownerId,
			tokenFingerprint: tokenFingerprint(this.opts.botToken),
			chatId: this.opts.chatId,
			fs: this.fsImpl,
			now: this.opts.now,
			pid: this.opts.pid ?? process.pid,
		});
		if (!this.running) return;
		this.runtime.start();
		this.startOwnershipHeartbeatTimer();
		this.startFlushTimer();
		this.startScanTimer();
		this.startTypingTimer();
		try {
			await this.refreshBotIdentity();
			await this.registerBotCommands();
			await this.loadAliases();
			await this.loadTopics();
			await this.loadSeenUpdateIds();
			await this.replyStore.load();
			await this.runScan();
			// Owner-only: start the session-lifecycle control server now that
			// ownership is confirmed (singleton-safe). Best-effort; degrades.
			await this.startLifecycleControl();
			let idleSince = this.runtime.now();
			while (this.running) {
				if (await this.controlStopRequested()) break;
				if (!(await this.renewOwnershipHeartbeat())) break;
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
					logger.warn(
						`notifications: getUpdates failed, backing off ${backoffMs}ms: ${sanitizeDiagnostic(String(e))}`,
					);
					await this.runtime.sleep(backoffMs);
					continue;
				} finally {
					this.runtime.clearAbortController(activePoll);
				}
				if (await this.controlStopRequested()) break;
				await this.runtime.sleep(10);
			}
		} finally {
			this.effects.beginShutdown();
			let persisted = false;
			const shutdown = this.effects.allowTerminal(async () => {
				await this.#drainBtwTurns();
				this.runtime.stop();
				this.stopOwnershipHeartbeatTimer();
				this.stopFlushTimer();
				this.stopScanTimer();
				this.stopTypingTimer();
				this.stopLifecycleControl();
				await this.cleanupAllAttachmentDirs();
				await this.persistAliases();
				await this.persistTopics();
				await this.persistSeenUpdateIds();
				await this.opts.control?.clear?.(this.opts.ownerId);
				persisted = true;
			});
			const deadline = Promise.withResolvers<boolean>();
			const deadlineTimer = setTimeout(() => deadline.resolve(false), BTW_SHUTDOWN_JOIN_MS);
			const completed = await Promise.race([
				shutdown.then(
					() => true,
					error => {
						logger.warn(`notifications: shutdown persistence failed: ${sanitizeDiagnostic(String(error))}`);
						return false;
					},
				),
				deadline.promise,
			]);
			clearTimeout(deadlineTimer);
			const quiesced = completed && (await this.effects.join(BTW_SHUTDOWN_JOIN_MS));
			if (!quiesced || !persisted) {
				logger.warn("notifications: shutdown was not durably quiesced; retaining daemon ownership");
			} else {
				await releaseDaemonOwnership({
					settings: this.opts.settings,
					ownerId: this.opts.ownerId,
					tokenFingerprint: tokenFingerprint(this.opts.botToken),
					chatId: this.opts.chatId,
					pid: this.opts.pid ?? process.pid,
					fs: this.fsImpl,
					now: this.opts.now,
				});
			}
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
