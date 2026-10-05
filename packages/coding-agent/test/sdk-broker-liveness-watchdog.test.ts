import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import { logger } from "@gajae-code/utils";
import { Broker, setHeartbeatStallForTest, setLivenessGraceForTest } from "../src/sdk/broker/broker";
import { publishBrokerDiscovery, readBrokerDiscovery } from "../src/sdk/broker/discovery";

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
