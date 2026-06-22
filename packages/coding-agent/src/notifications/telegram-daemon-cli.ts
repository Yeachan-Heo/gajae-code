import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "../config/settings";
import { getNotificationConfig, isGloballyConfigured } from "./config";
import { daemonPaths, TelegramNotificationDaemon } from "./telegram-daemon";

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
	});
	await daemon.run();
}
