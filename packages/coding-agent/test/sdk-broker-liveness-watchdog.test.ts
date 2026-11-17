import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import { logger } from "@gajae-code/utils";
import { Broker, setHeartbeatStallForTest, setLivenessGraceForTest } from "../src/sdk/broker/broker";
import { publishBrokerDiscovery, readBrokerDiscovery } from "../src/sdk/broker/discovery";
import {
	publicationLivenessHardExitEnabled,
	publicationLivenessMustExit,
} from "../src/sdk/broker/publication-liveness-deadline";
import {
	armPublicationLivenessWatchdog,
	disarmPublicationLivenessWatchdog,
	publicationLivenessWatchdogLost,
	setPublicationLivenessSlotExhaustedForTest,
	setPublicationLivenessWorkerStartFailureForTest,
} from "../src/sdk/broker/publication-liveness-watchdog";

// A short TTL drives the publication watchdog at `ttl/3`, so a liveness deadline
// expressed in cadences expires in tens of milliseconds.
const HEARTBEAT_TTL_MS = 300;
const WATCHDOG_CADENCE_MS = HEARTBEAT_TTL_MS / 3;

const brokers: Broker[] = [];
const roots: string[] = [];

async function startBroker(): Promise<Broker> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-liveness-"));
	roots.push(root);
	const broker = new Broker({ agentDir: path.join(root, "agent"), heartbeatTtlMs: HEARTBEAT_TTL_MS });
	brokers.push(broker);
	await broker.start();
	return broker;
}

/** Resolves to true when the broker self-terminated inside the window. */
function completedWithin(broker: Broker, ms: number): Promise<boolean> {
	return Promise.race([
		broker.completion.then(
			() => true,
			() => true,
		),
		Bun.sleep(ms).then(() => false),
	]);
}

afterEach(async () => {
	setPublicationLivenessWorkerStartFailureForTest(undefined);
	setPublicationLivenessSlotExhaustedForTest(false);
	for (const broker of brokers) {
		setHeartbeatStallForTest(broker, false);
		setLivenessGraceForTest(broker, undefined);
		await broker.stop().catch(() => {});
	}
	brokers.length = 0;
	for (const root of roots) await fs.rm(root, { recursive: true, force: true });
	roots.length = 0;
});

test("a broker whose heartbeat write never settles self-terminates and leaves its lock reclaimable", async () => {
	const broker = await startBroker();
	const ownerRecord = path.join(broker.settings.agentDir, "sdk", "broker.lock", "owner.json");
	setLivenessGraceForTest(broker, WATCHDOG_CADENCE_MS * 4);
	// The observation keeps reporting "owned" and nothing throws, so no fence is
	// ever armed. This is the state that survived 13.6 hours in #4704: alive,
	// holding its port and its lock, while peers read a heartbeat long past its TTL
	// and refused to reclaim a lock whose owner pid was still alive.
	setHeartbeatStallForTest(broker, true);

	// Completion resolves with the heartbeat still unresolved, which also proves
	// the teardown's synchronous `publication.close()` did not wait for it.
	expect(await completedWithin(broker, WATCHDOG_CADENCE_MS * 40)).toBe(true);

	// lost-root deliberately keeps the lock record: this process is exiting, and
	// the dead-owner reclaim (#3963) is what hands it to the successor. Taking it
	// over is covered by sdk-broker-restart's stale-lock takeover tests.
	expect(JSON.parse(await fs.readFile(ownerRecord, "utf8"))).toMatchObject({ pid: process.pid });
});

test("a broker that keeps publishing is never terminated by the liveness deadline", async () => {
	const broker = await startBroker();
	// Far shorter than production and still several cadences wide, so a healthy
	// broker republishes many times inside the window it is watched for.
	setLivenessGraceForTest(broker, WATCHDOG_CADENCE_MS * 8);

	expect(await completedWithin(broker, WATCHDOG_CADENCE_MS * 24)).toBe(false);
});

test("AC1: a stalled session checkpoint does not starve discovery heartbeats or block stop", async () => {
	const broker = await startBroker();
	const checkpointEntered = Promise.withResolvers<void>();
	const releaseCheckpoint = Promise.withResolvers<void>();
	// Install after startup so only the periodic checkpoint stalls; retained
	// publication IO and the broker's watchdog/checkpoint wrapper stay real.
	const checkpoint = vi.spyOn(broker.index, "checkpointLiveHeartbeats").mockImplementation(async () => {
		checkpointEntered.resolve();
		await releaseCheckpoint.promise;
		return 0;
	});
	try {
		expect(
			await Promise.race([
				checkpointEntered.promise.then(() => true),
				Bun.sleep(WATCHDOG_CADENCE_MS * 20).then(() => false),
			]),
		).toBe(true);
		const before = await readBrokerDiscovery(broker.settings.agentDir, HEARTBEAT_TTL_MS);
		expect(before).not.toBeNull();
		let heartbeatAt = before!.heartbeatAt;
		await Bun.sleep(HEARTBEAT_TTL_MS + WATCHDOG_CADENCE_MS);
		for (let tick = 0; tick < 3; tick += 1) {
			expect(checkpoint).toHaveBeenCalledTimes(1);
			const discovery = await readBrokerDiscovery(broker.settings.agentDir, HEARTBEAT_TTL_MS);
			expect(discovery).not.toBeNull();
			expect(discovery!.ownerId).toBe(before!.ownerId);
			expect(discovery!.heartbeatAt).toBeGreaterThan(heartbeatAt);
			heartbeatAt = discovery!.heartbeatAt;
			await Bun.sleep(WATCHDOG_CADENCE_MS * 2);
		}
		expect(checkpoint).toHaveBeenCalledTimes(1);
		// Stop must settle while the checkpoint is still waiting on its release.
		expect(
			await Promise.race([broker.stop().then(() => true), Bun.sleep(WATCHDOG_CADENCE_MS * 20).then(() => false)]),
		).toBe(true);
	} finally {
		releaseCheckpoint.resolve();
		checkpoint.mockRestore();
		await broker.stop();
	}
});

test("AC2: a contender yields to the live owner while its session checkpoint is stalled beyond discovery TTL", async () => {
	const broker = await startBroker();
	const checkpointEntered = Promise.withResolvers<void>();
	const releaseCheckpoint = Promise.withResolvers<void>();
	const checkpoint = vi.spyOn(broker.index, "checkpointLiveHeartbeats").mockImplementation(async () => {
		checkpointEntered.resolve();
		await releaseCheckpoint.promise;
		return 0;
	});
	const info = vi.spyOn(logger, "info");
	try {
		expect(
			await Promise.race([
				checkpointEntered.promise.then(() => true),
				Bun.sleep(WATCHDOG_CADENCE_MS * 20).then(() => false),
			]),
		).toBe(true);
		const owner = broker.discovery!;
		await Bun.sleep(HEARTBEAT_TTL_MS + WATCHDOG_CADENCE_MS);
		const contender = new Broker({ agentDir: broker.settings.agentDir, heartbeatTtlMs: HEARTBEAT_TTL_MS });
		brokers.push(contender);
		const discovered = await contender.start();
		expect(discovered).toMatchObject({
			ownerId: owner.ownerId,
			pid: owner.pid,
			url: owner.url,
			token: owner.token,
			startedAt: owner.startedAt,
		});
		expect(info).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ reason: "startup-race-lost", ownerId: owner.ownerId, pid: owner.pid, exitCode: 0 }),
		);
		expect(checkpoint).toHaveBeenCalledTimes(1);
	} finally {
		releaseCheckpoint.resolve();
		checkpoint.mockRestore();
		info.mockRestore();
		await broker.stop();
	}
});

test("the retained heartbeat never runs its blocking write or fsync on the JS thread", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-liveness-thread-"));
	roots.push(root);
	const agentDir = path.join(root, "agent");
	// The write and its fsync block until the device returns, which is what leaves
	// the watchdog above unable to run at all. The synchronous bindings are gone
	// from the native surface for that reason; these stubs stand in their place so
	// a reintroduced JS-thread call fails loudly instead of silently wedging.
	const retain = vi.spyOn(native, "retainBrokerPublication").mockReturnValue({
		observe: () => ({ kind: "owned" }),
		observeAsync: () => Promise.resolve({ kind: "owned" }),
		heartbeat: () => {
			throw new Error("blocking heartbeat write must not run on the JS thread");
		},
		sync: () => {
			throw new Error("blocking fsync must not run on the JS thread");
		},
		heartbeatAsync: () => Promise.resolve({ kind: "written" }),
		syncAsync: () => Promise.resolve({ kind: "synced" }),
		close: () => ({ kind: "closed" }),
	} as never);
	const now = Date.now();
	const publication = await publishBrokerDiscovery(agentDir, {
		version: 1,
		protocolVersion: 3,
		packageGeneration: "test",
		ownerId: "off-thread-owner",
		pid: process.pid,
		host: "127.0.0.1",
		port: 1,
		url: "ws://127.0.0.1:1",
		token: "off-thread-token",
		startedAt: now,
		heartbeatAt: now,
	});
	try {
		expect(await publication.heartbeat(now + 1)).toBe(true);
	} finally {
		publication.close();
		retain.mockRestore();
	}
});

test("the watchdog observes retained publication asynchronously", async () => {
	const originalRetain = native.retainBrokerPublication;
	const synchronousObserve = vi.fn(() => {
		throw new Error("watchdog must not use synchronous publication observation");
	});
	const asynchronousObserve = vi.fn(async () => ({ kind: "owned" as const }));
	const retain = vi.spyOn(native, "retainBrokerPublication").mockImplementation(agentDir => {
		const publication = originalRetain(agentDir);
		return {
			observe: synchronousObserve,
			observeAsync: asynchronousObserve,
			heartbeatAsync: publication.heartbeatAsync.bind(publication),
			syncAsync: publication.syncAsync.bind(publication),
			close: publication.close.bind(publication),
		} as never;
	});
	try {
		const broker = await startBroker();
		setHeartbeatStallForTest(broker, true);
		await Bun.sleep(WATCHDOG_CADENCE_MS * 2);
		expect(asynchronousObserve).toHaveBeenCalled();
		expect(synchronousObserve).not.toHaveBeenCalled();
	} finally {
		retain.mockRestore();
	}
});

test("a stale watchdog observation cannot reopen startup admission after lost-root", async () => {
	const originalRetain = native.retainBrokerPublication;
	const observation = Promise.withResolvers<{ kind: "owned" }>();
	let observed = false;
	const retain = vi.spyOn(native, "retainBrokerPublication").mockImplementation(agentDir => {
		const publication = originalRetain(agentDir);
		return {
			observe: publication.observe.bind(publication),
			observeAsync: () => {
				observed = true;
				return observation.promise;
			},
			heartbeatAsync: publication.heartbeatAsync.bind(publication),
			syncAsync: publication.syncAsync.bind(publication),
			close: publication.close.bind(publication),
		} as never;
	});
	try {
		const broker = await startBroker();
		setLivenessGraceForTest(broker, WATCHDOG_CADENCE_MS * 4);
		await Bun.sleep(WATCHDOG_CADENCE_MS * 2);
		expect(observed).toBe(true);
		expect(await completedWithin(broker, WATCHDOG_CADENCE_MS * 10)).toBe(true);

		observation.resolve({ kind: "owned" });
		await Bun.sleep(0);
		const admission = await broker.runStartup(
			1,
			{ now: Date.now, sleep: async () => undefined },
			async () => "admitted",
		);
		expect(admission.status).toBe("admission_refused");
	} finally {
		retain.mockRestore();
	}
});

test("a stale watchdog observation cannot mutate a restarted broker generation", async () => {
	const originalRetain = native.retainBrokerPublication;
	const observation = Promise.withResolvers<{ kind: "owned" }>();
	let retainCount = 0;
	const retain = vi.spyOn(native, "retainBrokerPublication").mockImplementation(agentDir => {
		const publication = originalRetain(agentDir);
		retainCount += 1;
		if (retainCount !== 1) return publication;
		return {
			observe: publication.observe.bind(publication),
			observeAsync: () => observation.promise,
			heartbeatAsync: publication.heartbeatAsync.bind(publication),
			syncAsync: publication.syncAsync.bind(publication),
			close: publication.close.bind(publication),
		} as never;
	});
	try {
		const broker = await startBroker();
		await Bun.sleep(WATCHDOG_CADENCE_MS * 2);
		await broker.stop();
		await broker.start();
		observation.resolve({ kind: "owned" });
		await Bun.sleep(0);
		expect(await broker.handleRequest("session.list", {})).toMatchObject({ ok: true });
	} finally {
		retain.mockRestore();
	}
});

interface WatchdogInitChildReport {
	result: string;
	message?: string;
	reason?: string | null;
	mode?: string | null;
	memory?: boolean;
	file?: boolean;
	lock?: boolean;
}

async function runWatchdogInitChild(mode: "fail" | "slots" | "lost"): Promise<WatchdogInitChildReport> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-liveness-init-"));
	roots.push(root);
	const agentDir = path.join(root, "agent");
	const home = path.join(root, "home");
	await fs.mkdir(home);
	const childPath = path.join(import.meta.dir, "sdk-broker-liveness-watchdog-init-child.ts");
	const child = Bun.spawn([process.execPath, childPath, agentDir, mode], {
		cwd: path.join(import.meta.dir, ".."),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			HOME: home,
			GJC_CODING_AGENT_DIR: agentDir,
			GJC_BROKER_LIVENESS_HARD_EXIT: "1",
		},
	});
	const finished = await Promise.race([child.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
	if (!finished) child.kill("SIGKILL");
	const stdout = await new Response(child.stdout).text();
	const stderr = await new Response(child.stderr).text();
	expect(finished, `still alive\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBe(true);
	expect(child.exitCode, `${stderr}\n${stdout}`).toBe(0);
	const line = stdout
		.trim()
		.split("\n")
		.findLast(row => row.startsWith("{"));
	expect(line, stdout).toBeTruthy();
	return JSON.parse(line ?? "{}") as WatchdogInitChildReport;
}

test("broker startup fails and releases lock and discovery when the liveness watchdog cannot start", async () => {
	const report = await runWatchdogInitChild("fail");
	expect(report.result).toBe("failed");
	expect(report.message).toContain("publication liveness watchdog unavailable");
	expect(report.message).toContain("worker failed to start");
	expect(report.memory).toBe(false);
	expect(report.file).toBe(false);
	expect(report.lock).toBe(false);
}, 15_000);

test("broker startup fails and releases lock and discovery when the liveness watchdog slot table is full", async () => {
	const report = await runWatchdogInitChild("slots");
	expect(report.result).toBe("failed");
	expect(report.message).toContain("publication liveness watchdog slot table is full");
	expect(report.memory).toBe(false);
	expect(report.file).toBe(false);
	expect(report.lock).toBe(false);
}, 15_000);

test("a watchdog worker that exits after startup ends the broker", async () => {
	const report = await runWatchdogInitChild("lost");
	expect(report).toMatchObject({
		result: "exited",
		reason: "publication-liveness-timeout",
		mode: "lost-root",
		memory: false,
		file: true,
		lock: true,
	});
}, 15_000);

test("retired watchdog events cannot mark a replacement worker lost", async () => {
	const originalWorker = globalThis.Worker;
	const previousFlag = process.env.GJC_BROKER_LIVENESS_HARD_EXIT;
	const workers: FakeWorker[] = [];
	class FakeWorker extends EventTarget {
		constructor() {
			super();
			workers.push(this);
		}
		terminate(): void {}
		ready(): void {
			this.dispatchEvent(new MessageEvent("message", { data: { type: "ready" } }));
		}
	}
	const firstOwner = {};
	const secondOwner = {};
	const thirdOwner = {};
	globalThis.Worker = FakeWorker as unknown as typeof Worker;
	process.env.GJC_BROKER_LIVENESS_HARD_EXIT = "1";
	try {
		const firstArm = armPublicationLivenessWatchdog(firstOwner, 60_000, 1_000);
		expect(workers).toHaveLength(1);
		workers[0].ready();
		expect(await firstArm).toBe(true);

		workers[0].dispatchEvent(new Event("error"));
		expect(publicationLivenessWatchdogLost()).toBe(true);
		const secondArm = armPublicationLivenessWatchdog(secondOwner, 60_000, 1_000);
		expect(workers).toHaveLength(2);
		workers[1].ready();
		expect(await secondArm).toBe(true);
		expect(publicationLivenessWatchdogLost()).toBe(false);

		for (const event of ["close", "exit", "error"]) workers[0].dispatchEvent(new Event(event));
		expect(publicationLivenessWatchdogLost()).toBe(false);
		expect(await armPublicationLivenessWatchdog(thirdOwner, 60_000, 1_000)).toBe(true);
		expect(workers).toHaveLength(2);

		workers[1].dispatchEvent(new Event("exit"));
		expect(publicationLivenessWatchdogLost()).toBe(true);
		workers[1].dispatchEvent(new Event("close"));
		expect(publicationLivenessWatchdogLost()).toBe(true);
	} finally {
		for (const worker of workers) worker.dispatchEvent(new Event("exit"));
		for (const owner of [firstOwner, secondOwner, thirdOwner]) disarmPublicationLivenessWatchdog(owner);
		globalThis.Worker = originalWorker;
		if (previousFlag === undefined) delete process.env.GJC_BROKER_LIVENESS_HARD_EXIT;
		else process.env.GJC_BROKER_LIVENESS_HARD_EXIT = previousFlag;
	}
});

test("hard-exit opt-out still starts when watchdog initialization cannot succeed", async () => {
	const previous = process.env.GJC_BROKER_LIVENESS_HARD_EXIT;
	process.env.GJC_BROKER_LIVENESS_HARD_EXIT = "0";
	setPublicationLivenessWorkerStartFailureForTest(new Error("worker failed to start"));
	setPublicationLivenessSlotExhaustedForTest(true);
	try {
		const broker = await startBroker();
		expect(broker.discovery).not.toBeNull();
		expect((await readBrokerDiscovery(broker.settings.agentDir, HEARTBEAT_TTL_MS))?.ownerId).toBe(
			broker.discovery?.ownerId,
		);
		const lockPath = path.join(broker.settings.agentDir, "sdk", "broker.lock");
		expect(await fs.stat(lockPath)).toBeTruthy();
	} finally {
		setPublicationLivenessWorkerStartFailureForTest(undefined);
		setPublicationLivenessSlotExhaustedForTest(false);
		if (previous === undefined) delete process.env.GJC_BROKER_LIVENESS_HARD_EXIT;
		else process.env.GJC_BROKER_LIVENESS_HARD_EXIT = previous;
	}
});

test("publication liveness hard-exit stays disarmed in the test runner", () => {
	expect(publicationLivenessHardExitEnabled()).toBe(false);
	expect(publicationLivenessHardExitEnabled({ GJC_BROKER_LIVENESS_HARD_EXIT: "1", BUN_ENV: "test" })).toBe(true);
	expect(publicationLivenessHardExitEnabled({ GJC_BROKER_LIVENESS_HARD_EXIT: "0" })).toBe(false);
});

test("a blocked event loop is the only hard-exit case", () => {
	const graceMs = 60_000n;
	const cadenceMs = 5_000n;
	const publishedMs = 1_000n;
	// cadence * 4 = 20s, which is inside the 60s publication grace.
	const loopLimitMs = 20_000n;
	expect(
		publicationLivenessMustExit({
			nowMs: publishedMs + graceMs - 1n,
			publishedMs,
			loopMs: publishedMs,
			graceMs,
			cadenceMs,
			active: 1n,
		}),
	).toBe(false);
	expect(
		publicationLivenessMustExit({
			nowMs: publishedMs + graceMs,
			publishedMs,
			loopMs: publishedMs + graceMs - cadenceMs,
			graceMs,
			cadenceMs,
			active: 1n,
		}),
	).toBe(false);
	expect(
		publicationLivenessMustExit({
			nowMs: publishedMs + graceMs,
			publishedMs,
			loopMs: publishedMs + graceMs - loopLimitMs,
			graceMs,
			cadenceMs,
			active: 1n,
		}),
	).toBe(true);
	expect(
		publicationLivenessMustExit({
			nowMs: publishedMs + graceMs,
			publishedMs,
			loopMs: publishedMs + graceMs - loopLimitMs,
			graceMs,
			cadenceMs,
			active: 0n,
		}),
	).toBe(false);
});

test("a heartbeat write that blocks the JS thread still trips publication-liveness-timeout", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-liveness-block-"));
	roots.push(root);
	const agentDir = path.join(root, "agent");
	const home = path.join(root, "home");
	await fs.mkdir(home);
	const graceMs = 500;
	const blockMs = 30_000;
	const childPath = path.join(import.meta.dir, "sdk-broker-liveness-blocked-write-child.ts");
	const startedAt = performance.now();
	const child = Bun.spawn([process.execPath, childPath, agentDir, String(graceMs), String(blockMs)], {
		cwd: path.join(import.meta.dir, ".."),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			HOME: home,
			GJC_CODING_AGENT_DIR: agentDir,
			GJC_BROKER_LIVENESS_HARD_EXIT: "1",
		},
	});
	const finished = await Promise.race([child.exited.then(() => true), Bun.sleep(15_000).then(() => false)]);
	if (!finished) child.kill("SIGKILL");
	const stdout = await new Response(child.stdout).text();
	const stderr = await new Response(child.stderr).text();
	const elapsedMs = performance.now() - startedAt;
	expect(finished, `still alive after ${elapsedMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBe(true);
	expect(stdout, stderr).toContain("hooks-installed");
	expect(stdout, stderr).not.toContain("graceful");
	expect(elapsedMs, stderr).toBeLessThan(blockMs);
	expect(
		child.signalCode === "SIGKILL" || child.exitCode === 137,
		`signal=${String(child.signalCode)} exit=${String(child.exitCode)}\n${stderr}`,
	).toBe(true);
}, 30_000);

test.skipIf(process.platform === "win32")(
	"publication-liveness SIGKILL still fires when stderr cannot accept a write",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-liveness-stderr-"));
		roots.push(root);
		const agentDir = path.join(root, "agent");
		const home = path.join(root, "home");
		await fs.mkdir(home);
		const graceMs = 500;
		const blockMs = 30_000;
		const childPath = path.join(import.meta.dir, "sdk-broker-liveness-blocked-write-child.ts");
		const startedAt = performance.now();
		const child = Bun.spawn(
			[process.execPath, childPath, agentDir, String(graceMs), String(blockMs), "block-stderr"],
			{
				cwd: path.join(import.meta.dir, ".."),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					HOME: home,
					GJC_CODING_AGENT_DIR: agentDir,
					GJC_BROKER_LIVENESS_HARD_EXIT: "1",
				},
			},
		);
		const finished = await Promise.race([child.exited.then(() => true), Bun.sleep(15_000).then(() => false)]);
		if (!finished) child.kill("SIGKILL");
		const stdout = await new Response(child.stdout).text();
		const elapsedMs = performance.now() - startedAt;
		expect(finished, `still alive after ${elapsedMs}ms\nstdout:\n${stdout}`).toBe(true);
		expect(stdout).toContain("hooks-installed");
		expect(stdout).toContain("stderr-blocked");
		expect(stdout).not.toContain("graceful");
		expect(elapsedMs).toBeLessThan(blockMs);
		expect(
			child.signalCode === "SIGKILL" || child.exitCode === 137,
			`signal=${String(child.signalCode)} exit=${String(child.exitCode)}`,
		).toBe(true);
	},
	30_000,
);

test("a heartbeat that resumes before the deadline clears the accrued stall", async () => {
	const broker = await startBroker();
	setLivenessGraceForTest(broker, WATCHDOG_CADENCE_MS * 12);
	setHeartbeatStallForTest(broker, true);
	await Bun.sleep(WATCHDOG_CADENCE_MS * 6);

	// Recovered IO releases the stalled tick, which publishes and resets the clock,
	// so the broker outlives the point where the uninterrupted stall would have
	// expired. Termination must follow lost liveness, not a transient slow write.
	setHeartbeatStallForTest(broker, false);

	expect(await completedWithin(broker, WATCHDOG_CADENCE_MS * 10)).toBe(false);
});
