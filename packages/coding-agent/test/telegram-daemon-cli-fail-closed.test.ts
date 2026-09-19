import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { Settings } from "../src/config/settings";
import { tokenFingerprint } from "../src/sdk/bus/config";
import { daemonPaths } from "../src/sdk/bus/daemon-paths";
import {
	DAEMON_GENERATION,
	type DaemonState,
	SERVING_EPOCH,
	type TelegramDaemonOptions,
} from "../src/sdk/bus/telegram-daemon";
import {
	createDaemonControlHooks,
	loadLightweightDaemonSettings,
	runDaemonInternal,
} from "../src/sdk/bus/telegram-daemon-cli";
import { writeTelegramControlRequest } from "../src/sdk/bus/telegram-daemon-control";

const BOT_TOKEN = "1234567890:ABCDEFghijkLmnOpQrsTuvWxYz012345678";

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-4403-cli-"));
}

function settings(agentDir: string): Settings {
	const isolated = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.enabled": true,
		"notifications.telegram.botToken": BOT_TOKEN,
		"notifications.telegram.chatId": "42",
	}) as Settings;
	return new Proxy(isolated, {
		get(target, property) {
			if (property === "getAgentDir") return () => agentDir;
			const v = Reflect.get(target, property, target);
			return typeof v === "function" ? v.bind(target) : v;
		},
	}) as Settings;
}

function writeReadyState(agentDir: string, pid: number, incarnation: string, ownerId: string): void {
	const paths = daemonPaths(agentDir);
	fs.mkdirSync(paths.dir, { recursive: true });
	const state: DaemonState = {
		pid,
		incarnation,
		ownerId,
		acquisitionId: ownerId,
		ownershipPhase: "ready",
		tokenFingerprint: tokenFingerprint(BOT_TOKEN),
		chatId: "42",
		startedAt: 1,
		heartbeatAt: Date.now(),
		version: 1,
		generation: DAEMON_GENERATION,
		servingEpoch: SERVING_EPOCH,
	};
	fs.writeFileSync(paths.state, `${JSON.stringify(state)}\n`);
	fs.writeFileSync(
		paths.lock,
		`${JSON.stringify({
			pid,
			incarnation,
			ownerId,
			acquisitionId: ownerId,
			startedAt: 1,
		})}\n`,
	);
}

describe("issue #4403 — CLI fail-closed + daemon watchdog reconciliation", () => {
	test("control action projection remains owner-fenced", async () => {
		const agentDir = tempAgentDir();
		try {
			const s = settings(agentDir);
			await writeTelegramControlRequest(s, {
				version: 1,
				requestId: "reload-request",
				action: "reload",
				ownerId: "owner-a",
				pid: 123,
				createdAt: 1,
			});
			const hooks = createDaemonControlHooks(s);
			expect(await hooks.shouldStop("owner-a")).toBe(true);
			expect(await hooks.requestedAction("owner-a")).toBe("reload");
			expect(await hooks.shouldStop("owner-b")).toBe(false);
			expect(await hooks.requestedAction("owner-b")).toBeUndefined();
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("watchdog does NOT self-terminate when incarnation authority is unavailable (fail-closed)", async () => {
		const agentDir = tempAgentDir();
		const token = "test-fail-closed";
		const ownerId = `${process.pid}-${token}`;
		try {
			const s = settings(agentDir);
			// Write a ready state for a DIFFERENT ownerId (simulating supersession).
			// Use the real process pid so ownerProcessIsAlive passes.
			writeReadyState(agentDir, process.pid, "linux:999999", "other-owner");

			let stopCalled = false;
			const runPromise = new Promise<void>(r => {
				// Bounded: resolve after 500ms. The watchdog fails closed and never
				// calls requestStop, so the daemon must stay alive until this resolves.
				setTimeout(() => r(), 500);
			});

			await runDaemonInternal(["--owner-id", ownerId, "--agent-dir", agentDir], {
				processPid: process.pid,
				pidAlive: () => true,
				// incarnation authority unavailable — simulates Windows/macOS-no-probe
				pidIncarnation: () => undefined,
				loadInstallationHostId: async () => "host-id",
				SettingsImpl: {
					init: async () => s as unknown as never,
				},
				DaemonImpl: class {
					requestStop(): void {
						stopCalled = true;
					}
					async run(): Promise<void> {
						await runPromise;
					}
				} as never,
				// Fast watchdog for the test
				setInterval: (cb: () => void) => {
					setTimeout(() => cb(), 50);
					return 1 as unknown as Timer;
				},
				clearInterval: () => {},
				readDaemonState: async (_settings: Settings) => {
					const raw = fs.readFileSync(daemonPaths(agentDir).state, "utf8");
					return JSON.parse(raw) as DaemonState;
				},
			});

			// The watchdog should NOT have called requestStop when incarnation
			// authority is unavailable — it should fail closed and not self-terminate.
			expect(stopCalled).toBe(false);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("watchdog self-terminates on proven supersession via full tuple", async () => {
		const agentDir = tempAgentDir();
		const token = "test-supersede";
		const ownerId = `${process.pid}-${token}`;
		const realIncarnation = `linux:999999`;
		try {
			const s = settings(agentDir);
			writeReadyState(agentDir, 88888, "linux:88888", "other-owner");

			let stopCalled = false;
			let resolveRun: () => void;
			const runPromise = new Promise<void>(r => {
				resolveRun = r;
			});

			await runDaemonInternal(["--owner-id", ownerId, "--agent-dir", agentDir], {
				processPid: process.pid,
				pidAlive: () => true,
				pidIncarnation: (pid: number) => (pid === 88888 ? "linux:88888" : realIncarnation),
				loadInstallationHostId: async () => "host-id",
				SettingsImpl: {
					init: async () => s as unknown as never,
				},
				DaemonImpl: class {
					requestStop(): void {
						stopCalled = true;
						resolveRun();
					}
					async run(): Promise<void> {
						await runPromise;
					}
				} as never,
				setInterval: (cb: () => void) => {
					setTimeout(() => cb(), 50);
					return 1 as unknown as Timer;
				},
				clearInterval: () => {},
				readDaemonState: async (_settings: Settings) => {
					const raw = fs.readFileSync(daemonPaths(agentDir).state, "utf8");
					return JSON.parse(raw) as DaemonState;
				},
			});

			// Proven supersession (published owner != self tuple) → stop called.
			expect(stopCalled).toBe(true);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("daemon constructor receives orphanReap option and startup fires it before poll", async () => {
		const agentDir = tempAgentDir();
		const token = "test-orphan-reap";
		const ownerId = `${process.pid}-${token}`;
		try {
			const s = settings(agentDir);
			let reapCalled = false;
			let reapCalledBeforeRun = false;

			await runDaemonInternal(["--owner-id", ownerId, "--agent-dir", agentDir], {
				processPid: process.pid,
				pidAlive: () => true,
				pidIncarnation: (pid: number) => `linux:${pid}`,
				loadInstallationHostId: async () => "host-id",
				SettingsImpl: {
					init: async () => s as unknown as never,
				},
				DaemonImpl: class {
					constructor(opts: TelegramDaemonOptions) {
						// The orphanReap callback must be wired into the constructor opts.
						const reap = opts.orphanReap;
						if (reap) {
							// Call it to prove it's wired and fires.
							reapCalledBeforeRun = true;
							void reap().then(() => {
								reapCalled = true;
							});
						}
					}
					requestStop(): void {}
					async run(): Promise<void> {}
				} as never,
			});

			expect(reapCalledBeforeRun).toBe(true);
			await Bun.sleep(100);
			expect(reapCalled).toBe(true);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test.each([
		"disabled",
		"missing",
		"malformed",
		"permission-denied",
		"token-rotated",
		"chat-rotated",
	] as const)("watchdog stops standalone ingress when configuration is %s", async scenario => {
		const agentDir = tempAgentDir();
		const ownerId = `${process.pid}-test-disable`;
		const incarnation = "linux:4242";
		const configPath = path.join(agentDir, "config.yml");
		const rawConfig: Record<string, unknown> = {
			notifications: {
				enabled: true,
				telegram: { enabled: true, botToken: BOT_TOKEN, chatId: "42" },
			},
		};
		fs.writeFileSync(configPath, JSON.stringify(rawConfig));
		writeReadyState(agentDir, process.pid, incarnation, ownerId);
		const warning = spyOn(logger, "warn");
		let watchdogCallback: (() => void) | undefined;
		let stopCalled = false;
		let standaloneIngress = false;
		const { promise: daemonRun, resolve: resolveRun } = Promise.withResolvers<void>();
		const watchdogReady = Promise.withResolvers<void>();
		let settingsLoads = 0;
		let runner: Promise<void> | undefined;
		try {
			runner = runDaemonInternal(["--owner-id", ownerId, "--agent-dir", agentDir], {
				processPid: process.pid,
				pidAlive: () => true,
				pidIncarnation: () => incarnation,
				loadInstallationHostId: async () => "host-id",
				SettingsImpl: {
					init: async () => {
						settingsLoads += 1;
						if (settingsLoads > 1 && scenario === "permission-denied")
							throw Object.assign(new Error(`denied ${BOT_TOKEN}`), { code: "EACCES" });
						return loadLightweightDaemonSettings(agentDir);
					},
				},
				DaemonImpl: class {
					constructor(opts: TelegramDaemonOptions) {
						standaloneIngress = opts.keepAliveWithoutAttachments === true;
					}
					requestStop(): void {
						stopCalled = true;
						resolveRun();
					}
					async run(): Promise<void> {
						await daemonRun;
					}
				} as never,
				setInterval: (cb: () => void, ms: number) => {
					if (ms === 5_000) {
						watchdogCallback = cb;
						watchdogReady.resolve();
					}
					return 1 as unknown as Timer;
				},
				clearInterval: () => {},
				readDaemonState: async (_settings: Settings) => {
					const raw = fs.readFileSync(daemonPaths(agentDir).state, "utf8");
					return JSON.parse(raw) as DaemonState;
				},
			});
			await watchdogReady.promise;
			expect(standaloneIngress).toBe(true);
			switch (scenario) {
				case "missing":
					fs.unlinkSync(configPath);
					break;
				case "malformed":
					fs.writeFileSync(configPath, `notifications: [${BOT_TOKEN}`);
					break;
				case "permission-denied":
					break;
				default:
					fs.writeFileSync(
						configPath,
						JSON.stringify({
							notifications: {
								enabled: true,
								telegram: {
									enabled: scenario !== "disabled",
									botToken: scenario === "token-rotated" ? `${BOT_TOKEN}new` : BOT_TOKEN,
									chatId: scenario === "chat-rotated" ? "43" : "42",
								},
							},
						}),
					);
			}
			watchdogCallback?.();
			for (let attempt = 0; attempt < 100 && !stopCalled; attempt++) await Bun.sleep(5);
			expect(stopCalled).toBe(true);
			expect(settingsLoads).toBeGreaterThan(1);
			await runner;
			if (scenario === "malformed" || scenario === "permission-denied")
				expect(warning).toHaveBeenCalledWith(
					"telegram-daemon: configuration verification failed; stopping command ingress",
				);
			expect(JSON.stringify(warning.mock.calls)).not.toContain(BOT_TOKEN);
		} finally {
			resolveRun();
			await runner?.catch(() => undefined);
			warning.mockRestore();
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("malformed daemon state does not crash the watchdog", async () => {
		const agentDir = tempAgentDir();
		const token = "test-malformed";
		const ownerId = `${process.pid}-${token}`;
		const s = settings(agentDir);
		const paths = daemonPaths(agentDir);
		await fs.promises.mkdir(paths.dir, { recursive: true });
		await fs.promises.writeFile(paths.state, "not-json{");

		let stopCalled = false;
		const runPromise = new Promise<void>(r => {
			// Resolve after bounded time: the daemon stays running because the
			// watchdog catch swallows the malformed-state error.
			setTimeout(() => r(), 500);
		});

		await runDaemonInternal(["--owner-id", ownerId, "--agent-dir", agentDir], {
			processPid: process.pid,
			pidAlive: () => true,
			pidIncarnation: (pid: number) => `linux:${pid}`,
			loadInstallationHostId: async () => "host-id",
			SettingsImpl: {
				init: async () => s as unknown as never,
			},
			DaemonImpl: class {
				requestStop(): void {
					stopCalled = true;
				}
				async run(): Promise<void> {
					await runPromise;
				}
			} as never,
			setInterval: (cb: () => void) => {
				setTimeout(() => cb(), 50);
				return 1 as unknown as Timer;
			},
			clearInterval: () => {},
			readDaemonState: async (_settings: Settings) => {
				const raw = fs.readFileSync(daemonPaths(agentDir).state, "utf8");
				return JSON.parse(raw) as DaemonState;
			},
		});

		// Malformed state must not trigger self-termination; the watchdog catches
		// and returns without calling requestStop.
		expect(stopCalled).toBe(false);
		fs.rmSync(agentDir, { recursive: true, force: true });
	});
});
