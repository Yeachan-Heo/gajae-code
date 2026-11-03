import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_FAILURE_REASONS } from "@gajae-gateway/protocol";
import { GjcCliError } from "@gajae-gateway/subsession";
import { DeliveryService } from "../src/delivery/delivery";
import { MemoryClosureQueue } from "../src/memory/closure";
import { initializeMemory } from "../src/memory/doctrine";
import { failureDetail, MonitorPropagator } from "../src/monitors/propagate";
import { MonitorRegistry } from "../src/monitors/registry";
import { MonitorRuntime } from "../src/monitors/runtime";
import {
	compileCron,
	cronMatches,
	DEFAULT_CRON_CATCH_UP,
	planCronCatchUp,
	startCron,
} from "../src/monitors/triggers/cron";
import { GjcRuntimeError } from "../src/orchestrator/rebind";
import {
	ModelNotSelectedError,
	SessionRequestTimeoutError,
	SessionTerminalError,
} from "../src/orchestrator/session-port";
import { RelayHelloError, RelayRefusedError } from "../src/orchestrator/tail-runner";
import { startUnixServer } from "../src/server/server";
import { Store } from "../src/store";
import {
	MONITOR_EVENT_MAX_DISPATCH_ATTEMPTS,
	MONITOR_EVENT_MAX_OPEN_AGE_MS,
	MONITOR_EVENT_RETRY_BACKOFF_MS,
} from "../src/store/groups/monitors";
import type { SessionPortResponder } from "./session-port.fake";
import { sessionPortFromScript } from "./session-port.fake";

let home = "";
let database: Store | undefined;
let propagators: MonitorPropagator[] = [];
afterEach(async () => {
	for (const propagator of propagators) await propagator.drain();
	propagators = [];
	database?.close();
	database = undefined;
	if (home) await rm(home, { recursive: true, force: true });
	home = "";
});

function fakeSessionPort(respond: SessionPortResponder) {
	return sessionPortFromScript({ bind: async () => ({ sessionId: "s1" }), respond });
}

async function harness(
	respond: SessionPortResponder,
	options: {
		ownerTarget?: { origin: { platform: "loopback"; kind: "loopback"; conversationId: "loopback" } };
		now?: () => number;
	} = {},
) {
	home = await mkdtemp(join(tmpdir(), "gajaeway-monitor-"));
	database = await Store.open(join(home, "gateway.db"));
	const registry = new MonitorRegistry(database);
	const monitor = registry.add({
		name: "canonicalize",
		trigger: { kind: "cron", schedule: "30 */6 * * *" },
		eventTypes: ["memory.canonicalize"],
		burstPolicy: "dedupe",
		enabled: true,
	});
	const sessionPort = fakeSessionPort(respond);
	const propagator = new MonitorPropagator({
		database,
		registry,
		sessionPort,
		memory: { enqueue: () => crypto.randomUUID(), enqueueExistingId: () => {} } as never,
		delivery: new DeliveryService(database),
		emit: () => {},
		...(options.ownerTarget ? { ownerTarget: options.ownerTarget } : {}),
		...(options.now ? { now: options.now } : {}),
	});
	propagators.push(propagator);
	return { propagator, monitor, database, registry, sessionPort };
}

function eventsFromPrompt(text: string): Array<{ eventId: string }> {
	const match = text.match(/\[.*\]$/s);
	if (!match) throw new Error("prompt has no event array");
	return JSON.parse(match[0]) as Array<{ eventId: string }>;
}

type MonitorEventInput = Parameters<Store["monitors"]["eventCreate"]>[1];
type MonitorStage = Parameters<Store["monitors"]["eventUpdate"]>[2];

function createEvent(db: Store, row: MonitorEventInput): void {
	db.transaction((tx) => db.monitors.eventCreate(tx, row));
}

function updateEvent(db: Store, eventId: string, stage: MonitorStage, batchId?: string | null): void {
	db.transaction((tx) => db.monitors.eventUpdate(tx, eventId, stage, batchId));
}

function createMonitor(db: Store, row: Parameters<Store["monitors"]["create"]>[1]): void {
	db.transaction((tx) => db.monitors.create(tx, row));
}

function recordFailure(
	db: Store,
	eventId: string,
	code: string,
	detail: string,
	options?: Parameters<Store["monitors"]["failureRecord"]>[4],
): void {
	db.transaction((tx) => db.monitors.failureRecord(tx, eventId, code, detail, options));
}

function createOutput(db: Store, eventId: string, output: string): void {
	db.transaction((tx) => db.monitors.authoredOutputCreate(tx, eventId, output));
}

function createIntent(db: Store, row: { id: string; kind: string; payloadJson: string }): void {
	db.transaction((tx) => db.memory.createIntent(tx, row));
}

function confirmAndSettleMonitorDelivery(
	db: Store,
	deliveryId: string,
	stageName: "delivered" | "authored",
): "unknown" | "transitioned" | "already_terminal" {
	return db.transaction((tx) => {
		const delivery = db.outbox.get(deliveryId);
		if (!delivery) return "unknown";
		if (delivery.state === "confirmed" || delivery.state === "expired") {
			if (delivery.state === "confirmed") db.monitors.settleForTurn(tx, delivery.turnId, stageName);
			return "already_terminal";
		}
		db.outbox.confirm(tx, deliveryId);
		db.monitors.settleForTurn(tx, delivery.turnId, stageName);
		return "transitioned";
	});
}

function acquireLease(
	db: Store,
	eventId: string,
	owner: string,
	leaseId: string,
	ttlMs: number,
	now?: number,
): boolean {
	return db.transaction((tx) => db.monitors.eventAcquireLease(tx, eventId, owner, leaseId, ttlMs, now));
}

function renewLease(db: Store, eventId: string, leaseId: string, ttlMs: number, now?: number): boolean {
	return db.transaction((tx) => db.monitors.eventRenewLease(tx, eventId, leaseId, ttlMs, now));
}

function releaseLease(db: Store, eventId: string, leaseId: string): void {
	db.transaction((tx) => db.monitors.eventReleaseLease(tx, eventId, leaseId));
}

const stage = (db: Store, id: string) => db.monitors.eventRows().find((row) => row.event_id === id)?.stage;

function seedEvent(db: Store, monitorId: string, stage: string, batchId: string | null = null): string {
	const eventId = crypto.randomUUID();
	db.transaction((tx) => {
		db.monitors.eventCreate(tx, {
			eventId,
			monitorId,
			eventType: "memory.canonicalize",
			payloadJson: JSON.stringify({ at: new Date().toISOString() }),
			firedAt: new Date().toISOString(),
		});
		db.monitors.eventUpdate(tx, eventId, stage as never, batchId);
	});
	return eventId;
}

function backdateMonitor(db: Store, monitorId: string, createdAt: Date): void {
	db.transaction((tx) => db.monitors.setCreatedAt(tx, monitorId, createdAt.toISOString()));
}

test("monitor.inspect exposes quarantined accepted and failed history without recovery sends", async () => {
	let sends = 0;
	const {
		database: db,
		monitor,
		propagator,
		sessionPort,
	} = await harness(async () => {
		sends++;
		throw new Error("quarantined history must not send");
	});
	// Dispatched is the durable monitor stage for an accepted authoring turn.
	const accepted = seedEvent(db, monitor.monitorId, "dispatched", "old-accepted-batch");
	const failed = seedEvent(db, monitor.monitorId, "failed", "old-failed-batch");
	const recovered = seedEvent(db, monitor.monitorId, "failed", "recovered-batch");
	db.transaction((tx) => {
		db.monitors.failureRecord(tx, recovered, "authoring_response_invalid", "safe protocol failure", {
			protocolFailure: {
				reason: "protocol_unparseable_json",
				responseByteLength: 12,
				responseEntryCount: null,
			},
		});
		db.monitors.eventUpdate(tx, recovered, "delivered");
	});
	db.transaction((tx) =>
		db.bindings.cutoverBrokerAuthority(tx, {
			expectedAuthority: null,
			targetAuthority: { canonicalAgentDir: "/tmp/monitor-inspection-global", identity: "shared-broker" },
			evidence: "Test operator authorized historical monitor quarantine",
			disposition: "quarantine",
		}),
	);
	const history = db.monitors.eventRows(monitor.monitorId, "newest", true);
	expect(history).toHaveLength(3);
	expect(db.monitors.eventRows()).toEqual([]);
	expect(db.monitors.eventRows(undefined, "oldest")).toEqual([]);
	expect(db.monitors.eventRows(monitor.monitorId, "oldest")).toEqual([]);
	await propagator.reconcile();
	expect(sends).toBe(0);
	const socketPath = join(home, "inspect.sock");
	const server = await startUnixServer({
		config: {
			schemaVersion: 1,
			home,
			gjc: { agentDir: join(home, "agent") },
			configPath: join(home, "config.json"),
			socketPath,
			dbPath: join(home, "gateway.db"),
			logVerbosity: "info",
		},
		database: db,
		sessionPort,
		onStop: () => {},
	});
	let socket: Awaited<ReturnType<typeof Bun.connect>> | undefined;
	try {
		const frames: Array<Record<string, unknown>> = [];
		let buffered = "";
		const connected = await Bun.connect({
			unix: socketPath,
			socket: {
				data(_socket, data) {
					buffered += Buffer.from(data).toString();
					const lines = buffered.split("\n");
					buffered = lines.pop() ?? "";
					for (const line of lines) if (line) frames.push(JSON.parse(line));
				},
			},
		});
		socket = connected;
		const request = async (id: string, verb: "monitor.inspect" | "monitor.list") => {
			connected.write(
				`${JSON.stringify({
					v: "0.1",
					type: "request",
					id,
					verb,
					...(verb === "monitor.inspect" ? { params: { monitorId: monitor.monitorId } } : {}),
				})}\n`,
			);
			for (let attempt = 0; attempt < 400; attempt++) {
				const frame = frames.find((entry) => entry.id === id);
				if (frame) {
					expect(frame.type).toBe("response");
					return frame.result as Record<string, unknown>;
				}
				await Bun.sleep(5);
			}
			throw new Error(`no ${verb} response for ${id}`);
		};
		connected.write(`${JSON.stringify({ v: "0.1", type: "hello", payload: { supportedVersions: ["0.1"] } })}\n`);
		const listResponse = await request("list", "monitor.list");
		const list = listResponse.monitors as Array<Record<string, unknown>>;
		const schedules = listResponse.schedules as Record<string, Record<string, unknown>>;
		expect(list[0]).not.toHaveProperty("nextFireAt");
		expect(schedules[monitor.monitorId]).toMatchObject({
			effectiveTimezone: monitor.trigger.kind === "cron" ? monitor.trigger.timezone : null,
			nextFireAt: {
				local: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
				utc: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
			},
		});
		const inspected = await request("history", "monitor.inspect");
		const inspectedMonitor = inspected.monitor as Record<string, unknown>;
		const rows = inspected.recentEvents as Array<Record<string, unknown>>;
		expect(inspectedMonitor).not.toHaveProperty("nextFireAt");
		expect(inspected.schedule).toMatchObject({
			effectiveTimezone: monitor.trigger.kind === "cron" ? monitor.trigger.timezone : null,
			nextFireAt: {
				local: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
				utc: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
			},
		});
		expect(inspected.catchUp).toBeUndefined();
		new MonitorRegistry(db).recordCronSkip(
			monitor.monitorId,
			{
				count: 2,
				oldest: "2026-09-01T00:00:00.000Z",
				newest: "2026-09-01T00:01:00.000Z",
			},
			"2026-09-01T00:02:00.000Z",
		);
		const inspectedWithCatchUp = await request("history-skips", "monitor.inspect");
		expect(inspectedWithCatchUp.catchUp).toEqual({
			skippedTotal: 2,
			lastSkip: {
				count: 2,
				oldest: "2026-09-01T00:00:00.000Z",
				newest: "2026-09-01T00:01:00.000Z",
				recordedAt: "2026-09-01T00:02:00.000Z",
			},
		});
		expect(rows).toHaveLength(3);
		for (const [eventId, stage] of [
			[accepted, "dispatched"],
			[failed, "failed"],
		]) {
			expect(rows.find((row) => row.eventId === eventId)).toMatchObject({
				stage,
				quarantined: true,
				reason: "broker_authority_quarantined",
			});
		}
		expect(rows.find((row) => row.eventId === recovered)).toMatchObject({
			stage: "delivered",
			recovery: {
				protocolFailures: [
					{
						reason: "protocol_unparseable_json",
						responseByteLength: 12,
						responseEntryCount: null,
					},
				],
				firstFailedAt: expect.any(String),
				deliveredAt: expect.any(String),
				recoveryLatencyMs: expect.any(Number),
				dispatchAttempts: 1,
			},
		});
		// Terminal current-authority events exercise the existing history bound without dispatch.
		for (let index = 0; index < 101; index++) seedEvent(db, monitor.monitorId, "authored_no_delivery");
		const boundedResponse = await request("bounded", "monitor.inspect");
		const bounded = boundedResponse.recentEvents as Array<Record<string, unknown>>;
		expect(bounded).toHaveLength(100);
		expect(bounded.map((row) => row.eventId)).toEqual(
			db.monitors
				.eventRows(monitor.monitorId, "newest", true)
				.slice(0, 100)
				.map((row) => row.event_id),
		);
		for (const row of bounded.filter((row) => row.eventId !== accepted && row.eventId !== failed)) {
			expect(row.quarantined).toBeUndefined();
			expect(row.reason).toBeUndefined();
		}
		await propagator.reconcile();
		expect(sends).toBe(0);
		expect(
			db.monitors
				.eventRows(monitor.monitorId, "newest", true)
				.filter((row) => [accepted, failed, recovered].includes(row.event_id)),
		).toEqual(history);
	} finally {
		await server.stop();
		socket?.end();
	}
});
describe("monitor crash-boundary state machine", () => {
	test("admitted→batched→dispatched→authored via a live dispatch", async () => {
		const {
			propagator,
			monitor,
			database: db,
		} = await harness(async (_id, text) =>
			JSON.stringify(eventsFromPrompt(text).map(({ eventId }) => ({ eventId, note: "authored note" }))),
		);
		const eventId = propagator.submit(monitor.monitorId, "memory.canonicalize", { at: "now" });
		for (let attempt = 0; attempt < 100 && stage(db, eventId) !== "authored_no_delivery"; attempt++)
			await Bun.sleep(10);
		expect(stage(db, eventId)).toBe("authored_no_delivery");
		expect(db.monitors.authoredOutput(eventId)).toBe("authored note");
	});

	test("restart crossing the batched stage: reconcile reclaims a stranded batched row exactly once", async () => {
		let turns = 0;
		const {
			propagator,
			monitor,
			database: db,
		} = await harness(async (_id, text) => {
			turns++;
			return JSON.stringify(eventsFromPrompt(text).map(({ eventId }) => ({ eventId, note: `note ${turns}` })));
		});
		const stranded = seedEvent(db, monitor.monitorId, "batched", crypto.randomUUID());
		await propagator.reconcile();
		// No target configured: the reclaimed event settles terminal, not authored-forever.
		expect(stage(db, stranded)).toBe("authored_no_delivery");
		expect(turns).toBe(1);
		// Idempotent: a second sweep does not re-author it.
		await propagator.reconcile();
		expect(turns).toBe(1);
	});

	test("dispatched-stranded rows are reclaimed by reconcile", async () => {
		const {
			propagator,
			monitor,
			database: db,
		} = await harness(async (_id, text) =>
			JSON.stringify(eventsFromPrompt(text).map(({ eventId }) => ({ eventId, note: "recovered" }))),
		);
		const stranded = seedEvent(db, monitor.monitorId, "dispatched", crypto.randomUUID());
		await propagator.reconcile();
		expect(stage(db, stranded)).toBe("authored_no_delivery");
	});

	test("legacy origin-invalid event types terminalize without invoking the session port", async () => {
		home = await mkdtemp(join(tmpdir(), "gajaeway-monitor-invalid-event-"));
		database = await Store.open(join(home, "gateway.db"));
		const db = database;
		const registry = new MonitorRegistry(db);
		const monitor = registry.add({
			name: "valid-monitor",
			trigger: { kind: "cron", schedule: "* * * * *" },
			eventTypes: ["valid.event"],
			burstPolicy: "serialize",
		});
		let turns = 0;
		const readinessFailures: Array<{ code: string; detail: string; originKey: string; at: number }> = [];
		const propagator = new MonitorPropagator({
			database: db,
			registry,
			sessionPort: fakeSessionPort(async () => {
				turns++;
				return "[]";
			}),
			memory: { enqueue: () => crypto.randomUUID(), enqueueExistingId: () => {} } as never,
			delivery: new DeliveryService(db),
			emit: () => {},
			onReadinessFailure: (failure) => readinessFailures.push(failure),
		});
		propagators.push(propagator);
		const eventId = crypto.randomUUID();
		createEvent(db, {
			eventId,
			monitorId: monitor.monitorId,
			eventType: "broken/type",
			payloadJson: "{}",
			firedAt: new Date().toISOString(),
		});

		await propagator.reconcile();

		expect(stage(db, eventId)).toBe("failed_no_retry");
		expect(db.monitors.failure(eventId)).toMatchObject({
			code: "event_type_invalid",
			detail: "dispatch setup failed (event_type_invalid)",
		});
		expect(readinessFailures).toHaveLength(1);
		expect(readinessFailures[0]).toMatchObject({
			code: "event_type_invalid",
			detail: "monitor dispatch failed during event setup",
		});
		expect(turns).toBe(0);
		await propagator.reconcile();
		expect(turns).toBe(0);
	});

	test("malformed persisted monitors are isolated and their events terminalize once", async () => {
		home = await mkdtemp(join(tmpdir(), "gajaeway-monitor-invalid-record-"));
		database = await Store.open(join(home, "gateway.db"));
		const db = database;
		const validRegistry = new MonitorRegistry(db);
		const valid = validRegistry.add({
			name: "healthy",
			trigger: { kind: "cron", schedule: "* * * * *" },
			eventTypes: ["healthy.event"],
		});
		const invalidId = crypto.randomUUID();
		createMonitor(db, {
			id: invalidId,
			name: "legacy-invalid",
			triggerJson: "{not-json",
			eventTypesJson: JSON.stringify(["broken/type"]),
			burstPolicy: "serialize",
			channelTargetJson: null,
			enabled: true,
			instruction: null,
			modelJson: null,
			serviceTier: null,
		});
		const registry = new MonitorRegistry(db);
		expect(registry.list().map((record) => record.monitorId)).toEqual([valid.monitorId]);
		const eventId = crypto.randomUUID();
		const readinessFailures: Array<{ code: string; detail: string; originKey: string; at: number }> = [];
		createEvent(db, {
			eventId,
			monitorId: invalidId,
			eventType: "broken/type",
			payloadJson: "{}",
			firedAt: new Date().toISOString(),
		});
		let turns = 0;
		const propagator = new MonitorPropagator({
			database: db,
			registry,
			sessionPort: fakeSessionPort(async () => {
				turns++;
				return "[]";
			}),
			memory: { enqueue: () => crypto.randomUUID(), enqueueExistingId: () => {} } as never,
			delivery: new DeliveryService(db),
			emit: () => {},
			onReadinessFailure: (failure) => readinessFailures.push(failure),
		});
		propagators.push(propagator);

		await propagator.reconcile();

		expect(stage(db, eventId)).toBe("failed_no_retry");
		expect(db.monitors.failure(eventId)).toMatchObject({
			code: "monitor_invalid",
			detail: "dispatch setup failed (monitor_invalid)",
		});
		expect(readinessFailures).toHaveLength(1);
		expect(readinessFailures[0]).toMatchObject({
			code: "monitor_invalid",
			detail: "monitor dispatch failed during setup",
		});
		expect(turns).toBe(0);
		await propagator.reconcile();
		expect(db.monitors.eventRows().filter((row) => row.event_id === eventId)).toHaveLength(1);
		expect(readinessFailures).toHaveLength(1);
		expect(turns).toBe(0);
	});

	test("exhausted event with saved authoring turn terminalize as monitor_invalid when monitor is removed and turn is terminal_ok (#508, #187)", async () => {
		home = await mkdtemp(join(tmpdir(), "gajaeway-monitor-exhausted-invalid-"));
		database = await Store.open(join(home, "gateway.db"));
		const db = database;

		// Create a monitor and event
		const registry = new MonitorRegistry(db);
		const monitor = registry.add({
			name: "test-monitor",
			trigger: { kind: "cron", schedule: "* * * * *" },
			eventTypes: ["test.event"],
		});

		const eventId = crypto.randomUUID();
		const sessionId = "s1";
		const opRef = crypto.randomUUID();
		const turnPointer = JSON.stringify({
			sessionId,
			opRef,
			eventIds: [eventId],
		});

		createEvent(db, {
			eventId,
			monitorId: monitor.monitorId,
			eventType: "test.event",
			payloadJson: "{}",
			firedAt: new Date().toISOString(),
		});

		// Simulate dispatch attempts that exhausted
		for (let i = 0; i < MONITOR_EVENT_MAX_DISPATCH_ATTEMPTS; i++) {
			updateEvent(db, eventId, "failed");
			db.transaction((tx) => db.monitors.eventIncrementAttempts(tx, eventId));
		}

		// Save the authoring turn pointer to simulate a previous dispatch that started
		db.transaction((_tx) => {
			db.core.metaSet(`monitor_authoring_turn:${eventId}`, turnPointer);
		});

		const sessionPort = fakeSessionPort(async () => {
			// Return terminal_ok to simulate the turn being complete
			return "[]";
		});

		// Pre-seed the operation with terminal_ok state
		sessionPort.seedOperation(opRef, sessionId, "terminal_ok", "");

		const propagator = new MonitorPropagator({
			database: db,
			registry: new MonitorRegistry(db),
			sessionPort,
			memory: { enqueue: () => crypto.randomUUID(), enqueueExistingId: () => {} } as never,
			delivery: new DeliveryService(db),
			emit: () => {},
		});
		propagators.push(propagator);

		// Remove the monitor to simulate invalidation after the turn pointer was saved
		db.transaction((tx) => db.monitors.delete(tx, monitor.monitorId));

		// Reconcile should fail the event with monitor_invalid
		await propagator.reconcile();

		expect(stage(db, eventId)).toBe("failed_no_retry");
		expect(db.monitors.failure(eventId)).toMatchObject({
			code: "monitor_invalid",
			detail: "dispatch setup failed (monitor_invalid)",
		});
		// Verify the event stays failed and doesn't loop forever
		await propagator.reconcile();
		expect(stage(db, eventId)).toBe("failed_no_retry");
	});

	test("exhausted invalidation does not overwrite an event authored during status lookup", async () => {
		home = await mkdtemp(join(tmpdir(), "gajaeway-monitor-exhausted-invalid-race-"));
		database = await Store.open(join(home, "gateway.db"));
		const db = database;
		const registry = new MonitorRegistry(db);
		const monitor = registry.add({
			name: "test-monitor",
			trigger: { kind: "cron", schedule: "* * * * *" },
			eventTypes: ["test.event"],
		});
		const eventId = crypto.randomUUID();
		const sessionId = "s1";
		const opRef = crypto.randomUUID();
		createEvent(db, {
			eventId,
			monitorId: monitor.monitorId,
			eventType: "test.event",
			payloadJson: "{}",
			firedAt: new Date().toISOString(),
		});
		for (let i = 0; i < MONITOR_EVENT_MAX_DISPATCH_ATTEMPTS; i++) {
			updateEvent(db, eventId, "failed");
			db.transaction((tx) => db.monitors.eventIncrementAttempts(tx, eventId));
		}
		db.transaction((_tx) =>
			db.core.metaSet(`monitor_authoring_turn:${eventId}`, JSON.stringify({ sessionId, opRef, eventIds: [eventId] })),
		);
		const sessionPort = fakeSessionPort(async () => "[]");
		sessionPort.seedOperation(opRef, sessionId, "terminal_ok", "");
		const propagator = new MonitorPropagator({
			database: db,
			registry: new MonitorRegistry(db),
			sessionPort,
			memory: { enqueue: () => crypto.randomUUID(), enqueueExistingId: () => {} } as never,
			delivery: new DeliveryService(db),
			emit: () => {},
		});
		propagators.push(propagator);
		db.transaction((tx) => db.monitors.delete(tx, monitor.monitorId));

		const reconciling = propagator.reconcile();
		createOutput(db, eventId, "completed response");
		updateEvent(db, eventId, "authored");
		await reconciling;

		expect(stage(db, eventId)).toBe("authored");
		expect(db.monitors.failure(eventId)).toBeUndefined();
	});

	test("authored + confirmed delivery → delivered; failure keeps it authored", async () => {
		const { monitor, database: db } = await harness(async (_id, text) =>
			JSON.stringify(eventsFromPrompt(text).map(({ eventId }) => ({ eventId, note: "note" }))),
		);
		const batchId = crypto.randomUUID();
		const eventId = seedEvent(db, monitor.monitorId, "authored", batchId);
		const delivery = new DeliveryService(db);
		const payload = delivery.prepare(
			batchId,
			{ platform: "loopback", kind: "loopback", conversationId: "loopback" },
			"note",
		);
		expect(payload).toBeDefined();
		const payload0 = payload as { deliveryId: string };
		const deliveryId = payload0.deliveryId;
		delivery.markInflight(deliveryId);
		// Not delivered before adapter confirmation.
		expect(stage(db, eventId)).toBe("authored");
		// Adapter confirms → delivered.
		expect(delivery.confirm(deliveryId)).toBe("transitioned");
		updateEvent(db, eventId, "delivered");
		expect(stage(db, eventId)).toBe("delivered");
		// Ambiguous failure is distinguishable in the ledger, never delivered.
		const payload2 = delivery.prepare(
			`${batchId}-2`,
			{ platform: "loopback", kind: "loopback", conversationId: "loopback" },
			"note",
		) as { deliveryId: string };
		const deliveryId2 = payload2.deliveryId as string;
		delivery.markInflight(deliveryId2);
		delivery.fail(deliveryId2, true);
		const row = db.outbox.rows().find((entry) => entry.delivery_id === deliveryId2);
		expect(row?.state).toBe("failed_ambiguous");
		expect(stage(db, eventId)).toBe("delivered");
	});

	test("a silent note settles authored_no_delivery, never authored-forever (#94)", async () => {
		const {
			propagator,
			monitor,
			database: db,
		} = await harness(
			async (_id, text) => JSON.stringify(eventsFromPrompt(text).map(({ eventId }) => ({ eventId, note: "[SILENT]" }))),
			{ ownerTarget: { origin: { platform: "loopback", kind: "loopback", conversationId: "loopback" } } },
		);
		const eventId = propagator.submit(monitor.monitorId, "memory.canonicalize", { at: "now" });
		for (let attempt = 0; attempt < 100 && db.monitors.authoredOutput(eventId) === undefined; attempt++)
			await Bun.sleep(10);
		await propagator.drain();
		expect(db.monitors.authoredOutput(eventId)).toBe("[SILENT]");
		expect(stage(db, eventId)).toBe("authored_no_delivery");
		expect(db.outbox.rows()).toHaveLength(0);
	});

	test("reconcile settles events already stranded at authored (#94)", async () => {
		const {
			propagator,
			monitor,
			database: db,
		} = await harness(async () => {
			throw new Error("stranded authored events must not be re-authored");
		});
		const silent = seedEvent(db, monitor.monitorId, "authored", crypto.randomUUID());
		createOutput(db, silent, "[SILENT]");
		const expiredBatch = crypto.randomUUID();
		const expired = seedEvent(db, monitor.monitorId, "authored", expiredBatch);
		createOutput(db, expired, "report");
		const ledger = new DeliveryService(db);
		ledger.createPending({ deliveryId: "old", turnId: expiredBatch, originKey: "loopback", payloadJson: "{}" });
		for (let attempt = 0; attempt < 3; attempt++) ledger.fail("old");
		ledger.expireStale(0, Date.now() + 1);
		// Memory intents exist, as they do for any event that was authored live.
		for (const eventId of [silent, expired])
			createIntent(db, { id: `monitor-event-intent:${eventId}`, kind: "monitor-event", payloadJson: eventId });
		await propagator.reconcile();
		expect(stage(db, silent)).toBe("authored_no_delivery");
		expect(stage(db, expired)).toBe("failed_no_retry");
		expect(db.monitors.failure(expired)).toMatchObject({
			code: "delivery_expired",
			detail: "delivery old expired after 3 attempts: expired_before_settlement",
		});
	});

	test("no channel target and no owner target settles authored_no_delivery", async () => {
		const {
			propagator,
			monitor,
			database: db,
		} = await harness(async (_id, text) =>
			JSON.stringify(eventsFromPrompt(text).map(({ eventId }) => ({ eventId, note: "no target note" }))),
		);
		const eventId = propagator.submit(monitor.monitorId, "memory.canonicalize", { at: "now" });
		for (let attempt = 0; attempt < 100 && stage(db, eventId) !== "authored_no_delivery"; attempt++)
			await Bun.sleep(10);
		expect(stage(db, eventId)).toBe("authored_no_delivery");
		// Terminal: reconcile never redispatches it.
		const turnsBefore = db.monitors.eventRows().length;
		await propagator.reconcile();
		expect(db.monitors.eventRows().length).toBe(turnsBefore);
		expect(stage(db, eventId)).toBe("authored_no_delivery");
	});

	for (const [label, error, expected] of [
		["CLI exit", new GjcCliError("SECRET_RAW", 42, "SECRET_STDERR"), '"exitCode":42'],
		[
			"runtime code",
			new GjcRuntimeError("SECRET_RAW", { code: "deadline_exceeded", message: "SECRET_RUNTIME" }),
			'"code":"deadline_exceeded"',
		],
		[
			"terminal status",
			new SessionTerminalError({
				operationRef: "SECRET_OP",
				status: { status: "failed", error: { code: "internal_error", message: "SECRET_TERMINAL" } },
			} as never),
			'"terminal":"failed"',
		],
		// #178: a relay refusal is a structured envelope, not a process exit. It
		// must carry the envelope code and never a misleading `exitCode: 0`.
		[
			"envelope refusal",
			new GjcCliError("SECRET_RAW", 0, "", { code: "prompt_failed", message: "SECRET_ENVELOPE" }),
			'"code":"prompt_failed","transport":"envelope"',
		],
		// #178: the SDK terminal code and outcome classifiers were flattened away,
		// so a deadline kill and a provider overload read identically.
		[
			"terminal deadline",
			new SessionTerminalError({
				operationRef: "SECRET_OP",
				status: {
					status: "failed",
					error: { code: "prompt_deadline_exceeded", message: "SECRET_TERMINAL" },
					outcome: { kind: "failed", provenance: "deadline" },
				},
			} as never),
			'"code":"prompt_deadline_exceeded","terminal":"failed","outcome":{"kind":"failed","provenance":"deadline"}',
		],
		[
			"terminal provider overload",
			new SessionTerminalError({
				operationRef: "SECRET_OP",
				status: {
					status: "failed",
					outcome: {
						kind: "failed",
						code: "prompt_failed",
						providerCode: "overloaded_error",
						phase: "post_start",
						category: "agent_runtime",
						provenance: "agent_failed",
						message: "SECRET_OUTCOME",
						reason: "SECRET REASON with spaces",
					},
				},
			} as never),
			'"code":"prompt_failed","terminal":"failed","outcome":{"kind":"failed","providerCode":"overloaded_error","phase":"post_start","category":"agent_runtime","provenance":"agent_failed"}',
		],
		[
			"request wait timeout",
			new SessionRequestTimeoutError("s1", "SECRET_OP", {
				operationRef: "SECRET_OP",
				status: { status: "in_flight" },
			} as never),
			'"class":"SessionRequestTimeoutError","lastStatus":"in_flight"',
		],
		[
			"relay hello missing",
			new RelayHelloError(1234, "stream_ended"),
			'"class":"RelayHelloError","code":"relay_hello_missing","message":"relay hello did not arrive within 1234ms (stream_ended)"',
		],
		[
			"model not selected",
			new ModelNotSelectedError("SECRET_OP"),
			'"class":"ModelNotSelectedError","code":"model_not_selected","message":"turn.prompt explicitly refused: model_not_selected"',
		],
		[
			"relay refusal with remote text",
			new RelayRefusedError("SECRET_SESSION", "session_gone", "SECRET remote text"),
			'"class":"RelayRefusedError"',
		],
		[
			"untrusted fields",
			Object.assign(new Error("SECRET_RAW"), {
				code: "SECRET_CODE",
				signal: "SECRET_SIGNAL",
				exitCode: -1,
				stack: "at packages/SECRET_PATH.ts:1",
			}),
			'"class":"Error"',
		],
		["missing fields", null, '"class":"unknown"'],
	] as const) {
		test(`injected ${label} persists safe diagnostics and request context`, async () => {
			const { propagator, monitor, database: db, sessionPort } = await harness(async () => "unused");
			sessionPort.request = async () => {
				throw error;
			};
			const eventId = seedEvent(db, monitor.monitorId, "failed");
			await propagator.reconcile();
			const detail = db.monitors.failure(eventId)?.detail ?? "";
			expect(detail).toContain(expected);
			expect(detail).toContain('"phase":"request"');
			expect(detail).toContain('"sessionId":"s1"');
			expect(detail).toContain(`"origin":"monitor/eventtype/memory.canonicalize/parent=${monitor.monitorId}"`);
			expect(detail).toContain('"attempt":2');
			expect(detail).not.toContain("SECRET");
			if (label === "untrusted fields" || label === "missing fields" || label === "envelope refusal") {
				expect(detail).not.toContain('"exitCode"');
				expect(detail).not.toContain('"signal"');
			}
			expect(stage(db, eventId)).toBe("failed");
		});
	}
	test("protocol failure evidence persists only its allowlisted reason and response shape", async () => {
		const { monitor, database: db } = await harness(async () => "unused");
		const eventId = seedEvent(db, monitor.monitorId, "failed");
		recordFailure(db, eventId, "authoring_response_invalid", "dispatch phase failed (authoring_response_invalid)", {
			protocolFailure: {
				reason: "protocol_unknown_event",
				responseByteLength: 57,
				responseEntryCount: 1,
			},
		});

		expect(db.monitors.failure(eventId)).toMatchObject({
			protocol_reason: "protocol_unknown_event",
			response_byte_length: 57,
			response_entry_count: 1,
		});
	});
	test("database protocol telemetry accepts every allowlisted reason including fallback", async () => {
		const { monitor, database: db } = await harness(async () => "unused");
		const storedReasons: string[] = [];
		for (const reason of PROTOCOL_FAILURE_REASONS) {
			const eventId = seedEvent(db, monitor.monitorId, "failed");
			recordFailure(db, eventId, "authoring_response_invalid", "safe detail", {
				protocolFailure: {
					reason,
					responseByteLength: 0,
					responseEntryCount: null,
				},
			});
			storedReasons.push(db.monitors.failure(eventId)?.protocol_reason ?? "missing");
		}

		expect(storedReasons).toEqual([...PROTOCOL_FAILURE_REASONS]);
		expect(storedReasons).toContain("protocol_off_contract");
		expect(() =>
			recordFailure(db, "invalid-reason", "authoring_response_invalid", "safe detail", {
				protocolFailure: {
					reason: "ghp_attacker_controlled_reason",
					responseByteLength: 0,
					responseEntryCount: null,
				},
			} as never),
		).toThrow();
	});
	test("failed protocol response recovery exposes first failure latency and attempts", async () => {
		const invalidResponse = JSON.stringify([{ eventId: "untrusted-event-id", note: "untrusted response text" }]);
		let turns = 0;
		const {
			propagator,
			monitor,
			database: db,
		} = await harness(
			async (_id, text) => {
				turns++;
				if (turns === 1) return invalidResponse;
				return JSON.stringify(eventsFromPrompt(text).map(({ eventId }) => ({ eventId, note: "recovered" })));
			},
			{ ownerTarget: { origin: { platform: "loopback", kind: "loopback", conversationId: "loopback" } } },
		);
		const eventId = propagator.submit(monitor.monitorId, "memory.canonicalize", { at: "now" });
		for (let attempt = 0; attempt < 100 && stage(db, eventId) !== "failed"; attempt++) await Bun.sleep(10);
		expect(stage(db, eventId)).toBe("failed");
		await propagator.reconcile();
		expect(stage(db, eventId)).toBe("authored");
		const event = db.monitors.eventRows().find((row) => row.event_id === eventId);
		const delivery = db.outbox.rows().find((row) => row.turn_id === event?.batch_id);
		expect(delivery).toBeDefined();
		if (!delivery) throw new Error("monitor delivery was not prepared");
		confirmAndSettleMonitorDelivery(db, delivery.delivery_id, "delivered");
		expect(stage(db, eventId)).toBe("delivered");

		const recovery = db.monitors.eventRecovery(eventId);
		expect(recovery).toMatchObject({
			protocolFailures: [
				{
					reason: "protocol_unknown_event",
					responseByteLength: Buffer.byteLength(invalidResponse, "utf8"),
					responseEntryCount: 1,
				},
			],
			dispatchAttempts: 2,
		});
		if (!recovery?.deliveredAt) throw new Error("monitor recovery telemetry was not completed");
		expect(recovery.recoveryLatencyMs).toBe(Date.parse(recovery.deliveredAt) - Date.parse(recovery.firstFailedAt));
		expect(recovery.recoveryLatencyMs).toBeGreaterThanOrEqual(0);
		expect(recovery.firstFailedAt).toBe(recovery.protocolFailures[0]?.failedAt);
	});
	test("protocol telemetry never persists attacker-controlled response or exception text", async () => {
		const hostileResponse = '[{"eventId":"ghp_attacker_event_id","note":"https://secret.example/token"}]';
		const { propagator, monitor, database: db } = await harness(async () => hostileResponse);
		const eventId = propagator.submit(monitor.monitorId, "memory.canonicalize", { at: "now" });
		for (let attempt = 0; attempt < 100 && stage(db, eventId) !== "failed"; attempt++) await Bun.sleep(10);

		const failure = db.monitors.failure(eventId);
		const durable = `${failure?.detail ?? ""} ${JSON.stringify(db.monitors.eventRecovery(eventId))}`;
		expect(failure?.protocol_reason).toBe("protocol_unknown_event");
		expect(durable).not.toContain("ghp_");
		expect(durable).not.toContain("secret.example");
		expect(durable).not.toContain("attacker_event_id");
	});
	test("reconcile reclaim budget: an always-failing event lands on failed_no_retry", async () => {
		let turns = 0;
		let clock = Date.now();
		const {
			propagator,
			monitor,
			database: db,
		} = await harness(
			async () => {
				turns++;
				throw new Error("turn exploded");
			},
			{ now: () => clock },
		);
		const eventId = seedEvent(db, monitor.monitorId, "failed");
		// Sweep once per (simulated) minute for a day: the backoff schedule is exhausted well inside it.
		for (let sweep = 0; sweep < 24 * 60 && stage(db, eventId) !== "failed_no_retry"; sweep++) {
			await propagator.reconcile();
			clock += 60_000;
		}
		expect(stage(db, eventId)).toBe("failed_no_retry");
		expect(turns).toBe(MONITOR_EVENT_MAX_DISPATCH_ATTEMPTS);
		// Bounded: no more dispatch attempts after the budget.
		const attemptsAfter = turns;
		await propagator.reconcile();
		expect(turns).toBe(attemptsAfter);
		const failure = db.monitors.failure(eventId);
		expect(failure).toBeDefined();
		// Public-safe: no raw error body persisted.
		expect(failure?.detail).toBeDefined();
		expect(failure?.detail).not.toContain("turn exploded");
		expect(failure?.code.length ?? 0).toBeGreaterThan(0);
	});

	test("issue #179: a failed slot outlives a multi-hour dispatch outage and is authored after recovery", async () => {
		let turns = 0;
		let down = true;
		let clock = Date.now();
		const {
			propagator,
			monitor,
			database: db,
		} = await harness(
			async (_id, text) => {
				turns++;
				if (down) throw new GjcCliError("dispatch path down", 0, "");
				return JSON.stringify(eventsFromPrompt(text).map(({ eventId }) => ({ eventId, note: "note" })));
			},
			{ now: () => clock },
		);
		const eventId = seedEvent(db, monitor.monitorId, "failed");
		// The production reconcile timer sweeps every 60s. A 15h outage (measured on the issue host)
		// used to burn the whole budget in ~5 sweeps and drop the slot.
		for (let sweep = 0; sweep < 15 * 60; sweep++) {
			await propagator.reconcile();
			clock += 60_000;
		}
		expect(stage(db, eventId)).toBe("failed");
		// Backoff, not a retry storm: far fewer turns than sweeps.
		expect(turns).toBeLessThan(MONITOR_EVENT_MAX_DISPATCH_ATTEMPTS);
		down = false;
		for (let sweep = 0; sweep < 5 * 60 && stage(db, eventId) === "failed"; sweep++) {
			await propagator.reconcile();
			clock += 60_000;
		}
		expect(stage(db, eventId)).toBe("authored_no_delivery");
		expect(db.monitors.authoredOutput(eventId)).toBe("note");
	});

	test("#187 a retry attaches to the still-running authoring turn instead of re-prompting the session", async () => {
		let skew = 0;
		const {
			propagator,
			monitor,
			database: db,
			sessionPort,
		} = await harness(() => new Promise<string>(() => {}), { now: () => Date.now() + skew });
		const eventId = seedEvent(db, monitor.monitorId, "failed");
		const request = sessionPort.request.bind(sessionPort);
		// Attempt 1: the prompt is accepted, but the bounded request wait elapses
		// while the authoring turn keeps running.
		sessionPort.request = async (input) => {
			await sessionPort.send(input);
			throw new SessionRequestTimeoutError(
				input.sessionId,
				input.opRef,
				await sessionPort.status({ sessionId: input.sessionId, repo: input.repo, opRef: input.opRef }),
			);
		};
		await propagator.reconcile();
		expect(stage(db, eventId)).toBe("failed");
		expect(sessionPort.sends).toHaveLength(1);
		const firstOpRef = sessionPort.sends[0]?.opRef;
		// Attempt 2 runs once the #179 retry backoff elapses, while that turn is still alive.
		skew += (MONITOR_EVENT_RETRY_BACKOFF_MS[1] ?? 0) + 60_000;
		sessionPort.request = request;
		const retry = propagator.reconcile();
		await Bun.sleep(50);
		// The live turn finishes its work; whichever op is newest gets the answer.
		sessionPort.complete(sessionPort.sends.at(-1)?.opRef ?? "", JSON.stringify([{ eventId, note: "slot done" }]));
		await retry;
		// One prompt for one event: the retry observed the original turn.
		expect(sessionPort.sends).toHaveLength(1);
		expect(sessionPort.sendAttempts.map((input) => input.opRef)).toEqual([firstOpRef, firstOpRef]);
		expect(db.monitors.authoredOutput(eventId)).toBe("slot done");
		expect(stage(db, eventId)).toBe("authored_no_delivery");
	});

	test("#187 a retry after the prior turn settled failed sends a fresh prompt", async () => {
		let skew = 0;
		const {
			propagator,
			monitor,
			database: db,
			sessionPort,
		} = await harness(
			async (_session, text) =>
				JSON.stringify(eventsFromPrompt(text).map((entry) => ({ eventId: entry.eventId, note: "ok" }))),
			{ now: () => Date.now() + skew },
		);
		const eventId = seedEvent(db, monitor.monitorId, "failed");
		const request = sessionPort.request.bind(sessionPort);
		sessionPort.request = async (input) => {
			sessionPort.seedAcceptedSend(input, "failed");
			throw new SessionTerminalError(
				await sessionPort.status({ sessionId: input.sessionId, repo: input.repo, opRef: input.opRef }),
			);
		};
		await propagator.reconcile();
		skew += (MONITOR_EVENT_RETRY_BACKOFF_MS[1] ?? 0) + 60_000;
		sessionPort.request = request;
		await propagator.reconcile();
		expect(sessionPort.sends).toHaveLength(2);
		expect(new Set(sessionPort.sends.map((input) => input.opRef)).size).toBe(2);
		expect(stage(db, eventId)).toBe("authored_no_delivery");
	});

	test("concurrent reconcile sweeps collapse into one", async () => {
		let turns = 0;
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const {
			propagator,
			monitor,
			database: db,
		} = await harness(async (_id, text) => {
			turns++;
			await parked;
			return JSON.stringify(eventsFromPrompt(text).map(({ eventId }) => ({ eventId, note: "note" })));
		});
		const stranded = seedEvent(db, monitor.monitorId, "batched", crypto.randomUUID());
		const first = propagator.reconcile();
		const second = propagator.reconcile();
		// The second sweep must be a no-op while the first is mid-flight.
		await second;
		expect(turns).toBe(1);
		release?.();
		await first;
		expect(stage(db, stranded)).toBe("authored_no_delivery");
	});

	test("drain waits for a claimed monitor dispatch before teardown", async () => {
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let turns = 0;
		const {
			propagator,
			monitor,
			database: db,
		} = await harness(async (_id, text) => {
			turns++;
			await parked;
			return JSON.stringify(eventsFromPrompt(text).map(({ eventId }) => ({ eventId, note: "drained" })));
		});
		const eventId = seedEvent(db, monitor.monitorId, "batched", crypto.randomUUID());
		const reconcile = propagator.reconcile();
		for (let attempt = 0; attempt < 100 && turns === 0; attempt++) await Bun.sleep(5);
		expect(turns).toBe(1);
		let drained = false;
		const drain = propagator.drain().then(() => {
			drained = true;
		});
		await Bun.sleep(20);
		expect(drained).toBe(false);
		release?.();
		await Promise.all([reconcile, drain]);
		expect(drained).toBe(true);
		expect(stage(db, eventId)).toBe("authored_no_delivery");
		expect(() => propagator.submit(monitor.monitorId, "memory.canonicalize", {})).toThrow(
			"monitor propagator is closing",
		);
	});

	test("a bounded drain interrupts an in-flight authoring turn, names the session, and the next boot re-dispatches it (#225)", async () => {
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let turns = 0;
		const {
			propagator,
			monitor,
			database: db,
			registry,
		} = await harness(async (_id, text) => {
			turns++;
			if (turns === 1) await parked;
			return JSON.stringify(eventsFromPrompt(text).map(({ eventId }) => ({ eventId, note: "recovered" })));
		});
		const eventId = seedEvent(db, monitor.monitorId, "admitted");
		const reconcile = propagator.reconcile();
		for (let attempt = 0; attempt < 100 && turns === 0; attempt++) await Bun.sleep(5);
		expect(turns).toBe(1);
		// The turn never settles inside the shutdown window: drain must return on
		// its own instead of waiting for the service manager's SIGKILL.
		const started = Date.now();
		await propagator.drain(100);
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(stage(db, eventId)).toBe("failed");
		const failure = db.monitors.failure(eventId);
		expect(failure?.code).toBe("gateway_shutdown");
		expect(failure?.detail).toContain("gateway stopped at");
		expect(failure?.detail).toContain('"sessionId":"s1"');
		expect(failure?.detail).toContain('"phase":"request"');
		// The lease is released immediately: the next boot need not wait for the
		// 10-minute TTL before reclaiming the event.
		expect(db.monitors.eventLiveLeaseOwner(eventId)).toBeUndefined();
		// The orphaned turn finishing after the stop is fenced out: no authored
		// output and no stage change from the dead attempt. However, the authoring-turn
		// pointer is kept so a restart can check the saved turn's status (#743).
		release?.();
		await reconcile;
		expect(stage(db, eventId)).toBe("failed");
		expect(db.monitors.authoredOutput(eventId)).toBeUndefined();
		// Next boot: a fresh propagator reclaims the event as recoverable state
		// once its retry backoff has elapsed. Since the saved turn pointer is kept,
		// the next dispatch can check if the turn ever completed successfully.
		// In this case, the mocked turn never completed (it was waiting when drained),
		// so it does get re-dispatched (#179: the second retry waits 10 minutes).
		const next = new MonitorPropagator({
			database: db,
			registry,
			sessionPort: fakeSessionPort(async (_id, text) =>
				JSON.stringify(eventsFromPrompt(text).map(({ eventId }) => ({ eventId, note: "recovered" }))),
			),
			memory: { enqueue: () => crypto.randomUUID(), enqueueExistingId: () => {} } as never,
			delivery: new DeliveryService(db),
			emit: () => {},
			now: () => Date.now() + 10 * 60_000 + 1,
		});
		propagators.push(next);
		await next.reconcile();
		expect(stage(db, eventId)).toBe("authored_no_delivery");
		expect(db.monitors.authoredOutput(eventId)).toBe("recovered");
	});

	test("a late response after shutdown drain keeps the authoring-turn pointer for recovery (#743)", async () => {
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let turns = 0;
		const {
			propagator,
			monitor,
			database: db,
		} = await harness(async (_id, text) => {
			turns++;
			if (turns === 1) await parked;
			return JSON.stringify(eventsFromPrompt(text).map(({ eventId }) => ({ eventId, note: "authoring-result" })));
		});
		const eventId = seedEvent(db, monitor.monitorId, "admitted");
		const reconcile = propagator.reconcile();
		for (let attempt = 0; attempt < 100 && turns === 0; attempt++) await Bun.sleep(5);
		expect(turns).toBe(1);
		// Drain expires the lease and marks the event as failed, but the authoring
		// turn is still in flight (parked).
		await propagator.drain(100);
		expect(stage(db, eventId)).toBe("failed");
		const failure = db.monitors.failure(eventId);
		expect(failure?.code).toBe("gateway_shutdown");
		// The lease is released immediately.
		expect(db.monitors.eventLiveLeaseOwner(eventId)).toBeUndefined();
		// Release the parked authoring turn: it completes late after the drain
		// but before the reconcile loop continues. With the fix (#743),
		// the authoring-turn pointer is KEPT and not deleted prematurely.
		release?.();
		await reconcile;
		// The late response is fenced out: the lease was already released,
		// so the fenced update fails. The stage remains "failed".
		expect(stage(db, eventId)).toBe("failed");
		expect(db.monitors.authoredOutput(eventId)).toBeUndefined();
		// CRUCIAL: The authoring-turn pointer is KEPT because it was never deleted
		// before the fenced update check. This is the fix for #743.
		// Without the fix, the old code deleted the pointer immediately after receiving
		// the response, BEFORE checking if the lease was still valid. This meant that
		// if the lease expired before the fenced update, we lost the evidence that the
		// turn was running, and on restart the event would be re-authored without
		// checking the saved turn's status.
		const authorizingTurnKey = `monitor_authoring_turn:${eventId}`;
		const savedPointer = db.core.metaGet(authorizingTurnKey);
		expect(savedPointer).toBeDefined();
		const pointer = JSON.parse(savedPointer!);
		expect(pointer.sessionId).toBe("s1");
		expect(pointer.eventIds).toContain(eventId);
	});

	test("a closing propagator starts no new dispatch from reconcile", async () => {
		let turns = 0;
		const {
			propagator,
			monitor,
			database: db,
		} = await harness(async (_id, text) => {
			turns++;
			return JSON.stringify(eventsFromPrompt(text).map(({ eventId }) => ({ eventId, note: "n" })));
		});
		const eventId = seedEvent(db, monitor.monitorId, "admitted");
		await propagator.drain();
		await propagator.reconcile();
		expect(turns).toBe(0);
		expect(stage(db, eventId)).toBe("admitted");
	});

	test("durable failure detail keeps only allowlisted classes causes and frames", async () => {
		class SecretVendorTokenGhp123 extends Error {}
		const hostile = new SecretVendorTokenGhp123("ghp_attacker-secret prompt=https://secret.example/token");
		(hostile as Error & { code: string }).code = "ghp_attacker_secret";
		hostile.stack = "SecretVendorTokenGhp123: ghp_attacker-secret\n    at steal (/Users/private/token.ts:99:1)";
		let thrown: Error = hostile;
		const {
			propagator,
			monitor,
			database: db,
		} = await harness(async () => {
			throw thrown;
		});
		const hostileId = seedEvent(db, monitor.monitorId, "admitted");
		await propagator.reconcile();
		const hostileFailure = db.monitors.failure(hostileId);
		const hostileDetail = hostileFailure?.detail ?? "";
		expect(hostileDetail).toContain('"class":"Error"');
		expect(hostileDetail).toContain('"frame":"#dispatchBatch"');
		expect(hostileDetail).not.toContain("ghp_");
		expect(hostileDetail).not.toContain("/Users/");
		expect(JSON.stringify(hostileFailure)).not.toContain("ghp_");
		expect(db.monitors.eventRecovery(hostileId)).toBeUndefined();

		const closed = new Error("Database has closed: ghp_attacker-secret");
		closed.stack = "Error: Database has closed\n    at withTransaction (/Users/private/gateway.db:3:4)";
		thrown = closed;
		const closedId = seedEvent(db, monitor.monitorId, "admitted");
		await propagator.reconcile();
		const detail = db.monitors.failure(closedId)?.detail ?? "";
		expect(detail).toContain('"class":"Error"');
		expect(detail).toContain('"cause":"database_closed"');
		expect(detail).toContain('"frame":"#dispatchBatch"');
		expect(detail).not.toContain("ghp_");
		expect(detail).not.toContain("/Users/");
	});

	test("unknown stage writes are rejected fail-closed", async () => {
		const { monitor, database: db } = await harness(async () => "[]");
		const eventId = seedEvent(db, monitor.monitorId, "admitted");
		expect(() => updateEvent(db, eventId, "corrupt" as never)).toThrow(/unknown monitor event stage/);
		expect(stage(db, eventId)).toBe("admitted");
	});
});

describe("durable cron slot catch-up (#157)", () => {
	const at = (hour: number, minute = 0, day = 27) => new Date(2026, 7, day, hour, minute);
	const noted = async (_id: string, text: string) =>
		JSON.stringify(eventsFromPrompt(text).map(({ eventId }) => ({ eventId, note: "note" })));

	async function cronMonitor(schedule: string, createdAt: Date) {
		const fixture = await harness(noted);
		const monitor = fixture.registry.add({
			name: `cron ${schedule}`,
			trigger: { kind: "cron", schedule },
			eventTypes: ["memory.canonicalize"],
			burstPolicy: "dedupe",
			enabled: true,
		});
		backdateMonitor(fixture.database, monitor.monitorId, createdAt);
		return { ...fixture, monitor };
	}

	async function incarnation(
		fixture: Awaited<ReturnType<typeof cronMonitor>>,
		now: Date,
		catchUp?: { maxSlots: number; maxAgeMs: number },
	) {
		const runtime = new MonitorRuntime({} as never, fixture.registry, fixture.propagator, {
			now: () => now,
			...(catchUp ? { catchUp } : {}),
		});
		await runtime.start();
		await runtime.stop();
	}

	const admitted = (db: Store, monitorId: string) =>
		db.monitors.eventRows(monitorId, "oldest").map((row) => row.fired_at);

	test("planner retains the newest slots and counts age/count overflow once", () => {
		const hourly = compileCron("0 * * * *");
		expect(planCronCatchUp(hourly, at(0), at(13), DEFAULT_CRON_CATCH_UP).admit).toHaveLength(13);
		const plan = planCronCatchUp(hourly, at(0), at(12), { maxSlots: 3, maxAgeMs: 6 * 60 * 60 * 1000 });
		expect(plan.admit).toEqual([at(10), at(11), at(12)]);
		expect(plan.skipped).toEqual({ count: 9, oldest: at(1), newest: at(9) });
		expect(planCronCatchUp(hourly, at(0), at(0, 59), DEFAULT_CRON_CATCH_UP)).toEqual({ admit: [] });
	});

	test("compiled matcher keeps timezone and repeated DST slots", () => {
		const schedule = "*/15 8-17 * 1-6 1-5";
		const matches = compileCron(schedule, "Asia/Seoul");
		for (let minute = 0; minute < 7 * 24 * 60; minute += 5) {
			const date = new Date(Date.UTC(2026, 0, 5, 0, minute));
			expect(matches(date)).toBe(cronMatches(schedule, date, "Asia/Seoul"));
		}
		const repeated = compileCron("30 1 * * *", "America/New_York");
		const plan = planCronCatchUp(
			repeated,
			new Date("2026-11-01T05:00:00.000Z"),
			new Date("2026-11-01T07:00:00.000Z"),
			DEFAULT_CRON_CATCH_UP,
		);
		expect(plan.admit.map((slot) => slot.toISOString())).toEqual([
			"2026-11-01T05:30:00.000Z",
			"2026-11-01T06:30:00.000Z",
		]);
	});

	test("a 4-hour schedule replays every missed slot after a greater-than-one-hour outage", async () => {
		const fixture = await cronMonitor("0 */4 * * *", at(23, 30, 26));
		await incarnation(fixture, at(0, 1));
		expect(admitted(fixture.database, fixture.monitor.monitorId)).toEqual([at(0).toISOString()]);
		await incarnation(fixture, at(13));
		expect(admitted(fixture.database, fixture.monitor.monitorId)).toEqual(
			[at(0), at(4), at(8), at(12)].map((slot) => slot.toISOString()),
		);
		expect(fixture.registry.cronState(fixture.monitor.monitorId)).toBeUndefined();
	});

	test("restarts after 30 minutes, 2 hours, and 13 hours recover every due slot", async () => {
		const fixture = await cronMonitor("0 * * * *", at(0, 30));
		await incarnation(fixture, at(1, 5));
		await incarnation(fixture, at(1, 35));
		await incarnation(fixture, at(3, 35));
		await incarnation(fixture, at(16, 35));
		const expected = Array.from({ length: 16 }, (_, index) => at(index + 1).toISOString());
		expect(admitted(fixture.database, fixture.monitor.monitorId)).toEqual(expected);
		for (const slot of expected)
			expect(fixture.database.monitors.slotExists(fixture.monitor.monitorId, slot)).toBe(true);
	});

	test("duplicate startup and live sweeps admit each scheduled slot exactly once", async () => {
		const fixture = await cronMonitor("*/30 * * * *", at(5, 45));
		await incarnation(fixture, at(7, 30));
		await incarnation(fixture, at(7, 30));
		const clock = { value: at(7, 30) };
		const fired: string[] = [];
		const stop = startCron(
			"*/30 * * * *",
			{
				cursor: () => new Date(fixture.registry.cronCursor(fixture.monitor.monitorId) ?? at(5, 45)),
				fire: (slot) => {
					const id = fixture.propagator.submitSlot(
						fixture.monitor.monitorId,
						"memory.canonicalize",
						{ at: slot.toISOString() },
						slot,
					);
					if (id) fired.push(slot.toISOString());
					return id !== null;
				},
				skipped: () => {
					throw new Error("nothing is beyond policy");
				},
			},
			{ now: () => clock.value, intervalMs: 1 },
		);
		await Bun.sleep(5);
		clock.value = at(8);
		await Bun.sleep(5);
		stop();
		expect(fired).toEqual([at(8).toISOString()]);
		expect(admitted(fixture.database, fixture.monitor.monitorId)).toEqual(
			[at(6), at(6, 30), at(7), at(7, 30), at(8)].map((slot) => slot.toISOString()),
		);
	});

	test("a suspended process scans every due slot since its prior sweep once", async () => {
		const clock = { value: at(6) };
		const fired: string[] = [];
		const stop = startCron(
			"*/30 * * * *",
			{
				cursor: () => at(5, 50),
				fire: (slot) => {
					fired.push(slot.toISOString());
					return true;
				},
				skipped: () => {},
			},
			{ now: () => clock.value, intervalMs: 1 },
		);
		await Bun.sleep(5);
		clock.value = at(7, 30);
		await Bun.sleep(5);
		stop();
		expect(fired).toEqual([at(6), at(6, 30), at(7), at(7, 30)].map((slot) => slot.toISOString()));
	});

	test("slots before monitor creation are never backfilled", async () => {
		const fixture = await cronMonitor("0 * * * *", at(10, 15));
		await incarnation(fixture, at(13, 5));
		expect(admitted(fixture.database, fixture.monitor.monitorId)).toEqual(
			[at(11), at(12), at(13)].map((slot) => slot.toISOString()),
		);
		expect(fixture.database.monitors.slotExists(fixture.monitor.monitorId, at(10).toISOString())).toBe(false);
	});

	test("age/count skips advance a durable cursor and are exposed without recounting", async () => {
		const fixture = await cronMonitor("0 * * * *", at(23, 30, 26));
		const policy = { maxSlots: 3, maxAgeMs: 6 * 60 * 60 * 1000 };
		await incarnation(fixture, at(12, 5), policy);
		expect(admitted(fixture.database, fixture.monitor.monitorId)).toEqual(
			[at(10), at(11), at(12)].map((slot) => slot.toISOString()),
		);
		const state = fixture.registry.cronState(fixture.monitor.monitorId);
		expect(state).toEqual({
			cursor: at(9).toISOString(),
			skippedTotal: 10,
			lastSkip: {
				count: 10,
				oldest: at(0).toISOString(),
				newest: at(9).toISOString(),
				recordedAt: at(12, 5).toISOString(),
			},
		});
		await incarnation(fixture, at(12, 5), policy);
		expect(fixture.registry.cronState(fixture.monitor.monitorId)).toEqual(state);
		expect(admitted(fixture.database, fixture.monitor.monitorId)).toHaveLength(3);
		await incarnation(fixture, at(20, 5), { maxSlots: 3, maxAgeMs: 60_000 });
		expect(fixture.registry.cronState(fixture.monitor.monitorId)?.skippedTotal).toBe(18);
		expect(fixture.registry.cronCursor(fixture.monitor.monitorId)).toBe(at(20).toISOString());
		expect(fixture.registry.remove(fixture.monitor.monitorId)).toBe(true);
		expect(fixture.registry.cronState(fixture.monitor.monitorId)).toBeUndefined();
	});

	test("runtime startup respects monitor.createdAt", async () => {
		const raceHome = await mkdtemp(join(tmpdir(), "gajaeway-runtime-catchup-"));
		try {
			const db = await Store.open(join(raceHome, "gateway.db"));
			const registry = new MonitorRegistry(db);
			const monitor = registry.add({
				name: "startup",
				trigger: { kind: "cron", schedule: "30 6 * * *" },
				eventTypes: ["memory.canonicalize"],
				burstPolicy: "serialize",
				enabled: true,
			});
			const closure = new MemoryClosureQueue(db, raceHome);
			await initializeMemory(raceHome);
			const propagator = new MonitorPropagator({
				database: db,
				registry,
				sessionPort: sessionPortFromScript({
					bind: async () => ({ sessionId: "s" }),
					respond: async (_id, text) =>
						JSON.stringify(eventsFromPrompt(text).map(({ eventId: id }) => ({ eventId: id, note: "note" }))),
				}),
				memory: closure,
				delivery: new DeliveryService(db),
				deliver: () => {},
				emit: () => {},
			});
			backdateMonitor(db, monitor.monitorId, at(6, 29));
			const runtimeOld = new MonitorRuntime({} as never, registry, propagator, { now: () => at(6, 31) });
			await runtimeOld.start();
			await runtimeOld.stop();
			await closure.drain();
			expect(db.monitors.slotExists(monitor.monitorId, at(6, 30).toISOString())).toBe(true);
			const monitorNew = registry.add({
				name: "fresh",
				trigger: { kind: "cron", schedule: "30 6 * * *" },
				eventTypes: ["memory.canonicalize"],
				burstPolicy: "serialize",
				enabled: true,
			});
			const runtimeNew = new MonitorRuntime({} as never, registry, propagator, { now: () => at(6, 31) });
			await runtimeNew.start();
			await runtimeNew.stop();
			await closure.drain();
			expect(db.monitors.slotExists(monitorNew.monitorId, at(6, 30).toISOString())).toBe(false);
			await propagator.drain();
			await closure.drain();
			db.close();
		} finally {
			await rm(raceHome, { recursive: true, force: true });
		}
	});

	test("slot admission is atomic and duplicate claims never double-admit", async () => {
		const { propagator, monitor, database: db } = await harness(noted);
		backdateMonitor(db, monitor.monitorId, new Date(2026, 7, 26, 0, 0));
		const slotAt = at(6, 30);
		const first = propagator.submitSlot(monitor.monitorId, "memory.canonicalize", { at: slotAt.toISOString() }, slotAt);
		expect(first).not.toBeNull();
		expect(db.monitors.eventRows(monitor.monitorId)).toHaveLength(1);
		const second = propagator.submitSlot(
			monitor.monitorId,
			"memory.canonicalize",
			{ at: slotAt.toISOString() },
			slotAt,
		);
		expect(second).toBeNull();
		expect(db.monitors.eventRows(monitor.monitorId)).toHaveLength(1);
	});

	test("slot payload carries the exact scheduled timestamp", async () => {
		const { propagator, monitor, database: db } = await harness(noted);
		backdateMonitor(db, monitor.monitorId, new Date(2026, 7, 26, 0, 0));
		const slotAt = at(6, 30);
		const id = propagator.submitSlot(monitor.monitorId, "memory.canonicalize", { at: slotAt.toISOString() }, slotAt);
		expect(id).not.toBeNull();
		const rows = db.monitors.eventRows(monitor.monitorId);
		expect(JSON.parse(rows[0]?.payload_json ?? "null").at).toBe(slotAt.toISOString());
		expect(rows[0]?.fired_at).toBe(slotAt.toISOString());
	});
});
describe("durable dispatch leases (restart-concurrent authoring)", () => {
	test("lease claim is exclusive; a second claim before expiry fails", async () => {
		const { monitor, database: db } = await harness(async () => "[]");
		const eventId = seedEvent(db, monitor.monitorId, "batched", crypto.randomUUID());
		const now = Date.now();
		expect(acquireLease(db, eventId, "proc-A", "lease-A1", 60_000, now)).toBe(true);
		// Process B (restart) cannot steal a LIVE lease...
		expect(acquireLease(db, eventId, "proc-B", "lease-B1", 60_000, now + 1000)).toBe(false);
		// ...only after it expires.
		expect(acquireLease(db, eventId, "proc-B", "lease-B1", 60_000, now + 61_000)).toBe(true);
		// The stale attempt A1 can no longer release or hold the lease.
		releaseLease(db, eventId, "lease-A1");
		expect(db.monitors.eventLeaseHeld(eventId, "lease-A1", now + 61_000)).toBe(false);
		expect(db.monitors.eventLeaseHeld(eventId, "lease-B1", now + 61_000)).toBe(true);
	});

	test("an event with a live lease is not reclaimed by a new process's reconcile", async () => {
		let turns = 0;
		const {
			propagator,
			monitor,
			database: db,
		} = await harness(async (_id, text) => {
			turns++;
			return JSON.stringify(eventsFromPrompt(text).map(({ eventId }) => ({ eventId, note: "note" })));
		});
		const eventId = seedEvent(db, monitor.monitorId, "batched", crypto.randomUUID());
		// Another process still holds a live lease on this event (its gjc turn may
		// still be running there).
		expect(acquireLease(db, eventId, "proc-old", "lease-old", 60_000)).toBe(true);
		await propagator.reconcile();
		expect(turns).toBe(0);
		expect(stage(db, eventId)).toBe("batched");
		// Once the lease expires, reclaim succeeds.
		await Bun.sleep(5);
		// Expire by acquiring with a now past the TTL.
		expect(acquireLease(db, eventId, "proc-new", "lease-new", 60_000, Date.now() + 61_000)).toBe(true);
	});

	test("authored monitor intent is processed to receipted in the same live process, exactly once", async () => {
		const raceHome = await mkdtemp(join(tmpdir(), "gajaeway-same-run-"));
		try {
			const db = await Store.open(join(raceHome, "gateway.db"));
			const registry = new MonitorRegistry(db);
			const monitor = registry.add({
				name: "same-run",
				trigger: { kind: "cron", schedule: "30 6 * * *" },
				eventTypes: ["memory.canonicalize"],
				burstPolicy: "serialize",
				channelTarget: { origin: { platform: "loopback", kind: "loopback", conversationId: "loopback" } },
				enabled: true,
			});
			await initializeMemory(raceHome);
			const closure = new MemoryClosureQueue(db, raceHome);
			let deliveries = 0;
			const propagator = new MonitorPropagator({
				database: db,
				registry,
				sessionPort: sessionPortFromScript({
					bind: async () => ({ sessionId: "s" }),
					respond: async (_id, text) =>
						JSON.stringify(eventsFromPrompt(text).map(({ eventId: id }) => ({ eventId: id, note: "note" }))),
				}),
				memory: closure,
				delivery: new DeliveryService(db),
				deliver: () => {
					deliveries++;
				},
				emit: () => {},
			});
			propagator.submit(monitor.monitorId, "memory.canonicalize", { at: "same-run" });
			// Wait deterministically for the async serialize dispatch to admit the
			// intent (bounded poll, no fixed-sleep assumption), then drain the
			// closure queue: the intent must reach receipted in this live process.
			for (let attempt = 0; attempt < 400; attempt++) {
				if (db.memory.rows().some((row) => row.kind === "monitor-event")) break;
				await Bun.sleep(5);
			}
			await closure.drain();
			const intents = db.memory.rows().filter((row) => row.kind === "monitor-event");
			expect(intents).toHaveLength(1);
			expect(intents[0]?.state).toBe("receipted");
			// Duplicate/reconcile re-admission must not create a second intent.
			const before = db.memory.rows().length;
			const row = db.monitors
				.eventRows()
				.find((candidate) => candidate.event_id !== "" && candidate.stage === "authored");
			expect(row).toBeDefined();
			const eventRow = row as {
				event_id: string;
				event_type: string;
				fired_at: string;
			};
			db.transaction((tx) => {
				const intentId = `monitor-event-intent:${eventRow.event_id}`;
				const authored = db.monitors.authorFenced(tx, eventRow.event_id, "", "note");
				if (authored && !db.memory.get(intentId))
					db.memory.createIntent(tx, {
						id: intentId,
						kind: "monitor-event",
						payloadJson: JSON.stringify({
							identity: `monitor-event:${eventRow.event_id}`,
							originRefJson: JSON.stringify({
								platform: "monitor",
								kind: "eventtype",
								conversationId: "memory.canonicalize",
							}),
						}),
					});
			});
			expect(db.memory.rows().length).toBe(before);
			expect(deliveries).toBe(1);
			db.close();
		} finally {
			await rm(raceHome, { recursive: true, force: true });
		}
	});

	test("heartbeat renewal is lease-guarded and uses the injectable clock", async () => {
		const { monitor, database: db } = await harness(async () => "[]");
		const eventId = seedEvent(db, monitor.monitorId, "batched", crypto.randomUUID());
		const now = Date.now();
		// TTL 60s claimed at `now`; renewed at now+50s with the same TTL extends to
		// now+110s (renewal takes effect from the renewal instant).
		expect(acquireLease(db, eventId, "proc-A", "lease-A", 60_000, now)).toBe(true);
		expect(db.monitors.eventLiveLeaseOwner(eventId, now + 50_000)).toBe("lease-A");
		expect(renewLease(db, eventId, "lease-A", 60_000, now + 50_000)).toBe(true);
		expect(db.monitors.eventLiveLeaseOwner(eventId, now + 100_000)).toBe("lease-A");
		expect(db.monitors.eventLiveLeaseOwner(eventId, now + 110_001)).toBeUndefined();
		// A stale attempt (expired lease) cannot renew:
		expect(renewLease(db, eventId, "lease-A", 60_000, now + 200_000)).toBe(false);
	});

	test("stale attempt completion cannot overwrite a newer claim's outcome", async () => {
		const { monitor, database: db } = await harness(async () => "[]");
		const eventId = seedEvent(db, monitor.monitorId, "batched", crypto.randomUUID());
		const now = Date.now();
		// Attempt A claims and starts a long authoring turn...
		expect(acquireLease(db, eventId, "proc-A", "lease-A", 60_000, now)).toBe(true);
		// ...A's process dies; the lease expires; process B steals the claim.
		expect(acquireLease(db, eventId, "proc-B", "lease-B", 60_000, now + 61_000)).toBe(true);
		// A's authoring turn finally completes and tries to write its result. The
		// stale attempt does NOT hold the lease anymore:
		expect(db.monitors.eventLeaseHeld(eventId, "lease-A", now + 61_000)).toBe(false);
		// A lease-guarded release is a no-op on B's claim:
		releaseLease(db, eventId, "lease-A");
		expect(db.monitors.eventLiveLeaseOwner(eventId, now + 61_000)).toBe("lease-B");
		// B completes and releases cleanly:
		releaseLease(db, eventId, "lease-B");
		expect(db.monitors.eventLiveLeaseOwner(eventId, now + 61_000)).toBeUndefined();
	});
});

describe("durable dispatch leases — concurrent attempts (true overlap)", () => {
	test("all fences rejected: leases released, no heartbeat leak, no dispatch", async () => {
		const raceHome = await mkdtemp(join(tmpdir(), "gajaeway-fences-rej-"));
		try {
			const db = await Store.open(join(raceHome, "gateway.db"));
			const registry = new MonitorRegistry(db);
			const monitor = registry.add({
				name: "fences",
				trigger: { kind: "cron", schedule: "30 6 * * *" },
				eventTypes: ["memory.canonicalize"],
				burstPolicy: "serialize",
				enabled: true,
			});
			let responseRan = false;
			const propagator = new MonitorPropagator({
				database: db,
				registry,
				sessionPort: sessionPortFromScript({
					bind: async () => ({ sessionId: "s" }),
					respond: async () => {
						responseRan = true;
						return "[]";
					},
				}),
				memory: { enqueue: () => crypto.randomUUID(), enqueueExistingId: () => {} } as never,
				delivery: new DeliveryService(db),
				deliver: () => {},
				emit: () => {},
				// Force the initial fenced batching to fail for every row while the
				// acquire succeeds — exercising the all-fences-rejected branch.
				fencedUpdate: () => false,
			});
			propagator.submit(monitor.monitorId, "memory.canonicalize", { at: "x" });
			await Bun.sleep(80);
			expect(responseRan).toBe(false);
			// Every acquire was rolled back: no live leases remain (no leak).
			expect(db.monitors.leaseLiveCount()).toBe(0);
			db.close();
		} finally {
			await rm(raceHome, { recursive: true, force: true });
		}
	});

	test("claim race: the production loser performs no writes of any kind", async () => {
		const raceHome = await mkdtemp(join(tmpdir(), "gajaeway-claim-race-"));
		try {
			const db = await Store.open(join(raceHome, "gateway.db"));
			const registry = new MonitorRegistry(db);
			const monitor = registry.add({
				name: "race-claim",
				trigger: { kind: "cron", schedule: "30 6 * * *" },
				eventTypes: ["memory.canonicalize"],
				burstPolicy: "serialize",
				enabled: true,
			});
			let turnsA = 0;
			let turnsB = 0;
			let deliveriesB = 0;
			let bAcquireCalls = 0;
			let bFencedBatchCalls = 0;
			const propagatorA = new MonitorPropagator({
				database: db,
				registry,
				sessionPort: sessionPortFromScript({
					bind: async () => ({ sessionId: "s" }),
					respond: async (_id, text) => {
						turnsA++;
						return JSON.stringify(eventsFromPrompt(text).map(({ eventId: id }) => ({ eventId: id, note: "note-A" })));
					},
				}),
				memory: { enqueue: () => crypto.randomUUID(), enqueueExistingId: () => {} } as never,
				delivery: new DeliveryService(db),
				deliver: () => {},
				emit: () => {},
			});
			// Loser B: its lease-acquire ALWAYS returns false (deterministic claim
			// loss via the injected seam — production dispatch path unchanged). The
			// seam counters prove the REAL #dispatchBatch path was reached.
			const propagatorB = new MonitorPropagator({
				database: db,
				registry,
				sessionPort: sessionPortFromScript({
					bind: async () => ({ sessionId: "s" }),
					respond: async () => {
						turnsB++;
						return "[]";
					},
				}),
				memory: { enqueue: () => crypto.randomUUID(), enqueueExistingId: () => {} } as never,
				delivery: new DeliveryService(db),
				deliver: () => {
					deliveriesB++;
				},
				emit: () => {},
				acquireLease: () => {
					bAcquireCalls++;
					return false;
				},
				fencedUpdate: () => {
					bFencedBatchCalls++;
					return false;
				},
			});
			// Seed ONE recoverable event with NO live lease (crash-mid-dispatch
			// shape). Both dispatchers reconcile; B's atomic claim deterministically
			// loses via the injected seam.
			const seeded = crypto.randomUUID();
			createEvent(db, {
				eventId: seeded,
				monitorId: monitor.monitorId,
				eventType: "memory.canonicalize",
				payloadJson: "{}",
				firedAt: new Date().toISOString(),
			});
			// B loses: reconcile reaches #dispatchBatch (seam called exactly once),
			// the false acquire pushes nothing, and no downstream write occurs.
			await propagatorB.reconcile();
			expect(bAcquireCalls).toBe(1);
			expect(bFencedBatchCalls).toBe(0);
			expect(turnsB).toBe(0);
			expect(deliveriesB).toBe(0);
			const seededRow = db.monitors.eventRows().find((candidate) => candidate.event_id === seeded);
			expect(seededRow?.stage).toBe("admitted");
			expect(db.monitors.authoredOutput(seeded)).toBeUndefined();
			expect(db.monitors.failure(seeded)).toBeUndefined();
			expect(db.memory.rows().filter((row) => row.payload_json.includes(seeded))).toHaveLength(0);
			expect(db.outbox.rows()).toHaveLength(0);
			// A then claims and completes the seeded event through its own chain.
			await propagatorA.reconcile();
			expect(turnsA).toBe(1);
			expect(db.monitors.eventRows().find((candidate) => candidate.event_id === seeded)?.stage).toBe(
				"authored_no_delivery",
			);
			db.close();
		} finally {
			await rm(raceHome, { recursive: true, force: true });
		}
	});

	test("partial authoring response: omitted dispatched events never become delivered", async () => {
		const raceHome = await mkdtemp(join(tmpdir(), "gajaeway-partial-"));
		try {
			const db = await Store.open(join(raceHome, "gateway.db"));
			const registry = new MonitorRegistry(db);
			const monitor = registry.add({
				name: "partial",
				trigger: { kind: "cron", schedule: "30 6 * * *" },
				eventTypes: ["memory.canonicalize"],
				burstPolicy: "coalesce",
				enabled: true,
			});
			const closure = new MemoryClosureQueue(db, raceHome);
			await initializeMemory(raceHome);
			let deliveries = 0;
			const propagator = new MonitorPropagator({
				database: db,
				registry,
				sessionPort: sessionPortFromScript({
					bind: async () => ({ sessionId: "s" }),
					respond: async () =>
						// Malicious/partial response: omits the second event entirely.
						JSON.stringify([]),
				}),
				memory: closure,
				delivery: new DeliveryService(db),
				deliver: () => {
					deliveries++;
				},
				emit: () => {},
			});
			const first = propagator.submit(monitor.monitorId, "memory.canonicalize", { at: 1 });
			const second = propagator.submit(monitor.monitorId, "memory.canonicalize", { at: 2 });
			await Bun.sleep(400);
			await closure.drain();
			// The partial response is a structured failure: rows failed (recoverable),
			// never authored, and no delivery admitted.
			expect(deliveries).toBe(0);
			expect(db.outbox.rows()).toHaveLength(0);
			expect(db.monitors.failure(first)).toBeDefined();
			expect(db.monitors.failure(second)).toBeDefined();
			db.close();
		} finally {
			await rm(raceHome, { recursive: true, force: true });
		}
	});

	test("atomic confirm+settle repairs legacy split state; crash window closed", async () => {
		const raceHome = await mkdtemp(join(tmpdir(), "gajaeway-atomic-confirm-"));
		try {
			const db = await Store.open(join(raceHome, "gateway.db"));
			const registry = new MonitorRegistry(db);
			const monitor = registry.add({
				name: "atomic-confirm",
				trigger: { kind: "cron", schedule: "30 6 * * *" },
				eventTypes: ["memory.canonicalize"],
				enabled: true,
			});
			const batchId = crypto.randomUUID();
			const eventId = crypto.randomUUID();
			createEvent(db, {
				eventId,
				monitorId: monitor.monitorId,
				eventType: "memory.canonicalize",
				payloadJson: "{}",
				firedAt: new Date().toISOString(),
			});
			updateEvent(db, eventId, "authored", batchId);
			const delivery = new DeliveryService(db);
			const payload = delivery.prepare(
				batchId,
				{ platform: "loopback", kind: "loopback", conversationId: "loopback" },
				"note",
			);
			if (!payload) throw new Error("outbound delivery was not prepared");
			const deliveryId = payload.deliveryId as string;
			delivery.markInflight(deliveryId);
			// Atomic path: one call transitions ledger AND settles events.
			const outcome = confirmAndSettleMonitorDelivery(db, deliveryId, "delivered");
			expect(outcome).toBe("transitioned");
			expect(db.outbox.rows().find((row) => row.delivery_id === deliveryId)?.state).toBe("confirmed");
			expect(stage(db, eventId)).toBe("delivered");
			// Legacy split-state repair: simulate confirmed ledger + authored event.
			updateEvent(db, eventId, "authored");
			expect(stage(db, eventId)).toBe("authored");
			// Idempotent re-confirm repairs the legacy split:
			expect(confirmAndSettleMonitorDelivery(db, deliveryId, "delivered")).toBe("already_terminal");
			expect(stage(db, eventId)).toBe("delivered");
			// Expired + late confirm leaves events authored (unchanged behavior).
			db.close();
		} finally {
			await rm(raceHome, { recursive: true, force: true });
		}
	});

	test("submitAwaitable rejects non-serialize policies (honest seam contract)", async () => {
		const raceHome = await mkdtemp(join(tmpdir(), "gajaeway-await-seam-"));
		try {
			const db = await Store.open(join(raceHome, "gateway.db"));
			const registry = new MonitorRegistry(db);
			const monitor = registry.add({
				name: "coalesced",
				trigger: { kind: "cron", schedule: "30 6 * * *" },
				eventTypes: ["memory.canonicalize"],
				burstPolicy: "coalesce",
				enabled: true,
			});
			const propagator = new MonitorPropagator({
				database: db,
				registry,
				sessionPort: sessionPortFromScript({
					bind: async () => ({ sessionId: "s" }),
					respond: async (_id, text) =>
						JSON.stringify(eventsFromPrompt(text).map(({ eventId: id }) => ({ eventId: id, note: "n" }))),
				}),
				memory: { enqueue: () => crypto.randomUUID(), enqueueExistingId: () => {} } as never,
				delivery: new DeliveryService(db),
				deliver: () => {},
				emit: () => {},
			});
			expect(propagator.submitAwaitable(monitor.monitorId, "memory.canonicalize", { at: "x" })).rejects.toThrow(
				/only supports burstPolicy 'serialize'/,
			);
			// And an unknown/disabled monitor is still rejected:
			await expect(propagator.submitAwaitable("nope", "memory.canonicalize", {})).rejects.toThrow(
				/unknown or disabled monitor/,
			);
			db.close();
		} finally {
			await rm(raceHome, { recursive: true, force: true });
		}
	});

	test("stale attempt A cannot overwrite B's outcome, enqueue, or re-deliver after losing its lease", async () => {
		const raceHome = await mkdtemp(join(tmpdir(), "gajaeway-lease-race-"));
		try {
			const db = await Store.open(join(raceHome, "gateway.db"));
			const registry = new MonitorRegistry(db);
			const monitor = registry.add({
				name: "race",
				trigger: { kind: "cron", schedule: "30 6 * * *" },
				eventTypes: ["memory.canonicalize"],
				burstPolicy: "serialize",
				channelTarget: { origin: { platform: "loopback", kind: "loopback", conversationId: "loopback" } },
				enabled: true,
			});

			// Attempt A parks inside its real propagator dispatch (the response waits,
			// then returns an A note only after B has completed — the stale completion
			// path the fencing must neutralize). A uses the awaitable seam so we hold
			// the exact original dispatch promise.
			let releaseA!: () => void;
			const aParked = new Promise<void>((resolve) => {
				releaseA = resolve;
			});
			let markAReturned!: () => void;
			const aReturned = new Promise<void>((resolve) => {
				markAReturned = resolve;
			});
			let aUnblocked = false;
			let deliveriesA = 0;
			const propagatorA = new MonitorPropagator({
				database: db,
				registry,
				sessionPort: sessionPortFromScript({
					bind: async () => ({ sessionId: "s" }),
					respond: async () => {
						releaseA();
						await new Promise<void>((resolve) => {
							const check = setInterval(() => {
								if (aUnblocked) {
									clearInterval(check);
									resolve();
								}
							}, 2);
						});
						const note = JSON.stringify([{ eventId, note: "A note" }]);
						markAReturned();
						return note;
					},
				}),
				memory: { enqueue: () => crypto.randomUUID(), enqueueExistingId: () => {} } as never,
				delivery: new DeliveryService(db),
				deliver: () => {
					deliveriesA++;
				},
				emit: () => {},
			});
			let eventId = "";
			const aDispatch: Promise<string> = propagatorA
				.submitAwaitable(monitor.monitorId, "memory.canonicalize", { at: "a" })
				.then((submitted) => {
					eventId = submitted;
					return submitted;
				});
			await aParked;
			await Bun.sleep(10);
			eventId = db.monitors.eventRows()[0]?.event_id ?? eventId;
			const leaseA = db.monitors.eventLiveLeaseOwner(eventId);
			expect(leaseA).toBeString();

			// A's lease "expires": attempt B (clock shifted past A's TTL) finds no
			// live lease, acquires its own via the SAME awaitable seam, and runs the
			// full real dispatch to completion.
			const bClockShift = 10 * 60_000 + 5_000;
			let deliveriesB = 0;
			const propagatorB = new MonitorPropagator({
				database: db,
				registry,
				sessionPort: sessionPortFromScript({
					bind: async () => ({ sessionId: "s" }),
					respond: async (_id, text) =>
						JSON.stringify(eventsFromPrompt(text).map(({ eventId: id }) => ({ eventId: id, note: "B note" }))),
				}),
				memory: { enqueue: () => crypto.randomUUID(), enqueueExistingId: () => {} } as never,
				delivery: new DeliveryService(db),
				deliver: () => {
					deliveriesB++;
				},
				emit: () => {},
				now: () => Date.now() + bClockShift,
			});
			// B's production recovery path: reconcile claims the expired event and
			// dispatches it (real chain; asserted below by deliveries/intents).
			await propagatorB.reconcile();
			const row = db.monitors.eventRows().find((candidate) => candidate.event_id === eventId);
			expect(row?.stage).toBe("authored");
			expect(db.monitors.authoredOutput(eventId)).toBe("B note");
			expect(deliveriesB).toBe(1);

			// Unblock A: its stale attempt completes with an A note. Await A's exact
			// original dispatch promise — every write is lease-fenced (no-op).
			aUnblocked = true;
			await aReturned;
			await aDispatch;
			const freshRow = db.monitors.eventRows().find((candidate) => candidate.event_id === eventId);
			expect(freshRow?.stage).toBe("authored");
			expect(db.monitors.authoredOutput(eventId)).toBe("B note");
			// Exactly one deterministic memory intent (B's; A fenced out):
			const intents = db.memory.rows().filter((intent) => intent.payload_json.includes(eventId));
			expect(intents).toHaveLength(1);
			expect(intents[0]?.id).toBe(`monitor-event-intent:${eventId}`);
			expect(intents[0]?.payload_json).toContain("B note");
			// Exactly one ledger delivery row (B's); A emitted none:
			expect(db.outbox.rows()).toHaveLength(1);
			expect(deliveriesA).toBe(0);
			expect(deliveriesB).toBe(1);
			// No A failure evidence:
			expect(db.monitors.failure(eventId)).toBeUndefined();
			// Lease state explicit: B released on completion → owner undefined.
			expect(db.monitors.eventLiveLeaseOwner(eventId, Date.now() + bClockShift)).toBeUndefined();
			db.close();
		} finally {
			await rm(raceHome, { recursive: true, force: true });
		}
	});
});

describe("monitor overlap policy (issue #83)", () => {
	async function overlapHarness(overlap: "queue" | "skip" | undefined) {
		home = await mkdtemp(join(tmpdir(), "gajaeway-monitor-overlap-"));
		const db = await Store.open(join(home, "gateway.db"));
		database = db;
		const registry = new MonitorRegistry(db);
		const monitor = registry.add({
			name: "backlog-watch",
			trigger: { kind: "cron", schedule: "*/30 * * * *" },
			eventTypes: ["backlog.watch"],
			burstPolicy: "serialize",
			...(overlap ? { overlap } : {}),
		});
		backdateMonitor(db, monitor.monitorId, new Date(2026, 7, 26, 0, 0));
		let release!: () => void;
		let gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const prompts: string[] = [];
		const propagator = new MonitorPropagator({
			database: db,
			registry,
			sessionPort: fakeSessionPort(async (_id, text) => {
				prompts.push(text);
				await gate;
				return JSON.stringify(eventsFromPrompt(text).map(({ eventId }) => ({ eventId, note: "no-op" })));
			}),
			memory: { enqueue: () => crypto.randomUUID(), enqueueExistingId: () => {} } as never,
			delivery: new DeliveryService(db),
			emit: () => {},
		});
		propagators.push(propagator);
		const openGate = () => {
			release();
			gate = Promise.resolve();
		};
		return { db, monitor, propagator, prompts, openGate, registry };
	}
	const slot = (minute: number) => new Date(2026, 7, 27, 10, minute);
	async function settle(db: Store, eventId: string) {
		for (let attempt = 0; attempt < 400 && stage(db, eventId) !== "authored_no_delivery"; attempt++) await Bun.sleep(5);
		return stage(db, eventId);
	}

	test("skip: a slot that fires while its predecessor is still authoring is recorded skipped, never authored", async () => {
		const { db, monitor, propagator, prompts, openGate, registry } = await overlapHarness("skip");
		expect(registry.get(monitor.monitorId)?.overlap).toBe("skip");
		const first = propagator.submitSlot(monitor.monitorId, "backlog.watch", {}, slot(0)) as string;
		for (let attempt = 0; attempt < 400 && prompts.length === 0; attempt++) await Bun.sleep(5);
		expect(prompts).toHaveLength(1);
		// The 10:30 slot fires while the 10:00 authoring turn is still running.
		const second = propagator.submitSlot(monitor.monitorId, "backlog.watch", {}, slot(30)) as string;
		expect(second).not.toBeNull();
		const row = db.monitors.eventRows(monitor.monitorId).find((candidate) => candidate.event_id === second);
		expect(row?.stage).toBe("skipped");
		expect(row?.skipped_by).toBe(first);
		// A scheduling outcome, not an error: no failure evidence, and recovery
		// never revives it into a late (stale) authoring turn.
		expect(db.monitors.failure(second)).toBeUndefined();
		await propagator.reconcile();
		expect(stage(db, second)).toBe("skipped");
		// Webhook/script admission honors the same policy.
		const manual = propagator.submit(monitor.monitorId, "backlog.watch", {});
		expect(stage(db, manual)).toBe("skipped");
		openGate();
		expect(await settle(db, first)).toBe("authored_no_delivery");
		// Once the predecessor is done the next slot is admitted and authored normally.
		const third = propagator.submitSlot(monitor.monitorId, "backlog.watch", {}, slot(60)) as string;
		expect(await settle(db, third)).toBe("authored_no_delivery");
		expect(prompts).toHaveLength(2);
		expect(prompts.some((text) => text.includes(second) || text.includes(manual))).toBe(false);
		// The skipped slot stays claimed: a restart catch-up cannot refire it.
		expect(propagator.submitSlot(monitor.monitorId, "backlog.watch", {}, slot(30))).toBeNull();
	});

	test("queue (default): an overlapping slot is admitted behind its predecessor", async () => {
		const { db, monitor, propagator, prompts, openGate, registry } = await overlapHarness(undefined);
		expect(registry.get(monitor.monitorId)?.overlap).toBe("queue");
		const first = propagator.submitSlot(monitor.monitorId, "backlog.watch", {}, slot(0)) as string;
		for (let attempt = 0; attempt < 400 && prompts.length === 0; attempt++) await Bun.sleep(5);
		const second = propagator.submitSlot(monitor.monitorId, "backlog.watch", {}, slot(30)) as string;
		expect(stage(db, second)).not.toBe("skipped");
		openGate();
		expect(await settle(db, first)).toBe("authored_no_delivery");
		expect(await settle(db, second)).toBe("authored_no_delivery");
		expect(prompts).toHaveLength(2);
	});

	test("an invalid overlap policy is rejected at registration", async () => {
		home = await mkdtemp(join(tmpdir(), "gajaeway-monitor-overlap-"));
		database = await Store.open(join(home, "gateway.db"));
		const registry = new MonitorRegistry(database);
		expect(() =>
			registry.add({
				name: "bad",
				trigger: { kind: "cron", schedule: "*/30 * * * *" },
				eventTypes: ["backlog.watch"],
				overlap: "replace" as never,
			}),
		).toThrow('monitor overlap must be "queue" or "skip"');
	});
});

describe("#702: an exhausted event held on an unresolvable authoring turn", () => {
	async function heldSkipMonitor(status: "unknown" | "throws" | "accepted" | "in_flight", batchSize = 1) {
		home = await mkdtemp(join(tmpdir(), "gajaeway-monitor-702-"));
		database = await Store.open(join(home, "gateway.db"));
		const db = database;
		const monitor = new MonitorRegistry(db).add({
			name: "proactive",
			trigger: { kind: "cron", schedule: "* * * * *" },
			eventTypes: ["proactive.tick"],
		});
		const eventId = crypto.randomUUID();
		const opRef = crypto.randomUUID();
		createEvent(db, {
			eventId,
			monitorId: monitor.monitorId,
			eventType: "proactive.tick",
			payloadJson: "{}",
			firedAt: new Date().toISOString(),
			overlap: "skip",
		});
		// Coalesced batch members fire behind the first; queue keeps them admitted.
		const eventIds = [eventId];
		for (let i = 1; i < batchSize; i++) {
			const member = crypto.randomUUID();
			createEvent(db, {
				eventId: member,
				monitorId: monitor.monitorId,
				eventType: "proactive.tick",
				payloadJson: "{}",
				firedAt: new Date().toISOString(),
			});
			eventIds.push(member);
		}
		for (const id of eventIds)
			for (let i = 0; i < MONITOR_EVENT_MAX_DISPATCH_ATTEMPTS; i++) {
				updateEvent(db, id, "failed");
				db.transaction((tx) => db.monitors.eventIncrementAttempts(tx, id));
			}
		const pointer = JSON.stringify({ sessionId: "s1", opRef, eventIds });
		for (const id of eventIds) db.core.metaSet(`monitor_authoring_turn:${id}`, pointer);
		let prompts = 0;
		const sessionPort = fakeSessionPort(async () => {
			prompts++;
			return "[]";
		});
		if (status === "throws")
			sessionPort.status = async () => {
				throw new Error("broker_unavailable");
			};
		if (status === "in_flight") sessionPort.seedOperation(opRef, "s1", "in_flight");
		if (status === "accepted") {
			const scripted = sessionPort.status.bind(sessionPort);
			sessionPort.status = async (input) =>
				input.opRef === opRef
					? { operationRef: opRef, status: { status: "accepted" }, summaryCompleted: false }
					: await scripted(input);
		}
		let clock = Date.now();
		const propagator = new MonitorPropagator({
			database: db,
			registry: new MonitorRegistry(db),
			sessionPort,
			memory: { enqueue: () => crypto.randomUUID(), enqueueExistingId: () => {} } as never,
			delivery: new DeliveryService(db),
			emit: () => {},
			now: () => clock,
		});
		propagators.push(propagator);
		const fire = (): string => {
			const next = crypto.randomUUID();
			createEvent(db, {
				eventId: next,
				monitorId: monitor.monitorId,
				eventType: "proactive.tick",
				payloadJson: "{}",
				firedAt: new Date(clock).toISOString(),
				overlap: "skip",
			});
			return next;
		};
		return {
			db,
			eventId,
			eventIds,
			opRef,
			sessionPort,
			propagator,
			fire,
			prompts: () => prompts,
			advance: (ms: number) => {
				clock += ms;
			},
		};
	}

	for (const status of ["unknown", "throws"] as const) {
		test(`status ${status}: held within the open-age bound, given up after it, and the next slot is admitted`, async () => {
			const { db, eventId, propagator, fire, prompts, advance } = await heldSkipMonitor(status);
			await propagator.reconcile();
			expect(stage(db, eventId)).toBe("failed");
			expect(stage(db, fire())).toBe("skipped");

			advance(MONITOR_EVENT_MAX_OPEN_AGE_MS - 60_000);
			await propagator.reconcile();
			expect(stage(db, eventId)).toBe("failed");

			advance(2 * 60_000);
			await propagator.reconcile();
			expect(stage(db, eventId)).toBe("failed_no_retry");
			expect(db.monitors.failure(eventId)?.code).toBe("authoring_turn_unresolved");
			expect(db.core.metaGet(`monitor_authoring_turn:${eventId}`)).toBeDefined();
			expect(prompts()).toBe(0);
			expect(stage(db, fire())).toBe("admitted");
		});
	}

	test("an authored output that lands during the status read is not overwritten", async () => {
		const { db, eventId, propagator, advance } = await heldSkipMonitor("unknown");
		advance(MONITOR_EVENT_MAX_OPEN_AGE_MS + 60_000);
		const reconciling = propagator.reconcile();
		createOutput(db, eventId, "late response");
		updateEvent(db, eventId, "authored");
		await reconciling;
		expect(stage(db, eventId)).toBe("authored");
		expect(db.monitors.failure(eventId)).toBeUndefined();
	});
	for (const status of ["accepted", "in_flight"] as const) {
		test(`status ${status}: a turn reported running is never aged out and keeps overlap protection`, async () => {
			const { db, eventId, propagator, fire, prompts, advance } = await heldSkipMonitor(status);
			advance(MONITOR_EVENT_MAX_OPEN_AGE_MS + 60_000);
			await propagator.reconcile();
			expect(stage(db, eventId)).toBe("failed");
			advance(10 * MONITOR_EVENT_MAX_OPEN_AGE_MS);
			await propagator.reconcile();
			expect(stage(db, eventId)).toBe("failed");
			expect(db.monitors.failure(eventId)?.code).not.toBe("authoring_turn_unresolved");
			expect(db.core.metaGet(`monitor_authoring_turn:${eventId}`)).toBeDefined();
			expect(stage(db, fire())).toBe("skipped");
			expect(prompts()).toBe(0);
		});
	}

	test("a late result reopens the whole given-up batch and is harvested from its own op, never resent", async () => {
		const { db, eventIds, opRef, sessionPort, propagator, prompts, advance } = await heldSkipMonitor("unknown", 2);
		advance(MONITOR_EVENT_MAX_OPEN_AGE_MS + 60_000);
		await propagator.reconcile();
		for (const id of eventIds) {
			expect(stage(db, id)).toBe("failed_no_retry");
			expect(db.monitors.failure(id)?.code).toBe("authoring_turn_unresolved");
		}
		// Still unknown: the record stays given up and its pointer kept.
		await propagator.reconcile();
		for (const id of eventIds) expect(stage(db, id)).toBe("failed_no_retry");

		// The original operation finishes, then a later turn in the same session
		// replaces the session's latest assistant message.
		sessionPort.seedOperation(
			opRef,
			"s1",
			"terminal_ok",
			JSON.stringify(eventIds.map((eventId) => ({ eventId, note: `original ${eventId}` }))),
		);
		sessionPort.seedOperation("gw-m-successor", "s1", "terminal_ok", "successor answer");
		await propagator.reconcile();
		for (const id of eventIds) {
			expect(stage(db, id)).toBe("authored_no_delivery");
			expect(db.monitors.authoredOutput(id)).toBe(`original ${id}`);
			expect(db.core.metaGet(`monitor_authoring_turn:${id}`)).toBeUndefined();
		}
		expect(sessionPort.sendAttempts).toHaveLength(0);
		expect(prompts()).toBe(0);
	});

	test("a given-up batch whose operation later failed drops its pointer and stays settled", async () => {
		const { db, eventId, opRef, sessionPort, propagator, prompts, advance } = await heldSkipMonitor("unknown");
		advance(MONITOR_EVENT_MAX_OPEN_AGE_MS + 60_000);
		await propagator.reconcile();
		expect(stage(db, eventId)).toBe("failed_no_retry");
		sessionPort.seedOperation(opRef, "s1", "failed");
		await propagator.reconcile();
		expect(stage(db, eventId)).toBe("failed_no_retry");
		expect(db.core.metaGet(`monitor_authoring_turn:${eventId}`)).toBeUndefined();
		expect(prompts()).toBe(0);
	});

	test("operator retry of one event of a coalesced batch retries the batch and reuses the saved op", async () => {
		const { db, eventIds, opRef, sessionPort, propagator, prompts, advance } = await heldSkipMonitor("unknown", 2);
		advance(MONITOR_EVENT_MAX_OPEN_AGE_MS + 60_000);
		await propagator.reconcile();
		for (const id of eventIds) expect(stage(db, id)).toBe("failed_no_retry");
		sessionPort.seedOperation(
			opRef,
			"s1",
			"terminal_ok",
			JSON.stringify(eventIds.map((eventId) => ({ eventId, note: `original ${eventId}` }))),
		);
		sessionPort.seedOperation("gw-m-successor", "s1", "terminal_ok", "successor answer");
		expect(propagator.retry(eventIds[0] as string).done).toBe(true);
		for (let i = 0; i < 200 && eventIds.some((id) => stage(db, id) !== "authored_no_delivery"); i++) await Bun.sleep(5);
		for (const id of eventIds) expect(db.monitors.authoredOutput(id)).toBe(`original ${id}`);
		expect(sessionPort.sendAttempts).toHaveLength(0);
		expect(prompts()).toBe(0);
	});

	test("the terminal-history sweep removes a given-up event's pointer with it", async () => {
		const { db, eventId, propagator, advance } = await heldSkipMonitor("unknown");
		advance(MONITOR_EVENT_MAX_OPEN_AGE_MS + 60_000);
		await propagator.reconcile();
		expect(db.core.metaGet(`monitor_authoring_turn:${eventId}`)).toBeDefined();
		db.transaction((tx) =>
			db.monitors.sweep(tx, { historyCutoff: new Date(Date.now() + 365 * 86_400_000).toISOString(), batch: 100 }),
		);
		expect(db.monitors.eventGet(eventId)).toBeUndefined();
		expect(db.core.metaGet(`monitor_authoring_turn:${eventId}`)).toBeUndefined();
	});
});

test("#702: failureDetail names an unlisted Error subclass and keeps only a token-shaped code", () => {
	class RuntimePolicyError extends Error {
		readonly code: string;
		constructor(code: string) {
			super(`policy refused at /home/someone/secret ${code}`);
			this.code = code;
		}
	}
	expect(JSON.parse(failureDetail(new RuntimePolicyError("minimum_interval")))).toEqual({
		class: "Error",
		foreignClass: "RuntimePolicyError",
		code: "minimum_interval",
	});
	expect(JSON.parse(failureDetail(new RuntimePolicyError("token=abc/../x")))).toEqual({
		class: "Error",
		foreignClass: "RuntimePolicyError",
	});
	expect(JSON.parse(failureDetail(new Error("plain")))).toEqual({ class: "Error" });
});
