import { spawn as childProcessSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { withFileLock } from "../config/file-lock";
import type { Settings } from "../config/settings";
import { getNotificationConfig, isGloballyConfigured, tokenFingerprint } from "./config";
import {
	type AliasTable,
	buildActionMessage,
	type CallbackRoute,
	createAliasTable,
	type PendingAsk,
	readEndpoint,
	routeInboundUpdate,
} from "./telegram-reference";

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
	spawn?: (command: string, args: string[], opts: { detached: boolean; stdio: "ignore" }) => SpawnResult;
	execPath?: string;
	randomId?: () => string;
}

export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_TTL_MS = 20_000;
export const DAEMON_VERSION = 1;

const nodeFs: TelegramDaemonFs = fs.promises as unknown as TelegramDaemonFs;

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
	opts: { detached: boolean; stdio: "ignore" },
): SpawnResult {
	const child = childProcessSpawn(command, args, { detached: opts.detached, stdio: opts.stdio });
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
	const child = spawnImpl(execPath, args, { detached: true, stdio: "ignore" });
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

	constructor(private readonly opts: TelegramDaemonOptions) {
		this.fsImpl = opts.fs ?? nodeFs;
		this.aliasTable = createAliasTable();
		this.botApi = opts.botApi ?? {
			call: async (method, body) => {
				const res = await (opts.fetchImpl ?? fetch)(
					`${opts.apiBase ?? "https://api.telegram.org"}/bot${opts.botToken}/${method}`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					},
				);
				return res.json();
			},
		};
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
			void this.handleSessionMessage(session, JSON.parse(String(ev.data)));
		});
		ws.addEventListener("close", () => {
			this.sessions.delete(sessionId);
		});
	}

	async handleSessionMessage(session: SessionSocket, msg: any): Promise<void> {
		if (msg.type === "action_needed" && msg.id) {
			if (msg.kind === "ask") session.pending.set(msg.id, { sessionId: session.sessionId, actionId: msg.id });
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
					{
						command: "answer",
						description: "Reply to a pending question: /answer <sessionId> [actionId] <reply>",
					},
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
		await this.registerBotCommands();
		await this.loadAliases();
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
		await releaseDaemonOwnership({
			settings: this.opts.settings,
			ownerId: this.opts.ownerId,
			fs: this.fsImpl,
			now: this.opts.now,
		});
	}
}
