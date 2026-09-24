import { afterEach, expect, test, vi } from "bun:test";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { Broker, setAmbiguityGraceForTest, setPublicationObservationForTest } from "../src/sdk/broker/broker";
import { readBrokerExitRecord, writeBrokerExitRecord } from "../src/sdk/broker/broker-exit";

// A short TTL drives the publication watchdog at `ttl/3`, so the fence advances
// in tens of milliseconds instead of the production five-second cadence.
const HEARTBEAT_TTL_MS = 300;
const WATCHDOG_CADENCE_MS = HEARTBEAT_TTL_MS / 3;

const brokers: Broker[] = [];
const roots: string[] = [];

async function startBroker(): Promise<Broker> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-fence-"));
	roots.push(root);
	const broker = new Broker({ agentDir: path.join(root, "agent"), heartbeatTtlMs: HEARTBEAT_TTL_MS });
	brokers.push(broker);
	await broker.start();
	return broker;
}

test("cached discovery is not owned until its publication is retained", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-fence-unpublished-"));
	roots.push(root);
	const agentDir = path.join(root, "agent");
	const broker = new Broker({
		agentDir,
		heartbeatTtlMs: HEARTBEAT_TTL_MS,
		startupPrePublicationDelayMs: 500,
	});
	brokers.push(broker);
	const starting = broker.start();
	try {
		for (let attempt = 0; broker.discovery === null && attempt < 200; attempt++) await Bun.sleep(5);
		expect(broker.discovery).not.toBeNull();
		expect(await Bun.file(path.join(agentDir, "sdk", "broker.json")).exists()).toBe(false);
		expect(broker.ownsDiscovery).toBe(false);

		await starting;
		expect(broker.ownsDiscovery).toBe(true);
	} catch (error) {
		await starting.catch(() => {});
		throw error;
	}
});

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
		setPublicationObservationForTest(broker, undefined);
		setAmbiguityGraceForTest(broker, undefined);
		await broker.stop().catch(() => {});
	}
	brokers.length = 0;
	for (const root of roots) await fs.rm(root, { recursive: true, force: true });
	roots.length = 0;
});

test("a permanently ambiguous broker self-terminates instead of lingering forever", async () => {
	const broker = await startBroker();
	setAmbiguityGraceForTest(broker, WATCHDOG_CADENCE_MS);
	// `observe()` returns "ambiguous" forever once the retained publication handle
	// is closed. Before the ambiguity deadline existed this state cleared the loss
	// timer on every tick, so the broker stopped heartbeating but never exited --
	// peers then discovered it as stale and spawned unbounded replacements.
	setPublicationObservationForTest(broker, "ambiguous");

	expect(await completedWithin(broker, WATCHDOG_CADENCE_MS * 20)).toBe(true);
});

test("a lost-root exit logs and persists one structured fence reason", async () => {
	const broker = await startBroker();
	const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
	setAmbiguityGraceForTest(broker, WATCHDOG_CADENCE_MS);
	setPublicationObservationForTest(broker, "ambiguous");

	try {
		await broker.completion;

		const exitLogs = warn.mock.calls.filter(([message]) => message === "sdk broker: exiting");
		expect(exitLogs).toHaveLength(1);
		expect(exitLogs[0]?.[1]).toMatchObject({
			mode: "lost-root",
			reason: "ownership-fence-expired",
			fenceReason: "observation-ambiguous",
			pid: process.pid,
			signal: null,
		});

		const record = await readBrokerExitRecord(broker.settings.agentDir);
		expect(record).toMatchObject({
			mode: "lost-root",
			reason: "ownership-fence-expired",
			fenceReason: "observation-ambiguous",
			pid: process.pid,
			signal: null,
		});
		expect(record?.fencedForMs).toBeGreaterThanOrEqual(WATCHDOG_CADENCE_MS);
		expect(record?.uptimeMs).toBeGreaterThanOrEqual(0);
		expect((await fs.stat(path.join(broker.settings.agentDir, "sdk", "broker.exit.json"))).size).toBeLessThanOrEqual(
			1_024,
		);
	} finally {
		warn.mockRestore();
	}
});

test("a signal stop persists its reason without synchronous fsync", async () => {
	const broker = await startBroker();
	const info = vi.spyOn(logger, "info").mockImplementation(() => {});
	const syncFsync = vi.spyOn(syncFs, "fsyncSync").mockImplementation(() => {
		throw new Error("signal exit must not fsync synchronously");
	});
	try {
		await broker.stop({ kind: "signal", signal: "SIGTERM" });

		expect(syncFsync).not.toHaveBeenCalled();
		const exitLogs = info.mock.calls.filter(([message]) => message === "sdk broker: exiting");
		expect(exitLogs).toHaveLength(1);
		expect(exitLogs[0]?.[1]).toMatchObject({
			mode: "owned-root",
			reason: "signal",
			fenceReason: null,
			fencedForMs: 0,
			pid: process.pid,
			signal: "SIGTERM",
		});
		expect(await readBrokerExitRecord(broker.settings.agentDir)).toMatchObject({
			reason: "signal",
			signal: "SIGTERM",
		});
	} finally {
		syncFsync.mockRestore();
		info.mockRestore();
	}
});

test("an aborted exit-record write cannot publish after its caller gives up", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-exit-abort-"));
	roots.push(root);
	const agentDir = path.join(root, "agent");
	const controller = new AbortController();
	const write = writeBrokerExitRecord(
		agentDir,
		{
			version: 1,
			mode: "owned-root",
			reason: "shutdown-request",
			fenceReason: null,
			fencedForMs: 0,
			uptimeMs: 1,
			pid: process.pid,
			signal: null,
			writtenAt: Date.now(),
		},
		controller.signal,
	);
	controller.abort();

	await expect(write).rejects.toThrow("write was aborted");
	expect(await readBrokerExitRecord(agentDir)).toBeUndefined();
	expect(await Bun.file(path.join(agentDir, "sdk", "broker.exit.json")).exists()).toBe(false);
});

test("transient ambiguity within the deadline does not terminate the broker", async () => {
	const broker = await startBroker();
	setAmbiguityGraceForTest(broker, 60_000);
	setPublicationObservationForTest(broker, "ambiguous");

	expect(await completedWithin(broker, WATCHDOG_CADENCE_MS * 6)).toBe(false);
});

test("recovering to owned clears accrued ambiguity", async () => {
	const broker = await startBroker();
	setAmbiguityGraceForTest(broker, WATCHDOG_CADENCE_MS * 8);
	setPublicationObservationForTest(broker, "ambiguous");
	await Bun.sleep(WATCHDOG_CADENCE_MS * 5);

	// Recovery must reset the clock, so the broker survives well past the point
	// where the original uninterrupted ambiguity would have expired.
	setPublicationObservationForTest(broker, "owned");
	await Bun.sleep(WATCHDOG_CADENCE_MS * 2);
	setPublicationObservationForTest(broker, "ambiguous");

	expect(await completedWithin(broker, WATCHDOG_CADENCE_MS * 5)).toBe(false);
});

test("a replaced publication still terminates on the shorter loss grace", async () => {
	const broker = await startBroker();
	// Replacement is proven, not ambiguous, so it must not wait for the ambiguity
	// deadline; the pre-existing 15s loss grace governs it.
	setAmbiguityGraceForTest(broker, 60_000);
	setPublicationObservationForTest(broker, "replaced");

	expect(await completedWithin(broker, 25_000)).toBe(true);
}, 30_000);
