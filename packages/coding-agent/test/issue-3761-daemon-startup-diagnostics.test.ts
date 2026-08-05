import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { tokenFingerprint } from "../src/sdk/bus/config";
import { sanitizeDaemonDiagnostic } from "../src/sdk/bus/daemon-diagnostics";
import { daemonPaths } from "../src/sdk/bus/daemon-paths";
import {
	acquireDaemonOwnership,
	DAEMON_GENERATION,
	type DaemonState,
	TelegramNotificationDaemon,
} from "../src/sdk/bus/telegram-daemon";
import { runDaemonInternal } from "../src/sdk/bus/telegram-daemon-cli";

// #3761: a detached `notify daemon-internal` child exited before readiness with
// an empty notifications/daemon.log, which made every startup refusal
// indistinguishable from "the daemon was never spawned". Each pre-readiness exit
// must name its reason on the child's stderr, which the launcher redirects into
// notifications/daemon.log, and must never carry the bot token or the owner id
// (the owner id doubles as the acquisition secret).

const BOT_TOKEN = "123456:secret-token";

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-3761-diagnostics-"));
}

function privateAgentDir(s: Settings, agentDir: string): Settings {
	return new Proxy(s, {
		get(target, prop) {
			if (prop === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}

function telegramSettings(agentDir: string, botToken = BOT_TOKEN): Settings {
	return privateAgentDir(
		Settings.isolated({
			"notifications.enabled": true,
			"notifications.telegram.botToken": botToken,
			"notifications.telegram.chatId": "42",
			"notifications.daemon.idleTimeoutMs": 20,
		}) as Settings,
		agentDir,
	);
}

describe("issue 3761: daemon startup exits are diagnosable", () => {
	let agentDir: string;
	let lines: string[];
	const sink = (line: string): void => {
		lines.push(line);
	};

	beforeEach(() => {
		agentDir = tempAgentDir();
		lines = [];
	});

	afterEach(() => {
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	test("a dead owner pid is reported without leaking the owner id", async () => {
		let settingsLoaded = false;
		await runDaemonInternal(["--owner-id", `4242-${BOT_TOKEN}`, "--agent-dir", agentDir], {
			pidAlive: () => false,
			diagnostic: sink,
			SettingsImpl: {
				init: async () => {
					settingsLoaded = true;
					return telegramSettings(agentDir);
				},
			},
		});

		expect(settingsLoaded).toBe(false);
		expect(lines).toEqual(["gjc notify daemon: exiting before startup: owner process 4242 is not alive"]);
		expect(lines.join("\n")).not.toContain("secret-token");
	});

	test("an owner id without a pid falls through to the next reportable exit", async () => {
		await runDaemonInternal(["--owner-id", "daemon-opaque-owner", "--agent-dir", agentDir], {
			pidAlive: () => false,
			diagnostic: sink,
		});

		// An opaque owner id carries no pid, so liveness cannot refuse the child;
		// the next guard must still say why it exited.
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("does not enable a complete Telegram provider");
	});

	test("a config.yml the child cannot use names which half refused", async () => {
		// The parent CLI resolves notifications through the full Settings stack; the
		// child parses config.yml only. Both halves of that divergence are named.
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			'notifications:\n  enabled: false\n  telegram:\n    botToken: 123456:secret-token\n    chatId: "42"\n',
		);
		let daemonConstructed = false;
		const deps = {
			pidAlive: () => true,
			diagnostic: sink,
			DaemonImpl: class {
				constructor() {
					daemonConstructed = true;
				}
				requestStop(): void {}
				async run(): Promise<void> {}
			} as never,
		};

		await runDaemonInternal(["--owner-id", "owner", "--agent-dir", agentDir], deps);

		expect(daemonConstructed).toBe(false);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("exiting before startup:");
		expect(lines[0]).toContain(path.join(agentDir, "config.yml"));
		expect(lines[0]).toContain("does not enable a complete Telegram provider");
		expect(lines[0]).toContain("effectively enabled: false");
		expect(lines[0]).toContain("credentials complete: true");
		expect(lines[0]).not.toContain("secret-token");

		lines = [];
		fs.writeFileSync(path.join(agentDir, "config.yml"), "notifications:\n  enabled: true\n");
		await runDaemonInternal(["--owner-id", "owner", "--agent-dir", agentDir], deps);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("effectively enabled: false");
		expect(lines[0]).toContain("credentials complete: false");
	});

	test("an unreadable settings source is reported before the failure propagates", async () => {
		await expect(
			runDaemonInternal(["--owner-id", "owner", "--agent-dir", agentDir], {
				pidAlive: () => true,
				diagnostic: sink,
				SettingsImpl: {
					init: async () => {
						throw new Error("config.yml is a directory");
					},
				},
			}),
		).rejects.toThrow("config.yml is a directory");

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("cannot load notification settings from");
		expect(lines[0]).toContain("config.yml is a directory");
	});

	test("a blank bot token exits with a reason instead of silently", async () => {
		const daemon = new TelegramNotificationDaemon({
			settings: telegramSettings(agentDir, "   "),
			ownerId: "owner",
			botToken: "   ",
			chatId: "42",
			pid: 4242,
			diagnostic: sink,
		});

		await daemon.run();

		expect(lines).toEqual([
			"gjc notify daemon: exiting before startup: the configured Telegram bot token is missing or blank",
		]);
	});

	test("a missing ownership record is reported as a refusal, not as a silent exit", async () => {
		fs.mkdirSync(daemonPaths(agentDir).dir, { recursive: true, mode: 0o700 });
		const daemon = new TelegramNotificationDaemon({
			settings: telegramSettings(agentDir),
			ownerId: "owner",
			botToken: BOT_TOKEN,
			chatId: "42",
			pid: 4242,
			pidIncarnation: () => "linux:100",
			diagnostic: sink,
		});

		await daemon.run();

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("exiting before readiness: ownership was refused because");
		expect(lines[0]).toContain("no persisted ownership state exists");
	});

	test("an unusable notifications directory is reported instead of a bare exit", async () => {
		// No notifications/ directory: the transition lock cannot be taken at all.
		const daemon = new TelegramNotificationDaemon({
			settings: telegramSettings(agentDir),
			ownerId: "owner",
			botToken: BOT_TOKEN,
			chatId: "42",
			pid: 4242,
			pidIncarnation: () => "linux:100",
			diagnostic: sink,
		});

		await daemon.run();

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("exiting before readiness: ownership was refused because");
		expect(lines[0]).toContain("transition lock (telegram-daemon.steal) could not be acquired");
	});

	test("a generation mismatch names both generations", async () => {
		const s = telegramSettings(agentDir);
		await acquireDaemonOwnership({
			settings: s,
			tokenFingerprint: tokenFingerprint(BOT_TOKEN),
			chatId: "42",
			pid: 4242,
			pidIncarnation: () => "linux:100",
			randomId: () => "owner",
			allowPidRebind: true,
		});
		const statePath = daemonPaths(agentDir).state;
		const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as DaemonState;
		fs.writeFileSync(statePath, JSON.stringify({ ...state, generation: DAEMON_GENERATION - 1 }));

		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: BOT_TOKEN,
			chatId: "42",
			pid: 4242,
			pidIncarnation: () => "linux:100",
			diagnostic: sink,
		});
		await daemon.run();

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(`generation ${DAEMON_GENERATION - 1} does not match`);
		expect(lines[0]).toContain(`generation ${DAEMON_GENERATION}`);
		expect(lines[0]).not.toContain("secret-token");
	});

	test("a token-shaped value never reaches a durable diagnostic", () => {
		expect(sanitizeDaemonDiagnostic(`ownership for 123456:secret-token-value-long\nfailed`)).toBe(
			"ownership for <redacted-token> failed",
		);
	});

	test("the daemon-internal entrypoint defaults to one timestamped stderr line", async () => {
		const written: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			await runDaemonInternal(["--owner-id", "4242-acquisition-secret", "--agent-dir", agentDir], {
				pidAlive: () => false,
			});
		} finally {
			process.stderr.write = original;
		}

		expect(written).toHaveLength(1);
		expect(written[0]).toMatch(
			/^\d{4}-\d{2}-\d{2}T[\d:.]+Z gjc notify daemon: exiting before startup: owner process 4242 is not alive\n$/,
		);
	});

	test("the embeddable daemon writes nothing to the host stderr without a sink", async () => {
		const written: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			await new TelegramNotificationDaemon({
				settings: telegramSettings(agentDir, "   "),
				ownerId: "owner",
				botToken: "   ",
				chatId: "42",
				pid: 4242,
			}).run();
		} finally {
			process.stderr.write = original;
		}

		expect(written).toEqual([]);
	});

	test("a detached child's diagnostic lands in the redirected log file", async () => {
		// Exact production wiring: the launcher opens notifications/daemon.log and
		// hands the fd to the child as stdout/stderr. A pre-readiness exit must be
		// readable from that file after the child is gone.
		const logPath = path.join(daemonPaths(agentDir).dir, "daemon.log");
		fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
		const fd = fs.openSync(logPath, "a", 0o600);
		const cliModule = path.join(import.meta.dir, "..", "src", "sdk", "bus", "telegram-daemon-cli.ts");
		const script = `import { runDaemonInternal } from ${JSON.stringify(cliModule)};
await runDaemonInternal(["--owner-id", "4242-acquisition-secret", "--agent-dir", ${JSON.stringify(agentDir)}], {
	pidAlive: () => false,
});`;
		try {
			const child = Bun.spawn(["bun", "-e", script], { stdout: fd, stderr: fd });
			expect(await child.exited).toBe(0);
		} finally {
			fs.closeSync(fd);
		}

		const log = fs.readFileSync(logPath, "utf8");
		expect(log).toContain("gjc notify daemon: exiting before startup: owner process 4242 is not alive");
		expect(log).not.toContain("acquisition-secret");
	});
});
