import * as fs from "node:fs";
import * as path from "node:path";
import { logger, postmortem } from "@gajae-code/utils";
import { YAML } from "bun";
import { applyAtomicYamlPatches, setByPath } from "../../config/atomic-yaml-patch";
import type { Settings } from "../../config/settings";
import { isProcessIncarnation, processIncarnation } from "../broker/process-incarnation";
import {
	getNotificationConfig,
	isProviderEffectivelyEnabled,
	isTelegramComplete,
	type NotificationSettingsReader,
	parseNotificationSettingsSnapshot,
} from "./config";
import { daemonPaths, HEARTBEAT_TTL_MS } from "./daemon-paths";
import { type NotificationDebrisSweepReport, sweepNotificationDebris } from "./notification-service";
import {
	type DaemonState,
	FilesystemTopicRegistryCasAuthority,
	hasSafeDaemonStateShape,
	loadInstallationHostId,
	markDaemonOwnerStopped,
	readDaemonState,
	readOwnerFreshnessSnapshot,
	type TelegramDaemonOptions,
	TelegramNotificationDaemon,
} from "./telegram-daemon";
import { clearTelegramControlRequest, readTelegramControlRequest } from "./telegram-daemon-control";

type TelegramDaemonRunner = {
	run(): Promise<void>;
	requestStop(reason?: "reload" | "signal" | "stop"): void;
};

type TelegramDaemonConstructor = new (opts: TelegramDaemonOptions) => TelegramDaemonRunner;

export type LightweightDaemonSettings = Pick<Settings, "get" | "getAgentDir" | "set" | "flush"> &
	NotificationSettingsReader;

export interface RunDaemonInternalDeps {
	SettingsImpl?: {
		init: (options?: { agentDir?: string }) => Promise<LightweightDaemonSettings>;
	};
	DaemonImpl?: TelegramDaemonConstructor;
	processPid?: number;
	pidAlive?: (pid: number) => boolean;
	pidIncarnation?: (pid: number) => string | undefined;
	/** Clock used by the ownership-progress watchdog; defaults to `Date.now`. */
	now?: () => number;
	/** Timer pair backing the ownership-progress watchdog; defaults to globals. */
	setInterval?: (callback: () => void, ms: number) => Timer;
	clearInterval?: (timer: Timer) => void;
	/** Reads persisted daemon ownership state; defaults to the real reader. */
	readDaemonState?: (settings: Settings) => Promise<DaemonState | undefined>;
	/** Loads the verified machine-local identity; injectable so daemon tests do not touch the host. */
	loadInstallationHostId?: () => Promise<string>;
	/**
	 * Startup hygiene sweep over the notifications dir; injectable so tests can
	 * prove it is fired, is never awaited by startup, and that a rejection is
	 * logged instead of failing the daemon.
	 */
	sweepNotificationDebris?: (input: { dir: string }) => Promise<NotificationDebrisSweepReport>;
}

type DaemonOwnerTuple = {
	ownerId: string;
	acquisitionId: string;
	pid: number;
	incarnation: string;
};

function readyOwnerTuple(state: DaemonState | undefined): DaemonOwnerTuple | undefined {
	if (
		!state ||
		!hasSafeDaemonStateShape(state) ||
		state.stoppedAt !== undefined ||
		typeof state.ownerId !== "string" ||
		state.ownerId.length === 0 ||
		typeof state.acquisitionId !== "string" ||
		state.acquisitionId.length === 0 ||
		!Number.isSafeInteger(state.pid) ||
		state.pid <= 0 ||
		!isProcessIncarnation(state.incarnation)
	)
		return undefined;
	return {
		ownerId: state.ownerId,
		acquisitionId: state.acquisitionId,
		pid: state.pid,
		incarnation: state.incarnation,
	};
}

function ownerTuplesEqual(left: DaemonOwnerTuple, right: DaemonOwnerTuple): boolean {
	return (
		left.ownerId === right.ownerId &&
		left.acquisitionId === right.acquisitionId &&
		left.pid === right.pid &&
		left.incarnation === right.incarnation
	);
}

function daemonOwnerTuple(ownerId: string, deps: RunDaemonInternalDeps): DaemonOwnerTuple | undefined {
	const pid = deps.processPid ?? process.pid;
	const incarnation = (deps.pidIncarnation ?? processIncarnation)(pid);
	if (!Number.isSafeInteger(pid) || pid <= 0 || !isProcessIncarnation(incarnation)) return undefined;
	return { ownerId, acquisitionId: ownerId, pid, incarnation };
}

/** Ownership-watchdog cadence while the daemon process is running. */
const OWNER_WATCHDOG_INTERVAL_MS = 5_000;
const OWNER_STALL_MS = 3 * HEARTBEAT_TTL_MS;

function argValue(argv: string[], name: string): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}
const DAEMON_COMPATIBILITY_DIAGNOSTIC_LIMIT = 1;
let daemonCompatibilityDiagnosticCount = 0;
function recordDaemonCompatibilityDiagnostic(message: string): void {
	if (daemonCompatibilityDiagnosticCount >= DAEMON_COMPATIBILITY_DIAGNOSTIC_LIMIT) return;
	daemonCompatibilityDiagnosticCount++;
	logger.warn(message);
}

export function createLightweightDaemonSettings(input: {
	agentDir: string;
	rawConfig?: unknown;
}): LightweightDaemonSettings {
	const rawConfig = input.rawConfig === undefined ? {} : input.rawConfig;
	const getNotificationSettingsSnapshot = () => parseNotificationSettingsSnapshot(rawConfig);
	getNotificationSettingsSnapshot();

	return {
		get(pathName: string): unknown {
			const snapshot = getNotificationSettingsSnapshot();
			switch (pathName) {
				case "notifications.enabled":
					return snapshot.enabled;
				case "notifications.telegram.enabled":
					return snapshot.telegram.enabled;
				case "notifications.telegram.botToken":
					return snapshot.telegram.botToken;
				case "notifications.telegram.chatId":
					return snapshot.telegram.chatId;
				case "notifications.telegram.btw.enabled":
					return snapshot.telegram.btw.enabled;
				case "notifications.telegram.streaming.enabled":
					return snapshot.telegram.streaming.enabled;
				case "notifications.discord.enabled":
					return snapshot.discord.enabled;
				case "notifications.discord.botToken":
					return snapshot.discord.botToken;
				case "notifications.discord.applicationId":
					return snapshot.discord.applicationId;
				case "notifications.discord.guildId":
					return snapshot.discord.guildId;
				case "notifications.discord.parentChannelId":
					return snapshot.discord.parentChannelId;
				case "notifications.slack.enabled":
					return snapshot.slack.enabled;
				case "notifications.slack.botToken":
					return snapshot.slack.botToken;
				case "notifications.slack.appToken":
					return snapshot.slack.appToken;
				case "notifications.slack.workspaceId":
					return snapshot.slack.workspaceId;
				case "notifications.slack.channelId":
					return snapshot.slack.channelId;
				case "notifications.slack.authorizedUserId":
					return snapshot.slack.authorizedUserId;
				case "notifications.telegram.topics.nameTemplate":
					return snapshot.telegram.topics.nameTemplate;
				case "notifications.telegram.rich.enabled":
					return snapshot.telegram.rich.enabled;
				case "notifications.telegram.richDraft.enabled":
					return snapshot.telegram.richDraft.enabled;
				case "notifications.redact":
					return snapshot.redact;
				case "notifications.verbosity":
					return snapshot.verbosity;
				case "notifications.sessionScope":
					return snapshot.sessionScope;
				case "notifications.daemon.idleTimeoutMs":
					return snapshot.idleTimeoutMs;
				default:
					return undefined;
			}
		},
		getNotificationSettingsSnapshot,
		getAgentDir(): string {
			return input.agentDir;
		},
		async set(pathName: string, value: unknown): Promise<void> {
			// The daemon process never loads full Settings, but writes through the exact
			// same in-process queue, cross-process lock, and atomic replacement helper.
			// Its local snapshot changes only after the durable rename succeeds.
			const configPath = path.join(input.agentDir, "config.yml");
			await applyAtomicYamlPatches(configPath, [{ path: pathName, op: "set", value }]);
			setByPath(rawConfig as Record<string, unknown>, pathName.split("."), value);
		},
		async flush(): Promise<void> {
			// The set() above is synchronously durable (it awaits the atomic tmp+rename
			// write under the shared file lock), so there is never a pending save to
			// flush. Present so the daemon can await flush() uniformly regardless of
			// which Settings implementation is injected.
		},
	} as LightweightDaemonSettings;
}

export async function loadLightweightDaemonSettings(agentDir: string): Promise<LightweightDaemonSettings> {
	const configPath = path.join(agentDir, "config.yml");
	let rawConfig: unknown = {};
	try {
		rawConfig = YAML.parse(await fs.promises.readFile(configPath, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return createLightweightDaemonSettings({ agentDir, rawConfig });
}

async function resolveDaemonSettings(
	agentDir: string,
	deps: RunDaemonInternalDeps,
): Promise<LightweightDaemonSettings> {
	if (deps.SettingsImpl) return await deps.SettingsImpl.init({ agentDir });
	return await loadLightweightDaemonSettings(agentDir);
}

export function ownerPidFromOwnerId(ownerId: string): number | undefined {
	const match = /^(\d+)(?:-|$)/.exec(ownerId);
	if (!match) return undefined;
	const pid = Number(match[1]);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function ownerProcessIsAlive(ownerId: string, deps: RunDaemonInternalDeps): boolean {
	const ownerPid = ownerPidFromOwnerId(ownerId);
	if (ownerPid === undefined) return true;
	return (deps.pidAlive ?? defaultPidAlive)(ownerPid);
}

/** Creates owner-fenced daemon control hooks for the CLI lifecycle boundary. */
export function createDaemonControlHooks(settings: Settings) {
	return {
		shouldStop: async (owner: string) => {
			const req = await readTelegramControlRequest(settings);
			return Boolean(req && (!req.ownerId || req.ownerId === owner));
		},
		clear: async (owner: string) => {
			const req = await readTelegramControlRequest(settings);
			// Only clear a request that targets this daemon owner, so an exiting
			// daemon never erases a newer request meant for a different owner.
			if (req && (!req.ownerId || req.ownerId === owner)) await clearTelegramControlRequest(settings, req.requestId);
		},
	};
}

export async function runDaemonSmoke(opts: { agentDir?: string } = {}): Promise<void> {
	const agentDir = opts.agentDir ?? fs.mkdtempSync(path.join(process.cwd(), ".telegram-daemon-smoke-"));
	const settings = createLightweightDaemonSettings({ agentDir, rawConfig: {} });
	const paths = daemonPaths(agentDir);
	await fs.promises.mkdir(paths.dir, { recursive: true, mode: 0o700 });
	const tempLock = `${paths.lock}.smoke.${process.pid}`;
	const handle = await fs.promises.open(tempLock, "wx", 0o600);
	await handle.close();
	await fs.promises.unlink(tempLock);
	void settings;
}

export async function runDaemonInternal(argv: string[], deps: RunDaemonInternalDeps = {}): Promise<void> {
	const smoke = argv.includes("--smoke");
	const agentDir = argValue(argv, "--agent-dir");
	if (smoke) return runDaemonSmoke({ agentDir });
	const ownerId = argValue(argv, "--owner-id");
	if (!ownerId) throw new Error("missing --owner-id");
	if (!ownerProcessIsAlive(ownerId, deps)) {
		recordDaemonCompatibilityDiagnostic("GJC notify daemon exiting because its owner is not alive");
		return;
	}
	const resolvedAgentDir = agentDir ?? process.env.GJC_CODING_AGENT_DIR ?? path.join(process.cwd(), ".gjc", "agent");
	const settings = await resolveDaemonSettings(resolvedAgentDir, deps);
	const cfg = getNotificationConfig(settings);
	if (!isProviderEffectivelyEnabled(cfg, "telegram") || !isTelegramComplete(cfg)) return;
	// Startup hygiene: reclaim inert quarantine/staging debris left by crashed
	// writers so the notifications dir cannot grow unboundedly and slow every
	// later endpoint scan. Never awaited by startup; a rejection is logged and
	// never fails the daemon, because hygiene must not own daemon availability.
	void (deps.sweepNotificationDebris ?? sweepNotificationDebris)({
		dir: daemonPaths(resolvedAgentDir).dir,
	})
		.then(report => {
			// A resolved report can still carry operational failures; surfacing only
			// a rejected promise would hide exactly the evidence the sweep records.
			if (report.failures > 0 || report.scanFailed === true)
				logger.warn(
					`telegram-daemon: startup debris sweep incomplete: removed ${report.removed.length}, failed ${report.failures}${report.scanFailed ? ", scan failed" : ""}`,
				);
		})
		.catch(error => logger.warn(`telegram-daemon: startup debris sweep failed: ${String(error)}`));
	const installationHostId = await (deps.loadInstallationHostId ?? loadInstallationHostId)();
	const topicRegistryAuthority = new FilesystemTopicRegistryCasAuthority(
		path.join(daemonPaths(resolvedAgentDir).dir, "telegram-topics.json"),
		{ installationHostId },
	);
	const Daemon: TelegramDaemonConstructor = deps.DaemonImpl ?? TelegramNotificationDaemon;
	const readState = deps.readDaemonState ?? readDaemonState;
	// The daemon owns periodic orphan-owner reconciliation: it fences stale
	// pollers before becoming poll-capable and re-runs the reap on a fixed
	// cadence so late strays converge. The callback reads the current owner
	// identity from the durable state (not from this process's volatile
	// ownerId) so the reap targets only superseded owners, never itself.
	const orphanReap = async (): Promise<void> => {
		const { reapTelegramDaemonOrphans, writeTelegramOrphanRecoveryReceipt } = await import(
			"./telegram-daemon-orphan-reap"
		);
		const snapshot = await readOwnerFreshnessSnapshot({ settings: settings as Settings });
		const state = snapshot.state;
		if (!state || !hasSafeDaemonStateShape(state) || state.ownershipPhase !== "ready") return;
		const { nativeProcessBindings } = await import("@gajae-code/utils/native-process");
		const incarnation = state.incarnation;
		const { receipt } = await reapTelegramDaemonOrphans({
			agentDir: resolvedAgentDir,
			currentOwnerId: state.ownerId,
			currentAcquisitionId: state.acquisitionId ?? state.ownerId,
			currentPid: state.pid,
			currentIncarnation: incarnation,
			fsImpl: fs.promises as unknown as import("./telegram-daemon").TelegramDaemonFs,
			deps: {
				pidAlive:
					deps.pidAlive ??
					((pid: number) => {
						try {
							process.kill(pid, 0);
							return true;
						} catch (e) {
							return (e as NodeJS.ErrnoException).code !== "ESRCH";
						}
					}),
				pidIncarnation: deps.pidIncarnation ?? processIncarnation,
				processReference: (pid: number) => {
					try {
						const r = nativeProcessBindings().Process.fromPid(pid) as {
							incarnation?: unknown;
							killTree?: (signal?: number) => number;
						} | null;
						if (!r || typeof r.incarnation !== "string" || !isProcessIncarnation(r.incarnation)) return undefined;
						return {
							incarnation: r.incarnation,
							terminateTree: (sig?: NodeJS.Signals) => {
								const os = require("node:os") as typeof import("node:os");
								const code = sig === "SIGKILL" ? os.constants.signals.SIGKILL : os.constants.signals.SIGTERM;
								const count = (r as { killTree: (signal?: number) => number }).killTree(code);
								return count > 0;
							},
						};
					} catch {
						return undefined;
					}
				},
				now: deps.now,
			},
		});
		if (receipt.refused > 0) {
			logger.warn(`notifications: daemon orphan reap had ${receipt.refused} refused candidate(s)`);
		}
		await writeTelegramOrphanRecoveryReceipt(
			fs.promises as unknown as import("./telegram-daemon").TelegramDaemonFs,
			resolvedAgentDir,
			receipt,
		).catch(() => undefined);
	};
	const daemon = new Daemon({
		settings: settings as Settings,
		ownerId,
		botToken: cfg.botToken,
		chatId: cfg.chatId,
		idleTimeoutMs: cfg.idleTimeoutMs,
		sound: cfg.sound,
		rich: cfg.rich,
		richDraft: cfg.richDraft,
		toolActivity: cfg.toolActivity,
		topics: cfg.topics,
		btw: cfg.btw,
		pid: deps.processPid ?? process.pid,
		control: createDaemonControlHooks(settings as Settings),
		topicRegistryAuthority,
		installationHostId,
		requireTelegramTopicEligibility: true,
		orphanReap,
	});
	// Signals are a process concern: install them at the daemon-internal boundary,
	// not inside the embeddable daemon class. SIGTERM is the reload wakeup path.
	const onSignal = (): void => daemon.requestStop("signal");
	const now = deps.now ?? Date.now;
	const schedule = deps.setInterval ?? setInterval;
	const unschedule = deps.clearInterval ?? clearInterval;
	let watchdogActive = true;
	let watchdogTickInFlight = false;
	let stopRequested = false;
	let lastHeartbeatAt: number | undefined;
	let stalledSince: number | undefined;
	const watchdogTick = async (): Promise<void> => {
		if (!watchdogActive || watchdogTickInFlight || stopRequested) return;
		watchdogTickInFlight = true;
		try {
			const isInjectedState = Boolean(deps.readDaemonState);
			const snapshot = isInjectedState
				? {
						state: await readState(settings as Settings),
						effectiveHeartbeatAt: undefined,
						ownerTag: undefined as unknown as {
							ownerId: string;
							acquisitionId: string;
							pid: number;
							incarnation: string;
						} | null,
					}
				: await readOwnerFreshnessSnapshot({ settings: settings as Settings });
			const state = snapshot.state;
			const heartbeatAt = (snapshot as { effectiveHeartbeatAt?: number }).effectiveHeartbeatAt ?? state?.heartbeatAt;
			if (!watchdogActive || !state) return;
			// Self-fencing: prove the complete lock/state tuple (ownerId, acquisitionId, pid, incarnation).
			// Product-owned proof uses the lock/state tuple; a bare ownerId equality alone is not authorization.
			const publishedOwner = readyOwnerTuple(state);
			if (isInjectedState) {
				// Test seam path: deps.readDaemonState injects state without lock. Prove full tuple against daemon's own stable identity.
				const expectedOwner = daemonOwnerTuple(ownerId, deps);
				// Without stable self incarnation authority, fail closed (Windows or unavailable probe).
				if (!publishedOwner || !expectedOwner) return;
				if (!ownerTuplesEqual(publishedOwner, expectedOwner)) {
					stopRequested = true;
					daemon.requestStop("stop");
					return;
				}
			} else {
				// Production path: prove the published state matches the lock-backed ownerTag; then prove supersession against current tuple.
				if (!publishedOwner) return;
				const snapshotTag = (
					snapshot as {
						ownerTag?: { ownerId: string; acquisitionId: string; pid: number; incarnation: string } | null;
					}
				).ownerTag;
				if (!snapshotTag) return;
				// Lock/state mismatch or missing lock is ambiguous — fail closed, do not selfterminate on noise.
				if (
					snapshotTag.ownerId !== publishedOwner.ownerId ||
					snapshotTag.acquisitionId !== publishedOwner.acquisitionId ||
					snapshotTag.pid !== publishedOwner.pid ||
					snapshotTag.incarnation !== publishedOwner.incarnation
				)
					return;
				// Positive supersession: published authoritative tuple no longer matches this daemon's acquisition.
				// We prove via exact tuple comparison; acquisitionId == ownerId for daemon-spawned owners.
				const selfTuple = daemonOwnerTuple(ownerId, deps);
				if (selfTuple && !ownerTuplesEqual(publishedOwner, selfTuple)) {
					stopRequested = true;
					daemon.requestStop("stop");
					return;
				}
				// No stable self incarnation proof available (e.g. Windows native
				// unavailable). Fail closed: do NOT self-terminate on ownerId alone.
				// A bare ownerId equality is not sufficient authority to terminate a
				// running daemon — a stale or reused PID could match, killing a
				// foreign process. The stall watchdog below handles non-progress.
			}
			if (lastHeartbeatAt === undefined || heartbeatAt !== lastHeartbeatAt) {
				lastHeartbeatAt = heartbeatAt;
				stalledSince = now();
				return;
			}
			stalledSince ??= now();
			if (now() - stalledSince >= OWNER_STALL_MS) {
				stopRequested = true;
				daemon.requestStop("stop");
			}
		} catch {
			// Missing, malformed, or temporarily unreadable state is ambiguous.
			// Stop only on positive supersession or observed non-progress.
		} finally {
			watchdogTickInFlight = false;
		}
	};
	const watchdog = schedule(() => void watchdogTick(), OWNER_WATCHDOG_INTERVAL_MS);
	process.once("SIGTERM", onSignal);
	process.once("SIGINT", onSignal);
	// The daemon releases ownership only after a fully quiesced, fully persisted
	// shutdown. Every other ending - a failed final persist, a signal, an
	// uncaught error inside a detached async chain - used to leave
	// `ownershipPhase: "ready"` on disk for a process that no longer exists, and
	// later readers attached to it. Observed in the field: a daemon wrote one
	// heartbeat 559 ms after readiness, died on an uncaught topic-registry
	// error, and was still advertising itself as ready eight hours later.
	//
	// `finally` covers a returning or throwing run(); the postmortem hook covers
	// the fatal paths that call `process.exit()` without unwinding this frame.
	const recordOwnerStopped = (): Promise<boolean> =>
		markDaemonOwnerStopped({
			settings: settings as Settings,
			ownerId,
			acquisitionId: ownerId,
			pid: deps.processPid ?? process.pid,
			now: deps.now,
		});
	const unregisterPostmortem = postmortem.register("telegram-daemon:owner-state", async () => {
		await recordOwnerStopped();
	});
	try {
		await daemon.run();
	} finally {
		watchdogActive = false;
		unschedule(watchdog);
		process.off("SIGTERM", onSignal);
		process.off("SIGINT", onSignal);
		unregisterPostmortem();
		await recordOwnerStopped();
	}
}
