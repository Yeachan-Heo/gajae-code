import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { runDaemonInternal } from "../src/sdk/bus/telegram-daemon-cli";

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-daemon-orphan-"));
}

function settings(agentDir: string): Settings {
	return new Proxy(
		Settings.isolated({
			"notifications.enabled": true,
			"notifications.telegram.botToken": "123456:secret-token",
			"notifications.telegram.chatId": "42",
		}) as Settings,
		{
			get(target, prop) {
				if (prop === "getAgentDir") return () => agentDir;
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		},
	) as Settings;
}

test("runDaemonInternal self-exits when its spawning owner process dies mid-run", async () => {
	const agentDir = tempAgentDir();
	const s = settings(agentDir);
	// Owner id embeds the launcher PID: "4242-..." is the spawning session process.
	const ownerId = "4242-launcher-token";
	let ownerPidAlive = true;
	let tick: (() => void) | undefined;
	let stopReason: string | undefined;
	let resolveRun!: () => void;
	class StubDaemon {
		requestStop(reason?: string): void {
			stopReason = reason;
			resolveRun();
		}
		run(): Promise<void> {
			return new Promise<void>(resolve => {
				resolveRun = resolve;
			});
		}
	}
	const run = runDaemonInternal(["--agent-dir", agentDir, "--owner-id", ownerId], {
		SettingsImpl: { init: async () => s },
		DaemonImpl: StubDaemon,
		// While the launcher (4242) is alive, ownership still names this daemon.
		pidAlive: pid => (pid === 4242 ? ownerPidAlive : true),
		readDaemonState: async () =>
			({ ownerId, heartbeatAt: 1, pid: 4242 }) as never,
		setInterval: callback => {
			tick = callback;
			return 1 as unknown as Timer;
		},
		clearInterval: () => {},
	});
	for (let attempt = 0; attempt < 100 && !tick; attempt++) await Bun.sleep(1);
	expect(tick).toBeDefined();

	// First tick: launcher still alive — no stop.
	tick!();
	await Bun.sleep(0);
	expect(stopReason).toBeUndefined();

	// The spawning session exits. The detached daemon is now orphaned but still
	// polling. The next watchdog tick must observe the dead owner and self-stop,
	// so a later session's fresh daemon no longer shares the bot token with it.
	ownerPidAlive = false;
	tick!();
	await run;

	expect(stopReason).toBe("stop");
});

test("runDaemonInternal keeps running while its owner process stays alive", async () => {
	const agentDir = tempAgentDir();
	const s = settings(agentDir);
	const ownerId = "4242-launcher-token";
	let tick: (() => void) | undefined;
	let stopReason: string | undefined;
	let resolveRun!: () => void;
	class StubDaemon {
		requestStop(reason?: string): void {
			stopReason = reason;
		}
		run(): Promise<void> {
			return new Promise<void>(resolve => {
				resolveRun = resolve;
			});
		}
	}
	const run = runDaemonInternal(["--agent-dir", agentDir, "--owner-id", ownerId], {
		SettingsImpl: { init: async () => s },
		DaemonImpl: StubDaemon,
		pidAlive: () => true,
		readDaemonState: async () =>
			({ ownerId, heartbeatAt: 1, pid: 4242 }) as never,
		setInterval: callback => {
			tick = callback;
			return 1 as unknown as Timer;
		},
		clearInterval: () => {},
	});
	for (let attempt = 0; attempt < 100 && !tick; attempt++) await Bun.sleep(1);
	expect(tick).toBeDefined();

	// Several ticks with the launcher alive must never request a stop.
	for (let i = 0; i < 5; i++) {
		tick!();
		await Bun.sleep(0);
	}
	expect(stopReason).toBeUndefined();

	// Release the daemon so the test can finish.
	resolveRun();
	await run;
});
