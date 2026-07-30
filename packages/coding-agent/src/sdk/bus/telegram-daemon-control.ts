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
import * as os from "node:os";
import * as path from "node:path";
import { Process } from "@gajae-code/natives";
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
import { isProcessIncarnation } from "../broker/process-incarnation";

import { getNotificationConfig, isTelegramComplete, tokenFingerprint } from "./config";
import { exactUnlinkNotificationFile, readNotificationEndpointFile } from "./notification-service";
import {
	type AttestedLegacyDaemonOwner,
	confirmTelegramDaemonSpawn,
	type DaemonState,
	daemonPaths,
	hasSafeDaemonStateShape,
	isCurrentCompatibleOwner,
	isFreshLiveOwner,
	isSignalableMatchingOwner,
	readAttestedLegacyDaemonOwner,
	readDaemonRoots,
	readDaemonState,
	readOwnerFreshnessSnapshot,
	spawnTelegramDaemonOwner,
	type TelegramDaemonDeps,
	type TelegramDaemonFs,
	type TelegramSpawnOwnerResult,
} from "./telegram-daemon";

const nodeFs: TelegramDaemonFs = {
	...(fs.promises as unknown as TelegramDaemonFs),
	readEndpointFile: readNotificationEndpointFile,
	exactUnlink: async (file, identity) =>
		exactUnlinkNotificationFile(file, identity, `.gjc-delete-daemon-transition-${crypto.randomUUID()}.json`),
};
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

export interface DaemonProcessReference {
	incarnation: string;
	/** Whether the platform delivers the requested signal cooperatively or as a hard termination. */
	termination: "cooperative" | "hard";
	signalRoot(signal: NodeJS.Signals): void;
}

export function defaultProcessReference(pid: number, platform = os.platform()): DaemonProcessReference | undefined {
	try {
		const processRef = Process.fromPid(pid);
		if (!processRef || !isProcessIncarnation(processRef.incarnation)) return undefined;
		const incarnation = processRef.incarnation;
		return {
			incarnation,
			termination: platform === "win32" ? "hard" : "cooperative",
			signalRoot: signal => {
				const nativeSignal = os.constants.signals[signal];
				if (nativeSignal === undefined) throw new Error(`Unsupported signal: ${signal}`);
				// macOS exposes no pidfd and the native signal_root is a no-op there, so
				// the daemon control plane previously had NO way to signal a live owner —
				// every stop/reload of a live/hung daemon refused ("ownership changed;
				// refusing to signal"), and only an external `kill -9` could recover it.
				// Signal by numeric PID via kill(2), but re-read the immutable start-time
				// incarnation immediately beforehand so a PID that exited and was reused
				// since capture is never signaled; the residual window is the few
				// instructions between this recheck and kill(2).
				if (platform === "darwin") {
					const current = Process.fromPid(pid) as { incarnation?: unknown } | null;
					if (!current || current.incarnation !== incarnation) throw new Error("Pinned process is already gone");
					process.kill(pid, signal);
					return;
				}
				const rootProcess = processRef as typeof processRef & { signalRoot(signal: number): boolean };
				if (!rootProcess.signalRoot(nativeSignal)) throw new Error("Pinned process is already gone");
			},
		};
	} catch {
		return undefined;
	}
}

export interface TelegramDaemonControlDeps {
	fs?: TelegramDaemonFs;
	now?: () => number;
	pidAlive?: (pid: number) => boolean;
	processReference?: (pid: number) => DaemonProcessReference | undefined;
	pidIncarnation?: (pid: number) => string | undefined;
	/** Test seam for platform-specific default stable-process authority. */
	platform?: NodeJS.Platform;
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
	/** Bounded startup-readiness timeout; injectable for deterministic controller tests. */
	readinessTimeoutMs?: number;
}

export type TelegramGenerationReloadResult =
	| { outcome: "ready"; operation: DaemonOperationResult }
	| { outcome: "failed"; operation: DaemonOperationResult };

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

export class TelegramDaemonController implements BuiltInDaemonController {
	readonly kind = "telegram" as const;
	private readonly fsImpl: TelegramDaemonFs;
	private readonly pidAlive: (pid: number) => boolean;
	private readonly now: () => number;
	private readonly processReference: (pid: number) => DaemonProcessReference | undefined;
	private readonly waitStepMs: number;
	constructor(
		private readonly settings: Settings,
		private readonly deps: TelegramDaemonControlDeps = {},
	) {
		this.fsImpl = deps.fs ?? nodeFs;
		this.now = deps.now ?? Date.now;
		this.pidAlive = deps.pidAlive ?? defaultPidAlive;
		this.processReference = deps.processReference ?? (pid => defaultProcessReference(pid, deps.platform));
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
		const configured = isTelegramComplete(cfg);
		if (!configured) {
			return { kind: this.kind, configured: false, health: "not_configured", runtime };
		}
		const snapshot = await readOwnerFreshnessSnapshot({ settings: this.settings, fs: this.fsImpl });
		const state = snapshot.state;
		const roots = await readDaemonRoots(this.settings, this.fsImpl);
		const health: DaemonHealth =
			!state || state.stoppedAt !== undefined || !this.pidAlive(state.pid)
				? "stopped"
				: isCurrentCompatibleOwner({
							state,
							now: this.now(),
							tokenFingerprint: tokenFingerprint(cfg.botToken as string),
							chatId: cfg.chatId as string,
							pidAlive: this.pidAlive,
							pidIncarnation: this.deps.pidIncarnation,
							effectiveHeartbeatAt: snapshot.effectiveHeartbeatAt,
						})
					? "running"
					: "stale";
		return {
			kind: this.kind,
			configured: true,
			health,
			pid: state?.pid,
			ownerId: state?.ownerId,
			startedAt: state?.startedAt,
			heartbeatAt: snapshot.effectiveHeartbeatAt,
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
			pidIncarnation: this.deps.pidIncarnation,
			pid: this.deps.ownerPid ?? process.ppid,
			spawn: this.deps.spawn,
			execPath: this.deps.execPath,
			randomId: this.deps.randomId,
		};
	}

	private async spawnAndWait(
		roots: string[],
		token: string,
		chatId: string,
	): Promise<{ spawned: TelegramSpawnOwnerResult; ready: boolean }> {
		const spawned = await spawnTelegramDaemonOwner(
			{ settings: this.settings, roots, tokenFingerprint: token, chatId },
			this.spawnDeps(),
		);
		const ready = await confirmTelegramDaemonSpawn({
			settings: this.settings,
			spawned,
			tokenFingerprint: token,
			chatId,
			pid: this.deps.ownerPid ?? process.ppid,
			fs: this.fsImpl,
			now: this.now,
			pidAlive: this.pidAlive,
			pidIncarnation: this.deps.pidIncarnation,
			sleep: this.deps.sleep,
			waitStepMs: this.waitStepMs,
			timeoutMs: this.deps.readinessTimeoutMs,
		});
		return { spawned, ready };
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
		const timeout = Math.max(timeoutMs, 0);
		const waitStepMs = Math.max(this.waitStepMs, 1);
		const deadline = this.now() + timeout;
		const maxPolls = Math.ceil(timeout / waitStepMs);
		for (let poll = 0; poll < maxPolls && this.now() < deadline; poll++) {
			await this.sleep(waitStepMs);
			if (!this.pidAlive(pid)) return true;
		}
		return !this.pidAlive(pid);
	}

	private async signalCapturedOwner(
		captured: DaemonState,
		tokenFingerprint: string,
		chatId: string,
		signal: NodeJS.Signals,
	): Promise<"signaled" | "already_gone" | "ownership_changed" | "hard_termination"> {
		const current = await readDaemonState(this.settings, this.fsImpl);

		const modernCurrentMatches =
			hasSafeDaemonStateShape(current) &&
			current.ownerId === captured.ownerId &&
			current.acquisitionId === captured.acquisitionId &&
			current.pid === captured.pid &&
			current.generation === captured.generation &&
			current.incarnation === captured.incarnation &&
			current.tokenFingerprint === captured.tokenFingerprint &&
			current.chatId === captured.chatId &&
			current.tokenFingerprint === tokenFingerprint &&
			current.chatId === chatId;
		// The signal is privileged: the persisted record must still be the exact
		// modern owner. Legacy generation-3 records remain migration evidence only;
		// this controller never upgrades or signals them.
		if (!modernCurrentMatches) return "ownership_changed";
		if (!this.pidAlive(captured.pid)) return "already_gone";
		if (
			!isSignalableMatchingOwner({
				state: modernCurrentMatches ? current : captured,
				tokenFingerprint,
				chatId,
				pidAlive: this.pidAlive,
				pidIncarnation: this.deps.pidIncarnation,
			})
		)
			return "ownership_changed";
		const processRef = this.processReference(captured.pid);
		// A stable native process reference (pidfd/handle/start-time reference) closes
		// the exit-and-reuse window between ordinary provenance checks and signaling.
		// Its identity must still be the exact persisted incarnation before use.
		if (!processRef || processRef.incarnation !== captured.incarnation) return "ownership_changed";
		if (signal === "SIGTERM" && processRef.termination === "hard") return "hard_termination";
		try {
			processRef.signalRoot(signal);
		} catch {
			return "already_gone";
		}
		return "signaled";
	}

	#currentConfigurationMatches(tokenFingerprintValue: string, chatId: string): boolean {
		const current = getNotificationConfig(this.settings);
		return (
			isTelegramComplete(current) &&
			tokenFingerprint(current.botToken) === tokenFingerprintValue &&
			current.chatId === chatId
		);
	}

	async #signalAttestedLegacyOwner(
		captured: AttestedLegacyDaemonOwner,
		tokenFingerprint: string,
		chatId: string,
		signal: NodeJS.Signals,
	): Promise<"signaled" | "already_gone" | "ownership_changed" | "hard_termination"> {
		if (!this.#currentConfigurationMatches(tokenFingerprint, chatId)) return "ownership_changed";
		const current = await readAttestedLegacyDaemonOwner({
			settings: this.settings,
			fs: this.fsImpl,
			now: this.now,
			pidIncarnation: this.deps.pidIncarnation,
			tokenFingerprint,
			chatId,
		});
		if (
			!current ||
			current.state.pid !== captured.state.pid ||
			current.state.ownerId !== captured.state.ownerId ||
			current.state.startedAt !== captured.state.startedAt ||
			current.incarnation !== captured.incarnation
		)
			return "ownership_changed";
		if (!this.pidAlive(captured.state.pid)) return "already_gone";
		const processRef = this.processReference(captured.state.pid);
		if (!processRef || processRef.incarnation !== captured.incarnation) return "ownership_changed";
		const rechecked = await readAttestedLegacyDaemonOwner({
			settings: this.settings,
			fs: this.fsImpl,
			now: this.now,
			pidIncarnation: this.deps.pidIncarnation,
			tokenFingerprint,
			chatId,
		});
		if (
			!rechecked ||
			rechecked.state.pid !== current.state.pid ||
			rechecked.state.ownerId !== current.state.ownerId ||
			rechecked.state.startedAt !== current.state.startedAt ||
			rechecked.incarnation !== current.incarnation ||
			!this.#currentConfigurationMatches(tokenFingerprint, chatId) ||
			!this.pidAlive(captured.state.pid)
		)
			return "ownership_changed";
		if (signal === "SIGTERM" && processRef.termination === "hard") return "hard_termination";
		try {
			processRef.signalRoot(signal);
		} catch {
			return "already_gone";
		}
		return "signaled";
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

	async reloadForGenerationUpgrade(
		opts: DaemonOperationOptions = {},
		attestedLegacyUpgrade = false,
	): Promise<TelegramGenerationReloadResult> {
		// A generation upgrade MUST replace an incompatible older-generation owner to
		// avoid a permanent single-poller deadlock. Unlike a manual `gjc daemon
		// reload`, this automatic path force-escalates to SIGKILL when the old owner
		// ignores the cooperative SIGTERM within the graceful timeout, so SDK startup
		// self-recovers instead of failing closed and asking the operator to rerun
		// with --force. The SIGKILL remains fenced to the still-live, still-matching
		// captured owner (same ownerId + pid), so a fresh replacement is never killed.
		const operation = await this.stopOrReload("reload", { ...opts, force: true }, attestedLegacyUpgrade);
		if (!operation.ok) return { outcome: "failed", operation };
		const after = await this.status();
		return after.health === "running" ? { outcome: "ready", operation } : { outcome: "failed", operation };
	}

	async stop(opts: DaemonOperationOptions = {}): Promise<DaemonOperationResult> {
		return this.stopOrReload("stop", opts);
	}

	private async stopOrReload(
		action: "stop" | "reload",
		opts: DaemonOperationOptions,
		attestedLegacyUpgrade = false,
	): Promise<DaemonOperationResult> {
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

		const ownerSnapshot = await readOwnerFreshnessSnapshot({ settings: this.settings, fs: this.fsImpl });
		const state = ownerSnapshot.state;
		const attestedLegacyOwner = attestedLegacyUpgrade
			? await readAttestedLegacyDaemonOwner({
					settings: this.settings,
					fs: this.fsImpl,
					now: this.now,
					pidIncarnation: this.deps.pidIncarnation,
					tokenFingerprint: fp,
					chatId,
				})
			: undefined;
		const replaceableLiveOwner =
			(action === "reload" &&
				state !== undefined &&
				isFreshLiveOwner({
					state,
					now: this.now(),
					tokenFingerprint: fp,
					chatId,
					pidAlive: this.pidAlive,
					pidIncarnation: this.deps.pidIncarnation,
					effectiveHeartbeatAt: ownerSnapshot.effectiveHeartbeatAt,
				}) &&
				isSignalableMatchingOwner({
					state,
					tokenFingerprint: fp,
					chatId,
					pidAlive: this.pidAlive,
					pidIncarnation: this.deps.pidIncarnation,
				})) ||
			(action === "reload" && attestedLegacyOwner !== undefined && this.pidAlive(attestedLegacyOwner.state.pid)) ||
			// A physically-live matching owner whose heartbeat is stale (hung) may be
			// past-TTL yet still holding the poller. Autostart/generation-upgrade reloads
			// stay conservative and refuse it, but an explicit `reload --force` must be
			// able to signal and replace it rather than deadlock behind the live PID.
			(opts.force === true &&
				isSignalableMatchingOwner({
					state,
					tokenFingerprint: fp,
					chatId,
					pidAlive: this.pidAlive,
					pidIncarnation: this.deps.pidIncarnation,
				}));
		const stoppableLiveOwner =
			action === "stop" &&
			isSignalableMatchingOwner({
				state,
				tokenFingerprint: fp,
				chatId,
				pidAlive: this.pidAlive,
				pidIncarnation: this.deps.pidIncarnation,
			});
		// A stale pre-generation owner may only be moved by reload; manual stop
		// also targets a physically live matching legacy owner, but never spawns.
		if (before.health !== "running" && !replaceableLiveOwner && !stoppableLiveOwner) {
			if (action === "stop")
				return this.result(action, true, "no running telegram daemon", before, before, warnings);
			if (!(opts.spawnIfStopped ?? true)) {
				return this.result(action, true, "no running telegram daemon to reload", before, before, warnings);
			}
			const { spawned, ready } = await this.spawnAndWait(roots, fp, chatId);
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
				spawned.result === "owner_spawned" && ready && after.health === "running",
				ready
					? `spawned fresh telegram daemon (${spawned.result})`
					: "telegram daemon did not become ready after spawning",
				before,
				after,
				warnings,
			);
		}

		// Running owner: capture identity, request cooperative stop, signal, wait.
		const modernCapturedOwner =
			hasSafeDaemonStateShape(state) &&
			isSignalableMatchingOwner({
				state,
				tokenFingerprint: fp,
				chatId,
				pidAlive: this.pidAlive,
				pidIncarnation: this.deps.pidIncarnation,
			})
				? state
				: undefined;
		if (!modernCapturedOwner && !attestedLegacyOwner) {
			return this.result(
				action,
				false,
				"telegram daemon ownership changed; refusing to signal",
				before,
				before,
				warnings,
			);
		}
		const capturedOwner = modernCapturedOwner ?? attestedLegacyOwner!.state;
		const oldOwnerId = capturedOwner.ownerId;
		const oldPid = capturedOwner.pid;
		const requestId = this.deps.randomId?.() ?? `${this.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
		await writeTelegramControlRequest(
			this.settings,
			{ version: 1, requestId, action, ownerId: oldOwnerId, pid: oldPid, createdAt: this.now() },
			this.fsImpl,
		);
		const signalResult = attestedLegacyOwner
			? await this.#signalAttestedLegacyOwner(attestedLegacyOwner, fp, chatId, "SIGTERM")
			: await this.signalCapturedOwner(modernCapturedOwner!, fp, chatId, "SIGTERM");
		if (signalResult === "hard_termination") {
			await this.clearOwnRequest(requestId);
			return this.result(
				action,
				false,
				"telegram daemon has hard process authority; refusing cooperative SIGTERM",
				before,
				await this.status(),
				warnings,
			);
		}
		if (signalResult === "ownership_changed") {
			await this.clearOwnRequest(requestId);
			return this.result(
				action,
				false,
				"telegram daemon ownership changed; refusing to signal",
				before,
				await this.status(),
				warnings,
			);
		}
		// "signaled" or "already_gone" (the owner already exited cooperatively): confirm
		// death through the normal path — waitForPidDeath returns immediately for a
		// dead pid, so stop succeeds and reload proceeds to spawn the replacement.

		let dead = await this.waitForPidDeath(oldPid, gracefulTimeoutMs);
		if (!dead) {
			// Old pid still alive after the cooperative SIGTERM. Inspect current ownership.
			const currentSnapshot = await readOwnerFreshnessSnapshot({ settings: this.settings, fs: this.fsImpl });
			const current = currentSnapshot.state;
			const changedToLiveOwner =
				current !== undefined &&
				current.ownerId !== oldOwnerId &&
				isFreshLiveOwner({
					state: current,
					now: this.now(),
					tokenFingerprint: fp,
					chatId,
					pidAlive: this.pidAlive,
					pidIncarnation: this.deps.pidIncarnation,
					effectiveHeartbeatAt: currentSnapshot.effectiveHeartbeatAt,
				});
			if (changedToLiveOwner) {
				await this.clearOwnRequest(requestId);
				const after = await this.status();
				if (!dead) {
					return this.result(
						action,
						false,
						"ownership changed before the captured daemon exited; refusing to signal or spawn",
						before,
						after,
						warnings,
					);
				}
			}
			// No live replacement. Escalate to SIGKILL only with --force and only when
			// the captured owner/pid still matches, so we never kill a different owner.
			const stillSameOwner = current !== undefined && current.ownerId === oldOwnerId && current.pid === oldPid;
			if (opts.force && stillSameOwner) {
				const killResult = attestedLegacyOwner
					? await this.#signalAttestedLegacyOwner(attestedLegacyOwner, fp, chatId, "SIGKILL")
					: await this.signalCapturedOwner(modernCapturedOwner!, fp, chatId, "SIGKILL");
				// Kill only a still-live matching owner; an owner that exited between the
				// graceful timeout and this recheck ("already_gone") is confirmed dead by
				// waitForPidDeath, while a real ownership change stays fenced.
				if (killResult === "signaled" || killResult === "already_gone") {
					dead = await this.waitForPidDeath(oldPid, killTimeoutMs);
				}
			}
			if (!dead) {
				await this.clearOwnRequest(requestId);
				const after = await this.status();
				const message = opts.force
					? "old daemon did not exit after SIGKILL; refusing to spawn to avoid a Telegram 409 conflict"
					: "old daemon did not exit within the graceful timeout; rerun with --force to hard-kill";
				return this.result(action, false, message, before, after, warnings);
			}
		}

		// Old pid is dead: safe to clear our request and proceed.
		await this.clearOwnRequest(requestId);

		if (action === "stop") {
			const after = await this.status();
			return this.result(action, true, "stopped telegram daemon", before, after, warnings);
		}

		if (!this.#currentConfigurationMatches(fp, chatId)) {
			const after = await this.status();
			return this.result(
				action,
				false,
				"telegram notification configuration changed during reload; refusing to spawn",
				before,
				after,
				warnings,
			);
		}
		const { spawned, ready } = await this.spawnAndWait(roots, fp, chatId);
		warnings.push(...spawned.warnings);
		const after = await this.status();
		if (spawned.result === "attached") {
			const attachedSnapshot = await readOwnerFreshnessSnapshot({ settings: this.settings, fs: this.fsImpl });
			const attachedState = attachedSnapshot.state;
			if (
				!isCurrentCompatibleOwner({
					state: attachedState,
					now: this.now(),
					tokenFingerprint: fp,
					chatId,
					pidAlive: this.pidAlive,
					pidIncarnation: this.deps.pidIncarnation,
					effectiveHeartbeatAt: attachedSnapshot.effectiveHeartbeatAt,
				})
			) {
				return this.result(
					action,
					false,
					"ownership moved to a non-ready or incompatible daemon; reload required",
					before,
					after,
					warnings,
				);
			}
			warnings.push("a ready current-compatible owner already exists; attached instead of spawning");
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
			(spawned.result === "owner_spawned" || spawned.result === "attached") && ready && after.health === "running",
			ready ? `reloaded telegram daemon (${spawned.result})` : "telegram daemon did not become ready after spawning",
			before,
			after,
			warnings,
		);
	}

	/** Clear only our exact control request; a successor request must survive. */
	private async clearOwnRequest(requestId: string): Promise<void> {
		const current = await readTelegramControlRequest(this.settings, this.fsImpl);
		if (current?.requestId === requestId) await clearTelegramControlRequest(this.settings, requestId, this.fsImpl);
	}
}
