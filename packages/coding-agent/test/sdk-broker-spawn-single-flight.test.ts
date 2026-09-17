import { expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import * as native from "@gajae-code/natives";
import packageJson from "../package.json" with { type: "json" };
import type { BrokerDiscovery } from "../src/sdk/broker/discovery";
import * as brokerDiscovery from "../src/sdk/broker/discovery";
import {
	acquireSpawnLockForTest,
	BROKER_DISCOVERY_BUDGET,
	brokerOwnerForTest,
	closeBrokerClientBeforeDeadline,
	type EnsureBrokerTiming,
	ensureBroker,
	readBrokerDiscoveryBeforeDeadlineForTest,
	reconcileBrokerGenerationForStartup,
	setEnsureBrokerTimingForTest,
	withBrokerStartupLock,
} from "../src/sdk/broker/ensure";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const brokerModule = path.resolve(import.meta.dir, "../src/sdk/broker/broker.ts");
const discoveryModule = path.resolve(import.meta.dir, "../src/sdk/broker/discovery.ts");
const ensureModule = path.resolve(import.meta.dir, "../src/sdk/broker/ensure.ts");
const temp = () => fs.mkdtemp(path.join(os.tmpdir(), "gjc-spawn-race-"));
type LockWorker = Bun.Subprocess<"ignore", "pipe", "pipe">;

async function waitForFile(file: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			await fs.stat(file);
			return;
		} catch {
			await Bun.sleep(20);
		}
	}
	throw new Error(`Timed out waiting for ${file}`);
}

function spawnLockWorker(
	dir: string,
	ready: string,
	journal: string,
	label: string,
	holdMs: number,
	env: NodeJS.ProcessEnv = process.env,
): LockWorker {
	const source = `
		import * as fs from "node:fs/promises";
		import { acquireSpawnLockForTest } from ${JSON.stringify(ensureModule)};
		const release = await acquireSpawnLockForTest(${JSON.stringify(dir)}, { retries: 400, retryDelayMs: 10 });
		await fs.writeFile(${JSON.stringify(ready)}, "ready");
		await fs.appendFile(${JSON.stringify(journal)}, ${JSON.stringify(`${label}:start\n`)});
		await Bun.sleep(${holdMs});
		await fs.appendFile(${JSON.stringify(journal)}, ${JSON.stringify(`${label}:end\n`)});
		await release();
	`;
	return Bun.spawn([process.execPath, "-e", source], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
}

/**
 * #5604: the session CLI reports a discovery-budget expiry as a JSON envelope on
 * stdout, with exit code 1 and a legitimately empty stderr. An assertion that
 * reads only `{code, error}` therefore throws its own diagnostic away and prints
 * `{code: 1, error: ""}`. Fold the envelope's reason into the assertion instead.
 */
function cliFailureReason(stdout: string): string | undefined {
	const trimmed = stdout.trim();
	if (trimmed.length === 0) return undefined;
	try {
		const envelope = JSON.parse(trimmed) as { ok?: unknown; error?: { code?: unknown; message?: unknown } };
		if (envelope.ok !== false) return undefined;
		return `${envelope.error?.code ?? "unknown"}: ${envelope.error?.message ?? "no message"}`;
	} catch {
		return trimmed.slice(0, 500);
	}
}

/**
 * Virtual clock for the discovery budget. It starts at the real wall clock so any
 * absolute deadline handed to a real-time consumer stays sane, and advances only
 * when the code under test sleeps -- so a budget leg gets measured, not waited out.
 */
function virtualBudgetClock(): { timing: EnsureBrokerTiming; elapsedMs(): number } {
	const start = Date.now();
	let current = start;
	return {
		timing: {
			now: () => current,
			sleep: (ms: number) => {
				current += Math.max(0, ms);
				return Promise.resolve();
			},
		},
		elapsedMs: () => current - start,
	};
}

function spawnEnsureWorker(dir: string, env: NodeJS.ProcessEnv = process.env): LockWorker {
	const source = `
		import { ensureBroker } from ${JSON.stringify(ensureModule)};
		await ensureBroker({ agentDir: ${JSON.stringify(dir)} });
	`;
	return Bun.spawn([process.execPath, "-e", source], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
}

function spawnStaleBrokerWorker(dir: string, ready: string): LockWorker {
	const source = `
		import * as fs from "node:fs/promises";
		import { Broker } from ${JSON.stringify(brokerModule)};
		const broker = new Broker({ agentDir: ${JSON.stringify(dir)}, packageGeneration: "pr5204-stale-generation" });
		const discovery = await broker.start();
		await fs.writeFile(${JSON.stringify(ready)}, JSON.stringify(discovery));
		process.once("SIGTERM", () => void broker.stop());
		await broker.completion;
	`;
	return Bun.spawn([process.execPath, "-e", source], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
}

function spawnControllableStaleDiscoveryWorker(
	dir: string,
	ready: string,
	retirementRequested: string,
	retirementRelease: string,
): LockWorker {
	const source = `
		import * as fs from "node:fs/promises";
		import { brokerDiscoveryPath, brokerProcessIncarnation, writeBrokerDiscovery } from ${JSON.stringify(discoveryModule)};
		const startedAt = Date.now();
		const incarnation = brokerProcessIncarnation(process.pid);
		if (!incarnation) throw new Error("stale worker incarnation unavailable");
		let retiring = false;
		process.once("SIGTERM", () => {
			if (retiring) return;
			retiring = true;
			void (async () => {
				await fs.writeFile(${JSON.stringify(retirementRequested)}, "requested");
				while (!(await fs.stat(${JSON.stringify(retirementRelease)}).then(() => true).catch(() => false)))
					await Bun.sleep(10);
				await fs.rm(brokerDiscoveryPath(${JSON.stringify(dir)}), { force: true });
			})();
		});
		let published = false;
		while (!retiring) {
			await writeBrokerDiscovery(${JSON.stringify(dir)}, {
				version: 1,
				protocolVersion: 3,
				packageGeneration: "pr5204-expiring-stale",
				ownerId: "pr5204-expiring-stale-owner",
				pid: process.pid,
				incarnation,
				host: "127.0.0.1",
				port: 1,
				url: "ws://127.0.0.1:1",
				token: "pr5204-expiring-stale-token",
				startedAt,
				heartbeatAt: Date.now(),
			});
			if (!published) {
				published = true;
				await fs.writeFile(${JSON.stringify(ready)}, "ready");
			}
			await Bun.sleep(20);
		}
	`;
	return Bun.spawn([process.execPath, "-e", source], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
}

/**
 * #5198: N CLI invocations that all miss discovery on a cold agent dir must
 * not each spawn a detached broker. Exactly one broker may exist afterwards
 * and the lock tree must carry no quarantine tombstones.
 */
it("concurrent OS processes on a cold agent dir spawn exactly one broker and leave no tombstones", async () => {
	const dir = await temp();
	const brokerPids = new Set<number>();
	try {
		const invocations = Array.from({ length: 6 }, () => spawnEnsureWorker(dir));
		const results = await Promise.all(
			invocations.map(async child => ({ code: await child.exited, error: await new Response(child.stderr).text() })),
		);
		expect(results).toEqual(results.map(() => ({ code: 0, error: "" })));
		const discovery = await brokerDiscovery.readBrokerDiscovery(dir, undefined);
		expect(discovery).toBeDefined();
		brokerPids.add(discovery!.pid);
		const sdk = path.join(dir, "sdk");
		const names = await fs.readdir(sdk);
		expect(names.filter(name => name.startsWith(".broker.lock.stale-"))).toEqual([]);
		expect(names).not.toContain("broker.spawn.lock");
		const sessions = await fs.readdir(path.join(sdk, "sessions")).catch(() => [] as string[]);
		expect(sessions.filter(name => name.startsWith("index.jsonl.lock"))).toEqual([]);
		const broker = native.Process.fromPid(discovery!.pid);
		expect(broker?.args()).toContain("broker-internal");
		expect(broker?.args()).toContain(dir);
	} finally {
		for (const pid of brokerPids)
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// gone
			}
		await Bun.sleep(300);
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60_000);

it("source-mode CLI resolves a relative agent dir once for parent and detached broker", async () => {
	const root = await temp();
	const relativeAgentDir = "relative-agent";
	const agentDir = path.join(root, relativeAgentDir);
	let brokerPid: number | undefined;
	try {
		const child = Bun.spawn(
			[process.execPath, "run", cli, "sdk", "session", "list", "--scope", "all", "--agent-dir", relativeAgentDir],
			{ cwd: root, stdout: "pipe", stderr: "pipe" },
		);
		const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect({ code, error }).toEqual({ code: 0, error: "" });
		const discovery = await brokerDiscovery.readBrokerDiscovery(agentDir);
		expect(discovery).not.toBeNull();
		brokerPid = discovery!.pid;
		expect(native.Process.fromPid(brokerPid)?.args()).toContain(agentDir);
		expect(await brokerDiscovery.readBrokerDiscovery(path.resolve(import.meta.dir, relativeAgentDir))).toBeNull();
	} finally {
		if (brokerPid !== undefined)
			try {
				process.kill(brokerPid, "SIGTERM");
			} catch {
				// gone
			}
		await Bun.sleep(300);
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);

it("concurrent process replacement composes stale-generation fencing with single-flight spawn", async () => {
	const dir = await temp();
	const ready = path.join(dir, "stale.ready");
	const staleBroker = spawnStaleBrokerWorker(dir, ready);
	let currentPid: number | undefined;
	try {
		await waitForFile(ready);
		const stale = JSON.parse(await fs.readFile(ready, "utf8")) as brokerDiscovery.BrokerDiscovery;
		const invocations = Array.from({ length: 6 }, () => spawnEnsureWorker(dir));
		const results = await Promise.all(
			invocations.map(async child => ({
				code: await child.exited,
				error: await new Response(child.stderr).text(),
			})),
		);
		expect(results).toEqual(results.map(() => ({ code: 0, error: "" })));

		const replacement = await brokerDiscovery.readBrokerDiscovery(dir);
		expect(replacement).not.toBeNull();
		expect(replacement).toMatchObject({ packageGeneration: packageJson.version });
		expect(replacement!.ownerId).not.toBe(stale.ownerId);
		currentPid = replacement!.pid;
		const broker = native.Process.fromPid(replacement!.pid);
		expect(broker?.args()).toContain("broker-internal");
		expect(broker?.args()).toContain(dir);
		const sdkEntries = await fs.readdir(path.join(dir, "sdk"));
		expect(sdkEntries).not.toContain("broker.spawn.lock");
		expect(sdkEntries).not.toContain("broker.startup.lock");
		expect(sdkEntries.filter(name => name.startsWith(".broker.lock.stale-"))).toEqual([]);
	} finally {
		staleBroker.kill("SIGTERM");
		await staleBroker.exited;
		if (currentPid !== undefined)
			try {
				process.kill(currentPid, "SIGTERM");
			} catch {
				// gone
			}
		await Bun.sleep(300);
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60_000);

it("independent broker bootstrap children serialize before Broker.start", async () => {
	const dir = await temp();
	const children = Array.from({ length: 3 }, () =>
		Bun.spawn([process.execPath, "run", cli, "sdk", "broker-internal", "--agent-dir", dir], {
			cwd: import.meta.dir,
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
	let discovery: BrokerDiscovery | null = null;
	try {
		const deadline = Date.now() + 10_000;
		while (!discovery && Date.now() < deadline) {
			discovery = await brokerDiscovery.readBrokerDiscovery(dir);
			if (!discovery) await Bun.sleep(20);
		}
		expect(discovery).not.toBeNull();
		const losers = children.filter(child => child.pid !== discovery!.pid);
		const loserCodes = await Promise.all(losers.map(child => child.exited));
		expect(loserCodes).toEqual(losers.map(() => 0));
		const sdkEntries = await fs.readdir(path.join(dir, "sdk"));
		expect(sdkEntries).not.toContain("broker.startup.lock");
		expect(sdkEntries.filter(name => name.startsWith(".broker.lock.stale-"))).toEqual([]);
	} finally {
		for (const child of children) child.kill("SIGTERM");
		if (discovery)
			try {
				process.kill(discovery.pid, "SIGTERM");
			} catch {
				// gone
			}
		await Promise.all(children.map(child => child.exited));
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30_000);

it("retries discovery after a launcher dies while its child holds the startup fence", async () => {
	const dir = await temp();
	let first: Bun.Subprocess<"ignore", "ignore", "ignore"> | undefined;
	let replacementPid: number | undefined;
	try {
		first = Bun.spawn(
			[process.execPath, "run", cli, "sdk", "session", "list", "--scope", "all", "--agent-dir", dir],
			{
				cwd: import.meta.dir,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
				env: { ...process.env, GJC_SDK_TEST_BROKER_STARTUP_DELAY_MS: "10000" },
			},
		);
		const startupLockInfoPath = path.join(dir, "sdk", "broker.startup.lock", "info");
		await waitForFile(startupLockInfoPath);
		const incumbentOwner = JSON.parse(await fs.readFile(startupLockInfoPath, "utf8")) as {
			pid: number;
			process_incarnation: string;
		};
		first.kill("SIGKILL");
		await first.exited;

		const replacement = Bun.spawn(
			[process.execPath, "run", cli, "sdk", "session", "list", "--scope", "all", "--agent-dir", dir],
			{
				cwd: import.meta.dir,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [code, error] = await Promise.all([replacement.exited, new Response(replacement.stderr).text()]);
		expect({ code, error }).toEqual({ code: 0, error: "" });
		const discovery = await brokerDiscovery.readBrokerDiscovery(dir);
		expect(discovery).not.toBeNull();
		expect(discovery).toMatchObject({
			pid: incumbentOwner.pid,
			incarnation: incumbentOwner.process_incarnation,
		});
		replacementPid = discovery!.pid;
	} finally {
		first?.kill("SIGKILL");
		if (replacementPid !== undefined)
			try {
				process.kill(replacementPid, "SIGTERM");
			} catch {
				// gone
			}
		await Bun.sleep(300);
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30_000);

it("the parent discovery budget covers child-fence contention plus a full startup attempt", async () => {
	const dir = await temp();
	const entered = Promise.withResolvers<void>();
	const unblock = Promise.withResolvers<void>();
	const holder = withBrokerStartupLock(dir, async () => {
		entered.resolve();
		await unblock.promise;
	});
	let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
	try {
		await entered.promise;
		child = Bun.spawn(
			[process.execPath, "run", cli, "sdk", "session", "list", "--scope", "all", "--agent-dir", dir],
			{
				cwd: import.meta.dir,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, GJC_SDK_TEST_BROKER_STARTUP_DELAY_MS: "3000" },
			},
		);
		await Bun.sleep(8_000);
		unblock.resolve();
		await holder;
		const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect({ code, error }).toEqual({ code: 0, error: "" });
		const discovery = await brokerDiscovery.readBrokerDiscovery(dir);
		expect(discovery).not.toBeNull();
		expect(await fs.readdir(path.join(dir, "sdk"))).not.toContain("broker.startup.lock");
	} finally {
		unblock.resolve();
		await holder.catch(() => undefined);
		child?.kill("SIGTERM");
		await brokerOwnerForTest(dir)?.stop();
		const discovery = await brokerDiscovery.readBrokerDiscovery(dir).catch(() => null);
		if (discovery)
			try {
				process.kill(discovery.pid, "SIGTERM");
			} catch {
				// gone
			}
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30_000);

it("the parent budget composes stale retirement, child-fence contention, and startup", async () => {
	const dir = await temp();
	const ready = path.join(dir, "expiring-stale.ready");
	const retirementRequested = path.join(dir, "stale-retirement.requested");
	const retirementRelease = path.join(dir, "stale-retirement.release");
	const signalDir = path.join(dir, "broker-signals");
	const startupGate = path.join(dir, "broker-startup.release");
	await fs.mkdir(signalDir, { recursive: true });
	const stale = spawnControllableStaleDiscoveryWorker(dir, ready, retirementRequested, retirementRelease);
	const entered = Promise.withResolvers<void>();
	const unblock = Promise.withResolvers<void>();
	const holder = withBrokerStartupLock(dir, async () => {
		entered.resolve();
		await unblock.promise;
	});
	let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
	try {
		await Promise.all([waitForFile(ready), entered.promise]);
		child = Bun.spawn(
			[process.execPath, "run", cli, "sdk", "session", "list", "--scope", "all", "--agent-dir", dir],
			{
				cwd: import.meta.dir,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					GJC_SDK_TEST_BROKER_SIGNAL_DIR: signalDir,
					GJC_SDK_TEST_BROKER_STARTUP_GATE_FILE: startupGate,
				},
			},
		);
		await waitForFile(retirementRequested);
		await fs.writeFile(retirementRelease, "release");
		await waitForFile(path.join(signalDir, "retirement-finished"));
		await waitForFile(path.join(signalDir, "fence-contended"));
		unblock.resolve();
		await holder;
		await waitForFile(path.join(signalDir, "fence-acquired"));
		await waitForFile(path.join(signalDir, "startup-gate-waiting"));
		await fs.writeFile(startupGate, "release");
		await waitForFile(path.join(signalDir, "startup-gate-released"));
		// The session CLI reports a discovery-budget expiry as a JSON envelope on
		// stdout, with exit code 1 and a legitimately empty stderr, so an assertion
		// that reads only {code, error} prints `{code: 1, error: ""}` and throws its
		// own diagnostic away. Fold the envelope's reason in instead (#5604).
		const [code, error, output] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
			new Response(child.stdout).text(),
		]);
		expect({ code, error, failure: cliFailureReason(output) }).toEqual({
			code: 0,
			error: "",
			failure: undefined,
		});
		const discovery = await brokerDiscovery.readBrokerDiscovery(dir);
		expect(discovery).toMatchObject({ packageGeneration: packageJson.version });
		expect(await fs.readdir(path.join(dir, "sdk"))).not.toContain("broker.startup.lock");
	} finally {
		unblock.resolve();
		await holder.catch(() => undefined);
		stale.kill("SIGKILL");
		child?.kill("SIGTERM");
		await Promise.all([stale.exited, child?.exited]);
		const discovery = await brokerDiscovery.readBrokerDiscovery(dir).catch(() => null);
		if (discovery)
			try {
				process.kill(discovery.pid, "SIGTERM");
			} catch {
				// gone
			}
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 55_000);

/**
 * #5604: the composition the wall-clock case above stages -- stale retirement,
 * then the child fence, then startup and publication -- is arithmetic, and
 * racing three real clocks is a poor way to assert arithmetic. Drive the same
 * legs on a virtual clock so each one's cost is measured exactly and a change to
 * any constant fails here first, in milliseconds, instead of as a flake.
 */
it("spends the parent discovery budget one composition leg at a time", async () => {
	const dir = await temp();
	const clock = virtualBudgetClock();
	// An incumbent of the wrong generation that never retires: a pid this process
	// cannot match by incarnation keeps retirement on its polling path and out of
	// process.kill entirely, and the unroutable url refuses its shutdown request.
	const unretirable: BrokerDiscovery = {
		version: 1,
		protocolVersion: 3,
		packageGeneration: "pr5604-incompatible-generation",
		ownerId: "pr5604-virtual-clock-owner",
		pid: process.pid,
		incarnation: "pr5604-virtual-clock-incarnation",
		host: "127.0.0.1",
		port: 1,
		url: "ws://127.0.0.1:1",
		token: "pr5604-virtual-clock-token",
		startedAt: clock.timing.now(),
		heartbeatAt: clock.timing.now(),
	};
	const readSpy = spyOn(brokerDiscovery, "readBrokerDiscovery").mockImplementation(() => Promise.resolve(unretirable));
	setEnsureBrokerTimingForTest(clock.timing);
	try {
		const budgetStart = clock.timing.now();
		const reconciled = await reconcileBrokerGenerationForStartup(
			{ agentDir: dir },
			budgetStart + BROKER_DISCOVERY_BUDGET.discoveryMs,
		);
		// Leg one gives up on an incumbent that never goes away, and spends exactly
		// its own leg doing so -- never the caller's whole budget.
		expect(reconciled).toBeUndefined();
		expect(clock.elapsedMs()).toBe(BROKER_DISCOVERY_BUDGET.staleRetirementMs);
		// What survives retirement is still a full child-fence wait plus one
		// publication attempt; that remainder is what the wall-clock case stages.
		expect(budgetStart + BROKER_DISCOVERY_BUDGET.discoveryMs - clock.timing.now()).toBe(
			BROKER_DISCOVERY_BUDGET.startupLockWaitMs + BROKER_DISCOVERY_BUDGET.publicationMs,
		);
		// The fence itself grants its holder retirement plus that publication.
		const fenceDeadline = await withBrokerStartupLock(dir, deadline => Promise.resolve(deadline));
		expect(fenceDeadline - clock.timing.now()).toBe(BROKER_DISCOVERY_BUDGET.fenceOperationMs);
	} finally {
		setEnsureBrokerTimingForTest(undefined);
		readSpy.mockRestore();
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 15_000);

it("stale broker client teardown cannot extend an expired retirement deadline", async () => {
	const stalled = Promise.withResolvers<void>();
	let closeCalls = 0;
	await closeBrokerClientBeforeDeadline(
		{
			close() {
				closeCalls += 1;
				return stalled.promise;
			},
		},
		Date.now() - 1,
	);
	expect(closeCalls).toBe(1);
	stalled.resolve();
	await stalled.promise;
});

it("bounds the initial discovery read before taking the spawn lock", async () => {
	const stalled = Promise.withResolvers<BrokerDiscovery | null>();
	const readSpy = spyOn(brokerDiscovery, "readBrokerDiscovery").mockImplementation(() => stalled.promise);
	try {
		await expect(readBrokerDiscoveryBeforeDeadlineForTest("/unused", undefined, Date.now() + 25)).rejects.toThrow(
			"Timed out reading SDK broker discovery.",
		);
	} finally {
		readSpy.mockRestore();
		stalled.resolve(null);
	}
});

it("kills a broker bootstrap that outlives the startup fence deadline", async () => {
	const dir = await temp();
	let brokerPid: number | undefined;
	try {
		const child = Bun.spawn([process.execPath, "run", cli, "sdk", "broker-internal", "--agent-dir", dir], {
			cwd: import.meta.dir,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
			env: {
				...process.env,
				GJC_SDK_TEST_BROKER_STARTUP_STALL: "1",
				GJC_SDK_TEST_BROKER_STARTUP_WATCHDOG_MS: "250",
			},
		});
		const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(code).toBe(1);
		expect(error).toContain("SDK broker startup exceeded its 250ms fence deadline.");

		const discovery = await ensureBroker({ agentDir: dir });
		brokerPid = discovery.pid;
		expect(discovery.pid).toBeGreaterThan(0);
	} finally {
		if (brokerPid !== undefined)
			try {
				process.kill(brokerPid, "SIGTERM");
			} catch {
				// gone
			}
		await brokerOwnerForTest(dir)?.stop();
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 15_000);

it("releases the spawn lock when the under-lock discovery read fails so the next spawn succeeds", async () => {
	const dir = await temp();
	const readBrokerDiscovery = brokerDiscovery.readBrokerDiscovery;
	let reads = 0;
	const readSpy = spyOn(brokerDiscovery, "readBrokerDiscovery").mockImplementation(async (...args) => {
		reads += 1;
		if (reads === 1) return null;
		if (reads === 2) throw new Error("injected under-lock discovery failure");
		return readBrokerDiscovery(...args);
	});
	try {
		await expect(ensureBroker({ agentDir: dir })).rejects.toThrow("injected under-lock discovery failure");
		readSpy.mockRestore();
		expect(await fs.readdir(path.join(dir, "sdk"))).not.toContain("broker.spawn.lock");

		const discovery = await ensureBroker({ agentDir: dir });
		expect(discovery.pid).toBeGreaterThan(0);
		expect(await brokerDiscovery.readBrokerDiscovery(dir)).toMatchObject({ pid: discovery.pid });
		expect(await fs.readdir(path.join(dir, "sdk"))).not.toContain("broker.spawn.lock");
	} finally {
		readSpy.mockRestore();
		await brokerOwnerForTest(dir)?.stop();
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30_000);

it("the spawn lock rejects an incomplete published owner instead of acquiring over it", async () => {
	const dir = await temp();
	try {
		await fs.mkdir(path.join(dir, "sdk", "broker.spawn.lock"), { recursive: true });
		await expect(acquireSpawnLockForTest(dir, { retries: 1, retryDelayMs: 1 })).rejects.toThrow(
			"held by an unrecognized owner record",
		);
		expect(await fs.readdir(path.join(dir, "sdk", "broker.spawn.lock"))).toEqual([]);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

it("two OS processes reclaim a dead holder without overlapping critical sections", async () => {
	const dir = await temp();
	const journal = path.join(dir, "journal");
	const deadReady = path.join(dir, "dead.ready");
	const leftReady = path.join(dir, "left.ready");
	const rightReady = path.join(dir, "right.ready");
	const children = new Set<LockWorker>();
	try {
		const dead = spawnLockWorker(dir, deadReady, journal, "dead", 60_000);
		children.add(dead);
		await waitForFile(deadReady);
		dead.kill("SIGKILL");
		await dead.exited;
		children.delete(dead);
		await fs.writeFile(journal, "");

		const left = spawnLockWorker(dir, leftReady, journal, "left", 150);
		const right = spawnLockWorker(dir, rightReady, journal, "right", 150);
		children.add(left);
		children.add(right);
		const [leftCode, rightCode, leftError, rightError] = await Promise.all([
			left.exited,
			right.exited,
			new Response(left.stderr).text(),
			new Response(right.stderr).text(),
		]);
		children.delete(left);
		children.delete(right);
		expect({ leftCode, leftError, rightCode, rightError }).toEqual({
			leftCode: 0,
			leftError: "",
			rightCode: 0,
			rightError: "",
		});
		const events = (await fs.readFile(journal, "utf8")).trim().split("\n");
		expect([
			["left:start", "left:end", "right:start", "right:end"],
			["right:start", "right:end", "left:start", "left:end"],
		]).toContainEqual(events);
		expect(await fs.readdir(path.join(dir, "sdk"))).not.toContain("broker.spawn.lock");
	} finally {
		for (const child of children) child.kill("SIGKILL");
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30_000);

it("shared agent roots recover dead locks across config profiles despite a retained broker quarantine", async () => {
	const root = await temp();
	const dir = path.join(root, "shared-agent");
	const configA = path.join(root, "profile-a");
	const configB = path.join(root, "profile-b");
	const ready = path.join(root, "dead.ready");
	const journal = path.join(root, "journal");
	const envA = { ...process.env, GJC_CONFIG_DIR: configA };
	const envB = { ...process.env, GJC_CONFIG_DIR: configB };
	const dead = spawnLockWorker(dir, ready, journal, "dead", 60_000, envA);
	let brokerPid: number | undefined;
	try {
		await fs.mkdir(configB, { recursive: true });
		await fs.writeFile(path.join(configB, "machine-identity.secret"), "malformed-default-profile-secret\n");
		await waitForFile(ready);
		const deadPid = dead.pid;
		dead.kill("SIGKILL");
		await dead.exited;

		const sdk = path.join(dir, "sdk");
		const brokerLock = path.join(sdk, "broker.lock");
		await fs.mkdir(brokerLock, { recursive: true, mode: 0o700 });
		await fs.writeFile(
			path.join(brokerLock, "owner.json"),
			JSON.stringify({ version: 1, ownerId: "dead-broker", pid: deadPid, acquiredAt: Date.now() - 60_000 }),
			{ mode: 0o600 },
		);
		const lockStat = await fs.lstat(brokerLock, { bigint: true });
		const legacyTombstone = path.join(
			sdk,
			`.broker.lock.stale-${createHash("sha256").update(`${lockStat.dev}:${lockStat.ino}`).digest("hex")}`,
		);
		await fs.mkdir(legacyTombstone, { mode: 0o700 });
		await fs.writeFile(
			path.join(legacyTombstone, "owner.json"),
			JSON.stringify({ version: 1, ownerId: "older-dead-broker", pid: deadPid, acquiredAt: Date.now() - 120_000 }),
			{ mode: 0o600 },
		);
		await brokerDiscovery.writeBrokerDiscovery(dir, {
			version: 1,
			protocolVersion: 3,
			packageGeneration: packageJson.version,
			ownerId: "dead-broker",
			pid: deadPid,
			incarnation: `dead:${deadPid}`,
			host: "127.0.0.1",
			port: 1,
			url: "ws://127.0.0.1:1",
			token: "dead-broker-token",
			startedAt: Date.now() - 120_000,
			heartbeatAt: Date.now() - 120_000,
		});

		const contenders = Array.from({ length: 4 }, () => spawnEnsureWorker(dir, envB));
		const results = await Promise.all(
			contenders.map(async child => ({ code: await child.exited, error: await new Response(child.stderr).text() })),
		);
		expect(results).toEqual(results.map(() => ({ code: 0, error: "" })));
		const discovery = await brokerDiscovery.readBrokerDiscovery(dir);
		expect(discovery).not.toBeNull();
		brokerPid = discovery!.pid;
		expect(discovery!.pid).not.toBe(deadPid);
		expect(await fs.readdir(sdk)).not.toContain("broker.spawn.lock");
		expect(await fs.readFile(path.join(legacyTombstone, "owner.json"), "utf8")).toContain("older-dead-broker");
		expect(await fs.readFile(path.join(configB, "machine-identity.secret"), "utf8")).toBe(
			"malformed-default-profile-secret\n",
		);
	} finally {
		dead.kill("SIGKILL");
		if (brokerPid !== undefined)
			try {
				process.kill(brokerPid, "SIGTERM");
			} catch {
				// gone
			}
		await Bun.sleep(300);
		await fs.rm(root, { recursive: true, force: true });
	}
}, 60_000);

it("a transient exact stale-removal refusal stays fail-closed and retries acquisition", async () => {
	const dir = await temp();
	const ready = path.join(dir, "holder.ready");
	const journal = path.join(dir, "journal");
	const holder = spawnLockWorker(dir, ready, journal, "holder", 60_000);
	const exactRemoveDirectoryTree = native.exactRemoveDirectoryTree;
	let refused = false;
	const removalSpy = spyOn(native, "exactRemoveDirectoryTree").mockImplementation((...args) => {
		if (!refused) {
			refused = true;
			return { ok: false, code: "io_error" };
		}
		return exactRemoveDirectoryTree(...args);
	});
	try {
		await waitForFile(ready);
		holder.kill("SIGKILL");
		await holder.exited;
		const release = await acquireSpawnLockForTest(dir, { retries: 20, retryDelayMs: 10 });
		expect(refused).toBeTrue();
		await release();
		expect(await fs.readdir(path.join(dir, "sdk"))).not.toContain("broker.spawn.lock");
	} finally {
		removalSpy.mockRestore();
		holder.kill("SIGKILL");
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30_000);

it("a recycled live PID does not keep a dead spawn-lock generation alive", async () => {
	const dir = await temp();
	const ready = path.join(dir, "holder.ready");
	const journal = path.join(dir, "journal");
	const holder = spawnLockWorker(dir, ready, journal, "holder", 60_000);
	try {
		await waitForFile(ready);
		holder.kill("SIGKILL");
		await holder.exited;
		const infoPath = path.join(dir, "sdk", "broker.spawn.lock", "info");
		const info = JSON.parse(await fs.readFile(infoPath, "utf8")) as Record<string, unknown>;
		expect(typeof info.process_incarnation).toBe("string");
		info.pid = process.pid;
		info.process_incarnation = "recycled-process-generation";
		await fs.writeFile(infoPath, JSON.stringify(info));

		const release = await acquireSpawnLockForTest(dir, { retries: 20, retryDelayMs: 10 });
		await release();
		expect(await fs.readdir(path.join(dir, "sdk"))).not.toContain("broker.spawn.lock");
	} finally {
		holder.kill("SIGKILL");
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30_000);

it("never reclaims a dead broker lock qualified to a different host", async () => {
	const dir = await temp();
	const ready = path.join(dir, "holder.ready");
	const journal = path.join(dir, "journal");
	const holder = spawnLockWorker(dir, ready, journal, "holder", 60_000);
	try {
		await waitForFile(ready);
		holder.kill("SIGKILL");
		await holder.exited;
		const infoPath = path.join(dir, "sdk", "broker.spawn.lock", "info");
		const info = JSON.parse(await fs.readFile(infoPath, "utf8")) as Record<string, unknown>;
		expect(typeof info.owner_host_id).toBe("string");
		info.owner_host_id = "foreign-installation-host";
		await fs.writeFile(infoPath, JSON.stringify(info));

		await expect(acquireSpawnLockForTest(dir, { retries: 1, retryDelayMs: 1 })).rejects.toThrow(
			"Failed to acquire lock",
		);
		expect(await fs.stat(path.join(dir, "sdk", "broker.spawn.lock"))).toBeDefined();
	} finally {
		holder.kill("SIGKILL");
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30_000);
