import * as fs from "node:fs";
import * as path from "node:path";
import { YAML } from "bun";
import type { Settings } from "../config/settings";
import { getNotificationConfig, isGloballyConfigured } from "./config";
import { daemonPaths, TelegramNotificationDaemon } from "./telegram-daemon";
import { clearTelegramControlRequest, readTelegramControlRequest } from "./telegram-daemon-control";

export interface RunDaemonInternalDeps {
	SettingsImpl?: { init: (options?: { agentDir?: string }) => Promise<Pick<Settings, "get" | "getAgentDir">> };
	DaemonImpl?: typeof TelegramNotificationDaemon;
	processPid?: number;
	pidAlive?: (pid: number) => boolean;
}

function argValue(argv: string[], name: string): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}

function getByPath(obj: unknown, pathSegments: string[]): unknown {
	let current = obj;
	for (const segment of pathSegments) {
		if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asIdleTimeoutMs(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 60_000;
}

export function createLightweightDaemonSettings(input: {
	agentDir: string;
	rawConfig?: unknown;
}): Pick<Settings, "get" | "getAgentDir"> {
	const rawConfig = input.rawConfig && typeof input.rawConfig === "object" ? input.rawConfig : {};
	return {
		get(pathName: string): unknown {
			const value = getByPath(rawConfig, pathName.split("."));
			switch (pathName) {
				case "notifications.enabled":
					return asBoolean(value, false);
				case "notifications.telegram.botToken":
				case "notifications.telegram.chatId":
				case "notifications.discord.botToken":
				case "notifications.discord.channelId":
				case "notifications.slack.botToken":
				case "notifications.slack.channelId":
					return asString(value);
				case "notifications.redact":
					return asBoolean(value, false);
				case "notifications.verbosity":
					return value === "verbose" ? "verbose" : "lean";
				case "notifications.daemon.idleTimeoutMs":
					return asIdleTimeoutMs(value);
				default:
					return undefined;
			}
		},
		getAgentDir(): string {
			return input.agentDir;
		},
	} as Pick<Settings, "get" | "getAgentDir">;
}

export async function loadLightweightDaemonSettings(agentDir: string): Promise<Pick<Settings, "get" | "getAgentDir">> {
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
): Promise<Pick<Settings, "get" | "getAgentDir">> {
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
		process.stderr.write(`GJC notify daemon exiting: owner process from --owner-id ${ownerId} is not alive.\n`);
		return;
	}
	const resolvedAgentDir = agentDir ?? process.env.GJC_CODING_AGENT_DIR ?? path.join(process.cwd(), ".gjc", "agent");
	const settings = await resolveDaemonSettings(resolvedAgentDir, deps);
	const cfg = getNotificationConfig(settings as Settings);
	if (!isGloballyConfigured(cfg) || !cfg.botToken || !cfg.chatId) return;
	const Daemon = deps.DaemonImpl ?? TelegramNotificationDaemon;
	const daemon = new Daemon({
		settings: settings as Settings,
		ownerId,
		botToken: cfg.botToken,
		chatId: cfg.chatId,
		idleTimeoutMs: cfg.idleTimeoutMs,
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
	process.once("SIGTERM", onSignal);
	process.once("SIGINT", onSignal);
	try {
		await daemon.run();
	} finally {
		process.off("SIGTERM", onSignal);
		process.off("SIGINT", onSignal);
	}
}
