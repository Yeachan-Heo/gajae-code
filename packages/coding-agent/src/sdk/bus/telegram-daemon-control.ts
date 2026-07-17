/**
 * Telegram daemon controller + owner-scoped control-request helpers.
 *
 * Reload is a hybrid: an owner-scoped control-request file records auditable
 * intent, SIGTERM is the wakeup that aborts the in-flight long poll, and a
 * fresh daemon is spawned only after the old pid is dead / has exited. This
 * keeps the single-poller invariant (no Telegram getUpdates 409 overlap) and
 * never steals a still-live owner.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Settings } from "../../config/settings";
import type {
	BuiltInDaemonController,
	DaemonHealth,
	DaemonOperationOptions,
	DaemonOperationResult,
	DaemonRecovery,
	DaemonRuntimeInfo,
	DaemonStatus,
} from "../../daemon/control-types";
import { OWNERSHIP_MISMATCH_MESSAGE, ownershipMismatchRecovery } from "../../daemon/operator-contract";
import { resolveGjcRuntimeSpawnInfo } from "../../daemon/runtime";
import { getNotificationConfig, isTelegramConfigured, tokenFingerprint } from "./config";
import {
	daemonPaths,
	isFreshLiveOwner,
	readDaemonRoots,
	readDaemonState,
	spawnTelegramDaemonOwner,
	type TelegramDaemonDeps,
	type TelegramDaemonFs,
} from "./telegram-daemon";

const nodeFs: TelegramDaemonFs = fs.promises as unknown as TelegramDaemonFs;
const DEFAULT_GRACEFUL_TIMEOUT_MS = 8_000;
const DEFAULT_KILL_TIMEOUT_MS = 3_000;
const DEFAULT_WAIT_STEP_MS = 25;

export interface TelegramDaemonControlRequest {
	version: 1;
	requestId: string;
	action: "reload" | "stop";
	ownerId: string;
	pid: number;
	createdAt: number;
}

export function telegramControlRequestPath(agentDir: string): string {
	return path.join(daemonPaths(agentDir).dir, "telegram-daemon.control.json");
}

export async function readTelegramControlRequest(
	settings: Settings,
	fsImpl: TelegramDaemonFs = nodeFs,
): Promise<TelegramDaemonControlRequest | undefined> {
	const file = telegramControlRequestPath(settings.getAgentDir());
	try {
		const parsed = JSON.parse(await fsImpl.readFile(file, "utf8")) as TelegramDaemonControlRequest;
		return parsed?.version === 1 ? parsed : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return undefined;
	}
}

export async function writeTelegramControlRequest(
	settings: Settings,
	request: TelegramDaemonControlRequest,
	fsImpl: TelegramDaemonFs = nodeFs,
): Promise<void> {
	const dir = daemonPaths(settings.getAgentDir()).dir;
	await fsImpl.mkdir(dir, { recursive: true, mode: 0o700 });
	const file = telegramControlRequestPath(settings.getAgentDir());
	const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	await fsImpl.writeFile(tmp, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
	await fsImpl.chmod(tmp, 0o600).catch(() => undefined);
	await fsImpl.rename(tmp, file);
}

export async function clearTelegramControlRequest(
	settings: Settings,
	requestId?: string,
	fsImpl: TelegramDaemonFs = nodeFs,
): Promise<void> {
	const file = telegramControlRequestPath(settings.getAgentDir());
	if (requestId) {
		const current = await readTelegramControlRequest(settings, fsImpl);
		if (current && current.requestId !== requestId) return;
	}
	await fsImpl.unlink(file).catch(() => undefined);
}

export interface TelegramDaemonControlDeps {
	fs?: TelegramDaemonFs;
	now?: () => number;
	pidAlive?: (pid: number) => boolean;
	sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
	spawn?: TelegramDaemonDeps["spawn"];
	execPath?: string;
	/**
	 * Stable process id encoded into freshly-spawned daemon owner ids.
	 *
	 * The daemon-internal entrypoint rejects numeric owner ids whose process is
	 * already gone. `gjc daemon reload` is a short-lived CLI process, so using its
	 * own pid can race the child startup and make the replacement exit immediately.
	 */
	ownerPid?: number;
	randomId?: () => string;
	sleep?: (ms: number) => Promise<void>;
	waitStepMs?: number;
}

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function defaultSendSignal(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		// Best-effort: the process may already be gone.
	}
}

export class TelegramDaemonController implements BuiltInDaemonController {
	readonly kind = "telegram" as const;
	private readonly fsImpl: TelegramDaemonFs;
	private readonly now: () => number;
	private readonly pidAlive: (pid: number) => boolean;
	private readonly sendSignal: (pid: number, signal: NodeJS.Signals) => void;
	private readonly waitStepMs: number;

	constructor(
		private readonly settings: Settings,
		private readonly deps: TelegramDaemonControlDeps = {},
	) {
		this.fsImpl = deps.fs ?? nodeFs;
		this.now = deps.now ?? Date.now;
		this.pidAlive = deps.pidAlive ?? defaultPidAlive;
		this.sendSignal = deps.sendSignal ?? defaultSendSignal;
		this.waitStepMs = deps.waitStepMs ?? DEFAULT_WAIT_STEP_MS;
	}

	private runtimeInfo(): DaemonRuntimeInfo {
		const rt = resolveGjcRuntimeSpawnInfo(this.deps.execPath ?? process.execPath);
		return {
			mode: rt.mode,
			execPath: rt.execPath,
			reloadPicksUpSourceEdits: rt.reloadPicksUpSourceEdits,
			warning: rt.warning,
		};
	}

	async status(): Promise<DaemonStatus> {
		const runtime = this.runtimeInfo();
		const cfg = getNotificationConfig(this.settings);
		const configured = isTelegramConfigured(cfg);
		if (!configured) {
			return { kind: this.kind, configured: false, health: "not_configured", runtime };
		}
		const state = await readDaemonState(this.settings, this.fsImpl);
		const roots = await readDaemonRoots(this.settings, this.fsImpl);
		const live =
			state !== undefined &&
			isFreshLiveOwner({
				state,
				now: this.now(),
				tokenFingerprint: tokenFingerprint(cfg.botToken as string),
				chatId: cfg.chatId as string,
				pidAlive: this.pidAlive,
			});
		let health: DaemonHealth = "stopped";
		if (live) health = "running";
		else if (state && state.stoppedAt === undefined) health = "stale";
		return {
			kind: this.kind,
			configured: true,
			health,
			pid: state?.pid,
			ownerId: state?.ownerId,
			startedAt: state?.startedAt,
			heartbeatAt: state?.heartbeatAt,
			roots,
			rootCount: roots.length,
			runtime,
		};
	}

	private spawnDeps(): TelegramDaemonDeps {
		return {
			fs: this.deps.fs,
			now: this.deps.now,
			pidAlive: this.deps.pidAlive,
			pid: this.deps.ownerPid ?? process.ppid,
			spawn: this.deps.spawn,
			execPath: this.deps.execPath,
			randomId: this.deps.randomId,
		};
	}

	private sleep(ms: number): Promise<void> {
		if (this.deps.sleep) return this.deps.sleep(ms);
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	/**
	 * Wait until the captured pid is dead. Ownership-file movement is NOT treated
	 * as quiescence here: only actual process death proves the old poller stopped,
	 * which is what the no-409 invariant requires before spawning a fresh poller.
	 */
	private async waitForPidDeath(pid: number, timeoutMs: number): Promise<boolean> {
		if (!this.pidAlive(pid)) return true;
		const deadline = this.now() + timeoutMs;
		while (this.now() < deadline) {
			await this.sleep(this.waitStepMs);
			if (!this.pidAlive(pid)) return true;
		}
		return !this.pidAlive(pid);
	}

	private result(
		action: "stop" | "reload",
		ok: boolean,
		message: string,
		before: DaemonStatus | undefined,
		after: DaemonStatus | undefined,
		warnings: string[],
		recovery?: DaemonRecovery,
	): DaemonOperationResult {
		return { kind: this.kind, action, ok, before, after, message, warnings, recovery };
	}

	async reload(opts: DaemonOperationOptions = {}): Promise<DaemonOperationResult> {
		return this.stopOrReload("reload", opts);
	}

	async stop(opts: DaemonOperationOptions = {}): Promise<DaemonOperationResult> {
		return this.stopOrReload("stop", opts);
	}

	private async stopOrReload(action: "stop" | "reload", opts: DaemonOperationOptions): Promise<DaemonOperationResult> {
		const before = await this.status();
		const warnings: string[] = [];
		if (before.runtime.warning) warnings.push(before.runtime.warning);
		if (!before.configured) {
			return this.result(action, false, "telegram notifications are not configured", before, before, warnings);
		}
		const cfg = getNotificationConfig(this.settings);
		const fp = tokenFingerprint(cfg.botToken as string);
		const chatId = cfg.chatId as string;
		const roots = before.roots ?? (await readDaemonRoots(this.settings, this.fsImpl));
		const gracefulTimeoutMs = opts.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS;
		const killTimeoutMs = opts.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;

		// No running owner.
		if (before.health !== "running") {
			if (action === "stop") {
				return this.result(action, true, "no running telegram daemon", before, before, warnings);
			}
			const spawnIfStopped = opts.spawnIfStopped ?? true;
			if (!spawnIfStopped) {
				return this.result(action, true, "no running telegram daemon to reload", before, before, warnings);
			}
			const spawned = await spawnTelegramDaemonOwner(
				{ settings: this.settings, roots, tokenFingerprint: fp, chatId },
				this.spawnDeps(),
			);
			warnings.push(...spawned.warnings);
			const after = await this.status();
			if (spawned.result === "blocked") {
				return this.result(
					action,
					false,
					OWNERSHIP_MISMATCH_MESSAGE,
					before,
					after,
					warnings,
					ownershipMismatchRecovery(),
				);
			}
			return this.result(
				action,
				spawned.result === "owner_spawned",
				`spawned fresh telegram daemon (${spawned.result})`,
				before,
				after,
				warnings,
			);
		}

		// Running owner: capture identity, request cooperative stop, signal, wait.
		const oldOwnerId = before.ownerId as string;
		const oldPid = before.pid as number;
		const requestId = this.deps.randomId?.() ?? `${this.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
		await writeTelegramControlRequest(
			this.settings,
			{ version: 1, requestId, action, ownerId: oldOwnerId, pid: oldPid, createdAt: this.now() },
			this.fsImpl,
		);
		if (this.pidAlive(oldPid)) this.sendSignal(oldPid, "SIGTERM");

		let dead = await this.waitForPidDeath(oldPid, gracefulTimeoutMs);
		if (!dead) {
			// Old pid still alive after the cooperative SIGTERM. Inspect current ownership.
			const current = await readDaemonState(this.settings, this.fsImpl);
			const changedToLiveOwner =
				current !== undefined &&
				current.ownerId !== oldOwnerId &&
				isFreshLiveOwner({
					state: current,
					now: this.now(),
					tokenFingerprint: fp,
					chatId,
					pidAlive: this.pidAlive,
				});
			if (changedToLiveOwner) {
				// A different, fresh-live owner already supersedes the old one. Do not
				// kill it or spawn another; attach to the running daemon.
				await this.clearOwnRequest(requestId, oldOwnerId);
				const after = await this.status();
				warnings.push("ownership changed to a live owner; attached without spawning");
				return this.result(
					action,
					true,
					action === "reload"
						? "a live owner already exists; attached instead of reloading"
						: "another live owner already exists",
					before,
					after,
					warnings,
				);
			}
			// No live replacement. Escalate to SIGKILL only with --force and only when
			// the captured owner/pid still matches, so we never kill a different owner.
			const stillSameOwner = current !== undefined && current.ownerId === oldOwnerId && current.pid === oldPid;
			if (opts.force && stillSameOwner && this.pidAlive(oldPid)) {
				this.sendSignal(oldPid, "SIGKILL");
				dead = await this.waitForPidDeath(oldPid, killTimeoutMs);
			}
			if (!dead) {
				await this.clearOwnRequest(requestId, oldOwnerId);
				const after = await this.status();
				const message = opts.force
					? "old daemon did not exit after SIGKILL; refusing to spawn to avoid a Telegram 409 conflict"
					: "old daemon did not exit within the graceful timeout; rerun with --force to hard-kill";
				return this.result(action, false, message, before, after, warnings);
			}
		}

		// Old pid is dead: safe to clear our request and proceed.
		await this.clearOwnRequest(requestId, oldOwnerId);

		if (action === "stop") {
			const after = await this.status();
			return this.result(action, true, "stopped telegram daemon", before, after, warnings);
		}

		const spawned = await spawnTelegramDaemonOwner(
			{ settings: this.settings, roots, tokenFingerprint: fp, chatId },
			this.spawnDeps(),
		);
		warnings.push(...spawned.warnings);
		const after = await this.status();
		if (spawned.result === "attached") {
			// A live owner already exists; attaching to it is a valid running end-state.
			warnings.push("a live owner already exists; attached instead of spawning");
		} else if (after.ownerId && after.ownerId === oldOwnerId) {
			warnings.push("owner id unchanged after reload");
		}
		if (spawned.result === "blocked") {
			return this.result(
				action,
				false,
				OWNERSHIP_MISMATCH_MESSAGE,
				before,
				after,
				warnings,
				ownershipMismatchRecovery(),
			);
		}
		return this.result(
			action,
			spawned.result !== "disabled",
			`reloaded telegram daemon (${spawned.result})`,
			before,
			after,
			warnings,
		);
	}

	/** Clear our own control request unless a newer owner-scoped request replaced it. */
	private async clearOwnRequest(requestId: string, oldOwnerId: string): Promise<void> {
		const current = await readTelegramControlRequest(this.settings, this.fsImpl);
		if (!current) return;
		if (current.requestId === requestId || current.ownerId === oldOwnerId) {
			await clearTelegramControlRequest(this.settings, current.requestId, this.fsImpl);
		}
	}
}
