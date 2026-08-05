import { AsyncLocalStorage } from "node:async_hooks";
import { spawn as childProcessSpawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exactReplacePath, type NativeExactFileIdentity, type NativeExactUnlinkResult } from "@gajae-code/natives";
import { logger } from "@gajae-code/utils";
import { withFileLock } from "../../config/file-lock";
import type { Settings } from "../../config/settings";
import type { DaemonRuntimeInfo } from "../../daemon/control-types";
import { resolveGjcRuntimeSpawnInfo } from "../../daemon/runtime";
import { resizeImageBuffer } from "../../utils/image-resize";
import { isProcessIncarnation, processIncarnation } from "../broker/process-incarnation";
import { getNotificationConfig, isProviderEffectivelyEnabled, isTelegramComplete, tokenFingerprint } from "./config";
import {
	parseInThreadConfigCommand,
	parseRichToggleCommand,
	parseTelegramControlCommand,
	parseToolActivityToggleCommand,
} from "./config-commands";
import { daemonPaths, HEARTBEAT_TTL_MS } from "./daemon-paths";
import {
	acquireDaemonTransitionLock,
	classifyNotificationEndpoint,
	type DaemonTransitionLock,
	daemonTransitionLockIsHeld,
	exactUnlinkNotificationFile,
	type NotificationEndpointFile,
	type NotificationEndpointFileIdentity,
	type NotificationExactUnlinkResult,
	readNotificationEndpointFile,
	releaseDaemonTransitionLock,
	sanitizeDiagnostic,
} from "./notification-service";
import { DAEMON_GENERATION, NOTIFICATION_PROTOCOL_VERSION, SERVING_EPOCH } from "./telegram-daemon-contract";
import {
	type DaemonProcessReference,
	type TelegramDaemonControlDeps,
	TelegramDaemonController,
} from "./telegram-daemon-control";
import { type TelegramSetupPreflight, withTelegramSetupLease } from "./telegram-setup";

export { DAEMON_GENERATION, NOTIFICATION_PROTOCOL_VERSION, SERVING_EPOCH } from "./telegram-daemon-contract";

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
	type LifecycleCommandVerb,
	lifecycleUsage,
	normalizeLifecyclePath,
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
import { type ListRecentSessionsResult, listRecentSessions } from "./recent-activity";
import { ReplySentStore } from "./reply-sent-store";
import { DraftStreamState, deliverDraft, shouldStreamDraft } from "./rich-draft";
import {
	deliverRichActionWithFallback,
	deliverRichWithFallback,
	isBtwRichEligible,
	shouldPromoteRich,
} from "./rich-render";
import {
	type AdoptionIntentFs,
	buildAdoptionIntent,
	DEFAULT_ADOPTION_INTENT_TTL_MS,
	TelegramAdoptionIntentStore,
	type TelegramAdoptionTarget,
} from "./telegram-adoption-intent";
import {
	type AliasTable,
	buildActionMarkdown,
	buildActionMessage,
	type CallbackRoute,
	createAliasTable,
	readEndpoint,
	routeInboundUpdate,
	telegramDisableNotification,
} from "./telegram-reference";
import { decideThreadedInbound, type InboundAttachment } from "./threaded-inbound";
import { renderThreadedFrame, supportsTelegramPhotoUpload, type ThreadedSend } from "./threaded-render";
import {
	parseTopicRegistryState,
	type TopicEndpointBinding,
	TopicRegistry,
	type TopicRegistryCasAuthority,
	type TopicRegistryState,
} from "./topic-registry";

export type EnsureDaemonResult = "owner_spawned" | "attached" | "disabled" | "blocked";
/** Detailed result for orchestration that must distinguish a #2028 handoff from a fresh spawn. */
export type EnsureTelegramDaemonDetailedResult = "spawned" | "reloaded" | "attached" | "disabled" | "blocked_identity";

export type TelegramDaemonOwnershipPhase = "provisional" | "ready" | "retired";

export interface DaemonState {
	pid: number;
	/** OS process-start provenance; mandatory for PID-authorized ownership actions. */
	incarnation: string;
	ownerId: string;
	/** Unique, durable identity for one ownership acquisition. */
	acquisitionId?: string;
	/** A provisional owner is physical-live but MUST NOT be attached as ready. */
	ownershipPhase?: TelegramDaemonOwnershipPhase;

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
	 * from both the persisted state-schema {@link DaemonState.version} and the
	 * notification wire protocol version. Absent on pre-generation state.
	 */
	generation?: number;
	/** Lifecycle-serving compatibility epoch; absent pre-epoch records are epoch 1. */
	servingEpoch?: number;
	stoppedAt?: number;
}
interface ExactFileStat {
	dev: bigint;
	ino: bigint;
	nlink: bigint;
	size: bigint;
	mtimeNs: bigint;
	isFile(): boolean;
}

export interface TelegramDaemonFs {
	mkdir(path: string, opts?: fs.MakeDirectoryOptions): Promise<void>;
	readFile(path: string, encoding: BufferEncoding): Promise<string>;
	writeFile(path: string, data: string, opts?: fs.WriteFileOptions): Promise<void>;
	rename(oldPath: string, newPath: string): Promise<void>;
	unlink(path: string): Promise<void>;
	open(path: string, flags: string, mode?: number): Promise<{ sync?: () => Promise<void>; close(): Promise<void> }>;
	readdir(path: string): Promise<string[]>;
	chmod(path: string, mode: number): Promise<void>;
	/** Crash-atomic persistence seams. Implementations without them fail closed. */
	fsyncFile?(path: string): Promise<void>;
	fsyncDirectory?(path: string): Promise<void>;
	stat?(path: string): Promise<{
		mtimeMs: number;
		size?: number;
		dev?: number;
		ino?: number;
		/** Hard-link count; required to prove a staging temp has no second name. */
		nlink?: number;
		ctimeMs?: number;
		isDirectory?(): boolean;
	}>;
	lstat?(path: string, opts: { bigint: true }): Promise<ExactFileStat>;
	readEndpointFile?(path: string): Promise<NotificationEndpointFile>;
	exactUnlink?(
		path: string,
		identity: NotificationEndpointFileIdentity,
		quarantineName?: string,
	): Promise<NotificationExactUnlinkResult>;
}

export interface SpawnResult {
	pid?: number;
	unref?: () => void;
}

export interface TelegramDaemonDeps {
	fs?: TelegramDaemonFs;
	now?: () => number;
	pid?: number;
	pidAlive?: (pid: number) => boolean;
	/** Opens an identity-stable process authority for destructive lifecycle operations. */
	processReference?: (pid: number) => DaemonProcessReference | undefined;
	/** Returns immutable process-start provenance, or undefined when unsupported. */
	pidIncarnation?: (pid: number) => string | undefined;
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
	/** Bounded startup-readiness timeout; injectable for deterministic handoff tests. */
	readinessTimeoutMs?: number;
}

export const HEARTBEAT_INTERVAL_MS = 5_000;
export { HEARTBEAT_TTL_MS };
export const DAEMON_VERSION = 1;
/** Capability token advertised when the server supports app-level ping/pong. */
export const CLIENT_PING_PONG_CAPABILITY = "client_ping_pong";
/** Capability required for typed controls and semantic Selected acknowledgement frames. */
export const ASK_SELECTED_ACK_CAPABILITY = "ask_selected_ack_v1";
export const ASK_CONTROLS_CAPABILITY = "ask_controls_v1";
/** Capability for the closed tool phase set: started, completed, failed, and cancelled. */
export const TOOL_ACTIVITY_CAPABILITY = "tool_activity_v2";
/** Receive-only compatibility capability for pre-v2 hosts. */
export const LEGACY_TOOL_ACTIVITY_CAPABILITY = "tool_activity_v1";
type ToolActivityCapability = "v1" | "v2";

function negotiateToolActivityCapability(
	current: ToolActivityCapability | undefined,
	capabilities: unknown[],
): ToolActivityCapability | undefined {
	if (current === "v2" || capabilities.includes(TOOL_ACTIVITY_CAPABILITY)) return "v2";
	if (current === "v1" || capabilities.includes(LEGACY_TOOL_ACTIVITY_CAPABILITY)) return "v1";
	return undefined;
}

const nodeFs: TelegramDaemonFs = {
	...(fs.promises as unknown as TelegramDaemonFs),
	fsyncFile: async file => {
		const handle = await fs.promises.open(file, "r+");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	},
	fsyncDirectory: async directory => {
		const handle = await fs.promises.open(directory, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	},
	readEndpointFile: readNotificationEndpointFile,
	exactUnlink: async (file, identity, quarantineName) =>
		exactUnlinkNotificationFile(
			file,
			identity,
			quarantineName ?? `.gjc-delete-daemon-transition-${crypto.randomUUID()}.json`,
		),
};

/**
 * Durably persist a daemon-local Telegram delivery toggle. A real
 * {@link Settings} exposes `flushOrThrow()`, which rejects on a failed config.yml
 * write (its `set()` is a fire-and-forget whose background save swallows errors).
 * The lightweight daemon settings has no `flushOrThrow` — its `set()` already
 * wrote durably and throws on failure — so its plain `flush()` no-op drain is
 * sufficient.
 */
async function flushTelegramToggleSettings(settings: Settings): Promise<void> {
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
// Retry a session endpoint whose socket never completes its WebSocket handshake.
const CONNECTING_RECONNECT_MS = 1_000;

// Transient Telegram API delivery is retried this many times before giving up.
const BOT_API_RETRY_ATTEMPTS = 3;
// Backoff after a failed getUpdates long-poll so a persistent outage does not
// busy-loop the daemon.
const POLL_BACKOFF_MS = 1_000;
const AUTOMATIC_RELOAD_COOLDOWN_MS = 10 * 60 * 1_000;
// Default freshness-poll window a cooldown contender waits for a sibling's
// replacement daemon to publish a fresh ready owner before reloading itself.
const RELOAD_FRESHNESS_WAIT_MS = 15_000;
// Cooperative-then-forced termination + replacement-readiness bounds the reload
// controller can spend while holding the reservation lock (mirrors the control
// plane's graceful/kill defaults plus a readiness wait).
const RELOAD_CONTROLLER_GRACEFUL_MS = 8_000;
const RELOAD_CONTROLLER_KILL_MS = 3_000;
const RELOAD_RESERVATION_HEADROOM_MS = 10_000;
const ROOTS_REGISTRATION_LOCK_RETRY_DELAY_MS = 100;
const ROOTS_REGISTRATION_LOCK_HEADROOM_MS = 5_000;
const ROOTS_REGISTRATION_LOCK_RETRIES =
	Math.ceil(
		(RELOAD_CONTROLLER_GRACEFUL_MS + RELOAD_CONTROLLER_KILL_MS + ROOTS_REGISTRATION_LOCK_HEADROOM_MS) /
			ROOTS_REGISTRATION_LOCK_RETRY_DELAY_MS,
	) + 1;
const ROOTS_REGISTRATION_LOCK_OPTIONS = {
	staleMs: 10_000,
	retries: ROOTS_REGISTRATION_LOCK_RETRIES,
	retryDelayMs: ROOTS_REGISTRATION_LOCK_RETRY_DELAY_MS,
};

/**
 * File-lock options whose acquisition budget covers the full reload-reservation
 * critical section: the in-lock freshness poll plus the controller's
 * graceful+kill+readiness sequence, with headroom. A contender must be able to
 * wait out a legitimate slow reload and then attach, never fail startup.
 */
export function reloadReservationLockOptions(input: {
	freshnessWaitMs: number;
	readinessTimeoutMs: number;
	retryDelayMs?: number;
}): { staleMs: number; retries: number; retryDelayMs: number } {
	const retryDelayMs = Math.max(input.retryDelayMs ?? 100, 1);
	const criticalMs =
		Math.max(input.freshnessWaitMs, 0) +
		RELOAD_CONTROLLER_GRACEFUL_MS +
		RELOAD_CONTROLLER_KILL_MS +
		Math.max(input.readinessTimeoutMs, 0) +
		RELOAD_RESERVATION_HEADROOM_MS;
	return { staleMs: 10_000, retries: Math.max(1, Math.ceil(criticalMs / retryDelayMs)), retryDelayMs };
}
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
const PICKER_CALLBACK_PREFIX = "p:";
const ADOPTION_INTENT_SWEEP_INTERVAL_MS = 60_000;
const BTW_MAX_PENDING = 256;
const BTW_SHUTDOWN_JOIN_MS = 1_000;
const BTW_USAGE_TEXT = "Usage: /btw <question>";
const BTW_CAPACITY_TEXT = "Too many /btw questions are pending. Wait for one to finish and try again.";
export const BTW_QUESTION_MAX_UNICODE_SCALARS = 4_096;
export const BTW_QUESTION_MAX_UTF8_BYTES = 16_384;
const TELEGRAM_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const TELEGRAM_SESSION_ATTACHMENT_MAX_COUNT = 20;
const TELEGRAM_SESSION_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
const TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 60_000;
const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const TELEGRAM_PHOTO_MAX_DIMENSION = 10_000;
const TELEGRAM_PHOTO_MAX_ASPECT_RATIO = 20;
const BTW_QUESTION_LIMIT_TEXT = "Question must be at most 4096 Unicode scalar values and 16384 UTF-8 bytes.";
type ParsedBtwCommand = { kind: "question"; question: string } | { kind: "ignored" };
type TelegramFileDownload = { bytes: Buffer } | { failure: "download_failed" | "too_large" };
class ThreadedModeCapabilityRefusal extends Error {}

async function prepareTelegramImageAttachment(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
	if (frame.type !== "image_attachment") return frame;
	const mime = typeof frame.mime === "string" ? frame.mime : undefined;
	const data = typeof frame.data === "string" ? frame.data : undefined;
	if (!data || supportsTelegramPhotoUpload(mime) || !mime?.toLowerCase().startsWith("image/")) return frame;
	try {
		const converted = await resizeImageBuffer(Buffer.from(data, "base64"), mime, {
			maxWidth: TELEGRAM_PHOTO_MAX_DIMENSION,
			maxHeight: TELEGRAM_PHOTO_MAX_DIMENSION,
			maxBytes: TELEGRAM_PHOTO_MAX_BYTES,
			jpegQuality: 90,
			excludeWebP: true,
			forceReencode: true,
		});
		const shortestEdge = Math.min(converted.width, converted.height);
		const longestEdge = Math.max(converted.width, converted.height);
		if (
			!supportsTelegramPhotoUpload(converted.mimeType) ||
			converted.buffer.byteLength > TELEGRAM_PHOTO_MAX_BYTES ||
			shortestEdge <= 0 ||
			longestEdge / shortestEdge > TELEGRAM_PHOTO_MAX_ASPECT_RATIO
		) {
			return frame;
		}
		return { ...frame, mime: converted.mimeType, data: converted.data };
	} catch (error) {
		logger.warn(`notifications: image conversion failed; falling back to document: ${String(error)}`);
		return frame;
	}
}

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
function topicArchiveSettled(response: unknown): boolean {
	if (!response || typeof response !== "object") return false;
	const result = response as { ok?: unknown; result?: unknown; error_code?: unknown; description?: unknown };
	if (result.ok === true && result.result === true) return true;
	if (result.ok !== false || result.error_code !== 400 || typeof result.description !== "string") return false;
	const description = result.description.trim();
	return /^(?:Bad Request: )?(?:TOPIC_NOT_FOUND|THREAD_NOT_FOUND|topic (?:already|is already) closed|message thread (?:not found|is not modified))$/i.test(
		description,
	);
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

async function writeJsonAtomic(
	fsImpl: TelegramDaemonFs,
	file: string,
	data: unknown,
	options: { durable?: boolean } = {},
): Promise<void> {
	const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	let renamed = false;
	try {
		await fsImpl.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		await fsImpl.chmod(tmp, 0o600).catch(() => undefined);
		if (options.durable) await syncTelegramFile(fsImpl, tmp);
		await fsImpl.rename(tmp, file);
		renamed = true;
		if (options.durable) await syncTelegramDirectory(fsImpl, path.dirname(file));
	} catch (error) {
		if (renamed) throw error;
		let cleanupError: unknown;
		try {
			await fsImpl.unlink(tmp);
		} catch (candidate) {
			if ((candidate as NodeJS.ErrnoException).code !== "ENOENT") cleanupError = candidate;
		}
		if (cleanupError) throw new AggregateError([error, cleanupError], "Atomic JSON write and cleanup failed");
		throw error;
	}
}

async function syncTelegramFile(fsImpl: TelegramDaemonFs, file: string): Promise<void> {
	const handle = await fsImpl.open(file, "r+");
	let syncError: unknown;
	try {
		if (typeof handle.sync !== "function")
			throw new Error("Telegram alias durability requires filesystem sync support");
		await handle.sync();
	} catch (error) {
		syncError = error;
	}
	let closeError: unknown;
	try {
		await handle.close();
	} catch (error) {
		closeError = error;
	}
	if (syncError && closeError)
		throw new AggregateError([syncError, closeError], "Telegram alias file sync and close failed");
	if (syncError) throw syncError;
	if (closeError) throw closeError;
}

async function syncTelegramDirectory(fsImpl: TelegramDaemonFs, directory: string): Promise<void> {
	let handle: Awaited<ReturnType<TelegramDaemonFs["open"]>>;
	try {
		handle = await fsImpl.open(directory, "r");
	} catch (error) {
		if (process.platform === "win32" && isUnsupportedTelegramDirectoryBarrier(error)) return;
		throw error;
	}
	let syncError: unknown;
	try {
		if (typeof handle.sync !== "function")
			throw new Error("Telegram alias durability requires filesystem sync support");
		await handle.sync();
	} catch (error) {
		if (!(process.platform === "win32" && isUnsupportedTelegramDirectoryBarrier(error))) syncError = error;
	}
	let closeError: unknown;
	try {
		await handle.close();
	} catch (error) {
		closeError = error;
	}
	if (syncError && closeError)
		throw new AggregateError([syncError, closeError], "Telegram alias directory sync and close failed");
	if (syncError) throw syncError;
	if (closeError) throw closeError;
}

function isUnsupportedTelegramDirectoryBarrier(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "EINVAL" || code === "EISDIR" || code === "ENOTSUP" || code === "EPERM";
}

export class TopicRegistryDurabilityUnavailableError extends Error {
	readonly code = "durability_unavailable";

	constructor(cause: unknown) {
		super("topic registry durability is unavailable", { cause });
		this.name = "TopicRegistryDurabilityUnavailableError";
	}
}

type TopicRegistryExactReplace = (
	sourcePath: string,
	destinationPath: string,
	expectedSource: NativeExactFileIdentity,
	expectedDestination: NativeExactFileIdentity,
) => NativeExactUnlinkResult;

function sameExactFileStat(left: ExactFileStat, right: ExactFileStat): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs
	);
}

async function captureExactFileSnapshot(
	fsImpl: TelegramDaemonFs,
	file: string,
): Promise<{ bytes: string; identity: NativeExactFileIdentity }> {
	if (!fsImpl.lstat)
		throw new TopicRegistryDurabilityUnavailableError(
			new Error("topic registry persistence requires no-follow file identity"),
		);
	const before = await fsImpl.lstat(file, { bigint: true });
	const bytes = await fsImpl.readFile(file, "utf8");
	const after = await fsImpl.lstat(file, { bigint: true });
	const parentStat = await fsImpl.lstat(path.dirname(file), { bigint: true });
	if (!before.isFile() || !after.isFile() || before.nlink !== 1n || !sameExactFileStat(before, after))
		throw new TopicRegistryDurabilityUnavailableError(
			new Error("topic registry persistence requires a stable single-link regular file"),
		);
	return {
		bytes,
		identity: {
			dev: after.dev,
			ino: after.ino,
			nlink: after.nlink,
			parentDev: parentStat.dev,
			parentIno: parentStat.ino,
			size: after.size,
			mtimeNs: after.mtimeNs,
			sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
		},
	};
}
async function captureTopicRegistryDestination(
	fsImpl: TelegramDaemonFs,
	file: string,
	platform: NodeJS.Platform,
): Promise<NativeExactFileIdentity | undefined> {
	if (platform !== "win32") return undefined;
	try {
		return (await captureExactFileSnapshot(fsImpl, file)).identity;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Publish topic authority only after its staged bytes and replacement are durable. */
export async function writeTopicRegistryAtomic(
	fsImpl: TelegramDaemonFs,
	file: string,
	data: unknown,
	platform: NodeJS.Platform = process.platform,
	exactReplace: TopicRegistryExactReplace = exactReplacePath,
	expectedDestination?: NativeExactFileIdentity,
): Promise<void> {
	if (!fsImpl.fsyncFile)
		throw new TopicRegistryDurabilityUnavailableError(
			new Error("topic registry persistence requires file fsync crash-atomicity"),
		);
	if (platform !== "win32" && !fsImpl.fsyncDirectory)
		throw new TopicRegistryDurabilityUnavailableError(
			new Error("topic registry persistence requires directory fsync crash-atomicity"),
		);
	const parent = path.dirname(file);
	const serialized = `${JSON.stringify(data, null, 2)}\n`;
	let destinationExists = true;
	try {
		await fsImpl.readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		destinationExists = false;
	}
	if (!destinationExists && expectedDestination)
		throw new TopicRegistryDurabilityUnavailableError(
			new Error("topic registry destination disappeared after generation validation"),
		);
	if (!destinationExists) {
		try {
			await fsImpl.writeFile(file, serialized, { mode: 0o600, flag: "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST")
				throw new TopicRegistryDurabilityUnavailableError(
					new Error("topic registry appeared during exclusive creation"),
				);
			throw error;
		}
		await fsImpl.chmod(file, 0o600).catch(() => undefined);
		await fsImpl.fsyncFile(file);
		if (platform !== "win32") await fsImpl.fsyncDirectory!(parent);
		const written = await fsImpl.readFile(file, "utf8");
		if (written !== serialized)
			throw new TopicRegistryDurabilityUnavailableError(
				new Error("exclusive topic registry creation verification failed"),
			);
		return;
	}

	const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		await fsImpl.writeFile(tmp, serialized, { mode: 0o600, flag: "wx" });
		await fsImpl.chmod(tmp, 0o600).catch(() => undefined);
		await fsImpl.fsyncFile(tmp);
		if (platform === "win32") {
			if (typeof exactReplace !== "function")
				throw new TopicRegistryDurabilityUnavailableError(
					new Error("native Windows exact replacement is unavailable"),
				);
			if (!expectedDestination)
				throw new TopicRegistryDurabilityUnavailableError(
					new Error("native Windows replacement requires the validated destination identity"),
				);
			const expectedSource = (await captureExactFileSnapshot(fsImpl, tmp)).identity;
			const outcome = exactReplace(tmp, file, expectedSource, expectedDestination);
			if (!outcome.ok)
				throw new TopicRegistryDurabilityUnavailableError(
					new Error(`native Windows topic replacement failed: ${outcome.code ?? "unknown"}`),
				);
		} else {
			await fsImpl.rename(tmp, file);
			await fsImpl.fsyncDirectory!(parent);
		}
		const written = await fsImpl.readFile(file, "utf8");
		if (written !== serialized)
			throw new TopicRegistryDurabilityUnavailableError(new Error("topic registry replacement verification failed"));
	} catch (error) {
		await fsImpl.unlink(tmp).catch(() => undefined);
		throw error;
	}
}
/**
 * Shared-volume topic authority backed by the existing cross-process file lock.
 * A missing authority is the only valid bootstrap state; malformed and future
 * snapshots are never interpreted as empty state.
 */
export class FilesystemTopicRegistryCasAuthority implements TopicRegistryCasAuthority {
	private readonly fsImpl: TelegramDaemonFs;
	private readonly platform: NodeJS.Platform;
	private readonly exactReplace: TopicRegistryExactReplace;
	private readonly installationHostId: string;

	constructor(
		private readonly file: string,
		input: {
			installationHostId: string;
			fs?: TelegramDaemonFs;
			platform?: NodeJS.Platform;
			exactReplace?: TopicRegistryExactReplace;
		},
	) {
		if (!input.installationHostId) throw new Error("installationHostId must be non-empty");
		this.installationHostId = input.installationHostId;
		this.fsImpl = input.fs ?? nodeFs;
		this.platform = input.platform ?? process.platform;
		this.exactReplace = input.exactReplace ?? exactReplacePath;
	}

	async read(): Promise<TopicRegistryState> {
		return await withFileLock(this.file, async () => await this.readLocked(), {
			staleMs: 10_000,
			ownerHostId: this.installationHostId,
		});
	}

	async compareAndSet(expectedGeneration: number, next: TopicRegistryState): Promise<boolean> {
		if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0)
			throw new Error("invalid expected topic registry generation");
		if (
			next.version !== 2 ||
			next.registryGeneration !== expectedGeneration + 1 ||
			parseTopicRegistryState(next) === undefined
		)
			throw new Error("invalid next topic registry generation");
		return await withFileLock(
			this.file,
			async () => {
				const { state: current, legacyRaw, expectedDestination } = await this.#readLockedWithLegacy();
				if (current.registryGeneration !== expectedGeneration) return false;
				await ensureDir(this.fsImpl, path.dirname(this.file));
				if (legacyRaw !== undefined) await this.#quarantineLegacyLocked(legacyRaw);
				await writeTopicRegistryAtomic(
					this.fsImpl,
					this.file,
					next,
					this.platform,
					this.exactReplace,
					expectedDestination,
				);
				return true;
			},
			{ staleMs: 10_000, ownerHostId: this.installationHostId },
		);
	}

	private async readLocked(): Promise<TopicRegistryState> {
		return (await this.#readLockedWithLegacy()).state;
	}

	async #readLockedWithLegacy(): Promise<{
		state: TopicRegistryState;
		legacyRaw?: unknown;
		expectedDestination?: NativeExactFileIdentity;
	}> {
		let raw: unknown;
		let expectedDestination: NativeExactFileIdentity | undefined;
		try {
			if (this.platform === "win32") {
				const snapshot = await captureExactFileSnapshot(this.fsImpl, this.file);
				raw = JSON.parse(snapshot.bytes);
				expectedDestination = snapshot.identity;
			} else {
				raw = JSON.parse(await this.fsImpl.readFile(this.file, "utf8"));
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return { state: { version: 2, registryGeneration: 0, topics: {} } };
			throw new Error("shared topic authority is malformed or unavailable");
		}
		const legacyRaw =
			raw && typeof raw === "object" && !Array.isArray(raw) && !Object.hasOwn(raw as object, "version")
				? raw
				: undefined;
		const state = parseTopicRegistryState(raw);
		const generation = state?.registryGeneration;
		if (state?.version !== 2 || generation === undefined || !Number.isSafeInteger(generation) || generation < 0)
			throw new Error("shared topic authority is malformed or unsupported");
		return {
			state: { ...state, registryGeneration: generation },
			...(legacyRaw === undefined ? {} : { legacyRaw }),
			...(expectedDestination === undefined ? {} : { expectedDestination }),
		};
	}

	async #quarantineLegacyLocked(raw: unknown): Promise<void> {
		const digest = crypto.createHash("sha256").update(JSON.stringify(raw)).digest("hex");
		const quarantinePath = `${this.file}.legacy-quarantine.${digest}.json`;
		try {
			await this.fsImpl.readFile(quarantinePath, "utf8");
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				throw new Error("shared topic authority is malformed or unavailable");
		}
		await writeTopicRegistryAtomic(this.fsImpl, quarantinePath, raw, this.platform, this.exactReplace);
	}
}

export interface MachineIdentityDeps {
	platform?: NodeJS.Platform;
	readFile?: (file: string) => Promise<string>;
	runCommand?: (command: string, args: readonly string[]) => { exitCode: number; stdout: Uint8Array };
}

function normalizedMachineIdentity(value: string, pattern: RegExp): string | undefined {
	const normalized = value.trim().toLowerCase();
	if (!pattern.test(normalized) || /^0+$/.test(normalized.replace(/-/g, ""))) return undefined;
	return normalized;
}

/** @internal */
export function parseWindowsMachineGuid(output: string): string | undefined {
	const match = /^\s*MachineGuid\s+REG_\w+\s+(\S+)\s*$/im.exec(output);
	return match
		? normalizedMachineIdentity(match[1], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
		: undefined;
}

/** @internal */
export function parseMacPlatformUuid(output: string): string | undefined {
	const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(output);
	return match
		? normalizedMachineIdentity(match[1], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
		: undefined;
}

function hashMachineIdentity(rawId: string): string {
	return crypto
		.createHash("sha256")
		.update("gajae-code:telegram-daemon:machine-identity:v1\0")
		.update(rawId)
		.digest("hex");
}

/** Loads a verified machine-local identity without persisting the underlying machine ID. */
export async function loadInstallationHostId(deps: MachineIdentityDeps = {}): Promise<string> {
	const platform = deps.platform ?? process.platform;
	const readFile = deps.readFile ?? (async (file: string) => await fs.promises.readFile(file, "utf8"));
	const runCommand =
		deps.runCommand ??
		((command: string, args: readonly string[]) =>
			Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "ignore" }));

	let rawId: string | undefined;
	if (platform === "linux") {
		for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
			try {
				const value = normalizedMachineIdentity(await readFile(file), /^[0-9a-f]{32}$/);
				if (!value) throw new Error("machine-local identity is unavailable or malformed");
				rawId = value;
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	} else if (platform === "win32") {
		const result = runCommand("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
		if (result.exitCode === 0) rawId = parseWindowsMachineGuid(new TextDecoder().decode(result.stdout));
	} else if (platform === "darwin") {
		const result = runCommand("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
		if (result.exitCode === 0) rawId = parseMacPlatformUuid(new TextDecoder().decode(result.stdout));
	} else {
		throw new Error(`machine-local identity is unsupported on ${platform}`);
	}

	if (!rawId) throw new Error("machine-local identity is unavailable or malformed");
	return hashMachineIdentity(rawId);
}

function validDaemonPid(pid: unknown): pid is number {
	return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

export async function tryCreateOwnershipLock(
	fsImpl: TelegramDaemonFs,
	file: string,
	initialization: OwnershipLockMetadata,
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

type OwnershipLockMetadata = {
	pid: number;
	incarnation: string;
	ownerId?: string;
	acquisitionId?: string;
	startedAt: number;
};
type LegacyOwnershipLockMetadata = {
	pid: number;
	incarnation?: string;
	startedAt: number;
};
type V010OwnershipLockMetadata = {
	size: 0;
	mtimeMs?: number;
	dev?: number;
	ino?: number;
	ctimeMs?: number;
};
type OwnershipLockRead =
	| { kind: "missing" }
	| { kind: "malformed"; raw: string; mtimeMs?: number }
	| { kind: "v010"; metadata: V010OwnershipLockMetadata }
	| { kind: "legacy"; metadata: LegacyOwnershipLockMetadata }
	| { kind: "valid"; metadata: OwnershipLockMetadata };

/** Read lock provenance without treating a corrupt legacy artifact as a filesystem failure. */
export async function readOwnershipLock(fsImpl: TelegramDaemonFs, file: string): Promise<OwnershipLockRead> {
	let raw: string;
	try {
		raw = await fsImpl.readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		throw error;
	}
	if (raw.length === 0) {
		const stat = await fsImpl.stat?.(file).catch(() => undefined);
		if (stat?.size !== 0) return { kind: "malformed", raw, mtimeMs: stat?.mtimeMs };
		return {
			kind: "v010",
			metadata: {
				size: 0,
				...(stat?.mtimeMs === undefined ? {} : { mtimeMs: stat.mtimeMs }),
				...(stat?.dev === undefined ? {} : { dev: stat.dev }),
				...(stat?.ino === undefined ? {} : { ino: stat.ino }),
				...(stat?.ctimeMs === undefined ? {} : { ctimeMs: stat.ctimeMs }),
			},
		};
	}
	try {
		const value = JSON.parse(raw) as Partial<OwnershipLockMetadata>;
		const pid = value.pid;
		const startedAt = value.startedAt;
		if (validDaemonPid(pid) && typeof startedAt === "number" && Number.isSafeInteger(startedAt)) {
			if (isProcessIncarnation(value.incarnation))
				return {
					kind: "valid",
					metadata: {
						pid,
						incarnation: value.incarnation,
						...(typeof value.ownerId === "string" && value.ownerId.length > 0 ? { ownerId: value.ownerId } : {}),
						...(typeof value.acquisitionId === "string" && value.acquisitionId.length > 0
							? { acquisitionId: value.acquisitionId }
							: {}),
						startedAt,
					},
				};
			return { kind: "legacy", metadata: { pid, startedAt } };
		}
	} catch {}
	const mtimeMs = await fsImpl
		.stat?.(file)
		.then(stat => stat.mtimeMs)
		.catch(() => undefined);
	return { kind: "malformed", raw, ...(mtimeMs === undefined ? {} : { mtimeMs }) };
}

/**
 * A live initializer lock only proves that a concurrent publisher is active.
 * It never proves a ready daemon: legacy or unavailable provenance remains
 * blocked, while a canonical mismatch proves PID reuse and can be reclaimed
 * under the transition lock.
 */
export function liveOwnershipLockDecision(input: {
	lock: OwnershipLockRead;
	pidAlive: (pid: number) => boolean;
	pidIncarnation: (pid: number) => string | undefined;
}):
	| { acquired: false; attached: false; blocked: true }
	| { acquired: false; attached: false; provisional: true }
	| undefined {
	if (input.lock.kind === "v010") return { acquired: false, attached: false, blocked: true };
	if (input.lock.kind !== "valid" && input.lock.kind !== "legacy") return undefined;
	if (!input.pidAlive(input.lock.metadata.pid)) return undefined;
	if (input.lock.kind === "legacy") {
		if (!isProcessIncarnation(input.lock.metadata.incarnation))
			return { acquired: false, attached: false, blocked: true };
		const current = input.pidIncarnation(input.lock.metadata.pid);
		if (!isProcessIncarnation(current)) return { acquired: false, attached: false, blocked: true };
		if (current !== input.lock.metadata.incarnation) return undefined;
		return { acquired: false, attached: false, blocked: true };
	}
	const current = input.pidIncarnation(input.lock.metadata.pid);
	if (!isProcessIncarnation(current)) return { acquired: false, attached: false, blocked: true };
	if (current !== input.lock.metadata.incarnation) return undefined;
	return { acquired: false, attached: false, provisional: true };
}

function ownershipLockMatches(left: OwnershipLockRead, right: OwnershipLockRead): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "missing") return true;
	if (left.kind === "malformed" && right.kind === "malformed")
		return left.raw === right.raw && left.mtimeMs !== undefined && left.mtimeMs === right.mtimeMs;
	if ((left.kind === "legacy" && right.kind === "legacy") || (left.kind === "v010" && right.kind === "v010"))
		return JSON.stringify(left.metadata) === JSON.stringify(right.metadata);
	if (left.kind !== "valid" || right.kind !== "valid") return false;
	return JSON.stringify(left.metadata) === JSON.stringify(right.metadata);
}

function ownershipLockMatchesState(lock: OwnershipLockRead, state: DaemonState | undefined): boolean {
	return Boolean(
		lock.kind === "valid" &&
			state &&
			lock.metadata.ownerId === state.ownerId &&
			lock.metadata.acquisitionId === state.acquisitionId &&
			lock.metadata.pid === state.pid &&
			lock.metadata.incarnation === state.incarnation,
	);
}

type OwnerHeartbeatSidecar = {
	pid: number;
	incarnation: string;
	ownerId: string;
	acquisitionId: string;
	heartbeatAt: number;
};

function ownerTagFromState(
	state: DaemonState | undefined,
): Pick<OwnerHeartbeatSidecar, "pid" | "incarnation" | "ownerId" | "acquisitionId"> | undefined {
	if (
		!state ||
		!hasSafeDaemonStateShape(state) ||
		state.stoppedAt !== undefined ||
		!state.ownerId ||
		!state.acquisitionId
	)
		return undefined;
	return {
		pid: state.pid,
		incarnation: state.incarnation,
		ownerId: state.ownerId,
		acquisitionId: state.acquisitionId,
	};
}

function sidecarMatchesOwnerTag(
	sidecar: OwnerHeartbeatSidecar | undefined,
	tag: Pick<OwnerHeartbeatSidecar, "pid" | "incarnation" | "ownerId" | "acquisitionId"> | undefined,
): sidecar is OwnerHeartbeatSidecar {
	return Boolean(
		sidecar &&
			tag &&
			validDaemonPid(sidecar.pid) &&
			isProcessIncarnation(sidecar.incarnation) &&
			typeof sidecar.ownerId === "string" &&
			typeof sidecar.acquisitionId === "string" &&
			Number.isSafeInteger(sidecar.heartbeatAt) &&
			sidecar.pid === tag.pid &&
			sidecar.incarnation === tag.incarnation &&
			sidecar.ownerId === tag.ownerId &&
			sidecar.acquisitionId === tag.acquisitionId,
	);
}

/**
 * A corrupt, truncated, or otherwise unreadable sidecar must never break a
 * freshness read: the sidecar is advisory-only, so any read/parse failure
 * degrades to "no sidecar" (state-floor freshness), never a throw.
 */
async function readSidecarLenient(fsImpl: TelegramDaemonFs, file: string): Promise<OwnerHeartbeatSidecar | undefined> {
	try {
		const parsed: unknown = JSON.parse(await fsImpl.readFile(file, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as OwnerHeartbeatSidecar)
			: undefined;
	} catch {
		return undefined;
	}
}

export interface OwnerFreshnessSnapshot {
	ownerTag: Pick<OwnerHeartbeatSidecar, "pid" | "incarnation" | "ownerId" | "acquisitionId"> | null;
	effectiveHeartbeatAt: number | undefined;
	legacyEmbedded: boolean;
	state: DaemonState | undefined;
}

export async function readOwnerFreshnessSnapshot(input: {
	settings: Settings;
	fs?: TelegramDaemonFs;
}): Promise<OwnerFreshnessSnapshot> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	const state = await readJson<DaemonState>(fsImpl, paths.state);
	const legacyEmbedded = Boolean(
		state && (isGenerationAbsentParentDaemonState(state) || isGeneration3ReleaseDaemonState(state)),
	);
	const tag = ownerTagFromState(state);
	const lock = await readOwnershipLock(fsImpl, paths.lock);
	const ownerTag = tag && ownershipLockMatchesState(lock, state) ? tag : null;
	if (legacyEmbedded) return { ownerTag, effectiveHeartbeatAt: state?.heartbeatAt, legacyEmbedded, state };
	const sidecar = await readSidecarLenient(fsImpl, paths.heartbeat);
	const rereadState = await readJson<DaemonState>(fsImpl, paths.state);
	const rereadLock = await readOwnershipLock(fsImpl, paths.lock);
	const rereadTag = ownerTagFromState(rereadState);
	const stableTag = rereadTag && ownershipLockMatchesState(rereadLock, rereadState) ? rereadTag : null;
	const stable =
		ownerTag && stableTag && sidecarMatchesOwnerTag({ ...ownerTag, heartbeatAt: 0 }, stableTag) ? stableTag : null;
	const effectiveHeartbeatAt = stable
		? sidecarMatchesOwnerTag(sidecar, stable)
			? Math.max(rereadState?.heartbeatAt ?? 0, sidecar.heartbeatAt)
			: rereadState?.heartbeatAt
		: undefined;
	return {
		ownerTag: stable,
		effectiveHeartbeatAt,
		legacyEmbedded: false,
		state: rereadState,
	};
}

/** Marker-free steady heartbeat renewal. The final lock reread fences a stale writer. */
export async function renewOwnerHeartbeatSidecar(input: {
	settings: Settings;
	ownerId: string;
	acquisitionId?: string;
	fs?: TelegramDaemonFs;
	now?: () => number;
	pid?: number;
	pidIncarnation?: (pid: number) => string | undefined;
}): Promise<boolean> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	const state = await readJson<DaemonState>(fsImpl, paths.state);
	const pid = input.pid ?? state?.pid;
	const incarnation = (input.pidIncarnation ?? defaultPidIncarnation)(pid ?? 0);
	const acquisitionId = input.acquisitionId ?? input.ownerId;
	if (
		!state ||
		!validDaemonPid(pid) ||
		!isProcessIncarnation(incarnation) ||
		state.pid !== pid ||
		state.incarnation !== incarnation ||
		state.ownerId !== input.ownerId ||
		state.acquisitionId !== acquisitionId ||
		state.stoppedAt !== undefined
	)
		return false;
	const sidecar: OwnerHeartbeatSidecar = {
		pid,
		incarnation,
		ownerId: input.ownerId,
		acquisitionId,
		heartbeatAt: (input.now ?? Date.now)(),
	};
	const tmp = `${paths.heartbeat}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	await fsImpl.writeFile(tmp, `${JSON.stringify(sidecar, null, 2)}\n`, { mode: 0o600 });
	await fsImpl.chmod(tmp, 0o600).catch(() => undefined);
	const lock = await readOwnershipLock(fsImpl, paths.lock);
	if (!ownershipLockMatchesState(lock, state)) {
		await fsImpl.unlink(tmp).catch(() => undefined);
		return false;
	}
	// Revalidate the exact lock after the temporary sidecar exists so a stale
	// writer cannot publish after ownership moved during its write.
	const finalLock = await readOwnershipLock(fsImpl, paths.lock);
	if (!ownershipLockMatchesState(finalLock, state)) {
		await fsImpl.unlink(tmp).catch(() => undefined);
		return false;
	}
	await fsImpl.rename(tmp, paths.heartbeat);
	return true;
}

function ownershipLockMatchesStoppedState(
	lock: OwnershipLockRead,
	state: unknown,
	pidAlive: (pid: number) => boolean,
): boolean {
	if (isExplicitlyStoppedDaemonState(state)) return ownershipLockMatchesState(lock, state);
	if (!isLegacyStoppedDaemonState(state)) return false;
	const legacyState = state as Pick<DaemonState, "pid" | "startedAt" | "generation"> & { stoppedAt: number };
	if (lock.kind === "v010")
		return (
			legacyState.generation === 3 &&
			!pidAlive(legacyState.pid) &&
			lock.metadata.mtimeMs !== undefined &&
			lock.metadata.mtimeMs <= legacyState.stoppedAt
		);
	if (lock.kind !== "legacy") return false;
	return (
		lock.metadata.pid === legacyState.pid &&
		lock.metadata.startedAt <= legacyState.startedAt &&
		legacyState.startedAt <= legacyState.stoppedAt
	);
}

async function transitionLockIsHeldByCaller(input: {
	fs: TelegramDaemonFs;
	path: string;
	lock: DaemonTransitionLock;
}): Promise<boolean> {
	return await daemonTransitionLockIsHeld(input);
}

function ownershipLockMatchesMetadata(lock: OwnershipLockRead, metadata: OwnershipLockMetadata): boolean {
	return lock.kind === "valid" && JSON.stringify(lock.metadata) === JSON.stringify(metadata);
}

/**
 * Accept an exact unlink only when it either completed or returned typed
 * retained authority — a concrete detached quarantine plus a proven-absent
 * canonical pathname. Anything else stays fail-closed.
 */
async function exactUnlinkAcceptedWithRetainedEvidence(
	fsImpl: TelegramDaemonFs,
	file: string,
	identity: NotificationEndpointFileIdentity,
	quarantineName?: string,
): Promise<boolean> {
	const removed = await fsImpl.exactUnlink!(file, identity, quarantineName);
	if (removed.ok) return true;
	return (
		removed.code === "cleanup_pending" &&
		typeof removed.detachedPath === "string" &&
		removed.detachedPath.length > 0 &&
		(await fsImpl.readEndpointFile!(file).catch(() => undefined)) === undefined
	);
}

type NotificationArtifactReapOutcome = "removed" | "retained" | "unchanged";

/** Distinguish terminal removal from a safely detached artifact that still needs authority-preserving cleanup. */
async function reapNotificationArtifactExactly(
	fsImpl: TelegramDaemonFs,
	file: string,
	identity: NotificationEndpointFileIdentity,
	quarantineName: string,
): Promise<NotificationArtifactReapOutcome> {
	const removed = await fsImpl.exactUnlink!(file, identity, quarantineName);
	if (removed.ok) return "removed";
	if (
		removed.code === "cleanup_pending" &&
		typeof removed.detachedPath === "string" &&
		removed.detachedPath.length > 0 &&
		(await fsImpl.readEndpointFile!(file).catch(() => undefined)) === undefined
	)
		return "retained";
	return "unchanged";
}

async function unlinkOwnershipLockExactly(
	fsImpl: TelegramDaemonFs,
	file: string,
	expected: OwnershipLockRead,
): Promise<boolean> {
	if (expected.kind === "missing" || !fsImpl.readEndpointFile || !fsImpl.exactUnlink) return false;
	const endpoint = await fsImpl.readEndpointFile(file).catch(() => undefined);
	if (!endpoint || !ownershipLockMatches(expected, await readOwnershipLock(fsImpl, file))) return false;
	return await exactUnlinkAcceptedWithRetainedEvidence(fsImpl, file, endpoint.identity);
}

/**
 * Replace an acquisition's lease only after proving the old lease is unchanged.
 * The transition fence serializes lifecycle writers; the exact read-back prevents
 * a stale binder from overwriting a newer owner if that fence is lost.
 */
async function rebindOwnershipLock(input: {
	fs: TelegramDaemonFs;
	path: string;
	transitionPath: string;
	transition: DaemonTransitionLock;
	expected: OwnershipLockMetadata;
	rebound: OwnershipLockMetadata;
}): Promise<boolean> {
	if (!(await transitionLockIsHeldByCaller({ fs: input.fs, path: input.transitionPath, lock: input.transition })))
		return false;
	if (!ownershipLockMatchesMetadata(await readOwnershipLock(input.fs, input.path), input.expected)) return false;
	if (!(await transitionLockIsHeldByCaller({ fs: input.fs, path: input.transitionPath, lock: input.transition })))
		return false;
	try {
		await writeJsonAtomic(input.fs, input.path, input.rebound);
	} catch {
		return false;
	}
	return (
		(await transitionLockIsHeldByCaller({ fs: input.fs, path: input.transitionPath, lock: input.transition })) &&
		ownershipLockMatchesMetadata(await readOwnershipLock(input.fs, input.path), input.rebound)
	);
}

/** Restore the launcher lease only when the failed binder still owns the child lease. */
async function rollbackOwnershipLockRebind(input: {
	fs: TelegramDaemonFs;
	path: string;
	transitionPath: string;
	transition: DaemonTransitionLock;
	previous: OwnershipLockMetadata;
	rebound: OwnershipLockMetadata;
}): Promise<boolean> {
	if (!(await transitionLockIsHeldByCaller({ fs: input.fs, path: input.transitionPath, lock: input.transition })))
		return false;
	if (!ownershipLockMatchesMetadata(await readOwnershipLock(input.fs, input.path), input.rebound)) return false;
	if (!(await transitionLockIsHeldByCaller({ fs: input.fs, path: input.transitionPath, lock: input.transition })))
		return false;
	try {
		await writeJsonAtomic(input.fs, input.path, input.previous);
	} catch {
		return false;
	}
	return (
		(await transitionLockIsHeldByCaller({ fs: input.fs, path: input.transitionPath, lock: input.transition })) &&
		ownershipLockMatchesMetadata(await readOwnershipLock(input.fs, input.path), input.previous)
	);
}

async function ownershipLockIsReclaimable(input: {
	fs: TelegramDaemonFs;
	path: string;
	lock: OwnershipLockRead;
	now: number;
	pidAlive: (pid: number) => boolean;
	pidIncarnation: (pid: number) => string | undefined;
}): Promise<boolean> {
	if (input.lock.kind === "missing") return true;
	if (input.lock.kind === "v010") return false;
	if (input.lock.kind === "malformed") {
		if (!input.fs.stat) return false;
		const stat = await input.fs.stat(input.path).catch(() => undefined);
		return stat !== undefined && input.now - stat.mtimeMs > HEARTBEAT_TTL_MS;
	}
	if (!input.pidAlive(input.lock.metadata.pid)) return true;
	const current = input.pidIncarnation(input.lock.metadata.pid);
	return (
		isProcessIncarnation(input.lock.metadata.incarnation) &&
		isProcessIncarnation(current) &&
		current !== input.lock.metadata.incarnation
	);
}

export interface NotificationRootRegistration {
	root?: string;
	managed?: boolean;
	token?: string;
}

export async function readNotificationRootRegistration(input: {
	settings: Settings;
	sessionId: string;
	fs?: TelegramDaemonFs;
}): Promise<NotificationRootRegistration> {
	const fsImpl = input.fs ?? nodeFs;
	const current = await readJson<{
		sessions?: Record<string, string>;
		managedRoots?: string[];
		registrationTokens?: Record<string, string>;
	}>(fsImpl, daemonPaths(input.settings.getAgentDir()).roots);
	const root = current?.sessions?.[input.sessionId];
	return {
		root,
		managed: root !== undefined && current?.managedRoots?.includes(root) === true,
		token: current?.registrationTokens?.[input.sessionId],
	};
}

/** Restore a session root only if this ensure operation still owns its registration. */
async function restoreNotificationRootRegistration(input: {
	settings: Settings;
	sessionId: string;
	registeredRoot: string;
	/** Token minted by this operation's own registration; a newer replacement registration's token fences the rollback. */
	registeredToken?: string;
	previous: NotificationRootRegistration;
	fs?: TelegramDaemonFs;
}): Promise<void> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	await ensureDir(fsImpl, paths.dir);
	await withFileLock(
		paths.roots,
		async () => {
			const current =
				(await readJson<{
					roots?: string[];
					managedRoots?: string[];
					sessions?: Record<string, string>;
					registrationTokens?: Record<string, string>;
				}>(fsImpl, paths.roots)) ?? {};
			const sessions = { ...(current.sessions ?? {}) };
			if (sessions[input.sessionId] !== input.registeredRoot) return;
			if (
				current.registrationTokens?.[input.sessionId] !== undefined &&
				current.registrationTokens[input.sessionId] !== input.registeredToken
			)
				return;
			const registrationTokens = { ...(current.registrationTokens ?? {}) };
			if (input.previous.root) sessions[input.sessionId] = input.previous.root;
			else delete sessions[input.sessionId];
			if (input.previous.token !== undefined) registrationTokens[input.sessionId] = input.previous.token;
			else delete registrationTokens[input.sessionId];
			const referencedRoots = new Set(Object.values(sessions));
			const roots = new Set(current.roots ?? []);
			const managedRoots = new Set(current.managedRoots ?? []);
			if (input.previous.root) {
				roots.add(input.previous.root);
				if (input.previous.managed) managedRoots.add(input.previous.root);
				else managedRoots.delete(input.previous.root);
			}
			if (managedRoots.has(input.registeredRoot) && !referencedRoots.has(input.registeredRoot)) {
				roots.delete(input.registeredRoot);
				managedRoots.delete(input.registeredRoot);
			}
			await writeJsonAtomic(fsImpl, paths.roots, {
				version: 1,
				roots: Array.from(roots).sort(),
				managedRoots: Array.from(managedRoots).sort(),
				sessions,
				registrationTokens,
			});
		},
		{ staleMs: 10_000 },
	);
}

export interface RegisterNotificationRootResult {
	root: string;
	/** Per-registration ownership token fencing a stale same-session cleanup from deleting a live replacement registration. */
	token: string;
}

export async function registerNotificationRoot(input: {
	settings: Settings;
	cwd: string;
	sessionId: string;
	fs?: TelegramDaemonFs;
}): Promise<RegisterNotificationRootResult> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	await ensureDir(fsImpl, paths.dir);
	const root = notificationRootForCwd(input.cwd);
	const token = crypto.randomUUID();
	await withFileLock(
		paths.roots,
		async () => {
			const current =
				(await readJson<{
					roots?: string[];
					managedRoots?: string[];
					sessions?: Record<string, string>;
					registrationTokens?: Record<string, string>;
				}>(fsImpl, paths.roots)) ?? {};
			const roots = new Set(current.roots ?? []);
			const managedRoots = new Set(current.managedRoots ?? []);
			const sessions = { ...(current.sessions ?? {}) };
			const registrationTokens = { ...(current.registrationTokens ?? {}) };
			const previousRoot = sessions[input.sessionId];
			const rootAlreadyPresent = roots.has(root);
			roots.add(root);
			// Roots present before session registration are legacy/unmanaged and must
			// survive a later session rollback or unregister.
			if (!rootAlreadyPresent) managedRoots.add(root);
			sessions[input.sessionId] = root;
			registrationTokens[input.sessionId] = token;
			if (previousRoot && previousRoot !== root && managedRoots.has(previousRoot)) {
				const previousStillReferenced = Object.values(sessions).includes(previousRoot);
				if (!previousStillReferenced) {
					roots.delete(previousRoot);
					managedRoots.delete(previousRoot);
				}
			}
			await writeJsonAtomic(fsImpl, paths.roots, {
				version: 1,
				roots: Array.from(roots).sort(),
				managedRoots: Array.from(managedRoots).sort(),
				sessions,
				registrationTokens,
			});
		},
		ROOTS_REGISTRATION_LOCK_OPTIONS,
	);
	return { root, token };
}

export interface UnregisterNotificationRootResult {
	root: string;
	remainingRoots: number;
	/** Opaque fingerprint of the exact registry written by this successful unregister. */
	registryFingerprint?: string;
}

/** Remove one session's Telegram scan root without disturbing other live session roots. */
export async function unregisterNotificationRoot(input: {
	settings: Settings;
	cwd: string;
	sessionId: string;
	fs?: TelegramDaemonFs;
	/** Ownership token minted by this runtime's own registration; a stale cleanup presenting an older token never deletes a replacement registration. */
	registrationToken?: string;
}): Promise<UnregisterNotificationRootResult> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	const root = notificationRootForCwd(input.cwd);
	await ensureDir(fsImpl, paths.dir);
	let remainingRoots = 0;
	let registryFingerprint: string | undefined;
	await withFileLock(
		paths.roots,
		async () => {
			const current = await readJson<NotificationRootsRegistry>(fsImpl, paths.roots);
			if (!current) return;
			const sessions = { ...(current.sessions ?? {}) };
			// A stale cleanup from a previous registration must not remove a newer
			// registration for the same session under a different root.
			if (sessions[input.sessionId] !== root) {
				remainingRoots = (current.roots ?? []).length;
				return;
			}
			// Same sessionId + same cwd re-registration records an identical root, so
			// the root match alone cannot distinguish a replaced registration. Any
			// token-bearing registration requires the caller to present that exact token;
			// only genuinely legacy token-less rows retain root-match cleanup behavior.
			const recordedToken = current.registrationTokens?.[input.sessionId];
			if (recordedToken !== undefined && recordedToken !== input.registrationToken) {
				logger.warn("notifications: fenced stale Telegram root unregister against a live replacement registration");
				remainingRoots = (current.roots ?? []).length;
				return;
			}
			delete sessions[input.sessionId];
			const registrationTokens = { ...(current.registrationTokens ?? {}) };
			delete registrationTokens[input.sessionId];
			const rootStillReferenced = Object.values(sessions).includes(root);
			const managedRoots = new Set(current.managedRoots ?? []);
			const roots = (current.roots ?? []).filter(
				candidate => candidate !== root || rootStillReferenced || !managedRoots.has(root),
			);
			if (!rootStillReferenced) managedRoots.delete(root);
			remainingRoots = roots.length;
			const nextRegistry: NotificationRootsRegistry = {
				version: 1,
				roots: Array.from(new Set(roots)).sort(),
				managedRoots: Array.from(managedRoots).sort(),
				sessions,
				registrationTokens,
			};
			await writeJsonAtomic(fsImpl, paths.roots, nextRegistry);
			registryFingerprint = notificationRootRegistryFingerprint(nextRegistry);
		},
		{ staleMs: 10_000 },
	);
	return registryFingerprint === undefined ? { root, remainingRoots } : { root, remainingRoots, registryFingerprint };
}

/** Run an action while the roots registry lock excludes any registration or unregister. */
export async function withNotificationRootRegistryFence(input: {
	settings: Settings;
	registryFingerprint: string;
	action: () => Promise<void>;
	fs?: TelegramDaemonFs;
}): Promise<boolean> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	await ensureDir(fsImpl, paths.dir);
	return await withFileLock(
		paths.roots,
		async () => {
			const current = await readJson<NotificationRootsRegistry>(fsImpl, paths.roots);
			if (
				!current ||
				(current.roots ?? []).length !== 0 ||
				notificationRootRegistryFingerprint(current) !== input.registryFingerprint
			)
				return false;
			await input.action();
			return true;
		},
		{ staleMs: 10_000 },
	);
}

function notificationRootForCwd(cwd: string): string {
	return path.join(cwd, ".gjc", "state");
}

/**
 * Leak artifact prefixes left when native exact-unlink cleanup is retained
 * (#2956). Nothing previously reaped these; they accumulate in the notifications
 * directory across ownership transitions.
 */
export const NOTIFICATION_LEAK_ARTIFACT_PREFIXES = [
	".gjc-delete-daemon-transition-",
	".gjc-exact-unlink-placeholder-",
	".gjc-delete-notification-endpoint-",
	".gjc-delete-notification-staging-temp-",
] as const;

/** Grace window before a leak artifact is reaped (covers in-flight unlinks). */
export const NOTIFICATION_LEAK_ARTIFACT_GRACE_MS = 5 * 60_000;

/** True when a path is permanently gone (not a transient I/O blip). */
export function isPermanentMissingPathError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Shape of an abandoned `writeJsonAtomic` staging file:
 * `<published-name>.<pid>.<epoch-ms>.<base36-suffix>.tmp`.
 *
 * Publication stages a sibling temp and then renames it over the destination.
 * If the staging write or the rename fails, or the process dies between the
 * two, that temp is never published and never read again — no prefix in
 * {@link NOTIFICATION_LEAK_ARTIFACT_PREFIXES} claimed it, so it accumulated in
 * the agent notifications directory permanently, once per failed attempt.
 *
 * Reaping it here (rather than only unwinding in the writer) also reclaims
 * temps orphaned by a crash or power loss, which no writer-side cleanup can
 * reach. Age alone is not proof of abandonment, though: a slow or blocked
 * publisher (a stalled network write, a rename fenced by an antivirus handle)
 * can hold a live staged temp well past any grace window. The staged name
 * therefore carries its publisher's PID, and the reaper only removes a temp
 * whose publisher is provably dead — see {@link parseNotificationStagingTemp}.
 */
const NOTIFICATION_STAGING_TEMP_PATTERN = /^(?<destination>.+)\.(?<pid>\d+)\.(?<stagedAt>\d+)\.[0-9a-z]+\.tmp$/;

/** A publication staging claim recovered from an abandoned temp's name. */
export interface NotificationStagingTempClaim {
	/** Published sibling this temp was staged for. */
	destination: string;
	/** PID of the process that staged it. */
	pid: number;
	/** Wall-clock ms the publisher recorded when it staged the temp. */
	stagedAtMs: number;
}

/**
 * Recover the publication claim encoded in a staging temp's name, or
 * `undefined` when `name` is not a staging temp or its PID/timestamp fields are
 * not usable integers. An unparseable claim is never reaped.
 */
export function parseNotificationStagingTemp(name: string): NotificationStagingTempClaim | undefined {
	const groups = NOTIFICATION_STAGING_TEMP_PATTERN.exec(name)?.groups;
	if (!groups) return undefined;
	const pid = Number(groups.pid);
	const stagedAtMs = Number(groups.stagedAt);
	if (!validDaemonPid(pid) || !Number.isSafeInteger(stagedAtMs) || stagedAtMs < 0) return undefined;
	return { destination: groups.destination as string, pid, stagedAtMs };
}

/** Liveness verdict for a staging temp's publisher; `unknown` fails closed. */
type NotificationPublisherLiveness = "alive" | "dead" | "unknown";

/**
 * Classify a staging temp publisher against the daemon's liveness seam. A
 * throwing probe (an unreadable process table, a denied query) is
 * indeterminate, not dead, so the temp is retained.
 */
function classifyNotificationStagingPublisher(
	claim: NotificationStagingTempClaim,
	pidAlive: (pid: number) => boolean,
): NotificationPublisherLiveness {
	try {
		return pidAlive(claim.pid) ? "alive" : "dead";
	} catch {
		return "unknown";
	}
}

/**
 * True when `file` is a regular file reachable under exactly one name. A
 * multi-link file shares its inode with another pathname, so unlinking this one
 * would not reclaim the data and may be another owner's live hardlink. Fails
 * closed when the `stat` seam cannot report a link count.
 */
async function isSingleLinkRegularFile(fsImpl: TelegramDaemonFs, file: string): Promise<boolean> {
	if (!fsImpl.stat) return false;
	const stat = await fsImpl.stat(file);
	return stat.nlink === 1;
}
export function isNotificationLeakArtifactName(name: string): boolean {
	return NOTIFICATION_LEAK_ARTIFACT_PREFIXES.some(prefix => name.startsWith(prefix));
}

type NotificationRootsRegistry = {
	version?: number;
	roots?: string[];
	managedRoots?: string[];
	sessions?: Record<string, string>;
	registrationTokens?: Record<string, string>;
};

function notificationRootRegistryFingerprint(registry: NotificationRootsRegistry): string {
	return crypto
		.createHash("sha256")
		.update(
			JSON.stringify({
				version: registry.version,
				roots: Array.from(new Set(registry.roots ?? [])).sort(),
				managedRoots: Array.from(new Set(registry.managedRoots ?? [])).sort(),
				sessions: Object.fromEntries(
					Object.entries(registry.sessions ?? {}).sort(([left], [right]) =>
						left < right ? -1 : left > right ? 1 : 0,
					),
				),
				registrationTokens: Object.fromEntries(
					Object.entries(registry.registrationTokens ?? {}).sort(([left], [right]) =>
						left < right ? -1 : left > right ? 1 : 0,
					),
				),
			}),
		)
		.digest("hex");
}

/**
 * Drop permanently missing scan roots from the durable registry under the roots
 * lock. Session map entries that pointed only at those roots are removed too.
 */
export async function pruneMissingNotificationRoots(input: {
	settings: Settings;
	fs?: TelegramDaemonFs;
	/** When set, only these roots are considered; otherwise every registered root is probed. */
	candidates?: readonly string[];
}): Promise<{ pruned: string[]; remaining: number }> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	await ensureDir(fsImpl, paths.dir);
	const pruned: string[] = [];
	let remaining = 0;
	await withFileLock(
		paths.roots,
		async () => {
			const current = (await readJson<NotificationRootsRegistry>(fsImpl, paths.roots)) ?? {};
			const roots = [...(current.roots ?? [])];
			const managedRoots = new Set(current.managedRoots ?? []);
			const sessions = { ...(current.sessions ?? {}) };
			const registrationTokens = { ...(current.registrationTokens ?? {}) };
			const candidateSet = input.candidates ? new Set(input.candidates) : undefined;
			const survivors: string[] = [];
			for (const root of roots) {
				if (candidateSet && !candidateSet.has(root)) {
					survivors.push(root);
					continue;
				}
				const sdkDir = path.join(root, "sdk");
				try {
					await fsImpl.readdir(sdkDir);
					survivors.push(root);
				} catch (error) {
					if (!isPermanentMissingPathError(error)) {
						// Transient unreadable: keep for the next pass.
						survivors.push(root);
						continue;
					}
					// Also accept a missing sdk dir when the root itself is still a directory
					// (empty registration) — still permanently useless for scans.
					try {
						await fsImpl.readdir(root);
					} catch (rootError) {
						if (!isPermanentMissingPathError(rootError)) {
							survivors.push(root);
							continue;
						}
					}
					pruned.push(root);
					managedRoots.delete(root);
					for (const [sessionId, mapped] of Object.entries(sessions)) {
						if (mapped === root) {
							delete sessions[sessionId];
							delete registrationTokens[sessionId];
						}
					}
				}
			}
			remaining = survivors.length;
			if (pruned.length === 0) return;
			await writeJsonAtomic(fsImpl, paths.roots, {
				version: 1,
				roots: Array.from(new Set(survivors)).sort(),
				managedRoots: Array.from(managedRoots).sort(),
				sessions,
				registrationTokens,
			});
		},
		{ staleMs: 10_000 },
	);
	return { pruned, remaining };
}

/**
 * Remove one abandoned publication staging temp under a liveness fence and an
 * identity-bound delete. Returns whether the temp was removed; `false` means it
 * was deliberately retained (live/indeterminate publisher, not a single-link
 * regular file, still inside the grace window, or an identity change between
 * capture and delete). Filesystem faults propagate to the caller's best-effort
 * handler.
 */
async function reapAbandonedNotificationStagingTemp(input: {
	fs: TelegramDaemonFs;
	file: string;
	claim: NotificationStagingTempClaim;
	now: number;
	graceMs: number;
	pidAlive: (pid: number) => boolean;
}): Promise<NotificationArtifactReapOutcome> {
	// A live or blocked publisher can hold a staged temp far past any grace
	// window; only a provably dead publisher's claim is abandoned. `unknown`
	// (throwing probe) fails closed.
	if (classifyNotificationStagingPublisher(input.claim, input.pidAlive) !== "dead") return "unchanged";
	const readEndpointFile = input.fs.readEndpointFile;
	// Both seams are optional; without them there is no no-follow capture and no
	// identity-bound delete, so retain rather than unlink unfenced.
	if (!readEndpointFile || !input.fs.exactUnlink) return "unchanged";
	// No-follow capture: rejects symlinks, directories, and anything that changes
	// while it is read. A reparse point or dangling link is therefore retained.
	const endpoint = await readEndpointFile(input.file);
	if (!(await isSingleLinkRegularFile(input.fs, input.file))) return "unchanged";
	// Age from the captured (no-follow) mtime rather than a second path-following
	// stat, so the grace decision and the delete bind the same inode. Integer ns
	// truncation only ever ages the file, never rejuvenates it.
	const age = input.now - Number(endpoint.identity.mtimeNs / 1_000_000n);
	if (age < input.graceMs) return "unchanged";
	// The native verifies dev+ino+size+mtimeNs+sha256 before unlinking, so a
	// readdir/capture -> replacement ABA cannot delete the fresh generation.
	return await reapNotificationArtifactExactly(
		input.fs,
		input.file,
		endpoint.identity,
		`.gjc-delete-notification-staging-temp-${crypto.randomUUID()}.json`,
	);
}

/** Reap one retained delete quarantine without following or unlinking a successor. */
async function reapNotificationLeakArtifact(input: {
	fs: TelegramDaemonFs;
	file: string;
	now: number;
	graceMs: number;
}): Promise<NotificationArtifactReapOutcome> {
	const name = path.basename(input.file);
	if (name.startsWith(".gjc-exact-unlink-placeholder-")) return "retained";
	if (name.startsWith(".gjc-delete-notification-staging-temp-")) {
		if (!input.fs.readEndpointFile || !input.fs.exactUnlink) return "unchanged";
		const endpoint = await input.fs.readEndpointFile(input.file);
		if (!(await isSingleLinkRegularFile(input.fs, input.file))) return "unchanged";
		const age = input.now - Number(endpoint.identity.mtimeNs / 1_000_000n);
		if (age < input.graceMs) return "unchanged";
		return await reapNotificationArtifactExactly(
			input.fs,
			input.file,
			endpoint.identity,
			`.gjc-exact-unlink-placeholder-${crypto.randomUUID()}.json`,
		);
	}
	if (!input.fs.stat) return "unchanged";
	const stat = await input.fs.stat(input.file);
	if (Number.isFinite(stat.mtimeMs) && input.now - stat.mtimeMs < input.graceMs) return "unchanged";
	await input.fs.unlink(input.file);
	return "removed";
}

/**
 * Reap retained exact-unlink / ownership-transition quarantine files older than
 * the grace window from the notifications directory, plus publication staging
 * temps whose publisher is provably dead.
 */
export async function reapStaleNotificationArtifacts(input: {
	settings: Settings;
	fs?: TelegramDaemonFs;
	now?: () => number;
	graceMs?: number;
	/** Liveness seam used to prove a staging temp's publisher is dead. */
	pidAlive?: (pid: number) => boolean;
}): Promise<{ removed: string[]; skipped: number }> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	await ensureDir(fsImpl, paths.dir);
	const now = input.now?.() ?? Date.now();
	const graceMs = input.graceMs ?? NOTIFICATION_LEAK_ARTIFACT_GRACE_MS;
	const pidAlive = input.pidAlive ?? defaultPidAlive;
	const removed: string[] = [];
	let skipped = 0;
	let names: string[];
	try {
		names = await fsImpl.readdir(paths.dir);
	} catch (error) {
		if (isPermanentMissingPathError(error)) return { removed, skipped };
		throw error;
	}
	for (const name of names) {
		const stagingTemp = NOTIFICATION_STAGING_TEMP_PATTERN.test(name);
		if (!isNotificationLeakArtifactName(name) && !stagingTemp) continue;
		const file = path.join(paths.dir, name);
		try {
			if (stagingTemp) {
				const claim = parseNotificationStagingTemp(name);
				// A staging-temp shape whose PID/timestamp will not parse carries no
				// provable claim, so it is retained.
				if (!claim) {
					skipped += 1;
					continue;
				}
				const outcome = await reapAbandonedNotificationStagingTemp({
					fs: fsImpl,
					file,
					claim,
					now,
					graceMs,
					pidAlive,
				});
				if (outcome === "removed") removed.push(file);
				else skipped += 1;
				continue;
			}
			const outcome = await reapNotificationLeakArtifact({ fs: fsImpl, file, now, graceMs });
			if (outcome === "removed") removed.push(file);
			else skipped += 1;
		} catch (error) {
			if (isPermanentMissingPathError(error)) continue;
			// Best-effort: a busy file must not fail daemon ownership.
			skipped += 1;
		}
	}
	return { removed, skipped };
}

/**
 * Startup / ownership self-heal: prune dead roots and reap leak artifacts so
 * `gjc daemon reload` recovers a degraded install without manual surgery (#2956).
 */
export async function healTelegramDaemonNotificationState(input: {
	settings: Settings;
	fs?: TelegramDaemonFs;
	now?: () => number;
	graceMs?: number;
	/** Liveness seam used to prove a staging temp's publisher is dead. */
	pidAlive?: (pid: number) => boolean;
}): Promise<{ prunedRoots: string[]; removedArtifacts: string[] }> {
	const prune = await pruneMissingNotificationRoots(input);
	const reap = await reapStaleNotificationArtifacts(input);
	if (prune.pruned.length > 0 || reap.removed.length > 0) {
		logger.warn(
			`notifications: self-heal pruned ${prune.pruned.length} dead root(s), reaped ${reap.removed.length} leak artifact(s)`,
		);
	}
	return { prunedRoots: prune.pruned, removedArtifacts: reap.removed };
}

function validBotToken(token: unknown): token is string {
	return typeof token === "string" && token.trim().length > 0;
}

function isExplicitlyStoppedDaemonState(state: unknown): state is DaemonState {
	return Boolean(
		hasSafeDaemonStateShape(state) &&
			state.stoppedAt !== undefined &&
			typeof state.acquisitionId === "string" &&
			state.acquisitionId.length > 0,
	);
}
/**
 * v0.11.4 and earlier generations wrote stopped tombstones before acquisition
 * and incarnation fields existed. A live, reused PID must not turn that durable
 * stop marker into a foreign live owner during an upgrade.
 */
function isLegacyStoppedDaemonState(state: unknown): boolean {
	const candidate = state as Partial<DaemonState> | undefined;
	return Boolean(
		candidate &&
			Number.isSafeInteger(candidate.pid) &&
			(candidate.pid ?? 0) > 0 &&
			typeof candidate.ownerId === "string" &&
			candidate.ownerId.length > 0 &&
			typeof candidate.tokenFingerprint === "string" &&
			typeof candidate.chatId === "string" &&
			Number.isSafeInteger(candidate.startedAt) &&
			Number.isSafeInteger(candidate.heartbeatAt) &&
			Number.isSafeInteger(candidate.stoppedAt) &&
			(candidate.launcherPid === undefined ||
				(Number.isSafeInteger(candidate.launcherPid) && (candidate.launcherPid ?? 0) > 0)) &&
			Array.isArray(candidate.roots) &&
			candidate.roots.every(root => typeof root === "string") &&
			candidate.version === DAEMON_VERSION &&
			isRecognizedLegacyGeneration(candidate.generation) &&
			candidate.incarnation === undefined &&
			candidate.acquisitionId === undefined &&
			candidate.ownershipPhase === undefined,
	);
}

function isStoppedDaemonState(state: unknown): boolean {
	return isExplicitlyStoppedDaemonState(state) || isLegacyStoppedDaemonState(state);
}

function ownerIdentityMatches(
	state: Pick<DaemonState, "tokenFingerprint" | "chatId">,
	tokenFingerprint: string,
	chatId: string,
): boolean {
	return state.tokenFingerprint === tokenFingerprint && state.chatId === chatId;
}

function ownerProvenanceMatches(state: DaemonState, pidIncarnation?: (pid: number) => string | undefined): boolean {
	const current = (pidIncarnation ?? defaultPidIncarnation)(state.pid);
	return isProcessIncarnation(state.incarnation) && isProcessIncarnation(current) && current === state.incarnation;
}

export function hasSafeDaemonStateShape(state: unknown): state is DaemonState {
	if (!state || typeof state !== "object" || Array.isArray(state)) return false;
	const candidate = state as Partial<DaemonState>;
	return Boolean(
		Number.isSafeInteger(candidate.pid) &&
			(candidate.pid as number) > 0 &&
			typeof candidate.ownerId === "string" &&
			candidate.ownerId.length > 0 &&
			(candidate.acquisitionId === undefined ||
				(typeof candidate.acquisitionId === "string" && candidate.acquisitionId.length > 0)) &&
			(candidate.ownershipPhase === undefined ||
				candidate.ownershipPhase === "provisional" ||
				candidate.ownershipPhase === "ready" ||
				candidate.ownershipPhase === "retired") &&
			typeof candidate.tokenFingerprint === "string" &&
			typeof candidate.chatId === "string" &&
			Number.isSafeInteger(candidate.startedAt) &&
			Number.isSafeInteger(candidate.heartbeatAt) &&
			isProcessIncarnation(candidate.incarnation) &&
			(candidate.launcherPid === undefined ||
				(Number.isSafeInteger(candidate.launcherPid) && (candidate.launcherPid as number) > 0)) &&
			Array.isArray(candidate.roots) &&
			candidate.roots.every(root => typeof root === "string") &&
			candidate.version === DAEMON_VERSION &&
			(candidate.generation === undefined ||
				(Number.isSafeInteger(candidate.generation) && (candidate.generation as number) > 0)) &&
			(candidate.stoppedAt === undefined || Number.isSafeInteger(candidate.stoppedAt)) &&
			(candidate.servingEpoch === undefined ||
				(Number.isSafeInteger(candidate.servingEpoch) && (candidate.servingEpoch as number) > 0)),
	);
}

const V010_PARENT_STATE_KEYS = [
	"pid",
	"ownerId",
	"tokenFingerprint",
	"chatId",
	"startedAt",
	"heartbeatAt",
	"roots",
	"version",
] as const;
const V010_GENERATION_3_PARENT_STATE_KEYS = [...V010_PARENT_STATE_KEYS, "generation"] as const;

type ParentDaemonStateBase = Omit<
	DaemonState,
	"incarnation" | "acquisitionId" | "ownershipPhase" | "generation" | "launcherPid"
> & {
	incarnation?: undefined;
	acquisitionId?: undefined;
	ownershipPhase?: undefined;
	generation?: unknown;
	launcherPid?: undefined;
};
type GenerationAbsentParentDaemonState = Omit<ParentDaemonStateBase, "generation"> & {
	generation?: undefined;
};
type Generation3ReleaseDaemonState = Omit<ParentDaemonStateBase, "generation"> & {
	generation: 3;
};
export type LegacyParentDaemonState = GenerationAbsentParentDaemonState | Generation3ReleaseDaemonState;

interface LegacyMigrationAttestation {
	stateDigest: string;
	confirmed?: true;
	lock?: V010OwnershipLockMetadata;
	pid: number;
	incarnation: string;
	heartbeatAt: number;
	observedAt: number;
	tokenFingerprint: string;
	chatId: string;
}

function historicalStateSerializer(state: LegacyParentDaemonState): string {
	const historicalState = {
		pid: state.pid,
		ownerId: state.ownerId,
		tokenFingerprint: state.tokenFingerprint,
		chatId: state.chatId,
		startedAt: state.startedAt,
		heartbeatAt: state.heartbeatAt,
		roots: state.roots,
		version: state.version,
		...(state.generation === undefined ? {} : { generation: 3 }),
	};
	return `${JSON.stringify(historicalState, null, 2)}\n`;
}

function legacyParentStateDigest(state: LegacyParentDaemonState): string {
	const { heartbeatAt: _heartbeatAt, ...immutableState } = state;
	return crypto
		.createHash("sha256")
		.update(historicalStateSerializer({ ...immutableState, heartbeatAt: 0 }))
		.digest("hex");
}

function hasExactParentStateKeys(state: object, keys: readonly string[]): boolean {
	const actual = Object.keys(state);
	return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isGenerationAbsentParentDaemonState(state: unknown): state is GenerationAbsentParentDaemonState {
	return hasParentDaemonStateShape(state) && hasExactParentStateKeys(state, V010_PARENT_STATE_KEYS);
}

function isGeneration3ReleaseDaemonState(state: unknown): state is Generation3ReleaseDaemonState {
	return (
		hasParentDaemonStateShape(state) &&
		state.generation === 3 &&
		hasExactParentStateKeys(state, V010_GENERATION_3_PARENT_STATE_KEYS)
	);
}

function isParentDaemonState(state: unknown): state is LegacyParentDaemonState {
	return isGenerationAbsentParentDaemonState(state) || isGeneration3ReleaseDaemonState(state);
}

function hasParentDaemonStateShape(state: unknown): state is ParentDaemonStateBase {
	const candidate = state as Partial<ParentDaemonStateBase> | undefined;
	return Boolean(
		candidate &&
			typeof candidate === "object" &&
			!Array.isArray(candidate) &&
			Number.isSafeInteger(candidate.pid) &&
			(candidate.pid ?? 0) > 0 &&
			typeof candidate.ownerId === "string" &&
			candidate.ownerId.length > 0 &&
			typeof candidate.tokenFingerprint === "string" &&
			typeof candidate.chatId === "string" &&
			Number.isSafeInteger(candidate.startedAt) &&
			Number.isSafeInteger(candidate.heartbeatAt) &&
			Array.isArray(candidate.roots) &&
			candidate.roots.every(root => typeof root === "string") &&
			candidate.version === DAEMON_VERSION &&
			candidate.incarnation === undefined &&
			candidate.acquisitionId === undefined &&
			candidate.ownershipPhase === undefined &&
			candidate.launcherPid === undefined &&
			candidate.stoppedAt === undefined &&
			(candidate.generation === undefined || candidate.generation === 3),
	);
}

const isLegacyParentDaemonState = isParentDaemonState;

/**
 * A live v0.10-shaped record is authority only in its exact historical form.
 * Parsed JSON alone cannot establish that form: field order and serialization
 * bytes are part of the migration attestation.
 */
async function isLiveNoncanonicalParentState(input: {
	fs: TelegramDaemonFs;
	statePath: string;
	state: unknown;
	pidAlive: (pid: number) => boolean;
	pidIncarnation: (pid: number) => string | undefined;
	tokenFingerprint: string;
	chatId: string;
}): Promise<boolean> {
	const candidate = input.state as Partial<ParentDaemonStateBase> | undefined;
	if (
		!candidate ||
		typeof candidate !== "object" ||
		Array.isArray(candidate) ||
		!validDaemonPid(candidate.pid) ||
		typeof candidate.ownerId !== "string" ||
		candidate.ownerId.length === 0 ||
		typeof candidate.tokenFingerprint !== "string" ||
		typeof candidate.chatId !== "string" ||
		!Number.isSafeInteger(candidate.startedAt) ||
		!Number.isSafeInteger(candidate.heartbeatAt) ||
		!Array.isArray(candidate.roots) ||
		!candidate.roots.every(root => typeof root === "string") ||
		candidate.version !== DAEMON_VERSION ||
		!input.pidAlive(candidate.pid)
	)
		return false;
	if (
		isStoppedDaemonState(candidate) ||
		(candidate.incarnation !== undefined &&
			(candidate.acquisitionId !== undefined || candidate.ownershipPhase !== undefined))
	)
		return false;
	if (
		candidate.incarnation !== undefined &&
		isProcessIncarnation(input.pidIncarnation(candidate.pid)) &&
		input.pidIncarnation(candidate.pid) !== candidate.incarnation &&
		!(candidate.tokenFingerprint === input.tokenFingerprint && candidate.chatId === input.chatId)
	)
		return false;
	if (!isParentDaemonState(candidate)) return true;
	try {
		return (await input.fs.readFile(input.statePath, "utf8")) !== historicalStateSerializer(candidate);
	} catch {
		return false;
	}
}
function legacyOwnershipLockMatchesHandoffState(lock: OwnershipLockRead, state: unknown): boolean {
	return lock.kind === "v010" && isGeneration3ReleaseDaemonState(state);
}

function legacyMigrationAttestationPath(statePath: string): string {
	return `${statePath}.legacy-migration.json`;
}

async function legacyParentHandoffDecision(input: {
	fs: TelegramDaemonFs;
	statePath: string;
	lockPath: string;
	state: LegacyParentDaemonState;
	now: number;
	pidAlive: (pid: number) => boolean;
	pidIncarnation: (pid: number) => string | undefined;
	tokenFingerprint: string;
	chatId: string;
}): Promise<
	| {
			acquired: false;
			attached: false;
			provisional?: boolean;
			reloadRequired?: boolean;
			legacyReloadRequired?: boolean;
			blocked?: boolean;
	  }
	| undefined
> {
	const { state } = input;
	if (!input.pidAlive(state.pid)) return undefined;
	if (state.generation !== 3) return { acquired: false, attached: false, blocked: true };
	if (!ownerIdentityMatches(state, input.tokenFingerprint, input.chatId))
		return { acquired: false, attached: false, blocked: true };
	const incarnation = input.pidIncarnation(state.pid);
	if (!isProcessIncarnation(incarnation)) return { acquired: false, attached: false, blocked: true };
	let stateBytes: string;
	try {
		stateBytes = await input.fs.readFile(input.statePath, "utf8");
	} catch {
		return { acquired: false, attached: false, provisional: true };
	}
	if (stateBytes !== historicalStateSerializer(state)) return { acquired: false, attached: false, blocked: true };
	const lock = await readOwnershipLock(input.fs, input.lockPath);
	const attestationLock =
		state.generation === undefined && lock.kind === "missing"
			? undefined
			: lock.kind === "v010" && legacyOwnershipLockMatchesHandoffState(lock, state)
				? lock.metadata
				: null;
	if (attestationLock === null) return { acquired: false, attached: false, blocked: true };
	const previous = await readJson<LegacyMigrationAttestation>(
		input.fs,
		legacyMigrationAttestationPath(input.statePath),
	);
	const stateDigest = legacyParentStateDigest(state);
	const attested = Boolean(
		previous &&
			previous.stateDigest === stateDigest &&
			JSON.stringify(previous.lock) === JSON.stringify(attestationLock) &&
			previous.pid === state.pid &&
			previous.incarnation === incarnation &&
			previous.tokenFingerprint === input.tokenFingerprint &&
			previous.chatId === input.chatId &&
			state.heartbeatAt > previous.heartbeatAt &&
			input.now - previous.observedAt <= HEARTBEAT_TTL_MS,
	);
	await writeJsonAtomic(input.fs, legacyMigrationAttestationPath(input.statePath), {
		stateDigest,
		...(attested ? { confirmed: true as const } : {}),
		...(attestationLock === undefined ? {} : { lock: attestationLock }),
		pid: state.pid,
		incarnation,
		heartbeatAt: state.heartbeatAt,
		observedAt: input.now,
		tokenFingerprint: input.tokenFingerprint,
		chatId: input.chatId,
	} satisfies LegacyMigrationAttestation);
	if (!attested) return { acquired: false, attached: false, provisional: true };
	return { acquired: false, attached: false, reloadRequired: true, legacyReloadRequired: true };
}

export interface AttestedLegacyDaemonOwner {
	state: LegacyParentDaemonState;
	incarnation: string;
}

/** Revalidate the exact two-observation legacy proof immediately before signaling. */
export async function readAttestedLegacyDaemonOwner(input: {
	settings: Settings;
	fs?: TelegramDaemonFs;
	now?: () => number;
	pidIncarnation?: (pid: number) => string | undefined;
	tokenFingerprint: string;
	chatId: string;
}): Promise<AttestedLegacyDaemonOwner | undefined> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	const state = await readJson<unknown>(fsImpl, paths.state);
	if (!isGeneration3ReleaseDaemonState(state)) return undefined;
	let stateBytes: string;
	try {
		stateBytes = await fsImpl.readFile(paths.state, "utf8");
	} catch {
		return undefined;
	}
	if (stateBytes !== historicalStateSerializer(state)) return undefined;
	const lock = await readOwnershipLock(fsImpl, paths.lock);
	if (lock.kind !== "v010") return undefined;
	const attestation = await readJson<LegacyMigrationAttestation>(fsImpl, legacyMigrationAttestationPath(paths.state));
	const incarnation = (input.pidIncarnation ?? defaultPidIncarnation)(state.pid);
	const now = (input.now ?? Date.now)();
	if (
		attestation?.confirmed !== true ||
		!isProcessIncarnation(incarnation) ||
		attestation.stateDigest !== legacyParentStateDigest(state) ||
		JSON.stringify(attestation.lock) !== JSON.stringify(lock.metadata) ||
		attestation.pid !== state.pid ||
		attestation.incarnation !== incarnation ||
		attestation.tokenFingerprint !== input.tokenFingerprint ||
		attestation.chatId !== input.chatId ||
		attestation.heartbeatAt > state.heartbeatAt ||
		now < attestation.observedAt ||
		now - attestation.observedAt > HEARTBEAT_TTL_MS
	)
		return undefined;
	return { state, incarnation };
}

function isRecognizedLegacyGeneration(generation: number | undefined): boolean {
	return generation === undefined || generation === 3;
}

/** True when a modern owner carries complete ready-state provenance. */
function hasFullModernOwnerProvenance(
	state: DaemonState | undefined,
	pidIncarnation?: (pid: number) => string | undefined,
): boolean {
	return Boolean(
		hasSafeDaemonStateShape(state) &&
			state.generation !== 3 &&
			state.ownershipPhase === "ready" &&
			typeof state.acquisitionId === "string" &&
			state.acquisitionId.length > 0 &&
			ownerProvenanceMatches(state, pidIncarnation),
	);
}

/**
 * Classifies a physically live daemon record before any replacement action.
 *
 * A canonical, differing incarnation is the only authoritative proof that a
 * live PID is no longer the recorded owner. This applies equally to matching
 * and foreign Telegram identities: identity never substitutes for provenance.
 */
function classifyForeignLiveOwner(input: {
	state: unknown;
	tokenFingerprint: string;
	chatId: string;
	pidAlive: (pid: number) => boolean;
	pidIncarnation?: (pid: number) => string | undefined;
}): "identity_mismatch" | "ambiguous" | undefined {
	const state = input.state as Partial<DaemonState> | undefined;
	// Validate before probing so malformed PIDs never reach the liveness source.
	if (!state || !validDaemonPid(state.pid) || !input.pidAlive(state.pid)) return undefined;
	// A stopped tombstone with a canonical acquisition is not a live owner.
	if (isStoppedDaemonState(state) || isLegacyParentDaemonState(state)) return undefined;
	const currentIncarnation = input.pidIncarnation ? input.pidIncarnation(state.pid) : defaultPidIncarnation(state.pid);
	if (
		!hasSafeDaemonStateShape(state) ||
		!isProcessIncarnation(state.incarnation) ||
		!isProcessIncarnation(currentIncarnation)
	)
		return "ambiguous";
	if (currentIncarnation !== state.incarnation) return undefined;
	return ownerIdentityMatches(state, input.tokenFingerprint, input.chatId) ? undefined : "identity_mismatch";
}

/** True for a physically live owner with this configuration, including legacy generations. */
export function isPhysicalMatchingOwner(input: {
	state: DaemonState | undefined;
	tokenFingerprint: string;
	chatId: string;
	pidAlive: (pid: number) => boolean;
	pidIncarnation?: (pid: number) => string | undefined;
}): boolean {
	const persistedState: unknown = input.state;
	const legacyParentState = isLegacyParentDaemonState(persistedState) ? persistedState : undefined;
	const modernState = hasSafeDaemonStateShape(persistedState) ? persistedState : undefined;
	const state = modernState ?? legacyParentState;
	if (
		!state ||
		state.stoppedAt !== undefined ||
		!ownerIdentityMatches(state, input.tokenFingerprint, input.chatId) ||
		!input.pidAlive(state.pid)
	)
		return false;
	return legacyParentState
		? isProcessIncarnation((input.pidIncarnation ?? defaultPidIncarnation)(legacyParentState.pid))
		: modernState !== undefined && ownerProvenanceMatches(modernState, input.pidIncarnation);
}

/** True only for a fully-provenanced modern owner outside the generation-3 parent schema. */
export function isSignalableMatchingOwner(input: {
	state: DaemonState | undefined;
	tokenFingerprint: string;
	chatId: string;
	pidAlive: (pid: number) => boolean;
	pidIncarnation?: (pid: number) => string | undefined;
}): boolean {
	const { state } = input;
	return Boolean(isPhysicalMatchingOwner(input) && hasFullModernOwnerProvenance(state, input.pidIncarnation));
}

export function isFreshLiveOwner(input: {
	state: DaemonState | undefined;
	now: number;
	tokenFingerprint: string;
	chatId: string;
	pidAlive: (pid: number) => boolean;
	pidIncarnation?: (pid: number) => string | undefined;
	effectiveHeartbeatAt?: number;
}): boolean {
	const { state } = input;
	const heartbeatAt = Object.hasOwn(input, "effectiveHeartbeatAt") ? input.effectiveHeartbeatAt : state?.heartbeatAt;
	return Boolean(
		state &&
			heartbeatAt !== undefined &&
			hasSafeDaemonStateShape(state) &&
			state.stoppedAt === undefined &&
			ownerIdentityMatches(state, input.tokenFingerprint, input.chatId) &&
			input.now - heartbeatAt <= HEARTBEAT_TTL_MS &&
			input.pidAlive(state.pid) &&
			ownerProvenanceMatches(state, input.pidIncarnation),
	);
}

/** True only when a physically live matching owner can serve this build's daemon lifecycle contract. */
export function isCurrentCompatibleOwner(input: {
	state: DaemonState | undefined;
	now: number;
	tokenFingerprint: string;
	chatId: string;
	pidAlive: (pid: number) => boolean;
	pidIncarnation?: (pid: number) => string | undefined;
	effectiveHeartbeatAt?: number;
}): boolean {
	const state = input.state;
	return Boolean(
		isFreshLiveOwner(input) &&
			state?.ownershipPhase === "ready" &&
			typeof state.acquisitionId === "string" &&
			state.acquisitionId.length > 0 &&
			state.generation === DAEMON_GENERATION &&
			state.servingEpoch === SERVING_EPOCH,
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
	pidIncarnation?: (pid: number) => string | undefined;
	randomId?: () => string;
	/** Permit one Windows source launcher PID to daemon PID handoff. */
	allowPidRebind?: boolean;
	/** A caller-supplied opaque owner identity, used when the launcher PID is not durable. */
	ownerId?: string;
}): Promise<{
	acquired: boolean;
	ownerId?: string;
	acquisitionId?: string;
	attached?: boolean;
	blocked?: boolean;
	provisional?: boolean;
	reason?: "identity_mismatch";
	reloadRequired?: boolean;
	legacyReloadRequired?: boolean;
}> {
	const fsImpl = input.fs ?? nodeFs;
	const now = input.now ?? Date.now;
	const pid = input.pid ?? process.pid;
	if (!validDaemonPid(pid)) return { acquired: false, attached: true };
	const pidAlive = input.pidAlive ?? defaultPidAlive;
	const pidIncarnation = input.pidIncarnation ?? defaultPidIncarnation;
	const incarnation = pidIncarnation(pid);
	if (!isProcessIncarnation(incarnation)) return { acquired: false, attached: false, provisional: true };
	const paths = daemonPaths(input.settings.getAgentDir());
	await ensureDir(fsImpl, paths.dir);
	const ownerId =
		input.ownerId ?? input.randomId?.() ?? `${pid}-${now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	const roots = input.roots ?? (await readJson<{ roots?: string[] }>(fsImpl, paths.roots))?.roots ?? [];

	// Generation is inventory-only: a lower servingEpoch triggers convergence,
	// while same-epoch cross-generation owners attach.
	const attachDecision = (
		snapshot: OwnerFreshnessSnapshot,
	):
		| { acquired: false; attached: boolean; blocked?: boolean; provisional?: boolean; reloadRequired?: boolean }
		| undefined => {
		const state = snapshot.state;
		if (state && !hasSafeDaemonStateShape(state)) {
			const malformed = state as Partial<DaemonState>;
			if (
				!isStoppedDaemonState(malformed) &&
				validDaemonPid(malformed.pid) &&
				typeof malformed.incarnation === "string" &&
				pidAlive(malformed.pid)
			)
				return { acquired: false, attached: false, blocked: true };
			return undefined;
		}
		if (!state || state.stoppedAt !== undefined || !ownerIdentityMatches(state, input.tokenFingerprint, input.chatId))
			return undefined;
		if (state.generation === 3) return { acquired: false, attached: false, blocked: true };
		// Unavailable provenance is ambiguous and must remain fail-closed. A
		// different authoritative incarnation proves PID reuse, so allow only the
		// transition-locked path below to reclaim the stale owner artifacts.
		if (pidAlive(state.pid)) {
			const currentIncarnation = pidIncarnation(state.pid);
			if (!isProcessIncarnation(currentIncarnation) || !isProcessIncarnation(state.incarnation))
				return { acquired: false, attached: false, blocked: true };
			if (currentIncarnation !== state.incarnation) return undefined;
		}
		if (!pidAlive(state.pid)) return undefined;
		if (
			isCurrentCompatibleOwner({
				state,
				now: now(),
				tokenFingerprint: input.tokenFingerprint,
				chatId: input.chatId,
				pidAlive,
				pidIncarnation,
				effectiveHeartbeatAt: snapshot.effectiveHeartbeatAt,
			})
		)
			return { acquired: false, attached: true };
		// A physical owner that cannot prove current compatibility is never safe to
		// attach. A reload handoff additionally requires a fresh heartbeat: a stale
		// record must remain blocked rather than authorizing a signal to its PID.
		if (
			isFreshLiveOwner({
				state,
				now: now(),
				tokenFingerprint: input.tokenFingerprint,
				chatId: input.chatId,
				pidAlive,
				pidIncarnation,
				effectiveHeartbeatAt: snapshot.effectiveHeartbeatAt,
			}) &&
			(state.version !== DAEMON_VERSION ||
				((state.servingEpoch === undefined ? 1 : state.servingEpoch) < SERVING_EPOCH &&
					isSignalableMatchingOwner({
						state,
						tokenFingerprint: input.tokenFingerprint,
						chatId: input.chatId,
						pidAlive,
						pidIncarnation,
					})))
		)
			return { acquired: false, attached: false, reloadRequired: true };
		return { acquired: false, attached: false, provisional: true };
	};
	const existing = await readJson<DaemonState>(fsImpl, paths.state);
	if (
		existing &&
		validDaemonPid(existing.pid) &&
		!ownerIdentityMatches(existing, input.tokenFingerprint, input.chatId) &&
		(!hasSafeDaemonStateShape(existing) ||
			!isProcessIncarnation(existing.incarnation) ||
			!isProcessIncarnation(pidIncarnation(existing.pid))) &&
		pidAlive(existing.pid)
	)
		return { acquired: false, attached: false, blocked: true };
	const foreignOwner = classifyForeignLiveOwner({
		state: existing,
		tokenFingerprint: input.tokenFingerprint,
		chatId: input.chatId,
		pidAlive,
		pidIncarnation,
	});
	if (foreignOwner) {
		return foreignOwner === "identity_mismatch"
			? { acquired: false, attached: false, blocked: true, reason: "identity_mismatch" }
			: { acquired: false, attached: false, blocked: true };
	}
	if (
		await isLiveNoncanonicalParentState({
			fs: fsImpl,
			statePath: paths.state,
			state: existing,
			pidAlive,
			pidIncarnation,
			tokenFingerprint: input.tokenFingerprint,
			chatId: input.chatId,
		})
	)
		return { acquired: false, attached: false, blocked: true };

	const transition = await acquireTransitionLock({ fs: fsImpl, path: paths.steal, pidAlive, pidIncarnation });
	if (!transition) return { acquired: false, attached: false, provisional: true };
	try {
		const recheckedSnapshot = await readOwnerFreshnessSnapshot({ settings: input.settings, fs: fsImpl });
		const rechecked = recheckedSnapshot.state;
		const recheckedLock = await readOwnershipLock(fsImpl, paths.lock);
		const recheckedForeignOwner = classifyForeignLiveOwner({
			state: rechecked,
			tokenFingerprint: input.tokenFingerprint,
			chatId: input.chatId,
			pidAlive,
			pidIncarnation,
		});
		if (recheckedForeignOwner) {
			return recheckedForeignOwner === "identity_mismatch"
				? { acquired: false, attached: false, blocked: true, reason: "identity_mismatch" }
				: { acquired: false, attached: false, blocked: true };
		}
		if (
			await isLiveNoncanonicalParentState({
				fs: fsImpl,
				statePath: paths.state,
				state: rechecked,
				pidAlive,
				pidIncarnation,
				tokenFingerprint: input.tokenFingerprint,
				chatId: input.chatId,
			})
		)
			return { acquired: false, attached: false, blocked: true };
		const recheckedDecision = isLegacyParentDaemonState(rechecked) ? undefined : attachDecision(recheckedSnapshot);
		if (
			recheckedDecision &&
			(recheckedDecision.attached ||
				recheckedDecision.blocked ||
				recheckedLock.kind === "missing" ||
				ownershipLockMatchesState(recheckedLock, rechecked))
		)
			return recheckedDecision;
		// A stopped tombstone authorizes removal only of its own canonical lock.
		// A newer initializer may have replaced the pathname while that tombstone
		// remained, and must receive the same liveness/freshness protection as any
		// other live reservation.
		const stoppedLockMatches = ownershipLockMatchesStoppedState(recheckedLock, rechecked, pidAlive);
		// A v0.10 parent owns a legacy { pid, startedAt } lock. An exact
		// state/lock pair is authority only to attest or retry handoff of that
		// owner; it is never attached or unlinked here.
		const legacyHandoffLockMatches = legacyOwnershipLockMatchesHandoffState(recheckedLock, rechecked);
		const lockDecision =
			stoppedLockMatches || legacyHandoffLockMatches
				? undefined
				: liveOwnershipLockDecision({ lock: recheckedLock, pidAlive, pidIncarnation });
		if (lockDecision) return lockDecision;
		if (
			!stoppedLockMatches &&
			!legacyHandoffLockMatches &&
			!(await ownershipLockIsReclaimable({
				fs: fsImpl,
				path: paths.lock,
				lock: recheckedLock,
				now: now(),
				pidAlive,
				pidIncarnation,
			}))
		)
			return { acquired: false, attached: false, provisional: true };
		if (isLegacyParentDaemonState(rechecked)) {
			const legacyDecision = await legacyParentHandoffDecision({
				fs: fsImpl,
				statePath: paths.state,
				lockPath: paths.lock,
				state: rechecked,
				now: now(),
				pidAlive,
				pidIncarnation,
				tokenFingerprint: input.tokenFingerprint,
				chatId: input.chatId,
			});
			if (legacyDecision) return legacyDecision;
		} else if (recheckedDecision) {
			return recheckedDecision;
		}
		if (
			hasSafeDaemonStateShape(rechecked) &&
			rechecked.stoppedAt === undefined &&
			pidAlive(rechecked.pid) &&
			ownerProvenanceMatches(rechecked, pidIncarnation)
		)
			return { acquired: false, attached: false, provisional: true };
		const currentLock = await readOwnershipLock(fsImpl, paths.lock);
		if (!ownershipLockMatches(recheckedLock, currentLock))
			return { acquired: false, attached: false, provisional: true };
		if (currentLock.kind !== "missing") {
			if (!(await transitionLockIsHeldByCaller({ fs: fsImpl, path: paths.steal, lock: transition })))
				return { acquired: false, attached: false, provisional: true };
			if (!(await unlinkOwnershipLockExactly(fsImpl, paths.lock, currentLock)))
				return { acquired: false, attached: false, provisional: true };
		}
		const ownershipLock: OwnershipLockMetadata = {
			pid,
			incarnation,
			ownerId,
			acquisitionId: ownerId,
			startedAt: now(),
		};
		if (!(await transitionLockIsHeldByCaller({ fs: fsImpl, path: paths.steal, lock: transition })))
			return { acquired: false, attached: false, provisional: true };
		if (!(await tryCreateOwnershipLock(fsImpl, paths.lock, ownershipLock)))
			return { acquired: false, attached: false, provisional: true };
		if (
			!(await transitionLockIsHeldByCaller({ fs: fsImpl, path: paths.steal, lock: transition })) ||
			!ownershipLockMatchesMetadata(await readOwnershipLock(fsImpl, paths.lock), ownershipLock)
		)
			return { acquired: false, attached: false, provisional: true };
		await writeJsonAtomic(fsImpl, paths.state, {
			pid,
			incarnation,
			ownerId,
			acquisitionId: ownerId,
			ownershipPhase: "provisional",
			tokenFingerprint: input.tokenFingerprint,
			chatId: input.chatId,
			startedAt: now(),
			heartbeatAt: now(),
			roots,
			version: DAEMON_VERSION,
			generation: DAEMON_GENERATION,
			servingEpoch: SERVING_EPOCH,
		} satisfies DaemonState);
		if (
			!(await transitionLockIsHeldByCaller({ fs: fsImpl, path: paths.steal, lock: transition })) ||
			!ownershipLockMatchesMetadata(await readOwnershipLock(fsImpl, paths.lock), ownershipLock)
		)
			return { acquired: false, attached: false, provisional: true };
		return { acquired: true, ownerId, acquisitionId: ownerId };
	} finally {
		await releaseDaemonTransitionLock({ fs: fsImpl, path: paths.steal, lock: transition });
	}
}

export async function renewDaemonHeartbeat(input: {
	settings: Settings;
	ownerId: string;
	acquisitionId?: string;
	tokenFingerprint?: string;
	chatId?: string;
	fs?: TelegramDaemonFs;
	now?: () => number;
	pid?: number;
	generation?: number;
	pidIncarnation?: (pid: number) => string | undefined;
	sleep?: (ms: number) => Promise<void>;
	stealRetries?: number;
	stealRetryDelayMs?: number;
}): Promise<boolean> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	const acquisitionId = input.acquisitionId ?? input.ownerId;
	// The steal lock is held only briefly by concurrent lifecycle operations.
	// A contended lock never proves readiness: only the holder may validate and
	// publish the exact ready PID/generation state.
	const transition = await acquireTransitionLock({
		fs: fsImpl,
		path: paths.steal,
		pidIncarnation: input.pidIncarnation,
		sleep: input.sleep,
		retries: input.stealRetries,
		retryDelayMs: input.stealRetryDelayMs,
	});
	if (!transition) return false;
	try {
		const state = await readJson<DaemonState>(fsImpl, paths.state);
		const pid = input.pid ?? state?.pid;
		const generation = input.generation ?? state?.generation;
		const incarnation = (input.pidIncarnation ?? defaultPidIncarnation)(pid ?? 0);
		// A daemon child may atomically bind its own PID only while its launcher
		// reservation is still provisional and carries the same acquisition secret.
		const canBindProvisionalPid =
			state?.ownershipPhase === "provisional" &&
			state.pid !== pid &&
			state.ownerId === input.ownerId &&
			state.acquisitionId === acquisitionId;
		if (
			!state ||
			!hasSafeDaemonStateShape(state) ||
			typeof pid !== "number" ||
			!Number.isSafeInteger(pid) ||
			pid <= 0 ||
			!isProcessIncarnation(incarnation) ||
			generation !== DAEMON_GENERATION ||
			state.ownerId !== input.ownerId ||
			state.acquisitionId !== acquisitionId ||
			(input.tokenFingerprint !== undefined && state.tokenFingerprint !== input.tokenFingerprint) ||
			(input.chatId !== undefined && state.chatId !== input.chatId) ||
			(!canBindProvisionalPid && state.incarnation !== incarnation) ||
			(!canBindProvisionalPid && state.pid !== pid) ||
			state.generation !== generation ||
			state.stoppedAt !== undefined ||
			state.ownershipPhase === "retired"
		)
			return false;
		if (!(await transitionLockIsHeldByCaller({ fs: fsImpl, path: paths.steal, lock: transition }))) return false;
		const previousLock = canBindProvisionalPid ? await readOwnershipLock(fsImpl, paths.lock) : undefined;
		const expectedLock =
			previousLock?.kind === "valid" &&
			previousLock.metadata.pid === state.pid &&
			previousLock.metadata.incarnation === state.incarnation &&
			previousLock.metadata.ownerId === state.ownerId &&
			previousLock.metadata.acquisitionId === state.acquisitionId
				? previousLock.metadata
				: undefined;
		const reboundLock = expectedLock ? { ...expectedLock, pid, incarnation } : undefined;
		if (
			canBindProvisionalPid &&
			(!expectedLock ||
				!reboundLock ||
				!(await rebindOwnershipLock({
					fs: fsImpl,
					path: paths.lock,
					transitionPath: paths.steal,
					transition,

					expected: expectedLock,
					rebound: reboundLock,
				})))
		)
			return false;
		const heartbeatAt = (input.now ?? Date.now)();
		const boundState: DaemonState = {
			...state,
			// Preserve the source launcher PID so concurrent ensures can recognize
			// this bound child as its successor while it is still provisional.
			launcherPid: state.pid,
			pid,
			incarnation,
			ownershipPhase: "provisional",
			heartbeatAt,
			servingEpoch: SERVING_EPOCH,
		};
		try {
			await writeJsonAtomic(fsImpl, paths.state, boundState);
		} catch {
			if (expectedLock && reboundLock)
				await rollbackOwnershipLockRebind({
					fs: fsImpl,
					path: paths.lock,
					transitionPath: paths.steal,
					transition,

					previous: expectedLock,
					rebound: reboundLock,
				});
			return false;
		}
		const retireBoundOwnership = async (): Promise<void> => {
			const lock = await readOwnershipLock(fsImpl, paths.lock);
			if (!ownershipLockMatchesState(lock, boundState)) return;
			await writeJsonAtomic(fsImpl, paths.state, {
				...boundState,
				ownershipPhase: "retired",
				stoppedAt: (input.now ?? Date.now)(),
			}).catch(() => undefined);
			if (await transitionLockIsHeldByCaller({ fs: fsImpl, path: paths.steal, lock: transition }))
				await unlinkOwnershipLockExactly(fsImpl, paths.lock, lock);
		};
		// The durable sidecar must exist and match the rebound ownership lock before
		// any observer can see ownershipPhase:"ready". A provisional state may be
		// fresh, but readiness waiters categorically refuse to attach to it.
		let sidecarRenewed = false;
		try {
			sidecarRenewed = await renewOwnerHeartbeatSidecar({
				settings: input.settings,
				ownerId: input.ownerId,
				acquisitionId,
				fs: fsImpl,
				now: () => heartbeatAt,
				pid,
				pidIncarnation: input.pidIncarnation,
			});
		} catch {
			sidecarRenewed = false;
		}
		if (!sidecarRenewed) {
			logger.warn(
				"notifications: Telegram daemon initial heartbeat sidecar proof failed; retiring provisional ownership",
			);
			await retireBoundOwnership();
			return false;
		}
		try {
			await writeJsonAtomic(fsImpl, paths.state, { ...boundState, ownershipPhase: "ready" });
			return true;
		} catch {
			logger.warn("notifications: Telegram daemon ready publication failed after sidecar proof; retiring ownership");
			await retireBoundOwnership();
			return false;
		}
	} finally {
		await releaseDaemonTransitionLock({ fs: fsImpl, path: paths.steal, lock: transition });
	}
}

/** Acquire the lifecycle transition lock with bounded retry for bind/retire races. */
export async function acquireTransitionLock(input: {
	fs: TelegramDaemonFs;
	path: string;
	pidAlive?: (pid: number) => boolean;
	pidIncarnation?: (pid: number) => string | undefined;
	sleep?: (ms: number) => Promise<void>;
	retries?: number;
	retryDelayMs?: number;
}): Promise<DaemonTransitionLock | undefined> {
	return await acquireDaemonTransitionLock({
		fs: input.fs,
		path: input.path,
		pid: process.pid,
		pidAlive: input.pidAlive ?? defaultPidAlive,
		pidIncarnation: input.pidIncarnation ?? defaultPidIncarnation,
		sleep: input.sleep,
		retries: input.retries,
		retryDelayMs: input.retryDelayMs,
	});
}

/** Retire only the unchanged provisional acquisition after bounded readiness fails. */
export async function retireProvisionalDaemonOwnership(input: {
	settings: Settings;
	ownerId: string;
	acquisitionId?: string;
	pidIncarnation?: (pid: number) => string | undefined;
	pidAlive?: (pid: number) => boolean;
	/** Detached child PID, when the launcher successfully reported it. */
	pid: number;
	/** PID which created the provisional reservation before the child was bound. */
	launcherPid?: number;
	fs?: TelegramDaemonFs;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	stealRetries?: number;
	stealRetryDelayMs?: number;
	/** Only no-child confirmation may retire a ready-like launcher publication. */
	allowReadyWithoutChildPid?: boolean;
}): Promise<boolean> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	const transition = await acquireTransitionLock({
		fs: fsImpl,
		path: paths.steal,
		pidAlive: input.pidAlive,
		pidIncarnation: input.pidIncarnation,
		sleep: input.sleep,
		retries: input.stealRetries,
		retryDelayMs: input.stealRetryDelayMs,
	});
	if (!transition) return false;
	try {
		const state = await readJson<DaemonState>(fsImpl, paths.state);
		const acquisitionId = input.acquisitionId ?? input.ownerId;
		const expectedPid = state?.pid === input.pid ? input.pid : input.launcherPid;
		const pidAlive = input.pidAlive ?? defaultPidAlive;
		const expectedPidAlive = expectedPid !== undefined && pidAlive(expectedPid);
		const incarnation = (input.pidIncarnation ?? defaultPidIncarnation)(expectedPid ?? 0);
		if (
			!state ||
			state.ownerId !== input.ownerId ||
			state.acquisitionId !== acquisitionId ||
			(expectedPidAlive &&
				(!isProcessIncarnation(incarnation) ||
					!isProcessIncarnation(state.incarnation) ||
					state.incarnation !== incarnation)) ||
			(state.pid !== input.pid && state.pid !== input.launcherPid) ||
			state.generation !== DAEMON_GENERATION ||
			!Number.isSafeInteger(state.generation) ||
			(state.ownershipPhase !== "provisional" &&
				!(input.allowReadyWithoutChildPid === true && state.ownershipPhase === "ready"))
		)
			return false;
		if (!(await transitionLockIsHeldByCaller({ fs: fsImpl, path: paths.steal, lock: transition }))) return false;
		const lock = await readOwnershipLock(fsImpl, paths.lock);
		if (!ownershipLockMatchesState(lock, state)) return false;
		await writeJsonAtomic(fsImpl, paths.state, {
			...state,
			ownershipPhase: "retired",
			stoppedAt: (input.now ?? Date.now)(),
		});
		if (!(await transitionLockIsHeldByCaller({ fs: fsImpl, path: paths.steal, lock: transition }))) return false;
		return await unlinkOwnershipLockExactly(fsImpl, paths.lock, lock);
	} finally {
		await releaseDaemonTransitionLock({ fs: fsImpl, path: paths.steal, lock: transition });
	}
}

/** Bind a launcher-reserved provisional acquisition to its actual detached child. */
async function bindProvisionalDaemonPid(input: {
	settings: Settings;
	ownerId: string;
	acquisitionId: string;
	pid: number;
	incarnation: string;
	fs?: TelegramDaemonFs;
	sleep?: (ms: number) => Promise<void>;
	stealRetries?: number;
	stealRetryDelayMs?: number;
}): Promise<boolean> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	const transition = await acquireTransitionLock({
		fs: fsImpl,
		path: paths.steal,
		sleep: input.sleep,
		retries: input.stealRetries,
		retryDelayMs: input.stealRetryDelayMs,
	});
	if (!transition) return false;
	try {
		const state = await readJson<DaemonState>(fsImpl, paths.state);
		if (
			!state ||
			state.ownerId !== input.ownerId ||
			state.acquisitionId !== input.acquisitionId ||
			state.ownershipPhase !== "provisional" ||
			state.generation !== DAEMON_GENERATION ||
			!isProcessIncarnation(state.incarnation) ||
			!isProcessIncarnation(input.incarnation)
		)
			return false;
		if (!(await transitionLockIsHeldByCaller({ fs: fsImpl, path: paths.steal, lock: transition }))) return false;
		const previousLock = await readOwnershipLock(fsImpl, paths.lock);
		if (
			previousLock.kind !== "valid" ||
			previousLock.metadata.pid !== state.pid ||
			previousLock.metadata.incarnation !== state.incarnation ||
			previousLock.metadata.ownerId !== state.ownerId ||
			previousLock.metadata.acquisitionId !== state.acquisitionId
		)
			return false;
		const reboundLock = { ...previousLock.metadata, pid: input.pid, incarnation: input.incarnation };
		if (
			!(await rebindOwnershipLock({
				fs: fsImpl,
				path: paths.lock,
				transitionPath: paths.steal,
				transition,

				expected: previousLock.metadata,
				rebound: reboundLock,
			}))
		)
			return false;
		try {
			await writeJsonAtomic(fsImpl, paths.state, {
				...state,
				// This durable marker distinguishes a launcher reservation from a PID
				// the launcher authoritatively rebound to its child.
				launcherPid: state.launcherPid ?? state.pid,
				pid: input.pid,
				incarnation: input.incarnation,
			});
		} catch {
			await rollbackOwnershipLockRebind({
				fs: fsImpl,
				path: paths.lock,
				transitionPath: paths.steal,
				transition,
				previous: previousLock.metadata,
				rebound: reboundLock,
			});
			return false;
		}
		return true;
	} finally {
		await releaseDaemonTransitionLock({ fs: fsImpl, path: paths.steal, lock: transition });
	}
}

/** Wait for a matching compatible owner to publish a ready state. Readiness is serving-epoch gated (same-epoch cross-generation owners attach, per isCurrentCompatibleOwner); generation is inventory-only here. Mutation paths still require exact current-generation equality. */
export async function waitForTelegramDaemonReady(input: {
	settings: Settings;
	ownerId?: string;
	acquisitionId?: string;
	pid?: number;
	excludedPid?: number;
	tokenFingerprint: string;
	chatId: string;
	fs?: TelegramDaemonFs;
	now?: () => number;
	pidAlive?: (pid: number) => boolean;
	pidIncarnation?: (pid: number) => string | undefined;
	sleep?: (ms: number) => Promise<void>;
	waitStepMs?: number;
	timeoutMs?: number;
}): Promise<boolean> {
	const now = input.now ?? Date.now;
	const pidAlive = input.pidAlive ?? defaultPidAlive;
	const pidIncarnation = input.pidIncarnation ?? defaultPidIncarnation;
	const sleep = input.sleep ?? (async (ms: number) => await Bun.sleep(ms));
	const timeoutMs = Math.max(input.timeoutMs ?? 8_000, 0);
	const waitStepMs = Math.max(input.waitStepMs ?? 25, 1);
	const deadline = now() + timeoutMs;
	const maxPolls = Math.ceil(timeoutMs / waitStepMs);
	for (let poll = 0; poll <= maxPolls; poll++) {
		const snapshot = await readOwnerFreshnessSnapshot({ settings: input.settings, fs: input.fs });
		const state = snapshot.state;
		if (
			(!input.ownerId || state?.ownerId === input.ownerId) &&
			(!input.acquisitionId || state?.acquisitionId === input.acquisitionId) &&
			state?.ownershipPhase === "ready" &&
			Number.isSafeInteger(state.generation) &&
			ownerIdentityMatches(state, input.tokenFingerprint, input.chatId) &&
			ownerProvenanceMatches(state, pidIncarnation) &&
			pidAlive(state.pid) &&
			(Number.isSafeInteger(input.pid) && (input.pid as number) > 0
				? state.pid === input.pid
				: !Number.isSafeInteger(input.excludedPid) || state.pid !== input.excludedPid) &&
			isCurrentCompatibleOwner({
				state,
				now: now(),
				tokenFingerprint: input.tokenFingerprint,
				chatId: input.chatId,
				pidAlive,
				pidIncarnation,
				effectiveHeartbeatAt: snapshot.effectiveHeartbeatAt,
			})
		)
			return true;
		if (now() >= deadline || poll === maxPolls) break;
		await sleep(waitStepMs);
	}
	return false;
}

/** Confirm the provisional owner or retire only its unchanged acquisition. */
export async function confirmTelegramDaemonSpawn(input: {
	settings: Settings;
	spawned: TelegramSpawnOwnerResult;
	tokenFingerprint: string;
	chatId: string;
	pid: number;
	fs?: TelegramDaemonFs;
	now?: () => number;
	pidAlive?: (pid: number) => boolean;
	pidIncarnation?: (pid: number) => string | undefined;
	sleep?: (ms: number) => Promise<void>;
	waitStepMs?: number;
	timeoutMs?: number;
	/** Retain an unproven no-PID child lease during a successor handoff. */
	preserveOnUnprovenChildExit?: boolean;
}): Promise<boolean> {
	if (input.spawned.result !== "owner_spawned") return true;
	const childPid = input.spawned.acquisition.pid;
	const hasExactChildPid = Number.isSafeInteger(childPid) && (childPid as number) > 0;
	const ready = await waitForTelegramDaemonReady({
		settings: input.settings,
		ownerId: input.spawned.acquisition.ownerId,
		acquisitionId: input.spawned.acquisition.acquisitionId,
		pid: hasExactChildPid ? childPid : undefined,
		excludedPid: hasExactChildPid ? undefined : input.pid,
		tokenFingerprint: input.tokenFingerprint,
		chatId: input.chatId,
		fs: input.fs,
		now: input.now,
		pidAlive: input.pidAlive,
		pidIncarnation: input.pidIncarnation,
		sleep: input.sleep,
		waitStepMs: input.waitStepMs,
		timeoutMs: input.timeoutMs,
	});
	if (ready) return true;
	// An identified live child remains fenced. A no-PID launch retains its lease
	// only when a successor handoff explicitly requests that protection; ordinary
	// confirmation keeps the historical cleanup behavior.
	if (
		(hasExactChildPid && (input.pidAlive ?? defaultPidAlive)(childPid as number)) ||
		(!hasExactChildPid && input.preserveOnUnprovenChildExit)
	)
		return false;
	const launcherPid = input.spawned.acquisition.launcherPid ?? input.pid;
	const retired = await retireProvisionalDaemonOwnership({
		settings: input.settings,
		ownerId: input.spawned.acquisition.ownerId,
		acquisitionId: input.spawned.acquisition.acquisitionId,
		pid: hasExactChildPid ? (childPid as number) : launcherPid,
		launcherPid,
		allowReadyWithoutChildPid: !hasExactChildPid,
		fs: input.fs,
		now: input.now,
		pidAlive: input.pidAlive,
		pidIncarnation: input.pidIncarnation,
		sleep: input.sleep,
	});
	if (retired) return false;
	const snapshot = await readOwnerFreshnessSnapshot({ settings: input.settings, fs: input.fs });
	const state = snapshot.state;
	if (
		hasExactChildPid &&
		isCurrentCompatibleOwner({
			state,
			now: (input.now ?? Date.now)(),
			tokenFingerprint: input.tokenFingerprint,
			chatId: input.chatId,
			pidAlive: input.pidAlive ?? defaultPidAlive,
			pidIncarnation: input.pidIncarnation ?? defaultPidIncarnation,
			effectiveHeartbeatAt: snapshot.effectiveHeartbeatAt,
		}) &&
		(state?.ownerId !== input.spawned.acquisition.ownerId ||
			state.acquisitionId !== input.spawned.acquisition.acquisitionId ||
			state.pid === childPid)
	)
		return true;
	if (
		state?.ownerId === input.spawned.acquisition.ownerId &&
		state.acquisitionId === input.spawned.acquisition.acquisitionId &&
		(state.pid === childPid || state.pid === launcherPid || state.pid === input.pid) &&
		state.ownershipPhase === "retired"
	)
		return false;
	throw new Error("Telegram daemon provisional ownership could not be retired safely");
}

export async function releaseDaemonOwnership(input: {
	settings: Settings;
	ownerId: string;
	acquisitionId?: string;
	tokenFingerprint?: string;
	chatId?: string;
	pid?: number;
	generation?: number;
	pidIncarnation?: (pid: number) => string | undefined;
	fs?: TelegramDaemonFs;
	now?: () => number;
}): Promise<void> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	const transition = await acquireTransitionLock({
		fs: fsImpl,
		path: paths.steal,
		pidIncarnation: input.pidIncarnation,
	});
	if (!transition) return;
	try {
		const state = await readJson<DaemonState>(fsImpl, paths.state);
		const acquisitionId = input.acquisitionId ?? input.ownerId;
		const pid = input.pid ?? state?.pid;
		const generation = input.generation ?? state?.generation;
		const incarnation = (input.pidIncarnation ?? defaultPidIncarnation)(pid ?? 0);
		if (
			!hasSafeDaemonStateShape(state) ||
			state.ownerId !== input.ownerId ||
			state.acquisitionId !== acquisitionId ||
			(input.tokenFingerprint !== undefined && state.tokenFingerprint !== input.tokenFingerprint) ||
			(input.chatId !== undefined && state.chatId !== input.chatId) ||
			state.pid !== pid ||
			!isProcessIncarnation(incarnation) ||
			state.incarnation !== incarnation ||
			state.generation !== generation ||
			!Number.isSafeInteger(generation)
		)
			return;
		if (!(await transitionLockIsHeldByCaller({ fs: fsImpl, path: paths.steal, lock: transition }))) return;
		const lock = await readOwnershipLock(fsImpl, paths.lock);
		if (!ownershipLockMatchesState(lock, state)) return;
		await writeJsonAtomic(fsImpl, paths.state, { ...state, stoppedAt: (input.now ?? Date.now)() });
		if (await transitionLockIsHeldByCaller({ fs: fsImpl, path: paths.steal, lock: transition }))
			await unlinkOwnershipLockExactly(fsImpl, paths.lock, lock);
	} finally {
		await releaseDaemonTransitionLock({ fs: fsImpl, path: paths.steal, lock: transition });
	}
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

/** Injectable readers for {@link resolveTelegramSetupPreflight}, defaulting to the real OS/state probes. */
export interface ResolveTelegramSetupPreflightDeps {
	readDaemonState?: (settings: Settings) => Promise<DaemonState | undefined>;
	pidAlive?: (pid: number) => boolean;
	pidIncarnation?: (pid: number) => string | undefined;
}

/**
 * Build the Telegram setup preflight from persisted daemon state. The daemon is
 * reported live ONLY when its PID is alive AND its current process incarnation
 * still matches the persisted incarnation. Skipping the incarnation check makes
 * a stale state file whose PID has been recycled by an unrelated process
 * masquerade as a live owner, which wrongly blocks discovery pairing. Both the
 * `notify setup` CLI and the /settings Notifications tab share this resolver so
 * pairing behaves identically on both surfaces.
 */
export async function resolveTelegramSetupPreflight(
	settings: Settings,
	deps: ResolveTelegramSetupPreflightDeps = {},
): Promise<TelegramSetupPreflight> {
	const storedChatId = getNotificationConfig(settings).chatId;
	const pidAlive = deps.pidAlive ?? defaultPidAlive;
	const pidIncarnation = deps.pidIncarnation ?? defaultPidIncarnation;
	try {
		const state = await (deps.readDaemonState ?? readDaemonState)(settings);
		if (!state) return { storedChatId };
		const validPid = Number.isSafeInteger(state.pid) && state.pid > 0;
		if (!validPid || !pidAlive(state.pid)) return { storedChatId };
		const persistedIncarnation = state.incarnation;
		const currentIncarnation = pidIncarnation(state.pid);
		if (
			!isProcessIncarnation(persistedIncarnation) ||
			!isProcessIncarnation(currentIncarnation) ||
			persistedIncarnation !== currentIncarnation
		)
			return { storedChatId };
		return {
			storedChatId,
			daemon: {
				live: true,
				tokenFingerprint: typeof state.tokenFingerprint === "string" ? state.tokenFingerprint : undefined,
				chatId: typeof state.chatId === "string" ? state.chatId : undefined,
			},
		};
	} catch {
		// A state read failure is not proof of a live daemon; proceed normally. The
		// daemon's own 409 handling remains the backstop against poller contention.
		return { storedChatId };
	}
}

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/**
 * Use immutable process-start provenance on every supported OS. In particular,
 * Windows is authorized by the native process API or PowerShell StartTime/FileTime;
 * absent authority fails closed and never trusts the numeric PID alone.
 */
function defaultPidIncarnation(pid: number): string | undefined {
	return processIncarnation(pid);
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
	return { pid: child.pid, unref: () => child.unref() };
}

export interface TelegramSpawnOwnerInput {
	settings: Settings;
	roots?: string[];
	tokenFingerprint: string;
	chatId: string;
	/** Ephemeral outbound-only validation destination for this owner launch. */
	validationTestSupergroupChatId?: string;
}

export interface TelegramSpawnAcquisition {
	readonly ownerId: string;
	readonly acquisitionId: string;
	/** PID of the launcher which reserved provisional ownership before spawn. */
	readonly launcherPid?: number;
	/** Actual detached child which must publish the ready owner state. */
	readonly pid?: number;
}

export type TelegramSpawnOwnerResult =
	| { result: "owner_spawned"; acquisition: TelegramSpawnAcquisition; runtime: DaemonRuntimeInfo; warnings: string[] }
	| {
			result: "attached";
			runtime: DaemonRuntimeInfo;
			warnings: string[];
			reloadRequired?: boolean;
			legacyReloadRequired?: boolean;
	  }
	| { result: "blocked"; runtime: DaemonRuntimeInfo; warnings: string[]; reloadRequired?: boolean };

/**
 * Build the detached spawn command/args for the daemon-internal entrypoint.
 * Source mode prepends the entry script so the respawn loads edited source;
 * a compiled binary self-spawns its own subcommand directly.
 */
export function buildTelegramDaemonSpawnArgs(input: {
	execPath?: string;
	ownerId: string;
	agentDir: string;
	validationTestSupergroupChatId?: string;
}): {
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
		...(input.validationTestSupergroupChatId !== undefined
			? ["--validation-test-supergroup-chat-id", input.validationTestSupergroupChatId]
			: []),
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
		pidIncarnation: deps.pidIncarnation,
		randomId: ownerId ? undefined : deps.randomId,
		ownerId,
	});
	if (!ownership.acquired) {
		if (ownership.blocked || ownership.provisional) {
			return {
				result: "blocked",
				runtime: buildTelegramDaemonSpawnArgs({ execPath, ownerId: "", agentDir }).runtime,
				warnings: [
					ownership.provisional
						? "telegram daemon ownership is provisional; refusing to attach"
						: "live telegram daemon uses a different bot token or chat; refusing to attach",
				],
			};
		}
		return {
			result: "attached",
			runtime: buildTelegramDaemonSpawnArgs({ execPath, ownerId: "", agentDir }).runtime,
			warnings: [],
			reloadRequired: ownership.reloadRequired,
			legacyReloadRequired: ownership.legacyReloadRequired,
		};
	}
	const launcherPid = deps.pid ?? process.pid;
	const provisionalAcquisition: TelegramSpawnAcquisition = Object.freeze({
		ownerId: ownership.ownerId as string,
		acquisitionId: ownership.acquisitionId as string,
		launcherPid,
	});
	// One source of truth for runtime detection + spawn args (no duplicate resolve).
	const { command, args, runtime } = buildTelegramDaemonSpawnArgs({
		execPath,
		ownerId: provisionalAcquisition.ownerId,
		agentDir,
		validationTestSupergroupChatId: input.validationTestSupergroupChatId,
	});
	const spawnImpl = deps.spawn ?? defaultDaemonSpawn;
	const child = spawnImpl(command, args, {
		detached: true,
		stdio: "ignore",
		logPath: path.join(daemonPaths(agentDir).dir, "daemon.log"),
	});
	child?.unref?.();
	// A launcher can reserve ownership, but only the actual child can become
	// ready. Missing PID provenance is intentionally non-ready and times out.
	const childPid = child?.pid;
	if (!Number.isSafeInteger(childPid) || (childPid as number) <= 0)
		return { result: "owner_spawned", acquisition: provisionalAcquisition, runtime, warnings: [] };
	const pid = childPid as number;
	const acquisition: TelegramSpawnAcquisition = Object.freeze({ ...provisionalAcquisition, pid });
	const incarnation = (deps.pidIncarnation ?? defaultPidIncarnation)(pid);
	if (!incarnation) return { result: "owner_spawned", acquisition, runtime, warnings: [] };
	await bindProvisionalDaemonPid({
		settings: input.settings,
		ownerId: acquisition.ownerId,
		acquisitionId: acquisition.acquisitionId,
		incarnation,
		pid,
		fs: deps.fs,
		sleep: deps.sleep,
	});
	return { result: "owner_spawned", acquisition, runtime, warnings: [] };
}

/**
 * Owner-bound reclamation of a confirmed-dead daemon owner, mirroring the
 * daemon step of `gjc notify recovery`. It returns a structured, actionable
 * result and removes only identity-verified dead-owner artifacts while holding
 * the transition fence; live, successor, unknown, or unreadable evidence is
 * retained.
 */
export type DeadOwnerRecoveryResult =
	| { recovered: true; reason: "cleared" }
	| {
			recovered: false;
			reason:
				| "not-confirmed-dead"
				| "unsafe-lock"
				| "transition-contended"
				| "owner-superseded"
				| "unsafe-endpoint"
				| "endpoint-changed"
				| "endpoint-directory-unreadable"
				| "lock-changed";
	  };

/** Preflight cleanup for a confirmed-dead owner, with identity-bound removal. */
export async function reclaimDeadDaemonOwner(input: {
	settings: Settings;
	endpointDir?: string;
	fs?: TelegramDaemonFs;
	now?: () => number;
	pidAlive?: (pid: number) => boolean;
	pidIncarnation?: (pid: number) => string | undefined;
}): Promise<DeadOwnerRecoveryResult> {
	const fsImpl = input.fs ?? nodeFs;
	const now = input.now ?? Date.now;
	const pidAlive = input.pidAlive ?? defaultPidAlive;
	const pidIncarnation = input.pidIncarnation ?? defaultPidIncarnation;
	const paths = daemonPaths(input.settings.getAgentDir());
	const state = await readDaemonState(input.settings, fsImpl);
	if (!state || !hasSafeDaemonStateShape(state) || pidAlive(state.pid))
		return { recovered: false, reason: "not-confirmed-dead" };
	const lock = await readOwnershipLock(fsImpl, paths.lock);
	if (
		!(await ownershipLockIsReclaimable({ fs: fsImpl, path: paths.lock, lock, now: now(), pidAlive, pidIncarnation }))
	)
		return { recovered: false, reason: "unsafe-lock" };
	const transition = await acquireDaemonTransitionLock({
		fs: fsImpl,
		path: paths.steal,
		pid: process.pid,
		pidAlive: defaultPidAlive,
		pidIncarnation: defaultPidIncarnation,
	});
	const readEndpointFile = fsImpl.readEndpointFile;
	if (!transition || !readEndpointFile || !fsImpl.exactUnlink)
		return { recovered: false, reason: "transition-contended" };
	try {
		const current = await readDaemonState(input.settings, fsImpl);
		if (
			!current ||
			!hasSafeDaemonStateShape(current) ||
			current.ownerId !== state.ownerId ||
			current.acquisitionId !== state.acquisitionId ||
			current.pid !== state.pid ||
			current.incarnation !== state.incarnation ||
			current.generation !== state.generation ||
			current.ownershipPhase !== state.ownershipPhase ||
			current.tokenFingerprint !== state.tokenFingerprint ||
			current.chatId !== state.chatId ||
			pidAlive(current.pid)
		)
			return { recovered: false, reason: "owner-superseded" };
		const currentLock = await readOwnershipLock(fsImpl, paths.lock);
		if (
			!ownershipLockMatches(lock, currentLock) ||
			!(await ownershipLockIsReclaimable({
				fs: fsImpl,
				path: paths.lock,
				lock: currentLock,
				now: now(),
				pidAlive,
				pidIncarnation,
			})) ||
			!(await transitionLockIsHeldByCaller({ fs: fsImpl, path: paths.steal, lock: transition }))
		)
			return { recovered: false, reason: "unsafe-lock" };
		const endpoints: Array<{ file: string; identity: NotificationEndpointFileIdentity }> = [];
		if (input.endpointDir) {
			let names: string[];
			try {
				names = await fsImpl.readdir(input.endpointDir);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") names = [];
				else return { recovered: false, reason: "endpoint-directory-unreadable" };
			}
			for (const name of names) {
				if (!name.endsWith(".json")) continue;
				const file = path.join(input.endpointDir, name);
				const endpoint = await classifyNotificationEndpoint(
					{ readEndpointFile: fsImpl.readEndpointFile! },
					file,
					pidAlive,
				);
				if (endpoint.kind === "non-endpoint") continue;
				if (endpoint.kind !== "endpoint" || endpoint.liveness !== "dead")
					return { recovered: false, reason: "unsafe-endpoint" };
				endpoints.push({ file, identity: endpoint.identity });
			}
		}
		if (!(await transitionLockIsHeldByCaller({ fs: fsImpl, path: paths.steal, lock: transition })))
			return { recovered: false, reason: "transition-contended" };
		for (const endpoint of endpoints)
			if (!(await exactUnlinkAcceptedWithRetainedEvidence(fsImpl, endpoint.file, endpoint.identity)))
				return { recovered: false, reason: "endpoint-changed" };
		if (currentLock.kind === "missing") return { recovered: true, reason: "cleared" };
		const exactLock = await fsImpl.readEndpointFile!(paths.lock).catch(() => undefined);
		const exactCurrentLock = await readOwnershipLock(fsImpl, paths.lock);
		if (
			!exactLock ||
			!ownershipLockMatches(currentLock, exactCurrentLock) ||
			!(await transitionLockIsHeldByCaller({ fs: fsImpl, path: paths.steal, lock: transition }))
		)
			return { recovered: false, reason: "lock-changed" };
		return (await exactUnlinkAcceptedWithRetainedEvidence(fsImpl, paths.lock, exactLock.identity))
			? { recovered: true, reason: "cleared" }
			: { recovered: false, reason: "lock-changed" };
	} finally {
		await releaseDaemonTransitionLock({ fs: fsImpl, path: paths.steal, lock: transition });
	}
}

/**
 * Ensure a configured daemon owns this session root, preserving ownership safety
 * while exposing whether a #2028 generation handoff was required.
 */
async function ensureTelegramDaemonRunningDetailedOnce(
	input: {
		settings: Settings;
		cwd: string;
		sessionId: string;
		registerRoot?: boolean;
		/** Receives each registration this ensure operation minted so the caller can fence its own later cleanup. */
		onRegistered?: (registration: RegisterNotificationRootResult) => void;
	},
	deps: TelegramDaemonDeps = {},
): Promise<EnsureTelegramDaemonDetailedResult> {
	const cfg = getNotificationConfig(input.settings);
	if (!isProviderEffectivelyEnabled(cfg, "telegram") || !isTelegramComplete(cfg)) return "disabled";
	const root = notificationRootForCwd(input.cwd);
	const fp = tokenFingerprint(cfg.botToken);
	// A live v0.10 parent has no stable process authority on Windows. Never turn an
	// unproven cooperative handoff into destructive cleanup or a replacement spawn.
	if ((deps.platform ?? process.platform) === "win32") {
		const parentState: unknown = await readDaemonState(input.settings, deps.fs);
		if (
			isParentDaemonState(parentState) &&
			(deps.pidAlive ?? defaultPidAlive)(parentState.pid) &&
			(!hasSafeDaemonStateShape(parentState) || ownerProvenanceMatches(parentState, deps.pidIncarnation))
		)
			return "blocked_identity";
	}
	// Windows can retain dead launcher metadata without an ownership lock; reclaim
	// its dead discovery records before the replacement can publish a new owner.
	if ((deps.platform ?? process.platform) === "win32" && !deps.fs) {
		let preflight = await reclaimDeadDaemonOwner({
			settings: input.settings,
			endpointDir: path.join(root, "sdk"),
			fs: deps.fs,
			now: deps.now,
			pidAlive: deps.pidAlive,
			pidIncarnation: deps.pidIncarnation,
		});
		// A just-reused PID can be reported alive for the first probe. Recheck once
		// before acquisition only when stale discovery records need fenced cleanup.
		// reclaimDeadDaemonOwner still requires exact state, lock, incarnation,
		// transition-lock, and endpoint-identity proofs before deleting anything.
		const endpointNames =
			preflight.reason === "not-confirmed-dead"
				? await (deps.fs ?? nodeFs).readdir(path.join(root, "sdk")).catch(() => undefined)
				: undefined;
		if (
			!preflight.recovered &&
			preflight.reason === "not-confirmed-dead" &&
			endpointNames?.some(name => name.endsWith(".json"))
		) {
			preflight = await reclaimDeadDaemonOwner({
				settings: input.settings,
				endpointDir: path.join(root, "sdk"),
				fs: deps.fs,
				now: deps.now,
				pidAlive: deps.pidAlive,
				pidIncarnation: deps.pidIncarnation,
			});
		}
		if (!preflight.recovered && preflight.reason !== "not-confirmed-dead") {
			logger.warn(
				`notifications: startup recovery unsafe (${preflight.reason}); run \`gjc notify recovery\` for diagnostics`,
			);
			return "blocked_identity";
		}
	}
	let spawned = await withTelegramSetupLease(
		cfg.botToken,
		async () =>
			await spawnTelegramDaemonOwner(
				{ settings: input.settings, roots: [root], tokenFingerprint: fp, chatId: cfg.chatId },
				deps,
			),
	);
	if (spawned.result === "blocked" && spawned.warnings[0]?.includes("provisional")) {
		const provisional = await readDaemonState(input.settings, deps.fs);
		// A launcher-reserved PID can be rebound by the child heartbeat. Only a
		// state marked by bindProvisionalDaemonPid has an authoritative child PID.
		const hasAuthoritativeChildPid =
			Number.isSafeInteger(provisional?.launcherPid) && (provisional?.launcherPid as number) > 0;
		const ready = await waitForTelegramDaemonReady({
			settings: input.settings,
			ownerId: provisional?.ownerId,
			acquisitionId: provisional?.acquisitionId,
			pid: hasAuthoritativeChildPid ? provisional?.pid : undefined,
			excludedPid: hasAuthoritativeChildPid ? undefined : provisional?.pid,
			tokenFingerprint: fp,
			chatId: cfg.chatId,
			fs: deps.fs,
			now: deps.now,
			pidAlive: deps.pidAlive,
			pidIncarnation: deps.pidIncarnation,
			sleep: deps.sleep,
			waitStepMs: deps.waitStepMs,
			timeoutMs: deps.readinessTimeoutMs,
		});
		// A legacy parent cannot satisfy the current ready-state shape, but the
		// bounded wait gives its heartbeat a second observation window. Retry the
		// acquisition once so legacyParentHandoffDecision can consume that
		// attestation before startup treats the owner as blocked.
		if (ready || isLegacyParentDaemonState(provisional)) {
			spawned = await withTelegramSetupLease(
				cfg.botToken,
				async () =>
					await spawnTelegramDaemonOwner(
						{ settings: input.settings, roots: [root], tokenFingerprint: fp, chatId: cfg.chatId },
						deps,
					),
			);
		}
	}
	let recoveryReason: Extract<DeadOwnerRecoveryResult, { recovered: false }>["reason"] | undefined;
	if (spawned.result === "blocked" && !spawned.warnings[0]?.includes("provisional")) {
		const recovery = await reclaimDeadDaemonOwner({
			settings: input.settings,
			endpointDir: path.join(root, "sdk"),
			fs: deps.fs,
			now: deps.now,
			pidAlive: deps.pidAlive,
			pidIncarnation: deps.pidIncarnation,
		});
		if (recovery.recovered) {
			spawned = await withTelegramSetupLease(
				cfg.botToken,
				async () =>
					await spawnTelegramDaemonOwner(
						{ settings: input.settings, roots: [root], tokenFingerprint: fp, chatId: cfg.chatId },
						deps,
					),
			);
		} else recoveryReason = recovery.reason;
	}
	if (spawned.result === "blocked") {
		logger.warn(
			`notifications: failed to ensure Telegram daemon: ${recoveryReason ? `stale recovery ${recoveryReason}; run \`gjc notify recovery\`` : spawned.warnings.join("; ")}`,
		);
		return "blocked_identity";
	}
	if (spawned.result === "attached" && spawned.reloadRequired) {
		const previous = await readNotificationRootRegistration({ ...input, fs: deps.fs });
		let registeredToken: string | undefined;
		if (input.registerRoot !== false) {
			const registered = await registerNotificationRoot({ ...input, fs: deps.fs });
			registeredToken = registered.token;
			input.onRegistered?.(registered);
		}
		const fsImpl = deps.fs ?? nodeFs;
		const now = deps.now ?? Date.now;
		const pidAlive = deps.pidAlive ?? defaultPidAlive;
		const pidIncarnation = deps.pidIncarnation ?? defaultPidIncarnation;
		const reloadAttemptPath = path.join(
			daemonPaths(input.settings.getAgentDir()).dir,
			"telegram-daemon.reload-attempt.json",
		);
		await ensureDir(fsImpl, daemonPaths(input.settings.getAgentDir()).dir);
		const reloadWaitStepMs = Math.max(deps.waitStepMs ?? 100, 1);
		const reloadFreshnessWaitMs = Math.max(deps.readinessTimeoutMs ?? RELOAD_FRESHNESS_WAIT_MS, reloadWaitStepMs);
		const reloadReadinessTimeoutMs = deps.readinessTimeoutMs ?? RELOAD_FRESHNESS_WAIT_MS;
		const reloadResult = await withFileLock(
			reloadAttemptPath,
			async () => {
				const currentState = await readDaemonState(input.settings, fsImpl);
				const previousAttempt = await readJson<{
					lastReloadAt?: number;
					ownerId?: string;
					targetGeneration?: number;
				}>(fsImpl, reloadAttemptPath).catch(() => undefined);
				const reloadNow = now();
				const cooldownApplies =
					previousAttempt?.targetGeneration === DAEMON_GENERATION &&
					typeof previousAttempt.lastReloadAt === "number" &&
					Number.isFinite(previousAttempt.lastReloadAt) &&
					reloadNow - previousAttempt.lastReloadAt < AUTOMATIC_RELOAD_COOLDOWN_MS;
				if (cooldownApplies) {
					// A sibling ensure may have just finished its reload. Its replacement
					// daemon heartbeats only after startup, so wait briefly for the fresh
					// ready owner instead of issuing a duplicate reload in the gap.
					const sleep = deps.sleep ?? Bun.sleep;
					const waitStepMs = reloadWaitStepMs;
					const waitBudgetMs = reloadFreshnessWaitMs;
					const deadline = reloadNow + waitBudgetMs;
					// Iteration-capped so a frozen `now` cannot spin forever.
					const maxWaits = Math.ceil(waitBudgetMs / waitStepMs);
					for (let waits = 0; waits <= maxWaits; waits++) {
						const snapshot = await readOwnerFreshnessSnapshot({ settings: input.settings, fs: fsImpl });
						const state = snapshot.state;
						const t = now();
						if (
							isCurrentCompatibleOwner({
								state,
								now: t,
								tokenFingerprint: fp,
								chatId: cfg.chatId,
								pidAlive,
								pidIncarnation,
								effectiveHeartbeatAt: snapshot.effectiveHeartbeatAt,
							})
						)
							return "attached" as const;
						if (t >= deadline) break;
						await sleep(waitStepMs);
					}
					// Keep the reservation after a failed reload so concurrent ensures do not
					// repeatedly signal the same incompatible predecessor. Surface the failed
					// convergence; the next ensure after cooldown expiry retries the reload.
					return "blocked_identity" as const;
				}
				await writeJsonAtomic(fsImpl, reloadAttemptPath, {
					lastReloadAt: reloadNow,
					ownerId: currentState?.ownerId ?? "",
					targetGeneration: DAEMON_GENERATION,
				});
				const controller = new TelegramDaemonController(input.settings, telegramControllerDeps(deps));
				const upgrade = await controller.reloadForGenerationUpgrade({}, spawned.legacyReloadRequired === true);
				return upgrade.outcome === "ready" ? ("reloaded" as const) : upgrade;
			},
			reloadReservationLockOptions({
				freshnessWaitMs: reloadFreshnessWaitMs,
				readinessTimeoutMs: reloadReadinessTimeoutMs,
				retryDelayMs: reloadWaitStepMs,
			}),
		);
		if (reloadResult === "attached") return "attached";
		if (reloadResult === "blocked_identity") {
			await restoreNotificationRootRegistration({
				settings: input.settings,
				sessionId: input.sessionId,
				registeredRoot: root,
				registeredToken,
				previous,
				fs: deps.fs,
			});
			return "blocked_identity";
		}
		if (reloadResult !== "reloaded") {
			await restoreNotificationRootRegistration({
				settings: input.settings,
				sessionId: input.sessionId,
				registeredRoot: root,
				registeredToken,
				previous,
				fs: deps.fs,
			});
			throw new Error(`Unable to replace stale Telegram daemon: ${reloadResult.operation.message}`);
		}
		return "reloaded";
	}
	if (spawned.result !== "owner_spawned") {
		if (input.registerRoot !== false) {
			const registered = await registerNotificationRoot({ ...input, fs: deps.fs });
			input.onRegistered?.(registered);
		}
		return "attached";
	}
	if (
		await confirmTelegramDaemonSpawn({
			settings: input.settings,
			spawned,
			tokenFingerprint: fp,
			chatId: cfg.chatId,
			pid: deps.pid ?? process.pid,
			fs: deps.fs,
			now: deps.now,
			pidAlive: deps.pidAlive,
			pidIncarnation: deps.pidIncarnation,
			sleep: deps.sleep,
			waitStepMs: deps.waitStepMs,
			timeoutMs: deps.readinessTimeoutMs,
		})
	) {
		if (input.registerRoot !== false) {
			const registered = await registerNotificationRoot({ ...input, fs: deps.fs });
			input.onRegistered?.(registered);
		}
		return "spawned";
	}
	throw new Error("Telegram daemon did not become ready after spawning");
}

/**
 * Ensure a configured daemon owns this session root, preserving ownership safety
 * while exposing whether a #2028 generation handoff was required.
 */
export async function ensureTelegramDaemonRunningDetailed(
	input: {
		settings: Settings;
		cwd: string;
		sessionId: string;
		registerRoot?: boolean;
		/** Receives each registration this ensure operation minted so the caller can fence its own later cleanup. */
		onRegistered?: (registration: RegisterNotificationRootResult) => void;
	},
	deps: TelegramDaemonDeps = {},
): Promise<EnsureTelegramDaemonDetailedResult> {
	const result = await ensureTelegramDaemonRunningDetailedOnce(input, deps);
	if (input.registerRoot === false || (result !== "attached" && result !== "spawned")) return result;

	const cfg = getNotificationConfig(input.settings);
	if (!isProviderEffectivelyEnabled(cfg, "telegram") || !isTelegramComplete(cfg)) return "disabled";
	const ownerIsCurrent = async (): Promise<boolean> => {
		const snapshot = await readOwnerFreshnessSnapshot({ settings: input.settings, fs: deps.fs });
		return isCurrentCompatibleOwner({
			state: snapshot.state,
			now: (deps.now ?? Date.now)(),
			tokenFingerprint: tokenFingerprint(cfg.botToken),
			chatId: cfg.chatId,
			pidAlive: deps.pidAlive ?? defaultPidAlive,
			pidIncarnation: deps.pidIncarnation ?? defaultPidIncarnation,
			effectiveHeartbeatAt: snapshot.effectiveHeartbeatAt,
		});
	};
	if (await ownerIsCurrent()) return result;

	const converged = await ensureTelegramDaemonRunningDetailedOnce({ ...input, registerRoot: false }, deps);
	if (converged === "disabled" || converged === "blocked_identity") return converged;
	return (await ownerIsCurrent()) ? converged : "blocked_identity";
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

function telegramControllerDeps(deps: TelegramDaemonDeps): TelegramDaemonControlDeps {
	// The legacy signal seam has no authority metadata of its own. Pair it with
	// the captured process incarnation so the controller retains its identity
	// fence; Windows continues through its hard-authority refusal path.
	const cooperativeSignalReference =
		deps.sendSignal && (deps.platform ?? process.platform) !== "win32"
			? (pid: number): DaemonProcessReference | undefined => {
					const incarnation = deps.pidIncarnation?.(pid);
					if (!isProcessIncarnation(incarnation)) return undefined;
					return {
						incarnation,
						termination: "cooperative",
						signalRoot: signal => deps.sendSignal!(pid, signal),
					};
				}
			: undefined;
	return {
		fs: deps.fs,
		now: deps.now,
		pidAlive: deps.pidAlive,
		processReference: cooperativeSignalReference ?? deps.processReference,
		pidIncarnation: deps.pidIncarnation,
		platform: deps.platform,
		spawn: deps.spawn,
		execPath: deps.execPath,
		ownerPid: deps.pid,
		randomId: deps.randomId,
		sleep: deps.sleep,
		waitStepMs: deps.waitStepMs,
		readinessTimeoutMs: deps.readinessTimeoutMs,
	};
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
				disable_notification?: boolean;
			};
			const form = new FormData();
			form.set("chat_id", String(b.chat_id));
			if (b.message_thread_id !== undefined) form.set("message_thread_id", String(b.message_thread_id));
			if (b.caption) form.set("caption", b.caption);
			if (b.parse_mode) form.set("parse_mode", String(b.parse_mode));
			if (b.disable_notification === true) form.set("disable_notification", "true");
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
				disable_notification?: boolean;
			};
			const form = new FormData();
			form.set("chat_id", String(b.chat_id));
			if (b.message_thread_id !== undefined) form.set("message_thread_id", String(b.message_thread_id));
			if (b.caption) form.set("caption", b.caption);
			if (b.parse_mode) form.set("parse_mode", String(b.parse_mode));
			if (b.disable_notification === true) form.set("disable_notification", "true");
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

type PairedChatPrivacy = "private" | "validation-forum" | "non-private" | "indeterminate";

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
	backoff: { next(): number; reset(): void };
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

class JitteredPollConflictBackoff {
	#currentMs = 0;

	next(): number {
		if (this.#currentMs === 0) this.#currentMs = POLL_BACKOFF_MS;
		else this.#currentMs = Math.min(this.#currentMs * (1.5 + Math.random() * 0.5), 10_000);
		return this.#currentMs;
	}

	reset(): void {
		this.#currentMs = 0;
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
	readonly inboundReactions = new Map<
		number,
		{ messageId: number; socketLease?: { session: SessionSocket; token: number; logicalSessionId: string } }
	>();
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

type BtwTerminalDeliveryOutcome = "accepted" | "not_delivered" | "uncertain" | "partial_accepted" | "stale";

interface BtwTerminalDeliveryReceipt {
	requestId: string;
	logicalSessionId: string;
	transportSessionId: string;
	threadId: string;
	updateId: number;
	messageId: number;
	outcome: BtwTerminalDeliveryOutcome;
}

const BTW_TERMINAL_DELIVERY_TEST_OBSERVER = Symbol.for("gjc.test.btw-terminal-delivery-observer");

export interface TelegramDaemonOptions {
	settings: Settings;
	ownerId: string;
	botToken: string;
	chatId: string;
	/**
	 * Exact ephemeral forum destination supplied to the daemon-internal validation
	 * command. Production ownership, pairing, and durable topic authority remain
	 * bound to `chatId`.
	 */
	validationTestSupergroupChatId?: string;
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
	/** TTL for durable topic-adoption intents (default 10 minutes). Observed, not a fixed contract. */
	adoptionIntentTtlMs?: number;
	scanIntervalMs?: number;
	pid?: number;
	/** Liveness probe for skipping dead-PID endpoint records in {@link TelegramNotificationDaemon.scanRoots}. */
	pidAlive?: (pid: number) => boolean;
	pidIncarnation?: (pid: number) => string | undefined;
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
	/** Tool start/completion messages (off by default; explicit opt-in only). */
	toolActivity?: { enabled: boolean };
	/** Controls which Telegram sends play an audible notification. Defaults to all. */
	sound?: "all" | "important" | "none";
	/**
	 * Per-session Telegram forum-topic naming. `nameTemplate` supports the
	 * `{repo}`, `{branch}`, and `{title}` placeholders; unset preserves the
	 * built-in `{repo}/{branch} - {title}` composition and its fallbacks.
	 */
	topics?: { nameTemplate?: string };
	/**
	 * Optional compare-and-set store for installations that share topic state
	 * across hosts. When configured, every publication is fenced by it.
	 */
	topicRegistryAuthority?: TopicRegistryCasAuthority;
	/** Stable host-local identity. Required whenever a shared authority is configured. */
	installationHostId?: string;
}

interface StagedCallbackActivation {
	pending: { sessionId: string; actionId: string };
	socketLease: { session: SessionSocket; token: number; logicalSessionId: string };
	topicLease?: TopicAuthorityLease;
	settled: Promise<boolean>;
}

interface SessionSocket {
	/** Immutable key of the transport endpoint that owns this socket. */
	sessionId: string;
	/** Current logical session carried by valid threaded frames on this transport. */
	logicalSessionId: string;
	/** Endpoint metadata proved this logical id belongs to this discovery record. */
	logicalSessionIdTrusted: boolean;
	token: string;
	endpointKey: string;
	endpointDigest: string;
	hostGeneration: number;
	ws: WebSocket;
	/** Timestamp (via opts.now) at which this socket began connecting. */
	connectingSince: number;

	pending: Map<string, { sessionId: string; actionId: string }>;
	/** True once the server advertised the `client_ping_pong` capability. */
	capable: boolean;
	ephemeralCapable: boolean;
	/** Tool activity contract advertised by the connected host. */
	toolActivityCapability?: "v1" | "v2";
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
	/** Trusted recovery may not route until its durable endpoint lease is committed. */
	recoveryLease?: {
		state: "pending" | "authorized" | "rejected";
		logicalSessionId: string;
		binding: TopicEndpointBinding;
		token: number;
	};
}

interface ModelChoiceRoute {
	/** Exact transport socket that rendered this choice. */
	session: SessionSocket;
	/** Immutable owner lease captured when this choice was rendered. */
	socketLease: { session: SessionSocket; token: number; logicalSessionId: string };
	/** Logical session current when this choice was rendered. */
	sessionId: string;
	selector: string;
	expiresAt: number;
}

interface RenderedModelChoice {
	selector: string;
	label: string;
}
type TopicPickerAction = { kind: "select"; target: TelegramAdoptionTarget } | { kind: "recent" } | { kind: "direct" };

interface TopicPickerRoute {
	/** Telegram forum topic id the user created and that this picker controls. */
	topicId: number;
	/** Preallocated session id that will adopt this topic once created. */
	intendedSessionId: string;
	/** Configured chat id this picker was rendered for; replay into another chat is refused. */
	chatId: string;
	action: TopicPickerAction;
	expiresAt: number;
}

interface PendingAdoptionPathInput {
	chatId: string;
	intendedSessionId: string;
	expiresAt: number;
}

interface TopicAuthorityLease {
	sessionId: string;
	topicId: string;
	authorityEpoch: number;
}

interface ToolActivityOwner {
	sessionId: string;
	toolCallId: string;
	toolName: string;
	endpointDigest: string;
	session: SessionSocket;
	phase: "started" | "terminal";
	policyEpoch?: number;
	summaryFreeSend?: ThreadedSend;
}
type LegacyToolStartOutcome = "visible" | "failed" | "cancelled" | "terminal";
interface LegacyToolStartSettlement {
	key: string;
	owner: ToolActivityOwner;
	policyEpoch: number;
	phase: "admitted" | "pending_identity" | "queued" | "dispatching" | LegacyToolStartOutcome;
	itemId?: string;
	settled: Promise<LegacyToolStartOutcome>;
	resolve: (outcome: LegacyToolStartOutcome) => void;
	settledOutcome?: LegacyToolStartOutcome;
	terminalClaimed?: boolean;
}

interface PendingThreadedFrame {
	send: ThreadedSend;
	msg: Record<string, unknown>;
	logicalSessionId: string;
	session: SessionSocket;
	socketLease?: { session: SessionSocket; token: number; logicalSessionId: string };
	toolActivity?: ToolActivityOwner;
}

type SelectedAckOutcome =
	| { status: "delivered"; messageId: number }
	| { status: "failed"; reason: "route_missing" | "expired" | "cancelled" | "telegram_rejected" }
	| { status: "unknown"; reason: "transport_ambiguous" | "shutdown" };
type BtwQueuedDeliveryOutcome = "accepted" | "not_delivered" | "uncertain" | "stale" | "partial_accepted";

type BotApiCallOutcome =
	| { kind: "accepted" }
	| { kind: "rejected" }
	| { kind: "retryable"; retryAfterMs: number }
	| { kind: "unknown" };

interface BotApiCallResult {
	response: unknown;
	outcome: BotApiCallOutcome;
}
function createBotApiAdapter(
	call: (
		method: string,
		body: unknown,
		callOpts?: { signal?: AbortSignal; noRetry?: boolean },
	) => Promise<BotApiCallResult>,
): BotApi {
	return {
		call: async (method, body, callOpts) => (await call(method, body, callOpts)).response,
	};
}
function createBotApiPipeline(
	rawBotApi: BotApi,
	callBotApi: (
		rawBotApi: BotApi,
		method: string,
		body: unknown,
		callOpts?: { signal?: AbortSignal; noRetry?: boolean },
	) => Promise<BotApiCallResult>,
): {
	classified: (
		method: string,
		body: unknown,
		callOpts?: { signal?: AbortSignal; noRetry?: boolean },
	) => Promise<BotApiCallResult>;
	api: BotApi;
} {
	const classified = (method: string, body: unknown, callOpts?: { signal?: AbortSignal; noRetry?: boolean }) =>
		callBotApi(rawBotApi, method, body, callOpts);
	return { classified, api: createBotApiAdapter(classified) };
}

function classifyBotApiCallOutcome(response: unknown, cooldownSuppressed = false): BotApiCallOutcome {
	if (cooldownSuppressed) return { kind: "retryable", retryAfterMs: 0 };
	if (!response || typeof response !== "object") return { kind: "unknown" };
	const body = response as {
		ok?: unknown;
		error_code?: unknown;
		parameters?: { retry_after?: unknown };
	};
	if (body.ok === false && body.error_code === 429) {
		const retryAfter = body.parameters?.retry_after;
		const seconds = typeof retryAfter === "number" && Number.isFinite(retryAfter) ? retryAfter : 30;
		return { kind: "retryable", retryAfterMs: Math.min(3600, Math.max(1, seconds)) * 1_000 };
	}
	if (body.ok === true) return { kind: "accepted" };
	if (body.ok === false) return { kind: "rejected" };
	return { kind: "unknown" };
}

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
	/** Immutable owner lease captured when this acknowledgement was admitted. */
	socketLease: { session: SessionSocket; token: number; logicalSessionId: string };
	state: "queued" | "dispatching" | "sending";
	controller?: AbortController;
	followers: Array<{ pendingKey: string; requestId: string; commitKey: string }>;
}

interface TelegramQueuePayload {
	send: ThreadedSend;
	topicLease?: TopicAuthorityLease;
	/** Immutable owner lease captured when the work was admitted. */
	socketLease?: { session: SessionSocket; token: number; logicalSessionId: string };
	selectedAck?: SelectedAckQueueItem;
	btwDelivery?: BtwQueuedDelivery;
	toolActivity?: ToolActivityOwner;
	/** Exact admitted legacy-v1 start authorized for this terminal delivery. */
	legacyToolStart?: LegacyToolStartSettlement;
}

interface PendingBtwTurn {
	/** Immutable transport/topic ownership key. */
	transportSessionId: string;
	/** Logical session id supplied to the session endpoint. */
	logicalSessionId: string;
	/** Immutable committed owner lease captured when the inbound turn was admitted. */
	socketLease: { session: SessionSocket; token: number; logicalSessionId: string };
	/** Lease token to which this request was most recently dispatched. */
	dispatchedSocketLeaseToken?: number;
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
	#admitting = true;
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

	admit<T>(effect: () => Promise<T>): Promise<T> {
		if (!this.#admitting)
			return Promise.reject(Object.assign(new Error("Daemon is stopping"), { name: "AbortError" }));
		try {
			return this.track(effect());
		} catch (error) {
			return Promise.reject(error);
		}
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

	closeAdmission(): void {
		this.#admitting = false;
	}

	beginShutdown(): void {
		this.closeAdmission();
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
	/** Callback aliases are routable only by the immutable socket lease that rendered them. */
	#callbackAliasLeases = new Map<string, { session: SessionSocket; token: number; logicalSessionId: string }>();
	/** Each active alias is bound to the exact pending ask object that rendered it. */
	#callbackAliasPending = new Map<string, { sessionId: string; actionId: string }>();
	/** Active callbacks preserve the exact topic authority under which their keyboard was rendered. */
	#callbackAliasTopics = new Map<string, TopicAuthorityLease>();
	/** Exposed aliases wait for their accepted receipt persistence before routing. */
	#stagedCallbackActivations = new Map<string, StagedCallbackActivation>();
	readonly messageRoutes = new Map<string | number, CallbackRoute | Omit<CallbackRoute, "answer">>();
	/** Restart-revoked aliases retained only to terminalize their old keyboards on an authoritative replay. */
	private readonly reissueBacklog = new Map<string, CallbackRoute>();
	private aliasPersistenceQueue: Promise<void> = Promise.resolve();
	/** Telegram message id backing each streamed `${sessionId}:${coalesceKey}`, for in-place edits. */
	private readonly liveMessages = new Map<string, number>();
	/** Endpoint-bound ownership for visible or dispatching tool bubbles. */
	private readonly toolActivityOwners = new Map<string, ToolActivityOwner>();
	private readonly revokedToolEndpoints = new Set<string>();
	/** Exact settlement of each admitted legacy-v1 start; retained only while visible. */
	private readonly legacyToolStarts = new Map<string, LegacyToolStartSettlement>();
	private nextLegacyToolStartId = 1;
	private readonly unresolvedToolTerminalizations = new Map<string, { messageId: number; owner: ToolActivityOwner }>();
	private toolTerminalizationChain: Promise<void> = Promise.resolve();
	private toolActivityPolicyEpoch = 0;
	private toolActivityStopping = false;
	private readonly replayToolActivityEpochs = new WeakMap<Record<string, unknown>, number>();
	private toolShutdownBarrier: Promise<void> = Promise.resolve();
	private toolActivityAmbiguous = false;
	readonly sessions = new Map<string, SessionSocket>();
	/** Ephemeral aliases for model choices; deliberately never serialized across daemon restarts. */
	#modelChoiceAliases = new Map<string, ModelChoiceRoute>();
	/** One-shot picker aliases for user-created topic adoption; consumed before submit. */
	#adoptionPickerAliases = new Map<string, TopicPickerRoute>();
	/** Topics whose next authenticated text message is treated as an explicitly requested path. */
	#pendingAdoptionPathInputs = new Map<number, PendingAdoptionPathInput>();
	/** Durable, non-routable topic-adoption intents; sole claim authority is getOrCreateTopic. */
	#adoptionIntents: TelegramAdoptionIntentStore;
	/** Configured adoption-intent TTL (default 10 minutes); observed, not a fixed contract. */
	#adoptionIntentTtlMs: number;
	/** Periodic sweep handle for expired adoption intents. */
	#adoptionSweepTimer: NodeJS.Timeout | undefined;
	/** In-flight submissions close the pre-sidecar race across picker and direct-path entry points. */
	readonly #adoptionStartingTopics = new Set<number>();

	private readonly runtime: NotificationOperatorRuntime;
	private readonly sessionRouter: OperatorEventRouter<SessionSocket>;
	private readonly pollConflictBackoff = new JitteredPollConflictBackoff();
	private readonly loopBackoff = new OperatorBackoffPolicy({ initialMs: 250, maxMs: 4_000 });
	private running = false;
	/** Once set, a concurrent startup await can never restore a running daemon. */
	private stopRequested = false;

	private readonly fsImpl: TelegramDaemonFs;
	private readonly botApi: BotApi;
	private readonly effects = new TelegramEffectSupervisor();
	private readonly topics = new TopicRegistry();
	/** Stable host-local identity; never persisted in shared topic authority. */
	private installationHostId: string;
	/**
	 * Telegram may accept createForumTopic while returning an unusable success
	 * payload. Remember that ambiguity per endpoint so later frames cannot repeat
	 * the external side effect. Explicit API failures remain retryable.
	 */
	readonly #malformedTopicCreateEndpoints = new Map<string, string>();
	/** Serializes registry snapshots so an older atomic write cannot overwrite newer rename state. */
	/** Legacy sockets have no durable token, so explicit teardown is their revocation fence. */
	private readonly droppedSessions = new WeakSet<SessionSocket>();
	private topicsPersistQueue: Promise<void> = Promise.resolve();
	/** Serializes recovery compare/write/publish claims so competing endpoint migrations cannot durably diverge. */
	private recoveryBindingClaimQueue: Promise<void> = Promise.resolve();
	/** Durable compensation fences retry under supervision until persistence succeeds. */
	private readonly compensationFenceRetries = new Map<string, Promise<void>>();
	/** All archive paths for one session share one durable fence and remote dispatch. */
	private readonly archiveFlights = new Map<
		string,
		Promise<"pre_dispatch_cancelled" | "post_dispatch_pending" | "settled">
	>();

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
	/** Bot-wide flood-control window; inbound polling remains eligible during it. */
	private botCooldownUntil = 0;
	private warnedBotCooldownUntil = 0;
	/** Original markdown of rich messages we sent (chat+message_id), for restoring reply context on inbound replies. */
	private readonly replyStore: ReplySentStore;
	/** Per-session debounce + monotonic draft-id state for opt-in draft streaming. */
	private readonly draftStream = new DraftStreamState();
	/** Identity-bearing sessions by repo/branch surface, used to avoid transient duplicate topics. */
	private readonly topicOwnerByIdentity = new Map<string, string>();
	/** Ephemeral legacy topic owners retained across a same-socket config rekey. */
	private readonly legacyTopicOwners = new Map<string, SessionSocket>();
	/** Preserved initiator topics must not route through a rekeyed transport. */
	private readonly preservedInitiatorTopics = new Set<string>();
	/** Non-identity frames held until identity creates the correct thread. */
	private readonly pendingThreadedFrames = new Map<string, PendingThreadedFrame[]>();
	/** Durable endpoint leases for sessions that already sent an authorized session_closed. */
	private readonly closedEndpointKeys = new Map<string, TopicEndpointBinding>();
	/** Exactly one authorized transport may route each recovered logical session. */
	private readonly logicalSessionOwners = new Map<string, SessionSocket>();
	private nextSocketLeaseToken = 1;
	/** True once the daemon has nudged the user to enable Threaded Mode. */
	private threadedFallbackNoticeSent = false;
	/** Sessions whose identity header was already sent flat (Threaded Mode off). */
	private readonly flatIdentitySent = new Set<string>();
	/** Cached delivery boundary for the private owner chat or validation forum. */
	private pairedChatPrivacy: PairedChatPrivacy | undefined;
	/** Bot username from getMe, cached once at owner startup for group/forum command targeting. */
	private botUsername: string | undefined;
	/** Sessions whose agent loop is currently busy (drives the typing indicator). */
	private get busy(): Set<string> {
		return this.dispatchState.busy;
	}
	/** Inbound update id → originating Telegram message, for delivery reactions. */
	private get inboundReactions(): Map<
		number,
		{ messageId: number; socketLease?: { session: SessionSocket; token: number; logicalSessionId: string } }
	> {
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
		if (this.#leaseTokenAllows(item.socketLease) && item.session.ws.readyState === WebSocket.OPEN) {
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
		this.stopRequested = true;
		this.effects.closeAdmission();

		const toolShutdown = this.beginToolActivityShutdown();
		void toolShutdown
			.finally(() => {
				this.effects.beginShutdown();
				this.#deliveryAbort.abort();
			})
			.catch(() => undefined);
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
					reason: "spawn_failed",
					message: "lifecycle control unavailable; no session was started",
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
					reason: "spawn_failed",
					message: `lifecycle send failed before session start: ${String(e)}`,
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
		intendedSessionId?: string,
	): SessionLifecycleRequest {
		const requestId = this.nextLifecycleRequestId();
		const token = this.controlToken ?? "";
		const chatId = this.opts.chatId;
		if (parsed.kind === "create") {
			return {
				type: "session_create",
				requestId,
				lifecycleRequestId: requestId,
				intendedSessionId: intendedSessionId ?? `s${crypto.randomBytes(6).toString("hex")}`,
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
						...(telegramDisableNotification(this.opts.sound, "finalized") === true
							? { disable_notification: true }
							: {}),
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
						...(telegramDisableNotification(this.opts.sound, "finalized") === true
							? { disable_notification: true }
							: {}),
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
		await reply(this.formatLifecycleResponse(response, verb));
		return true;
	}

	private async refreshBotIdentity(): Promise<void> {
		try {
			const response = (await this.botApi.call("getMe", {})) as { result?: { username?: unknown } } | undefined;
			const username = response?.result?.username;
			this.botUsername =
				typeof username === "string" && username.trim() ? username.trim().replace(/^@/, "") : undefined;
		} catch {
			this.botUsername = undefined;
		}
	}

	/** Map a lifecycle response/error to a user-facing message (G010 surfacing). */
	private formatLifecycleResponse(r: SessionLifecycleResponse, verb: LifecycleCommandVerb): string {
		return formatLifecycleOutcome(r, verb);
	}

	private async callBotApi(
		rawBotApi: BotApi,
		method: string,
		body: unknown,
		callOpts?: { signal?: AbortSignal; noRetry?: boolean },
	): Promise<BotApiCallResult> {
		const now = this.opts.now?.() ?? Date.now();
		if (method !== "getUpdates" && now < this.botCooldownUntil) {
			if (this.warnedBotCooldownUntil !== this.botCooldownUntil) {
				this.warnedBotCooldownUntil = this.botCooldownUntil;
				logger.warn("notifications: Telegram Bot API flood-control cooldown suppressing outbound calls");
			}
			const outcome = classifyBotApiCallOutcome(undefined, true);
			return { response: undefined, outcome };
		}
		const outboundBody = this.validationTopicDestination(method, body);
		const response = await this.effects.call(rawBotApi, method, outboundBody, callOpts);
		const outcome = classifyBotApiCallOutcome(response);
		if (outcome.kind === "retryable")
			this.botCooldownUntil = Math.max(
				this.botCooldownUntil,
				(this.opts.now?.() ?? Date.now()) + outcome.retryAfterMs,
			);
		return { response, outcome };
	}
	private validationTopicDestination(method: string, body: unknown): unknown {
		if (
			!this.validationMode() ||
			method === "getChat" ||
			!body ||
			typeof body !== "object" ||
			String((body as { chat_id?: unknown }).chat_id) !== String(this.opts.chatId)
		)
			return body;
		return {
			...(body as Record<string, unknown>),
			chat_id: this.opts.validationTestSupergroupChatId!,
		};
	}

	private readonly callBotApiClassified: (
		method: string,
		body: unknown,
		callOpts?: { signal?: AbortSignal; noRetry?: boolean },
	) => Promise<BotApiCallResult>;

	private botApiWithOutcomeCollector(outcomes: BotApiCallOutcome[]): BotApi {
		return {
			call: async (method, body, callOpts) => {
				const result = await this.callBotApiClassified(method, body, callOpts);
				outcomes.push(result.outcome);
				return result.response;
			},
		};
	}

	constructor(private readonly opts: TelegramDaemonOptions) {
		this.fsImpl = opts.fs ?? nodeFs;
		this.replyStore = new ReplySentStore({ agentDir: opts.settings.getAgentDir(), fs: opts.fs });
		if (opts.topicRegistryAuthority && !opts.installationHostId)
			throw new Error("shared topic authority requires a host-local installation identity");
		this.installationHostId = opts.installationHostId ?? crypto.randomUUID();
		this.aliasTable = createAliasTable();
		this.#adoptionIntentTtlMs = opts.adoptionIntentTtlMs ?? DEFAULT_ADOPTION_INTENT_TTL_MS;
		const adoptionFs: AdoptionIntentFs = {
			mkdir: (directory, options) => this.fsImpl.mkdir(directory, options),
			chmod: (target, mode) => this.fsImpl.chmod(target, mode),
			readFile: (file, encoding) => this.fsImpl.readFile(file, encoding),
			writeFile: (file, data, options) => this.fsImpl.writeFile(file, data, options),
			rename: (from, to) => this.fsImpl.rename(from, to),
			unlink: file => this.fsImpl.unlink(file),
			readdir: directory => this.fsImpl.readdir(directory),
			open: async (file, flags) => {
				const handle = await this.fsImpl.open(file, flags);
				const sync = (handle as { sync?: () => Promise<void> }).sync;
				if (typeof sync !== "function") {
					await handle.close();
					throw new Error("adoption sidecar durability requires filesystem sync support");
				}
				return { sync: () => sync.call(handle), close: () => handle.close() };
			},
		};
		this.#adoptionIntents = new TelegramAdoptionIntentStore({
			agentDir: opts.settings.getAgentDir(),
			now: opts.now,
			fs: adoptionFs,
		});
		const rawBotApi =
			opts.botApi ??
			new TelegramBotTransport({
				botToken: opts.botToken,
				apiBase: opts.apiBase,
				fetchImpl: opts.fetchImpl,
				setTimeoutImpl: opts.setTimeoutImpl,
			});
		const botApiPipeline = createBotApiPipeline(rawBotApi, this.callBotApi.bind(this));
		this.callBotApiClassified = botApiPipeline.classified;
		this.botApi = botApiPipeline.api;
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
					const previousToolActivityCapability = session.toolActivityCapability;
					session.toolActivityCapability = negotiateToolActivityCapability(previousToolActivityCapability, caps);
					if (previousToolActivityCapability === "v1" && session.toolActivityCapability === "v2")
						this.cleanLegacyToolStartsForCapabilityUpgrade(session);
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
					const logicalSessionId = this.#logicalSessionId(session);
					const socketLease = this.#socketLease(session, logicalSessionId);
					if (!socketLease) return;
					const topicLease = this.topicAuthorityLeaseFromRegistry(logicalSessionId);
					if (
						this.topics.get(logicalSessionId)?.bindingMalformed ||
						(mode === "recovery" && (!topicLease || msg.sessionId !== logicalSessionId))
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
						socketLease,
						state: "queued",
						followers: [],
					};
					this.selectedAckPending.set(pendingKey, item);
					this.submitPool({
						lane: "ask",
						sessionId: logicalSessionId,
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
					const logicalSessionId = this.#logicalSessionId(session);
					if (msg.state === "busy") {
						this.busy.add(logicalSessionId);
						await this.sendTyping(logicalSessionId, this.#socketLease(session, logicalSessionId));
					} else {
						this.busy.delete(logicalSessionId);
					}
				},
			})
			.add({
				name: "inbound_ack",
				matches: msg => msg.type === "inbound_ack" && typeof msg.updateId === "number",
				handle: async (session, msg) => {
					const target = this.inboundReactions.get(msg.updateId as number);
					if (target && msg.state === "consumed") {
						this.inboundReactions.delete(msg.updateId as number);
						await this.setReaction(
							target.messageId,
							CONSUMED_REACTION,
							target.socketLease ?? this.#socketLease(session),
						);
					}
				},
			})
			.add({
				name: "session_closed",
				matches: msg => msg.type === "session_closed",
				handle: async (session, msg) => {
					const logicalSessionId = this.#logicalSessionId(session);
					if (
						(this.sessions.has(session.sessionId) && this.sessions.get(session.sessionId) !== session) ||
						typeof msg.sessionId !== "string" ||
						msg.sessionId !== logicalSessionId ||
						(session.logicalSessionIdTrusted && (!this.#leaseAllows(session) || session.hostGeneration < 1))
					)
						return;
					const socketLease = session.logicalSessionIdTrusted
						? this.#socketLease(session, logicalSessionId)
						: undefined;
					if (session.logicalSessionIdTrusted && !socketLease) return;
					this.busy.delete(logicalSessionId);
					await this.#terminalizeBtwTurnsForSession(session, true);
					if (socketLease && !this.#leaseTokenAllows(socketLease)) return;
					await this.#withRecoveryBindingClaim(async () => {
						if (socketLease && !this.#leaseTokenAllows(socketLease)) return;

						const closedBinding = this.#endpointBinding(session);
						const closedBindingMatches = () => {
							const current = this.closedEndpointKeys.get(session.sessionId);
							return (
								current?.chatId === closedBinding.chatId &&
								current.endpointKey === closedBinding.endpointKey &&
								current.endpointDigest === closedBinding.endpointDigest &&
								current.endpointGeneration === closedBinding.endpointGeneration
							);
						};
						const closeTopicAuthority = this.topics.captureArchiveAuthority(logicalSessionId);
						const previousClosedBinding = this.closedEndpointKeys.get(session.sessionId);
						await this.#persistTopicMutation(
							() => {
								this.closedEndpointKeys.set(session.sessionId, closedBinding);
								this.topics.beginArchive(logicalSessionId, this.installationHostId, this.runtime.now());
							},
							() => {
								this.topics.restoreArchiveAuthority(closeTopicAuthority);
								if (previousClosedBinding === undefined) this.closedEndpointKeys.delete(session.sessionId);
								else if (closedBindingMatches())
									this.closedEndpointKeys.set(session.sessionId, previousClosedBinding);
							},
						);
						if (
							this.sessions.get(session.sessionId) !== session ||
							(socketLease &&
								(session.recoveryLease?.token !== socketLease.token ||
									session.recoveryLease.state !== "authorized" ||
									this.logicalSessionOwners.get(logicalSessionId) !== session))
						) {
							// A replacement won after the close fence committed. Restore the exact
							// pre-close authority and remove the predecessor tombstone together.
							const restoreCloseAuthority = (): Promise<boolean> =>
								this.#persistTopicMutation(
									() => {
										this.topics.restoreArchiveAuthority(closeTopicAuthority);
										if (closedBindingMatches()) this.closedEndpointKeys.delete(session.sessionId);
										return true;
									},
									() => {
										this.topics.restoreArchiveFence(closeTopicAuthority);
										if (this.sessions.get(session.sessionId) === session)
											this.closedEndpointKeys.set(session.sessionId, closedBinding);
									},
								);
							try {
								await restoreCloseAuthority();
							} catch {
								await restoreCloseAuthority();
							}
							return;
						}
						const deleteOutcome = await this.archiveTopic(logicalSessionId, socketLease, true);
						if (
							deleteOutcome === "pre_dispatch_cancelled" &&
							socketLease &&
							!this.#deleteLeaseAllows(socketLease)
						) {
							await this.#persistTopicMutation(
								() => {
									if (!this.topics.restoreArchiveAuthority(closeTopicAuthority))
										throw new Error("close authority changed before compensation");
									this.closedEndpointKeys.delete(session.sessionId);
								},
								() => {
									this.topics.restoreArchiveFence(closeTopicAuthority);
									this.closedEndpointKeys.set(session.sessionId, closedBinding);
								},
							);
							return;
						}
						this.dropSession(session, "session_closed");
					});
				},
			});
	}

	async loadAliases(): Promise<void> {
		if (this.validationMode()) return;
		const raw = await readJson<unknown>(this.fsImpl, daemonPaths(this.opts.settings.getAgentDir()).aliases);
		if (!raw) return;
		const persisted = raw as { revokedRoutes?: unknown };
		const revoked = createAliasTable();
		revoked.load({ version: 2, next: 1, routes: persisted.revokedRoutes });
		for (const [alias, route] of revoked.entries()) this.reissueBacklog.set(alias, route);
		this.aliasTable.load(raw);
		for (const [alias, route] of this.aliasTable.entries()) this.reissueBacklog.set(alias, route);
		this.aliasTable.clear();
		await this.persistAliases();
	}

	persistAliases(): Promise<void> {
		if (this.validationMode()) return Promise.resolve();
		const pending = this.aliasPersistenceQueue.then(async () => {
			const paths = daemonPaths(this.opts.settings.getAgentDir());
			await ensureDir(this.fsImpl, paths.dir);
			await writeJsonAtomic(
				this.fsImpl,
				paths.aliases,
				{
					...this.aliasTable.serialize(),
					revokedRoutes: Object.fromEntries(this.reissueBacklog),
				},
				{ durable: true },
			);
		});
		this.aliasPersistenceQueue = pending.catch(() => undefined);
		return pending;
	}

	async loadSeenUpdateIds(): Promise<void> {
		if (this.validationMode()) return;
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
		if (this.validationMode()) return;
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
		if (this.validationMode()) {
			if (this.dispatchState.seenUpdateIds.has(updateId)) return false;
			this.dispatchState.seenUpdateIds.add(updateId);
			this.pruneSeenUpdateIds();
			return true;
		}
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

	private async releaseSeenUpdateId(updateId: number): Promise<void> {
		if (this.validationMode()) {
			this.dispatchState.seenUpdateIds.delete(updateId);
			return;
		}
		if (!this.dispatchState.seenUpdateIds.has(updateId)) return;
		const candidate = new Set(this.dispatchState.seenUpdateIds);
		candidate.delete(updateId);
		try {
			const paths = daemonPaths(this.opts.settings.getAgentDir());
			await ensureDir(this.fsImpl, paths.dir);
			await writeJsonAtomic(this.fsImpl, paths.seenUpdates, {
				version: 1,
				updateIds: [...candidate],
			});
		} catch {
			logger.warn("notifications: Telegram update state release failed");
			return;
		}
		this.dispatchState.seenUpdateIds.clear();
		for (const seenId of candidate) this.dispatchState.seenUpdateIds.add(seenId);
	}

	async scanRoots(): Promise<void> {
		await this.reconcilePendingTopicDeletes();
		const paths = daemonPaths(this.opts.settings.getAgentDir());
		const rootState = await readJson<{ roots?: string[] }>(this.fsImpl, paths.roots);
		const endpointSessionIds = new Set<string>();
		// Permanent absences prune; only transient I/O keeps orphan reconciliation
		// gated (so one deleted worktree cannot disable cleanup forever) (#2956).
		let allRootsReadable = true;
		const permanentlyMissingRoots: string[] = [];
		for (const root of rootState?.roots ?? []) {
			const dir = path.join(root, "sdk");
			let files: string[];
			try {
				files = await this.fsImpl.readdir(dir);
			} catch (error) {
				if (isPermanentMissingPathError(error)) {
					permanentlyMissingRoots.push(root);
					continue;
				}
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
					const owner = this.logicalSessionOwners.get(sessionId);
					if (owner && this.#leaseAllows(owner, sessionId)) {
						if (this.topics.clearOrphaned(sessionId)) await this.persistTopics();
						continue;
					}
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
						if (
							connected.endpointKey !== endpointKey ||
							(connected.ws.readyState === WebSocket.CONNECTING &&
								this.runtime.now() - connected.connectingSince >= CONNECTING_RECONNECT_MS)
						)
							this.connectSession(sessionId, endpoint.url, endpoint.token);
						continue;
					}
					const closed = this.closedEndpointKeys.get(sessionId);
					if (closed?.endpointKey === endpointKey) continue;
					if (closed) {
						this.closedEndpointKeys.delete(sessionId);
						await this.persistTopics();
					}
					this.connectSession(sessionId, endpoint.url, endpoint.token);
				} catch {}
			}
		}
		if (!this.validationMode()) {
			if (permanentlyMissingRoots.length > 0) {
				try {
					await pruneMissingNotificationRoots({
						settings: this.opts.settings,
						fs: this.fsImpl,
						candidates: permanentlyMissingRoots,
					});
				} catch (error) {
					logger.warn(`notifications: dead-root prune failed: ${sanitizeDiagnostic(String(error))}`);
				}
			}
			// Best-effort periodic reap of retained exact-unlink quarantines (#2956).
			try {
				await reapStaleNotificationArtifacts({
					settings: this.opts.settings,
					fs: this.fsImpl,
					now: this.opts.now,
					pidAlive: this.opts.pidAlive,
				});
			} catch (error) {
				logger.warn(`notifications: leak-artifact reap failed: ${sanitizeDiagnostic(String(error))}`);
			}
		}

		if (allRootsReadable) {
			for (const sessionId of this.topics.sessionIds()) {
				const owner = this.logicalSessionOwners.get(sessionId);
				if (owner && this.#leaseAllows(owner)) {
					if (this.topics.clearOrphaned(sessionId)) await this.persistTopics();
					continue;
				}
				if (!this.sessions.has(sessionId) && !endpointSessionIds.has(sessionId)) {
					this.#terminalizeBtwTurnsForTransportSession(sessionId);
					await this.observeOrphanedTopic(sessionId);
				}
			}
		}
	}

	connectSession(sessionId: string, url: string, token: string): SessionSocket {
		const WS = this.opts.WebSocketImpl ?? WebSocket;
		const ws = new WS(`${url}/?token=${encodeURIComponent(token)}`);
		const endpointKey = endpointGenerationKey(url, token);
		const endpointDigest = endpointAuthorityDigest(url, token);
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
			logicalSessionIdTrusted: false,
			token,
			endpointKey,
			endpointDigest,
			hostGeneration: 0,
			ws,
			connectingSince: this.runtime.now(),
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
		if (this.topics.get(sessionId)?.authorityState === "active") this.preservedInitiatorTopics.add(sessionId);

		// Bidirectional capability advertisement: announce client_ping_pong once the
		// socket is open. Sent on "open" only — a real WHATWG WebSocket cannot send
		// while CONNECTING — and liveness starts only after a capable ServerHello.
		ws.addEventListener("open", () => {
			if (this.sessions.get(sessionId) !== session) return;
			session.replayPending = true;
			session.replayQueue = [];
			// Cursors are endpoint-authority scoped. Reusing a prior host's cursor can
			// skip its identity event when a fresh host restarts at generation 1.
			const persistedTopic = this.topics.get(sessionId);
			const replayCursor =
				persistedTopic?.endpointDigest === session.endpointDigest ? this.topics.replayCursor(sessionId) : undefined;
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
								LEGACY_TOOL_ACTIVITY_CAPABILITY,
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
			void (async () => {
				if (this.#logicalSessionId(session) !== sessionId) return;
				const topic = this.topics.get(sessionId);
				if (!topic || topic.bindingMalformed) return;
				if (topic.authorityState === "disconnect_grace" && !(await this.#renewTopicLease(sessionId))) return;
				if (topic.authorityState !== "active") return;
				const topicLease = this.topicAuthorityLeaseFromRegistry(sessionId);
				if (topicLease?.topicId === topic.topicId) await this.flushPendingThreadedFrames(sessionId, topicLease);
			})().catch(err =>
				logger.warn(
					`notifications: Telegram topic reattach flush failed: ${sanitizeDiagnostic(String(err), this.opts.botToken)}`,
				),
			);
		});
		ws.addEventListener("message", ev => {
			// Identity guard: a delayed frame from a superseded socket must not act
			// through the replacement session.
			if (this.sessions.get(sessionId) !== session) return;
			void this.effects
				.admit(() => this.handleSessionMessage(session, JSON.parse(String(ev.data))))
				.catch(err => {
					// Surface frame-handling failures (e.g. a rejected ask sendMessage) to
					// the daemon log instead of an invisible unhandled rejection.
					logger.error("notifications daemon: handleSessionMessage failed", { error: String(err) });
				});
		});
		ws.addEventListener("close", () => {
			this.dropSession(session, "socket_closed");
		});
		return session;
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
			const logicalSessionId = this.#logicalSessionId(session);
			if (session.logicalSessionIdTrusted)
				void this.#renewTopicLease(logicalSessionId).then(renewed => {
					if (!renewed) this.dropSession(session, "topic_lease_lost");
				});
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
	private enqueueToolTerminalization(
		claimed:
			| Array<{ messageId: number; owner: ToolActivityOwner }>
			| (() => Array<{ messageId: number; owner: ToolActivityOwner }>),
		awaitDispatch: boolean,
		strict = false,
	): Promise<void> {
		const terminalize = (): Promise<void> =>
			this.effects.allowTerminal(async () => {
				if (awaitDispatch) await this.flushChain;
				const strictFailures: Error[] = [];
				const claimedItems = typeof claimed === "function" ? claimed() : claimed;
				for (const item of claimedItems) {
					const { messageId, owner } = item;
					const backlogKey = `${owner.endpointDigest}\0${owner.sessionId}\0${owner.toolCallId}\0${messageId}`;
					const send = this.renderThreadedFrame({
						type: "tool_activity",
						sessionId: owner.sessionId,
						toolCallId: owner.toolCallId,
						toolName: owner.toolName,
						phase: "cancelled",
					});
					if (!send?.text) continue;
					let failure: unknown;
					let delivered = false;
					for (let attempt = 0; attempt < (strict ? 5 : 1); attempt++) {
						try {
							const response = (await this.botApi.call("editMessageText", {
								chat_id: this.opts.chatId,
								message_id: messageId,
								text: send.text,
								parse_mode: TELEGRAM_PARSE_MODE,
							})) as { ok?: boolean; description?: string } | undefined;
							delivered = response?.ok === true || /not modified/i.test(String(response?.description ?? ""));
							if (delivered) break;
							failure = new Error(String(response?.description ?? "Telegram rejected tool terminalization."));
						} catch (error) {
							failure = error;
						}
						if (strict && attempt < 4) await this.runtime.sleep(50 * 2 ** attempt);
					}
					if (delivered) {
						this.unresolvedToolTerminalizations.delete(backlogKey);
						continue;
					}
					this.unresolvedToolTerminalizations.set(backlogKey, item);
					if (strict) {
						const key = `${owner.sessionId}:tool:${owner.toolCallId}`;
						if (!this.toolActivityOwners.has(key)) {
							this.toolActivityOwners.set(key, owner);
							this.liveMessages.set(key, messageId);
						}
						strictFailures.push(failure instanceof Error ? failure : new Error("Tool terminalization failed."));
					}
				}
				if (strictFailures.length > 0) {
					throw new AggregateError(strictFailures, strictFailures.map(failure => failure.message).join("; "));
				}
			});
		const next = this.toolTerminalizationChain.then(terminalize);
		this.toolTerminalizationChain = next.catch(() => {});
		return next;
	}

	private scheduleVisibleToolTerminalization(endpointDigest?: string, strict = false): Promise<void> {
		if (endpointDigest !== undefined) this.revokedToolEndpoints.add(endpointDigest);
		const claimVisible = (): Array<{ messageId: number; owner: ToolActivityOwner }> => {
			const claimedByKey = new Map<string, { messageId: number; owner: ToolActivityOwner }>();
			for (const [backlogKey, item] of this.unresolvedToolTerminalizations) {
				if (endpointDigest !== undefined && item.owner.endpointDigest !== endpointDigest) continue;
				this.unresolvedToolTerminalizations.delete(backlogKey);
				claimedByKey.set(backlogKey, item);
			}
			for (const [key, owner] of this.toolActivityOwners) {
				if (endpointDigest !== undefined && owner.endpointDigest !== endpointDigest) continue;
				this.toolActivityOwners.delete(key);
				const messageId = this.liveMessages.get(key);
				this.liveMessages.delete(key);
				const legacyStart = this.legacyToolStarts.get(key);
				if (legacyStart !== undefined && legacyStart.owner === owner)
					this.settleLegacyToolStart(legacyStart, "terminal");
				if (messageId !== undefined) {
					const backlogKey = `${owner.endpointDigest}\0${owner.sessionId}\0${owner.toolCallId}\0${messageId}`;
					claimedByKey.set(backlogKey, { messageId, owner });
				}
			}
			return [...claimedByKey.values()];
		};
		this.pool.removeWhere(
			item =>
				item.payload.toolActivity !== undefined &&
				(endpointDigest === undefined || item.payload.toolActivity.endpointDigest === endpointDigest),
		);
		const next = this.enqueueToolTerminalization(claimVisible, false, strict);
		if (endpointDigest !== undefined) {
			void next.then(
				() => this.revokedToolEndpoints.delete(endpointDigest),
				() => this.revokedToolEndpoints.delete(endpointDigest),
			);
		}
		return next;
	}

	private beginToolActivityShutdown(): Promise<void> {
		if (this.toolActivityStopping) return this.toolShutdownBarrier;
		this.toolActivityStopping = true;
		this.toolActivityPolicyEpoch++;
		this.toolShutdownBarrier = (async () => {
			await this.cancelLegacyToolStartsForPolicyTransition();
			await this.flushChain;
			const failures: Error[] = [];
			if (this.toolActivityAmbiguous) {
				failures.push(new Error("Tool activity delivery became ambiguous during daemon shutdown."));
			}
			try {
				await this.scheduleVisibleToolTerminalization(undefined, true);
			} catch (error) {
				failures.push(error instanceof Error ? error : new Error(String(error)));
			}
			if (failures.length > 0) {
				throw new AggregateError(failures, failures.map(failure => failure.message).join("; "));
			}
		})();
		return this.toolShutdownBarrier;
	}

	private dropSession(session: SessionSocket, reason: string): void {
		// Capture the exact callback lease before revoking recovery authority. A
		// predecessor transport can remain keyed by its own session id after a
		// successor becomes the logical owner, so logical-session revocation
		// would incorrectly delete the successor's freshly accepted aliases.
		const callbackLease = {
			session,
			token: session.recoveryLease?.token ?? 0,
			logicalSessionId: this.#logicalSessionId(session),
		};
		// A dropped socket must lose authority before any teardown-triggered asynchronous
		// work can observe it. Its immutable lease token remains captured by queued work,
		// but is no longer usable.
		if (session.recoveryLease) session.recoveryLease = { ...session.recoveryLease, state: "rejected" };
		const isCurrentSession = this.sessions.get(session.sessionId) === session;
		if (isCurrentSession) {
			this.revokeCallbackAliases(callbackLease);
			this.droppedSessions.add(session);
		}
		if (isCurrentSession) this.cancelLegacyToolStartsForSession(session);
		if (isCurrentSession) this.scheduleVisibleToolTerminalization(session.endpointDigest).catch(() => undefined);
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
		if (isCurrentSession && session.logicalSessionIdTrusted) this.#releaseTopicLease(this.#logicalSessionId(session));
		if (isCurrentSession || reason === "session_closed") {
			this.deleteMessageRoutes(session.sessionId);
		}
		if (isCurrentSession) {
			this.#clearModelChoiceAliasesForSocket(session);
			this.sessions.delete(session.sessionId);
			for (const [topicSessionId, owner] of this.legacyTopicOwners) {
				if (owner === session) this.legacyTopicOwners.delete(topicSessionId);
			}
			for (const [logicalSessionId, owner] of this.logicalSessionOwners) {
				if (owner === session) this.logicalSessionOwners.delete(logicalSessionId);
			}
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
				!this.#leaseTokenAllows(pending.socketLease) ||
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
		if (!this.#leaseTokenAllows(pending.socketLease) || this.sessions.get(session.sessionId) !== session)
			return false;
		if (pending.dispatchedSocketLeaseToken === pending.socketLease.token) return true;
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
			pending.dispatchedSocketLeaseToken = pending.socketLease.token;
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
		isAuthoritative?: () => boolean;
	}): Promise<unknown> {
		if (
			(!input.allowWhileStopping && this.#stoppingBtw) ||
			this.#btwDeliveryAbort.signal.aborted ||
			(input.isAuthoritative && !input.isAuthoritative())
		)
			return undefined;
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
				...(telegramDisableNotification(this.opts.sound, "finalized") === true
					? { disable_notification: true }
					: {}),
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
	#revokeCallbackAlias(alias: string): CallbackRoute | undefined {
		const route = this.aliasTable.get(alias);
		if (!route) return undefined;
		this.reissueBacklog.set(alias, route);
		this.aliasTable.delete(alias);
		this.#callbackAliasLeases.delete(alias);
		this.#callbackAliasPending.delete(alias);
		this.#callbackAliasTopics.delete(alias);
		return route;
	}
	#stageCallbackActivation(
		aliases: Iterable<string>,
		pending: { sessionId: string; actionId: string },
		socketLease: { session: SessionSocket; token: number; logicalSessionId: string },
		topicLease: TopicAuthorityLease | undefined,
	): PromiseWithResolvers<boolean> {
		const activation = Promise.withResolvers<boolean>();
		const staged: StagedCallbackActivation = { pending, socketLease, topicLease, settled: activation.promise };
		for (const alias of aliases) this.#stagedCallbackActivations.set(alias, staged);
		return activation;
	}

	revokeCallbackAliases(socketLease: { session: SessionSocket; token: number; logicalSessionId: string }): void {
		const actions = new Set<string>();
		for (const [alias, aliasLease] of this.#callbackAliasLeases) {
			if (
				aliasLease.session === socketLease.session &&
				aliasLease.token === socketLease.token &&
				aliasLease.logicalSessionId === socketLease.logicalSessionId
			) {
				const route = this.#revokeCallbackAlias(alias);
				if (route) actions.add(route.actionId);
			}
		}
		if (actions.size === 0) return;
		const terminalization = this.effects.track(
			(async () => {
				await this.persistAliases();
				for (const actionId of actions) await this.reissuePendingAction(socketLease.logicalSessionId, actionId);
			})(),
		);
		void terminalization.catch(() => undefined);
	}

	private async reissuePendingAction(sessionId: string, actionId: string): Promise<void> {
		const oldEntries = [...this.reissueBacklog.entries()].filter(
			([, route]) => route.sessionId === sessionId && route.actionId === actionId,
		);
		const messageIds = new Set<number>();
		for (const [, route] of oldEntries) {
			if (String(route.chatId) === String(this.opts.chatId) && Number.isSafeInteger(route.messageId))
				messageIds.add(route.messageId!);
		}
		const terminalizedMessageIds = new Set<number>();
		for (const messageId of messageIds) {
			try {
				const terminalized = (await this.botApi.call("editMessageReplyMarkup", {
					chat_id: this.opts.chatId,
					message_id: messageId,
					reply_markup: { inline_keyboard: [] },
				})) as { ok?: unknown } | undefined;
				if (terminalized?.ok === true) terminalizedMessageIds.add(messageId);
			} catch {
				// Retain the durable receipt so a later replay can retry terminalization.
			}
		}
		for (const [alias, route] of oldEntries) {
			if (
				String(route.chatId) === String(this.opts.chatId) &&
				Number.isSafeInteger(route.messageId) &&
				terminalizedMessageIds.has(route.messageId!)
			)
				this.reissueBacklog.delete(alias);
		}
		await this.persistAliases();
	}

	#logicalSessionId(session: SessionSocket): string {
		return session.logicalSessionId ?? session.sessionId;
	}

	#leaseAllows(session: SessionSocket, logicalSessionId = this.#logicalSessionId(session)): boolean {
		if (this.droppedSessions.has(session)) return false;
		const closedBinding = this.closedEndpointKeys.get(session.sessionId);
		if (
			closedBinding &&
			typeof session.endpointKey === "string" &&
			typeof session.endpointDigest === "string" &&
			closedBinding.endpointKey === session.endpointKey &&
			closedBinding.endpointDigest === session.endpointDigest &&
			closedBinding.endpointGeneration === session.hostGeneration
		)
			return false;
		if (!session.logicalSessionIdTrusted) return true;
		// Trusted leases require both the current transport socket and exact logical owner.
		if (this.sessions.get(session.sessionId) !== session) return false;
		const lease = session.recoveryLease;
		if (lease?.state !== "authorized" || lease.logicalSessionId !== logicalSessionId) return false;
		if (this.logicalSessionOwners.get(logicalSessionId) !== session) return false;
		const record = this.topics.get(logicalSessionId);
		return (
			lease.binding.endpointKey === session.endpointKey &&
			lease.binding.endpointDigest === session.endpointDigest &&
			lease.binding.endpointGeneration === session.hostGeneration &&
			(!record ||
				(record.authorityState === "active" &&
					!record.bindingMalformed &&
					record.leaseOwner === this.installationHostId &&
					(record.leaseExpiresAt ?? 0) > this.runtime.now() &&
					record.chatId === lease.binding.chatId &&
					record.endpointKey === lease.binding.endpointKey &&
					record.endpointDigest === lease.binding.endpointDigest &&
					record.endpointGeneration === lease.binding.endpointGeneration))
		);
	}

	#leaseTokenAllows(socketLease: { session: SessionSocket; token: number; logicalSessionId: string }): boolean {
		return socketLease.token === 0
			? !socketLease.session.logicalSessionIdTrusted && !this.droppedSessions.has(socketLease.session)
			: this.sessions.get(socketLease.session.sessionId) === socketLease.session &&
					socketLease.session.recoveryLease?.token === socketLease.token &&
					this.#leaseAllows(socketLease.session, socketLease.logicalSessionId);
	}

	#deleteLeaseAllows(socketLease: { session: SessionSocket; token: number; logicalSessionId: string }): boolean {
		if (socketLease.token === 0)
			return (
				this.sessions.get(socketLease.session.sessionId) === socketLease.session &&
				!this.droppedSessions.has(socketLease.session)
			);
		return (
			this.sessions.get(socketLease.session.sessionId) === socketLease.session &&
			socketLease.session.recoveryLease?.token === socketLease.token &&
			socketLease.session.recoveryLease.state === "authorized" &&
			socketLease.session.recoveryLease.logicalSessionId === socketLease.logicalSessionId &&
			this.logicalSessionOwners.get(socketLease.logicalSessionId) === socketLease.session
		);
	}

	/**
	 * An eager transport-topic create may complete after authenticated replay
	 * authorizes that exact transport as its own logical session. Preserve that
	 * handoff, but never revive a replaced socket or a rekeyed transport.
	 */
	#isEagerCreationHandoff(socketLease: { session: SessionSocket; token: number; logicalSessionId: string }): boolean {
		const { session, logicalSessionId } = socketLease;
		const lease = session.recoveryLease;
		return (
			socketLease.token === 0 &&
			logicalSessionId === session.sessionId &&
			session.logicalSessionIdTrusted &&
			this.sessions.get(session.sessionId) === session &&
			lease?.state === "authorized" &&
			lease.logicalSessionId === logicalSessionId &&
			this.logicalSessionOwners.get(logicalSessionId) === session &&
			lease.binding.chatId === String(this.opts.chatId) &&
			lease.binding.endpointKey === session.endpointKey &&
			lease.binding.endpointDigest === session.endpointDigest &&
			lease.binding.endpointGeneration === session.hostGeneration
		);
	}

	#creationLeaseAllows(socketLease: { session: SessionSocket; token: number; logicalSessionId: string }): boolean {
		return this.#leaseTokenAllows(socketLease) || this.#isEagerCreationHandoff(socketLease);
	}

	async #awaitCreationLeaseAuthority(socketLease: {
		session: SessionSocket;
		token: number;
		logicalSessionId: string;
	}): Promise<boolean> {
		if (this.#creationLeaseAllows(socketLease)) return true;
		if (
			socketLease.token === 0 &&
			socketLease.session.logicalSessionIdTrusted &&
			socketLease.session.recoveryLease?.state === "pending" &&
			this.sessions.get(socketLease.session.sessionId) === socketLease.session
		)
			await this.recoveryBindingClaimQueue;
		return this.#creationLeaseAllows(socketLease);
	}
	#socketLease(
		session: SessionSocket,
		logicalSessionId = this.#logicalSessionId(session),
	): { session: SessionSocket; token: number; logicalSessionId: string } | undefined {
		const lease = session.recoveryLease;
		return lease && this.#leaseAllows(session, logicalSessionId)
			? { session, token: lease.token, logicalSessionId }
			: session.logicalSessionIdTrusted
				? undefined
				: { session, token: 0, logicalSessionId };
	}
	async #renewTopicLease(sessionId: string): Promise<boolean> {
		const record = this.topics.get(sessionId);
		if (!record) return true;
		const previous = {
			leaseOwner: record.leaseOwner,
			leaseHeartbeatAt: record.leaseHeartbeatAt,
			leaseExpiresAt: record.leaseExpiresAt,
			authorityState: record.authorityState,
			orphanedAt: record.orphanedAt,
			disconnectGraceExpiresAt: record.disconnectGraceExpiresAt,
		};
		return this.#persistTopicMutation(
			() =>
				this.topics.acquireLease(
					sessionId,
					this.installationHostId,
					this.runtime.now(),
					HEARTBEAT_TTL_MS,
					ORPHAN_TOPIC_GRACE_MS,
				),
			() => {
				const current = this.topics.get(sessionId);
				if (!current) return;
				Object.assign(current, previous);
				if (previous.leaseOwner === undefined) delete current.leaseOwner;
				if (previous.leaseHeartbeatAt === undefined) delete current.leaseHeartbeatAt;
				if (previous.leaseExpiresAt === undefined) delete current.leaseExpiresAt;
				if (previous.orphanedAt === undefined) delete current.orphanedAt;
				if (previous.disconnectGraceExpiresAt === undefined) delete current.disconnectGraceExpiresAt;
			},
		);
	}
	#releaseTopicLease(sessionId: string): void {
		const record = this.topics.get(sessionId);
		if (!record) return;
		const previous = {
			leaseHeartbeatAt: record.leaseHeartbeatAt,
			leaseExpiresAt: record.leaseExpiresAt,
			authorityState: record.authorityState,
			orphanedAt: record.orphanedAt,
			disconnectGraceExpiresAt: record.disconnectGraceExpiresAt,
		};
		void this.#persistTopicMutation(
			() => {
				const owner = this.logicalSessionOwners.get(sessionId);
				return owner === undefined
					? this.topics.releaseLeaseToGrace(
							sessionId,
							this.installationHostId,
							this.runtime.now(),
							ORPHAN_TOPIC_GRACE_MS,
						)
					: false;
			},
			() => {
				const current = this.topics.get(sessionId);
				if (!current) return;
				Object.assign(current, previous);
				if (previous.leaseHeartbeatAt === undefined) delete current.leaseHeartbeatAt;
				if (previous.leaseExpiresAt === undefined) delete current.leaseExpiresAt;
				if (previous.orphanedAt === undefined) delete current.orphanedAt;
				if (previous.disconnectGraceExpiresAt === undefined) delete current.disconnectGraceExpiresAt;
			},
		).catch(() => undefined);
	}

	#authorizeLease(session: SessionSocket, logicalSessionId: string, binding: TopicEndpointBinding): void {
		const previousSessionId = this.#logicalSessionId(session);
		if (previousSessionId !== logicalSessionId && this.logicalSessionOwners.get(previousSessionId) === session)
			this.logicalSessionOwners.delete(previousSessionId);
		const previousOwner = this.logicalSessionOwners.get(logicalSessionId);
		if (previousOwner && previousOwner !== session && previousOwner.recoveryLease) {
			const predecessorLease = {
				session: previousOwner,
				token: previousOwner.recoveryLease.token,
				logicalSessionId,
			};
			previousOwner.recoveryLease = { ...previousOwner.recoveryLease, state: "rejected" };
			this.revokeCallbackAliases(predecessorLease);
		}
		this.logicalSessionOwners.set(logicalSessionId, session);
		this.preservedInitiatorTopics.delete(logicalSessionId);
		session.logicalSessionId = logicalSessionId;
		session.recoveryLease = { state: "authorized", logicalSessionId, binding, token: this.nextSocketLeaseToken++ };
	}

	#clearModelChoiceAliases(sessionId: string): void {
		for (const [alias, route] of this.#modelChoiceAliases) {
			if (route.sessionId === sessionId) this.#modelChoiceAliases.delete(alias);
		}
	}

	async #revokeAskAuthority(sessionId: string): Promise<void> {
		const actionIds = new Set<string>();
		for (const [alias, route] of this.aliasTable.entries()) {
			if (route.sessionId !== sessionId) continue;
			this.reissueBacklog.set(alias, route);
			this.aliasTable.delete(alias);
			this.#callbackAliasLeases.delete(alias);
			this.#callbackAliasPending.delete(alias);
			this.#callbackAliasTopics.delete(alias);
			actionIds.add(route.actionId);
		}
		for (const route of this.reissueBacklog.values()) {
			if (route.sessionId === sessionId) actionIds.add(route.actionId);
		}
		for (const session of this.sessions.values()) {
			if (session.sessionId === sessionId || this.#logicalSessionId(session) === sessionId) {
				for (const [actionId, pending] of session.pending) {
					if (pending.sessionId === sessionId) session.pending.delete(actionId);
				}
			}
		}
		await this.persistAliases();
		for (const actionId of actionIds) await this.reissuePendingAction(sessionId, actionId);
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

	/** Rekey only after authenticated replay, except legacy config updates which are transport-local. */
	async #updateLogicalSessionForThreadedFrame(session: SessionSocket, msg: Record<string, unknown>): Promise<void> {
		if (
			typeof msg.type !== "string" ||
			!TelegramNotificationDaemon.THREADED_FRAMES.has(msg.type) ||
			typeof msg.sessionId !== "string" ||
			!msg.sessionId.trim() ||
			msg.sessionId === this.#logicalSessionId(session) ||
			(msg.type !== "config_update" && !this.renderThreadedFrame(msg))
		)
			return;
		if (!session.logicalSessionIdTrusted) return;
		await this.#recoverTopicBinding(session, msg.sessionId, msg.type === "config_update");
	}

	#endpointBinding(session: SessionSocket): TopicEndpointBinding {
		return {
			chatId: String(this.opts.chatId),
			endpointKey: session.endpointKey,
			endpointDigest: session.endpointDigest,
			endpointGeneration: session.hostGeneration,
		};
	}

	#endpointAuthority(binding: TopicEndpointBinding, excludedSession?: SessionSocket) {
		const tombstoned = [...this.closedEndpointKeys.values()].some(
			closed =>
				closed.chatId === binding.chatId &&
				closed.endpointKey === binding.endpointKey &&
				closed.endpointDigest === binding.endpointDigest,
		);
		if (tombstoned) return { state: "ambiguous" as const };
		const authority = this.topics.endpointAuthority(binding, excludedSession);
		const competingLiveClaim = [...this.sessions.values()].some(
			session =>
				session !== excludedSession &&
				session.endpointKey === binding.endpointKey &&
				session.endpointDigest === binding.endpointDigest,
		);
		const competingRecoveryClaim = [...this.sessions.values()].some(
			session =>
				session !== excludedSession &&
				session.recoveryLease?.state === "pending" &&
				session.recoveryLease.binding.chatId === binding.chatId &&
				session.recoveryLease.binding.endpointKey === binding.endpointKey &&
				session.recoveryLease.binding.endpointDigest === binding.endpointDigest,
		);
		return competingLiveClaim || competingRecoveryClaim ? { state: "ambiguous" as const } : authority;
	}

	#ownsLiveOpenEndpoint(session: SessionSocket, binding: TopicEndpointBinding): boolean {
		return (
			this.sessions.get(session.sessionId) === session &&
			session.ws.readyState === WebSocket.OPEN &&
			binding.endpointKey === session.endpointKey &&
			binding.endpointDigest === session.endpointDigest &&
			binding.endpointGeneration === session.hostGeneration
		);
	}

	#activeEndpointKeysFor(logicalSessionId: string, claimant: SessionSocket): Set<string> {
		const keys = new Set<string>();
		for (const session of this.sessions.values()) {
			if (
				session !== claimant &&
				this.#logicalSessionId(session) === logicalSessionId &&
				this.#leaseAllows(session, logicalSessionId)
			)
				keys.add(session.endpointKey);
		}
		return keys;
	}

	#withRecoveryBindingClaim<T>(claim: () => Promise<T>): Promise<T> {
		const pending = this.recoveryBindingClaimQueue.then(claim, claim);
		this.recoveryBindingClaimQueue = pending.then(
			() => undefined,
			() => undefined,
		);
		return pending;
	}

	async #recoverTopicBinding(
		session: SessionSocket,
		candidateSessionId = this.#logicalSessionId(session),
		preserveTransportTopic = false,
		allowEndpointRotation = false,
		identitylessAdmission: "bootstrap" | "resume" | undefined = undefined,
	): Promise<boolean> {
		if (!session.logicalSessionIdTrusted) return false;
		const binding = this.#endpointBinding(session);
		const pendingToken = this.nextSocketLeaseToken++;
		session.recoveryLease = { state: "pending", logicalSessionId: candidateSessionId, binding, token: pendingToken };
		let claim: { previousSessionId: string; hadDurableTopic: boolean } | undefined;
		try {
			claim = await this.#withRecoveryBindingClaim(async () => {
				const existing = this.topics.get(candidateSessionId);
				const hadDurableTopic = existing !== undefined;
				const previousBinding = existing
					? {
							chatId: existing.chatId,
							endpointKey: existing.endpointKey,
							endpointDigest: existing.endpointDigest,
							endpointGeneration: existing.endpointGeneration,
							endpointIncarnation: existing.endpointIncarnation,
						}
					: undefined;
				let retiredTopicState: TopicRegistryState | undefined;
				const outcome = await this.#persistTopicMutation(
					() => {
						if (allowEndpointRotation && this.topics.get(candidateSessionId)?.authorityState === "inactive") {
							retiredTopicState = this.topics.serialize();
							this.topics.retireInactiveEndpointForSuccessor(candidateSessionId, binding);
						}
						return this.topics.get(candidateSessionId)
							? this.topics.bindEndpoint(
									candidateSessionId,
									binding,
									this.#activeEndpointKeysFor(candidateSessionId, session),
									allowEndpointRotation,
								)
							: "unchanged";
					},
					() => {
						if (retiredTopicState) this.topics.replace(retiredTopicState);
						else if (previousBinding)
							this.topics.restoreEndpointBinding(candidateSessionId, binding, previousBinding);
					},
				).catch(() => "rejected" as const);
				if (outcome === "rejected") {
					if (session.recoveryLease?.token === pendingToken)
						session.recoveryLease = {
							state: "rejected",
							logicalSessionId: candidateSessionId,
							binding,
							token: pendingToken,
						};
					return undefined;
				}
				if (!(await this.#renewTopicLease(candidateSessionId))) {
					if (session.recoveryLease?.token === pendingToken)
						session.recoveryLease = {
							state: "rejected",
							logicalSessionId: candidateSessionId,
							binding,
							token: pendingToken,
						};
					return undefined;
				}
				const endpointAuthority = this.#endpointAuthority(binding, session);
				const identitylessAdmissionAllows =
					identitylessAdmission === undefined ||
					(identitylessAdmission === "bootstrap"
						? (endpointAuthority.state === "none" && !this.topics.get(candidateSessionId)) ||
							(endpointAuthority.state === "unique" &&
								endpointAuthority.sessionId === candidateSessionId &&
								this.topics.matchesEndpoint(candidateSessionId, binding))
						: endpointAuthority.state === "unique" &&
							endpointAuthority.sessionId === candidateSessionId &&
							this.topics.matchesEndpoint(candidateSessionId, binding));
				if (
					session.recoveryLease?.token !== pendingToken ||
					session.recoveryLease.state !== "pending" ||
					!this.#ownsLiveOpenEndpoint(session, binding) ||
					!identitylessAdmissionAllows
				) {
					if (session.recoveryLease?.token === pendingToken)
						session.recoveryLease = {
							state: "rejected",
							logicalSessionId: candidateSessionId,
							binding,
							token: pendingToken,
						};
					return undefined;
				}
				const previousSessionId = this.#logicalSessionId(session);
				if (previousSessionId !== candidateSessionId) await this.#terminalizeBtwTurnsForSession(session, true);
				if (!this.#ownsLiveOpenEndpoint(session, binding)) {
					if (session.recoveryLease?.token === pendingToken)
						session.recoveryLease = {
							state: "rejected",
							logicalSessionId: candidateSessionId,
							binding,
							token: pendingToken,
						};
					return undefined;
				}
				this.#authorizeLease(session, candidateSessionId, binding);
				return { previousSessionId, hadDurableTopic };
			});
		} catch {
			if (session.recoveryLease?.token === pendingToken)
				session.recoveryLease = {
					state: "rejected",
					logicalSessionId: candidateSessionId,
					binding,
					token: pendingToken,
				};
			return false;
		}
		if (!claim) {
			if (session.recoveryLease?.token === pendingToken)
				session.recoveryLease = {
					state: "rejected",
					logicalSessionId: candidateSessionId,
					binding,
					token: pendingToken,
				};
			return false;
		}
		const { previousSessionId } = claim;
		if (preserveTransportTopic && previousSessionId !== candidateSessionId) {
			this.legacyTopicOwners.set(previousSessionId, session);
			this.preservedInitiatorTopics.add(previousSessionId);
		}
		if (candidateSessionId === session.sessionId)
			void (async () => {
				const topic = this.topics.get(candidateSessionId);
				if (topic?.authorityState !== "active" || topic.bindingMalformed) return;
				const topicLease = this.topicAuthorityLeaseFromRegistry(candidateSessionId);
				if (topicLease?.topicId === topic.topicId)
					await this.flushPendingThreadedFrames(candidateSessionId, topicLease);
			})().catch(err =>
				logger.warn(
					`notifications: Telegram recovered topic reattach flush failed: ${sanitizeDiagnostic(String(err), this.opts.botToken)}`,
				),
			);
		return true;
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
		if (remembered && rememberedTopic && rememberedTopic.authorityState === "active") return remembered;
		if (!identityKey) return undefined;
		const base = this.topicIdentityBase(msg);
		for (const sessionId of this.topics.sessionIds()) {
			const topic = this.topics.get(sessionId);
			if (topic?.authorityState !== "active") continue;
			const nameMatchesLegacyIdentity =
				base !== undefined && (topic?.name === base || topic?.name?.startsWith(`${base} - `));
			if (topic?.identityKey === identityKey || nameMatchesLegacyIdentity) {
				this.topicOwnerByIdentity.set(identityKey, sessionId);
				return sessionId;
			}
		}
		return undefined;
	}

	private admitLegacyToolStart(owner: ToolActivityOwner): LegacyToolStartSettlement | undefined {
		if (owner.session.toolActivityCapability !== "v1") return undefined;
		const key = `${owner.sessionId}:tool:${owner.toolCallId}`;
		if (this.legacyToolStarts.has(key)) return undefined;
		const deferred = Promise.withResolvers<LegacyToolStartOutcome>();
		const state: LegacyToolStartSettlement = {
			key,
			owner,
			policyEpoch: owner.policyEpoch ?? this.toolActivityPolicyEpoch,
			phase: "admitted",
			settled: deferred.promise,
			resolve: deferred.resolve,
		};
		this.legacyToolStarts.set(key, state);
		return state;
	}
	private legacyToolStartForTerminal(owner: ToolActivityOwner): LegacyToolStartSettlement | undefined {
		if (owner.phase !== "terminal") return undefined;
		const key = `${owner.sessionId}:tool:${owner.toolCallId}`;
		const state = this.legacyToolStarts.get(key);
		if (
			state === undefined ||
			state.key !== key ||
			state.owner.session !== owner.session ||
			state.owner.endpointDigest !== owner.endpointDigest ||
			state.owner.toolName !== owner.toolName ||
			state.policyEpoch !== owner.policyEpoch
		)
			return undefined;
		return state;
	}

	private settleLegacyToolStart(state: LegacyToolStartSettlement, outcome: LegacyToolStartOutcome): void {
		if (state.settledOutcome === undefined) {
			state.settledOutcome = outcome;
			state.resolve(outcome);
		}
		state.phase = outcome;
		if (outcome !== "visible" && this.legacyToolStarts.get(state.key) === state)
			this.legacyToolStarts.delete(state.key);
		if (outcome !== "visible" && !this.liveMessages.has(state.key)) {
			const owner = this.toolActivityOwners.get(state.key);
			if (owner === state.owner) this.toolActivityOwners.delete(state.key);
		}
	}

	private cancelUnsentLegacyToolStart(state: LegacyToolStartSettlement): boolean {
		if (state.phase !== "admitted" && state.phase !== "pending_identity" && state.phase !== "queued") return false;
		if (state.itemId) this.pool.removeById(state.itemId);
		for (const [sessionId, frames] of this.pendingThreadedFrames) {
			const retained = frames.filter(frame => frame.toolActivity !== state.owner);
			if (retained.length === 0) this.pendingThreadedFrames.delete(sessionId);
			else if (retained.length !== frames.length) this.pendingThreadedFrames.set(sessionId, retained);
		}
		this.settleLegacyToolStart(state, "cancelled");
		return true;
	}

	private failLegacyToolStart(toolActivity: ToolActivityOwner | undefined): void {
		if (toolActivity?.phase !== "started") return;
		const state = this.legacyToolStarts.get(`${toolActivity.sessionId}:tool:${toolActivity.toolCallId}`);
		if (state !== undefined && state.owner === toolActivity && state.phase !== "visible")
			this.settleLegacyToolStart(state, "failed");
	}

	private settleRejectedLegacyToolSubmission(
		toolActivity: ToolActivityOwner | undefined,
		legacyToolStart: LegacyToolStartSettlement | undefined,
	): void {
		if (toolActivity?.phase === "started") {
			this.failLegacyToolStart(toolActivity);
			return;
		}
		if (
			toolActivity?.phase !== "terminal" ||
			legacyToolStart === undefined ||
			this.legacyToolStarts.get(legacyToolStart.key) !== legacyToolStart
		)
			return;
		this.settleLegacyToolStart(legacyToolStart, "terminal");
		this.liveMessages.delete(legacyToolStart.key);
		if (this.toolActivityOwners.get(legacyToolStart.key) === legacyToolStart.owner)
			this.toolActivityOwners.delete(legacyToolStart.key);
	}

	private cancelLegacyToolStartsForSession(session: SessionSocket): void {
		for (const state of [...this.legacyToolStarts.values()]) {
			if (state.owner.session !== session) continue;
			if (!this.cancelUnsentLegacyToolStart(state)) this.settleLegacyToolStart(state, "cancelled");
		}
	}

	private cleanLegacyToolStartsForCapabilityUpgrade(session: SessionSocket): void {
		for (const state of [...this.legacyToolStarts.values()]) {
			if (state.owner.session !== session || state.phase === "dispatching") continue;
			if (state.phase === "visible") this.settleLegacyToolStart(state, "terminal");
			else this.cancelUnsentLegacyToolStart(state);
		}
	}
	private cancelLegacyToolStartsForPolicyTransition(): Promise<LegacyToolStartOutcome[]> {
		const dispatching: Promise<LegacyToolStartOutcome>[] = [];
		const visibleTerminalizations: Array<{ messageId: number; owner: ToolActivityOwner }> = [];
		for (const state of [...this.legacyToolStarts.values()]) {
			if (state.phase === "dispatching")
				dispatching.push(
					state.settled.then(outcome => {
						if (outcome === "visible" && this.legacyToolStarts.get(state.key) === state) {
							const messageId = this.liveMessages.get(state.key);
							this.liveMessages.delete(state.key);
							if (this.toolActivityOwners.get(state.key) === state.owner)
								this.toolActivityOwners.delete(state.key);
							this.settleLegacyToolStart(state, "terminal");
							if (messageId !== undefined) {
								void this.enqueueToolTerminalization([{ messageId, owner: state.owner }], false);
							}
						}
						return outcome;
					}),
				);
			else if (state.phase === "visible") {
				const messageId = this.liveMessages.get(state.key);
				this.liveMessages.delete(state.key);
				if (this.toolActivityOwners.get(state.key) === state.owner) this.toolActivityOwners.delete(state.key);
				this.settleLegacyToolStart(state, "terminal");
				if (messageId !== undefined) {
					visibleTerminalizations.push({ messageId, owner: state.owner });
				}
			} else this.cancelUnsentLegacyToolStart(state);
		}
		if (visibleTerminalizations.length > 0) {
			void this.enqueueToolTerminalization(visibleTerminalizations, false);
		}
		return Promise.all(dispatching);
	}
	private toolActivityOwner(session: SessionSocket, msg: Record<string, unknown>): ToolActivityOwner | undefined {
		if (msg.type !== "tool_activity") return undefined;
		const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
		const toolName = typeof msg.toolName === "string" ? msg.toolName : undefined;
		const phase = typeof msg.phase === "string" ? msg.phase : undefined;
		if (
			!toolCallId ||
			!toolName ||
			(phase !== "started" && phase !== "completed" && phase !== "failed" && phase !== "cancelled")
		)
			return undefined;
		return {
			sessionId: this.#logicalSessionId(session),
			toolCallId,
			toolName,
			endpointDigest: session.endpointDigest,
			session,
			phase: phase === "started" ? "started" : "terminal",
		};
	}
	private renderThreadedFrame(frame: Record<string, unknown>): ThreadedSend | undefined {
		if (
			frame.type === "tool_activity" &&
			frame.phase !== "started" &&
			frame.phase !== "completed" &&
			frame.phase !== "failed" &&
			frame.phase !== "cancelled"
		)
			return undefined;
		return renderThreadedFrame(frame);
	}
	private toolActivityFrameWithoutSummaries(frame: Record<string, unknown>): Record<string, unknown> {
		const summaryFree = { ...frame };
		delete summaryFree.argsSummary;
		delete summaryFree.resultSummary;
		return summaryFree;
	}
	private toolActivitySummariesAreCurrent(toolActivity: ToolActivityOwner): boolean {
		return (
			this.opts.toolActivity?.enabled === true &&
			toolActivity.policyEpoch === this.toolActivityPolicyEpoch &&
			this.toolActivityAuthorityIsCurrent(toolActivity)
		);
	}

	private toolActivityAuthorityIsCurrent(toolActivity: ToolActivityOwner): boolean {
		if (this.revokedToolEndpoints.has(toolActivity.endpointDigest)) return false;
		const session =
			this.logicalSessionOwners.get(toolActivity.sessionId) ?? this.sessions.get(toolActivity.sessionId);
		if (toolActivity.endpointDigest === undefined) return session === undefined;
		return session === toolActivity.session && session.endpointDigest === toolActivity.endpointDigest;
	}
	private toolActivityDeliveryIsCurrent(toolActivity: ToolActivityOwner): boolean {
		const key = `${toolActivity.sessionId}:tool:${toolActivity.toolCallId}`;
		const owner = this.toolActivityOwners.get(key);
		if (owner && owner.session !== toolActivity.session) return false;
		if (toolActivity.phase === "started") {
			const legacyStart =
				toolActivity.session.toolActivityCapability === "v1" ? this.legacyToolStarts.get(key) : undefined;
			return (
				(toolActivity.session.toolActivityCapability !== "v1" ||
					(legacyStart !== undefined &&
						legacyStart.owner === toolActivity &&
						legacyStart.phase !== "cancelled" &&
						legacyStart.phase !== "failed" &&
						legacyStart.phase !== "terminal")) &&
				this.toolActivityAuthorityIsCurrent(toolActivity) &&
				!this.toolActivityStopping &&
				this.opts.toolActivity?.enabled === true &&
				toolActivity.policyEpoch === this.toolActivityPolicyEpoch
			);
		}
		if (
			this.toolActivityAuthorityIsCurrent(toolActivity) &&
			this.opts.toolActivity?.enabled === true &&
			toolActivity.policyEpoch === this.toolActivityPolicyEpoch
		)
			return true;
		return this.liveMessages.has(key) && owner?.session === toolActivity.session;
	}
	private async submitThreadedFrame(
		sessionId: string,
		send: ThreadedSend,
		topicLease: TopicAuthorityLease,
		toolActivity?: ToolActivityOwner,
		socketLease?: { session: SessionSocket; token: number; logicalSessionId: string },
	): Promise<void> {
		const legacyStart =
			toolActivity?.phase === "started"
				? this.legacyToolStarts.get(`${toolActivity.sessionId}:tool:${toolActivity.toolCallId}`)
				: toolActivity?.phase === "terminal"
					? this.legacyToolStartForTerminal(toolActivity)
					: undefined;
		if (legacyStart !== undefined && legacyStart.owner === toolActivity) {
			if (toolActivity!.phase === "started") {
				legacyStart.phase = "queued";
				legacyStart.itemId ??= `legacy-tool-start:${this.nextLegacyToolStartId++}`;
			}
		}
		// Terminal frames get a distinct pool item identity so they cannot collide
		// with an in-flight start for the same legacy settlement.
		const poolItemId =
			legacyStart !== undefined && legacyStart.owner === toolActivity
				? toolActivity!.phase === "terminal"
					? `legacy-tool-terminal:${this.nextLegacyToolStartId++}`
					: legacyStart.itemId
				: undefined;
		const submitted = this.submitPool({
			sessionId,
			lane: send.lane,
			coalesceKey: send.coalesceKey,
			...(poolItemId !== undefined ? { itemId: poolItemId } : {}),
			payload: {
				send,
				topicLease,
				...(socketLease ? { socketLease } : {}),
				...(toolActivity ? { toolActivity } : {}),
				...(legacyStart !== undefined && toolActivity?.phase === "terminal"
					? { legacyToolStart: legacyStart }
					: {}),
			},
		});
		if (!submitted) {
			this.settleRejectedLegacyToolSubmission(toolActivity, legacyStart);
			return;
		}
		await this.flushPool();
	}

	private async existingTopicForPrivateChat(sessionId: string): Promise<string | undefined> {
		return (await this.topicAuthorityLease(sessionId))?.topicId;
	}

	private async topicAuthorityLease(sessionId: string): Promise<TopicAuthorityLease | undefined> {
		if (!(await this.pairedChatAllowsTopics())) return undefined;
		return this.topicAuthorityLeaseFromRegistry(sessionId);
	}

	private topicAuthorityLeaseFromRegistry(sessionId: string): TopicAuthorityLease | undefined {
		const topic = this.topics.get(sessionId);
		if (
			!topic ||
			!this.topics.isActiveUnambiguous(sessionId) ||
			topic.bindingMalformed ||
			topic.leaseOwner !== this.installationHostId ||
			(topic.leaseExpiresAt ?? 0) <= this.runtime.now()
		)
			return undefined;
		return { sessionId, topicId: topic.topicId, authorityEpoch: topic.authorityEpoch ?? 0 };
	}
	private topicLeaseIsCurrent(lease: TopicAuthorityLease): boolean {
		const topic = this.topics.get(lease.sessionId);
		return (
			this.topics.isActiveUnambiguous(lease.sessionId) &&
			!topic?.bindingMalformed &&
			topic?.leaseOwner === this.installationHostId &&
			(topic.leaseExpiresAt ?? 0) > this.runtime.now() &&
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

	private rememberPendingThreadedFrame(
		session: SessionSocket,
		send: ThreadedSend,
		msg: Record<string, unknown>,
		toolActivity?: ToolActivityOwner,
	): void {
		const logicalSessionId = this.#logicalSessionId(session);
		const socketLease = this.#socketLease(session, logicalSessionId);
		if (!socketLease && !session.logicalSessionIdTrusted) {
			this.failLegacyToolStart(toolActivity);
			return;
		}
		const frames = this.pendingThreadedFrames.get(logicalSessionId) ?? [];
		const legacyStart =
			toolActivity?.phase === "started"
				? this.legacyToolStarts.get(`${toolActivity.sessionId}:tool:${toolActivity.toolCallId}`)
				: undefined;
		if (legacyStart !== undefined && legacyStart.owner === toolActivity) legacyStart.phase = "pending_identity";
		frames.push({
			send,
			msg,
			logicalSessionId,
			session,
			socketLease,
			...(toolActivity ? { toolActivity } : {}),
		});
		if (frames.length > PENDING_TOPIC_FRAME_LIMIT) {
			const evicted = frames.shift();
			this.failLegacyToolStart(evicted?.toolActivity);
		}
		this.pendingThreadedFrames.set(logicalSessionId, frames);
	}

	private async flushPendingThreadedFrames(sessionId: string, topicLease: TopicAuthorityLease): Promise<void> {
		const frames = this.pendingThreadedFrames.get(sessionId);
		if (!frames || frames.length === 0) return;
		this.pendingThreadedFrames.delete(sessionId);
		for (const frame of frames) {
			const socketLease = frame.socketLease ?? this.#socketLease(frame.session, sessionId);
			if (
				frame.logicalSessionId !== sessionId ||
				!socketLease ||
				!this.#leaseTokenAllows(socketLease) ||
				(frame.msg.type === "tool_activity" && this.opts.toolActivity?.enabled !== true)
			) {
				this.failLegacyToolStart(frame.toolActivity);
				continue;
			}
			await this.submitThreadedFrame(sessionId, frame.send, topicLease, frame.toolActivity, socketLease);
		}
	}

	/**
	 * Resolve (creating once via `createForumTopic`) the forum topic for a
	 * session. On capability failure (e.g. Threaded Mode off) this returns
	 * `undefined`; callers then flat-deliver to a private paired chat (with a
	 * one-time nudge) or drop fail-closed for a non-private chat.
	 */
	private async ensureTopic(
		sessionId: string,
		name: string,
		session?: SessionSocket,
		creationLease?: { session: SessionSocket; token: number; logicalSessionId: string },
	): Promise<string | undefined> {
		if (!(await this.pairedChatAllowsTopics())) return undefined;
		if (session && sessionId === session.sessionId && this.#logicalSessionId(session) !== sessionId) return undefined;
		const capturedCreationLease = creationLease ?? (session ? this.#socketLease(session, sessionId) : undefined);
		if (session?.logicalSessionIdTrusted && !capturedCreationLease) return undefined;
		const creationEndpointKey = session?.endpointDigest ?? session?.endpointKey ?? "unbound";
		const malformedCreateEndpoint = this.#malformedTopicCreateEndpoints.get(sessionId);
		if (malformedCreateEndpoint === "unbound" || malformedCreateEndpoint === creationEndpointKey)
			throw new Error("createForumTopic: invalid message_thread_id");
		const existing = this.topics.get(sessionId);
		if (existing && (existing.authorityState !== "active" || existing.bindingMalformed)) return undefined;
		if (existing) return existing.topicId;
		if (
			session &&
			sessionId !== session.sessionId &&
			(!session.logicalSessionIdTrusted || sessionId !== this.#logicalSessionId(session))
		)
			return undefined;
		if (capturedCreationLease && !this.#leaseTokenAllows(capturedCreationLease)) return undefined;
		const creationBinding = session ? this.#endpointBinding(session) : undefined;
		const creationLeaseEpoch = this.topics.authorityEpoch(sessionId);
		let acceptedTopicId: string | undefined;
		let acceptedTopicCompensated = false;
		let acceptedTopicArchiveAttempted = false;
		let creationSuppressed = false;
		let creationRejected = false;
		let adoptedTopicId: number | undefined;
		const adoptionIntentCandidate = this.#adoptionIntents.bySession(sessionId);
		try {
			const rec = await this.topics.getOrCreateTopic(
				sessionId,
				async () => {
					if (capturedCreationLease && !this.#leaseTokenAllows(capturedCreationLease))
						throw new Error("topic authority was revoked during creation");
					// Adoption path: if a durable non-routable intent targets this
					// session, synchronously claim its user-created topicId, validate
					// chat/binding/pure availability, and RETURN it so getOrCreateTopic
					// commits the full record exactly once. createForumTopic is never
					// called for an adopted topic; acceptedTopicId stays unset so no
					// compensation path can delete the user topic.
					const adoptionIntent = adoptionIntentCandidate ? this.#adoptionIntents.bySession(sessionId) : undefined;
					if (adoptionIntentCandidate && !adoptionIntent) {
						throw new Error("topic adoption refused: intent expired before consumption");
					}
					if (adoptionIntent) {
						const chatId = String(this.opts.chatId);
						const topicIdStr = String(adoptionIntent.topicId);
						const chatMatches = adoptionIntent.chatId === chatId;
						const bindingChatMatches = !creationBinding || creationBinding.chatId === chatId;
						const available = this.topics.isTopicIdAvailable(topicIdStr);
						if (!chatMatches || !bindingChatMatches || !available) {
							// Fail closed: never fall back to remote-create over a user topic.
							throw new Error("topic adoption refused: intent chat/binding/topic unavailable");
						}
						if (!this.#adoptionIntents.tryClaim(adoptionIntent.topicId, sessionId)) {
							throw new Error("topic adoption refused: concurrent claim held");
						}
						this.#malformedTopicCreateEndpoints.delete(sessionId);
						adoptedTopicId = adoptionIntent.topicId;
						return topicIdStr;
					}
					const res = (await this.botApi.call("createForumTopic", { chat_id: this.opts.chatId, name })) as
						| { result?: { message_thread_id?: unknown } }
						| undefined;
					if (res === undefined) {
						creationSuppressed = true;
						return undefined;
					}
					if (isThreadedModeCapabilityRefusal(res)) throw new ThreadedModeCapabilityRefusal();
					const response = res as {
						ok?: unknown;
						result?: { message_thread_id?: unknown };
					};
					const tid = response.result?.message_thread_id;
					if (typeof tid !== "number" || !Number.isSafeInteger(tid) || tid <= 0) {
						creationRejected = response.ok === false;
						if (!creationRejected) this.#malformedTopicCreateEndpoints.set(sessionId, creationEndpointKey);
						throw new Error("createForumTopic: invalid message_thread_id");
					}
					acceptedTopicId = String(tid);
					this.#malformedTopicCreateEndpoints.delete(sessionId);
					if (capturedCreationLease && !(await this.#awaitCreationLeaseAuthority(capturedCreationLease))) {
						if (
							!this.topics.fenceAcceptedCreateForLease(
								sessionId,
								acceptedTopicId,
								creationLeaseEpoch,
								this.installationHostId,
								this.opts.now,
								name,
								creationBinding,
								undefined,
								String(this.opts.chatId),
							)
						)
							throw new Error("topic authority was revoked during creation");
						try {
							await this.persistTopics();
						} catch (error) {
							this.topics.scheduleArchiveRetry(
								sessionId,
								this.runtime.now(),
								"archive fence persistence failed",
							);
							try {
								await this.#persistTopicsWithRetry();
							} catch {
								await this.#superviseCompensationFence(sessionId);
							}
							throw error;
						}
						if (
							this.#acceptedCreateArchiveFenceAllows(
								sessionId,
								acceptedTopicId,
								creationLeaseEpoch,
								creationBinding,
							)
						) {
							acceptedTopicArchiveAttempted = true;
							acceptedTopicCompensated = (await this.archiveTopic(sessionId, undefined, true)) === "settled";
						}
						throw new Error("topic authority was revoked during creation");
					}
					return acceptedTopicId;
				},
				this.opts.now,
				name,
				creationBinding,
				() => this.persistTopics(),
				session,
				adoptionIntentCandidate ? "user_created" : undefined,
			);
			// Adoption commit success removes only the sidecar. The committed
			// user-created topic remains retained even when sidecar cleanup fails.
			if (adoptedTopicId !== undefined) {
				if (adoptionIntentCandidate)
					logger.info(
						`notifications: topic-adoption committed age_ms=${Math.max(0, this.runtime.now() - adoptionIntentCandidate.createdAt)}`,
					);
				try {
					await this.#adoptionIntents.remove(sessionId);
					await this.#adoptionIntents.removePendingTopic(adoptedTopicId);
				} catch (error) {
					logger.warn(
						`notifications: topic-adoption sidecar cleanup failed; retained for reconciliation: ${sanitizeDiagnostic(String(error))}`,
					);
				}
			}
			// Publish the durable host lease before rechecking the captured socket
			// lease. The recheck consults the registry once a record exists, so the
			// newly-created record must already authorize this host.
			if (!(await this.#renewTopicLease(sessionId))) return undefined;
			// getOrCreateTopic deduplicates callers, so an accepted create can be
			// observed by a successor after its initiating socket was revoked. Check
			// the immutable lease again before exposing that record to frame delivery.
			if (capturedCreationLease && this.#isEagerCreationHandoff(capturedCreationLease)) {
				const binding = this.#endpointBinding(capturedCreationLease.session);
				if (
					this.topics.bindEndpoint(
						sessionId,
						binding,
						this.#activeEndpointKeysFor(sessionId, capturedCreationLease.session),
						true,
					) !== "unchanged"
				)
					await this.persistTopics();
			}
			if (capturedCreationLease && !(await this.#awaitCreationLeaseAuthority(capturedCreationLease))) {
				if (
					this.topics.fenceAcceptedCreateForLease(
						sessionId,
						rec.topicId,
						creationLeaseEpoch,
						this.installationHostId,
						this.opts.now,
						name,
						creationBinding,
						undefined,
						String(this.opts.chatId),
					)
				) {
					try {
						await this.persistTopics();
					} catch {
						this.#superviseCompensationFence(sessionId);
						return undefined;
					}
					if (this.#acceptedCreateArchiveFenceAllows(sessionId, rec.topicId, creationLeaseEpoch, creationBinding))
						await this.archiveTopic(sessionId, undefined, true);
				}
				return undefined;
			}
			return rec.topicId;
		} catch (err) {
			if (adoptedTopicId !== undefined) this.#adoptionIntents.releaseClaim(adoptedTopicId, sessionId);
			if (adoptionIntentCandidate) this.topics.abandonCreateClaim(sessionId, creationLeaseEpoch);
			if (creationSuppressed || creationRejected || err instanceof ThreadedModeCapabilityRefusal) {
				if (this.topics.abandonCreateClaim(sessionId, creationLeaseEpoch)) await this.persistTopics();
				return undefined;
			}
			const revokedAcceptedRecord = acceptedTopicId ? this.topics.get(sessionId) : undefined;
			if (
				revokedAcceptedRecord !== undefined &&
				revokedAcceptedRecord.topicId === acceptedTopicId &&
				revokedAcceptedRecord.authorityState === "archive_pending" &&
				!this.topics.archiveAuthorityAllows(
					sessionId,
					this.installationHostId,
					this.opts.chatId,
					this.runtime.now(),
				)
			) {
				if (
					revokedAcceptedRecord.chatId === undefined &&
					revokedAcceptedRecord.endpointKey === undefined &&
					revokedAcceptedRecord.endpointDigest === undefined
				)
					revokedAcceptedRecord.chatId = String(this.opts.chatId);
				this.topics.beginArchive(sessionId, this.installationHostId, this.runtime.now());
				await this.persistTopics();
			}
			if (
				acceptedTopicId &&
				!acceptedTopicCompensated &&
				!acceptedTopicArchiveAttempted &&
				this.topics.get(sessionId)?.authorityState !== "archive_pending"
			) {
				// A failed initial commit must never make compensation conditional on
				// successfully publishing its fence.
				if (
					this.topics.fenceAcceptedCreateForLease(
						sessionId,
						acceptedTopicId,
						creationLeaseEpoch,
						this.installationHostId,
						this.opts.now,
						name,
						creationBinding,
						undefined,
						String(this.opts.chatId),
					)
				) {
					try {
						await this.#persistTopicsWithRetry();
					} catch {
						await this.#superviseCompensationFence(sessionId);
					}

					if (
						this.#acceptedCreateArchiveFenceAllows(
							sessionId,
							acceptedTopicId,
							creationLeaseEpoch,
							creationBinding,
						)
					) {
						try {
							acceptedTopicArchiveAttempted = true;
							acceptedTopicCompensated = (await this.archiveTopic(sessionId, undefined, true)) === "settled";
						} catch {
							this.#superviseCompensationFence(sessionId);
							await this.#persistTopicsWithRetry().catch(() => undefined);
						}
					}
				}
			}
			if (acceptedTopicId && !acceptedTopicCompensated && acceptedTopicArchiveAttempted) {
				this.#superviseCompensationFence(sessionId);
				await this.#persistTopicsWithRetry().catch(() => undefined);
			}
			if (session && err instanceof Error && err.message === "topic authority was revoked during creation")
				return undefined;
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
		await this.#withRecoveryBindingClaim(async () => {
			const owner = this.logicalSessionOwners.get(sessionId);
			if (owner && this.#leaseAllows(owner, sessionId)) {
				if (this.topics.clearOrphaned(sessionId)) await this.persistTopics();
				return;
			}
			if (this.topics.markOrphaned(sessionId, this.runtime.now())) await this.persistTopics();
			if (!this.topicPastOrphanGrace(sessionId)) return;
			const currentOwner = this.logicalSessionOwners.get(sessionId);
			if (currentOwner && this.#leaseAllows(currentOwner, sessionId)) return;
			await this.archiveTopic(sessionId);
		});
	}

	/** Best-effort delete of a session topic once its local notification endpoint shuts down. */
	/** Join all close, compensation, orphan, and restart callers for one session. */
	private archiveTopic(
		sessionId: string,
		socketLease?: { session: SessionSocket; token: number; logicalSessionId: string },
		archiveFenceAlreadyPublished = false,
	): Promise<"pre_dispatch_cancelled" | "post_dispatch_pending" | "settled"> {
		const active = this.archiveFlights.get(sessionId);
		if (active) return active;
		const flight = this.#archiveTopicOnce(sessionId, socketLease, archiveFenceAlreadyPublished);
		this.archiveFlights.set(sessionId, flight);
		void flight.then(
			() => {
				if (this.archiveFlights.get(sessionId) === flight) this.archiveFlights.delete(sessionId);
			},
			() => {
				if (this.archiveFlights.get(sessionId) === flight) this.archiveFlights.delete(sessionId);
			},
		);
		return flight;
	}

	/** One durable archive fence and at most one remote close dispatch per flight. */
	async #archiveTopicOnce(
		sessionId: string,
		socketLease?: { session: SessionSocket; token: number; logicalSessionId: string },
		archiveFenceAlreadyPublished = false,
	): Promise<"pre_dispatch_cancelled" | "post_dispatch_pending" | "settled"> {
		if (!(await this.pairedChatAllowsTopics())) return "pre_dispatch_cancelled";
		const existing = this.topics.get(sessionId);
		// A completed archive retains an inactive record as historical evidence.
		// Re-archiving it would duplicate the irreversible remote close request.
		if (existing?.authorityState === "inactive") return "settled";
		if (existing?.topicOrigin === "user_created") {
			if (existing.authorityState === "archive_pending") {
				const archiveSnapshot = this.topics.captureArchiveAuthority(sessionId);
				const authorityEpoch = existing.authorityEpoch ?? Number.MAX_SAFE_INTEGER;
				if (!this.topics.settleArchive(sessionId, existing.topicId, authorityEpoch)) return "post_dispatch_pending";
				try {
					await this.persistTopics();
				} catch {
					this.topics.restoreArchiveFence(archiveSnapshot);
					await this.#persistTopicsWithRetry().catch(() => undefined);
					return "post_dispatch_pending";
				}
			}
			return "settled";
		}
		const archiveSnapshot = this.topics.captureArchiveAuthority(sessionId);
		let record = archiveFenceAlreadyPublished
			? existing
			: this.topics.beginArchive(sessionId, this.installationHostId, this.runtime.now());
		if (socketLease && !this.#deleteLeaseAllows(socketLease)) return "pre_dispatch_cancelled";
		if (
			record &&
			!this.topics.archiveAuthorityAllows(sessionId, this.installationHostId, this.opts.chatId, this.runtime.now())
		)
			return "pre_dispatch_cancelled";
		if (!archiveFenceAlreadyPublished) await this.persistTopics();
		if (socketLease && !this.#deleteLeaseAllows(socketLease)) return "pre_dispatch_cancelled";
		if (
			record &&
			!this.topics.archiveAuthorityAllows(sessionId, this.installationHostId, this.opts.chatId, this.runtime.now())
		)
			return "pre_dispatch_cancelled";
		await this.#revokeAskAuthority(sessionId);
		this.deleteMessageRoutes(sessionId);
		this.#clearModelChoiceAliases(sessionId);
		if (!record) {
			await this.topics.awaitInflight(sessionId);
			record = this.topics.get(sessionId);
			await this.persistTopics();
			if (!record) return "settled";
			if (
				!this.topics.archiveAuthorityAllows(
					sessionId,
					this.installationHostId,
					this.opts.chatId,
					this.runtime.now(),
				)
			)
				return "pre_dispatch_cancelled";
		}
		const dispatchedAuthorityEpoch = record.authorityEpoch ?? Number.MAX_SAFE_INTEGER;
		const removed = this.pool.removeWhere(item => item.sessionId === sessionId);
		for (const item of removed) {
			if (item.payload.selectedAck)
				this.finishSelectedAck(item.payload.selectedAck, { status: "failed", reason: "cancelled" });
			item.payload.btwDelivery?.finish("stale");
		}
		try {
			await this.flushPool();
			if (socketLease && !this.#deleteLeaseAllows(socketLease)) return "pre_dispatch_cancelled";
			if (
				!this.topics.archiveAuthorityAllows(
					sessionId,
					this.installationHostId,
					this.opts.chatId,
					this.runtime.now(),
				)
			)
				return "pre_dispatch_cancelled";
			const res = (await this.botApi.call("closeForumTopic", {
				chat_id: this.opts.chatId,
				message_thread_id: Number(record.topicId),
			})) as { ok?: boolean };
			if (!topicArchiveSettled(res)) {
				this.topics.scheduleArchiveRetry(sessionId, this.runtime.now(), "archive result was not definitive");
				await this.persistTopics();
				return "post_dispatch_pending";
			}
			if (!this.topics.settleArchive(sessionId, record.topicId, dispatchedAuthorityEpoch))
				return "post_dispatch_pending";
			for (const k of [...this.liveMessages.keys()])
				if (k.startsWith(`${sessionId}:`)) {
					this.liveMessages.delete(k);
					this.toolActivityOwners.delete(k);
				}
			this.topicOwnerByIdentity.forEach((ownerSessionId, identityKey) => {
				if (ownerSessionId === sessionId) this.topicOwnerByIdentity.delete(identityKey);
			});
			this.pendingThreadedFrames.delete(sessionId);
			try {
				await this.persistTopics();
				return "settled";
			} catch {
				this.topics.restoreArchiveFence(archiveSnapshot);
				await this.#persistTopicsWithRetry().catch(() => undefined);
				return "post_dispatch_pending";
			}
		} catch {
			// Once Telegram dispatch starts, retain the persisted archive fence: the
			// remote result is ambiguous and may not restore stale routing authority.
			this.topics.scheduleArchiveRetry(sessionId, this.runtime.now(), "archive transport failed");
			await this.persistTopics().catch(() => undefined);
			return "post_dispatch_pending";
		}
	}

	/** Serialize a mutation and its durable snapshot so rollback precedes later writers. */
	#persistTopicMutation<T>(mutation: () => T, rollback: () => void): Promise<T> {
		if (this.validationMode()) return Promise.resolve().then(mutation);
		const pending = this.topicsPersistQueue.then(async () => {
			let result = mutation();
			const authority = this.opts.topicRegistryAuthority;
			let sharedCommitted = false;
			let latestWinner: TopicRegistryState | undefined;
			try {
				const snapshot = this.#topicStateForPersistence();
				if (authority) {
					for (let attempt = 0; attempt < 3; attempt++) {
						const expectedGeneration = this.topics.registryVersion();
						const snapshot = this.#topicStateForPersistence();
						const nextGeneration = expectedGeneration + 1;
						snapshot.registryGeneration = nextGeneration;
						let accepted = false;
						try {
							accepted = await authority.compareAndSet(expectedGeneration, snapshot);
						} catch {
							throw new Error("shared topic authority unavailable");
						}
						if (accepted) {
							this.topics.markRegistryPublished(nextGeneration);
							sharedCommitted = true;
							break;
						}
						const winner = parseTopicRegistryState(await authority.read().catch(() => undefined));
						if (!winner) throw new Error("shared topic authority conflict");
						latestWinner = winner;
						this.#replaceTopicAuthority(winner);
						if (attempt === 2) throw new Error("shared topic authority conflict");
						result = mutation();
					}
				}
				if (!authority) {
					const paths = daemonPaths(this.opts.settings.getAgentDir());
					await ensureDir(this.fsImpl, paths.dir);
					const expectedDestination = await captureTopicRegistryDestination(
						this.fsImpl,
						path.join(paths.dir, "telegram-topics.json"),
						process.platform,
					);
					await writeTopicRegistryAtomic(
						this.fsImpl,
						path.join(paths.dir, "telegram-topics.json"),
						snapshot,
						process.platform,
						exactReplacePath,
						expectedDestination,
					);
				}
				return result;
			} catch (error) {
				if (sharedCommitted && authority) {
					const committed = await authority.read().catch(() => undefined);
					const state = parseTopicRegistryState(committed);
					if (state) {
						this.topics.replace(state);
						this.closedEndpointKeys.clear();
						for (const [sessionId, binding] of Object.entries(state.closedEndpoints ?? {}))
							if (binding) this.closedEndpointKeys.set(sessionId, binding);
					}
				} else if (latestWinner) {
					this.#replaceTopicAuthority(latestWinner);
				} else {
					rollback();
				}
				throw error;
			}
		});
		this.topicsPersistQueue = pending.then(
			() => undefined,
			() => undefined,
		);
		return pending;
	}

	async #persistTopicsWithRetry(): Promise<void> {
		try {
			await this.persistTopics();
		} catch {
			await this.persistTopics();
		}
	}

	async #superviseCompensationFence(sessionId: string): Promise<void> {
		const existing = this.compensationFenceRetries.get(sessionId);
		if (existing) return await existing;
		const retry = this.effects.track(
			(async () => {
				for (;;) {
					try {
						await this.persistTopics();
						return;
					} catch {
						await this.runtime.sleep(250);
					}
				}
			})(),
		);
		this.compensationFenceRetries.set(sessionId, retry);
		try {
			await retry;
		} finally {
			if (this.compensationFenceRetries.get(sessionId) === retry) this.compensationFenceRetries.delete(sessionId);
		}
	}

	private persistTopics(): Promise<void> {
		if (this.validationMode()) return Promise.resolve();
		const pending = this.topicsPersistQueue.then(async () => {
			// Resolve implicit snapshots inside the serialization queue. Callers that
			// mutate the registry before waiting cannot overwrite a newer authority
			// binding with an invocation-time snapshot.
			const snapshot = this.#topicStateForPersistence();
			const authority = this.opts.topicRegistryAuthority;
			if (authority) {
				const expectedGeneration = this.topics.registryVersion();
				const nextGeneration = expectedGeneration + 1;
				snapshot.registryGeneration = nextGeneration;
				let accepted = false;
				try {
					accepted = await authority.compareAndSet(expectedGeneration, snapshot);
				} catch {
					throw new Error("shared topic authority unavailable");
				}
				if (!accepted) {
					let winner: TopicRegistryState | undefined;
					try {
						winner = parseTopicRegistryState(await authority.read());
					} catch {
						throw new Error("shared topic authority unavailable");
					}
					if (!winner) throw new Error("shared topic authority conflict");
					this.#replaceTopicAuthority(winner);
					throw new Error("shared topic authority conflict");
				}
				this.topics.markRegistryPublished(nextGeneration);
			}
			if (!authority) {
				const paths = daemonPaths(this.opts.settings.getAgentDir());
				await ensureDir(this.fsImpl, paths.dir);
				const topicPath = path.join(paths.dir, "telegram-topics.json");
				const expectedDestination = await captureTopicRegistryDestination(this.fsImpl, topicPath, process.platform);
				await writeTopicRegistryAtomic(
					this.fsImpl,
					topicPath,
					snapshot,
					process.platform,
					exactReplacePath,
					expectedDestination,
				);
			}
		});
		this.topicsPersistQueue = pending.catch(() => undefined);
		return pending;
	}

	#acceptedCreateArchiveFenceAllows(
		sessionId: string,
		topicId: string,
		creationLeaseEpoch: number,
		binding: TopicEndpointBinding | undefined,
	): boolean {
		const record = this.topics.get(sessionId);
		const bindingMatches = binding
			? record?.chatId === binding.chatId &&
				record.endpointKey === binding.endpointKey &&
				record.endpointDigest === binding.endpointDigest &&
				record.endpointGeneration === binding.endpointGeneration
			: record?.chatId === String(this.opts.chatId) &&
				record.endpointKey === undefined &&
				record.endpointDigest === undefined;
		return (
			record?.topicId === topicId &&
			record.creationLeaseEpoch === creationLeaseEpoch &&
			bindingMatches &&
			this.topics.archiveAuthorityAllows(sessionId, this.installationHostId, this.opts.chatId, this.runtime.now())
		);
	}

	#replaceTopicAuthority(state: TopicRegistryState): void {
		this.topics.replace(state);
		this.closedEndpointKeys.clear();
		for (const [sessionId, binding] of Object.entries(state.closedEndpoints ?? {}))
			if (binding) this.closedEndpointKeys.set(sessionId, binding);
	}

	#topicStateForPersistence(): TopicRegistryState {
		return {
			...this.topics.serialize(),
			closedEndpoints: Object.fromEntries(this.closedEndpointKeys),
			...(this.opts.topicRegistryAuthority ? {} : { installationHostId: this.installationHostId }),
		};
	}

	async loadTopics(): Promise<void> {
		if (this.validationMode()) return;
		const paths = daemonPaths(this.opts.settings.getAgentDir());
		const topicPath = path.join(paths.dir, "telegram-topics.json");
		let raw = await readJson<unknown>(this.fsImpl, topicPath);
		if (this.opts.topicRegistryAuthority) {
			try {
				raw = await this.opts.topicRegistryAuthority.read();
			} catch {
				throw new Error("shared topic authority unavailable");
			}
			if (!raw) throw new Error("shared topic authority unavailable");
		}
		const legacySnapshot =
			!!raw && typeof raw === "object" && !Array.isArray(raw) && !Object.hasOwn(raw as object, "version");
		if (legacySnapshot && raw !== undefined) {
			const legacyDigest = crypto.createHash("sha256").update(JSON.stringify(raw)).digest("hex");
			const quarantinePath = path.join(paths.dir, `telegram-topics.legacy-quarantine.${legacyDigest}.json`);
			if ((await readJson<unknown>(this.fsImpl, quarantinePath)) === undefined) {
				await ensureDir(this.fsImpl, paths.dir);
				await writeTopicRegistryAtomic(this.fsImpl, quarantinePath, raw);
			}
		}
		const state = parseTopicRegistryState(raw);
		// Restore the full serialized registry (topicId + identitySent + name) so a
		// fresh daemon after reload does not resend identity headers or lose renames.
		if (state) {
			const missingHostId =
				!this.opts.topicRegistryAuthority &&
				(typeof state.installationHostId !== "string" || state.installationHostId.length === 0);
			const missingSessionUuid = Object.values(state.topics).some(
				record => !!record && typeof record === "object" && typeof record.sessionUuid !== "string",
			);
			this.topics.load(state);
			if (!this.opts.topicRegistryAuthority && typeof state.installationHostId === "string")
				this.installationHostId = state.installationHostId;
			let reconciledCreateClaim = false;
			for (const claim of this.topics.pendingCreateClaims()) {
				const topic = this.topics.get(claim.sessionId);
				reconciledCreateClaim = this.topics.reconcileCreateClaim(claim.sessionId, topic) || reconciledCreateClaim;
			}
			for (const [sessionId, binding] of Object.entries(state.closedEndpoints ?? {})) {
				if (
					binding &&
					typeof binding.chatId === "string" &&
					typeof binding.endpointKey === "string" &&
					typeof binding.endpointDigest === "string" &&
					(binding.endpointGeneration === undefined ||
						(Number.isSafeInteger(binding.endpointGeneration) && binding.endpointGeneration >= 0))
				)
					this.closedEndpointKeys.set(sessionId, binding);
			}
			if (legacySnapshot || missingHostId || missingSessionUuid || reconciledCreateClaim) await this.persistTopics();
		}
	}

	/**
	 * Rehydrate durable adoption intents after restart. A sidecar whose topic
	 * already committed is stale evidence and can be removed without touching
	 * the retained user-created topic.
	 */
	async loadAdoptionIntents(): Promise<void> {
		await this.#adoptionIntents.rehydrate();
		const expired = await this.#adoptionIntents.sweepExpired();
		if (expired > 0) logger.info(`notifications: topic-adoption expired count=${expired}`);
		for (const sessionId of this.topics.sessionIds()) {
			const intent = this.#adoptionIntents.bySession(sessionId);
			if (!intent) continue;
			const record = this.topics.get(sessionId);
			if (record && record.topicId === String(intent.topicId)) {
				try {
					await this.#adoptionIntents.remove(sessionId);
					await this.#adoptionIntents.removePendingTopic(intent.topicId);
				} catch (error) {
					logger.warn(
						`notifications: stale topic-adoption sidecar cleanup failed: ${sanitizeDiagnostic(String(error))}`,
					);
				}
			}
		}
	}

	private startAdoptionSweepTimer(): void {
		const setIntervalImpl = this.opts.setIntervalImpl ?? setInterval;
		this.#adoptionSweepTimer = setIntervalImpl(() => {
			this.#sweepExpiredAdoptionPickerAliases();
			void this.#adoptionIntents
				.sweepExpired()
				.then(expired => {
					if (expired > 0) logger.info(`notifications: topic-adoption expired count=${expired}`);
				})
				.catch(error => {
					logger.warn(`notifications: adoption-intent sweep failed: ${sanitizeDiagnostic(String(error))}`);
				});
		}, ADOPTION_INTENT_SWEEP_INTERVAL_MS);
	}

	private stopAdoptionSweepTimer(): void {
		if (this.#adoptionSweepTimer !== undefined) {
			(this.opts.clearIntervalImpl ?? clearInterval)(this.#adoptionSweepTimer);
			this.#adoptionSweepTimer = undefined;
		}
	}

	/** Retry crash-interrupted topic archives only when the durable backoff permits it. */
	private async reconcilePendingTopicDeletes(): Promise<void> {
		for (const sessionId of this.topics.archivePendingSessionIds(this.runtime.now()))
			await this.archiveTopic(sessionId);
	}

	/** Download one Telegram file with the Bot API's 20 MiB ceiling and one end-to-end deadline. */
	private async downloadTelegramFile(
		filePath: string,
		maxBytes = TELEGRAM_ATTACHMENT_MAX_BYTES,
		deadlineController?: AbortController,
	): Promise<TelegramFileDownload> {
		const apiBase = this.opts.apiBase ?? "https://api.telegram.org";
		const fetchImpl = this.opts.fetchImpl ?? fetch;
		// `filePath` is remote metadata from getFile; reject suspicious segments
		// (traversal/absolute/backslash) and percent-encode each component before
		// composing the download URL.
		if (filePath.includes("..") || filePath.startsWith("/") || filePath.includes("\\")) {
			logger.warn("notifications: rejecting suspicious Telegram file_path");
			return { failure: "download_failed" };
		}
		const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
		const url = `${apiBase}/file/bot${this.opts.botToken}/${encodedPath}`;
		const controller = deadlineController ?? new AbortController();
		let cancelActiveReader: (() => Promise<void>) | undefined;
		const setTimeoutImpl = this.opts.setTimeoutImpl ?? setTimeout;
		const clearTimeoutImpl = this.opts.clearTimeoutImpl ?? clearTimeout;
		const timeout = deadlineController
			? undefined
			: setTimeoutImpl(
					() => controller.abort(new Error("Telegram attachment download timed out")),
					TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
				);
		const cancelReader = () => void cancelActiveReader?.();
		controller.signal.addEventListener("abort", cancelReader, { once: true });
		try {
			const res = await fetchImpl(url, { signal: controller.signal });
			if (!res.ok) {
				await res.body?.cancel().catch(() => undefined);
				controller.abort();
				return { failure: "download_failed" };
			}
			const declaredLength = res.headers.get("content-length");
			if (declaredLength !== null) {
				const declaredBytes = Number(declaredLength);
				if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > maxBytes) {
					await res.body?.cancel().catch(() => undefined);
					controller.abort();
					return { failure: "too_large" };
				}
			}
			if (!res.body) {
				controller.abort();
				return { failure: "download_failed" };
			}
			const reader = res.body.getReader();
			cancelActiveReader = () => reader.cancel().catch(() => undefined);
			controller.signal.throwIfAborted();
			const chunks: Buffer[] = [];
			let total = 0;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > maxBytes) {
					await reader.cancel().catch(() => undefined);
					controller.abort();
					return { failure: "too_large" };
				}
				chunks.push(Buffer.from(value));
			}
			controller.signal.throwIfAborted();
			return { bytes: Buffer.concat(chunks, total) };
		} catch (e) {
			await cancelActiveReader?.();
			controller.abort();
			logger.warn(`notifications: file download failed: ${sanitizeDiagnostic(String(e))}`);
			return { failure: "download_failed" };
		} finally {
			controller.signal.removeEventListener("abort", cancelReader);
			if (timeout !== undefined) clearTimeoutImpl(timeout);
		}
	}

	/**
	 * Per-session private temp directories (mode 0700) holding inbound non-image
	 * attachments. Keyed by session id and reused across transient reconnects;
	 * removed when the daemon stops (see {@link cleanupAllAttachmentDirs}).
	 */
	private readonly attachmentDirs = new Map<string, string>();
	readonly #attachmentUsage = new Map<string, { count: number; bytes: number }>();
	readonly #attachmentChains = new Map<string, Promise<void>>();

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
		this.#attachmentUsage.clear();
		this.#attachmentChains.clear();
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
		const previous = this.#attachmentChains.get(sessionId) ?? Promise.resolve();
		const task = previous.then(() => this.resolveInboundAttachmentSerial(att, sessionId));
		const chain = task.then(
			() => undefined,
			() => undefined,
		);
		this.#attachmentChains.set(sessionId, chain);
		return task.finally(() => {
			if (this.#attachmentChains.get(sessionId) === chain) this.#attachmentChains.delete(sessionId);
		});
	}

	private async resolveInboundAttachmentSerial(
		att: InboundAttachment,
		sessionId: string,
	): Promise<{ images: { data: string; mime?: string }[]; fileNotes: string[] }> {
		const images: { data: string; mime?: string }[] = [];
		const fileNotes: string[] = [];
		const label = att.fileName ?? att.kind;
		let timeout: NodeJS.Timeout | undefined;
		try {
			const usage = this.#attachmentUsage.get(sessionId) ?? { count: 0, bytes: 0 };
			if (
				usage.count >= TELEGRAM_SESSION_ATTACHMENT_MAX_COUNT ||
				usage.bytes >= TELEGRAM_SESSION_ATTACHMENT_MAX_BYTES
			) {
				fileNotes.push(`[attachment rejected: ${label}; session attachment limit reached]`);
				return { images, fileNotes };
			}
			const controller = new AbortController();
			timeout = (this.opts.setTimeoutImpl ?? setTimeout)(
				() => controller.abort(new Error("Telegram attachment download timed out")),
				TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
			);
			const got = (await this.botApi.call("getFile", { file_id: att.fileId }, { signal: controller.signal })) as {
				result?: { file_path?: unknown; file_size?: unknown };
			};
			const filePath = typeof got?.result?.file_path === "string" ? got.result.file_path : undefined;
			if (!filePath) {
				fileNotes.push(`[attachment unavailable: ${label}]`);
				return { images, fileNotes };
			}
			const declaredBytes = got.result?.file_size;
			const remainingBytes = TELEGRAM_SESSION_ATTACHMENT_MAX_BYTES - usage.bytes;
			if (
				(typeof declaredBytes === "number" &&
					(!Number.isSafeInteger(declaredBytes) ||
						declaredBytes < 0 ||
						declaredBytes > TELEGRAM_ATTACHMENT_MAX_BYTES ||
						declaredBytes > remainingBytes)) ||
				remainingBytes <= 0
			) {
				fileNotes.push(`[attachment rejected: ${label}; size limit exceeded]`);
				return { images, fileNotes };
			}
			const downloaded = await this.downloadTelegramFile(
				filePath,
				Math.min(TELEGRAM_ATTACHMENT_MAX_BYTES, remainingBytes),
				controller,
			);
			if ("failure" in downloaded) {
				fileNotes.push(
					downloaded.failure === "too_large"
						? `[attachment rejected: ${label}; size limit exceeded]`
						: `[attachment download failed: ${label}]`,
				);
				return { images, fileNotes };
			}
			const bytes = downloaded.bytes;
			const accountedBytes = Math.max(bytes.byteLength, typeof declaredBytes === "number" ? declaredBytes : 0);
			const current = this.#attachmentUsage.get(sessionId) ?? { count: 0, bytes: 0 };
			if (
				current.count >= TELEGRAM_SESSION_ATTACHMENT_MAX_COUNT ||
				current.bytes + accountedBytes > TELEGRAM_SESSION_ATTACHMENT_MAX_BYTES
			) {
				fileNotes.push(`[attachment rejected: ${label}; session attachment limit reached]`);
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
				try {
					await fs.promises.writeFile(dest, bytes, { flag: "wx", mode: 0o600 });
				} catch (e) {
					await fs.promises.unlink(dest).catch(() => undefined);
					throw e;
				}
				fileNotes.push(`[user attached a file, saved to ${dest}${att.mime ? ` (${att.mime})` : ""}]`);
			}
			this.#attachmentUsage.set(sessionId, { count: current.count + 1, bytes: current.bytes + accountedBytes });
		} catch (e) {
			logger.warn(`notifications: inbound attachment failed: ${String(e)}`);
			fileNotes.push(`[attachment error: ${label}]`);
		} finally {
			if (timeout !== undefined) (this.opts.clearTimeoutImpl ?? clearTimeout)(timeout);
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
			this.failLegacyToolStart(expiredItem.payload.toolActivity);
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
			const toolActivity = item.payload.toolActivity;
			const legacyStart =
				toolActivity?.phase === "started"
					? this.legacyToolStarts.get(`${toolActivity.sessionId}:tool:${toolActivity.toolCallId}`)
					: undefined;
			if (legacyStart !== undefined && legacyStart.owner === toolActivity && legacyStart.phase === "queued")
				legacyStart.phase = "dispatching";
			if (toolActivity && !this.toolActivityDeliveryIsCurrent(toolActivity)) {
				const key = `${toolActivity.sessionId}:tool:${toolActivity.toolCallId}`;
				const owner = this.toolActivityOwners.get(key);
				if (!this.liveMessages.has(key) && owner?.session === toolActivity.session)
					this.toolActivityOwners.delete(key);
				this.failLegacyToolStart(toolActivity);
				this.pool.settle(item.itemId!, "removed");
				continue;
			}
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
					const { outcome } = await this.callBotApiClassified("sendMessage", btwDelivery.body, {
						noRetry: true,
						signal: btwDelivery.signal,
					});
					if (outcome.kind === "retryable") {
						this.submitPool({
							sessionId: item.sessionId,
							lane: item.lane,
							coalesceKey: item.coalesceKey,
							deadlineAt: item.deadlineAt,
							payload: item.payload,
						});
						this.pool.settle(item.itemId!, "ambiguous");
						continue;
					}
					btwDelivery.finish(
						outcome.kind === "accepted"
							? "accepted"
							: outcome.kind === "rejected"
								? "not_delivered"
								: "uncertain",
					);
					this.pool.settle(
						item.itemId!,
						outcome.kind === "accepted" ? "accepted" : outcome.kind === "rejected" ? "rejected" : "ambiguous",
					);
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
					this.#leaseTokenAllows(selectedAck.socketLease) &&
					(await this.pairedChatIsPrivate()) &&
					(!topicLease || this.topicLeaseIsCurrent(topicLease));
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
					if (
						!this.#leaseTokenAllows(selectedAck.socketLease) ||
						(topicLease && !this.topicLeaseIsCurrent(topicLease))
					) {
						this.finishSelectedAck(selectedAck, { status: "failed", reason: "route_missing" });
						this.pool.settle(item.itemId!, "rejected");
						continue;
					}
					const { response, outcome } = await this.callBotApiClassified(
						"sendMessage",
						{
							chat_id: this.opts.chatId,
							...(topicLease ? { message_thread_id: Number(topicLease.topicId) } : {}),
							text: "Selected!",
							...(telegramDisableNotification(this.opts.sound, item.lane) === true
								? { disable_notification: true }
								: {}),
						},
						{ signal: controller.signal, noRetry: true },
					);
					if (outcome.kind === "retryable") {
						this.pool.settle(item.itemId!, "ambiguous");
						if (this.effects.stopping) {
							this.finishSelectedAck(selectedAck, { status: "unknown", reason: "shutdown" });
						} else {
							const retry = this.pool.submit({
								sessionId: item.sessionId,
								lane: item.lane,
								coalesceKey: item.coalesceKey,
								deadlineAt: item.deadlineAt,
								payload: item.payload,
							});
							selectedAck.itemId = retry.itemId;
							selectedAck.state = "queued";
							selectedAck.controller = undefined;
						}
						continue;
					}
					const typedResponse = response as { ok?: unknown; result?: { message_id?: unknown } } | undefined;
					const messageId = typedResponse?.result?.message_id;
					const delivered = typedResponse?.ok === true && typeof messageId === "number";
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
			let { send } = item.payload;
			const { topicLease, socketLease } = item.payload;
			if (
				(socketLease && !this.#leaseTokenAllows(socketLease)) ||
				(topicLease && !this.topicLeaseIsCurrent(topicLease))
			) {
				this.pool.settle(item.itemId!, "rejected");
				this.failLegacyToolStart(toolActivity);
				continue;
			}
			const topicId = topicLease?.topicId;
			if (topicId && !(await this.pairedChatAllowsTopics())) {
				this.pool.settle(item.itemId!, "rejected");
				this.failLegacyToolStart(toolActivity);
				continue;
			}
			if (
				(socketLease && !this.#leaseTokenAllows(socketLease)) ||
				(topicLease && !this.topicLeaseIsCurrent(topicLease))
			) {
				this.pool.settle(item.itemId!, "rejected");
				this.failLegacyToolStart(toolActivity);
				continue;
			}
			if (item.payload.toolActivity && !this.toolActivityAuthorityIsCurrent(item.payload.toolActivity)) {
				this.pool.settle(item.itemId!, "removed");
				this.failLegacyToolStart(toolActivity);
				continue;
			}
			if (
				toolActivity?.phase === "terminal" &&
				!this.toolActivitySummariesAreCurrent(toolActivity) &&
				toolActivity.summaryFreeSend
			)
				send = toolActivity.summaryFreeSend;
			// Threaded topic when available; otherwise deliver flat to the paired chat.
			const threadField = topicId ? { message_thread_id: Number(topicId) } : {};
			const ckey = send.editable ? item.coalesceKey : undefined;
			const editKey = ckey !== undefined ? `${item.sessionId}:${ckey}` : undefined;
			if (item.lane === "live" && editKey && finalizedKeys.has(editKey)) {
				this.pool.settle(item.itemId!, "removed");
				continue;
			}
			const itemOutcomes: BotApiCallOutcome[] = [];
			const itemBotApi = this.botApiWithOutcomeCollector(itemOutcomes);
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
								{
									chat_id: this.opts.chatId,
									...threadField,
									...(telegramDisableNotification(this.opts.sound, "live") === true
										? { disable_notification: true }
										: {}),
								},
								draftId,
								send.richDraftMarkdown!,
								logger,
							);
						}
					}
				}
				if (
					(socketLease && !this.#leaseTokenAllows(socketLease)) ||
					(topicLease && !this.topicLeaseIsCurrent(topicLease))
				) {
					disposition = "rejected";
					continue;
				}
				const disableNotification = telegramDisableNotification(this.opts.sound, send.lane);
				if (send.method === "sendPhoto" && send.photoBase64) {
					// Real photo upload (the default botApi multiparts base64 -> file).
					await itemBotApi.call("sendPhoto", {
						chat_id: this.opts.chatId,
						...threadField,
						photo: send.photoBase64,
						mime: send.mime,
						caption: send.text,
						parse_mode: TELEGRAM_PARSE_MODE,
						...(disableNotification === true ? { disable_notification: true } : {}),
					});
				} else if (send.method === "sendDocument" && send.documentBase64) {
					await itemBotApi.call("sendDocument", {
						chat_id: this.opts.chatId,
						...threadField,
						document: send.documentBase64,
						mime: send.mime,
						fileName: send.fileName,
						caption: send.text,
						parse_mode: TELEGRAM_PARSE_MODE,
						...(disableNotification === true ? { disable_notification: true } : {}),
					});
				} else if (send.text) {
					// Rich pre-branch: promote stable non-editable finalized text to a fresh
					// sendRichMessage when enabled. Off/miss falls through to the HTML path.
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
							if (
								(socketLease && !this.#leaseTokenAllows(socketLease)) ||
								(topicLease && !this.topicLeaseIsCurrent(topicLease))
							)
								return;
							await itemBotApi.call("sendMessage", {
								chat_id: this.opts.chatId,
								...threadField,
								text: chunks[0]!,
								parse_mode: TELEGRAM_PARSE_MODE,
								...(disableNotification === true ? { disable_notification: true } : {}),
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
										socketLease,
									},
								});
							}
						};
						const richMessageId = await deliverRichWithFallback(
							itemBotApi,
							{
								chat_id: this.opts.chatId,
								...threadField,
								...(disableNotification === true ? { disable_notification: true } : {}),
							},
							send,
							AbortSignal.any([this.#deliveryAbort.signal, AbortSignal.timeout(30_000)]),
							sendHtmlFallback,
							logger,
						);
						// Index the sent rich message so an inbound reply to it can restore
						// the original markdown as context (Telegram does not echo it back).
						if (richMessageId !== undefined && !this.validationMode()) {
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
								if (
									(socketLease && !this.#leaseTokenAllows(socketLease)) ||
									(topicLease && !this.topicLeaseIsCurrent(topicLease))
								)
									return;
								const res = (await itemBotApi.call("editMessageText", {
									chat_id: this.opts.chatId,
									message_id: existingId,
									text: chunks[0],
									parse_mode: TELEGRAM_PARSE_MODE,
								})) as { ok?: boolean; description?: string } | null;
								edited = res?.ok === true || /not modified/i.test(String(res?.description ?? ""));
							} catch {
								edited = false;
							}
							if (edited) {
								firstMessageId = existingId;
							} else if (
								(!socketLease || this.#leaseTokenAllows(socketLease)) &&
								(!topicLease || this.topicLeaseIsCurrent(topicLease))
							) {
								const res = (await itemBotApi.call("sendMessage", {
									chat_id: this.opts.chatId,
									...threadField,
									text: chunks[0]!,
									parse_mode: TELEGRAM_PARSE_MODE,
									...(disableNotification === true ? { disable_notification: true } : {}),
								})) as { result?: { message_id?: number } };
								firstMessageId = res?.result?.message_id;
							}
						} else {
							// No streamed message to edit: a single granted slot maps to a
							// single Telegram send.
							if (
								(socketLease && !this.#leaseTokenAllows(socketLease)) ||
								(topicLease && !this.topicLeaseIsCurrent(topicLease))
							)
								return;
							const res = (await itemBotApi.call("sendMessage", {
								chat_id: this.opts.chatId,
								...threadField,
								text: chunks[0]!,
								parse_mode: TELEGRAM_PARSE_MODE,
								...(disableNotification === true ? { disable_notification: true } : {}),
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
										socketLease,
									},
								});
							}
						}
						if (editKey && ckey !== undefined && firstMessageId !== undefined && !send.terminal) {
							this.recordLiveMessage(item.sessionId, ckey, firstMessageId, item.payload.toolActivity);
						}
					}
				}
			} catch {
				// Best-effort: a failed send/edit must never stop the daemon.
				disposition = "ambiguous";
				if (item.payload.toolActivity?.phase === "started") this.toolActivityAmbiguous = true;
			} finally {
				const retryable = itemOutcomes.some(outcome => outcome.kind === "retryable");
				const accepted = itemOutcomes.some(outcome => outcome.kind === "accepted");
				const rejected = itemOutcomes.some(outcome => outcome.kind === "rejected");
				if (retryable) {
					if (!accepted) {
						let retryItemId: string | undefined;
						let retryAllowed = true;
						if (toolActivity?.phase === "started") {
							retryAllowed =
								!this.toolActivityStopping &&
								!this.stopRequested &&
								this.opts.toolActivity?.enabled === true &&
								toolActivity.policyEpoch === this.toolActivityPolicyEpoch &&
								this.toolActivityAuthorityIsCurrent(toolActivity);
							if (toolActivity.session.toolActivityCapability === "v1") {
								const state = this.legacyToolStarts.get(
									`${toolActivity.sessionId}:tool:${toolActivity.toolCallId}`,
								);
								retryAllowed =
									retryAllowed &&
									state !== undefined &&
									state.owner === toolActivity &&
									!state.terminalClaimed;
								if (state !== undefined && state.owner === toolActivity) {
									if (retryAllowed) {
										state.phase = "queued";
										state.itemId = `legacy-tool-start:${this.nextLegacyToolStartId++}`;
										retryItemId = state.itemId;
									} else {
										this.settleLegacyToolStart(state, "cancelled");
									}
								}
							} else if (retryAllowed) {
								retryItemId = `tool-activity-start:${this.nextLegacyToolStartId++}`;
							}
						} else if (toolActivity?.phase === "terminal" && item.payload.legacyToolStart !== undefined) {
							retryItemId = `legacy-tool-terminal:${this.nextLegacyToolStartId++}`;
						}
						const newerCoalescedItem =
							toolActivity === undefined &&
							item.coalesceKey !== undefined &&
							this.pool.someQueued(
								queued =>
									queued.sessionId === item.sessionId &&
									queued.lane === item.lane &&
									queued.coalesceKey === item.coalesceKey,
							);
						if (retryAllowed && !newerCoalescedItem) {
							this.submitPool({
								sessionId: item.sessionId,
								lane: item.lane,
								coalesceKey: item.coalesceKey,
								deadlineAt: item.deadlineAt,
								...(retryItemId !== undefined ? { itemId: retryItemId } : {}),
								payload: item.payload,
							});
						}
					}
					disposition = "ambiguous";
				} else if (disposition === "accepted" && !accepted && rejected) {
					disposition = "rejected";
				}
				this.pool.settle(item.itemId!, disposition);
				if (toolActivity?.phase === "started" && !retryable) this.failLegacyToolStart(toolActivity);
				if (toolActivity?.phase === "terminal" && !retryable) {
					const state = item.payload.legacyToolStart;
					if (state !== undefined && this.legacyToolStarts.get(state.key) === state)
						this.settleLegacyToolStart(state, "terminal");
				}
				// A terminal tool frame owns the end of this coalescing key even when both
				// edit and fallback delivery fail. Retaining the old message id would leak
				// one entry per failure and let a later reused key edit stale Telegram state.
				if (send.terminal && editKey && !retryable) {
					this.liveMessages.delete(editKey);
					const owner = this.toolActivityOwners.get(editKey);
					if (!item.payload.toolActivity || owner?.session === item.payload.toolActivity.session)
						this.toolActivityOwners.delete(editKey);
				}
			}
		}
	}

	/**
	 * Track the Telegram message id backing a streamed `(sessionId, coalesceKey)`
	 * so later live/finalized frames edit it in place. Evicts this session's stale
	 * same-category entries (e.g. prior turns) so the map stays bounded.
	 */
	private recordLiveMessage(
		sessionId: string,
		coalesceKey: string,
		messageId: number,
		toolActivity?: ToolActivityOwner,
	): void {
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
		if (toolActivity) {
			const legacyStart = this.legacyToolStarts.get(mapKey);
			if (
				legacyStart !== undefined &&
				legacyStart.owner === toolActivity &&
				(toolActivity.session.toolActivityCapability !== "v1" ||
					legacyStart.policyEpoch !== this.toolActivityPolicyEpoch ||
					!this.toolActivityAuthorityIsCurrent(toolActivity))
			) {
				this.settleLegacyToolStart(legacyStart, "terminal");
				void this.enqueueToolTerminalization([{ messageId, owner: toolActivity }], false);
				return;
			}
			const owner = this.toolActivityOwners.get(mapKey);
			if (this.revokedToolEndpoints.has(toolActivity.endpointDigest) || owner?.session !== toolActivity.session) {
				void this.enqueueToolTerminalization([{ messageId, owner: toolActivity }], false);
				return;
			}
		}
		this.liveMessages.set(mapKey, messageId);
		if (toolActivity) this.toolActivityOwners.set(mapKey, toolActivity);
		if (toolActivity) {
			const state = this.legacyToolStarts.get(mapKey);
			if (state !== undefined && state.owner === toolActivity) this.settleLegacyToolStart(state, "visible");
		}
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
	private async deliverFlatFallback(
		sessionId: string,
		send: ThreadedSend,
		toolActivity?: ToolActivityOwner,
		socketLease?: { session: SessionSocket; token: number; logicalSessionId: string },
	): Promise<void> {
		if ((socketLease && !this.#leaseTokenAllows(socketLease)) || !(await this.pairedChatIsPrivate())) return;
		if (toolActivity && !this.toolActivityDeliveryIsCurrent(toolActivity)) return;
		if (socketLease && !this.#leaseTokenAllows(socketLease)) return;
		await this.notifyThreadedFallback(socketLease);
		if (toolActivity && !this.toolActivityDeliveryIsCurrent(toolActivity)) return;
		if (socketLease && !this.#leaseTokenAllows(socketLease)) return;
		if (toolActivity && !this.toolActivityDeliveryIsCurrent(toolActivity)) return;
		if (send.identity && this.flatIdentitySent.has(sessionId)) return;
		if (toolActivity && !this.toolActivityDeliveryIsCurrent(toolActivity)) return;
		const legacyToolStart =
			toolActivity?.phase === "started"
				? this.legacyToolStarts.get(`${toolActivity.sessionId}:tool:${toolActivity.toolCallId}`)
				: toolActivity?.phase === "terminal"
					? this.legacyToolStartForTerminal(toolActivity)
					: undefined;
		if (
			legacyToolStart !== undefined &&
			legacyToolStart.owner === toolActivity &&
			toolActivity?.phase === "started"
		) {
			legacyToolStart.phase = "queued";
			legacyToolStart.itemId ??= `legacy-tool-start:${this.nextLegacyToolStartId++}`;
		}
		const poolItemId =
			legacyToolStart !== undefined && legacyToolStart.owner === toolActivity
				? toolActivity!.phase === "terminal"
					? `legacy-tool-terminal:${this.nextLegacyToolStartId++}`
					: legacyToolStart.itemId
				: undefined;
		const submitted = this.submitPool({
			sessionId,
			lane: send.lane,
			coalesceKey: send.coalesceKey,
			...(poolItemId !== undefined ? { itemId: poolItemId } : {}),
			payload: {
				send,
				...(socketLease ? { socketLease } : {}),
				...(toolActivity ? { toolActivity } : {}),
				...(legacyToolStart !== undefined && toolActivity?.phase === "terminal" ? { legacyToolStart } : {}),
			},
		});
		if (!submitted) {
			this.settleRejectedLegacyToolSubmission(toolActivity, legacyToolStart);
			return;
		}
		await this.flushPool();
		if (socketLease && !this.#leaseTokenAllows(socketLease)) return;
		if (send.identity) this.flatIdentitySent.add(sessionId);
	}

	/**
	 * Resolve and cache the outbound delivery boundary. The validation forum is
	 * explicit and topic-only; all inbound and flat paths remain private-only.
	 */
	private validationMode(): boolean {
		return this.opts.validationTestSupergroupChatId !== undefined;
	}

	private async resolvePairedChatPrivacy(): Promise<PairedChatPrivacy> {
		if (this.pairedChatPrivacy !== undefined) return this.pairedChatPrivacy;
		const chatId = this.opts.validationTestSupergroupChatId ?? this.opts.chatId;
		try {
			const res = (await this.botApi.call("getChat", { chat_id: chatId })) as {
				ok?: unknown;
				result?: { id?: unknown; type?: unknown; is_forum?: unknown };
			};
			if (res === undefined) return "indeterminate";
			if (res?.ok !== true) {
				logger.warn("notifications: getChat privacy check indeterminate (non-success response)");
				return "indeterminate";
			}
			if (
				this.validationMode() &&
				String(res.result?.id) === this.opts.validationTestSupergroupChatId &&
				res.result?.type === "supergroup" &&
				res.result.is_forum === true
			) {
				this.pairedChatPrivacy = "validation-forum";
				return "validation-forum";
			}
			if (!this.validationMode() && res.result?.type === "private") {
				this.pairedChatPrivacy = "private";
				return "private";
			}
			if (res.result?.type === "group" || res.result?.type === "supergroup" || res.result?.type === "channel") {
				this.pairedChatPrivacy = "non-private";
				return "non-private";
			}
			logger.warn("notifications: getChat privacy check indeterminate (missing or invalid chat type)");
			return "indeterminate";
		} catch {
			logger.warn("notifications: getChat privacy check indeterminate (request failed)");
			return "indeterminate";
		}
	}

	private async pairedChatAllowsTopics(): Promise<boolean> {
		const privacy = await this.resolvePairedChatPrivacy();
		return privacy === "private" || privacy === "validation-forum";
	}

	/** Keep all flat delivery and inbound control paths private-only. */
	private async pairedChatIsPrivate(): Promise<boolean> {
		return (await this.resolvePairedChatPrivacy()) === "private";
	}

	/** Tell the user once (per daemon run) how to enable Threaded Mode. */
	private async notifyThreadedFallback(socketLease?: {
		session: SessionSocket;
		token: number;
		logicalSessionId: string;
	}): Promise<void> {
		if (
			this.threadedFallbackNoticeSent ||
			(socketLease && !this.#leaseTokenAllows(socketLease)) ||
			!(await this.pairedChatIsPrivate())
		)
			return;
		if (socketLease && !this.#leaseTokenAllows(socketLease)) return;
		this.threadedFallbackNoticeSent = true;
		try {
			if (socketLease && !this.#leaseTokenAllows(socketLease)) return;
			await this.botApi.call("sendMessage", {
				chat_id: this.opts.chatId,
				text: "Flat Telegram private chat supports outbound notifications and inline ask buttons only. Enable Threaded Mode in @BotFather > Bot Settings > Threads Settings for free-text replies and session commands.",
				parse_mode: TELEGRAM_PARSE_MODE,
				...(telegramDisableNotification(this.opts.sound, "finalized") === true
					? { disable_notification: true }
					: {}),
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
		return renewOwnerHeartbeatSidecar({
			settings: this.opts.settings,
			ownerId: this.opts.ownerId,
			acquisitionId: this.opts.ownerId,
			fs: this.fsImpl,
			now: this.opts.now,
			pid: this.opts.pid ?? process.pid,
			pidIncarnation: this.opts.pidIncarnation,
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
	private async sendTyping(
		sessionId: string,
		capturedLease?: { session: SessionSocket; token: number; logicalSessionId: string },
	): Promise<void> {
		const session = this.logicalSessionOwners.get(sessionId) ?? this.sessions.get(sessionId);
		const socketLease = capturedLease ?? (session ? this.#socketLease(session, sessionId) : undefined);
		if (!socketLease) return;
		const topicLease = await this.topicAuthorityLease(sessionId);
		if (!topicLease || !this.topicLeaseIsCurrent(topicLease) || !this.#leaseTokenAllows(socketLease)) return;
		try {
			if (!this.#leaseTokenAllows(socketLease) || !this.topicLeaseIsCurrent(topicLease)) return;
			await this.botApi.call("sendChatAction", {
				chat_id: this.opts.chatId,
				message_thread_id: Number(topicLease.topicId),
				action: "typing",
			});
		} catch {
			// Best-effort: a failed chat action must never stop the daemon.
		}
	}

	/** Set a native reaction on an inbound thread message (best-effort). */
	private async setReaction(
		messageId: number,
		emoji: string,
		socketLease?: { session: SessionSocket; token: number; logicalSessionId: string },
	): Promise<void> {
		if ((socketLease && !this.#leaseTokenAllows(socketLease)) || !(await this.pairedChatIsPrivate())) return;
		try {
			if (socketLease && !this.#leaseTokenAllows(socketLease)) return;
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
		const logicalSessionId =
			!session.logicalSessionIdTrusted && typeof msg.sessionId === "string" && msg.sessionId.trim()
				? msg.sessionId
				: this.#logicalSessionId(session);
		if (
			msg.type !== "control_command_result" ||
			msg.status !== "ok" ||
			msg.sessionId !== logicalSessionId ||
			!Array.isArray(msg.modelChoices) ||
			this.sessions.get(session.sessionId) !== session
		)
			return false;
		const socketLease = this.#socketLease(session, logicalSessionId);
		if (!socketLease) return false;

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
			(await this.existingTopicForPrivateChat(logicalSessionId)) ??
			(await this.ensureTopic(
				logicalSessionId,
				this.topicNameFor(logicalSessionId, msg),
				session.logicalSessionIdTrusted ? session : undefined,
				socketLease,
			));
		const topicLease = await this.topicAuthorityLease(logicalSessionId);
		if (!topicId || !topicLease || topicLease.topicId !== topicId) return false;
		if (!session.logicalSessionIdTrusted) this.legacyTopicOwners.set(logicalSessionId, session);

		// Each logical session owns only its most recently rendered menu.
		this.#clearModelChoiceAliases(logicalSessionId);
		const aliases = choices.map(choice =>
			this.#putModelChoiceAlias({ session, socketLease, sessionId: logicalSessionId, selector: choice.selector }),
		);
		const inline_keyboard = buildButtonGrid(
			choices.map(choice => choice.label),
			index => aliases[index]!,
		);
		if (!this.#leaseTokenAllows(socketLease) || !this.topicLeaseIsCurrent(topicLease)) return false;
		try {
			const response = await this.botApi.call(
				"sendMessage",
				{
					chat_id: this.opts.chatId,
					message_thread_id: Number(topicId),
					text: rendered.text,
					parse_mode: TELEGRAM_PARSE_MODE,
					reply_markup: { inline_keyboard },
					...(telegramDisableNotification(this.opts.sound, "ask") === true ? { disable_notification: true } : {}),
				},
				{ noRetry: true },
			);
			if (!response || typeof response !== "object" || (response as { ok?: unknown }).ok !== true) {
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
		if (msg?.type === "hello") {
			const capabilities = Array.isArray(msg.capabilities) ? msg.capabilities : [];
			const previousToolActivityCapability = session.toolActivityCapability;
			session.toolActivityCapability = negotiateToolActivityCapability(previousToolActivityCapability, capabilities);
			if (previousToolActivityCapability === "v1" && session.toolActivityCapability === "v2")
				this.cleanLegacyToolStartsForCapabilityUpgrade(session);
			if (capabilities.includes("ephemeral_turn_v1")) {
				session.ephemeralCapable = true;
				this.#resumeBtwTurnsForSession(session);
			}
			if (capabilities.includes(CLIENT_PING_PONG_CAPABILITY)) {
				session.capable = true;
				this.startLiveness(session);
			}
			return;
		}
		if (session.replayPending) {
			if (msg?.type === "tool_activity" && (this.opts.toolActivity?.enabled !== true || this.toolActivityStopping))
				return;
			const matchingReplay = msg?.type === "event_replay_result" && msg.id === session.replayId;
			if (!matchingReplay) {
				const frame = msg as Record<string, unknown>;
				if (frame.type === "tool_activity") this.replayToolActivityEpochs.set(frame, this.toolActivityPolicyEpoch);
				session.replayQueue.push(frame);
				return;
			}
			const replayValid =
				msg.ok === true &&
				Number.isSafeInteger(msg.generation) &&
				msg.generation >= 1 &&
				Number.isSafeInteger(msg.lastSeq) &&
				msg.lastSeq >= 0 &&
				msg.gap === undefined &&
				Array.isArray(msg.events) &&
				msg.events.every((event: unknown) => event !== null && typeof event === "object" && !Array.isArray(event));
			const replayed: Record<string, unknown>[] = replayValid
				? (msg.events as Record<string, unknown>[]).map(event => {
						const payload = event.payload;
						return payload && typeof payload === "object" && !Array.isArray(payload)
							? (payload as Record<string, unknown>)
							: event;
					})
				: [];
			const identityFrames = replayed.filter(frame => frame.type === "identity_header");
			const identities = identityFrames.flatMap(frame =>
				typeof frame.sessionId === "string" && frame.sessionId.trim() ? [frame.sessionId] : [],
			);
			const malformedIdentity = identityFrames.some(
				frame => typeof frame.sessionId !== "string" || !frame.sessionId.trim(),
			);
			const identityConflict = new Set(identities).size > 1;
			if (!replayValid || malformedIdentity || identityConflict) {
				// A replay result is the admission proof. Never clear its barrier or drain
				// queued frames after malformed/conflicting proof; the socket cannot fall
				// back to transport-local config rekeying.
				this.dropSession(session, "invalid_replay");
				return;
			}
			session.hostGeneration = msg.generation;
			session.logicalSessionIdTrusted = true;
			const identityIndex = replayed.findLastIndex(frame => frame.type === "identity_header");
			const latestIdentity = identityIndex < 0 ? undefined : replayed[identityIndex];
			const replayIdentitySessionId = latestIdentity?.sessionId as string | undefined;
			const endpointBinding = this.#endpointBinding(session);
			// Identity-less replay may resume only the exact transport owner. A
			// rekeyed A→B transport remains denied unless replay proves B.
			const endpointAuthority = this.#endpointAuthority(endpointBinding, session);
			const ownsLiveOpenEndpoint = this.#ownsLiveOpenEndpoint(session, endpointBinding);
			const canResumeTransport =
				endpointAuthority.state === "unique" &&
				endpointAuthority.sessionId === session.sessionId &&
				ownsLiveOpenEndpoint &&
				this.topics.matchesEndpoint(session.sessionId, endpointBinding);
			const inactiveSuccessor =
				this.topics.get(session.sessionId)?.authorityState === "inactive" &&
				this.topics.get(session.sessionId)?.endpointDigest !== endpointBinding.endpointDigest;
			const canBootstrapTransport =
				(endpointAuthority.state === "none" || inactiveSuccessor) &&
				ownsLiveOpenEndpoint &&
				(!this.topics.get(session.sessionId) || inactiveSuccessor) &&
				!this.preservedInitiatorTopics.has(session.sessionId);
			const replayCandidateSessionId =
				replayIdentitySessionId ?? (canResumeTransport || canBootstrapTransport ? session.sessionId : undefined);
			if (!replayCandidateSessionId) return;
			const recovered = await this.#recoverTopicBinding(
				session,
				replayCandidateSessionId ?? session.sessionId,
				true,
				true,
				replayIdentitySessionId ? undefined : canBootstrapTransport ? "bootstrap" : "resume",
			);
			if (this.sessions.get(session.sessionId) !== session) return;
			if (!recovered) {
				if (session.hostGeneration === msg.generation && session.recoveryLease?.state !== "pending")
					this.dropSession(session, "recovery_rejected");
				return;
			}
			if (
				!this.#ownsLiveOpenEndpoint(session, endpointBinding) ||
				!this.#leaseAllows(session, this.#logicalSessionId(session))
			) {
				this.dropSession(session, "recovery_rejected");
				return;
			}
			session.replayPending = false;
			// Replay restores durable attachment state only. Live notification effects
			// (turn streams, context updates, lifecycle messages) may already have been
			// delivered before a reconnect and must never be rendered a second time.
			const currentGeneration = identityIndex < 0 ? replayed : replayed.slice(identityIndex);
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
				try {
					await this.handleSessionMessage(session, frame);
				} catch (error) {
					logger.warn(
						`notifications: Telegram replay admission failed: ${sanitizeDiagnostic(String(error), this.opts.botToken)}`,
					);
					this.dropSession(session, "replay_admission_failed");
					return;
				}
			}
			const queued = session.replayQueue.splice(0);
			for (const frame of queued) {
				if (
					frame.type === "tool_activity" &&
					this.replayToolActivityEpochs.get(frame) !== this.toolActivityPolicyEpoch
				)
					continue;
				const fingerprint = JSON.stringify(frame);
				const remaining = replayCounts.get(fingerprint) ?? 0;
				if (remaining > 0) {
					if (remaining === 1) replayCounts.delete(fingerprint);
					else replayCounts.set(fingerprint, remaining - 1);
					continue;
				}
				await this.handleSessionMessage(session, frame);
			}
			this.#terminalizeBtwTurnsForGenerationChange(session);
			this.#resumeBtwTurnsForSession(session);
			const recoveredSessionId = this.#logicalSessionId(session);
			if (
				this.#leaseAllows(session, recoveredSessionId) &&
				this.topics.markReplayCursor(recoveredSessionId, msg.generation, msg.lastSeq)
			)
				await this.persistTopics();
			return;
		}
		if (msg?.type === "event_replay_result") return;
		if (msg && typeof msg === "object") await this.#updateLogicalSessionForThreadedFrame(session, msg);
		if (session.logicalSessionIdTrusted && !this.#leaseAllows(session)) return;
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
				this.topics.sessionForTopic(pending.threadId) !== pending.logicalSessionId
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
			const isAuthoritative = (): boolean =>
				!this.#stoppingBtw &&
				this.#leaseTokenAllows(pending.socketLease) &&
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
				this.topics.sessionForTopic(pending.threadId) === pending.logicalSessionId;
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
			let observerOutcome: BtwTerminalDeliveryOutcome = deliveryOutcome;
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
							isAuthoritative,
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
				const fallback = async (): Promise<BtwTerminalDeliveryOutcome> => {
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
								...(telegramDisableNotification(this.opts.sound, "finalized") === true
									? { disable_notification: true }
									: {}),
							},
						});
						if (outcome === "accepted") {
							acceptedChunks++;
							continue;
						}
						if (outcome === "partial_accepted" || acceptedChunks > 0) return "partial_accepted";
						if (outcome === "stale") return "stale";
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
						...(telegramDisableNotification(this.opts.sound, "finalized") === true
							? { disable_notification: true }
							: {}),
					});
					if (outcome === "accepted") {
						deliveryOutcome = "accepted";
						observerOutcome = "accepted";
					} else if (outcome === "rejected") {
						const fallbackOutcome = await fallback();
						observerOutcome = fallbackOutcome;
						deliveryOutcome = fallbackOutcome === "stale" ? "not_delivered" : fallbackOutcome;
					} else {
						deliveryOutcome = outcome === "uncertain" ? "uncertain" : "not_delivered";
						observerOutcome = outcome === "stale" ? "stale" : deliveryOutcome;
					}
				} else {
					const fallbackOutcome = await fallback();
					observerOutcome = fallbackOutcome;
					deliveryOutcome = fallbackOutcome === "stale" ? "not_delivered" : fallbackOutcome;
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
					observerOutcome = observerOutcome === "stale" ? "stale" : deliveryOutcome;
					if (this.#pendingBtwTurns.get(requestId) !== pending) {
						try {
							const observer = (
								this as unknown as Record<symbol, ((receipt: BtwTerminalDeliveryReceipt) => void) | undefined>
							)[BTW_TERMINAL_DELIVERY_TEST_OBSERVER];
							observer?.({
								requestId,
								logicalSessionId: pending.logicalSessionId,
								transportSessionId: pending.transportSessionId,
								threadId: pending.threadId,
								updateId: pending.updateId,
								messageId: pending.messageId,
								outcome: observerOutcome,
							});
						} catch {
							logger.warn("notifications: /btw terminal delivery observer failed");
						}
					}
				}
			}
			return;
		}
		if (typeof msg?.type === "string" && TelegramNotificationDaemon.THREADED_FRAMES.has(msg.type)) {
			let threadedFrame = msg as Record<string, unknown>;
			let legacyUnknownStart: LegacyToolStartSettlement | undefined;
			if (threadedFrame.type === "tool_activity" && threadedFrame.phase === "unknown") {
				const toolCallId = typeof threadedFrame.toolCallId === "string" ? threadedFrame.toolCallId : undefined;
				const toolName = typeof threadedFrame.toolName === "string" ? threadedFrame.toolName : undefined;
				const liveKey = toolCallId ? `${this.#logicalSessionId(session)}:tool:${toolCallId}` : undefined;
				const state = liveKey ? this.legacyToolStarts.get(liveKey) : undefined;
				if (
					session.toolActivityCapability !== "v1" ||
					!state ||
					state.owner.session !== session ||
					state.owner.toolName !== toolName ||
					state.terminalClaimed
				)
					return;
				state.terminalClaimed = true;
				if (this.cancelUnsentLegacyToolStart(state)) return;
				if (state.phase === "dispatching") await state.settled;
				if (
					state.settledOutcome !== "visible" ||
					this.legacyToolStarts.get(state.key) !== state ||
					session.toolActivityCapability !== "v1" ||
					state.owner.session !== session ||
					state.policyEpoch !== this.toolActivityPolicyEpoch ||
					!this.toolActivityAuthorityIsCurrent(state.owner) ||
					this.toolActivityOwners.get(state.key) !== state.owner ||
					!this.liveMessages.has(state.key)
				)
					return;
				legacyUnknownStart = state;
				threadedFrame = { ...this.toolActivityFrameWithoutSummaries(threadedFrame), phase: "cancelled" };
			}
			const toolActivity = this.toolActivityOwner(session, threadedFrame);
			if (threadedFrame.type === "tool_activity" && !toolActivity) return;
			const toolAdmissionEpoch = toolActivity
				? (this.replayToolActivityEpochs.get(threadedFrame) ?? this.toolActivityPolicyEpoch)
				: undefined;
			if (toolActivity) toolActivity.policyEpoch = toolAdmissionEpoch;
			if (toolActivity?.phase === "started" && toolActivity.session.toolActivityCapability === "v1") {
				const state = this.admitLegacyToolStart(toolActivity);
				if (!state) return;
			}
			if (legacyUnknownStart && toolActivity?.phase === "terminal") {
				if (
					legacyUnknownStart.owner.session !== toolActivity.session ||
					legacyUnknownStart.key !== `${toolActivity.sessionId}:tool:${toolActivity.toolCallId}`
				)
					return;
			}
			const toolFrameIsCurrent = (): boolean => !toolActivity || this.toolActivityDeliveryIsCurrent(toolActivity);
			const abandonStaleToolStart = (): void => {
				if (toolActivity?.phase !== "started") return;
				const key = `${toolActivity.sessionId}:tool:${toolActivity.toolCallId}`;
				const owner = this.toolActivityOwners.get(key);
				if (!this.liveMessages.has(key) && owner?.session === toolActivity.session)
					this.toolActivityOwners.delete(key);
				this.failLegacyToolStart(toolActivity);
			};
			if (toolActivity) {
				const liveKey = `${toolActivity.sessionId}:tool:${toolActivity.toolCallId}`;
				const currentOwner = this.toolActivityOwners.get(liveKey);
				if (toolActivity.phase === "started") {
					if (!toolFrameIsCurrent()) {
						this.failLegacyToolStart(toolActivity);
						return;
					}
					this.toolActivityOwners.set(liveKey, toolActivity);
				} else {
					if (currentOwner && currentOwner.session !== session) return;
					if (this.opts.toolActivity?.enabled !== true) {
						if (!currentOwner) return;
						if (!this.liveMessages.has(liveKey)) {
							// A start may already be granted to the serialized dispatcher but not
							// yet recorded as visible. Wait for that exact dispatch boundary before
							// deciding whether its terminal frame must close a visible message.
							await this.flushChain;
						}
						const settledOwner = this.toolActivityOwners.get(liveKey);
						if (!this.liveMessages.has(liveKey) || settledOwner?.session !== session) {
							if (settledOwner?.session === session) this.toolActivityOwners.delete(liveKey);
							return;
						}
					}
				}
			}
			const summaryFreeToolFrame =
				toolActivity?.phase === "terminal" ? this.toolActivityFrameWithoutSummaries(threadedFrame) : threadedFrame;
			const renderedFrame =
				toolActivity?.phase === "terminal" && !this.toolActivitySummariesAreCurrent(toolActivity)
					? summaryFreeToolFrame
					: threadedFrame;
			const preparedFrame = await prepareTelegramImageAttachment(renderedFrame);
			const send = this.renderThreadedFrame(preparedFrame);
			if (toolActivity?.phase === "terminal") {
				const summaryFreeSend = this.renderThreadedFrame(summaryFreeToolFrame);
				if (summaryFreeSend) toolActivity.summaryFreeSend = summaryFreeSend;
			}
			if (!send) {
				this.failLegacyToolStart(toolActivity);
				return;
			}
			const transportLogicalSessionId = this.#logicalSessionId(session);
			// Preserve legacy identity routing for direct/non-replay session callers.
			// Authenticated transports never infer topic ownership from display identity:
			// a resume must bind only its proven logical session.
			const logicalSessionId =
				send.identity && !session.logicalSessionIdTrusted && this.sessions.get(session.sessionId) !== session
					? (this.topicOwnerForIdentity(msg) ?? transportLogicalSessionId)
					: transportLogicalSessionId;
			if (!this.#leaseAllows(session, logicalSessionId)) {
				this.failLegacyToolStart(toolActivity);
				return;
			}
			const socketLease = this.#socketLease(session, logicalSessionId);
			if (!socketLease) {
				this.failLegacyToolStart(toolActivity);
				return;
			}
			const existingTopic = await this.existingTopicForPrivateChat(logicalSessionId);
			if (!toolFrameIsCurrent()) {
				abandonStaleToolStart();
				return;
			}
			const topicRecord = this.topics.get(logicalSessionId);
			if (topicRecord && (topicRecord.authorityState !== "active" || topicRecord.bindingMalformed)) {
				this.failLegacyToolStart(toolActivity);
				return;
			}
			if (!send.identity && !existingTopic && !this.flatIdentitySent.has(logicalSessionId)) {
				this.rememberPendingThreadedFrame(session, send, threadedFrame, toolActivity);
				return;
			}
			const topicId =
				existingTopic ??
				(await this.ensureTopic(logicalSessionId, this.topicNameFor(logicalSessionId, msg), session));
			const topicLease = await this.topicAuthorityLease(logicalSessionId);
			if (!topicId || !topicLease || topicLease.topicId !== topicId) {
				const topicRecord = this.topics.get(logicalSessionId);
				if (topicRecord && (topicRecord.authorityState !== "active" || topicRecord.bindingMalformed)) {
					this.failLegacyToolStart(toolActivity);
					return;
				}
				if (!toolFrameIsCurrent()) {
					abandonStaleToolStart();
					return;
				}
				await this.deliverFlatFallback(logicalSessionId, send, toolActivity, socketLease);
				return;
			}
			if (send.identity) {
				const identityKey = this.topicIdentityKey(msg);
				if (identityKey) {
					this.topicOwnerByIdentity.set(identityKey, logicalSessionId);
					if (this.topics.markIdentityKey(logicalSessionId, identityKey)) await this.persistTopics();
				}
				await this.reconcileUserTopicName(topicLease);
				const name = this.topicNameFor(logicalSessionId, msg);
				if (this.topics.needsRename(logicalSessionId, name)) {
					try {
						if (!this.#leaseTokenAllows(socketLease) || !this.topicLeaseIsCurrent(topicLease)) return;
						this.daemonRenameAttempts.set(
							logicalSessionId,
							(this.daemonRenameAttempts.get(logicalSessionId) ?? 0) + 1,
						);
						const response = await this.botApi.call("editForumTopic", {
							chat_id: this.opts.chatId,
							message_thread_id: Number(topicId),
							name,
						});
						if (topicRenameApplied(response)) this.topics.markNameApplied(logicalSessionId, name);
					} catch {
						// A later identity frame retries a transient daemon rename failure.
					} finally {
						const attempts = (this.daemonRenameAttempts.get(logicalSessionId) ?? 1) - 1;
						if (attempts > 0) this.daemonRenameAttempts.set(logicalSessionId, attempts);
						else this.daemonRenameAttempts.delete(logicalSessionId);
					}
				}
				if (this.topics.needsIdentity(logicalSessionId)) {
					await this.submitThreadedFrame(logicalSessionId, send, topicLease, undefined, socketLease);
					this.topics.markIdentitySent(logicalSessionId);
				}
				await this.persistTopics();
				await this.flushPendingThreadedFrames(logicalSessionId, topicLease);
				await this.reconcileUserTopicName(topicLease);
				return;
			}
			if (!toolFrameIsCurrent()) {
				abandonStaleToolStart();
				return;
			}
			await this.submitThreadedFrame(logicalSessionId, send, topicLease, toolActivity, socketLease);
			return;
		}
		if (msg.type === "action_needed" && msg.id) {
			const logicalSessionId = this.#logicalSessionId(session);
			const socketLease = this.#socketLease(session, logicalSessionId);
			if (!socketLease) return;
			const pendingAction = msg.kind === "ask" ? { sessionId: logicalSessionId, actionId: msg.id } : undefined;
			if (pendingAction) {
				session.pending.set(msg.id, pendingAction);
				await this.reissuePendingAction(logicalSessionId, msg.id);
			}
			const topicRecord = this.topics.get(logicalSessionId);
			if (topicRecord && (topicRecord.authorityState !== "active" || topicRecord.bindingMalformed)) return;
			const topicId = await this.ensureTopic(logicalSessionId, this.topicNameFor(logicalSessionId, msg), session);
			const topicLease = topicId ? this.topicAuthorityLeaseFromRegistry(logicalSessionId) : undefined;
			if (topicId && (!topicLease || topicLease.topicId !== topicId)) return;
			if (!topicId) {
				// Fail closed for non-private chats; only nudge + flat-deliver in a private DM.
				if (!(await this.pairedChatIsPrivate())) return;
				await this.notifyThreadedFallback(socketLease);
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
			const options: string[] = Array.isArray(msg.options)
				? msg.options.filter((option: unknown): option is string => typeof option === "string")
				: [];
			const multiSelect = Array.isArray(msg.selectedOptionIndices);
			const selectedOptionIndices = new Set(
				multiSelect
					? msg.selectedOptionIndices.filter(
							(index: unknown): index is number =>
								Number.isInteger(index) && Number(index) >= 0 && Number(index) < options.length,
						)
					: [],
			);
			const displayOptions = options.map((option, index) =>
				multiSelect ? `${selectedOptionIndices.has(index) ? "☑" : "☐"} ${option}` : option,
			);
			const rendered = buildActionMessage({
				kind: msg.kind ?? "ask",
				id: msg.id,
				question: msg.question,
				options: displayOptions,
				recommendedIndex: msg.recommendedIndex,
				controls,
				summary: msg.summary,
			});
			const kind = msg.kind === "idle" ? "idle" : "ask";
			const callbackDispatchAuthorityIsCurrent = (): boolean =>
				this.#leaseTokenAllows(socketLease) &&
				(!topicLease || this.topicLeaseIsCurrent(topicLease)) &&
				(kind !== "ask" || (pendingAction !== undefined && session.pending.get(msg.id) === pendingAction));
			const createdAliases: Array<[string, CallbackRoute]> = [];
			const createAlias = (answer: CallbackRoute["answer"]): string => {
				const alias = this.aliasTable.allocate(candidate => this.reissueBacklog.has(candidate));
				createdAliases.push([
					alias,
					{
						sessionId: logicalSessionId,
						actionId: msg.id,
						answer,
					},
				]);
				return alias;
			};
			const inline_keyboard = [
				...buildCompactChoiceGrid(displayOptions, (i: number) => createAlias(i)),
				...controls.map(control => [
					{
						text: control.label,
						callback_data: createAlias({ controlId: control.id }),
					},
				]),
			];
			if (createdAliases.length > 0) {
				for (const [alias, route] of createdAliases) {
					if (!this.aliasTable.activate(alias, route)) throw new Error("callback alias reservation conflicted");
				}
				// Reserve every exposed callback token durably before Telegram can
				// accept a keyboard. A restart loads these non-receipt routes only
				// into the non-routable reissue backlog.
				await this.persistAliases();
			}
			// HTML delivery: one sendMessage per chunk, keyboard on the last chunk;
			// returns the last chunk's authoritative message_id (the reply-routable message).
			let callbackDelivery: "accepted" | "rejected" | "ambiguous" = "rejected";
			const sendHtmlChunks = async (): Promise<number | undefined> => {
				const chunks = splitTelegramHtml(rendered.text);
				let acceptedMessageId: number | undefined;
				for (let i = 0; i < chunks.length; i++) {
					const exposesCallbacks = i === chunks.length - 1 && inline_keyboard.length > 0;
					if (!callbackDispatchAuthorityIsCurrent()) return undefined;
					let result: { ok?: unknown; result?: { message_id?: unknown } } | undefined;
					try {
						result = (await this.botApi.call(
							"sendMessage",
							{
								chat_id: this.opts.chatId,
								...threadField,
								text: chunks[i]!,
								parse_mode: TELEGRAM_PARSE_MODE,
								...(telegramDisableNotification(this.opts.sound, kind, i === chunks.length - 1) === true
									? { disable_notification: true }
									: {}),
								...(exposesCallbacks ? { reply_markup: { inline_keyboard } } : {}),
							},
							{ noRetry: true },
						)) as { ok?: unknown; result?: { message_id?: unknown } } | undefined;
					} catch {
						if (exposesCallbacks) callbackDelivery = "ambiguous";
						return undefined;
					}
					if (result?.ok !== true) {
						if (exposesCallbacks && result?.ok !== false) callbackDelivery = "ambiguous";
						return undefined;
					}
					const candidate = result.result?.message_id;
					if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate <= 0) {
						if (exposesCallbacks) callbackDelivery = "ambiguous";
						return undefined;
					}
					if (exposesCallbacks) callbackDelivery = "accepted";
					acceptedMessageId = candidate;
				}
				return acceptedMessageId;
			};
			let messageId: number | undefined;
			if (this.opts.rich?.enabled !== false) {
				// Rich (default on): promote to sendRichMessage with a top-level
				// reply_markup (probe-confirmed). Any miss falls back to the HTML loop.
				if (callbackDispatchAuthorityIsCurrent()) {
					const outcome = await deliverRichActionWithFallback(
						this.botApi,
						{
							chat_id: this.opts.chatId,
							...threadField,
							...(telegramDisableNotification(this.opts.sound, kind) === true
								? { disable_notification: true }
								: {}),
						},
						{
							markdown: buildActionMarkdown({
								kind,
								question: msg.question,
								options: displayOptions,
								recommendedIndex: msg.recommendedIndex,
								summary: msg.summary,
							}),
							replyMarkup: kind === "ask" && inline_keyboard.length ? { inline_keyboard } : undefined,
						},
						AbortSignal.any([this.#deliveryAbort.signal, AbortSignal.timeout(30_000)]),
						sendHtmlChunks,
						logger,
					);
					messageId = outcome.messageId;
					if (createdAliases.length > 0 && messageId !== undefined) callbackDelivery = "accepted";
					else if (createdAliases.length > 0 && !outcome.usedFallback) callbackDelivery = "ambiguous";
				}
			} else {
				// Rich disabled: deliver through the HTML chunk path.
				messageId = await sendHtmlChunks();
			}
			const pendingActionIsCurrent = pendingAction !== undefined && session.pending.get(msg.id) === pendingAction;
			const mayActivate =
				kind === "ask" &&
				messageId !== undefined &&
				pendingActionIsCurrent &&
				this.#leaseTokenAllows(socketLease) &&
				(!topicLease || this.topicLeaseIsCurrent(topicLease));
			if (mayActivate) {
				for (const [alias, route] of createdAliases) {
					if (
						!this.aliasTable.update(alias, {
							...route,
							chatId: String(this.opts.chatId),
							messageId,
							ownerId: this.opts.ownerId,
							generation: DAEMON_GENERATION,
						})
					)
						throw new Error("callback alias receipt update conflicted");
				}
				this.messageRoutes.set(String(messageId), { sessionId: logicalSessionId, actionId: msg.id });
				const activation = this.#stageCallbackActivation(
					createdAliases.map(([alias]) => alias),
					pendingAction,
					socketLease,
					topicLease,
				);
				try {
					// A receipt is durable before an alias gets a routable socket lease.
					await this.persistAliases();
				} catch {
					for (const [alias] of createdAliases) {
						this.#stagedCallbackActivations.delete(alias);
						this.#revokeCallbackAlias(alias);
					}
					this.deleteMessageRoutes(logicalSessionId, msg.id);
					try {
						await this.persistAliases();
					} catch {
						// The in-memory backlog retains the accepted receipt for shutdown terminalization.
					}
					activation.resolve(false);
					throw new Error("callback alias receipt persistence failed");
				}
				if (
					session.pending.get(msg.id) !== pendingAction ||
					!this.#leaseTokenAllows(socketLease) ||
					(topicLease && !this.topicLeaseIsCurrent(topicLease))
				) {
					for (const [alias] of createdAliases) {
						this.#revokeCallbackAlias(alias);
						this.#stagedCallbackActivations.delete(alias);
					}
					this.deleteMessageRoutes(logicalSessionId, msg.id);
					let revocationPersistenceError: unknown;
					try {
						await this.persistAliases();
					} catch (error) {
						revocationPersistenceError = error;
					} finally {
						activation.resolve(false);
					}
					try {
						await this.botApi.call("editMessageReplyMarkup", {
							chat_id: this.opts.chatId,
							message_id: messageId,
							reply_markup: { inline_keyboard: [] },
						});
					} catch {
						// The accepted receipt remains in memory for shutdown terminalization if persistence failed.
					}
					if (revocationPersistenceError !== undefined)
						throw new Error("callback alias revocation persistence failed", {
							cause: revocationPersistenceError,
						});
					return;
				}
				for (const [alias] of createdAliases) {
					this.#callbackAliasPending.set(alias, pendingAction);
					this.#callbackAliasLeases.set(alias, socketLease);
					if (topicLease) this.#callbackAliasTopics.set(alias, topicLease);
					this.#stagedCallbackActivations.delete(alias);
				}
				activation.resolve(true);
			} else if (kind === "ask" && messageId !== undefined) {
				// The send may have succeeded after authority ended. Persist every
				// receipt as revoked before best-effort remote terminalization.
				for (const [alias, route] of createdAliases) {
					const receipt = {
						...route,
						chatId: String(this.opts.chatId),
						messageId,
						ownerId: this.opts.ownerId,
						generation: DAEMON_GENERATION,
					};
					if (this.aliasTable.update(alias, receipt)) {
						this.#revokeCallbackAlias(alias);
						continue;
					}
					const revoked = this.reissueBacklog.get(alias);
					if (
						revoked &&
						(revoked.sessionId !== route.sessionId ||
							revoked.actionId !== route.actionId ||
							revoked.answer !== route.answer)
					)
						throw new Error("callback alias revocation update conflicted");
					this.reissueBacklog.set(alias, receipt);
				}
				await this.persistAliases();
				try {
					const terminalized = (await this.botApi.call("editMessageReplyMarkup", {
						chat_id: this.opts.chatId,
						message_id: messageId,
						reply_markup: { inline_keyboard: [] },
					})) as { ok?: unknown } | undefined;
					if (terminalized?.ok === true) for (const [alias] of createdAliases) this.reissueBacklog.delete(alias);
				} catch {
					// The accepted receipt remains durably terminalizable even if its keyboard cannot be removed.
				}
			} else if (kind === "ask" && callbackDelivery === "ambiguous") {
				for (const [alias] of createdAliases) this.#revokeCallbackAlias(alias);
			} else if (kind === "ask") {
				for (const [alias] of createdAliases) this.aliasTable.delete(alias);
			}
			await this.persistAliases();
		} else if (msg.type === "action_resolved" && msg.id) {
			session.pending.delete(msg.id);
			this.deleteMessageRoutes(this.#logicalSessionId(session), msg.id);
			for (const [alias, route] of this.aliasTable.entries()) {
				if (route.sessionId === this.#logicalSessionId(session) && route.actionId === msg.id)
					this.#revokeCallbackAlias(alias);
			}
			await this.reissuePendingAction(this.#logicalSessionId(session), msg.id);
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
			session.ws.readyState !== WebSocket.OPEN ||
			!this.#leaseTokenAllows(route.socketLease) ||
			(this.topics.get(route.sessionId) !== undefined && !this.topicAuthorityLeaseFromRegistry(route.sessionId))
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
		if (
			!this.#leaseTokenAllows(route.socketLease) ||
			(this.topics.get(route.sessionId) !== undefined && !this.topicAuthorityLeaseFromRegistry(route.sessionId))
		) {
			await this.#sendModelStaleGuidance(callbackId);
			return true;
		}
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
				...(telegramDisableNotification(this.opts.sound, "finalized") === true
					? { disable_notification: true }
					: {}),
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
			...(telegramDisableNotification(this.opts.sound, "finalized") === true ? { disable_notification: true } : {}),
		});
	}
	/**
	 * Consume a user-created forum topic (`forum_topic_created` service message)
	 * before edited/text routing. Authenticates the chat, user, privacy, and
	 * lifecycle state; offers home, recent folders, or explicit path entry. The
	 * selected path (or an exact `/session_create path <dir>`) creates a session
	 * that adopts this topic — never a duplicate topic. Non-routable durable
	 * intents prevent duplicate creation across concurrent first frames.
	 */
	private async handleForumTopicCreatedUpdate(update: unknown): Promise<"not-topic" | TelegramUpdateOutcome> {
		const parsed = update as {
			update_id?: unknown;
			message?: {
				chat?: { id?: unknown };
				from?: { id?: unknown; is_bot?: unknown };
				message_thread_id?: unknown;
				forum_topic_created?: { name?: unknown };
			};
		};
		const message = parsed.message;
		if (!message?.forum_topic_created) return "not-topic";
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
		if (typeof threadId !== "number" || !Number.isSafeInteger(threadId) || threadId <= 0) return "consumed";
		if (!this.lifecycleControlActive) return "consumed";
		// A non-expired intent for this topic means a session is already starting;
		// do not mint a new intendedSessionId or render a second picker.
		if (this.#adoptionIntents.hasNonExpiredTopic(threadId)) {
			try {
				await this.botApi.call("sendMessage", {
					chat_id: this.opts.chatId,
					message_thread_id: threadId,
					text: "A session is already starting in this topic.",
				});
			} catch {
				// Best-effort notice; never block on the side message.
			}
			await this.rememberSeenUpdateId(updateId);
			return "consumed";
		}
		// The topic may already be bound to an active session (late duplicate of a
		// created update whose adoption already committed). Do not re-offer.
		if (this.topics.sessionForTopic(String(threadId))) {
			await this.rememberSeenUpdateId(updateId);
			return "consumed";
		}
		let pendingTopic = this.#adoptionIntents.pendingTopic(threadId);
		if (!pendingTopic) {
			const now = this.runtime.now();
			pendingTopic = {
				topicId: threadId,
				chatId: String(this.opts.chatId),
				createdAt: now,
				expiresAt: now + this.#adoptionIntentTtlMs,
			};
			try {
				await this.#adoptionIntents.putPendingTopic(pendingTopic);
			} catch (error) {
				logger.warn(
					`notifications: failed to persist pending user topic: ${sanitizeDiagnostic(String(error), this.opts.botToken)}`,
				);
				return "retry";
			}
		}
		if (!(await this.#renderAdoptionPicker(threadId))) return "retry";
		await this.rememberSeenUpdateId(updateId);
		return "consumed";
	}

	/** Render the top-level folder source choices for a user-created topic. */
	async #renderAdoptionPicker(threadId: number): Promise<boolean> {
		const intendedSessionId = `s${crypto.randomBytes(6).toString("hex")}`;
		const chatId = String(this.opts.chatId);
		const choices: Array<{ label: string; action: TopicPickerAction }> = [
			{ label: "1. Home (~)", action: { kind: "select", target: { kind: "existing_path", path: os.homedir() } } },
			{ label: "2. Recent work folders", action: { kind: "recent" } },
			{ label: "3. Enter a path", action: { kind: "direct" } },
		];
		const aliases = choices.map(choice => ({
			...choice,
			alias: this.#putAdoptionPickerAlias({
				topicId: threadId,
				intendedSessionId,
				chatId,
				action: choice.action,
			}),
		}));
		try {
			const response = await this.botApi.call(
				"sendMessage",
				{
					chat_id: this.opts.chatId,
					message_thread_id: threadId,
					text: "Choose where to start the GJC session:",
					reply_markup: {
						inline_keyboard: aliases.map(choice => [{ text: choice.label, callback_data: choice.alias }]),
					},
				},
				{ noRetry: true },
			);
			if (!response || typeof response !== "object" || (response as { ok?: unknown }).ok !== true) {
				for (const choice of aliases) this.#adoptionPickerAliases.delete(choice.alias);
				return false;
			}
			return true;
		} catch {
			for (const choice of aliases) this.#adoptionPickerAliases.delete(choice.alias);
			logger.warn("notifications: failed to send topic-adoption picker keyboard");
			return false;
		}
	}

	/** Render verified recent work folders as one-shot picker buttons. */
	async #renderRecentFolderChoices(threadId: number, intendedSessionId: string): Promise<boolean> {
		let recent: ListRecentSessionsResult;
		try {
			recent = await listRecentSessions({
				cwd: process.cwd(),
				agentDir: this.opts.settings.getAgentDir(),
				limit: 8,
				includeInternal: false,
				allWorkspaces: true,
			});
		} catch (error) {
			logger.warn(
				`notifications: failed to list recent folders for topic adoption: ${sanitizeDiagnostic(String(error))}`,
			);
			return false;
		}
		const entries = recent.kind === "complete" ? recent.entries.filter(entry => entry.path) : [];
		const chatId = String(this.opts.chatId);
		if (entries.length === 0) {
			const text =
				recent.kind === "error"
					? `Recent work folders could not be verified: ${recent.message}. Choose “Enter a path” from a new topic or use /session_create path <dir>.`
					: "No recent verified work folders were found. Choose “Enter a path” from a new topic or use /session_create path <dir>.";
			try {
				const response = await this.botApi.call("sendMessage", {
					chat_id: this.opts.chatId,
					message_thread_id: threadId,
					text,
				});
				return Boolean(response && typeof response === "object" && (response as { ok?: unknown }).ok === true);
			} catch {
				return false;
			}
		}
		const aliases = entries.map(entry => {
			const target = { kind: "existing_path" as const, path: entry.path! };
			const alias = this.#putAdoptionPickerAlias({
				topicId: threadId,
				intendedSessionId,
				chatId,
				action: { kind: "select", target },
			});
			return { alias, label: this.#pickerLabel(entry) };
		});
		const inline_keyboard = buildButtonGrid(
			aliases.map(a => a.label),
			index => aliases[index]!.alias,
		);
		try {
			const response = await this.botApi.call(
				"sendMessage",
				{
					chat_id: this.opts.chatId,
					message_thread_id: threadId,
					text: "Pick a recent work folder to start a session here:",
					reply_markup: { inline_keyboard },
				},
				{ noRetry: true },
			);
			if (!response || typeof response !== "object" || (response as { ok?: unknown }).ok !== true) {
				for (const a of aliases) this.#adoptionPickerAliases.delete(a.alias);
				return false;
			}
			return true;
		} catch {
			for (const a of aliases) this.#adoptionPickerAliases.delete(a.alias);
			logger.warn("notifications: failed to send recent-folder picker keyboard");
			return false;
		}
	}

	#pickerLabel(entry: { sessionId: string; path?: string; branch?: string; title?: string }): string {
		const base = path.basename(entry.path ?? entry.sessionId);
		const raw = entry.branch ? `${base} (${entry.branch})` : base;
		return safeModelButtonLabel(raw) ?? "workspace";
	}

	#sweepExpiredAdoptionPickerAliases(): void {
		const now = this.runtime.now();
		for (const [alias, route] of this.#adoptionPickerAliases) {
			if (route.expiresAt <= now) this.#adoptionPickerAliases.delete(alias);
		}
		for (const [topicId, pending] of this.#pendingAdoptionPathInputs) {
			if (pending.expiresAt <= now) this.#pendingAdoptionPathInputs.delete(topicId);
		}
	}

	#putAdoptionPickerAlias(route: Omit<TopicPickerRoute, "expiresAt">): string {
		this.#sweepExpiredAdoptionPickerAliases();
		let alias: string;
		do {
			alias = `${PICKER_CALLBACK_PREFIX}${crypto.randomBytes(16).toString("base64url")}`;
		} while (this.#adoptionPickerAliases.has(alias));
		this.#adoptionPickerAliases.set(alias, { ...route, expiresAt: this.runtime.now() + this.#adoptionIntentTtlMs });
		return alias;
	}
	#deleteAdoptionPickerAliasesForTopic(topicId: number): void {
		for (const [alias, route] of this.#adoptionPickerAliases) {
			if (route.topicId === topicId) this.#adoptionPickerAliases.delete(alias);
		}
	}

	/** Handle a one-shot picker button tap. Re-validates chat/topic/expiry/target before submit. */
	async #handleAdoptionPickerCallback(update: unknown, callbackId: unknown): Promise<boolean> {
		const parsed = update as {
			update_id?: unknown;
			callback_query?: {
				data?: unknown;
				from?: { id?: unknown; is_bot?: unknown };
				message?: { chat?: { id?: unknown }; message_id?: unknown; message_thread_id?: unknown };
			};
		};
		const callback = parsed.callback_query;
		const alias = callback?.data;
		if (typeof alias !== "string" || !alias.startsWith(PICKER_CALLBACK_PREFIX)) return false;
		this.#sweepExpiredAdoptionPickerAliases();
		const route = this.#adoptionPickerAliases.get(alias);
		if (!route) {
			await this.answerCallbackQueryBestEffort(callbackId, "Button is stale");
			return true;
		}
		const configuredUserId = Number(this.opts.chatId);
		const updateId = parsed.update_id;
		if (
			!Number.isSafeInteger(configuredUserId) ||
			String(callback?.message?.chat?.id) !== route.chatId ||
			route.chatId !== String(this.opts.chatId) ||
			callback?.from?.id !== configuredUserId ||
			callback?.from?.is_bot !== false ||
			callback?.message?.message_thread_id !== route.topicId ||
			typeof updateId !== "number" ||
			!Number.isSafeInteger(updateId) ||
			updateId < 0 ||
			!this.lifecycleControlActive
		) {
			await this.answerCallbackQueryBestEffort(callbackId, "Not authorized");
			return true;
		}
		if (route.expiresAt <= this.runtime.now()) {
			this.#deleteAdoptionPickerAliasesForTopic(route.topicId);
			await this.answerCallbackQueryBestEffort(callbackId, "Button is stale");
			return true;
		}
		if (!this.#adoptionIntents.hasPendingTopic(route.topicId, route.chatId)) {
			this.#deleteAdoptionPickerAliasesForTopic(route.topicId);
			await this.answerCallbackQueryBestEffort(callbackId, "Button is stale");
			return true;
		}
		if (
			this.dispatchState.seenUpdateIds.has(updateId) ||
			this.#adoptionIntents.hasNonExpiredTopic(route.topicId) ||
			this.#adoptionStartingTopics.has(route.topicId)
		) {
			this.#deleteAdoptionPickerAliasesForTopic(route.topicId);
			await this.answerCallbackQueryBestEffort(callbackId, "A session is already starting in this topic.");
			return true;
		}
		if (route.action.kind === "select") {
			const valid = validateLifecycleTarget("session_create", route.action.target);
			if (!valid.ok) {
				this.#deleteAdoptionPickerAliasesForTopic(route.topicId);
				await this.answerCallbackQueryBestEffort(callbackId, "That folder is no longer valid.");
				return true;
			}
		}
		// Consume the whole picker synchronously before the first successful-path await.
		this.#deleteAdoptionPickerAliasesForTopic(route.topicId);
		if (!(await this.pairedChatIsPrivate())) {
			await this.answerCallbackQueryBestEffort(callbackId, "Not authorized");
			return true;
		}
		await this.rememberSeenUpdateId(updateId);
		await this.answerCallbackQueryBestEffort(callbackId);
		if (route.action.kind === "recent") {
			if (!(await this.#renderRecentFolderChoices(route.topicId, route.intendedSessionId))) {
				await this.botApi
					.call("sendMessage", {
						chat_id: this.opts.chatId,
						message_thread_id: route.topicId,
						text: "Recent work folders could not be loaded. Open a new topic and try again, or use /session_create path <dir>.",
					})
					.catch(() => undefined);
			}
			return true;
		}
		if (route.action.kind === "direct") {
			this.#pendingAdoptionPathInputs.set(route.topicId, {
				chatId: route.chatId,
				intendedSessionId: route.intendedSessionId,
				expiresAt: route.expiresAt,
			});
			await this.botApi
				.call("sendMessage", {
					chat_id: this.opts.chatId,
					message_thread_id: route.topicId,
					text: "Send the folder path in your next message. Examples: ~ or ~/projects/my-app",
				})
				.catch(() => undefined);
			return true;
		}
		await this.#submitAdoptionFrame(
			route.topicId,
			route.action.target,
			route.chatId,
			updateId,
			route.intendedSessionId,
		);
		return true;
	}

	/** Handle the next text message after the user explicitly chooses direct path entry. */
	async #handleAdoptionPathInput(update: unknown): Promise<boolean> {
		const parsed = update as { update_id?: unknown; message?: Record<string, unknown> };
		const message = parsed.message;
		const threadId = message?.message_thread_id;
		if (typeof threadId !== "number" || !Number.isSafeInteger(threadId) || threadId <= 0) return false;
		this.#sweepExpiredAdoptionPickerAliases();
		const pending = this.#pendingAdoptionPathInputs.get(threadId);
		if (!pending) return false;

		const text = typeof message?.text === "string" ? message.text.trim() : undefined;
		const chat = message?.chat as { id?: unknown; type?: unknown } | undefined;
		const from = message?.from as { id?: unknown; is_bot?: unknown } | undefined;
		const updateId = parsed.update_id;
		const commandCtx = {
			chatType: typeof chat?.type === "string" ? chat.type : undefined,
			botUsername: this.botUsername,
		};
		if (isLifecycleCommandText(text, commandCtx)) return false;
		const configuredUserId = Number(this.opts.chatId);
		if (
			!Number.isSafeInteger(configuredUserId) ||
			String(chat?.id) !== pending.chatId ||
			pending.chatId !== String(this.opts.chatId) ||
			from?.id !== configuredUserId ||
			from?.is_bot !== false ||
			typeof updateId !== "number" ||
			!Number.isSafeInteger(updateId) ||
			updateId < 0
		)
			return true;
		if (!this.lifecycleControlActive || this.dispatchState.seenUpdateIds.has(updateId)) return true;
		if (!(await this.pairedChatIsPrivate())) return true;
		if (
			!this.#adoptionIntents.hasPendingTopic(threadId, pending.chatId) ||
			this.#adoptionIntents.hasNonExpiredTopic(threadId) ||
			this.#adoptionStartingTopics.has(threadId)
		) {
			this.#pendingAdoptionPathInputs.delete(threadId);
			return true;
		}

		const normalized = text ? normalizeLifecyclePath(text) : undefined;
		const target = normalized ? ({ kind: "existing_path", path: normalized } as const) : undefined;
		if (!target || !validateLifecycleTarget("session_create", target).ok) {
			await this.rememberSeenUpdateId(updateId);
			await this.botApi
				.call("sendMessage", {
					chat_id: this.opts.chatId,
					message_thread_id: threadId,
					text: "That path is invalid. Send a folder path such as ~ or ~/projects/my-app.",
				})
				.catch(() => undefined);
			return true;
		}

		this.#pendingAdoptionPathInputs.delete(threadId);
		await this.rememberSeenUpdateId(updateId);
		await this.#submitAdoptionFrame(threadId, target, pending.chatId, updateId, pending.intendedSessionId);
		return true;
	}
	/**
	 * Handle an exact `/session_create path <dir>` typed inside a pending
	 * (user-created, not-yet-adopted) topic without requiring the direct-entry choice.
	 */
	async #handleAdoptionDirectPath(update: unknown): Promise<boolean> {
		const parsedUpdate = update as { update_id?: unknown; message?: Record<string, unknown> };
		const message = parsedUpdate.message;
		const text = typeof message?.text === "string" ? message.text : undefined;
		const chat = message?.chat as { id?: unknown; type?: unknown } | undefined;
		const from = message?.from as { id?: unknown; is_bot?: unknown } | undefined;
		const commandCtx = {
			chatType: typeof chat?.type === "string" ? chat.type : undefined,
			botUsername: this.botUsername,
		};
		if (!isLifecycleCommandText(text, commandCtx)) return false;
		const parsed = parseLifecycleCommand(text, commandCtx);
		if (parsed.kind !== "create") return false;
		const configuredUserId = Number(this.opts.chatId);
		const threadId = message?.message_thread_id;
		const updateId = parsedUpdate.update_id;
		if (typeof threadId !== "number" || !Number.isSafeInteger(threadId) || threadId <= 0) return false;
		if (
			!Number.isSafeInteger(configuredUserId) ||
			String(chat?.id) !== String(this.opts.chatId) ||
			from?.id !== configuredUserId ||
			from?.is_bot !== false ||
			typeof updateId !== "number" ||
			!Number.isSafeInteger(updateId) ||
			updateId < 0
		)
			return true;
		if (!this.lifecycleControlActive) return false;
		if (this.dispatchState.seenUpdateIds.has(updateId)) return true;
		if (!(await this.pairedChatIsPrivate())) return true;
		if (this.topics.sessionForTopic(String(threadId))) return false;
		if (!this.#adoptionIntents.hasPendingTopic(threadId, String(this.opts.chatId))) {
			await this.rememberSeenUpdateId(updateId);
			await this.botApi
				.call("sendMessage", {
					chat_id: this.opts.chatId,
					message_thread_id: threadId,
					text: "This topic was not opened for a new GJC session, or its folder picker expired. Open a new topic and try again.",
				})
				.catch(error => {
					logger.warn(
						`notifications: failed to report stale topic adoption: ${sanitizeDiagnostic(String(error), this.opts.botToken)}`,
					);
				});
			return true;
		}
		if (parsed.target.kind !== "existing_path") {
			await this.rememberSeenUpdateId(updateId);
			await this.botApi
				.call("sendMessage", {
					chat_id: this.opts.chatId,
					message_thread_id: threadId,
					text: "This topic can start a session only with /session_create path <dir>.",
				})
				.catch(error => {
					logger.warn(
						`notifications: failed to report unsupported topic-adoption target: ${sanitizeDiagnostic(String(error), this.opts.botToken)}`,
					);
				});
			return true;
		}
		const valid = validateLifecycleTarget("session_create", parsed.target);
		if (!valid.ok) return false;
		await this.rememberSeenUpdateId(updateId);
		await this.#submitAdoptionFrame(threadId, parsed.target, String(this.opts.chatId), updateId);
		return true;
	}

	/**
	 * Build an authenticated lifecycle frame, durably persist the adoption intent
	 * BEFORE submit, then submit. Definite no-spawn failures remove the intent;
	 * readiness_timeout / terminal_uncertain retain it because a late spawn may
	 * still adopt the original topic. Never deletes the user topic.
	 */
	async #submitAdoptionFrame(
		topicId: number,
		target: TelegramAdoptionTarget,
		chatId: string,
		updateId: number,
		preallocatedSessionId?: string,
	): Promise<void> {
		if (this.#adoptionStartingTopics.has(topicId) || this.#adoptionIntents.hasNonExpiredTopic(topicId)) {
			await this.botApi
				.call("sendMessage", {
					chat_id: this.opts.chatId,
					message_thread_id: topicId,
					text: "A session is already starting in this topic.",
				})
				.catch(() => undefined);
			return;
		}
		this.#adoptionStartingTopics.add(topicId);
		try {
			const frame = this.buildLifecycleFrame({ kind: "create", target }, updateId, preallocatedSessionId);
			if (frame.type !== "session_create") throw new Error("topic adoption requires a create frame");
			const intendedSessionId = frame.intendedSessionId;
			const intent = buildAdoptionIntent({
				intendedSessionId,
				topicId,
				chatId,
				target,
				now: this.runtime.now(),
				ttlMs: this.#adoptionIntentTtlMs,
			});
			try {
				await this.#adoptionIntents.put(intent);
			} catch (error) {
				logger.warn(`notifications: failed to persist topic-adoption intent: ${sanitizeDiagnostic(String(error))}`);
				try {
					await this.botApi.call("sendMessage", {
						chat_id: this.opts.chatId,
						message_thread_id: topicId,
						text: "Could not start a session because its durable topic binding could not be saved.",
					});
				} catch (noticeError) {
					logger.warn(
						`notifications: failed to report topic-adoption persistence failure: ${sanitizeDiagnostic(String(noticeError))}`,
					);
				}
				return;
			}
			const normalizedPath = target.kind === "existing_path" ? normalizeLifecyclePath(target.path) : undefined;
			let targetExists = false;
			if (normalizedPath) {
				try {
					const stat = await this.fsImpl.stat?.(normalizedPath);
					targetExists = stat?.isDirectory?.() === true;
				} catch {
					targetExists = false;
				}
			}
			if (!targetExists || !validateLifecycleTarget("session_create", target).ok) {
				await this.#adoptionIntents.remove(intendedSessionId);
				await this.botApi
					.call("sendMessage", {
						chat_id: this.opts.chatId,
						message_thread_id: topicId,
						text: "That folder is no longer available.",
					})
					.catch(() => undefined);
				return;
			}
			const response = await this.submitLifecycleFrame(frame);
			await this.botApi
				.call("sendMessage", {
					chat_id: this.opts.chatId,
					message_thread_id: topicId,
					text: this.formatLifecycleResponse(response, "session_create"),
				})
				.catch(error => {
					logger.warn(
						`notifications: failed to report topic-adoption lifecycle result: ${sanitizeDiagnostic(String(error), this.opts.botToken)}`,
					);
				});
			if (response.status === "ok") return;
			if (response.type === "session_lifecycle_error" && response.reason === "spawn_failed") {
				try {
					await this.#adoptionIntents.remove(intendedSessionId);
				} catch (error) {
					logger.warn(
						`notifications: failed to remove rejected topic-adoption intent: ${sanitizeDiagnostic(String(error))}`,
					);
				}
			}
			// readiness_timeout / terminal_uncertain: spawn may still be in flight; retain intent.
		} finally {
			this.#adoptionStartingTopics.delete(topicId);
		}
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
		if (this.validationMode()) return "consumed";
		const createdOutcome = await this.handleForumTopicCreatedUpdate(update);
		if (createdOutcome !== "not-topic") return createdOutcome;
		const topicOutcome = await this.handleForumTopicEdited(update);
		if (topicOutcome !== "not-topic") return topicOutcome;
		try {
			await this.handleTelegramUpdate(update);
		} catch (err) {
			logger.error("notifications daemon: handleTelegramUpdate failed", { error: String(err) });
			return "retry";
		}
		return "consumed";
	}

	async handleTelegramUpdate(update: unknown): Promise<void> {
		if (this.validationMode()) return;
		if ((await this.handleForumTopicCreatedUpdate(update)) !== "not-topic") return;
		if ((await this.handleForumTopicEdited(update)) !== "not-topic") return;
		// A raw path is accepted only after the explicit direct-entry choice. The exact
		// `/session_create path <dir>` form remains available in any pending topic.
		// Both must precede the general lifecycle handler, which would otherwise create
		// a separate daemon-owned topic.
		if (await this.#handleAdoptionPathInput(update)) return;
		if (await this.#handleAdoptionDirectPath(update)) return;
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
		// Telegram delivery toggles are daemon-local policy, NOT session config
		// forwards. Handle them before threaded injection and independently of any
		// session WebSocket, so they work even when no session is connected.
		{
			const m = (update as { update_id?: number; message?: Record<string, unknown> }).message;
			const chat = m?.chat as { id?: unknown } | undefined;
			const cmdText = typeof m?.text === "string" ? m.text : undefined;
			const commandToken = cmdText?.trim().split(/\s+/)[0]?.toLowerCase();
			const [command, commandSuffix] = commandToken?.split("@", 2) ?? [];
			const isRichCommand = command === "/rich";
			const isToolActivityCommand = command === "/toolactivity";
			if (
				isToolActivityCommand &&
				commandSuffix &&
				(!this.botUsername || commandSuffix !== this.botUsername.toLowerCase())
			)
				return;
			if (
				m !== undefined &&
				String(chat?.id) === String(this.opts.chatId) &&
				(isRichCommand || isToolActivityCommand)
			) {
				// These commands mutate global config, so honor them ONLY in the
				// configured private chat. Fail closed for legacy or hand-edited group IDs.
				if (!(await this.pairedChatIsPrivate())) return;
				const updateId = (update as { update_id?: number }).update_id;
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
							...(telegramDisableNotification(this.opts.sound, "finalized") === true
								? { disable_notification: true }
								: {}),
						});
					} catch {
						// Best-effort confirmation; never block on the notice.
					}
				};
				const desired = isRichCommand
					? parseRichToggleCommand(cmdText ?? "")
					: parseToolActivityToggleCommand(cmdText ?? "", this.botUsername);
				const usage = isRichCommand ? "Usage: /rich on|off" : "Usage: /toolactivity on|off";
				if (desired === undefined) {
					await reply(usage);
					return;
				}
				const settingPath = isRichCommand
					? "notifications.telegram.rich.enabled"
					: "notifications.telegram.toolActivity.enabled";
				const label = isRichCommand ? "Rich messages" : "Tool activity";
				const toolActivityChanged = isRichCommand || this.opts.toolActivity?.enabled !== desired;
				try {
					await this.opts.settings.set(settingPath, desired);
					// Confirm only after the global config write is durable.
					await flushTelegramToggleSettings(this.opts.settings);
				} catch (err) {
					logger.warn(
						`notifications: ${command} settings write failed (${err instanceof Error ? err.message : String(err)}); runtime unchanged`,
					);
					await reply(`${label}: unchanged (settings write failed)`);
					return;
				}
				if (isRichCommand) {
					this.opts.rich = { enabled: desired };
				} else if (toolActivityChanged) {
					this.toolActivityPolicyEpoch++;
					this.opts.toolActivity = { enabled: desired };
					const legacySettlements = this.cancelLegacyToolStartsForPolicyTransition();
					if (!desired) {
						// Unsent legacy starts are cancelled by exact item/frame identity; a
						// dispatch already inside Bot API is joined through its own settlement.
						await legacySettlements;
						await this.flushChain;
						const removedTools = this.pool.removeWhere(item => {
							const toolActivity = item.payload.toolActivity;
							if (!toolActivity) return false;
							if (toolActivity.phase === "started") return true;
							// Keep a terminal only when its exact start is already visible. A
							// queued or pending start is cancelled above and cannot retain a
							// terminal merely because its owner record has not been swept yet.
							const key = `${toolActivity.sessionId}:tool:${toolActivity.toolCallId}`;
							const owner = this.toolActivityOwners.get(key);
							return !this.liveMessages.has(key) || owner?.session !== toolActivity.session;
						});
						for (const item of removedTools) {
							const toolActivity = item.payload.toolActivity;
							if (!toolActivity) continue;
							const key = `${toolActivity.sessionId}:tool:${toolActivity.toolCallId}`;
							const owner = this.toolActivityOwners.get(key);
							if (!this.liveMessages.has(key) && owner?.session === toolActivity.session)
								this.toolActivityOwners.delete(key);
						}
						for (const [sessionId, frames] of this.pendingThreadedFrames) {
							for (const frame of frames) {
								const toolActivity = frame.toolActivity;
								if (!toolActivity || frame.msg.type !== "tool_activity") continue;
								const key = `${toolActivity.sessionId}:tool:${toolActivity.toolCallId}`;
								const owner = this.toolActivityOwners.get(key);
								if (!this.liveMessages.has(key) && owner?.session === toolActivity.session)
									this.toolActivityOwners.delete(key);
							}
							const retained = frames.filter(frame => frame.msg.type !== "tool_activity");
							if (retained.length === 0) this.pendingThreadedFrames.delete(sessionId);
							else this.pendingThreadedFrames.set(sessionId, retained);
						}
						for (const session of this.sessions.values()) {
							session.replayQueue = session.replayQueue.filter(frame => frame.type !== "tool_activity");
						}
					}
					// The policy flips before joining the serialized dispatch chain:
					// future starts are rejected immediately, queued starts are removed,
					// and any already-granted Bot API effect settles before the off
					// acknowledgement. Visible starts may still receive their terminal edit.
				}
				await reply(`${label}: ${desired ? "on" : "off"}`);
				return;
			}
		}
		// Threaded injection: a free-text message in a known topic (not a button
		// tap and not a reply to a specific ask message) injects a user turn or an
		// in-thread config command. Fail-closed: paired chat + known topic +
		// update_id dedupe are all enforced by decideThreadedInbound.
		const raw = update as {
			callback_query?: unknown;
			message?: {
				text?: unknown;
				reply_to_message?: { message_id?: unknown };
				photo?: unknown;
				document?: unknown;
				video?: unknown;
				audio?: unknown;
				chat?: { id?: unknown };
				message_thread_id?: unknown;
				message_id?: unknown;
			};
		};
		// A reply to a known ask message routes to that ask (below). Any OTHER
		// message in a topic (plain text, or a reply to a non-ask message) is a
		// free-text injection. Previously replies bypassed injection entirely.
		const replyTo = raw.message?.reply_to_message?.message_id;
		const reservedBtw =
			typeof raw.message?.text === "string" ? parseBtwCommand(raw.message.text, this.botUsername) : undefined;
		const isAskReply =
			replyTo !== undefined && (this.messageRoutes.has(String(replyTo)) || this.messageRoutes.has(Number(replyTo)));
		if (
			reservedBtw?.kind === "question" &&
			(raw.message?.photo || raw.message?.document || raw.message?.video || raw.message?.audio) &&
			typeof raw.message?.message_thread_id === "number" &&
			typeof raw.message.message_id === "number" &&
			String(raw.message.chat?.id) === this.opts.chatId &&
			(await this.pairedChatIsPrivate())
		) {
			if (!(await this.reserveSeenUpdateId((update as { update_id?: number }).update_id!))) return;
			await this.#sendBtwMessage({
				threadId: String(raw.message.message_thread_id),
				messageId: raw.message.message_id,
				text: BTW_USAGE_TEXT,
				isAuthoritative: () => true,
			});
			return;
		}
		const directControl =
			typeof raw.message?.text === "string"
				? parseTelegramControlCommand(raw.message.text, this.botUsername)
				: ({ kind: "none" } as const);
		const interceptAskControl = isAskReply && directControl.kind !== "none";
		if (!raw.callback_query && (!isAskReply || interceptAskControl || reservedBtw !== undefined)) {
			const inbound = decideThreadedInbound(update as never, {
				pairedChatId: this.opts.chatId,
				topicToSession: t => {
					const topicSessionId = this.topics.sessionForTopic(t);
					if (!topicSessionId) return undefined;
					const legacyOwner = this.legacyTopicOwners.get(topicSessionId);
					if (this.preservedInitiatorTopics.has(topicSessionId)) return undefined;
					const owner =
						this.logicalSessionOwners.get(topicSessionId) ??
						legacyOwner ??
						[...this.sessions.values()].find(
							session =>
								(session.sessionId === topicSessionId || this.#logicalSessionId(session) === topicSessionId) &&
								this.#leaseAllows(session, topicSessionId),
						);
					if (owner) {
						if (owner.replayPending || owner.recoveryLease?.state === "pending") return undefined;
						return this.#leaseAllows(owner, topicSessionId) ? owner.logicalSessionId : undefined;
					}
					const transportOwner = [...this.sessions.values()].find(
						candidate => candidate.sessionId === topicSessionId && this.#leaseAllows(candidate),
					);
					if (transportOwner) {
						if (transportOwner.replayPending || transportOwner.recoveryLease?.state === "pending")
							return undefined;
						return transportOwner.logicalSessionId;
					}
					if (
						reservedBtw?.kind === "question" &&
						(raw.message?.photo || raw.message?.document || raw.message?.video || raw.message?.audio)
					)
						return topicSessionId;
					return [...this.sessions.values()].some(
						session =>
							(session.sessionId === topicSessionId ||
								this.#logicalSessionId(session) === topicSessionId ||
								session.recoveryLease?.logicalSessionId === topicSessionId) &&
							session.ws.readyState !== WebSocket.CLOSED,
					)
						? undefined
						: topicSessionId;
				},
				isDuplicate: id => this.dispatchState.seenUpdateIds.has(id),
			});
			if (inbound.kind === "duplicate") return;
			if (inbound.kind === "inject") {
				if (!(await this.pairedChatIsPrivate())) return;
				const preliminaryControl = inbound.attachment
					? { kind: "none" as const }
					: parseTelegramControlCommand(inbound.text, this.botUsername);
				const reservedBtw = parseBtwCommand(inbound.text, this.botUsername);
				if (preliminaryControl.kind === "ignored") return;
				const session =
					this.logicalSessionOwners.get(inbound.sessionId) ??
					this.sessions.get(inbound.sessionId) ??
					[...this.sessions.values()].find(
						candidate =>
							this.#logicalSessionId(candidate) === inbound.sessionId &&
							this.#leaseAllows(candidate, inbound.sessionId),
					);
				if (session && !this.#leaseAllows(session, inbound.sessionId)) return;
				const topicSessionId = this.topics.sessionForTopic(inbound.threadId);
				const topicLease = topicSessionId ? this.topicAuthorityLeaseFromRegistry(topicSessionId) : undefined;
				const topicLeaseAllows = (): boolean => {
					const current = topicSessionId ? this.topicAuthorityLeaseFromRegistry(topicSessionId) : undefined;
					return (
						!!topicLease &&
						current?.topicId === topicLease.topicId &&
						current.authorityEpoch === topicLease.authorityEpoch
					);
				};
				const routeLease = session ? this.#socketLease(session, inbound.sessionId) : undefined;
				const routeAllows = (): boolean =>
					!!session &&
					!!routeLease &&
					session.ws.readyState === WebSocket.OPEN &&
					this.#leaseTokenAllows(routeLease) &&
					topicLeaseAllows();
				const routeLeaseAllows = (): boolean =>
					topicLeaseAllows() && (!session || (!!routeLease && this.#leaseTokenAllows(routeLease)));
				if (
					/^\/btw(?:\s|$)/i.test(inbound.text) &&
					inbound.attachment &&
					(!session || session.ws.readyState !== WebSocket.OPEN || !routeLease)
				) {
					if (!(await this.reserveSeenUpdateId(inbound.updateId))) return;
					await this.#sendBtwMessage({
						threadId: inbound.threadId,
						messageId: inbound.messageId,
						text: BTW_USAGE_TEXT,
						isAuthoritative: () => true,
					});
					return;
				}
				const reserveRouteUpdate = async (): Promise<boolean> => {
					if (!(await this.reserveSeenUpdateId(inbound.updateId))) return false;
					if (routeLeaseAllows()) return true;
					await this.releaseSeenUpdateId(inbound.updateId);
					return false;
				};

				if (session && !routeLease && !(reservedBtw?.kind === "question" && inbound.attachment)) return;
				if (
					preliminaryControl.kind === "invalid" &&
					session?.ws.readyState !== WebSocket.OPEN &&
					!(reservedBtw?.kind === "question" && inbound.attachment)
				)
					return;
				if (
					preliminaryControl.kind === "command" &&
					session?.ws.readyState !== WebSocket.OPEN &&
					!(reservedBtw?.kind === "question" && inbound.attachment)
				) {
					if (await reserveRouteUpdate()) {
						try {
							await this.botApi.call("sendMessage", {
								chat_id: this.opts.chatId,
								message_thread_id: Number(inbound.threadId),
								text: "Session control unavailable: this local GJC session is disconnected.",
								...(telegramDisableNotification(this.opts.sound, "finalized") === true
									? { disable_notification: true }
									: {}),
							});
						} catch {
							logger.warn("notifications: unavailable-control notice delivery failed");
						}
					}
					return;
				}
				if (reservedBtw?.kind === "ignored") {
					await this.rememberSeenUpdateId(inbound.updateId);
					return;
				}
				if (reservedBtw?.kind === "question" && (!reservedBtw.question || inbound.attachment)) {
					const reserved =
						session?.ws.readyState === WebSocket.OPEN
							? await reserveRouteUpdate()
							: await this.reserveSeenUpdateId(inbound.updateId);
					if (!reserved) return;
					if (session?.ws.readyState !== WebSocket.OPEN) await this.flushPool();
					await this.#sendBtwMessage({
						threadId: inbound.threadId,
						messageId: inbound.messageId,
						text: BTW_USAGE_TEXT,
						isAuthoritative: session?.ws.readyState === WebSocket.OPEN ? routeLeaseAllows : () => true,
					});
					return;
				}
				if (reservedBtw?.kind === "question" && this.opts.btw?.enabled === false) {
					if (!(await reserveRouteUpdate())) return;
					await this.#sendBtwMessage({
						threadId: inbound.threadId,
						messageId: inbound.messageId,
						text: "Telegram /btw is disabled in local settings.",
						isAuthoritative: routeLeaseAllows,
					});
					return;
				}
				if (reservedBtw?.kind === "question" && session?.ws.readyState !== WebSocket.OPEN) {
					if (!(await reserveRouteUpdate())) return;
					await this.#sendBtwMessage({
						threadId: inbound.threadId,
						messageId: inbound.messageId,
						text: "Restart this GJC session to enable /btw.",
						isAuthoritative: routeLeaseAllows,
					});
					return;
				}
				if (!session || !routeLease) return;
				if (routeAllows()) {
					const attachmentResult = inbound.attachment
						? await this.resolveInboundAttachment(inbound.attachment, inbound.sessionId)
						: undefined;
					if (!routeAllows()) return;
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
							if (!(await reserveRouteUpdate())) return;
							await this.#sendBtwMessage({
								threadId: inbound.threadId,
								messageId: inbound.messageId,
								text: BTW_USAGE_TEXT,
								isAuthoritative: routeLeaseAllows,
							});
							return;
						}
						if (!isValidBtwQuestion(btwQuestion)) {
							try {
								await this.#sendBtwMessage({
									threadId: inbound.threadId,
									messageId: inbound.messageId,
									text: BTW_QUESTION_LIMIT_TEXT,
									isAuthoritative: routeLeaseAllows,
								});
							} catch {
								logger.warn("notifications: /btw question-limit delivery failed");
							}
							await reserveRouteUpdate();
							return;
						}
						if (this.opts.btw?.enabled === false) {
							if (!(await reserveRouteUpdate())) return;
							await this.#sendBtwMessage({
								threadId: inbound.threadId,
								messageId: inbound.messageId,
								text: "Telegram /btw is disabled in local settings.",
								isAuthoritative: routeLeaseAllows,
							});
							return;
						}
						if (!session.ephemeralCapable || session.hostGeneration < 1) {
							if (!(await reserveRouteUpdate())) return;
							await this.#sendBtwMessage({
								threadId: inbound.threadId,
								messageId: inbound.messageId,
								text: "Restart this GJC session to enable /btw.",
								isAuthoritative: routeLeaseAllows,
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
							if (!(await reserveRouteUpdate())) return;
							await this.#sendBtwMessage({
								threadId: inbound.threadId,
								messageId: inbound.messageId,
								text: BTW_CAPACITY_TEXT,
								isAuthoritative: routeLeaseAllows,
							});
							return;
						}
						const transportSessionId = session.sessionId;
						const logicalSessionId = this.#logicalSessionId(session);
						const requestId = `btw:${crypto.randomUUID()}`;
						if (!(await reserveRouteUpdate())) return;
						const pending: PendingBtwTurn = {
							transportSessionId,
							logicalSessionId,
							socketLease: routeLease,
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
								isAuthoritative: routeLeaseAllows,
							});
							return;
						}
						return;
					}
					const control = hasMedia ? { kind: "none" as const } : preliminaryControl;
					if (control.kind !== "none") {
						if (!(await reserveRouteUpdate())) return;
						const sendControlNotice = async (body: string): Promise<void> => {
							try {
								if (!routeLeaseAllows()) return;
								await this.botApi.call("sendMessage", {
									chat_id: this.opts.chatId,
									message_thread_id: Number(inbound.threadId),
									text: body,
									parse_mode: TELEGRAM_PARSE_MODE,
									...(telegramDisableNotification(this.opts.sound, "finalized") === true
										? { disable_notification: true }
										: {}),
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
						if (!routeAllows()) return;
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
					if (!routeAllows()) return;
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
						if (inbound.messageId !== undefined)
							await this.setReaction(inbound.messageId, QUEUED_REACTION, routeLease);
						return;
					}
					if (!routeAllows()) return;
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
						if (!routeAllows()) return;
						this.inboundReactions.set(inbound.updateId, {
							messageId: inbound.messageId,
							socketLease: routeLease,
						});
						await this.setReaction(inbound.messageId, QUEUED_REACTION, routeLease);
					}
				}
				return;
			}
		}
		const callbackId = (update as { callback_query?: { id?: unknown } }).callback_query?.id;
		if (await this.#handleAdoptionPickerCallback(update, callbackId)) return;
		if (await this.#handleModelChoiceCallback(update, callbackId)) return;
		const callbackAlias = (update as { callback_query?: { data?: unknown } }).callback_query?.data;
		const stagedActivation =
			typeof callbackAlias === "string" ? this.#stagedCallbackActivations.get(callbackAlias) : undefined;
		if (stagedActivation && !(await stagedActivation.settled)) {
			await this.sendStaleGuidance(callbackId);
			return;
		}
		const decision = routeInboundUpdate(update, {
			aliasTable: this.aliasTable,
			messageRoutes: this.messageRoutes,
			pairedChatId: this.opts.chatId,
		});
		if (decision.kind === "reply") {
			const callbackLease =
				typeof callbackAlias === "string" ? this.#callbackAliasLeases.get(callbackAlias) : undefined;
			const callbackPending =
				typeof callbackAlias === "string" ? this.#callbackAliasPending.get(callbackAlias) : undefined;
			const callbackTopic =
				typeof callbackAlias === "string" ? this.#callbackAliasTopics.get(callbackAlias) : undefined;
			const session = this.logicalSessionOwners.get(decision.sessionId) ?? this.sessions.get(decision.sessionId);
			const pendingAction = session?.pending.get(decision.actionId);
			if (
				(typeof callbackAlias === "string" &&
					(!callbackLease ||
						!callbackPending ||
						callbackPending !== pendingAction ||
						!this.#leaseTokenAllows(callbackLease) ||
						(callbackTopic
							? !this.topicLeaseIsCurrent(callbackTopic)
							: this.topics.get(decision.sessionId) !== undefined))) ||
				session?.ws.readyState !== WebSocket.OPEN ||
				!pendingAction ||
				!this.#leaseAllows(session, decision.sessionId)
			) {
				if (
					typeof callbackAlias === "string" &&
					callbackPending !== undefined &&
					callbackPending !== pendingAction &&
					this.#revokeCallbackAlias(callbackAlias)
				)
					await this.persistAliases();
				await this.sendStaleGuidance(callbackId);
				return;
			}
			const consumedAliases: Array<
				[
					string,
					CallbackRoute,
					{ session: SessionSocket; token: number; logicalSessionId: string } | undefined,
					{ sessionId: string; actionId: string } | undefined,
					TopicAuthorityLease | undefined,
				]
			> = [];
			// Consume only controls from this exact rendered ask. Predecessor receipts
			// remain in the terminalization backlog until their authoritative outcome.
			for (const [alias, route] of this.aliasTable.entries()) {
				if (
					route.sessionId === decision.sessionId &&
					route.actionId === decision.actionId &&
					this.#callbackAliasPending.get(alias) === pendingAction
				) {
					consumedAliases.push([
						alias,
						route,
						this.#callbackAliasLeases.get(alias),
						this.#callbackAliasPending.get(alias),
						this.#callbackAliasTopics.get(alias),
					]);
					this.aliasTable.delete(alias);
					this.#callbackAliasLeases.delete(alias);
					this.#callbackAliasPending.delete(alias);
					this.#callbackAliasTopics.delete(alias);
				}
			}
			try {
				await this.persistAliases();
			} catch {
				for (const [alias, route, lease, pending, topic] of consumedAliases) {
					this.aliasTable.activate(alias, route);
					if (lease) this.#callbackAliasLeases.set(alias, lease);
					if (pending) this.#callbackAliasPending.set(alias, pending);
					if (topic) this.#callbackAliasTopics.set(alias, topic);
				}
				throw new Error("callback receipt consumption was not durably persisted");
			}
			if (
				session.ws.readyState !== WebSocket.OPEN ||
				session.pending.get(decision.actionId) !== pendingAction ||
				(typeof callbackAlias === "string" &&
					(!callbackPending ||
						callbackPending !== pendingAction ||
						!callbackLease ||
						!this.#leaseTokenAllows(callbackLease) ||
						(callbackTopic
							? !this.topicLeaseIsCurrent(callbackTopic)
							: this.topics.get(decision.sessionId) !== undefined)))
			) {
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
					{
						command: "toolactivity",
						description: "Toggle tool activity updates: /toolactivity <on|off>",
					},
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
		// Runtime callers can bypass TypeScript's option type. Without a valid bot
		// token, there is no authenticated daemon identity or lifecycle authority.
		if (!validBotToken(this.opts.botToken)) return;
		if (this.validationMode()) {
			if (!/^-100\d+$/.test(this.opts.validationTestSupergroupChatId!))
				throw new Error("validation forum destination must be a negative -100... chat ID");
			if ((await this.resolvePairedChatPrivacy()) !== "validation-forum")
				throw new Error("validation forum destination must be the exact supergroup forum returned by getChat");
		}
		let ownershipProved = false;
		try {
			const renewed = await renewDaemonHeartbeat({
				settings: this.opts.settings,
				ownerId: this.opts.ownerId,
				acquisitionId: this.opts.ownerId,
				tokenFingerprint: tokenFingerprint(this.opts.botToken),
				chatId: this.opts.chatId,
				fs: this.fsImpl,
				now: this.opts.now,
				pid: this.opts.pid ?? process.pid,
				pidIncarnation: this.opts.pidIncarnation,
			});
			if (!renewed) return;
			ownershipProved = true;
			this.running = !this.stopRequested;
			if (!this.running) return;
			// Self-heal durable notification state before any scan/poll work so
			// `daemon reload` recovers dead roots + leak artifacts (#2956).
			if (!this.validationMode()) {
				try {
					await healTelegramDaemonNotificationState({
						settings: this.opts.settings,
						fs: this.fsImpl,
						now: this.opts.now,
					});
				} catch (error) {
					logger.warn(`notifications: startup self-heal failed: ${sanitizeDiagnostic(String(error))}`);
				}
			}
			await this.loadAliases();
			// Owner-only: start lifecycle control immediately after ownership proof,
			// before timers or pre-poll startup work can invalidate this run.
			// Best-effort; notification delivery remains available on failure.
			if (!this.validationMode()) await this.startLifecycleControl();
			// A stop may arrive while lifecycle startup awaits its control endpoint.
			// Do not re-enable runtime work after that stop; close the partial server.
			if (!this.running) return;
			this.runtime.start();
			this.startOwnershipHeartbeatTimer();
			this.startFlushTimer();
			this.startScanTimer();
			this.startTypingTimer();
			if (!this.validationMode()) {
				await this.refreshBotIdentity();
				await this.registerBotCommands();
			}
			await this.loadTopics();
			if (!this.validationMode()) {
				await this.loadAdoptionIntents();
				this.startAdoptionSweepTimer();
			}
			if (!this.validationMode()) {
				await this.loadSeenUpdateIds();
				await this.replyStore.load();
			}
			await this.runScan();
			let idleSince = this.runtime.now();
			while (this.running) {
				if (await this.controlStopRequested()) break;
				if (
					!(await renewOwnerHeartbeatSidecar({
						settings: this.opts.settings,
						ownerId: this.opts.ownerId,
						acquisitionId: this.opts.ownerId,
						fs: this.fsImpl,
						now: this.opts.now,
						pid: this.opts.pid ?? process.pid,
						pidIncarnation: this.opts.pidIncarnation,
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
			this.running = false;
			this.runtime.stop();
			this.stopOwnershipHeartbeatTimer();
			const heartbeatJoined = await this.runtime.joinExclusive("telegram-owner-heartbeat", BTW_SHUTDOWN_JOIN_MS);
			if (!heartbeatJoined) logger.warn("heartbeat join timed out; retaining daemon ownership (release aborted)");
			// A contender must not mutate durable owner state while unwinding startup.
			if (ownershipProved) {
				let toolShutdownError: unknown;
				try {
					await this.beginToolActivityShutdown();
				} catch (error) {
					toolShutdownError = error;
				}
				this.effects.beginShutdown();
				this.#deliveryAbort.abort();
				this.stopFlushTimer();
				this.stopScanTimer();
				this.stopTypingTimer();
				this.stopAdoptionSweepTimer();
				this.stopLifecycleControl();
				let persisted = false;
				const sessionEffectsQuiesced = await this.effects.join(BTW_SHUTDOWN_JOIN_MS);
				let completed = false;
				if (sessionEffectsQuiesced) {
					const shutdown = this.effects.allowTerminal(async () => {
						if (toolShutdownError) throw toolShutdownError;
						await this.#drainBtwTurns();
						await this.toolTerminalizationChain;
						await this.cleanupAllAttachmentDirs();
						if (!this.validationMode()) {
							await this.persistAliases();
							await this.persistSeenUpdateIds();
							await this.opts.control?.clear?.(this.opts.ownerId);
						}
						await this.persistTopics();
						persisted = true;
					});
					const deadline = Promise.withResolvers<boolean>();
					const deadlineTimer = setTimeout(() => deadline.resolve(false), BTW_SHUTDOWN_JOIN_MS);
					completed = await Promise.race([
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
				}
				const quiesced = completed && heartbeatJoined && sessionEffectsQuiesced;
				if (!quiesced || !persisted) {
					logger.warn("notifications: shutdown was not durably quiesced; retaining daemon ownership");
				} else {
					await releaseDaemonOwnership({
						settings: this.opts.settings,
						ownerId: this.opts.ownerId,
						acquisitionId: this.opts.ownerId,
						tokenFingerprint: tokenFingerprint(this.opts.botToken),
						chatId: this.opts.chatId,
						pid: this.opts.pid ?? process.pid,
						generation: DAEMON_GENERATION,
						pidIncarnation: this.opts.pidIncarnation,
						fs: this.fsImpl,
						now: this.opts.now,
					});
				}
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
