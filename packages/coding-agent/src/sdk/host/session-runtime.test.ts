import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createSdkSessionRuntimeExtension,
	SessionSdkSessionRuntime,
	type SessionSdkTransport,
} from "./session-runtime";
import { createSdkCapabilities, createSdkSurfacePolicy } from "./surface-policy";
import { createReconciliationStore } from "../bus/reconciliation-store";
import type { SdkFrame } from "./types";
import { SdkTransportLifecycleError } from "./websocket-transport";

function memoryTransport(): SessionSdkTransport & {
	feed(connectionId: string, frame: SdkFrame): void;
	readonly sent: SdkFrame[];
	readonly broadcasts: SdkFrame[];
} {
	let handler: ((connectionId: string, frame: SdkFrame) => void) | undefined;
	const sent: SdkFrame[] = [];
	const broadcasts: SdkFrame[] = [];
	let started = false;
	return {
		sessionId: "session-runtime-test",
		stateRoot: "/tmp/gjc-session-runtime-test",
		token: "test-token",
		sent,
		broadcasts,
		onFrame(next) {
			handler = next;
			return () => {
				if (handler === next) handler = undefined;
			};
		},
		sendFrame(_connectionId, frame) {
			sent.push(frame);
		},
		start: async () => {
			started = true;
			return { url: "ws://127.0.0.1:1" };
		},
		stop: async () => {
			started = false;
		},
		broadcastFrame(frame) {
			broadcasts.push(frame);
		},
		feed(connectionId, frame) {
			if (!started) throw new Error("transport is not started");
			handler?.(connectionId, frame);
		},
	};
}

function extensionContext(sessionId: string, cwd: string): any {
	return {
		cwd,
		workflowGate: undefined,
		sdkBindings: () => [],
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => path.join(cwd, `${sessionId}.json`),
			getSessionName: () => undefined,
		},
	};
}

describe("SessionSdkSessionRuntime", () => {
	test("has no notification adapter or native notification import edge", async () => {
		const source = await readFile(new URL("./session-runtime.ts", import.meta.url), "utf8");
		expect(source).not.toContain("../bus");
		expect(source).not.toContain("@gajae-code/natives");
		expect(source).not.toContain("NotificationServer");
	});

	test("hosts control, replay, and reverse frames with notifications disabled", async () => {
		const transport = memoryTransport();
		const runtime = new SessionSdkSessionRuntime({
			transport,
			control: async (_connectionId, frame) => ({ id: frame.id, ok: true, result: { operation: frame.operation } }),
			query: async (_connectionId, frame) => ({ id: frame.id, ok: true, result: { query: frame.query } }),
		});
		await runtime.start();
		runtime.emitEvent({ kind: "session_ready", sessionId: transport.sessionId });
		transport.feed("client", {
			type: "event_replay",
			id: "replay",
			sinceGeneration: runtime.generation,
			sinceSeq: 0,
		});
		transport.feed("client", {
			type: "control_request",
			id: "control",
			operation: "runtime.capabilities",
			input: {},
		});
		transport.feed("client", { type: "query_request", id: "query", query: "Q18", input: {} });
		await Bun.sleep(0);
		expect(transport.broadcasts.some(frame => frame.kind === "session_ready")).toBe(true);
		expect(transport.sent).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "event_replay_result", id: "replay", ok: true }),
				expect.objectContaining({ type: "control_response", id: "control", ok: true }),
				expect.objectContaining({ type: "query_response", id: "query", ok: true }),
			]),
		);
		await runtime.stop();
	});
	test("SDK-only host admits, replays, and conflicts terminal abort requests durably", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-abort-"));
		const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: any) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as any;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		let activeHandle: string | undefined = "exact-run-handle";
		let activeEpoch: number | undefined = 7;
		createSdkSessionRuntimeExtension(api, {
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => activeEpoch,
				getActivePromptHandle: () => activeHandle,
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async (handle, options) => {
					seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			const request = {
				type: "control_request",
				id: "terminal-abort-1",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "terminal-key-1",
			} as SdkFrame;
			transport.feed("client", request);
			await Bun.sleep(25);
			expect(seamCalls).toEqual([{ handle: "exact-run-handle", scope: "turn" }]);
			expect(transport.sent).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "control_response",
						id: "terminal-abort-1",
						ok: true,
						result: expect.objectContaining({ turn: "stopped" }),
					}),
				]),
			);

			transport.feed("client", { ...request, id: "terminal-abort-replay" });
			await Bun.sleep(25);
			expect(seamCalls).toHaveLength(1);
			expect(transport.sent).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "control_response",
						id: "terminal-abort-replay",
						ok: true,
					}),
				]),
			);

			transport.feed("client", {
				...request,
				id: "terminal-abort-conflict",
				input: { mode: "terminal", scope: "owned" },
			});
			await Bun.sleep(25);
			expect(seamCalls).toHaveLength(1);
			expect(transport.sent).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "control_response",
						id: "terminal-abort-conflict",
						ok: false,
						error: expect.objectContaining({ code: "idempotency_conflict" }),
					}),
				]),
			);

			activeHandle = undefined;
			activeEpoch = undefined;
			const idleRequest = { ...request, id: "terminal-abort-idle", idempotencyKey: "terminal-idle-key" };
			transport.feed("client", idleRequest);
			await Bun.sleep(25);
			expect(seamCalls).toHaveLength(1);
			activeHandle = "later-run-handle";
			activeEpoch = 8;
			transport.feed("client", { ...idleRequest, id: "terminal-abort-idle-replay" });
			await Bun.sleep(25);
			expect(seamCalls).toHaveLength(1);
			expect(transport.sent).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "control_response",
						id: "terminal-abort-idle-replay",
						ok: true,
						result: expect.objectContaining({ turn: "no_active_turn" }),
					}),
				]),
			);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host rejects a same-key different-scope race atomically inside the durable transaction", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-race-"));
		const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: any) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as any;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		createSdkSessionRuntimeExtension(api, {
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => 7,
				getActivePromptHandle: () => "exact-run-handle",
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async (handle, options) => {
					seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			const race = {
				type: "control_request",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "race-key",
			} as SdkFrame;
			// Both requests pass the earlier snapshot check before either durable
			// row lands; the serialized transaction must reject the second
			// (different scope) atomically instead of appending a duplicate-key
			// row that would make later replay of the first ambiguous (review
			// thread P2).
			transport.feed("client", { ...race, id: "race-turn" });
			transport.feed("client", { ...race, id: "race-owned", input: { mode: "terminal", scope: "owned" } });
			await Bun.sleep(25);
			const turnResponse = transport.sent.find(frame => frame.id === "race-turn");
			const ownedResponse = transport.sent.find(frame => frame.id === "race-owned");
			expect(turnResponse).toMatchObject({ type: "control_response", ok: true });
			expect(ownedResponse).toMatchObject({
				type: "control_response",
				ok: false,
				error: expect.objectContaining({ code: "idempotency_conflict" }),
			});
			// Only the admitted request reached the session seam; the loser never
			// touched the run.
			expect(seamCalls).toEqual([{ handle: "exact-run-handle", scope: "turn" }]);
			// Exactly ONE durable row exists for the key: the winner's.
			expect(reconciliationStore.snapshotTerminalScopes().filter(s => s.idempotencyKeyHash).length).toBe(1);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("native-like and loopback transports share the same SDK contract matrix", async () => {
		const nativePolicy = createSdkSurfacePolicy({
			bindings: ["sdkControl", "cycleModel", "getSkillState"],
			workflowGateAvailable: false,
		});
		const loopbackPolicy = createSdkSurfacePolicy({
			bindings: ["sdkControl", "cycleModel", "getSkillState"],
			workflowGateAvailable: false,
		});
		expect([...loopbackPolicy.installedControls]).toEqual([...nativePolicy.installedControls]);
		expect([...loopbackPolicy.installedQueries]).toEqual([...nativePolicy.installedQueries]);
		expect(createSdkCapabilities(loopbackPolicy, true)).toEqual(createSdkCapabilities(nativePolicy, true));

		const nativeTransport = memoryTransport();
		const loopbackTransport = memoryTransport();
		const makeRuntime = (transport: ReturnType<typeof memoryTransport>) =>
			new SessionSdkSessionRuntime({
				transport,
				control: async (_connectionId, frame) => ({
					id: frame.id,
					ok: true,
					result: { operation: frame.operation },
				}),
				query: async (_connectionId, frame) => ({ id: frame.id, ok: true, result: { query: frame.query } }),
			});
		const nativeRuntime = makeRuntime(nativeTransport);
		const loopbackRuntime = makeRuntime(loopbackTransport);
		await Promise.all([nativeRuntime.start(), loopbackRuntime.start()]);
		for (const transport of [nativeTransport, loopbackTransport]) {
			transport.feed("client", {
				type: "control_request",
				id: "control",
				operation: "runtime.capabilities",
				input: {},
			});
			transport.feed("client", { type: "query_request", id: "query", query: "turn.prompt_status", input: {} });
		}
		await Bun.sleep(0);
		expect(loopbackTransport.sent).toEqual(nativeTransport.sent);
		await Promise.all([nativeRuntime.stop(), loopbackRuntime.stop()]);
	});
	test("failed extension stop retains retry state before replacement start", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-extension-"));
		const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: any) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as any;
		const transports: Array<{ starts: number; stops: number }> = [];
		createSdkSessionRuntimeExtension(api, {
			createTransport: async ({ sessionId, stateRoot, token }) => {
				const stats = { starts: 0, stops: 0 };
				const failFirstStop = transports.length === 0;
				transports.push(stats);
				let frameHandler: ((connectionId: string, frame: SdkFrame) => void) | undefined;
				return {
					sessionId,
					stateRoot,
					token,
					onFrame(handler) {
						frameHandler = handler;
						return () => {
							if (frameHandler === handler) frameHandler = undefined;
						};
					},
					sendFrame: () => {},
					start: async () => {
						stats.starts += 1;
						return { url: `ws://127.0.0.1:${30_000 + stats.starts}` };
					},
					stop: async () => {
						stats.stops += 1;
						if (failFirstStop && stats.stops === 1)
							throw new SdkTransportLifecycleError(
								"endpoint_remove_failed",
								"injected endpoint removal failure",
							);
					},
				};
			},
		});
		const firstContext = extensionContext("extension-first", cwd);
		try {
			await handlers.get("session_start")?.({}, firstContext);
			expect(transports).toHaveLength(1);
			expect(transports[0]?.starts).toBe(1);
			await expect(handlers.get("session_shutdown")?.({}, firstContext)).rejects.toMatchObject({
				code: "endpoint_remove_failed",
			});
			expect(transports[0]?.stops).toBe(1);

			await handlers.get("session_shutdown")?.({}, firstContext);
			expect(transports[0]?.stops).toBe(2);

			await handlers.get("session_switch")?.({}, extensionContext("extension-replacement", cwd));
			expect(transports).toHaveLength(2);
			expect(transports[1]?.starts).toBe(1);
			await handlers.get("session_shutdown")?.({}, firstContext);
			expect(transports[1]?.stops).toBe(1);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
