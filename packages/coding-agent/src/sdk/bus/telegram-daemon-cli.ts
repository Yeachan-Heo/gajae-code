import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { YAML } from "bun";
import { applyAtomicYamlPatches, setByPath } from "../../config/atomic-yaml-patch";
import type { Settings } from "../../config/settings";
import {
	getNotificationConfig,
	isTelegramConfigured,
	type NotificationSettingsReader,
	parseNotificationSettingsSnapshot,
} from "./config";
import { daemonPaths, HEARTBEAT_TTL_MS } from "./daemon-paths";
import {
	type DaemonState,
	readDaemonState,
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
	/** Clock used by the ownership-progress watchdog; defaults to `Date.now`. */
	now?: () => number;
	/** Timer pair backing the ownership-progress watchdog; defaults to globals. */
	setInterval?: (callback: () => void, ms: number) => Timer;
	clearInterval?: (timer: Timer) => void;
	/** Reads persisted daemon ownership state; defaults to the real reader. */
	readDaemonState?: (settings: Settings) => Promise<DaemonState | undefined>;
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
				case "notifications.telegram.botToken":
					return snapshot.telegram.botToken;
				case "notifications.telegram.chatId":
					return snapshot.telegram.chatId;
				case "notifications.telegram.btw.enabled":
					return snapshot.telegram.btw.enabled;
				case "notifications.discord.botToken":
					return snapshot.discord.botToken;
				case "notifications.discord.applicationId":
					return snapshot.discord.applicationId;
				case "notifications.discord.guildId":
					return snapshot.discord.guildId;
				case "notifications.discord.parentChannelId":
					return snapshot.discord.parentChannelId;
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
	if (!isTelegramConfigured(cfg)) return;
	const Daemon: TelegramDaemonConstructor = deps.DaemonImpl ?? TelegramNotificationDaemon;
	const readState = deps.readDaemonState ?? readDaemonState;
	const daemon = new Daemon({
		settings: settings as Settings,
		ownerId,
		botToken: cfg.botToken,
		chatId: cfg.chatId,
		idleTimeoutMs: cfg.idleTimeoutMs,
		rich: cfg.rich,
		richDraft: cfg.richDraft,
		toolActivity: cfg.toolActivity,
		topics: cfg.topics,
		btw: cfg.btw,
		pid: deps.processPid ?? process.pid,
		control: {
			shouldStop: async owner => {
				const req = await readTelegramControlRequest(settings as Settings);
				return Boolean(req && (!req.ownerId || req.ownerId === owner));
			},
			clear: async owner => {
				const req = await readTelegramControlRequest(settings as Settings);
				// Only clear a request that targets this daemon owner, so an exiting
				// daemon never erases a newer request meant for a different owner.
				if (req && (!req.ownerId || req.ownerId === owner)) {
					await clearTelegramControlRequest(settings as Settings, req.requestId);
				}
			},
		},
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
			const state = await readState(settings as Settings);
			if (!watchdogActive || !state) return;
			if (state.ownerId !== ownerId) {
				stopRequested = true;
				daemon.requestStop("stop");
				return;
			}
			if (lastHeartbeatAt === undefined || state.heartbeatAt !== lastHeartbeatAt) {
				lastHeartbeatAt = state.heartbeatAt;
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
	try {
		await daemon.run();
	} finally {
		watchdogActive = false;
		unschedule(watchdog);
		process.off("SIGTERM", onSignal);
		process.off("SIGINT", onSignal);
	}
}
