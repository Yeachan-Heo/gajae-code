import { spawn as childProcessSpawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Settings } from "../../config/settings";
import type {
	BuiltInDaemonController,
	DaemonHealth,
	DaemonOperationOptions,
	DaemonOperationResult,
	DaemonRuntimeInfo,
	DaemonStatus,
} from "../../daemon/control-types";
import { resolveGjcRuntimeSpawnInfo } from "../../daemon/runtime";
import { isProcessIncarnation, processIncarnation } from "../broker/process-incarnation";
import { getNotificationConfig, isDiscordConfigured, isSlackConfigured } from "./config";

export type ChatDaemonKind = "discord" | "slack";
export type ChatDaemonAction = "stop" | "reload";

export interface ChatDaemonState {
	version: 1;
	kind: ChatDaemonKind;
	pid: number;
	ownerId: string;
	identity: string;
	incarnation: string;
	startedAt: number;
	heartbeatAt: number;
	transportHealthy: boolean;
	stoppedAt?: number;
}

export interface ChatDaemonControlRequest {
	version: 1;
	requestId: string;
	action: ChatDaemonAction;
	ownerId: string;
	pid: number;
	createdAt: number;
	incarnation: string;
}

export interface ChatDaemonControlDeps {
	pidAlive?: (pid: number) => boolean;
	sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
	spawn?: (command: string, args: string[], opts: { detached: boolean; stdio: "ignore" }) => { unref?: () => void };
	execPath?: string;
	ownerPid?: number;
	randomId?: () => string;
	pidIncarnation?: (pid: number) => string | undefined;
	sleep?: (ms: number) => Promise<void>;
}

const HEARTBEAT_TTL_MS = 20_000;
const DEFAULT_GRACEFUL_TIMEOUT_MS = 8_000;
const DEFAULT_KILL_TIMEOUT_MS = 3_000;
const UNPUBLISHED_OWNER_LOCK_STALE_MS = HEARTBEAT_TTL_MS;

interface ChatDaemonOwnerLock {
	pid: number;
	incarnation: string;
	createdAt: number;
}

interface ChatDaemonOwnershipProbe {
	pidAlive(pid: number): boolean;
	pidIncarnation(pid: number): string | undefined;
}

export function chatDaemonPaths(
	agentDir: string,
	kind: ChatDaemonKind,
): { dir: string; lock: string; state: string; control: string } {
	const dir = path.join(agentDir, "sdk", "daemons", kind);
	return {
		dir,
		lock: path.join(dir, "owner.lock"),
		state: path.join(dir, "state.json"),
		control: path.join(dir, "control.json"),
	};
}

function identityFor(settings: Settings, kind: ChatDaemonKind): string | undefined {
	const cfg = getNotificationConfig(settings);
	if (kind === "discord") {
		if (!isDiscordConfigured(cfg)) return undefined;
		return fingerprint([
			cfg.discord.botToken,
			cfg.discord.applicationId,
			cfg.discord.guildId,
			cfg.discord.parentChannelId,
			String(cfg.redact),
			cfg.verbosity,
		]);
	}
	if (!isSlackConfigured(cfg)) return undefined;
	return fingerprint([
		cfg.slack.botToken,
		cfg.slack.appToken,
		cfg.slack.workspaceId,
		cfg.slack.channelId,
		cfg.slack.authorizedUserId ?? "",
		String(cfg.redact),
		cfg.verbosity,
	]);
}

function fingerprint(values: string[]): string {
	return crypto.createHash("sha256").update(values.join("\0")).digest("hex").slice(0, 16);
}
function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
function defaultSignal(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {}
}

function runtimeInfo(execPath?: string): DaemonRuntimeInfo {
	const rt = resolveGjcRuntimeSpawnInfo(execPath ?? process.execPath);
	return {
		mode: rt.mode,
		execPath: rt.execPath,
		reloadPicksUpSourceEdits: rt.reloadPicksUpSourceEdits,
		warning: rt.warning,
	};
}

const stateWriteTails = new Map<string, Promise<void>>();

async function withStateWriteLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
	const previous = stateWriteTails.get(file) ?? Promise.resolve();
	const gate = Promise.withResolvers<void>();
	const tail = previous.then(() => gate.promise);
	stateWriteTails.set(file, tail);
	await previous;
	try {
		return await operation();
	} finally {
		gate.resolve();
		if (stateWriteTails.get(file) === tail) stateWriteTails.delete(file);
	}
}

async function readJson<T>(file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await fs.promises.readFile(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}
async function writeJson(file: string, value: unknown): Promise<void> {
	await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.promises.writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
		await fs.promises.rename(tmp, file);
	} catch (error) {
		await fs.promises.unlink(tmp).catch(() => undefined);
		throw error;
	}
}

export async function readChatDaemonState(
	agentDir: string,
	kind: ChatDaemonKind,
): Promise<ChatDaemonState | undefined> {
	return await readJson(chatDaemonPaths(agentDir, kind).state);
}
export async function readChatDaemonControlRequest(
	agentDir: string,
	kind: ChatDaemonKind,
): Promise<ChatDaemonControlRequest | undefined> {
	return await readJson(chatDaemonPaths(agentDir, kind).control);
}
export async function writeChatDaemonControlRequest(
	agentDir: string,
	kind: ChatDaemonKind,
	request: ChatDaemonControlRequest,
): Promise<void> {
	await writeJson(chatDaemonPaths(agentDir, kind).control, request);
}
export async function clearChatDaemonControlRequest(
	agentDir: string,
	kind: ChatDaemonKind,
	requestId?: string,
): Promise<void> {
	const paths = chatDaemonPaths(agentDir, kind);
	if (requestId && (await readChatDaemonControlRequest(agentDir, kind))?.requestId !== requestId) return;
	await fs.promises.unlink(paths.control).catch(() => undefined);
}

export function buildChatDaemonSpawnArgs(input: {
	kind: ChatDaemonKind;
	ownerId: string;
	agentDir: string;
	execPath?: string;
}): { command: string; args: string[]; runtime: DaemonRuntimeInfo } {
	const rt = resolveGjcRuntimeSpawnInfo(input.execPath ?? process.execPath);
	return {
		command: rt.execPath,
		args: [
			...rt.argsPrefix,
			"daemon",
			`${input.kind}-internal`,
			"--owner-id",
			input.ownerId,
			"--agent-dir",
			input.agentDir,
		],
		runtime: runtimeInfo(input.execPath),
	};
}

export class ChatDaemonController implements BuiltInDaemonController {
	readonly kind: ChatDaemonKind;
	constructor(
		private readonly settings: Settings,
		kind: ChatDaemonKind,
		private readonly deps: ChatDaemonControlDeps = {},
	) {
		this.kind = kind;
	}
	private identity(): string | undefined {
		return identityFor(this.settings, this.kind);
	}
	private alive(pid: number): boolean {
		return (this.deps.pidAlive ?? defaultPidAlive)(pid);
	}
	async status(): Promise<DaemonStatus> {
		const runtime = runtimeInfo(this.deps.execPath);
		const identity = this.identity();
		if (!identity) return { kind: this.kind, configured: false, health: "not_configured", runtime };
		const state = await readChatDaemonState(this.settings.getAgentDir(), this.kind);
		const live = Boolean(
			state &&
				state.version === 1 &&
				state.kind === this.kind &&
				state.identity === identity &&
				!state.stoppedAt &&
				state.transportHealthy &&
				Date.now() - state.heartbeatAt <= HEARTBEAT_TTL_MS &&
				this.alive(state.pid) &&
				this.incarnation(state.pid) === state.incarnation,
		);
		const health: DaemonHealth = live ? "running" : state && !state.stoppedAt ? "stale" : "stopped";
		return {
			kind: this.kind,
			configured: true,
			health,
			pid: state?.pid,
			ownerId: state?.ownerId,
			startedAt: state?.startedAt,
			heartbeatAt: state?.heartbeatAt,
			runtime,
		};
	}
	async stop(opts: DaemonOperationOptions = {}): Promise<DaemonOperationResult> {
		return await this.operate("stop", opts);
	}
	async reload(opts: DaemonOperationOptions = {}): Promise<DaemonOperationResult> {
		return await this.operate("reload", opts);
	}
	async ensure(): Promise<EnsureChatDaemonResult> {
		const identity = this.identity();
		if (!identity) return "disabled";
		const existing = await readChatDaemonState(this.settings.getAgentDir(), this.kind);
		if (existing && this.isLiveState(existing)) {
			if (existing.identity === identity) return "attached";
			await this.stopForReplacement(existing);
		}
		const spawned = await this.spawn();
		if (spawned) return "owner_spawned";
		const replacement = await readChatDaemonState(this.settings.getAgentDir(), this.kind);
		if (replacement && replacement.identity === identity && this.isLiveState(replacement)) return "attached";
		throw new Error(`Unable to attach or spawn ${this.kind} daemon owner`);
	}

	private async operate(action: ChatDaemonAction, opts: DaemonOperationOptions): Promise<DaemonOperationResult> {
		const before = await this.status();
		const warnings = before.runtime.warning ? [before.runtime.warning] : [];
		if (!before.configured)
			return this.result(action, false, `${this.kind} notifications are not configured`, before, before, warnings);
		if (before.health !== "running") {
			if (action === "stop")
				return this.result(action, true, `no running ${this.kind} daemon`, before, before, warnings);
			if (opts.spawnIfStopped === false)
				return this.result(action, true, `no running ${this.kind} daemon to reload`, before, before, warnings);
			const spawned = await this.spawn();
			const after = await this.status();
			return this.result(
				action,
				spawned,
				spawned ? `spawned fresh ${this.kind} daemon` : `a live ${this.kind} owner already exists`,
				before,
				after,
				warnings,
			);
		}
		const state = await readChatDaemonState(this.settings.getAgentDir(), this.kind);
		if (!state || !this.ownsCapturedState(state, before))
			return this.result(
				action,
				false,
				`${this.kind} daemon ownership changed; refusing to signal`,
				before,
				await this.status(),
				warnings,
			);
		const requestId = this.deps.randomId?.() ?? crypto.randomUUID();
		await writeChatDaemonControlRequest(this.settings.getAgentDir(), this.kind, {
			version: 1,
			requestId,
			action,
			ownerId: state.ownerId,
			pid: state.pid,
			incarnation: state.incarnation,
			createdAt: Date.now(),
		});
		if (!(await this.signalIfOwner(state, "SIGTERM"))) return this.ownerChanged(action, requestId, before, warnings);
		let dead = await this.waitForDeath(state.pid, opts.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS);
		if (!dead && opts.force) {
			if (!(await this.signalIfOwner(state, "SIGKILL")))
				return this.ownerChanged(action, requestId, before, warnings);
			dead = await this.waitForDeath(state.pid, opts.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS);
		}
		if (!dead) {
			await clearChatDaemonControlRequest(this.settings.getAgentDir(), this.kind, requestId);
			const after = await this.status();
			return this.result(
				action,
				false,
				opts.force ? "old daemon did not exit after SIGKILL" : "old daemon did not exit; rerun with --force",
				before,
				after,
				warnings,
			);
		}
		await clearChatDaemonControlRequest(this.settings.getAgentDir(), this.kind, requestId);
		if (action === "stop")
			return this.result(action, true, `stopped ${this.kind} daemon`, before, await this.status(), warnings);
		const spawned = await this.spawn();
		return this.result(
			action,
			spawned,
			spawned ? `reloaded ${this.kind} daemon` : `a live ${this.kind} owner already exists`,
			before,
			await this.status(),
			warnings,
		);
	}
	private incarnation(pid: number): string | undefined {
		return (this.deps.pidIncarnation ?? processIncarnation)(pid);
	}
	private isLiveState(state: ChatDaemonState): boolean {
		return (
			state.version === 1 &&
			state.kind === this.kind &&
			!state.stoppedAt &&
			state.transportHealthy &&
			Date.now() - state.heartbeatAt <= HEARTBEAT_TTL_MS &&
			this.alive(state.pid) &&
			Boolean(state.incarnation) &&
			this.incarnation(state.pid) === state.incarnation
		);
	}
	private async stopForReplacement(state: ChatDaemonState): Promise<void> {
		if (!this.isLiveState(state)) return;
		const requestId = this.deps.randomId?.() ?? crypto.randomUUID();
		await writeChatDaemonControlRequest(this.settings.getAgentDir(), this.kind, {
			version: 1,
			requestId,
			action: "reload",
			ownerId: state.ownerId,
			pid: state.pid,
			incarnation: state.incarnation,
			createdAt: Date.now(),
		});
		try {
			if (!(await this.signalIfOwner(state, "SIGTERM")))
				throw new Error(`${this.kind} daemon ownership changed; refusing replacement`);
			let dead = await this.waitForDeath(state.pid, DEFAULT_GRACEFUL_TIMEOUT_MS);
			if (!dead) {
				if (!(await this.signalIfOwner(state, "SIGKILL")))
					throw new Error(`${this.kind} daemon ownership changed; refusing replacement`);
				dead = await this.waitForDeath(state.pid, DEFAULT_KILL_TIMEOUT_MS);
			}
			if (!dead) throw new Error(`Old ${this.kind} daemon did not exit before replacement`);
		} finally {
			await clearChatDaemonControlRequest(this.settings.getAgentDir(), this.kind, requestId);
		}
	}

	private ownsCapturedState(state: ChatDaemonState, before: DaemonStatus): boolean {
		return (
			state.ownerId === before.ownerId &&
			state.pid === before.pid &&
			Boolean(state.incarnation) &&
			this.incarnation(state.pid) === state.incarnation
		);
	}
	private async signalIfOwner(state: ChatDaemonState, signal: NodeJS.Signals): Promise<boolean> {
		const current = await readChatDaemonState(this.settings.getAgentDir(), this.kind);
		if (
			!current ||
			current.ownerId !== state.ownerId ||
			current.pid !== state.pid ||
			current.incarnation !== state.incarnation ||
			this.incarnation(state.pid) !== state.incarnation
		)
			return false;
		(this.deps.sendSignal ?? defaultSignal)(state.pid, signal);
		return true;
	}
	private async ownerChanged(
		action: ChatDaemonAction,
		requestId: string,
		before: DaemonStatus,
		warnings: string[],
	): Promise<DaemonOperationResult> {
		await clearChatDaemonControlRequest(this.settings.getAgentDir(), this.kind, requestId);
		return this.result(
			action,
			false,
			`${this.kind} daemon ownership changed; refusing to signal`,
			before,
			await this.status(),
			warnings,
		);
	}
	private result(
		action: ChatDaemonAction,
		ok: boolean,
		message: string,
		before: DaemonStatus,
		after: DaemonStatus,
		warnings: string[],
	): DaemonOperationResult {
		return { kind: this.kind, action, ok, message, before, after, warnings };
	}
	private async waitForDeath(pid: number, timeout: number): Promise<boolean> {
		const until = Date.now() + timeout;
		while (this.alive(pid) && Date.now() < until) await this.sleep(25);
		return !this.alive(pid);
	}
	private sleep(ms: number): Promise<void> {
		return this.deps.sleep ? this.deps.sleep(ms) : new Promise(resolve => setTimeout(resolve, ms));
	}
	private async spawn(): Promise<boolean> {
		const identity = this.identity();
		if (!identity) return false;
		const paths = chatDaemonPaths(this.settings.getAgentDir(), this.kind);
		await fs.promises.mkdir(paths.dir, { recursive: true, mode: 0o700 });
		const existing = await readChatDaemonState(this.settings.getAgentDir(), this.kind);
		if (
			existing &&
			!existing.stoppedAt &&
			existing.identity === identity &&
			Date.now() - existing.heartbeatAt <= HEARTBEAT_TTL_MS &&
			this.alive(existing.pid) &&
			this.incarnation(existing.pid) === existing.incarnation
		)
			return false;
		const ownerId = `${this.deps.ownerPid ?? process.ppid}-${this.deps.randomId?.() ?? crypto.randomUUID()}`;
		const { command, args } = buildChatDaemonSpawnArgs({
			kind: this.kind,
			ownerId,
			agentDir: this.settings.getAgentDir(),
			execPath: this.deps.execPath,
		});
		(this.deps.spawn ?? ((command, args, opts) => childProcessSpawn(command, args, opts)))(command, args, {
			detached: true,
			stdio: "ignore",
		}).unref?.();
		return true;
	}
}

export type EnsureChatDaemonResult = "disabled" | "owner_spawned" | "attached";

async function ensureChatDaemon(
	kind: ChatDaemonKind,
	settings: Settings,
	deps: ChatDaemonControlDeps = {},
): Promise<EnsureChatDaemonResult> {
	return await new ChatDaemonController(settings, kind, deps).ensure();
}

export async function ensureDiscordDaemon(
	settings: Settings,
	deps: ChatDaemonControlDeps = {},
): Promise<EnsureChatDaemonResult> {
	return await ensureChatDaemon("discord", settings, deps);
}

export async function ensureSlackDaemon(
	settings: Settings,
	deps: ChatDaemonControlDeps = {},
): Promise<EnsureChatDaemonResult> {
	return await ensureChatDaemon("slack", settings, deps);
}

export async function acquireChatDaemonOwnership(input: {
	agentDir: string;
	kind: ChatDaemonKind;
	ownerId: string;
	pid?: number;
	identity: string;
	incarnation?: string;
	pidAlive?: (pid: number) => boolean;
	pidIncarnation?: (pid: number) => string | undefined;
}): Promise<boolean> {
	const paths = chatDaemonPaths(input.agentDir, input.kind);
	const pid = input.pid ?? process.pid;
	const probe: ChatDaemonOwnershipProbe = {
		pidAlive: input.pidAlive ?? defaultPidAlive,
		pidIncarnation: input.pidIncarnation ?? processIncarnation,
	};
	const incarnation = input.incarnation ?? probe.pidIncarnation(pid) ?? "unavailable";
	await fs.promises.mkdir(paths.dir, { recursive: true, mode: 0o700 });
	if (!(await createChatDaemonOwnerLock(paths.lock, { pid, incarnation, createdAt: Date.now() }))) {
		if (!(await reclaimChatDaemonOwnerLock(paths.lock, paths.state, probe))) return false;
		if (!(await createChatDaemonOwnerLock(paths.lock, { pid, incarnation, createdAt: Date.now() }))) return false;
	}

	await withStateWriteLock(
		paths.state,
		async () =>
			await writeJson(paths.state, {
				version: 1,
				kind: input.kind,
				pid,
				ownerId: input.ownerId,
				identity: input.identity,
				incarnation,
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: false,
			} satisfies ChatDaemonState),
	);
	return true;
}

async function createChatDaemonOwnerLock(lock: string, owner: ChatDaemonOwnerLock): Promise<boolean> {
	try {
		const handle = await fs.promises.open(lock, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		return true;
	} catch (error) {
		if (isAlreadyExists(error)) return false;
		throw error;
	}
}

async function reclaimChatDaemonOwnerLock(
	lock: string,
	stateFile: string,
	probe: ChatDaemonOwnershipProbe,
): Promise<boolean> {
	if (!(await canReclaimChatDaemonOwnerLock(lock, stateFile, probe))) return false;

	const reclaimFile = `${lock}.reclaim`;
	const reclaimLock = await acquireChatDaemonReclaimLock(reclaimFile, probe);

	if (!reclaimLock) return false;
	try {
		if (!(await canReclaimChatDaemonOwnerLock(lock, stateFile, probe))) return false;

		await fs.promises.unlink(lock).catch(() => undefined);
		return true;
	} finally {
		await reclaimLock.close().catch(() => undefined);
		await fs.promises.unlink(reclaimFile).catch(() => undefined);
	}
}

async function acquireChatDaemonReclaimLock(
	reclaimFile: string,
	probe: ChatDaemonOwnershipProbe,
): Promise<{ close(): Promise<void> } | undefined> {
	const owner: ChatDaemonOwnerLock = {
		pid: process.pid,
		incarnation: probe.pidIncarnation(process.pid) ?? "unavailable",
		createdAt: Date.now(),
	};
	if (await createChatDaemonOwnerLock(reclaimFile, owner)) return await fs.promises.open(reclaimFile, "r+");
	if (!(await isStaleChatDaemonLock(reclaimFile, probe))) return undefined;
	await fs.promises.unlink(reclaimFile).catch(() => undefined);
	if (!(await createChatDaemonOwnerLock(reclaimFile, owner))) return undefined;
	return await fs.promises.open(reclaimFile, "r+");
}

async function isStaleChatDaemonLock(lock: string, probe: ChatDaemonOwnershipProbe): Promise<boolean> {
	let owner: unknown;
	try {
		owner = JSON.parse(await fs.promises.readFile(lock, "utf8"));
	} catch {}
	if (isChatDaemonOwnerLock(owner)) {
		const currentIncarnation = probe.pidIncarnation(owner.pid);
		return (
			!probe.pidAlive(owner.pid) ||
			(owner.incarnation !== "unavailable" &&
				(!isProcessIncarnation(owner.incarnation) ||
					(currentIncarnation !== undefined && currentIncarnation !== owner.incarnation)))
		);
	}
	const stat = await fs.promises.stat(lock).catch(() => undefined);
	return Boolean(stat && Date.now() - stat.mtimeMs >= UNPUBLISHED_OWNER_LOCK_STALE_MS);
}

async function canReclaimChatDaemonOwnerLock(
	lock: string,
	stateFile: string,
	probe: ChatDaemonOwnershipProbe,
): Promise<boolean> {
	const state = await readJson<ChatDaemonState>(stateFile);
	if (state && probe.pidAlive(state.pid) && probe.pidIncarnation(state.pid) === state.incarnation) return false;
	return await isStaleChatDaemonLock(lock, probe);
}

function isChatDaemonOwnerLock(value: unknown): value is ChatDaemonOwnerLock {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as ChatDaemonOwnerLock).pid === "number" &&
		Number.isSafeInteger((value as ChatDaemonOwnerLock).pid) &&
		(value as ChatDaemonOwnerLock).pid > 0 &&
		typeof (value as ChatDaemonOwnerLock).incarnation === "string" &&
		typeof (value as ChatDaemonOwnerLock).createdAt === "number"
	);
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST";
}
export async function renewChatDaemonHeartbeat(input: {
	agentDir: string;
	kind: ChatDaemonKind;
	ownerId: string;
	pid?: number;
	incarnation?: string;
	transportHealthy: boolean;
}): Promise<boolean> {
	const paths = chatDaemonPaths(input.agentDir, input.kind);
	return await withStateWriteLock(paths.state, async () => {
		const state = await readJson<ChatDaemonState>(paths.state);
		const pid = input.pid ?? state?.pid;
		if (
			!state ||
			state.ownerId !== input.ownerId ||
			pid !== state.pid ||
			!input.incarnation ||
			state.incarnation !== input.incarnation
		)
			return false;
		await writeJson(paths.state, { ...state, heartbeatAt: Date.now(), transportHealthy: input.transportHealthy });
		return true;
	});
}
export async function releaseChatDaemonOwnership(input: {
	agentDir: string;
	kind: ChatDaemonKind;
	ownerId: string;
	pid?: number;
	incarnation?: string;
}): Promise<void> {
	const paths = chatDaemonPaths(input.agentDir, input.kind);
	await withStateWriteLock(paths.state, async () => {
		const state = await readJson<ChatDaemonState>(paths.state);
		if (
			state?.ownerId !== input.ownerId ||
			(input.pid !== undefined && state.pid !== input.pid) ||
			(input.incarnation !== undefined && state.incarnation !== input.incarnation)
		)
			return;
		await writeJson(paths.state, { ...state, stoppedAt: Date.now(), transportHealthy: false });
		const lock = await readJson<ChatDaemonOwnerLock>(paths.lock);
		if (lock?.pid === state.pid && lock.incarnation === state.incarnation)
			await fs.promises.unlink(paths.lock).catch(() => undefined);
	});
}
