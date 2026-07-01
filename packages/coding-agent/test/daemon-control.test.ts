import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseDaemonArgs, runDaemonCommand } from "../src/cli/daemon-cli";
import { Settings } from "../src/config/settings";
import { createBuiltInDaemonControllers, selectDaemonControllers } from "../src/daemon/builtin";
import type { BuiltInDaemonController, DaemonOperationResult, DaemonStatus } from "../src/daemon/control-types";
import { resolveGjcRuntimeSpawnInfo } from "../src/daemon/runtime";
import { tokenFingerprint } from "../src/notifications/config";
import { daemonPaths } from "../src/notifications/telegram-daemon";
import {
	clearTelegramControlRequest,
	readTelegramControlRequest,
	TelegramDaemonController,
	writeTelegramControlRequest,
} from "../src/notifications/telegram-daemon-control";
import { TopicRegistry } from "../src/notifications/topic-registry";

const BOT_TOKEN = "123456:secret-token";

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-daemon-control-test-"));
}

function setPrivateAgentDir(s: Settings, agentDir: string): Settings {
	return new Proxy(s, {
		get(target, prop) {
			if (prop === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}

function settings(agentDir: string): Settings {
	return setPrivateAgentDir(
		Settings.isolated({
			"notifications.enabled": true,
			"notifications.telegram.botToken": BOT_TOKEN,
			"notifications.telegram.chatId": "42",
		}) as Settings,
		agentDir,
	);
}

function writeState(agentDir: string, state: Record<string, unknown>): void {
	const paths = daemonPaths(agentDir);
	fs.mkdirSync(paths.dir, { recursive: true });
	fs.writeFileSync(paths.state, JSON.stringify(state));
}

function freshState(extra: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		pid: 999,
		ownerId: "old",
		tokenFingerprint: tokenFingerprint(BOT_TOKEN),
		chatId: "42",
		startedAt: Date.now(),
		heartbeatAt: Date.now(),
		roots: [],
		version: 1,
		...extra,
	};
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
	const orig = process.stdout.write.bind(process.stdout);
	let out = "";
	process.stdout.write = ((chunk: unknown): boolean => {
		out += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		await fn();
	} finally {
		process.stdout.write = orig;
	}
	return out;
}

describe("daemon runtime detection", () => {
	test("source runtime picks up edits; compiled warns", () => {
		const source = resolveGjcRuntimeSpawnInfo("/usr/local/bin/node");
		expect(source.mode).toBe("source");
		expect(source.reloadPicksUpSourceEdits).toBe(true);
		expect(source.warning).toBeUndefined();

		const compiled = resolveGjcRuntimeSpawnInfo("/opt/gjc/gjc");
		expect(compiled.mode).toBe("compiled");
		expect(compiled.reloadPicksUpSourceEdits).toBe(false);
		expect(compiled.warning).toContain("Rebuild");
		expect(compiled.argsPrefix).toEqual([]);
	});
});

describe("static built-in controller map", () => {
	test("createBuiltInDaemonControllers exposes telegram only", () => {
		const s = settings(tempAgentDir());
		const map = createBuiltInDaemonControllers(s);
		expect(Object.keys(map)).toEqual(["telegram"]);
		expect(map.telegram).toBeInstanceOf(TelegramDaemonController);
	});

	test("selectDaemonControllers resolves default, all, and rejects unknown kinds", () => {
		const s = settings(tempAgentDir());
		expect(selectDaemonControllers(s, undefined, false)).toHaveLength(1);
		expect(selectDaemonControllers(s, ["telegram"], false)).toHaveLength(1);
		expect(selectDaemonControllers(s, undefined, true)).toHaveLength(1);
		// Unknown kinds are rejected by the static map.
		expect(() => selectDaemonControllers(s, ["mystery" as never], false)).toThrow(/unknown daemon kind/);
	});
});

describe("parseDaemonArgs", () => {
	test("parses action, kind, and flags", () => {
		const parsed = parseDaemonArgs([
			"daemon",
			"reload",
			"telegram",
			"--json",
			"--force",
			"--graceful-timeout-ms",
			"1500",
		]);
		expect(parsed).toBeTruthy();
		expect(parsed?.action).toBe("reload");
		expect(parsed?.kinds).toEqual(["telegram"]);
		expect(parsed?.json).toBe(true);
		expect(parsed?.force).toBe(true);
		expect(parsed?.gracefulTimeoutMs).toBe(1500);
	});

	test("defaults to status and ignores non-daemon argv", () => {
		expect(parseDaemonArgs(["notify", "status"])).toBeUndefined();
		expect(parseDaemonArgs(["daemon"])?.action).toBe("status");
	});
});

describe("control request helpers", () => {
	test("write/read/clear roundtrip is owner-scoped", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		await writeTelegramControlRequest(s, {
			version: 1,
			requestId: "r1",
			action: "reload",
			ownerId: "owner-a",
			pid: 123,
			createdAt: Date.now(),
		});
		const read = await readTelegramControlRequest(s);
		expect(read?.requestId).toBe("r1");
		expect(read?.ownerId).toBe("owner-a");

		// Clearing with a mismatched requestId must not remove a newer request.
		await clearTelegramControlRequest(s, "different-id");
		expect(await readTelegramControlRequest(s)).toBeTruthy();

		await clearTelegramControlRequest(s, "r1");
		expect(await readTelegramControlRequest(s)).toBeUndefined();
	});
});

describe("TelegramDaemonController.status", () => {
	test("reports not_configured when token/chat missing", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(Settings.isolated({}) as Settings, agentDir);
		const status = await new TelegramDaemonController(s).status();
		expect(status.configured).toBe(false);
		expect(status.health).toBe("not_configured");
	});

	test("reports running for a fresh live owner and stale for a dead one", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState());

		const running = await new TelegramDaemonController(s, { pidAlive: () => true }).status();
		expect(running.health).toBe("running");
		expect(running.pid).toBe(999);
		expect(running.ownerId).toBe("old");

		const stale = await new TelegramDaemonController(s, { pidAlive: () => false }).status();
		expect(stale.health).toBe("stale");
	});
});

describe("TelegramDaemonController.reload", () => {
	test("cooperatively stops the old owner and spawns a fresh one", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState());
		fs.writeFileSync(daemonPaths(agentDir).lock, "");

		const alive = new Set<number>([999, 4242]);
		const signals: Array<[number, string]> = [];
		const spawns: Array<{ command: string; args: string[] }> = [];
		const ctrl = new TelegramDaemonController(s, {
			ownerPid: 4242,
			pidAlive: pid => alive.has(pid),
			sendSignal: (pid, sig) => {
				signals.push([pid, sig]);
				if (sig === "SIGTERM") alive.delete(999);
			},
			spawn: (command, args) => {
				spawns.push({ command, args });
				return { unref() {} };
			},
			sleep: async () => undefined,
		});

		const result = await ctrl.reload();
		expect(result.ok).toBe(true);
		expect(signals).toContainEqual([999, "SIGTERM"]);
		expect(spawns).toHaveLength(1);
		const after = JSON.parse(fs.readFileSync(daemonPaths(agentDir).state, "utf8")) as {
			ownerId: string;
			pid: number;
		};
		expect(after.ownerId).not.toBe("old");
		expect(after.ownerId.startsWith("4242-")).toBe(true);
		expect(after.pid).toBe(4242);
		// No leftover control request after a successful reload.
		expect(await readTelegramControlRequest(s)).toBeUndefined();
	});

	test("escalates to SIGKILL when the old owner ignores SIGTERM", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState());
		fs.writeFileSync(daemonPaths(agentDir).lock, "");

		const alive = new Set<number>([999, process.pid]);
		const signals: Array<[number, string]> = [];
		const ctrl = new TelegramDaemonController(s, {
			pidAlive: pid => alive.has(pid),
			sendSignal: (pid, sig) => {
				signals.push([pid, sig]);
				if (sig === "SIGKILL") alive.delete(999);
			},
			spawn: () => ({ unref() {} }),
			sleep: async () => undefined,
			waitStepMs: 1,
		});

		const result = await ctrl.reload({ gracefulTimeoutMs: 5, killTimeoutMs: 50, force: true });
		expect(result.ok).toBe(true);
		expect(signals.some(([, sig]) => sig === "SIGTERM")).toBe(true);
		expect(signals.some(([, sig]) => sig === "SIGKILL")).toBe(true);
	});

	test("does not escalate or kill when ownership changes mid-wait", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState());
		fs.writeFileSync(daemonPaths(agentDir).lock, "");

		const alive = new Set<number>([999, process.pid, 1000]);
		const signals: Array<[number, string]> = [];
		let mutated = false;
		const ctrl = new TelegramDaemonController(s, {
			pidAlive: pid => alive.has(pid),
			// SIGTERM never kills 999 here; ownership changes underneath instead.
			sendSignal: (pid, sig) => signals.push([pid, sig]),
			spawn: () => ({ unref() {} }),
			sleep: async () => {
				if (!mutated) {
					mutated = true;
					writeState(agentDir, freshState({ ownerId: "newer", pid: 1000 }));
				}
			},
			waitStepMs: 1,
		});

		const result = await ctrl.reload({ gracefulTimeoutMs: 50 });
		expect(result.ok).toBe(true);
		// We must never SIGKILL a different/newer owner.
		expect(signals.some(([, sig]) => sig === "SIGKILL")).toBe(false);
		expect(result.warnings.some(w => /live owner|ownership changed/i.test(w))).toBe(true);
	});

	test("without --force, an unresponsive old daemon is not killed or replaced", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState());
		fs.writeFileSync(daemonPaths(agentDir).lock, "");
		const alive = new Set<number>([999, process.pid]);
		const signals: Array<[number, string]> = [];
		let spawnCalls = 0;
		const ctrl = new TelegramDaemonController(s, {
			pidAlive: pid => alive.has(pid),
			sendSignal: (pid, sig) => signals.push([pid, sig]),
			spawn: () => {
				spawnCalls++;
				return { unref() {} };
			},
			sleep: async () => undefined,
			waitStepMs: 1,
		});
		const result = await ctrl.reload({ gracefulTimeoutMs: 5 });
		expect(result.ok).toBe(false);
		expect(signals.some(([, sig]) => sig === "SIGKILL")).toBe(false);
		expect(spawnCalls).toBe(0);
		expect(result.message).toMatch(/--force/);
	});

	test("never spawns while the captured old pid is still alive (stale changed-owner)", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState());
		fs.writeFileSync(daemonPaths(agentDir).lock, "");
		// 999 stays alive; ownership flips to a DEAD different owner (pid 1000 not alive).
		const alive = new Set<number>([999]);
		let spawnCalls = 0;
		let mutated = false;
		const ctrl = new TelegramDaemonController(s, {
			pidAlive: pid => alive.has(pid),
			sendSignal: () => undefined,
			spawn: () => {
				spawnCalls++;
				return { unref() {} };
			},
			sleep: async () => {
				if (!mutated) {
					mutated = true;
					writeState(agentDir, freshState({ ownerId: "stale-newer", pid: 1000 }));
				}
			},
			waitStepMs: 1,
		});
		const result = await ctrl.reload({ gracefulTimeoutMs: 20, force: true });
		// Old pid 999 never died and the changed owner is not live -> must not spawn.
		expect(spawnCalls).toBe(0);
		expect(result.ok).toBe(false);
	});

	test("spawns the fresh owner only after the old pid is confirmed dead (no poll overlap)", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState());
		fs.writeFileSync(daemonPaths(agentDir).lock, "");
		const alive = new Set<number>([999, process.pid]);
		let oldAliveAtSpawn: boolean | undefined;
		const ctrl = new TelegramDaemonController(s, {
			pidAlive: pid => alive.has(pid),
			sendSignal: (_pid, sig) => {
				if (sig === "SIGTERM") alive.delete(999);
			},
			spawn: () => {
				oldAliveAtSpawn = alive.has(999);
				return { unref() {} };
			},
			sleep: async () => undefined,
		});
		const result = await ctrl.reload();
		expect(result.ok).toBe(true);
		// The no-409 invariant: the old poller must be dead before a new one spawns.
		expect(oldAliveAtSpawn).toBe(false);
	});

	test("rejects an unknown kind with a clean error and exit code 1", async () => {
		const prevExit = process.exitCode;
		const orig = process.stderr.write.bind(process.stderr);
		let err = "";
		process.stderr.write = ((chunk: unknown): boolean => {
			err += String(chunk);
			return true;
		}) as typeof process.stderr.write;
		try {
			await runDaemonCommand(
				{ action: "status", kinds: ["bogus" as never], all: false, json: true, force: false },
				{ controllers: undefined },
			);
		} finally {
			process.stderr.write = orig;
		}
		expect(err).toContain("Unknown daemon kind(s): bogus");
		expect(process.exitCode).toBe(1);
		// Reset so this expected non-zero exitCode does not leak into the test runner's exit status.
		process.exitCode = typeof prevExit === "number" ? prevExit : 0;
	});

	test("reload with no running daemon spawns a fresh one (spawnIfStopped default)", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		const spawns: Array<{ command: string; args: string[] }> = [];
		const ctrl = new TelegramDaemonController(s, {
			pidAlive: () => true,
			spawn: (command, args) => {
				spawns.push({ command, args });
				return { unref() {} };
			},
		});
		const result = await ctrl.reload();
		expect(result.ok).toBe(true);
		expect(spawns).toHaveLength(1);
	});
});

describe("TelegramDaemonController.stop", () => {
	test("stops a running owner without spawning a replacement", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState());
		fs.writeFileSync(daemonPaths(agentDir).lock, "");

		const alive = new Set<number>([999]);
		let spawnCalls = 0;
		const ctrl = new TelegramDaemonController(s, {
			pidAlive: pid => alive.has(pid),
			sendSignal: (pid, sig) => {
				if (sig === "SIGTERM") alive.delete(pid);
			},
			spawn: () => {
				spawnCalls++;
				return { unref() {} };
			},
			sleep: async () => undefined,
		});
		const result = await ctrl.stop();
		expect(result.ok).toBe(true);
		expect(spawnCalls).toBe(0);
	});
});

describe("runDaemonCommand", () => {
	function fakeController(status: DaemonStatus, result: DaemonOperationResult): BuiltInDaemonController {
		return {
			kind: "telegram",
			status: async () => status,
			stop: async () => result,
			reload: async () => result,
		};
	}

	test("status --json prints the controller status array", async () => {
		const status: DaemonStatus = {
			kind: "telegram",
			configured: true,
			health: "running",
			pid: 7,
			ownerId: "o1",
			rootCount: 2,
			runtime: { mode: "source", execPath: "/usr/bin/node", reloadPicksUpSourceEdits: true },
		};
		const out = await captureStdout(() =>
			runDaemonCommand(
				{ action: "status", kinds: ["telegram"], all: false, json: true, force: false },
				{ controllers: [fakeController(status, {} as DaemonOperationResult)] },
			),
		);
		const parsed = JSON.parse(out) as DaemonStatus[];
		expect(parsed[0].health).toBe("running");
		expect(parsed[0].ownerId).toBe("o1");
	});

	test("reload prints a human result line", async () => {
		const status: DaemonStatus = {
			kind: "telegram",
			configured: true,
			health: "running",
			runtime: { mode: "source", execPath: "/usr/bin/node", reloadPicksUpSourceEdits: true },
		};
		const result: DaemonOperationResult = {
			kind: "telegram",
			action: "reload",
			ok: true,
			warnings: [],
			message: "reloaded telegram daemon (owner_spawned)",
		};
		const out = await captureStdout(() =>
			runDaemonCommand(
				{ action: "reload", kinds: ["telegram"], all: false, json: false, force: false },
				{ controllers: [fakeController(status, result)] },
			),
		);
		expect(out).toContain("telegram reload: ok");
		expect(out).toContain("reloaded telegram daemon");
	});
});

describe("cli registration", () => {
	test("gjc daemon is registered in the explicit command registry", () => {
		const cliSource = fs.readFileSync(path.join(import.meta.dir, "../src/cli.ts"), "utf8");
		expect(cliSource).toContain('{ name: "daemon"');
		expect(cliSource).toContain('import("./commands/daemon")');
	});
});

describe("topic registry reload persistence", () => {
	test("load() preserves identitySent and name so reload does not resend identity", () => {
		const registry = new TopicRegistry();
		registry.load({
			topics: {
				S1: { topicId: "100", identitySent: true, name: "repo/main - title", createdAt: 1 },
			},
		});
		// identitySent must survive so a reloaded daemon does not re-emit the header.
		expect(registry.needsIdentity("S1")).toBe(false);
		expect(registry.get("S1")?.name).toBe("repo/main - title");
		// topicId routing must also survive.
		expect(registry.sessionForTopic("100")).toBe("S1");
	});
});
