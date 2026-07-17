import { describe, expect, it, vi } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import * as native from "@gajae-code/natives";
import { getSessionsDir } from "@gajae-code/utils";

import { lifecycleArgs } from "../src/commands/sdk";
import { Broker } from "../src/sdk/broker/broker";
import * as brokerDiscovery from "../src/sdk/broker/discovery";
import {
	type BrokerDiscovery,
	brokerDiscoveryPath,
	readBrokerDiscovery,
	redactBrokerDiscovery,
	writeBrokerDiscovery,
} from "../src/sdk/broker/discovery";
import {
	brokerOwnerForTest,
	brokerSpawnEnvironmentForTest,
	ensureBroker,
	reapSpawnedBrokerForTest,
	registerBrokerOwnerForTest,
	startFixtureBrokerWithLeaseForTest,
} from "../src/sdk/broker/ensure";
import { getBrokerIdentityKey } from "../src/sdk/broker/identity";
import {
	deriveLifecycleDeadlines,
	readSessionLifecycleLaunchRequest,
	type SessionLifecycleLaunchRequest,
} from "../src/sdk/broker/lifecycle";
import { resolveSdkInternalSpawnCommand, resolveSdkInternalSpawnCommandForTest } from "../src/sdk/broker/runtime";
import { prepareManagedSessionScopeForWrite, resolveManagedScope } from "../src/session/internal/managed-session-scope";
import { SessionManager } from "../src/session/session-manager";
import { FileSessionStorage, type VerifiedSessionDeleteTarget } from "../src/session/session-storage";

const temp = () => fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-"));
async function managedSessionPath(agentDir: string, cwd: string, sessionId: string): Promise<string> {
	await fs.mkdir(cwd, { recursive: true });
	const sessionsRoot = getSessionsDir(agentDir);
	const resolved = resolveManagedScope({ cwd, agentDir, sessionsRoot });
	if (resolved.kind !== "resolved") throw new Error(resolved.message);
	const prepared = await prepareManagedSessionScopeForWrite(resolved.scope);
	if (prepared.kind !== "resolved") throw new Error(prepared.message);
	return path.join(prepared.scope.directoryPath, `${sessionId}.jsonl`);
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const brokerEntrypoint = path.resolve(import.meta.dir, "../src/cli.ts");
const BROKER_PROCESS_STARTUP_TIMEOUT_MS = 10_000;

it("isolates source SDK children and preserves compiled self-spawn", () => {
	const sourceEnvironment = {
		...process.env,
		BUN_OPTIONS: "--inspect",
		PI_COMPILED: "1",
		GJC_COMPILED: "1",
	};
	const source = resolveSdkInternalSpawnCommandForTest("broker-internal", { environment: sourceEnvironment });
	expect(source.kind).toBe("bun-source");
	expect(source.file).toBe(process.execPath);
	expect(source.args).toEqual([
		"--no-env-file",
		`--config=${path.resolve(import.meta.dir, "../src/sdk/broker/internal-source.bunfig.toml")}`,
		path.resolve(import.meta.dir, "../src/cli.ts"),
		"sdk",
		"broker-internal",
	]);
	expect(source.env.BUN_OPTIONS).toBeUndefined();
	expect(source.env.PI_COMPILED).toBeUndefined();
	expect(source.env.GJC_COMPILED).toBeUndefined();
	expect(source.cwd).toBe(path.resolve(import.meta.dir, "../src/sdk/broker"));
	expect(resolveSdkInternalSpawnCommand("broker-internal")).toMatchObject({
		kind: "bun-source",
		file: process.execPath,
	});

	const environment = { PATH: process.env.PATH, BUN_OPTIONS: "--inspect", PI_COMPILED: "spoofed" };
	const markerPath = "/$bunfs/root/internal-source-marker-2178-abcd.txt";
	const compiled = resolveSdkInternalSpawnCommandForTest("session-host-internal", {
		execPath: process.execPath,
		environment,
		markerPath,
		embeddedFiles: [{ name: path.basename(markerPath) }],
	});
	expect(compiled).toEqual({
		kind: "compiled",
		file: process.execPath,
		args: ["sdk", "session-host-internal"],
		env: { PATH: process.env.PATH, PI_COMPILED: "spoofed" },
	});
	expect(compiled.env.BUN_OPTIONS).toBeUndefined();
	const windowsMarkerPath = "C:/~BUN/root/internal-source-marker-2178-abcd.txt";
	expect(
		resolveSdkInternalSpawnCommandForTest("broker-internal", {
			execPath: process.execPath,
			environment,
			markerPath: windowsMarkerPath,
			embeddedFiles: [{ name: path.basename(windowsMarkerPath) }],
		}),
	).toEqual({
		kind: "compiled",
		file: process.execPath,
		args: ["sdk", "broker-internal"],
		env: { PATH: process.env.PATH, PI_COMPILED: "spoofed" },
	});
});

it("treats explicit broker env as a complete allowlist and still scrubs runtime options", () => {
	const command = resolveSdkInternalSpawnCommandForTest("broker-internal", {
		environment: { AMBIENT_SENTINEL: "must-not-leak" },
	});
	const environment = brokerSpawnEnvironmentForTest(command, {
		PATH: process.env.PATH,
		OWNED_SENTINEL: "kept",
		BUN_OPTIONS: "--inspect",
		PI_COMPILED: "spoofed",
		GJC_COMPILED: "spoofed",
	});
	expect(environment).toEqual({ PATH: process.env.PATH, OWNED_SENTINEL: "kept" });
	expect(environment.AMBIENT_SENTINEL).toBeUndefined();
});

it("fails closed when compiled marker evidence disagrees", () => {
	expect(() =>
		resolveSdkInternalSpawnCommandForTest("broker-internal", {
			markerPath: "/$bunfs/root/internal-source-marker-2178-abcd.txt",
			embeddedFiles: [],
		}),
	).toThrow("compiled-runtime marker evidence is inconsistent");
	expect(() =>
		resolveSdkInternalSpawnCommandForTest("broker-internal", {
			markerPath: path.join(import.meta.dir, "../src/sdk/broker/internal-source-marker-2178.txt"),
			embeddedFiles: [{ name: "internal-source-marker-2178.txt" }],
		}),
	).toThrow("compiled-runtime marker evidence is inconsistent");
	for (const evidence of [
		{
			markerPath: "/$bunfs/root/nested/internal-source-marker-2178-abcd.txt",
			embeddedFiles: [{ name: "internal-source-marker-2178-abcd.txt" }],
		},
		{
			markerPath: "/$bunfs/root/internal-source-marker-2178.txt",
			embeddedFiles: [{ name: "internal-source-marker-2178.txt" }],
		},
		{
			markerPath: "C:/project/~BUN/root/internal-source-marker-2178-abcd.txt",
			embeddedFiles: [{ name: "internal-source-marker-2178-abcd.txt" }],
		},
		{
			markerPath: "/$bunfs/root/internal-source-marker-2178-abcd.txt",
			embeddedFiles: [
				{ name: "internal-source-marker-2178-abcd.txt" },
				{ name: "internal-source-marker-2178-abcd.txt" },
			],
		},
	]) {
		expect(() => resolveSdkInternalSpawnCommandForTest("broker-internal", evidence)).toThrow(
			"compiled-runtime marker evidence is inconsistent",
		);
	}
});

it("SDK lifecycle model presets reach the session host parser", async () => {
	const agentDir = await temp();
	const cwd = path.join(agentDir, "repo");
	await fs.mkdir(cwd);
	const request = readSessionLifecycleLaunchRequest(
		JSON.stringify({
			operation: "session.create",
			sessionId: "session-1",
			stateRoot: path.join(cwd, ".gjc", "state"),
			cwd,
			modelPreset: "codex-eco",
			...deriveLifecycleDeadlines(Date.now(), 10_000),
		}),
	);
	try {
		expect((await lifecycleArgs(request, cwd, agentDir)).mpreset).toBe("codex-eco");
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

it("initializes the managed target scope before lifecycle fork arguments expose it", async () => {
	const agentDir = await temp();
	const cwd = path.join(agentDir, "fork-target");
	await fs.mkdir(cwd);
	const request: SessionLifecycleLaunchRequest = {
		operation: "session.fork",
		sessionId: "fork-destination",
		cwd,
		stateRoot: path.join(cwd, ".gjc", "state"),
		...deriveLifecycleDeadlines(Date.now(), 10_000),
		sourceCwd: cwd,
		sourceSessionId: "source-session",
		sourceSessionPath: path.join(cwd, "source.jsonl"),
		sourceSessionIdentity: { dev: "1", ino: "2", size: 3, mtimeMs: 4, mtimeNs: "5", sha256: "a".repeat(64) },
	};
	try {
		const args = await lifecycleArgs(request, cwd, agentDir);
		expect(args.sessionDir).toEqual(expect.any(String));
		expect(syncFs.existsSync(path.join(args.sessionDir!, ".gjc-managed-session-scope.v2.json"))).toBe(true);
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

it("SDK lifecycle launch requests require a worktree identity", () => {
	expect(() =>
		readSessionLifecycleLaunchRequest(
			JSON.stringify({ operation: "session.create", sessionId: "session-1", stateRoot: "/state" }),
		),
	).toThrow("GJC_SDK_LIFECYCLE_REQUEST is invalid.");
});
it("SDK lifecycle transcript authority requires and preserves a full sha256 identity", () => {
	const cwd = "/workspace/repo";
	const request = {
		operation: "session.resume",
		sessionId: "session-1",
		stateRoot: path.join(cwd, ".gjc", "state"),
		cwd,
		sessionPath: "/agent/sessions/session-1.jsonl",
		sessionIdentity: {
			dev: "1",
			ino: "2",
			size: 3,
			mtimeMs: 4,
			mtimeNs: "5",
			sha256: "a".repeat(64),
		},
		...deriveLifecycleDeadlines(Date.now(), 10_000),
	};
	expect(readSessionLifecycleLaunchRequest(JSON.stringify(request)).sessionIdentity?.sha256).toBe("a".repeat(64));
	const { sha256: _sha256, ...withoutHash } = request.sessionIdentity;
	expect(() =>
		readSessionLifecycleLaunchRequest(JSON.stringify({ ...request, sessionIdentity: withoutHash })),
	).toThrow("GJC_SDK_LIFECYCLE_REQUEST is invalid.");
});

async function waitForDiscovery(agentDir: string, children?: Bun.Subprocess[]) {
	const deadline = Date.now() + BROKER_PROCESS_STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const discovery = await readBrokerDiscovery(agentDir);
		if (discovery) return discovery;
		if (children?.every(child => child.exitCode !== null)) {
			throw new Error(
				`All broker contenders exited before discovery (codes=${children.map(child => child.exitCode).join(",")}).`,
			);
		}
		await sleep(20);
	}
	throw new Error("Timed out waiting for broker discovery.");
}
describe("SDK broker identity and discovery", () => {
	it("persists identity and writes a redacted private discovery record", async () => {
		const dir = await temp();
		const a = await getBrokerIdentityKey(dir);
		expect(await getBrokerIdentityKey(dir)).toBe(a);
		const d = {
			version: 1 as const,
			protocolVersion: 3 as const,
			packageGeneration: "test",
			ownerId: "x",
			pid: process.pid,
			host: "127.0.0.1" as const,
			port: 1,
			url: "ws://127.0.0.1:1",
			token: "secret",
			startedAt: 1,
			heartbeatAt: Date.now(),
		};
		await writeBrokerDiscovery(dir, d);
		const persisted = await readBrokerDiscovery(dir);
		expect(persisted).not.toBeNull();
		expect(redactBrokerDiscovery(persisted!).token).toBe("[redacted]");
		if (process.platform !== "win32")
			expect((await fs.stat(path.join(dir, "sdk", "broker.json"))).mode & 0o777).toBe(0o600);
	});

	it("keeps the temp broker.json fsync fail-closed even for EPERM (not shared with the directory barrier)", async () => {
		const dir = await temp();
		const realOpen = fs.open.bind(fs);
		const spy = vi.spyOn(fs, "open").mockImplementation((async (p: string, ...rest: unknown[]) => {
			const handle = await (realOpen as (p: string, ...r: unknown[]) => Promise<fs.FileHandle>)(p, ...rest);
			if (String(p).endsWith(".tmp"))
				(handle as unknown as { sync: () => Promise<void> }).sync = async () => {
					throw Object.assign(new Error("EPERM file fsync"), { code: "EPERM" });
				};
			return handle;
		}) as typeof fs.open);
		try {
			await expect(
				writeBrokerDiscovery(dir, {
					version: 1,
					protocolVersion: 3,
					packageGeneration: "test",
					ownerId: "x",
					pid: process.pid,
					host: "127.0.0.1",
					port: 1,
					url: "ws://127.0.0.1:1",
					token: "secret",
					startedAt: 1,
					heartbeatAt: Date.now(),
				}),
			).rejects.toMatchObject({ code: "EPERM" });
		} finally {
			spy.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not blanket-tolerate directory fsync failures (tolerance is win32-scoped only)", async () => {
		if (process.platform === "win32") return;
		const dir = await temp();
		const sdkDir = path.dirname(brokerDiscoveryPath(dir));
		const realOpen = fs.open.bind(fs);
		const spy = vi.spyOn(fs, "open").mockImplementation((async (p: string, ...rest: unknown[]) => {
			const handle = await (realOpen as (p: string, ...r: unknown[]) => Promise<fs.FileHandle>)(p, ...rest);
			if (path.resolve(String(p)) === path.resolve(sdkDir))
				(handle as unknown as { sync: () => Promise<void> }).sync = async () => {
					throw Object.assign(new Error("EIO dir fsync"), { code: "EIO" });
				};
			return handle;
		}) as typeof fs.open);
		try {
			await expect(
				writeBrokerDiscovery(dir, {
					version: 1,
					protocolVersion: 3,
					packageGeneration: "test",
					ownerId: "x",
					pid: process.pid,
					host: "127.0.0.1",
					port: 1,
					url: "ws://127.0.0.1:1",
					token: "secret",
					startedAt: 1,
					heartbeatAt: Date.now(),
				}),
			).rejects.toMatchObject({ code: "EIO" });
		} finally {
			spy.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects discovery bound to a different process incarnation", async () => {
		const dir = await temp();
		await writeBrokerDiscovery(dir, {
			version: 1,
			protocolVersion: 3,
			packageGeneration: "test",
			ownerId: "stale",
			pid: process.pid,
			incarnation: "different-incarnation",
			host: "127.0.0.1",
			port: 1,
			url: "ws://127.0.0.1:1",
			token: "secret",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		});

		expect(await readBrokerDiscovery(dir)).toBeNull();
		await fs.rm(dir, { recursive: true, force: true });
	});
	it("treats a truncated discovery record as unavailable", async () => {
		const dir = await temp();
		await fs.mkdir(path.dirname(brokerDiscoveryPath(dir)), { recursive: true });
		await fs.writeFile(brokerDiscoveryPath(dir), '{"version":1,"pid":');
		expect(await readBrokerDiscovery(dir)).toBeNull();
		await fs.rm(dir, { recursive: true, force: true });
	});
	it("refreshes discovery heartbeat, removes it on stop, and can restart", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir, heartbeatTtlMs: 45 });
		const first = await broker.start();
		const deadline = Date.now() + 5_000;
		let refreshed = await readBrokerDiscovery(dir);
		while ((!refreshed || refreshed.heartbeatAt <= first.heartbeatAt) && Date.now() < deadline) {
			await sleep(10);
			refreshed = await readBrokerDiscovery(dir);
		}
		expect(refreshed?.heartbeatAt).toBeGreaterThan(first.heartbeatAt);
		await broker.stop();
		await expect(fs.stat(brokerDiscoveryPath(dir))).rejects.toThrow();
		const restarted = await ensureBroker({ agentDir: dir });
		expect(restarted.token).not.toBe(first.token);
		const owner = (await import("../src/sdk/broker/ensure")).brokerOwnerForTest(dir);
		await owner?.stop();
	}, 15_000);
	it("terminates and reaps the spawned broker when discovery times out", async () => {
		const dir = await temp();
		// Force ensureBroker's discovery reads to never resolve a live record so the
		// discovery wait is doomed from the start. The real broker still spawns and
		// stays alive as a detached daemon, which is exactly the orphan path the reap
		// must close. Capture its pid from the discovery file (bypassing the spy)
		// before ensureBroker times out and reaps it.
		const spy = vi.spyOn(brokerDiscovery, "readBrokerDiscovery").mockResolvedValue(null);
		try {
			const { promise: gotPid, resolve: onPid } = Promise.withResolvers<number | undefined>();
			void (async () => {
				const deadline = Date.now() + 12_000;
				while (Date.now() < deadline) {
					try {
						const raw = JSON.parse(await fs.readFile(brokerDiscovery.brokerDiscoveryPath(dir), "utf8")) as {
							pid?: number;
						};
						if (typeof raw.pid === "number") return onPid(raw.pid);
					} catch {}
					await sleep(25);
				}
				onPid(undefined);
			})();
			await expect(ensureBroker({ agentDir: dir })).rejects.toThrow(
				"Timed out waiting for detached SDK broker discovery.",
			);
			const brokerPid = await gotPid;
			// The spawned detached broker must have been terminated + reaped, not orphaned.
			expect(typeof brokerPid).toBe("number");
			expect(brokerDiscovery.isPidAlive(brokerPid!)).toBe(false);
			// No owner handle leaked for the failed agent dir.
			expect(brokerOwnerForTest(dir)).toBeUndefined();
		} finally {
			spy.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
	it("fails fast and reaps the spawned broker when it exits before discovery", async () => {
		const dir = await temp();
		// Plant an unsupported session-index snapshot so the spawned broker's start()
		// rejects immediately and it exits before publishing discovery. ensureBroker
		// must take the early-exit path (not the 10s timeout) and leave no orphan.
		await fs.mkdir(path.join(dir, "sdk", "sessions"), { recursive: true });
		await fs.writeFile(path.join(dir, "sdk", "sessions", "index.snapshot.json"), JSON.stringify({ version: 99 }));
		await expect(ensureBroker({ agentDir: dir })).rejects.toThrow(/exited before discovery/);
		// No owner handle leaked for the failed agent dir.
		expect(brokerOwnerForTest(dir)).toBeUndefined();
		// No discovery record was published: the broker exited before writing one.
		await expect(fs.stat(brokerDiscoveryPath(dir))).rejects.toThrow();
		await fs.rm(dir, { recursive: true, force: true });
	}, 15_000);
	it("escalates to SIGKILL and awaits verified exit when a live child emits error after SIGTERM", async () => {
		// Reproduces the PR #2157 review blocker: a still-live broker child emits
		// `error` during SIGTERM (e.g. a transient signal-delivery failure). The
		// reaper must treat that as diagnostic only, escalate to SIGKILL, and await
		// an actual exit/close — never resolve on `error` alone and orphan the child.
		// This condition is not deterministically reproducible with a real OS process,
		// so a controllable child surface drives the exact reap control flow. Before
		// the fix the `error` event resolved the wait as if the child had exited, so
		// SIGKILL was never reached and the process stayed alive.
		const signals: NodeJS.Signals[] = [];
		const child = Object.assign(new EventEmitter(), {
			pid: 4242,
			exitCode: null as number | null,
			signalCode: null as NodeJS.Signals | null,
			kill(sig: NodeJS.Signals): boolean {
				signals.push(sig);
				if (sig === "SIGTERM") {
					// Still-live child surfaces an error mid-teardown without exiting.
					queueMicrotask(() => child.emit("error", new Error("signal delivery failed during teardown")));
					return true;
				}
				if (sig === "SIGKILL") {
					queueMicrotask(() => {
						child.signalCode = "SIGKILL";
						child.emit("exit", null, "SIGKILL");
					});
					return true;
				}
				return false;
			},
		});
		// Production always retains ensureBroker's spawn-error listener on the child;
		// keep one here so emitting `error` matches that surface (and is not fatal).
		child.on("error", () => {});
		await expect(reapSpawnedBrokerForTest(child as unknown as ChildProcess)).resolves.toBeUndefined();
		// SIGTERM's emitted `error` must NOT count as exit: escalation reached SIGKILL.
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		// Termination was proven by an observed exit, not by the earlier `error`.
		expect(child.signalCode).toBe("SIGKILL");
	}, 10_000);

	it("does not signal a child whose exit is already authoritative", async () => {
		const signals: NodeJS.Signals[] = [];
		const child = Object.assign(new EventEmitter(), {
			pid: 4243,
			exitCode: 0 as number | null,
			signalCode: null as NodeJS.Signals | null,
			kill(sig: NodeJS.Signals): boolean {
				signals.push(sig);
				return true;
			},
		});

		await reapSpawnedBrokerForTest(child as unknown as ChildProcess, { gracefulMs: 1, killVerifyMs: 1 });

		expect(signals).toEqual([]);
	});
	it("reaps a spawn failure with no process as a no-op instead of waiting on SIGKILL", async () => {
		// A spawn failure (e.g. ENOENT) never created a kernel process: pid is
		// undefined and there is nothing to signal or await. Reaping must be a no-op
		// rather than running out the SIGKILL cap and reporting a stuck child that
		// never existed — the distinct failure this owner must keep closed.
		const child = Object.assign(new EventEmitter(), {
			pid: undefined,
			exitCode: null as number | null,
			signalCode: null as NodeJS.Signals | null,
			kill: (): boolean => false,
		});
		await expect(reapSpawnedBrokerForTest(child as unknown as ChildProcess)).resolves.toBeUndefined();
	}, 10_000);

	it("retains unverified broker authority and fences replacement startup", async () => {
		const dir = await temp();
		const signals: NodeJS.Signals[] = [];
		const child = Object.assign(new EventEmitter(), {
			pid: 4244,
			exitCode: null as number | null,
			signalCode: null as NodeJS.Signals | null,
			kill(sig: NodeJS.Signals): boolean {
				signals.push(sig);
				return true;
			},
		});
		const owner = registerBrokerOwnerForTest(dir, child as unknown as ChildProcess, {
			gracefulMs: 1,
			killVerifyMs: 1,
		});
		const competingDiscovery: BrokerDiscovery = {
			version: 1,
			protocolVersion: 3,
			packageGeneration: "test",
			ownerId: "competitor",
			pid: process.pid,
			incarnation: "competing-incarnation",
			host: "127.0.0.1",
			port: 1,
			url: "ws://127.0.0.1:1",
			token: "competitor-token",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		};
		const spy = vi.spyOn(brokerDiscovery, "readBrokerDiscovery").mockResolvedValue(competingDiscovery);
		try {
			await expect(owner.stop()).rejects.toThrow("did not exit after SIGKILL");
			expect(brokerOwnerForTest(dir)).toBe(owner);

			// A new ensure must retry the exact retained owner and reject; it may not
			// discard that authority handle and spawn a replacement.
			await expect(ensureBroker({ agentDir: dir })).rejects.toThrow("did not exit after SIGKILL");
			expect(brokerOwnerForTest(dir)).toBe(owner);
			expect(signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"]);

			child.signalCode = "SIGKILL";
			await owner.stop();
			expect(brokerOwnerForTest(dir)).toBeUndefined();
		} finally {
			spy.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not let a stale stop handle delete its successor owner", async () => {
		const dir = await temp();
		const exitedChild = (pid: number) =>
			Object.assign(new EventEmitter(), {
				pid,
				exitCode: 0 as number | null,
				signalCode: null as NodeJS.Signals | null,
				kill: (): boolean => true,
			});
		const first = registerBrokerOwnerForTest(dir, exitedChild(4245) as unknown as ChildProcess);
		const successor = registerBrokerOwnerForTest(dir, exitedChild(4246) as unknown as ChildProcess);

		await first.stop();
		expect(brokerOwnerForTest(dir)).toBe(successor);
		await successor.stop();
		expect(brokerOwnerForTest(dir)).toBeUndefined();
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("shares one in-process startup and owner across concurrent ensure calls", async () => {
		const dir = await temp();
		const first = ensureBroker({ agentDir: dir });
		const second = ensureBroker({ agentDir: dir });

		expect(second).toBe(first);
		const [left, right] = await Promise.all([first, second]);
		expect(right).toEqual(left);
		const owner = brokerOwnerForTest(dir);
		expect(owner).toBeDefined();
		await owner?.stop();
		expect(brokerOwnerForTest(dir)).toBeUndefined();
		await fs.rm(dir, { recursive: true, force: true });
	});
	it("leaves exactly one live detached broker after concurrent process startup", async () => {
		const dir = await temp();
		const children = [0, 1].map(() =>
			Bun.spawn([process.execPath, "run", brokerEntrypoint, "sdk", "broker-internal", "--agent-dir", dir], {
				stdout: "ignore",
				stderr: "ignore",
			}),
		);
		try {
			const discovery = await waitForDiscovery(dir, children);
			// The losing broker exits once it observes the winner's discovery record.
			// Poll instead of a fixed delay so the assertion is robust to CI scheduling
			// (the loser's exit can lag the discovery write under load).
			for (let attempt = 0; attempt < 200 && children.every(child => child.exitCode === null); attempt++)
				await sleep(25);
			const exited = children.filter(child => child.exitCode !== null);
			expect(exited).toHaveLength(1);
			const owner = children.find(child => child.exitCode === null);
			expect(owner).toBeDefined();
			expect(discovery.pid).toBe(owner!.pid!);
			process.kill(discovery.pid, "SIGTERM");
			await Promise.all(children.map(child => child.exited));
		} finally {
			for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
			await Promise.all(children.map(child => child.exited));
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 20_000);
	it("returns only an endpoint bound to the indexed incarnation", async () => {
		const dir = await temp();
		const stateRoot = path.join(dir, "state");
		const endpointPath = path.join(stateRoot, "sdk", "s.json");
		const broker = new Broker({ agentDir: dir });
		await broker.index.open();
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(endpointPath, JSON.stringify({ sessionId: "s", pid: process.pid, token: "session-secret" }));
		const endpointMtimeMs = (await fs.stat(endpointPath)).mtimeMs;
		await broker.index.append({
			type: "host_registered",
			sessionId: "s",
			locator: { repo: "r", stateRoot },
			endpointGeneration: 3,
			pid: process.pid,
			endpointMtimeMs,
		});
		const endpointIncarnation = createHash("sha256")
			.update(JSON.stringify({ endpointGeneration: 3, endpointMtimeMs, pid: process.pid, sessionId: "s" }))
			.digest("hex");
		expect(
			await broker.handleRequest("session.get_endpoint", {
				sessionId: "s",
				endpointGeneration: 3,
				endpointIncarnation,
			}),
		).toEqual({
			ok: true,
			result: { sessionId: "s", pid: process.pid, token: "session-secret" },
		});
		expect(
			await broker.handleRequest("session.get_endpoint", {
				sessionId: "s",
				endpointGeneration: 3,
				endpointIncarnation: "0".repeat(64),
			}),
		).toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "session endpoint is stale" },
		});
		expect(await broker.handleRequest("session.get_endpoint", { sessionId: "s", endpointGeneration: 2 })).toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "session endpoint is stale" },
		});
		await broker.index.append({
			type: "host_registered",
			sessionId: "s",
			locator: { repo: "r", stateRoot },
			endpointGeneration: 4,
			pid: process.pid,
			endpointMtimeMs: endpointMtimeMs + 1,
		});
		expect(await broker.handleRequest("session.get_endpoint", { sessionId: "s", endpointGeneration: 4 })).toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "session endpoint is stale" },
		});
	});
	it("rejects a cross-scope live resume without returning the indexed endpoint", async () => {
		const dir = await temp();
		const liveCwd = path.join(dir, "live-workspace");
		const requestedCwd = path.join(dir, "requested-workspace");
		await fs.mkdir(liveCwd, { recursive: true });
		await fs.mkdir(requestedCwd, { recursive: true });
		const stateRoot = path.join(liveCwd, ".gjc", "state");
		const sessionId = "shared-live-session";
		const sessionDir = SessionManager.getDefaultSessionDir(liveCwd, dir);
		const sessionPath = path.join(sessionDir, `${sessionId}.jsonl`);
		const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
		const broker = new Broker({ agentDir: dir });
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.mkdir(sessionDir, { recursive: true });
		await fs.writeFile(
			sessionPath,
			`${JSON.stringify({ type: "session", id: sessionId, timestamp: new Date().toISOString(), cwd: liveCwd })}\n`,
		);
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId, pid: process.pid, token: "foreign-workspace-token" }),
		);
		await broker.start();
		try {
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator: { repo: liveCwd, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
				endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
			});
			const result = await broker.handleRequest(
				"session.resume",
				{
					cwd: requestedCwd,
					target: { path: requestedCwd },
					sessionId,
					sessionPath,
				},
				"cross-scope-resume",
			);
			expect(result).toEqual({
				ok: false,
				error: {
					code: "endpoint_stale",
					message: "Live session does not match the requested resume scope.",
				},
			});
			expect(JSON.stringify(result)).not.toContain("foreign-workspace-token");
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("replays only the same lifecycle body and conflicts when a caller reuses its key for the same target", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir });
		await broker.start();
		try {
			const input = { sessionId: "saved", sessionPath: path.join(dir, "missing.json"), trace: "first" };
			const first = await broker.handleRequest("session.delete", input, "caller-key");
			expect(await broker.handleRequest("session.delete", input, "caller-key")).toEqual(first);
			expect(await broker.handleRequest("session.delete", { ...input, trace: "changed" }, "caller-key")).toEqual({
				ok: false,
				error: { code: "idempotency_conflict", message: "idempotency key was used with a different request" },
			});
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("binds session.delete to the requested session header and configured storage root", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "repo");
		const sessions = path.join(getSessionsDir(dir), "project");
		const requested = path.join(sessions, "requested.jsonl");
		const other = path.join(sessions, "other.jsonl");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(sessions, { recursive: true });
		await fs.writeFile(requested, `${JSON.stringify({ type: "session", id: "requested" })}\n`);
		await fs.writeFile(other, `${JSON.stringify({ type: "session", id: "other" })}\n`);
		const broker = new Broker({ agentDir: dir });
		await broker.start();
		try {
			expect(
				await broker.handleRequest(
					"session.delete",
					{ sessionId: "requested", sessionPath: other, cwd },
					"delete-cross-session",
				),
			).toEqual({
				ok: false,
				error: {
					code: "invalid_input",
					message: "session.delete path is not an owned managed session for the configured cwd.",
				},
			});
			expect(await fs.readFile(other, "utf8")).toContain('"other"');
			expect(
				await broker.handleRequest(
					"session.delete",
					{ sessionId: "requested", sessionPath: path.join(dir, "outside.jsonl"), cwd },
					"delete-outside-root",
				),
			).toEqual({
				ok: false,
				error: {
					code: "invalid_input",
					message: "session.delete path is not an owned managed session for the configured cwd.",
				},
			});
			expect(await fs.readFile(requested, "utf8")).toContain('"requested"');
			const external = path.join(dir, "external.jsonl");
			const externalArtifacts = external.slice(0, -6);
			const linked = path.join(sessions, "linked.jsonl");
			await fs.writeFile(external, `${JSON.stringify({ type: "session", id: "requested" })}\n`);
			await fs.mkdir(externalArtifacts);
			await fs.symlink(external, linked);
			expect(
				await broker.handleRequest(
					"session.delete",
					{ sessionId: "requested", sessionPath: linked, cwd },
					"delete-symlink-escape",
				),
			).toEqual({
				ok: false,
				error: {
					code: "invalid_input",
					message: "session.delete path is not an owned managed session for the configured cwd.",
				},
			});
			expect(await fs.readFile(external, "utf8")).toContain('"requested"');
			expect((await fs.stat(externalArtifacts)).isDirectory()).toBe(true);
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("rejects traversal and conflicting session-id aliases before lifecycle state access", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir });
		try {
			expect(await broker.handleRequest("session.get_endpoint", { sessionId: "../escape" })).toEqual({
				ok: false,
				error: { code: "invalid_input", message: "sessionId must be a canonical safe identifier" },
			});
			expect(
				await broker.handleRequest("session.close", { sessionId: "session-a", id: "session-b" }, "alias-conflict"),
			).toEqual({ ok: false, error: { code: "invalid_input", message: "sessionId aliases conflict" } });
			await expect(fs.stat(path.join(dir, "sdk", "escape.json"))).rejects.toThrow();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("replays id and sessionId lifecycle aliases under one caller idempotency key", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir });
		await broker.start();
		try {
			const first = await broker.handleRequest("session.close", { sessionId: "missing" }, "same-close");
			expect(await broker.handleRequest("session.close", { id: "missing" }, "same-close")).toEqual(first);
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects a non-default lifecycle state root at broker ingress", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir });
		try {
			expect(
				await broker.handleRequest(
					"session.create",
					{ cwd: dir, stateRoot: path.join(dir, "alternate-state") },
					"alternate-state-root",
				),
			).toEqual({
				ok: false,
				error: { code: "invalid_input", message: "stateRoot must be the default .gjc/state for cwd." },
			});
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("uses verified deletion to remove the exact transcript, artifacts, and indexed authority", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "workspace");
		const stateRoot = path.join(cwd, ".gjc", "state");
		const sessionId = "verified-delete";
		const sessionPath = await managedSessionPath(dir, cwd, sessionId);
		const artifactsDir = sessionPath.slice(0, -6);
		const broker = new Broker({ agentDir: dir });
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
		await fs.mkdir(artifactsDir);
		await fs.writeFile(path.join(artifactsDir, "artifact.txt"), "artifact");
		await broker.start();
		try {
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator: { repo: cwd, stateRoot },
				endpointGeneration: 1,
				pid: 999_999_999,
			});
			expect(
				await broker.handleRequest("session.delete", { sessionId, sessionPath, cwd }, "verified-delete-key"),
			).toEqual({ ok: true, result: { sessionId } });
			await expect(fs.stat(sessionPath)).rejects.toThrow();
			await expect(fs.stat(artifactsDir)).rejects.toThrow();
			expect(await broker.handleRequest("session.list", {})).toMatchObject({
				ok: true,
				result: { sessions: [] },
			});
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("preserves typed verified-delete partial-cleanup evidence", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "workspace");
		const sessionId = "pending-delete";
		const sessionPath = await managedSessionPath(dir, cwd, sessionId);
		const broker = new Broker({ agentDir: dir });
		const originalDelete = FileSessionStorage.prototype.deleteSessionVerified;
		let detachedArtifactsPath: string | undefined;
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
		await broker.start();
		FileSessionStorage.prototype.deleteSessionVerified = async target => {
			detachedArtifactsPath = target.plannedArtifactsPath;
			if (!detachedArtifactsPath) throw new Error("Missing planned artifact path");
			return {
				kind: "cleanup_pending" as const,
				phase: "artifacts" as const,
				error: new Error("artifact cleanup denied"),
				artifactsIdentity: { dev: 7n, ino: 8n, size: 9, mtimeNs: 10n, sha256: "a".repeat(64) },
				artifactsTree: { rootDev: "7", rootIno: "8", entries: [] },
				detachedArtifactsPath,
				transcriptIdentity: { dev: 5n, ino: 6n, size: 7, mtimeNs: 8n, sha256: "b".repeat(64) },
			};
		};
		try {
			const pending = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"pending-delete-key",
			);
			expect(pending).toMatchObject({
				ok: false,
				error: {
					code: "cleanup_pending",
					message: "Saved session cleanup is pending in artifacts: artifact cleanup denied",
					cleanup: {
						phase: "artifacts",
						sessionId,
						cwd,
						sessionsRoot: path.join(dir, "sessions"),
						transcriptPath: sessionPath,
						metadataRoot: path.join(cwd, ".gjc", "state"),
						artifactsIdentity: { dev: "7", ino: "8", size: 9, mtimeNs: "10", sha256: "a".repeat(64) },
						transcriptIdentity: { dev: "5", ino: "6", size: 7, mtimeNs: "8", sha256: "b".repeat(64) },
						detachedArtifactsPath,
					},
				},
			});
			if (!pending.ok) {
				expect(pending.error.cleanup?.plannedArtifactsPath).toMatch(/\.gjc-delete-[\w-]+-artifacts$/);
				expect(pending.error.cleanup?.plannedTranscriptPath).toMatch(/\.gjc-delete-[\w-]+-transcript$/);
			}
			const retried = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"pending-delete-key",
			);
			expect(retried).toMatchObject({ ok: false, error: { code: "cleanup_pending" } });
			if (!pending.ok && !retried.ok) {
				expect(retried.error.cleanup?.plannedArtifactsPath).not.toBe(pending.error.cleanup?.plannedArtifactsPath);
				expect(retried.error.cleanup?.detachedArtifactsPath).toBe(retried.error.cleanup?.plannedArtifactsPath);
			}
			expect(await fs.readFile(sessionPath, "utf8")).toContain(sessionId);
		} finally {
			FileSessionStorage.prototype.deleteSessionVerified = originalDelete;
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("replays transcript cleanup after artifact completion without reattaching completed artifact authority", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "workspace");
		const sessionId = "artifacts-removed-replay";
		const sessionPath = await managedSessionPath(dir, cwd, sessionId);
		const broker = new Broker({ agentDir: dir });
		const originalDelete = FileSessionStorage.prototype.deleteSessionVerified;
		const transcriptIdentity = { dev: 5n, ino: 6n, size: 7, mtimeNs: 8n, sha256: "b".repeat(64) };
		const deleteTargets: VerifiedSessionDeleteTarget[] = [];
		let calls = 0;
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
		await broker.start();
		FileSessionStorage.prototype.deleteSessionVerified = async target => {
			deleteTargets.push(target);
			calls++;
			if (calls === 1) return { kind: "artifacts_removed", phase: "artifacts", transcriptIdentity };
			if (calls === 2)
				return {
					kind: "cleanup_pending",
					phase: "transcript",
					error: new Error("transcript cleanup deferred"),
					transcriptIdentity,
				};
			return { kind: "deleted" };
		};
		try {
			const pending = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"artifacts-removed-replay-key",
			);
			expect(pending).toMatchObject({
				ok: false,
				error: {
					code: "cleanup_pending",
					cleanup: { artifactsRemoved: true, phase: "transcript" },
				},
			});
			await fs.unlink(sessionPath);
			const replayed = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"artifacts-removed-replay-key",
			);
			expect(replayed).toMatchObject({ ok: true, result: { sessionId } });
			expect(deleteTargets).toHaveLength(2);
			expect(deleteTargets[1]).toMatchObject({ artifactsRemoved: true });
			expect(deleteTargets[1]?.expectedArtifactsIdentity).toBeUndefined();
			expect(deleteTargets[1]?.expectedArtifactsTree).toBeUndefined();
			expect(deleteTargets[1]?.detachedArtifactsPath).toBeUndefined();
		} finally {
			FileSessionStorage.prototype.deleteSessionVerified = originalDelete;
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("retries cleanup pending after restart, then reopens and exactly replays successful metadata cleanup", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "workspace");
		const stateRoot = path.join(cwd, ".gjc", "state");
		const sessionId = "metadata-cleanup-pending";
		const sessionPath = await managedSessionPath(dir, cwd, sessionId);
		const markerPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
		let broker = new Broker({ agentDir: dir });
		const originalUnlink = native.exactUnlink;
		let detachedQ1: string | undefined;
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
		await fs.mkdir(path.dirname(markerPath), { recursive: true });
		await fs.writeFile(
			markerPath,
			JSON.stringify({ pid: 2_147_483_647, effectMarker: "metadata", incarnation: "test" }),
		);
		await broker.start();
		vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (pathname === markerPath) {
				detachedQ1 = path.join(path.dirname(markerPath), identity.quarantineName!);
				syncFs.renameSync(markerPath, detachedQ1);
				return { ok: false, code: "io_error", detachedPath: detachedQ1 };
			}
			return originalUnlink(pathname, identity);
		});
		try {
			const pending = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"metadata-cleanup-pending-key",
			);
			expect(structuredClone(pending)).toMatchObject({
				ok: false,
				error: {
					code: "cleanup_pending",
					cleanup: {
						phase: "lifecycle",
						lifecycleFiles: [
							expect.objectContaining({
								path: markerPath,
								identity: expect.objectContaining({ sha256: expect.any(String) }),
								plannedPath: detachedQ1,
								detachedPath: detachedQ1,
							}),
						],
					},
				},
			});
			if (!detachedQ1) throw new Error("Native metadata detach did not produce Q1");
			expect(await fs.stat(markerPath).catch(() => undefined)).toBeUndefined();
			expect(await fs.stat(detachedQ1)).toBeDefined();
			const ledgerRows = (await fs.readFile(path.join(dir, "sdk", "lifecycle-ledger.jsonl"), "utf8"))
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line) as Record<string, unknown>);
			expect(ledgerRows).toContainEqual(
				expect.objectContaining({
					state: "effect_started",
					response: expect.objectContaining({
						error: expect.objectContaining({
							cleanup: expect.objectContaining({
								phase: "lifecycle",
								lifecycleFiles: [
									expect.objectContaining({
										identity: expect.objectContaining({ sha256: expect.any(String) }),
										plannedPath: expect.stringMatching(/\.gjc-delete-.*\.lifecycle\.json$/),
									}),
								],
							}),
						}),
					}),
				}),
			);
			if (!detachedQ1) throw new Error("Missing persisted Q1 metadata path");
			vi.restoreAllMocks();
			await broker.stop();
			broker = new Broker({ agentDir: dir });
			await broker.start();
			let plannedQ2: string | undefined;
			const replay = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
				if (pathname === detachedQ1) {
					const rows = syncFs
						.readFileSync(path.join(dir, "sdk", "lifecycle-ledger.jsonl"), "utf8")
						.split("\n")
						.filter(Boolean)
						.map(line => JSON.parse(line) as Record<string, unknown>);
					const pendingCleanup = rows
						.map(
							row =>
								(row.response as Record<string, unknown> | undefined)?.error as
									| Record<string, unknown>
									| undefined,
						)
						.map(error => error?.cleanup as Record<string, unknown> | undefined)
						.findLast(cleanup => {
							const file = (cleanup?.lifecycleFiles as Record<string, unknown>[] | undefined)?.[0];
							return file?.detachedPath === detachedQ1 && file?.plannedPath !== detachedQ1;
						});
					plannedQ2 = (pendingCleanup?.lifecycleFiles as Record<string, unknown>[] | undefined)?.[0]
						?.plannedPath as string | undefined;
					expect(plannedQ2).toEqual(expect.any(String));
					expect(plannedQ2).not.toBe(detachedQ1);
					expect((identity as { quarantineName?: string }).quarantineName).toBe(path.basename(plannedQ2!));
				}
				return originalUnlink(pathname, identity);
			});
			try {
				const replayed = await broker.handleRequest(
					"session.delete",
					{ sessionId, sessionPath, cwd },
					"metadata-cleanup-pending-key",
				);
				if (!replayed.ok) throw new Error(JSON.stringify(replayed.error));
				expect(replayed).toMatchObject({ ok: true, result: { sessionId } });
			} finally {
				replay.mockRestore();
			}
			expect(plannedQ2).toEqual(expect.any(String));
			expect(await fs.stat(detachedQ1).catch(() => undefined)).toBeUndefined();
			await broker.stop();
			broker = new Broker({ agentDir: dir });
			await broker.start();
			expect(
				await broker.handleRequest(
					"session.delete",
					{ sessionId, sessionPath, cwd },
					"metadata-cleanup-pending-key",
				),
			).toMatchObject({ ok: true, result: { sessionId } });
		} finally {
			vi.restoreAllMocks();
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("returns endpoint_stale without dispatching close after endpoint generation rotation", async () => {
		const dir = await temp();
		const stateRoot = path.join(dir, ".gjc", "state");
		const sessionId = "rotating";
		const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
		const broker = new Broker({ agentDir: dir });
		let controlRequests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, httpServer) {
				if (httpServer.upgrade(request)) return;
				return new Response("WebSocket required", { status: 426 });
			},
			websocket: {
				open(ws) {
					void (async () => {
						await fs.writeFile(
							endpointPath,
							JSON.stringify({
								sessionId,
								pid: process.pid,
								url: `ws://127.0.0.1:${server.port}`,
								token: "replacement-token",
							}),
						);
						await broker.index.append({
							type: "host_registered",
							sessionId,
							locator: { repo: dir, stateRoot },
							endpointGeneration: 2,
							pid: process.pid,
							endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
						});
						ws.send(JSON.stringify({ type: "hello" }));
					})();
				},
				message(ws, message) {
					const frame = JSON.parse(String(message)) as { id?: string; type?: string };
					if (frame.type === "control_request") controlRequests++;
					if (frame.id) ws.send(JSON.stringify({ id: frame.id, ok: true }));
				},
			},
		});
		await broker.start();
		try {
			await fs.mkdir(path.dirname(endpointPath), { recursive: true });
			await fs.writeFile(
				endpointPath,
				JSON.stringify({
					sessionId,
					pid: process.pid,
					url: `ws://127.0.0.1:${server.port}`,
					token: "initial-token",
				}),
			);
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator: { repo: dir, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
				endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
			});
			expect(await broker.handleRequest("session.close", { sessionId }, "rotating-close")).toEqual({
				ok: false,
				error: { code: "endpoint_stale", message: "session endpoint is stale" },
			});
			expect(controlRequests).toBe(0);
		} finally {
			server.stop(true);
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("preserves a typed session-host close failure without signal fallback", async () => {
		const dir = await temp();
		const stateRoot = path.join(dir, ".gjc", "state");
		const sessionId = "flush-failure";
		const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
		const broker = new Broker({ agentDir: dir });
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, httpServer) {
				if (httpServer.upgrade(request)) return;
				return new Response("WebSocket required", { status: 426 });
			},
			websocket: {
				open(ws) {
					ws.send(JSON.stringify({ type: "hello" }));
				},
				message(ws, message) {
					const frame = JSON.parse(String(message)) as { id?: string };
					if (frame.id)
						ws.send(
							JSON.stringify({
								id: frame.id,
								ok: false,
								error: { code: "flush_failed", message: "session flush failed" },
							}),
						);
				},
			},
		});
		await broker.start();
		try {
			await fs.mkdir(path.dirname(endpointPath), { recursive: true });
			await fs.writeFile(
				endpointPath,
				JSON.stringify({
					sessionId,
					pid: process.pid,
					url: `ws://127.0.0.1:${server.port}`,
					token: "flush-token",
				}),
			);
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator: { repo: dir, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
				endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
			});
			expect(await broker.handleRequest("session.close", { sessionId }, "flush-close")).toEqual({
				ok: false,
				error: { code: "flush_failed", message: "session flush failed" },
			});
		} finally {
			server.stop(true);
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("fixture broker lease authority", () => {
	it("mints one lease for a fresh child and never mints one from an existing owner", async () => {
		const dir = await temp();
		try {
			const started = await startFixtureBrokerWithLeaseForTest({ agentDir: dir });
			expect(typeof started.discovery.pid).toBe("number");
			await expect(startFixtureBrokerWithLeaseForTest({ agentDir: dir })).rejects.toThrow(
				"fixture_broker_lease_unavailable",
			);
			const firstClose = started.lease.close();
			const secondClose = started.lease.close();
			expect(secondClose).toBe(firstClose);
			await firstClose;
			await started.lease.close();
			expect(brokerOwnerForTest(dir)).toBeUndefined();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 15_000);

	it("rejects a fixture lease that joins discovery-mode startup without claiming its owner", async () => {
		const dir = await temp();
		try {
			const discovery = ensureBroker({ agentDir: dir });
			await expect(startFixtureBrokerWithLeaseForTest({ agentDir: dir })).rejects.toThrow(
				"fixture_broker_lease_unavailable",
			);
			await discovery;
			const owner = brokerOwnerForTest(dir);
			expect(owner).toBeDefined();
			await owner?.stop();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 15_000);

	it("rejects a concurrent second fixture lease and keeps independent roots isolated", async () => {
		const leftDir = await temp();
		const rightDir = await temp();
		try {
			const leftStart = startFixtureBrokerWithLeaseForTest({ agentDir: leftDir });
			await expect(startFixtureBrokerWithLeaseForTest({ agentDir: leftDir })).rejects.toThrow(
				"fixture_broker_lease_unavailable",
			);
			const [left, right] = await Promise.all([
				leftStart,
				startFixtureBrokerWithLeaseForTest({ agentDir: rightDir }),
			]);
			await left.lease.close();
			expect(await readBrokerDiscovery(rightDir)).toMatchObject({
				pid: right.discovery.pid,
				incarnation: right.discovery.incarnation,
			});
			expect(brokerOwnerForTest(rightDir)).toBeDefined();
			await right.lease.close();
		} finally {
			await brokerOwnerForTest(leftDir)?.stop();
			await brokerOwnerForTest(rightDir)?.stop();
			await fs.rm(leftDir, { recursive: true, force: true });
			await fs.rm(rightDir, { recursive: true, force: true });
		}
	}, 15_000);

	it("rejects external discovery without changing its broker", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir });
		await broker.start();
		try {
			await expect(startFixtureBrokerWithLeaseForTest({ agentDir: dir })).rejects.toThrow(
				"fixture_broker_lease_unavailable",
			);
			expect((await readBrokerDiscovery(dir))?.pid).toBe(process.pid);
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
