/**
 * Regression for https://github.com/Yeachan-Heo/gajae-code/issues/2956
 *
 * Dead notification roots must prune without poisoning orphan reconciliation,
 * and retained exact-unlink transition/placeholder artifacts must be reaped.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import {
	daemonPaths,
	healTelegramDaemonNotificationState,
	isNotificationLeakArtifactName,
	isPermanentMissingPathError,
	pruneMissingNotificationRoots,
	reapStaleNotificationArtifacts,
	registerNotificationRoot,
	TelegramNotificationDaemon,
} from "../src/sdk/bus/telegram-daemon";

const cleanupDirs: string[] = [];

afterEach(() => {
	for (const dir of cleanupDirs.splice(0)) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
});

function tempAgentDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-tg-selfheal-"));
	cleanupDirs.push(dir);
	return dir;
}

function settings(agentDir: string): Settings {
	const s = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": "tok",
		"notifications.telegram.chatId": "42",
	} as never);
	return new Proxy(s, {
		get(target, property) {
			if (property === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}

describe("telegram daemon self-heal (#2956)", () => {
	test("isPermanentMissingPathError distinguishes ENOENT from other errors", () => {
		expect(isPermanentMissingPathError(Object.assign(new Error("gone"), { code: "ENOENT" }))).toBe(true);
		expect(isPermanentMissingPathError(Object.assign(new Error("not dir"), { code: "ENOTDIR" }))).toBe(true);
		expect(isPermanentMissingPathError(Object.assign(new Error("busy"), { code: "EACCES" }))).toBe(false);
		expect(isPermanentMissingPathError(new Error("plain"))).toBe(false);
	});

	test("isNotificationLeakArtifactName matches quarantine prefixes only", () => {
		expect(isNotificationLeakArtifactName(".gjc-delete-daemon-transition-abc.json")).toBe(true);
		expect(isNotificationLeakArtifactName(".gjc-exact-unlink-placeholder-xyz")).toBe(true);
		expect(isNotificationLeakArtifactName(".gjc-delete-notification-endpoint-1.json")).toBe(true);
		expect(isNotificationLeakArtifactName("telegram-daemon.roots.json")).toBe(false);
		expect(isNotificationLeakArtifactName("normal.json")).toBe(false);
	});

	test("pruneMissingNotificationRoots drops dead roots and keeps live ones", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		const liveCwd = path.join(agentDir, "live");
		const deadCwd = path.join(agentDir, "dead");
		await registerNotificationRoot({ settings: s, cwd: liveCwd, sessionId: "live" });
		await registerNotificationRoot({ settings: s, cwd: deadCwd, sessionId: "dead" });

		const liveRoot = path.join(liveCwd, ".gjc", "state");
		const deadRoot = path.join(deadCwd, ".gjc", "state");
		fs.mkdirSync(path.join(liveRoot, "sdk"), { recursive: true });
		// dead root is registered but never materializes (or is deleted)
		fs.rmSync(deadRoot, { recursive: true, force: true });

		const result = await pruneMissingNotificationRoots({ settings: s });
		expect(result.pruned).toContain(deadRoot);
		expect(result.pruned).not.toContain(liveRoot);
		expect(result.remaining).toBe(1);

		const registry = JSON.parse(fs.readFileSync(daemonPaths(agentDir).roots, "utf8")) as {
			roots: string[];
			sessions: Record<string, string>;
		};
		expect(registry.roots).toEqual([liveRoot]);
		expect(registry.sessions).toEqual({ live: liveRoot });
		expect(registry.sessions.dead).toBeUndefined();
	});

	test("reapStaleNotificationArtifacts removes aged leak files and keeps fresh ones", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		const dir = daemonPaths(agentDir).dir;
		fs.mkdirSync(dir, { recursive: true });
		const aged = path.join(dir, ".gjc-delete-daemon-transition-old.json");
		const fresh = path.join(dir, ".gjc-exact-unlink-placeholder-fresh");
		const keep = path.join(dir, "telegram-daemon.roots.json");
		fs.writeFileSync(aged, "{}");
		fs.writeFileSync(fresh, "{}");
		fs.writeFileSync(keep, "{}");

		const oldTime = new Date(Date.now() - 10 * 60_000);
		fs.utimesSync(aged, oldTime, oldTime);

		const result = await reapStaleNotificationArtifacts({
			settings: s,
			now: () => Date.now(),
			graceMs: 5 * 60_000,
		});
		expect(result.removed.some(p => p.endsWith(".gjc-delete-daemon-transition-old.json"))).toBe(true);
		expect(fs.existsSync(aged)).toBe(false);
		expect(fs.existsSync(fresh)).toBe(true);
		expect(fs.existsSync(keep)).toBe(true);
	});

	test("scanRoots prunes dead roots without disabling orphan cleanup for live roots", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		const liveCwd = path.join(agentDir, "live");
		const deadCwd = path.join(agentDir, "dead");
		await registerNotificationRoot({ settings: s, cwd: liveCwd, sessionId: "S" });
		await registerNotificationRoot({ settings: s, cwd: deadCwd, sessionId: "ghost" });

		const liveRoot = path.join(liveCwd, ".gjc", "state");
		const deadRoot = path.join(deadCwd, ".gjc", "state");
		const sdkDir = path.join(liveRoot, "sdk");
		fs.mkdirSync(sdkDir, { recursive: true });
		fs.writeFileSync(path.join(sdkDir, "S.json"), JSON.stringify({ url: "ws://s", token: "ts" }));
		fs.rmSync(deadRoot, { recursive: true, force: true });

		class FakeWs {
			static instances: FakeWs[] = [];
			readyState = 0;
			sent: string[] = [];
			constructor(public url: string) {
				FakeWs.instances.push(this);
			}
			send(data: string) {
				this.sent.push(String(data));
			}
			close() {}
			addEventListener() {}
			removeEventListener() {}
			dispatchEvent() {
				return true;
			}
		}

		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: {
				call: async () => ({ ok: true, result: {} }),
			} as never,
			WebSocketImpl: FakeWs as never,
			now: () => 0,
		});

		await daemon.scanRoots();

		const registry = JSON.parse(fs.readFileSync(daemonPaths(agentDir).roots, "utf8")) as {
			roots: string[];
			sessions: Record<string, string>;
		};
		expect(registry.roots).toEqual([liveRoot]);
		expect(registry.sessions).toEqual({ S: liveRoot });
		expect(FakeWs.instances.length).toBeGreaterThanOrEqual(1);
		expect(daemon.sessions.has("S")).toBe(true);
	});

	test("healTelegramDaemonNotificationState combines prune and reap", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		const deadCwd = path.join(agentDir, "gone");
		await registerNotificationRoot({ settings: s, cwd: deadCwd, sessionId: "gone" });
		const deadRoot = path.join(deadCwd, ".gjc", "state");
		fs.rmSync(deadRoot, { recursive: true, force: true });

		const dir = daemonPaths(agentDir).dir;
		const leak = path.join(dir, ".gjc-delete-daemon-transition-stale.json");
		fs.writeFileSync(leak, "{}");
		const oldTime = new Date(Date.now() - 60 * 60_000);
		fs.utimesSync(leak, oldTime, oldTime);

		const result = await healTelegramDaemonNotificationState({
			settings: s,
			now: () => Date.now(),
			graceMs: 1_000,
		});
		expect(result.prunedRoots).toContain(deadRoot);
		expect(result.removedArtifacts.some(p => p.endsWith(".gjc-delete-daemon-transition-stale.json"))).toBe(true);
		expect(fs.existsSync(leak)).toBe(false);
	});
});
