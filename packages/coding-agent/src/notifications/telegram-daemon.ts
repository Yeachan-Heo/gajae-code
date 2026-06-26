import { spawn as childProcessSpawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { withFileLock } from "../config/file-lock";
import type { Settings } from "../config/settings";
import type { DaemonRuntimeInfo } from "../daemon/control-types";
import { resolveGjcRuntimeSpawnInfo } from "../daemon/runtime";
import { getNotificationConfig, isGloballyConfigured, tokenFingerprint } from "./config";
import { parseInThreadConfigCommand } from "./config-commands";
import { buildCompactChoiceGrid, TELEGRAM_PARSE_MODE } from "./html-format";
import { NotificationOperatorRuntime, OperatorBackoffPolicy, OperatorEventRouter } from "./operator-runtime";
import { RateLimitPool } from "./rate-limit-pool";
import {
	type AliasTable,
	buildActionMessage,
	type CallbackRoute,
	createAliasTable,
	type PendingAsk,
	readEndpoint,
	routeInboundUpdate,
} from "./telegram-reference";
import { decideThreadedInbound, type InboundAttachment } from "./threaded-inbound";
import { renderThreadedFrame, type ThreadedSend } from "./threaded-render";
import { TopicRegistry, type TopicRegistryState } from "./topic-registry";

export type EnsureDaemonResult = "owner_spawned" | "attached" | "disabled";

export interface DaemonState {
	pid: number;
	ownerId: string;
	tokenFingerprint: string;
	chatId: string;
	startedAt: number;
	heartbeatAt: number;
	roots: string[];
	version: 1;
	stoppedAt?: number;
}

export interface DaemonPaths {
	dir: string;
	lock: string;
	state: string;
	roots: string;
	steal: string;
	aliases: string;
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
	randomId?: () => string;
}

export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_TTL_MS = 20_000;
export const DAEMON_VERSION = 1;
/** Capability token advertised when the server supports app-level ping/pong. */
export const CLIENT_PING_PONG_CAPABILITY = "client_ping_pong";
/** Protocol version the daemon advertises in its ClientHello. */
export const NOTIFICATION_PROTOCOL_VERSION = 2;

const nodeFs: TelegramDaemonFs = fs.promises as unknown as TelegramDaemonFs;
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
const CONSUMED_REACTION = "✅";

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

export function daemonPaths(agentDir: string): DaemonPaths {
	const dir = path.join(agentDir, "notifications");
	return {
		dir,
		lock: path.join(dir, "telegram-daemon.lock"),
		state: path.join(dir, "telegram-daemon.state.json"),
		roots: path.join(dir, "telegram-daemon.roots.json"),
		steal: path.join(dir, "telegram-daemon.steal"),
		aliases: path.join(dir, "telegram-callback-aliases.json"),
	};
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

export async function registerNotificationRoot(input: {
	settings: Settings;
	cwd: string;
	sessionId: string;
	fs?: TelegramDaemonFs;
}): Promise<string> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	await ensureDir(fsImpl, paths.dir);
	const root = path.join(input.cwd, ".gjc", "state");
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
			state.tokenFingerprint === input.tokenFingerprint &&
			state.chatId === input.chatId &&
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
}): Promise<{ acquired: boolean; ownerId?: string; attached?: boolean }> {
	const fsImpl = input.fs ?? nodeFs;
	const now = input.now ?? Date.now;
	const pid = input.pid ?? process.pid;
	const pidAlive = input.pidAlive ?? defaultPidAlive;
	const paths = daemonPaths(input.settings.getAgentDir());
	await ensureDir(fsImpl, paths.dir);
	const ownerId = input.randomId?.() ?? `${pid}-${now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	const roots = input.roots ?? (await readJson<{ roots?: string[] }>(fsImpl, paths.roots))?.roots ?? [];
	const existing = await readJson<DaemonState>(fsImpl, paths.state);
	if (
		isFreshLiveOwner({
			state: existing,
			now: now(),
			tokenFingerprint: input.tokenFingerprint,
			chatId: input.chatId,
			pidAlive,
		})
	) {
		return { acquired: false, attached: true };
	}
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
		} satisfies DaemonState);
		return { acquired: true, ownerId };
	}
	const afterLock = await readJson<DaemonState>(fsImpl, paths.state);
	if (
		isFreshLiveOwner({
			state: afterLock,
			now: now(),
			tokenFingerprint: input.tokenFingerprint,
			chatId: input.chatId,
			pidAlive,
		})
	) {
		return { acquired: false, attached: true };
	}
	if (!afterLock) return { acquired: false, attached: true };
	if (!(await tryOpenWx(fsImpl, paths.steal))) return { acquired: false, attached: true };
	try {
		const rechecked = await readJson<DaemonState>(fsImpl, paths.state);
		if (
			isFreshLiveOwner({
				state: rechecked,
				now: now(),
				tokenFingerprint: input.tokenFingerprint,
				chatId: input.chatId,
				pidAlive,
			})
		) {
			return { acquired: false, attached: true };
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
	if (!ownership.acquired) return { result: "attached", runtime, warnings: [] };
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
	input: { settings: Settings; cwd: string; sessionId: string },
	deps: TelegramDaemonDeps = {},
): Promise<EnsureDaemonResult> {
	const cfg = getNotificationConfig(input.settings);
	if (!isGloballyConfigured(cfg) || !cfg.botToken || !cfg.chatId) return "disabled";
	const root = await registerNotificationRoot({ ...input, fs: deps.fs });
	const fp = tokenFingerprint(cfg.botToken);
	const spawned = await spawnTelegramDaemonOwner(
		{ settings: input.settings, roots: [root], tokenFingerprint: fp, chatId: cfg.chatId },
		deps,
	);
	return spawned.result;
}

export interface BotApi {
	call(method: string, body: unknown, opts?: { signal?: AbortSignal }): Promise<unknown>;
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

	async call(method: string, body: unknown, opts?: { signal?: AbortSignal }): Promise<unknown> {
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
			const res = await fetchWithRetry(fetchImpl, url, { method: "POST", body: form, signal: opts?.signal }, sleep);
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
			const res = await fetchWithRetry(fetchImpl, url, { method: "POST", body: form, signal: opts?.signal }, sleep);
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
		);
		return res.json();
	}
}

export interface TelegramUpdatePollerOptions {
	botApi: BotApi;
	runtime: NotificationOperatorRuntime;
	backoff: OperatorBackoffPolicy;
	processUpdate: (update: unknown) => Promise<void>;
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
			this.#offset = update.update_id + 1;
			try {
				await this.#opts.processUpdate(update);
			} catch (err) {
				logger.error("notifications daemon: handleTelegramUpdate failed", { error: String(err) });
			}
		}
		return body.result?.length ?? 0;
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
	idleTimeoutMs?: number;
	scanIntervalMs?: number;
	pid?: number;
	botApi?: BotApi;
	control?: DaemonControlHooks;
}

interface SessionSocket {
	sessionId: string;
	token: string;
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
}

interface PendingThreadedFrame {
	send: ThreadedSend;
	msg: Record<string, unknown>;
}

export class TelegramNotificationDaemon {
	readonly aliasTable: AliasTable;
	readonly messageRoutes = new Map<string | number, CallbackRoute | Omit<CallbackRoute, "answer">>();
	readonly sessions = new Map<string, SessionSocket>();
	private readonly runtime: NotificationOperatorRuntime;
	private readonly sessionRouter: OperatorEventRouter<SessionSocket>;
	private readonly pollConflictBackoff = new OperatorBackoffPolicy({ initialMs: 500, maxMs: 5_000 });
	private readonly loopBackoff = new OperatorBackoffPolicy({ initialMs: 250, maxMs: 4_000 });
	private running = false;
	private readonly fsImpl: TelegramDaemonFs;
	private readonly botApi: BotApi;
	private readonly topics = new TopicRegistry();
	private readonly pool: RateLimitPool<{ send: ThreadedSend; topicId?: string }>;
	private readonly poller: TelegramUpdatePoller;
	private readonly dispatchState = new TelegramEventDispatchState();
	/** Identity-bearing sessions by repo/branch surface, used to avoid transient duplicate topics. */
	private readonly topicOwnerByIdentity = new Map<string, string>();
	/** Non-identity frames held until identity creates the correct thread. */
	private readonly pendingThreadedFrames = new Map<string, PendingThreadedFrame[]>();
	/** True once the daemon has nudged the user to enable Threaded Mode. */
	private threadedFallbackNoticeSent = false;
	/** Sessions whose identity header was already sent flat (Threaded Mode off). */
	private readonly flatIdentitySent = new Set<string>();
	/** Cached result of whether the paired chat is a private chat (flat-fallback gate). */
	private pairedChatPrivate: boolean | undefined;
	/** Sessions whose agent loop is currently busy (drives the typing indicator). */
	private get busy(): Set<string> {
		return this.dispatchState.busy;
	}
	/** Inbound update id → originating Telegram message, for delivery reactions. */
	private get inboundReactions(): Map<number, { messageId: number }> {
		return this.dispatchState.inboundReactions;
	}

	/**
	 * Cooperatively stop the daemon: set the stop flag and abort the in-flight
	 * long poll so the run loop wakes immediately instead of waiting out the
	 * ~25s getUpdates timeout. Safe to call from a signal handler.
	 */
	requestStop(_reason?: "reload" | "stop" | "signal"): void {
		this.runtime.requestStop();
		this.running = false;
	}

	constructor(private readonly opts: TelegramDaemonOptions) {
		this.fsImpl = opts.fs ?? nodeFs;
		this.aliasTable = createAliasTable();
		this.botApi =
			opts.botApi ??
			new TelegramBotTransport({
				botToken: opts.botToken,
				apiBase: opts.apiBase,
				fetchImpl: opts.fetchImpl,
				setTimeoutImpl: opts.setTimeoutImpl,
			});
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
			processUpdate: update => this.handleTelegramUpdate(update),
		});
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

	async scanRoots(): Promise<void> {
		const paths = daemonPaths(this.opts.settings.getAgentDir());
		const rootState = await readJson<{ roots?: string[] }>(this.fsImpl, paths.roots);
		for (const root of rootState?.roots ?? []) {
			const dir = path.join(root, "notifications");
			let files: string[];
			try {
				files = await this.fsImpl.readdir(dir);
			} catch {
				continue;
			}
			for (const file of files.filter(item => item.endsWith(".json"))) {
				const sessionId = path.basename(file, ".json");
				if (this.sessions.has(sessionId)) continue;
				try {
					const endpoint = readEndpoint(path.join(dir, file));
					this.connectSession(sessionId, endpoint.url, endpoint.token);
				} catch {}
			}
		}
	}

	connectSession(sessionId: string, url: string, token: string): void {
		const WS = this.opts.WebSocketImpl ?? WebSocket;
		const ws = new WS(`${url}/?token=${encodeURIComponent(token)}`);
		const session: SessionSocket = {
			sessionId,
			token,
			ws,
			pending: new Map(),
			capable: false,
			lastPongAt: 0,
			awaitingNonce: undefined,
			pingTimer: undefined,
		};
		this.sessions.set(sessionId, session);
		// Bidirectional capability advertisement: announce client_ping_pong once the
		// socket is open. Sent on "open" only — a real WHATWG WebSocket cannot send
		// while CONNECTING — and liveness starts only after a capable ServerHello.
		ws.addEventListener("open", () => {
			if (session.ws.readyState === WebSocket.OPEN) {
				try {
					session.ws.send(
						JSON.stringify({
							type: "hello",
							protocolVersion: NOTIFICATION_PROTOCOL_VERSION,
							capabilities: [CLIENT_PING_PONG_CAPABILITY],
						}),
					);
				} catch {}
			}
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
	private dropSession(session: SessionSocket, _reason: string): void {
		const clearIntervalImpl = this.opts.clearIntervalImpl ?? clearInterval;
		if (session.pingTimer) {
			clearIntervalImpl(session.pingTimer);
			session.pingTimer = undefined;
		}
		if (this.sessions.get(session.sessionId) === session) {
			this.sessions.delete(session.sessionId);
		}
		if (session.ws.readyState !== WebSocket.CLOSED) {
			try {
				session.ws.close();
			} catch {}
		}
	}

	private static readonly THREADED_FRAMES = new Set([
		"identity_header",
		"context_update",
		"turn_stream",
		"image_attachment",
		"file_attachment",
		"config_update",
	]);

	private topicNameFor(sessionId: string, msg: { title?: unknown; repo?: unknown; branch?: unknown }): string {
		const repo = typeof msg?.repo === "string" && msg.repo ? msg.repo : undefined;
		const branch = typeof msg?.branch === "string" && msg.branch ? msg.branch : undefined;
		const title = typeof msg?.title === "string" && msg.title ? msg.title : undefined;
		// Name the topic "{repo}/{branch}" before a session title exists, then
		// "{repo}/{branch} - {title}" once it does. Fall back to the session id
		// only when no repo identity is available.
		const base = repo ? (branch ? `${repo}/${branch}` : repo) : undefined;
		if (base) return title ? `${base} - ${title}` : base;
		if (title) return title;
		return `GJC ${sessionId.slice(-6)}`;
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
		const base = this.topicIdentityBase(msg);
		if (!identityKey || !base) return undefined;
		for (const sessionId of this.topics.sessionIds()) {
			const name = this.topics.get(sessionId)?.name;
			if (name === base || name?.startsWith(`${base} - `)) {
				this.topicOwnerByIdentity.set(identityKey, sessionId);
				return sessionId;
			}
		}
		return undefined;
	}

	private async submitThreadedFrame(sessionId: string, send: ThreadedSend, topicId: string): Promise<void> {
		this.pool.submit({
			sessionId,
			lane: send.lane,
			coalesceKey: send.coalesceKey,
			payload: { send, topicId },
		});
		await this.flushPool();
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
		const existing = this.topics.get(sessionId);
		if (existing) return existing.topicId;
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
			);
			this.topics.applyName(sessionId, name);
			await this.persistTopics();
			return rec.topicId;
		} catch {
			return undefined;
		}
	}

	private async persistTopics(): Promise<void> {
		const paths = daemonPaths(this.opts.settings.getAgentDir());
		await ensureDir(this.fsImpl, paths.dir);
		await writeJsonAtomic(this.fsImpl, path.join(paths.dir, "telegram-topics.json"), this.topics.serialize());
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

	/** Drain the shared rate-limit pool and deliver each granted send to its topic. */
	private async flushPool(): Promise<void> {
		for (const item of this.pool.drain()) {
			const { send, topicId } = item.payload;
			// Threaded topic when available; otherwise deliver flat to the paired chat.
			const threadField = topicId ? { message_thread_id: Number(topicId) } : {};
			try {
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
					await this.botApi.call("sendMessage", {
						chat_id: this.opts.chatId,
						...threadField,
						text: send.text,
						parse_mode: TELEGRAM_PARSE_MODE,
					});
				}
			} catch {
				// Best-effort: a failed send must never stop the daemon.
			}
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
	private async deliverFlatFallback(sessionId: string, send: ThreadedSend): Promise<void> {
		if (!(await this.pairedChatIsPrivate())) return;
		await this.notifyThreadedFallback();
		if (send.identity && this.flatIdentitySent.has(sessionId)) return;
		this.pool.submit({ sessionId, lane: send.lane, coalesceKey: send.coalesceKey, payload: { send } });
		await this.flushPool();
		if (send.identity) this.flatIdentitySent.add(sessionId);
	}

	/**
	 * Resolve once (cached) whether the paired `chatId` is a private chat. Flat
	 * fallback is only safe in a private DM; any non-private chat or an unresolvable
	 * `getChat` is treated as not-private so delivery fails closed.
	 */
	private async pairedChatIsPrivate(): Promise<boolean> {
		if (this.pairedChatPrivate !== undefined) return this.pairedChatPrivate;
		try {
			const res = (await this.botApi.call("getChat", { chat_id: this.opts.chatId })) as {
				result?: { type?: string };
			};
			this.pairedChatPrivate = res.result?.type === "private";
		} catch {
			this.pairedChatPrivate = false;
		}
		return this.pairedChatPrivate;
	}

	/** Tell the user once (per daemon run) how to enable Threaded Mode. */
	private async notifyThreadedFallback(): Promise<void> {
		if (this.threadedFallbackNoticeSent) return;
		this.threadedFallbackNoticeSent = true;
		try {
			await this.botApi.call("sendMessage", {
				chat_id: this.opts.chatId,
				text: "turn on threaded mode from botfather miniapp to receive gjc notification!",
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
		if (!topicId) return;
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

	async handleSessionMessage(session: SessionSocket, msg: any): Promise<void> {
		if (await this.sessionRouter.dispatch(session, msg as Record<string, unknown>)) return;
		if (typeof msg?.type === "string" && TelegramNotificationDaemon.THREADED_FRAMES.has(msg.type)) {
			const send = renderThreadedFrame(msg);
			if (!send) return;
			const existingTopic = this.topics.get(session.sessionId)?.topicId;
			if (!send.identity && !existingTopic && !this.flatIdentitySent.has(session.sessionId)) {
				this.rememberPendingThreadedFrame(session.sessionId, send, msg as Record<string, unknown>);
				return;
			}
			if (send.identity) {
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
				if (identityKey) this.topicOwnerByIdentity.set(identityKey, session.sessionId);
				// Rename the topic if the title changed (e.g. the session title was
				// auto-generated after the topic was first created). This runs on
				// every identity frame, but does NOT re-send the bulleted message.
				const name = this.topicNameFor(session.sessionId, msg);
				if (this.topics.applyName(session.sessionId, name)) {
					try {
						await this.botApi.call("editForumTopic", {
							chat_id: this.opts.chatId,
							message_thread_id: Number(topicId),
							name,
						});
					} catch {
						// Best-effort rename; never block delivery.
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
			const rendered = buildActionMessage({
				kind: msg.kind ?? "ask",
				id: msg.id,
				question: msg.question,
				options: msg.options,
				summary: msg.summary,
			});
			const options = Array.isArray(msg.options) ? msg.options : [];
			// Daemon keyboards use alias callback data with compact one-based tap targets;
			// full option text is rendered in the message body by buildActionMessage.
			const inline_keyboard = buildCompactChoiceGrid(options, (i: number) =>
				this.aliasTable.put({ sessionId: session.sessionId, actionId: msg.id, answer: i }),
			);
			const result = (await this.botApi.call("sendMessage", {
				chat_id: this.opts.chatId,
				...threadField,
				text: rendered.text,
				parse_mode: TELEGRAM_PARSE_MODE,
				...(inline_keyboard.length ? { reply_markup: { inline_keyboard } } : {}),
			})) as { result?: { message_id?: number } };
			const messageId = result.result?.message_id;
			if (messageId !== undefined)
				this.messageRoutes.set(String(messageId), { sessionId: session.sessionId, actionId: msg.id });
			await this.persistAliases();
		} else if (msg.type === "action_resolved" && msg.id) {
			session.pending.delete(msg.id);
			for (const [alias, route] of this.aliasTable.entries()) {
				if (route.sessionId === session.sessionId && route.actionId === msg.id) this.aliasTable.delete(alias);
			}
			await this.persistAliases();
		}
	}

	pendingBySession = (sessionId?: string): PendingAsk[] => {
		const result: PendingAsk[] = [];
		for (const session of this.sessions.values()) {
			if (sessionId && session.sessionId !== sessionId) continue;
			result.push(...session.pending.values());
		}
		return result;
	};

	private async sendStaleGuidance(callbackId: unknown): Promise<void> {
		if (typeof callbackId === "string") {
			await this.botApi.call("answerCallbackQuery", { callback_query_id: callbackId, text: "Button is stale" });
		}
		await this.botApi.call("sendMessage", {
			chat_id: this.opts.chatId,
			text: "This button is stale after notification daemon restart. Please answer locally in the GJC session or wait for a fresh notification.",
			parse_mode: TELEGRAM_PARSE_MODE,
		});
	}

	async handleTelegramUpdate(update: unknown): Promise<void> {
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
				this.dispatchState.seenUpdateIds.add(inbound.updateId);
				const session = this.sessions.get(inbound.sessionId);
				if (session?.ws.readyState === WebSocket.OPEN) {
					const attachmentResult = inbound.attachment
						? await this.resolveInboundAttachment(inbound.attachment, inbound.sessionId)
						: undefined;
					const images = attachmentResult?.images ?? [];
					const fileNotes = attachmentResult?.fileNotes ?? [];
					const hasMedia = images.length > 0 || fileNotes.length > 0;
					const injectedText = [inbound.text, ...fileNotes].filter(Boolean).join("\n");
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
		const decision = routeInboundUpdate(update, {
			aliasTable: this.aliasTable,
			messageRoutes: this.messageRoutes,
			pendingBySession: this.pendingBySession,
			pairedChatId: this.opts.chatId,
		});
		if (decision.kind === "reply") {
			const session = this.sessions.get(decision.sessionId);
			if (session?.ws.readyState !== WebSocket.OPEN || !session.pending.has(decision.actionId)) {
				await this.sendStaleGuidance(callbackId);
				return;
			}
			if (typeof callbackId === "string")
				await this.botApi.call("answerCallbackQuery", { callback_query_id: callbackId });
			session.ws.send(
				JSON.stringify({ type: "reply", id: decision.actionId, answer: decision.answer, token: session.token }),
			);
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
		this.startFlushTimer();
		this.startScanTimer();
		this.startTypingTimer();
		try {
			await this.registerBotCommands();
			await this.loadAliases();
			await this.loadTopics();
			await this.runScan();
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
				if (this.sessions.size === 0) {
					if (this.runtime.now() - idleSince >= (this.opts.idleTimeoutMs ?? 60_000)) break;
				} else {
					idleSince = this.runtime.now();
					const activePoll = this.runtime.createAbortController();
					try {
						await this.pollOnce(activePoll.signal);
						this.loopBackoff.reset();
					} catch (e) {
						// A transient getUpdates/network failure must not kill the
						// daemon. Back off (bounded, below the heartbeat TTL) and keep
						// renewing ownership at the loop top.
						const backoffMs = this.loopBackoff.next();
						logger.warn(`notifications: getUpdates failed, backing off ${backoffMs}ms: ${String(e)}`);
						await this.runtime.sleep(backoffMs);
						continue;
					} finally {
						this.runtime.clearAbortController(activePoll);
					}
				}
				if (await this.controlStopRequested()) break;
				await this.runtime.sleep(10);
			}
		} finally {
			this.runtime.stop();
			this.stopFlushTimer();
			this.stopScanTimer();
			this.stopTypingTimer();
			await this.cleanupAllAttachmentDirs();
			// Persist durable state before releasing ownership so a fresh daemon
			// (e.g. after reload) reloads aliases/topics seamlessly.
			await this.persistAliases().catch(() => undefined);
			await this.persistTopics().catch(() => undefined);
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
