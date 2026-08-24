import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../src/extensibility/extensions";
import { startFixtureBrokerWithLeaseForTest } from "../src/sdk/broker/ensure";
import { createSdkSessionRuntimeExtension, type SessionSdkTransport } from "../src/sdk/host/session-runtime";
import {
	cleanupFixtureRoot,
	createFixtureBrokerEnvironment,
	createFixtureRootCleanup,
	withFixtureBrokerEnvironment,
} from "./helpers/fixture-broker-cleanup";

/**
 * Safety bound for a single emission to resolve. Far above any real host
 * dispatch time, but finite so a lost response fails the test instead of
 * hanging the file to the harness timeout.
 */
const RESPONSE_TIMEOUT_MS = 5_000;

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-host-steer-broker-"));
const fixtureAgentDir = path.join(fixtureRoot, "agent");
const fixtureEnv = createFixtureBrokerEnvironment(fixtureRoot, fixtureAgentDir);
const fixtureBroker = await withFixtureBrokerEnvironment(() =>
	startFixtureBrokerWithLeaseForTest({ agentDir: fixtureAgentDir, env: fixtureEnv }),
);
const fixtureCleanup = createFixtureRootCleanup(fixtureRoot, fixtureAgentDir, fixtureBroker.lease);
afterAll(async () => {
	await cleanupFixtureRoot(fixtureCleanup);
});

interface HarnessOptions {
	/** Artificial transport delivery delay; models a host that responds slowly. */
	responseDelayMs?: number;
	/** Safety timeout for one emission; small values are for race-contract tests. */
	responseTimeoutMs?: number;
}
interface Harness {
	emit(frame: Record<string, unknown>): Promise<Record<string, unknown>>;
	/** Response frames observed after the emission they belong to already ended. */
	readonly lateResponses: ReadonlyArray<Record<string, unknown>>;
	/** Waits for one fenced response without assuming when host dispatch completes. */
	waitForLateResponse(id: string): Promise<Record<string, unknown>>;
	/** Adjust the artificial transport delivery delay between emissions. */
	setResponseDelay(ms: number): void;
	start(): Promise<void>;
	stop(): Promise<void>;
	dispatches: number;
	persistedAtDispatch?: string;
}

function createHarness(cwd: string, sessionId: string, sessionFile: string | undefined): Harness {
	const handlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
	let receive: ((connectionId: string, frame: never) => void) | undefined;
	let dispatches = 0;
	let persistedAtDispatch: string | undefined;
	// Exactly one pending emission at a time (the tests emit sequentially). The
	// handshake resolves with the frame correlated to the live emission only;
	// any frame arriving before or after it is fenced as stale and recorded.
	let pending:
		| {
				id: string;
				resolve: (frame: Record<string, unknown>) => void;
				reject: (error: Error) => void;
		  }
		| undefined;
	const lateResponses: Array<Record<string, unknown>> = [];
	const lateResponseWaiters: Array<{
		id: string;
		resolve: (frame: Record<string, unknown>) => void;
		reject: (error: Error) => void;
		timer?: ReturnType<typeof setTimeout>;
	}> = [];
	const delayedDeliveries = new Set<ReturnType<typeof setTimeout>>();
	const transport: SessionSdkTransport = {
		sessionId,
		stateRoot: path.join(cwd, ".gjc", "state"),
		token: "test-token",
		sendFrame: (_connectionId, frame) => {
			const response = frame as Record<string, unknown>;
			const deliver = () => {
				const current = pending;
				// A response only satisfies the emission whose request id it
				// carries. Anything else (a late frame from an already ended
				// emission, or an unsolicited frame) must never resolve a later
				// await.
				if (current && response.id === current.id) {
					pending = undefined;
					current.resolve(response);
				} else {
					lateResponses.push(response);
					const waiterIndex = lateResponseWaiters.findIndex(waiter => response.id === waiter.id);
					if (waiterIndex >= 0) {
						const waiter = lateResponseWaiters.splice(waiterIndex, 1)[0]!;
						if (waiter.timer) clearTimeout(waiter.timer);
						waiter.resolve(response);
					}
				}
			};
			if (responseDelayMs <= 0) {
				deliver();
				return;
			}
			const timer = setTimeout(() => {
				delayedDeliveries.delete(timer);
				deliver();
			}, responseDelayMs);
			delayedDeliveries.add(timer);
		},
		onFrame: handler => {
			receive = handler;
			return () => {
				receive = undefined;
			};
		},
		start: async () => ({ url: "memory://host-steer" }),
		stop: async () => {
			for (const timer of delayedDeliveries) clearTimeout(timer);
			delayedDeliveries.clear();
			for (const waiter of lateResponseWaiters) {
				if (waiter.timer) clearTimeout(waiter.timer);
				waiter.reject(new Error("harness stopped before the late response arrived"));
			}
			lateResponseWaiters.length = 0;
		},
	};
	const api = {
		on: (event: string, handler: (event: unknown, context: ExtensionContext) => unknown) =>
			handlers.set(event, handler),
		registerCommand: () => {},
		sendUserMessage: async (
			_content: unknown,
			options?: {
				onPreflightAccepted?: () => void;
				onPreflightAcceptCommit?: () => void | Promise<void>;
			},
		) => {
			dispatches++;
			persistedAtDispatch = await fs.readFile(
				path.join(
					path.dirname(sessionFile ?? path.join(cwd, ".gjc", "state", `${sessionId}.jsonl`)),
					".sdk-reconciliation",
					`${sessionId}.json`,
				),
				"utf8",
			);
			if (options?.onPreflightAcceptCommit) await options.onPreflightAcceptCommit();
			else options?.onPreflightAccepted?.();
		},
	} as unknown as ExtensionAPI;
	createSdkSessionRuntimeExtension(api, { agentDir: fixtureAgentDir, createTransport: () => transport });
	const base = {
		cwd,
		sessionMetadata: { kind: "main" },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
			getCwd: () => cwd,
			getSessionName: () => "host steer oracle",
			getUsageStatistics: () => ({}),
			getBranch: () => [],
		},
		model: { provider: "test", id: "model" },
		modelRegistry: { getAll: () => [], find: () => undefined },
		getContextUsage: () => ({ tokens: 0, contextWindow: 1, percent: 0 }),
		getThinkingLevel: () => "off",
		getActivePromptHandle: () => undefined,
		getPendingMessageCounts: () => ({ steering: 0, followUp: 0, nextTurn: 0 }),
		getTranscript: () => [],
	} as unknown as ExtensionContext;
	const waitForQueuedResponse = async (id: string): Promise<void> => {
		if (queuedResponses.has(id)) return;
		const waiter = Promise.withResolvers<void>();
		const waiters = responseWaiters.get(id) ?? [];
		waiters.push(waiter);
		responseWaiters.set(id, waiters);
		await waiter.promise;
	};
	return {
		start: async () => {
			await handlers.get("session_start")?.({ type: "session_start" }, base);
		},
		stop: async () => {
			await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, base);
		},
		emit: async frame => {
			const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
			pending = { id: String(frame.id), resolve, reject };
			try {
				receive?.("client", frame as never);
				// The test advances the host response explicitly. There is no
				// wall-clock race or fixed sleep budget that can expire under load.
				return await promise;
			} finally {
				if (pending?.id === String(frame.id)) pending = undefined;
			}
		},
		waitForResponse: waitForQueuedResponse,
		deliverResponse: async id => {
			await waitForQueuedResponse(id);
			const response = queuedResponses.get(id);
			if (!response) throw new Error(`response ${id} was already delivered`);
			queuedResponses.delete(id);
			deliverResponse(response);
		},
		expirePendingEmission: () => {
			const current = pending;
			if (!current) throw new Error("no pending host emission");
			pending = undefined;
			current.reject(new Error("host did not respond"));
		},
		get dispatches() {
			return dispatches;
		},
		get persistedAtDispatch() {
			return persistedAtDispatch;
		},
		get lateResponses() {
			return lateResponses;
		},
		waitForLateResponse: id => {
			const existing = lateResponses.find(response => response.id === id);
			if (existing) return Promise.resolve(existing);
			const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
			const waiter: (typeof lateResponseWaiters)[number] = { id, resolve, reject };
			waiter.timer = setTimeout(() => {
				const index = lateResponseWaiters.indexOf(waiter);
				if (index >= 0) lateResponseWaiters.splice(index, 1);
				reject(new Error(`late response ${id} was not delivered`));
			}, RESPONSE_TIMEOUT_MS);
			lateResponseWaiters.push(waiter);
			return promise;
		},
	};
}

async function control(harness: Harness, id: string, text: string, clientRef: string) {
	const response = harness.emit({ type: "control_request", id, operation: "turn.steer", input: { text, clientRef } });
	await harness.deliverResponse(id);
	return await response;
}

function controlWithoutDelivery(harness: Harness, id: string, text: string, clientRef: string) {
	return harness.emit({ type: "control_request", id, operation: "turn.steer", input: { text, clientRef } });
}

async function query(harness: Harness, id: string, input: Record<string, unknown>) {
	const response = harness.emit({ type: "query_request", id, query: "turn.steer_status", input });
	await harness.deliverResponse(id);
	return await response;
}

test("harness handshake resolves after explicit host progression", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-host-steer-handshake-"));
	try {
		const harness = createHarness(cwd, "handshake-delay", undefined);
		await harness.start();
		// The response is held until explicit host progression, so this proof is
		// independent of whether a fresh CI process can schedule a 1ms timer.
		const delayed = controlWithoutDelivery(harness, "delayed", "delayed steer", "delayed-ref");
		await harness.deliverResponse("delayed");
		expect(await delayed).toMatchObject({ ok: true, result: { accepted: true, clientRef: "delayed-ref" } });
		expect(harness.dispatches).toBe(1);
		expect(harness.lateResponses).toEqual([]);
		await harness.stop();
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("harness handshake times out, and a late response never satisfies a later emission", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-host-steer-timeout-"));
	try {
		const harness = createHarness(cwd, "handshake-timeout", undefined);
		await harness.start();
		// A response slower than the safety bound must fail the emission
		// deterministically instead of hanging, and must leave the harness usable.
		await expect(control(harness, "slow", "slow steer", "slow-ref")).rejects.toThrow("host did not respond");
		// The stale frame for the timed-out id lands after that emission ended:
		// it is fenced into lateResponses, never resolving a live await.
		await harness.waitForLateResponse("slow");
		expect(harness.lateResponses.length).toBe(1);
		expect(harness.lateResponses[0]).toMatchObject({ id: "slow", type: "control_response" });
		await harness.deliverResponse("recovered");
		expect(await accepted).toMatchObject({ ok: true, result: { accepted: true, clientRef: "recovered-ref" } });
		expect(harness.dispatches).toBe(2);
		expect(harness.lateResponses.length).toBe(1);
		await harness.stop();
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("harness keeps late responses fenced across repeated bounded-load emissions", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-host-steer-stress-"));
	try {
		const harness = createHarness(cwd, "handshake-stress", undefined);
		await harness.start();
		const rounds = 16;
		for (let index = 0; index < rounds; index++) {
			const timedOut = controlWithoutDelivery(harness, `slow-${index}`, "slow steer", `slow-ref-${index}`);
			harness.expirePendingEmission();
			await expect(timedOut).rejects.toThrow("host did not respond");

			await harness.waitForResponse(`slow-${index}`);
			const recovered = controlWithoutDelivery(
				harness,
				`recovered-${index}`,
				"recovering steer",
				`recovered-ref-${index}`,
			);
			await harness.deliverResponse(`slow-${index}`);
			await harness.deliverResponse(`recovered-${index}`);
			expect(await recovered).toMatchObject({
				ok: true,
				result: { accepted: true, clientRef: `recovered-ref-${index}` },
			});
		}
		expect(harness.lateResponses).toHaveLength(rounds);
		expect(harness.lateResponses.map(response => response.id)).toEqual(
			Array.from({ length: rounds }, (_, index) => `slow-${index}`),
		);
		expect(harness.dispatches).toBe(rounds * 2);
		await harness.stop();
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("production SDK host correlates durable steer replay and restart without redispatch", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-host-steer-"));
	try {
		const sessionId = "host-steer-oracle";
		const sessionFile = path.join(cwd, "sessions", "session.jsonl");
		await fs.mkdir(path.dirname(sessionFile), { recursive: true });
		await fs.writeFile(sessionFile, "");
		const first = createHarness(cwd, sessionId, sessionFile);
		await first.start();
		const accepted = await control(first, "accept", "deliver exactly once", "  caller-ref  ");
		expect(accepted).toMatchObject({ ok: true, result: { accepted: true, clientRef: "caller-ref" } });
		const correlation = (accepted.result ?? {}) as Record<string, unknown>;
		expect(correlation.commandId).toBeString();
		expect(correlation.turnId).toBeString();
		expect(first.persistedAtDispatch).toContain('"status":"dispatching"');
		expect(await control(first, "replay", "deliver exactly once", "caller-ref")).toMatchObject({
			ok: true,
			result: { commandId: correlation.commandId, turnId: correlation.turnId },
		});
		expect(first.dispatches).toBe(1);
		expect(await control(first, "conflict", "different text", "caller-ref")).toMatchObject({
			ok: false,
		});
		expect(first.dispatches).toBe(1);
		expect(await query(first, "by-ref", { clientRef: "caller-ref" })).toMatchObject({
			ok: true,
			result: { commandId: correlation.commandId, turnId: correlation.turnId },
		});
		expect(
			await query(first, "by-pair", { commandId: correlation.commandId, turnId: correlation.turnId }),
		).toMatchObject({
			ok: true,
			result: { clientRef: "caller-ref" },
		});
		// Sequential controls each resolved against their OWN correlated
		// response: no stale or unsolicited frame satisfied any later emission.
		expect(first.lateResponses).toEqual([]);
		const persisted = await fs.readFile(
			path.join(path.dirname(sessionFile), ".sdk-reconciliation", `${sessionId}.json`),
			"utf8",
		);
		expect(persisted).not.toContain("deliver exactly once");
		expect(persisted).not.toContain("different text");
		await first.stop();

		const restarted = createHarness(cwd, sessionId, sessionFile);
		await restarted.start();
		expect(await query(restarted, "restart", { clientRef: "caller-ref" })).toMatchObject({
			ok: true,
			result: { status: "uncertain", error: { code: "process_restart_uncertain" } },
		});
		expect(await control(restarted, "restart-replay", "deliver exactly once", "caller-ref")).toMatchObject({
			ok: true,
			result: { accepted: false, status: "uncertain" },
		});
		expect(restarted.dispatches).toBe(0);
		await restarted.stop();
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("production SDK host persists steer reconciliation under state root when session file is undefined", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-host-steer-state-root-"));
	try {
		const sessionId = "in-memory-host-steer";
		const harness = createHarness(cwd, sessionId, undefined);
		await harness.start();
		const accepted = await control(harness, "accept", "private steer text", "state-root-ref");
		expect(accepted).toMatchObject({ ok: true, result: { accepted: true, clientRef: "state-root-ref" } });
		const persisted = await fs.readFile(
			path.join(cwd, ".gjc", "state", ".sdk-reconciliation", `${sessionId}.json`),
			"utf8",
		);
		expect(persisted).toContain('"status":"accepted"');
		expect(persisted).not.toContain("private steer text");
		await harness.stop();
		const restarted = createHarness(cwd, sessionId, undefined);
		await restarted.start();
		expect(await query(restarted, "restart", { clientRef: "state-root-ref" })).toMatchObject({
			ok: true,
			result: { status: "uncertain", error: { code: "process_restart_uncertain" } },
		});
		await restarted.stop();
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});
