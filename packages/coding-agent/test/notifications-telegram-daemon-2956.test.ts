import { expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { tokenFingerprint } from "../src/sdk/bus/config";
import {
	DAEMON_GENERATION,
	DAEMON_VERSION,
	type DaemonState,
	daemonPaths,
	ensureTelegramDaemonRunningDetailed,
	reloadReservationLockOptions,
	renewDaemonHeartbeat,
	type TelegramDaemonFs,
} from "../src/sdk/bus/telegram-daemon";

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-daemon-2956-"));
}

function settings(agentDir: string): Settings {
	const isolated = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": "123456:secret-token",
		"notifications.telegram.chatId": "42",
	}) as Settings;
	return new Proxy(isolated, {
		get(target, prop) {
			if (prop === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}

function daemonFs(readdirOverride?: (dir: string) => Promise<string[]>): TelegramDaemonFs {
	return {
		...(fs.promises as unknown as TelegramDaemonFs),
		mkdir: (file, opts) => fs.promises.mkdir(file, opts).then(() => undefined),
		readFile: (file, encoding) => fs.promises.readFile(file, encoding),
		writeFile: (file, data, opts) => fs.promises.writeFile(file, data, opts).then(() => undefined),
		rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath).then(() => undefined),
		unlink: file => fs.promises.unlink(file),
		open: async (file, flags, mode) => fs.promises.open(file, flags, mode),
		readdir: readdirOverride ?? (file => fs.promises.readdir(file)),
		chmod: (file, mode) => fs.promises.chmod(file, mode),
		stat: file => fs.promises.stat(file),
		readEndpointFile: async file => {
			const bytes = await fs.promises.readFile(file);
			const stat = await fs.promises.lstat(file, { bigint: true });
			return {
				bytes,
				identity: {
					dev: stat.dev,
					ino: stat.ino,
					size: stat.size,
					mtimeNs: stat.mtimeNs,
					sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
				},
			};
		},
		exactUnlink: async (file, identity) => {
			const bytes = await fs.promises.readFile(file).catch(() => undefined);
			if (!bytes) return { ok: false, code: "missing" };
			const stat = await fs.promises.lstat(file, { bigint: true });
			const matches =
				stat.dev === identity.dev &&
				stat.ino === identity.ino &&
				stat.size === identity.size &&
				stat.mtimeNs === identity.mtimeNs &&
				crypto.createHash("sha256").update(bytes).digest("hex") === identity.sha256;
			if (!matches) return { ok: false, code: "identity_mismatch" };
			await fs.promises.unlink(file);
			return { ok: true };
		},
	};
}

function writeLiveOwner(agentDir: string, state: DaemonState): void {
	const paths = daemonPaths(agentDir);
	fs.mkdirSync(paths.dir, { recursive: true });
	fs.writeFileSync(paths.state, JSON.stringify(state));
	fs.writeFileSync(
		paths.lock,
		JSON.stringify({
			pid: state.pid,
			incarnation: state.incarnation,
			ownerId: state.ownerId,
			acquisitionId: state.acquisitionId ?? state.ownerId,
			startedAt: state.startedAt,
		}),
	);
}

test("failed generation reload stays blocked during cooldown and retries after expiry", async () => {
	const agentDir = tempDir();
	const s = settings(agentDir);
	let now = 1_000;
	const signals: Array<[number, NodeJS.Signals]> = [];
	const fsImpl = daemonFs();
	writeLiveOwner(agentDir, {
		pid: 999,
		incarnation: "linux:100",
		ownerId: "old-owner",
		tokenFingerprint: tokenFingerprint("123456:secret-token"),
		chatId: "42",
		startedAt: now,
		heartbeatAt: now,
		roots: [],
		version: DAEMON_VERSION,
		generation: DAEMON_GENERATION - 1,
		acquisitionId: "old-owner",
		ownershipPhase: "ready",
	});
	const attemptPath = path.join(daemonPaths(agentDir).dir, "telegram-daemon.reload-attempt.json");
	fs.writeFileSync(
		attemptPath,
		JSON.stringify({ lastReloadAt: now, ownerId: "old-owner", targetGeneration: DAEMON_GENERATION - 1 }),
	);
	const deps = {
		fs: fsImpl,
		pid: 4242,
		now: () => now,
		pidAlive: (pid: number) => pid === 999,
		pidIncarnation: () => "linux:100",
		processReference: (pid: number) =>
			pid === 999
				? {
						incarnation: "linux:100",
						termination: "cooperative" as const,
						signalRoot: (signal: NodeJS.Signals) => signals.push([pid, signal]),
					}
				: undefined,
		spawn: () => {
			throw new Error("a live predecessor must not be replaced");
		},
		sleep: async (ms: number) => {
			now += ms;
		},
		waitStepMs: 10_000,
		readinessTimeoutMs: 1,
	};

	await expect(
		ensureTelegramDaemonRunningDetailed(
			{ settings: s, cwd: path.join(agentDir, "first-session"), sessionId: "first-session" },
			deps,
		),
	).rejects.toThrow("Unable to replace stale Telegram daemon");
	expect(signals).toEqual([
		[999, "SIGTERM"],
		[999, "SIGKILL"],
	]);
	const firstAttempt = JSON.parse(fs.readFileSync(attemptPath, "utf8")) as {
		lastReloadAt: number;
		targetGeneration: number;
	};
	expect(firstAttempt).toMatchObject({ lastReloadAt: 1_000, targetGeneration: DAEMON_GENERATION });

	await expect(
		ensureTelegramDaemonRunningDetailed(
			{ settings: s, cwd: path.join(agentDir, "second-session"), sessionId: "second-session" },
			deps,
		),
	).resolves.toBe("blocked_identity");
	expect(signals).toHaveLength(2);
	expect(JSON.parse(fs.readFileSync(attemptPath, "utf8"))).toMatchObject(firstAttempt);

	now = 601_000;
	const predecessor = JSON.parse(fs.readFileSync(daemonPaths(agentDir).state, "utf8")) as DaemonState;
	fs.writeFileSync(daemonPaths(agentDir).state, JSON.stringify({ ...predecessor, heartbeatAt: now }));
	await expect(
		ensureTelegramDaemonRunningDetailed(
			{ settings: s, cwd: path.join(agentDir, "third-session"), sessionId: "third-session" },
			deps,
		),
	).rejects.toThrow("Unable to replace stale Telegram daemon");
	expect(signals).toHaveLength(4);
	expect(signals.slice(2)).toEqual([
		[999, "SIGTERM"],
		[999, "SIGKILL"],
	]);
});

test("cooldown never attaches a non-ready servingEpoch predecessor", async () => {
	const agentDir = tempDir();
	const s = settings(agentDir);
	const now = 1_000;
	const signals: Array<[number, NodeJS.Signals]> = [];
	writeLiveOwner(agentDir, {
		pid: 999,
		incarnation: "linux:100",
		ownerId: "provisional-owner",
		tokenFingerprint: tokenFingerprint("123456:secret-token"),
		chatId: "42",
		startedAt: now,
		heartbeatAt: now,
		roots: [],
		version: DAEMON_VERSION,
		generation: DAEMON_GENERATION - 1,
		servingEpoch: undefined,
		acquisitionId: "provisional-owner",
	});
	fs.writeFileSync(
		path.join(daemonPaths(agentDir).dir, "telegram-daemon.reload-attempt.json"),
		JSON.stringify({ lastReloadAt: now, ownerId: "provisional-owner", targetGeneration: DAEMON_GENERATION }),
	);
	const attemptPath = path.join(daemonPaths(agentDir).dir, "telegram-daemon.reload-attempt.json");
	const deps = {
		fs: daemonFs(),
		pid: 4242,
		now: () => now,
		pidAlive: (pid: number) => pid === 999,
		pidIncarnation: () => "linux:100",
		sendSignal: (pid: number, signal: NodeJS.Signals) => signals.push([pid, signal]),
		waitStepMs: 1,
		readinessTimeoutMs: 1,
		sleep: async () => undefined,
		spawn: () => {
			throw new Error("non-ready predecessor must not be replaced");
		},
	};
	for (const sessionId of ["first", "second"]) {
		expect(fs.existsSync(attemptPath)).toBe(true);
		await expect(
			ensureTelegramDaemonRunningDetailed({ settings: s, cwd: path.join(agentDir, sessionId), sessionId }, deps),
		).resolves.toBe("blocked_identity");
	}
	expect(signals).toEqual([]);
});

test("concurrent generation upgrades reserve one reload attempt", async () => {
	const agentDir = tempDir();
	const s = settings(agentDir);
	const now = 1_000;
	const alive = new Set<number>([999, 4242]);
	const signals: Array<[number, NodeJS.Signals]> = [];
	let pending: { ownerId: string; pid: number } | undefined;
	const fsImpl = daemonFs();
	writeLiveOwner(agentDir, {
		pid: 999,
		incarnation: "linux:100",
		ownerId: "old-owner",
		tokenFingerprint: tokenFingerprint("123456:secret-token"),
		chatId: "42",
		startedAt: now,
		heartbeatAt: now,
		roots: [],
		version: DAEMON_VERSION,
		generation: DAEMON_GENERATION - 1,
		acquisitionId: "old-owner",
		ownershipPhase: "ready",
	});
	const deps = {
		fs: fsImpl,
		pid: 4242,
		now: () => now,
		pidAlive: (pid: number) => alive.has(pid),
		pidIncarnation: () => "linux:100",
		processReference: (pid: number) =>
			pid === 999
				? {
						incarnation: "linux:100",
						termination: "cooperative" as const,
						signalRoot: (signal: NodeJS.Signals) => {
							signals.push([pid, signal]);
							if (signal === "SIGTERM") alive.delete(pid);
						},
					}
				: undefined,
		spawn: (_command: string, args: string[]) => {
			const ownerId = args[args.indexOf("--owner-id") + 1]!;
			pending = { ownerId, pid: 4244 };
			alive.add(4244);
			return { pid: 4244, unref() {} };
		},
		sleep: async () => {
			if (!pending) return;
			await renewDaemonHeartbeat({
				settings: s,
				ownerId: pending.ownerId,
				acquisitionId: pending.ownerId,
				pid: pending.pid,
				pidIncarnation: () => "linux:100",
				now: () => now,
				fs: fsImpl,
			});
		},
		waitStepMs: 1,
		readinessTimeoutMs: 10,
	};
	const results = await Promise.all([
		ensureTelegramDaemonRunningDetailed({ settings: s, cwd: path.join(agentDir, "one"), sessionId: "one" }, deps),
		ensureTelegramDaemonRunningDetailed({ settings: s, cwd: path.join(agentDir, "two"), sessionId: "two" }, deps),
	]);
	expect(results).toContain("reloaded");
	expect(signals.filter(([, signal]) => signal === "SIGTERM")).toHaveLength(1);
});

test("reloadReservationLockOptions budgets acquisition beyond the full in-lock reload window", () => {
	const freshnessWaitMs = 15_000;
	const readinessTimeoutMs = 15_000;
	const retryDelayMs = 100;
	const opts = reloadReservationLockOptions({ freshnessWaitMs, readinessTimeoutMs, retryDelayMs });
	// Worst case held under the lock: freshness poll + graceful(8s) + kill(3s) + readiness.
	const worstCaseHeldMs = freshnessWaitMs + 8_000 + 3_000 + readinessTimeoutMs;
	expect(opts.retries * opts.retryDelayMs).toBeGreaterThan(worstCaseHeldMs);
	// Larger injected readiness budgets scale the acquisition window too.
	const bigger = reloadReservationLockOptions({ freshnessWaitMs: 30_000, readinessTimeoutMs: 30_000, retryDelayMs });
	expect(bigger.retries).toBeGreaterThan(opts.retries);
	// Degenerate inputs stay valid (at least one retry, positive delay).
	const floor = reloadReservationLockOptions({ freshnessWaitMs: 0, readinessTimeoutMs: 0, retryDelayMs: 0 });
	expect(floor.retries).toBeGreaterThanOrEqual(1);
	expect(floor.retryDelayMs).toBeGreaterThanOrEqual(1);
});
