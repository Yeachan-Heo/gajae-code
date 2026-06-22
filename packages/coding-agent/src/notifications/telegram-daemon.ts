import { spawn as childProcessSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { withFileLock } from "../config/file-lock";
import type { Settings } from "../config/settings";
import { getNotificationConfig, isGloballyConfigured, tokenFingerprint } from "./config";
import { parseInThreadConfigCommand } from "./config-commands";
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
import { decideThreadedInbound } from "./threaded-inbound";
import { renderThreadedFrame, type ThreadedSend } from "./threaded-render";
import { TopicRegistry } from "./topic-registry";

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

const nodeFs: TelegramDaemonFs = fs.promises as unknown as TelegramDaemonFs;
const RATE_LIMIT_FLUSH_INTERVAL_MS = 1_000;

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

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
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

export async function ensureTelegramDaemonRunning(
	input: { settings: Settings; cwd: string; sessionId: string },
	deps: TelegramDaemonDeps = {},
): Promise<EnsureDaemonResult> {
	const cfg = getNotificationConfig(input.settings);
	if (!isGloballyConfigured(cfg) || !cfg.botToken || !cfg.chatId) return "disabled";
	const root = await registerNotificationRoot({ ...input, fs: deps.fs });
	const fp = tokenFingerprint(cfg.botToken);
	const ownership = await acquireDaemonOwnership({
		settings: input.settings,
		roots: [root],
		tokenFingerprint: fp,
		chatId: cfg.chatId,
		fs: deps.fs,
		now: deps.now,
		pid: deps.pid,
		pidAlive: deps.pidAlive,
		randomId: deps.randomId,
	});
	if (!ownership.acquired) return "attached";
	const execPath = deps.execPath ?? process.execPath;
	// Source mode (bun/node) needs the entry script prepended; a compiled single-file
	// binary (basename gjc/etc.) self-spawns its own subcommand directly.
	const base = path.basename(execPath).toLowerCase();
	const fromSource = base === "bun" || base === "node" || base.startsWith("bun") || base.startsWith("node");
	const mainScript = fromSource && typeof Bun !== "undefined" ? (Bun as unknown as { main?: string }).main : undefined;
	const args = [
		...(mainScript ? [mainScript] : []),
		"notify",
		"daemon-internal",
		"--owner-id",
		ownership.ownerId!,
		"--agent-dir",
		input.settings.getAgentDir(),
	];
	const spawnImpl = deps.spawn ?? defaultDaemonSpawn;
	const child = spawnImpl(execPath, args, {
		detached: true,
		stdio: "ignore",
		logPath: path.join(daemonPaths(input.settings.getAgentDir()).dir, "daemon.log"),
	});
	child?.unref?.();
	return "owner_spawned";
}

export interface BotApi {
	call(method: string, body: unknown): Promise<unknown>;
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
	pid?: number;
	botApi?: BotApi;
}

interface SessionSocket {
	sessionId: string;
	token: string;
	ws: WebSocket;
	pending: Map<string, { sessionId: string; actionId: string }>;
}

export class TelegramNotificationDaemon {
	readonly aliasTable: AliasTable;
	readonly messageRoutes = new Map<string | number, CallbackRoute | Omit<CallbackRoute, "answer">>();
	readonly sessions = new Map<string, SessionSocket>();
	private running = false;
	private offset = 0;
	private readonly fsImpl: TelegramDaemonFs;
	private readonly botApi: BotApi;
	private readonly topics = new TopicRegistry();
	private readonly pool: RateLimitPool<{ send: ThreadedSend; topicId: string }>;
	private readonly seenUpdateIds = new Set<number>();
	private flushTimer: ReturnType<typeof setInterval> | undefined;

	constructor(private readonly opts: TelegramDaemonOptions) {
		this.fsImpl = opts.fs ?? nodeFs;
		this.aliasTable = createAliasTable();
		this.botApi = opts.botApi ?? {
			call: async (method, body) => {
				const apiBase = opts.apiBase ?? "https://api.telegram.org";
				const url = `${apiBase}/bot${opts.botToken}/${method}`;
				const fetchImpl = opts.fetchImpl ?? fetch;
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
					};
					const form = new FormData();
					form.set("chat_id", String(b.chat_id));
					if (b.message_thread_id !== undefined) form.set("message_thread_id", String(b.message_thread_id));
					if (b.caption) form.set("caption", b.caption);
					form.set("photo", new Blob([Buffer.from(b.photo, "base64")], { type: b.mime ?? "image/png" }), "image");
					const res = await fetchImpl(url, { method: "POST", body: form });
					return res.json();
				}
				const res = await fetchImpl(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				});
				return res.json();
			},
		};
		this.pool = new RateLimitPool<{ send: ThreadedSend; topicId: string }>({ now: opts.now });
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
		const session: SessionSocket = { sessionId, token, ws, pending: new Map() };
		this.sessions.set(sessionId, session);
		ws.addEventListener("message", ev => {
			void this.handleSessionMessage(session, JSON.parse(String(ev.data))).catch(err => {
				// Surface frame-handling failures (e.g. a rejected ask sendMessage) to
				// the daemon log instead of an invisible unhandled rejection.
				console.error("notifications daemon: handleSessionMessage failed:", err);
			});
		});
		ws.addEventListener("close", () => {
			this.sessions.delete(sessionId);
		});
	}

	private static readonly THREADED_FRAMES = new Set([
		"identity_header",
		"context_update",
		"turn_stream",
		"image_attachment",
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

	/**
	 * Resolve (creating once via `createForumTopic`) the forum topic for a
	 * session. Threaded mode is required: on capability failure this returns
	 * `undefined` and the caller drops the send (no flat fallback).
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
		const raw = await readJson<{ topics?: Record<string, unknown> }>(
			this.fsImpl,
			path.join(paths.dir, "telegram-topics.json"),
		);
		if (raw && typeof raw === "object") {
			// Reconstruct via a fresh registry then copy in (TopicRegistry loads from state in ctor).
			const restored = new TopicRegistry(raw as never);
			for (const sid of Object.keys(raw.topics ?? {})) {
				const rec = restored.get(sid);
				if (rec) await this.topics.getOrCreateTopic(sid, async () => rec.topicId, this.opts.now);
			}
		}
	}

	/** Drain the shared rate-limit pool and deliver each granted send to its topic. */
	private async flushPool(): Promise<void> {
		for (const item of this.pool.drain()) {
			const { send, topicId } = item.payload;
			const thread = Number(topicId);
			try {
				if (send.method === "sendPhoto" && send.photoBase64) {
					// Real photo upload (the default botApi multiparts base64 -> file).
					await this.botApi.call("sendPhoto", {
						chat_id: this.opts.chatId,
						message_thread_id: thread,
						photo: send.photoBase64,
						mime: send.mime,
						caption: send.text,
					});
				} else if (send.text) {
					await this.botApi.call("sendMessage", {
						chat_id: this.opts.chatId,
						message_thread_id: thread,
						text: send.text,
					});
				}
			} catch {
				// Best-effort: a failed send must never stop the daemon.
			}
		}
	}

	private startFlushTimer(): void {
		if (this.flushTimer) return;
		const setIntervalImpl = this.opts.setIntervalImpl ?? setInterval;
		this.flushTimer = setIntervalImpl(() => {
			if (!this.running || this.pool.pending === 0) return;
			void this.flushPool();
		}, RATE_LIMIT_FLUSH_INTERVAL_MS);
	}

	private stopFlushTimer(): void {
		if (!this.flushTimer) return;
		const clearIntervalImpl = this.opts.clearIntervalImpl ?? clearInterval;
		clearIntervalImpl(this.flushTimer);
		this.flushTimer = undefined;
	}

	async handleSessionMessage(session: SessionSocket, msg: any): Promise<void> {
		if (typeof msg?.type === "string" && TelegramNotificationDaemon.THREADED_FRAMES.has(msg.type)) {
			const send = renderThreadedFrame(msg);
			if (!send) return;
			const topicId = await this.ensureTopic(session.sessionId, this.topicNameFor(session.sessionId, msg));
			if (!topicId) return;
			if (send.identity) {
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
					this.pool.submit({
						sessionId: session.sessionId,
						lane: send.lane,
						coalesceKey: send.coalesceKey,
						payload: { send, topicId },
					});
					await this.flushPool();
					this.topics.markIdentitySent(session.sessionId);
				}
				await this.persistTopics();
				return;
			}
			this.pool.submit({
				sessionId: session.sessionId,
				lane: send.lane,
				coalesceKey: send.coalesceKey,
				payload: { send, topicId },
			});
			await this.flushPool();
			return;
		}
		if (msg.type === "action_needed" && msg.id) {
			if (msg.kind === "ask") session.pending.set(msg.id, { sessionId: session.sessionId, actionId: msg.id });
			const topicId = await this.ensureTopic(session.sessionId, this.topicNameFor(session.sessionId, msg));
			if (!topicId) return;
			const rendered = buildActionMessage({
				kind: msg.kind ?? "ask",
				id: msg.id,
				question: msg.question,
				options: msg.options,
				summary: msg.summary,
			});
			const options = Array.isArray(msg.options) ? msg.options : [];
			const inline_keyboard = options.map((label: string, i: number) => [
				{
					text: label,
					callback_data: this.aliasTable.put({ sessionId: session.sessionId, actionId: msg.id, answer: i }),
				},
			]);
			const result = (await this.botApi.call("sendMessage", {
				chat_id: this.opts.chatId,
				message_thread_id: Number(topicId),
				text: rendered.text,
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
				isDuplicate: id => this.seenUpdateIds.has(id),
			});
			if (inbound.kind === "duplicate") return;
			if (inbound.kind === "inject") {
				this.seenUpdateIds.add(inbound.updateId);
				const session = this.sessions.get(inbound.sessionId);
				if (session?.ws.readyState === WebSocket.OPEN) {
					const cfg = parseInThreadConfigCommand(inbound.text);
					session.ws.send(
						JSON.stringify(
							cfg
								? { type: "config_command", sessionId: inbound.sessionId, token: session.token, ...cfg }
								: {
										type: "user_message",
										sessionId: inbound.sessionId,
										text: inbound.text,
										token: session.token,
										updateId: inbound.updateId,
										threadId: inbound.threadId,
									},
						),
					);
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

	async pollOnce(): Promise<number> {
		const body = (await this.botApi.call("getUpdates", {
			offset: this.offset,
			timeout: 25,
			allowed_updates: ["message", "callback_query"],
		})) as { result?: Array<{ update_id: number } & Record<string, unknown>> };
		for (const update of body.result ?? []) {
			this.offset = update.update_id + 1;
			await this.handleTelegramUpdate(update);
		}
		return body.result?.length ?? 0;
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
		this.startFlushTimer();
		try {
			await this.registerBotCommands();
			await this.loadAliases();
			await this.loadTopics();
			await this.scanRoots();
			let idleSince = (this.opts.now ?? Date.now)();
			while (this.running) {
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
				await this.scanRoots();
				if (this.sessions.size === 0) {
					if ((this.opts.now ?? Date.now)() - idleSince >= (this.opts.idleTimeoutMs ?? 60_000)) break;
				} else {
					idleSince = (this.opts.now ?? Date.now)();
					await this.pollOnce();
				}
				await new Promise(resolve => (this.opts.setTimeoutImpl ?? setTimeout)(resolve, 10));
			}
		} finally {
			this.stopFlushTimer();
			await releaseDaemonOwnership({
				settings: this.opts.settings,
				ownerId: this.opts.ownerId,
				fs: this.fsImpl,
				now: this.opts.now,
			});
		}
	}
}
