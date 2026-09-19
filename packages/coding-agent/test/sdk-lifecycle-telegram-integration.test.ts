import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../src/extensibility/extensions";
import { Broker } from "../src/sdk/broker/broker";
import { ensureBroker } from "../src/sdk/broker/ensure";
import { SessionIndex, type SessionIndexEvent } from "../src/sdk/broker/session-index";
import { createSdkSessionRuntimeExtension } from "../src/sdk/host/session-runtime";
import {
	deriveSessionLifecycleIdempotencyKey,
	type SessionLifecycleClient,
	type SessionLifecycleClientRequestOptions,
	SessionLifecycleService,
} from "../src/sdk/lifecycle/service";

const actor = { id: "42", namespace: "telegram:account-fingerprint" } as const;

function sdkContext(sessionId: string, cwd: string): ExtensionContext {
	return {
		cwd,
		workflowGate: undefined,
		sdkBindings: () => [],
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => path.join(cwd, `${sessionId}.json`),
			getSessionName: () => undefined,
			getBranch: () => [],
		},
		getTranscript: () => [],
		getGoalState: () => undefined,
	} as unknown as ExtensionContext;
}

function lifecycleClient(
	response: unknown = {
		ok: true,
		result: { sessionId: "broker-session-1", endpoint: { url: "ws://private", token: "secret" } },
	},
) {
	const calls: Array<{
		operation: string;
		input: Record<string, unknown>;
		options: SessionLifecycleClientRequestOptions;
	}> = [];
	const client: SessionLifecycleClient = {
		global: async (operation, input, options) => {
			calls.push({ operation, input, options });
			return response;
		},
	};
	return { service: new SessionLifecycleService(client), calls };
}

describe("SDK-owned Telegram lifecycle integration", () => {
	test("replays one Broker idempotency identity without a daemon control server", async () => {
		const { service, calls } = lifecycleClient();
		const target = { cwd: "/repo" };
		const first = await service.create({ actor, capability: "session.create", requestKey: "telegram:42:17", target });
		const second = await service.create({
			actor,
			capability: "session.create",
			requestKey: "telegram:42:17",
			target,
		});
		expect(calls).toHaveLength(2);
		expect(calls[0]?.options.idempotencyKey).toBe(calls[1]?.options.idempotencyKey);
		expect(calls[0]?.options.idempotencyKey).toBe(
			deriveSessionLifecycleIdempotencyKey(actor, "telegram:42:17", "session.create"),
		);
		expect(first).toEqual({ ok: true, operation: "session.create", result: { sessionId: "broker-session-1" } });
		expect(second).toEqual(first);
	});

	test("projects credential-free outcomes and fails closed on malformed Broker responses", async () => {
		const { service } = lifecycleClient({
			ok: true,
			result: {
				sessionId: "broker-session-2",
				endpoint: { url: "ws://private", token: "secret" },
				lifecycle: { tmuxSession: "gjc-private", sessionStateFile: "/private/state" },
			},
		});
		const outcome = await service.resume({
			actor,
			capability: "session.resume",
			requestKey: "telegram:42:18",
			target: { sessionId: "broker-session-2" },
		});
		expect(JSON.stringify(outcome)).not.toContain("ws://");
		expect(JSON.stringify(outcome)).not.toContain("secret");
		expect(JSON.stringify(outcome)).not.toContain("tmux");
		expect(JSON.stringify(outcome)).not.toContain("sessionStateFile");

		const malformed = lifecycleClient({ ok: true, result: { endpoint: { url: "ws://private", token: "secret" } } });
		const malformedOutcome = await malformed.service.create({
			actor,
			capability: "session.create",
			requestKey: "telegram:42:19",
			target: { cwd: "/repo" },
		});
		expect(malformedOutcome).toMatchObject({
			ok: false,
			certainty: "uncertain",
			error: { code: "malformed_response" },
		});
	});
});

test("four live SDK hosts recover broker index heartbeats without recreating sessions", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-broker-host-recovery-"));
	const agentDir = path.join(root, "agent");
	let broker: Broker | undefined;
	type Handler = (event: unknown, context: ExtensionContext) => Promise<void> | void;
	type TimerRecord = {
		callback: () => void;
		active: boolean;
		unrefCalls: number;
		unref(): void;
	};
	const timerRecords: TimerRecord[] = [];
	const transportStats: Array<{ starts: number; stops: number }> = [];
	let ensureCalls = 0;
	let failingEnsureCalls = 0;
	let ensureInFlight = 0;
	let failEnsures = false;
	let releaseFailure: PromiseWithResolvers<void> | undefined;
	const ensureForTest: typeof ensureBroker = async input => {
		ensureCalls++;
		ensureInFlight++;
		try {
			if (failEnsures) {
				failingEnsureCalls++;
				await releaseFailure?.promise;
				throw new Error("injected broker recovery failure");
			}
			return await ensureBroker(input);
		} finally {
			ensureInFlight--;
		}
	};
	const hosts: Array<{
		handlers: Map<string, Handler>;
		context: ExtensionContext;
		stats: { starts: number; stops: number };
	}> = [];
	try {
		broker = new Broker({ agentDir });
		await broker.start();
		for (let index = 0; index < 4; index++) {
			const sessionId = `live-host-${index + 1}`;
			const cwd = await fs.mkdtemp(path.join(root, `${sessionId}-`));
			const handlers = new Map<string, Handler>();
			const api = {
				on(event: string, handler: Handler) {
					handlers.set(event, handler);
				},
			} as unknown as ExtensionAPI;
			const stats = { starts: 0, stops: 0 };
			transportStats.push(stats);
			createSdkSessionRuntimeExtension(api, {
				agentDir,
				ensureBrokerImpl: ensureForTest,
				setIntervalImpl: ((callback: () => void) => {
					const timer: TimerRecord = {
						callback,
						active: true,
						unrefCalls: 0,
						unref() {
							this.unrefCalls++;
						},
					};
					timerRecords.push(timer);
					return timer as unknown as NodeJS.Timeout;
				}) as typeof setInterval,
				clearIntervalImpl: ((timer: NodeJS.Timeout) => {
					const record = timer as unknown as TimerRecord;
					record.active = false;
				}) as typeof clearInterval,
				createTransport: async ({ sessionId: transportSessionId, stateRoot, token }) => ({
					sessionId: transportSessionId,
					stateRoot,
					token,
					onFrame: () => undefined,
					sendFrame: () => undefined,
					start: async () => {
						stats.starts++;
						const endpoint = path.join(stateRoot, "sdk", `${transportSessionId}.json`);
						await fs.mkdir(path.dirname(endpoint), { recursive: true });
						await fs.writeFile(
							endpoint,
							JSON.stringify({
								sessionId: transportSessionId,
								pid: process.pid,
								url: `ws://127.0.0.1:${31_000 + index}`,
								token,
							}),
						);
						return { url: `ws://127.0.0.1:${31_000 + index}` };
					},
					stop: async () => {
						stats.stops++;
					},
				}),
			});
			const context = sdkContext(sessionId, cwd);
			hosts.push({ handlers, context, stats });
			await hosts[index]!.handlers.get("session_start")?.({}, context);
		}
		expect(transportStats.map(stats => stats.starts)).toEqual([1, 1, 1, 1]);
		expect(timerRecords).toHaveLength(4);
		expect(timerRecords.every(timer => timer.unrefCalls === 1)).toBe(true);

		await broker.stop();
		broker = undefined;
		failEnsures = true;
		releaseFailure = Promise.withResolvers<void>();
		const firstTimer = timerRecords[0]!;
		firstTimer.callback();
		firstTimer.callback();
		await Bun.sleep(0);
		expect(failingEnsureCalls).toBe(1);
		releaseFailure?.resolve();
		for (let attempt = 0; attempt < 100 && ensureInFlight > 0; attempt++) await Bun.sleep(1);
		expect(ensureInFlight).toBe(0);

		broker = new Broker({ agentDir });
		await broker.start();
		failEnsures = false;
		for (const timer of timerRecords) if (timer.active) timer.callback();
		for (let attempt = 0; attempt < 100 && ensureInFlight > 0; attempt++) await Bun.sleep(1);
		// Ensure completion is not a checkpoint barrier; exercise the real
		// replacement broker checkpoint before observing durable heartbeats.
		await broker.heartbeatSessions();
		await broker.index.refresh();
		const recovered = broker.index
			.listSessions()
			.sessions.filter(session => session.sessionId.startsWith("live-host-"));
		expect(recovered).toHaveLength(4);
		expect(recovered.every(session => session.live && session.lastHeartbeatAt !== undefined)).toBe(true);
		expect(ensureCalls).toBeGreaterThan(4);

		for (const host of hosts) await host.handlers.get("session_shutdown")?.({}, host.context);
		expect(timerRecords.every(timer => !timer.active)).toBe(true);
		expect(transportStats.map(stats => stats.stops)).toEqual([1, 1, 1, 1]);
	} finally {
		for (const host of hosts) {
			try {
				await host.handlers.get("session_shutdown")?.({}, host.context);
			} catch {
				// Cleanup retries are best effort after an assertion failure.
			}
		}
		await broker?.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});

for (const replacement of [false, true]) {
	test(`late registration after shutdown retires only its owner (replacement: ${replacement})`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-late-registration-"));
		const agentDir = path.join(root, "agent");
		const sessionId = "stopped-during-registration";
		const context = sdkContext(sessionId, root);
		const handlers = new Map<string, (event: unknown, context: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, context: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const entered = Promise.withResolvers<void>();
		const releasePublication = Promise.withResolvers<void>();
		const published = Promise.withResolvers<SessionIndexEvent>();
		const releaseResult = Promise.withResolvers<void>();
		const append = SessionIndex.prototype.append;
		const appendSpy = spyOn(SessionIndex.prototype, "append").mockImplementation(async function (
			this: SessionIndex,
			input,
		) {
			if (input.type !== "host_registered" || input.sessionId !== sessionId) return await append.call(this, input);
			entered.resolve();
			await releasePublication.promise;
			const event = await append.call(this, input);
			published.resolve(event);
			await releaseResult.promise;
			return event;
		});
		let starting: Promise<void> | void = undefined;
		let transportStops = 0;
		let broker: Broker | undefined;
		try {
			broker = new Broker({ agentDir });
			await broker.start();
			createSdkSessionRuntimeExtension(api, {
				agentDir,
				createTransport: async ({ sessionId: transportSessionId, stateRoot, token }) => ({
					sessionId: transportSessionId,
					stateRoot,
					token,
					onFrame: () => undefined,
					sendFrame: () => undefined,
					start: async () => {
						const endpoint = path.join(stateRoot, "sdk", `${transportSessionId}.json`);
						await fs.mkdir(path.dirname(endpoint), { recursive: true });
						await fs.writeFile(
							endpoint,
							JSON.stringify({
								sessionId: transportSessionId,
								pid: process.pid,
								url: "ws://127.0.0.1:1",
								token,
							}),
						);
						return { url: "ws://127.0.0.1:1" };
					},
					stop: async () => {
						transportStops++;
					},
				}),
			});
			const start = handlers.get("session_start");
			const stop = handlers.get("session_shutdown");
			if (!start || !stop) throw new Error("SDK lifecycle handlers were not installed.");
			starting = start({}, context);
			await entered.promise;
			await stop({}, context);
			expect(transportStops).toBe(1);
			releasePublication.resolve();
			const late = await published.promise;
			const index = await new SessionIndex(agentDir).open();
			if (replacement) {
				// Keep the generation but replace the endpoint file identity, so
				// cleanup must compare the captured publication's exact authority.
				await append.call(index, {
					type: "host_registered",
					sessionId,
					locator: late.locator,
					pid: late.pid,
					endpointGeneration: late.endpointGeneration,
					endpointMtimeMs: late.endpointMtimeMs,
					endpointFileId: `${late.endpointFileId}-replacement`,
					processIncarnation: late.processIncarnation,
					hostIncarnation: late.hostIncarnation,
				});
			}
			releaseResult.resolve();
			await starting;
			await index.refresh();
			const current = index.listSessions().sessions.find(session => session.sessionId === sessionId);
			if (replacement) {
				expect(current).toBeDefined();
				expect(current?.terminal).not.toBe(true);
				expect(current!.indexSeq).toBeGreaterThan(late.indexSeq);
			} else {
				expect(current?.terminal).toBe(true);
			}
		} finally {
			releasePublication.resolve();
			releaseResult.resolve();
			await starting;
			appendSpy.mockRestore();
			await handlers.get("session_shutdown")?.({}, context);
			await broker?.stop();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
}

test("stopping a host while broker ensure is pending cannot register it after disposal", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-broker-stop-fence-"));
	const agentDir = path.join(root, "agent");
	const sessionId = "stopped-during-broker-ensure";
	const cwd = await fs.mkdtemp(path.join(root, "session-"));
	const handlers = new Map<string, (event: unknown, context: ExtensionContext) => Promise<void> | void>();
	const api = {
		on(event: string, handler: (event: unknown, context: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	const ensureEntered = Promise.withResolvers<void>();
	const ensureRelease = Promise.withResolvers<void>();
	let timerCount = 0;
	let transportStops = 0;
	let broker: Broker | undefined;
	try {
		broker = new Broker({ agentDir });
		await broker.start();
		createSdkSessionRuntimeExtension(api, {
			agentDir,
			ensureBrokerImpl: async input => {
				ensureEntered.resolve();
				await ensureRelease.promise;
				return await ensureBroker(input);
			},
			setIntervalImpl: ((callback: () => void) => {
				timerCount++;
				return { callback } as unknown as NodeJS.Timeout;
			}) as typeof setInterval,
			clearIntervalImpl: (() => {}) as typeof clearInterval,
			createTransport: async ({ sessionId: transportSessionId, stateRoot, token }) => ({
				sessionId: transportSessionId,
				stateRoot,
				token,
				onFrame: () => undefined,
				sendFrame: () => undefined,
				start: async () => {
					const endpoint = path.join(stateRoot, "sdk", `${transportSessionId}.json`);
					await fs.mkdir(path.dirname(endpoint), { recursive: true });
					await fs.writeFile(
						endpoint,
						JSON.stringify({
							sessionId: transportSessionId,
							pid: process.pid,
							url: "ws://127.0.0.1:1",
							token,
						}),
					);
					return { url: "ws://127.0.0.1:1" };
				},
				stop: async () => {
					transportStops++;
				},
			}),
		});
		const context = sdkContext(sessionId, cwd);
		const start = handlers.get("session_start");
		const stop = handlers.get("session_shutdown");
		if (!start || !stop) throw new Error("SDK lifecycle handlers were not installed.");
		const starting = start({}, context);
		await ensureEntered.promise;
		await stop({}, context);
		ensureRelease.resolve();
		await starting;
		await broker.index.refresh();
		expect(broker.index.listSessions().sessions.some(session => session.sessionId === sessionId)).toBe(false);
		expect(timerCount).toBe(0);
		expect(transportStops).toBe(1);
	} finally {
		await broker?.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});
