import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import * as native from "@gajae-code/natives";
import packageJson from "../package.json" with { type: "json" };
import type { BrokerDiscovery } from "../src/sdk/broker/discovery";
import * as brokerDiscovery from "../src/sdk/broker/discovery";
import {
	acquireSpawnLockForTest,
	brokerOwnerForTest,
	closeBrokerClientBeforeDeadline,
	ensureBroker,
	withBrokerStartupLock,
} from "../src/sdk/broker/ensure";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const brokerModule = path.resolve(import.meta.dir, "../src/sdk/broker/broker.ts");
const discoveryModule = path.resolve(import.meta.dir, "../src/sdk/broker/discovery.ts");
const ensureModule = path.resolve(import.meta.dir, "../src/sdk/broker/ensure.ts");
const temp = () => fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-spawn-race-"));
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

function spawnLockWorker(dir: string, ready: string, journal: string, label: string, holdMs: number): LockWorker {
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
	return Bun.spawn([process.execPath, "-e", source], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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

function spawnExpiringStaleDiscoveryWorker(dir: string, ready: string, lifetimeMs: number): LockWorker {
	const source = `
		import * as fs from "node:fs/promises";
		import { brokerProcessIncarnation, writeBrokerDiscovery } from ${JSON.stringify(discoveryModule)};
		const startedAt = Date.now();
		const incarnation = brokerProcessIncarnation(process.pid);
		if (!incarnation) throw new Error("stale worker incarnation unavailable");
		process.on("SIGTERM", () => {});
		let published = false;
		while (Date.now() - startedAt < ${lifetimeMs}) {
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
			await Bun.sleep(100);
		}
	`;
	return Bun.spawn([process.execPath, "-e", source], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
}

/**
 * #5198: N CLI invocations that all miss discovery on a cold agent dir must
 * not each spawn a detached broker. Exactly one broker may exist afterwards
 * and the lock tree must carry no quarantine tombstones.
 */
it("concurrent CLI invocations on a cold agent dir spawn exactly one broker and leave no tombstones", async () => {
	const dir = await temp();
	const brokerPids = new Set<number>();
	try {
		const invocations = Array.from({ length: 6 }, (_, i) =>
			Bun.spawn([process.execPath, "run", cli, "sdk", "session", "list", "--scope", "all", "--agent-dir", dir], {
				cwd: import.meta.dir,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, GJC_TEST_SPAWN_RACE: String(i) },
			}),
		);
		const results = await Promise.all(
			invocations.map(async child => ({ code: await child.exited, out: await new Response(child.stdout).text() })),
		);
		for (const result of results) expect(result.code).toBe(0);
		const discovery = await brokerDiscovery.readBrokerDiscovery(dir, undefined);
		expect(discovery).toBeDefined();
		brokerPids.add(discovery!.pid);
		const sdk = path.join(dir, "sdk");
		const names = await fs.readdir(sdk);
		expect(names.filter(name => name.startsWith(".broker.lock.stale-"))).toEqual([]);
		expect(names).not.toContain("broker.spawn.lock");
		const sessions = await fs.readdir(path.join(sdk, "sessions")).catch(() => [] as string[]);
		expect(sessions.filter(name => name.startsWith("index.jsonl.lock"))).toEqual([]);
		// Exactly one broker process bound to this dir.
		const ps = Bun.spawnSync(["ps", "-Ao", "args="]).stdout.toString();
		const brokers = ps
			.split("\n")
			.filter(line => line.includes("broker-internal") && line.includes(`--agent-dir ${dir}`));
		expect(brokers).toHaveLength(1);
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

it("concurrent CLI replacement composes stale-generation fencing with single-flight spawn", async () => {
	const dir = await temp();
	const ready = path.join(dir, "stale.ready");
	const staleBroker = spawnStaleBrokerWorker(dir, ready);
	let currentPid: number | undefined;
	try {
		await waitForFile(ready);
		const stale = JSON.parse(await fs.readFile(ready, "utf8")) as brokerDiscovery.BrokerDiscovery;
		const invocations = Array.from({ length: 6 }, () =>
			Bun.spawn([process.execPath, "run", cli, "sdk", "session", "list", "--scope", "all", "--agent-dir", dir], {
				cwd: import.meta.dir,
				stdout: "pipe",
				stderr: "pipe",
			}),
		);
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
		const ps = Bun.spawnSync(["ps", "-Ao", "args="]).stdout.toString();
		expect(
			ps.split("\n").filter(line => line.includes("broker-internal") && line.includes(`--agent-dir ${dir}`)),
		).toHaveLength(1);
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
	const stale = spawnExpiringStaleDiscoveryWorker(dir, ready, 19_000);
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
				env: { ...process.env, GJC_SDK_TEST_BROKER_STARTUP_DELAY_MS: "10000" },
			},
		);
		await Bun.sleep(14_000);
		unblock.resolve();
		await holder;
		const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect({ code, error }).toEqual({ code: 0, error: "" });
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
