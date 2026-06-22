import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "../config/settings";
import { getNotificationConfig, isGloballyConfigured } from "./config";
import { daemonPaths, TelegramNotificationDaemon } from "./telegram-daemon";
import { clearTelegramControlRequest, readTelegramControlRequest } from "./telegram-daemon-control";

export interface RunDaemonInternalDeps {
	SettingsImpl?: Pick<typeof Settings, "init">;
	DaemonImpl?: typeof TelegramNotificationDaemon;
	processPid?: number;
}

function argValue(argv: string[], name: string): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}

export async function runDaemonSmoke(opts: { agentDir?: string } = {}): Promise<void> {
	const agentDir = opts.agentDir ?? fs.mkdtempSync(path.join(process.cwd(), ".telegram-daemon-smoke-"));
	const settings = Settings.isolated({});
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
	const settings = await (deps.SettingsImpl ?? Settings).init(agentDir ? { agentDir } : {});
	const cfg = getNotificationConfig(settings);
	if (!isGloballyConfigured(cfg) || !cfg.botToken || !cfg.chatId) return;
	const Daemon = deps.DaemonImpl ?? TelegramNotificationDaemon;
	const daemon = new Daemon({
		settings,
		ownerId,
		botToken: cfg.botToken,
		chatId: cfg.chatId,
		idleTimeoutMs: cfg.idleTimeoutMs,
		pid: deps.processPid ?? process.pid,
		control: {
			shouldStop: async owner => {
				const req = await readTelegramControlRequest(settings);
				return Boolean(req && (!req.ownerId || req.ownerId === owner));
			},
			clear: async owner => {
				const req = await readTelegramControlRequest(settings);
				// Only clear a request that targets this daemon owner, so an exiting
				// daemon never erases a newer request meant for a different owner.
				if (req && (!req.ownerId || req.ownerId === owner)) {
					await clearTelegramControlRequest(settings, req.requestId);
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
