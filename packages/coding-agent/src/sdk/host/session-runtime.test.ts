import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../../async";
import type { ExtensionAPI, ExtensionContext } from "../../extensibility/extensions";
import {
	registerOwnedRegistration,
	resetTerminalAbortRegistriesForTests,
	type TurnRegistrationKey,
	unregisterOwnedRegistration,
} from "../../session/terminal-abort";
import { Broker } from "../broker/broker";
import { createReconciliationStore } from "../bus/reconciliation-store";
import {
	createInvocationReconciliation,
	createSdkSessionRuntimeExtension,
	SessionSdkSessionRuntime,
	type SessionSdkTransport,
} from "./session-runtime";
import { createSdkCapabilities, createSdkSurfacePolicy } from "./surface-policy";
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

function admissionBarrier(target: number) {
	const ready = Promise.withResolvers<void>();
	let admitted = 0;
	return {
		onFrameAdmitted() {
			admitted += 1;
			if (admitted === target) ready.resolve();
		},
		ready: ready.promise,
	};
}

function extensionContext(sessionId: string, cwd: string): ExtensionContext {
	return {
		cwd,
		workflowGate: undefined,
		sdkBindings: () => [],
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => path.join(cwd, `${sessionId}.json`),
			getSessionName: () => undefined,
		},
	} as unknown as ExtensionContext;
}

test("preserves an agent failure code in host prompt reconciliation", async () => {
	const reconciliation = createInvocationReconciliation();
	const correlation = { commandId: "failed-command", turnId: "failed-turn" };
	await reconciliation.noteAccepted("prompt", correlation, "failed-ref");
	await reconciliation.noteTransition("prompt", correlation, {
		type: "agent_failed",
		error: Object.assign(new Error("provider unavailable"), { code: "provider_unavailable" }),
	});
	expect(reconciliation.lookup("prompt", { clientRef: "failed-ref" })).toMatchObject({
		status: "failed",
		error: { code: "provider_unavailable", message: "Prompt submission failed." },
	});
});

test("a late agent failure never overwrites the reason an already terminal record carries", async () => {
	const reconciliation = createInvocationReconciliation();
	const correlation = { commandId: "first-reason-command", turnId: "first-reason-turn" };
	await reconciliation.noteAccepted("prompt", correlation, "first-reason-ref");
	await reconciliation.noteTransition("prompt", correlation, {
		type: "agent_failed",
		error: Object.assign(new Error("stream interrupted"), { code: "upstream_stream_interrupted" }),
	});
	const claimed = reconciliation.lookup("prompt", { clientRef: "first-reason-ref" });
	expect(claimed).toMatchObject({
		status: "failed",
		error: { code: "upstream_stream_interrupted", message: "Prompt submission failed." },
		terminalAt: expect.any(Number),
	});
	// First reason wins: a second, different late failure neither replaces the recorded
	// reason nor re-stamps the terminal. The sleep makes a re-stamped terminalAt observable.
	await Bun.sleep(2);
	await reconciliation.noteTransition("prompt", correlation, {
		type: "agent_failed",
		error: Object.assign(new Error("transport reset"), { code: "transport_reset" }),
	});
	expect(reconciliation.lookup("prompt", { clientRef: "first-reason-ref" })).toEqual(claimed);
});

test("a reason attached after a prompt settled is never replaced by a later failure", async () => {
	const reconciliation = createInvocationReconciliation();
	const correlation = { commandId: "late-reason-command", turnId: "late-reason-turn" };
	await reconciliation.noteAccepted("prompt", correlation, "late-reason-ref");
	await reconciliation.noteTransition("prompt", correlation, { type: "agent_end" });
	const claimed = reconciliation.lookup("prompt", { clientRef: "late-reason-ref" }) as Record<string, unknown>;
	expect(claimed).toEqual({
		status: "terminal_ok",
		commandId: "late-reason-command",
		turnId: "late-reason-turn",
		clientRef: "late-reason-ref",
		acceptedAt: expect.any(Number),
		terminalAt: expect.any(Number),
	});
	// A failure delivered after the record settled enriches it with the sanitized reason and
	// leaves the terminal claim itself (status, terminalAt, identity) untouched.
	await reconciliation.noteTransition("prompt", correlation, {
		type: "agent_failed",
		error: Object.assign(new Error("late provider failure"), { code: "upstream_error" }),
	});
	const enriched = reconciliation.lookup("prompt", { clientRef: "late-reason-ref" });
	expect(enriched).toEqual({ ...claimed, error: { code: "upstream_error", message: "Prompt submission failed." } });
	// First reason wins on the enrichment path too: a second, different late failure changes
	// nothing. The sleep makes a re-stamped terminalAt observable.
	await Bun.sleep(2);
	await reconciliation.noteTransition("prompt", correlation, {
		type: "agent_failed",
		error: Object.assign(new Error("transport reset"), { code: "transport_reset" }),
	});
	expect(reconciliation.lookup("prompt", { clientRef: "late-reason-ref" })).toEqual(enriched);
});

test("redacts a persisted host failure during hydration", async () => {
	const stateRoot = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-reconciliation-"));
	const sessionId = "hydrated-failure";
	try {
		await Bun.write(
			path.join(stateRoot, ".sdk-reconciliation", `${sessionId}.json`),
			JSON.stringify({
				version: 1,
				sessionId,
				records: [
					{
						kind: "prompt",
						commandId: "persisted-command",
						turnId: "persisted-turn",
						status: "failed",
						acceptedAt: 1,
						terminalAt: Date.now(),
						error: { code: "unsafe code!", message: "secret provider payload" },
					},
				],
			}),
		);
		const reconciliation = createInvocationReconciliation({ stateRoot, sessionId });
		await reconciliation.hydrate();
		expect(
			reconciliation.lookup("prompt", { commandId: "persisted-command", turnId: "persisted-turn" }),
		).toMatchObject({
			status: "failed",
			error: { code: "internal", message: "Prompt submission failed." },
		});
	} finally {
		await rm(stateRoot, { recursive: true, force: true });
	}
});

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
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		let activeHandle: string | undefined = "exact-run-handle";
		let activeEpoch: number | undefined = 7;
		let captureCalls = 0;
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			onSdkRequest: undefined,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => activeEpoch,
				getActivePromptHandle: () => activeHandle,
				getActivePromptOwnerConnectionId: () => "client",
				cancelPendingPreflightForTerminalAbort: () => {},
				captureTerminalAbortSteeringSnapshot: () => {
					captureCalls += 1;
					return captureCalls;
				},
				abortPromptAndWaitWithTerminal: async (handle, options) => {
					seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			const waitForFrame = async (id: string) => {
				const deadline = Date.now() + 15_000;
				while (!transport.sent.some(frame => frame.id === id)) {
					if (Date.now() > deadline) throw new Error(`Timed out waiting for control frame ${id}`);
					await Bun.sleep(20);
				}
			};
			const request = {
				type: "control_request",
				id: "terminal-abort-1",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "terminal-key-1",
			} as SdkFrame;
			transport.feed("client", request);
			await waitForFrame("terminal-abort-1");
			// The steering snapshot seam is captured at ADMISSION (before the
			// durable transaction and settlement) — mirrors the production
			// wiring in session.ts (review thread P1).
			expect(captureCalls).toBeGreaterThanOrEqual(1);
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
			await waitForFrame("terminal-abort-replay");
			// An in-memory dispatch-cache replay short-circuits before the
			// surface: terminalAbort never runs, so no snapshot is captured and
			// nothing to discard (the durable-replay discard is covered by the
			// seeded-row test below).
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
			await waitForFrame("terminal-abort-conflict");
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
			await waitForFrame("terminal-abort-idle");
			expect(seamCalls).toHaveLength(1);
			activeHandle = "later-run-handle";
			activeEpoch = 8;
			transport.feed("client", { ...idleRequest, id: "terminal-abort-idle-replay" });
			await waitForFrame("terminal-abort-idle-replay");
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

	test("SDK-only host correlates a steering-queued prompt when the unwind promotes it to a run", async () => {
		// Review thread P2: a prompt accepted while the session reports busy
		// (finished prompt unwinding) is queued as steering with NO pending entry
		// at accept; when the unwind continuation actually promotes it to its own
		// run, the promotion hook must create the ownership correlation so the
		// submitting connection can terminal-abort that turn.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-unwind-promoted-"));
		let idle = true;
		let promoted: (() => void) | undefined;
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			sendUserMessage: (
				_content: string,
				options:
					| {
							onPreflightAccepted?: () => void;
							onPreflightAcceptCommit?: () => void;
							onQueuedPromoted?: () => void;
					  }
					| undefined,
			) =>
				Promise.resolve(options?.onPreflightAcceptCommit?.()).then(() => {
					promoted = options?.onQueuedPromoted;
					options?.onPreflightAccepted?.();
					return {};
				}),
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		let captureCalls = 0;
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => 7,
				getActivePromptHandle: () => "exact-run-handle",
				cancelPendingPreflightForTerminalAbort: () => {},
				captureTerminalAbortSteeringSnapshot: () => {
					captureCalls += 1;
					return captureCalls;
				},
				abortPromptAndWaitWithTerminal: async (handle, options) => {
					seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = {
			...extensionContext(transport.sessionId, cwd),
			isIdle: () => idle,
		} as unknown as ExtensionContext;
		try {
			await handlers.get("session_start")?.({}, ctx);
			const prompt = (connectionId: string, id: string) =>
				transport.feed(connectionId, {
					type: "control_request",
					id,
					operation: "turn.prompt",
					input: { text: id, images: [] },
				} as SdkFrame);
			const waitResponse = async (id: string) => {
				const deadline = Date.now() + 15_000;
				while (!transport.sent.some(frame => frame.id === id && frame.type === "control_response")) {
					if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id}`);
					await Bun.sleep(20);
				}
			};
			// A submits while idle and STARTS its run: owner becomes conn-a.
			prompt("conn-a", "unwind-a");
			await waitResponse("unwind-a");
			await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			// B submits while the session still reports busy (unwinding): the prompt
			// is queued as steering and NO pending entry is created at accept.
			idle = false;
			prompt("conn-b", "unwind-b");
			await waitResponse("unwind-b");
			expect(promoted).toBeDefined();
			// The unwind continuation promotes the queued steer to its own run: the
			// correlation hook fires before agent_start...
			promoted!();
			// ...and B's run starts: ownership transfers to conn-b.
			await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			// B's own terminal abort now stops its turn (previously no_active_turn).
			transport.feed("conn-b", {
				type: "control_request",
				id: "unwind-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "unwind-abort-key",
			} as SdkFrame);
			await waitResponse("unwind-abort");
			expect(transport.sent.find(frame => frame.id === "unwind-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			expect(seamCalls).toEqual([{ handle: "exact-run-handle", scope: "turn" }]);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host re-reads the active prompt after an idle reservation wins the race", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-race-active-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		// The FIRST active-prompt read sees no turn (idle abort request); a
		// prompt then wins the race and every later read sees it active —
		// exactly the window where writeNoEffect awaits the store.
		let promptReads = 0;
		let captureCalls = 0;
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => (promptReads++ === 0 ? undefined : 7),
				getActivePromptHandle: () => (promptReads === 0 ? undefined : "won-race-handle"),
				getActivePromptOwnerConnectionId: () => "client",
				cancelPendingPreflightForTerminalAbort: () => {},
				captureTerminalAbortSteeringSnapshot: () => {
					captureCalls += 1;
					return captureCalls;
				},
				abortPromptAndWaitWithTerminal: async (handle, options) => {
					seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
					return {
						status: "settled",
						terminalScope: { scopeId: "scope-race", abortedAttemptEpoch: 7, lineageIdHash: "race-lineage" },
					};
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			transport.feed("client", {
				type: "control_request",
				id: "race-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "race-key",
			} as SdkFrame);
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "race-abort")) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for the race abort response");
				await Bun.sleep(20);
			}
			// The prompt that won the race is ACTIVE-terminalized, never reported
			// as no_active_turn, and the durable no-effect reservation was replaced
			// by the stopped marker so a same-key retry replays stopped.
			expect(seamCalls).toEqual([{ handle: "won-race-handle", scope: "turn" }]);
			expect(transport.sent.find(frame => frame.id === "race-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			transport.feed("client", {
				type: "control_request",
				id: "race-replay",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "race-key",
			} as SdkFrame);
			const replayDeadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "race-replay")) {
				if (Date.now() > replayDeadline) throw new Error("Timed out waiting for the race replay");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "race-replay")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			expect(seamCalls).toHaveLength(1);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host re-reads the active prompt AND its owner after an owner-mismatch reservation wins the race", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-owner-race-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		// Connection A owns the active prompt when the abort is read; while the
		// no-effect reservation awaits the store, A's prompt finishes and
		// connection B's pending prompt wins the race. The aborting connection
		// (B) must re-read handle, epoch, AND owner and fall through to ACTIVE
		// terminalization instead of returning no_active_turn and leaving a
		// durable reservation that blocks B's own running prompt forever
		// (review thread P1).
		let reads = 0;
		let captureCalls = 0;
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getActivePromptHandle: () => {
					reads += 1;
					return reads === 1 ? "owner-a-handle" : "winner-b-handle";
				},
				getTerminalTurnEpoch: () => (reads === 1 ? 1 : 2),
				getActivePromptOwnerConnectionId: () => (reads === 1 ? "conn-a" : "conn-b"),
				cancelPendingPreflightForTerminalAbort: () => {},
				captureTerminalAbortSteeringSnapshot: () => {
					captureCalls += 1;
					return captureCalls;
				},
				abortPromptAndWaitWithTerminal: async (handle, options) => {
					seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
					return {
						status: "settled",
						terminalScope: {
							scopeId: "scope-owner-race",
							abortedAttemptEpoch: 2,
							lineageIdHash: "owner-lineage",
						},
					};
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			// The aborting connection is "conn-b"; the first owner read is
			// "conn-a", so this enters the owner-mismatch branch.
			transport.feed("conn-b", {
				type: "control_request",
				id: "owner-race-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "owner-race-key",
			} as SdkFrame);
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "owner-race-abort")) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for the owner race abort response");
				await Bun.sleep(20);
			}
			// B's now-owned prompt is ACTIVE-terminalized with B's run handle,
			// never reported no_active_turn.
			expect(seamCalls).toEqual([{ handle: "winner-b-handle", scope: "turn" }]);
			expect(transport.sent.find(frame => frame.id === "owner-race-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			// The durable no-effect reservation was replaced by the stopped
			// marker, so a same-key retry replays stopped instead of
			// no_active_turn.
			transport.feed("conn-b", {
				type: "control_request",
				id: "owner-race-replay",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "owner-race-key",
			} as SdkFrame);
			const replayDeadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "owner-race-replay")) {
				if (Date.now() > replayDeadline) throw new Error("Timed out waiting for the owner race replay");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "owner-race-replay")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			expect(seamCalls).toHaveLength(1);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host records the OBSERVED agent_end publication on the terminal stopped row", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-published-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		let captureCalls = 0;
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => 7,
				getActivePromptHandle: () => "exact-run-handle",
				getActivePromptOwnerConnectionId: () => "client",
				cancelPendingPreflightForTerminalAbort: () => {},
				captureTerminalAbortSteeringSnapshot: () => {
					captureCalls += 1;
					return captureCalls;
				},
				abortPromptAndWaitWithTerminal: async (_handle, _options) => {
					// The aborted run's loop exit publishes the correlated
					// agent_end lifecycle event before settlement returns.
					await handlers.get("agent_end")?.({ type: "agent_end" }, ctx);
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			transport.feed("client", {
				type: "control_request",
				id: "published-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "published-key",
			} as SdkFrame);
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "published-abort")) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for the published abort response");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "published-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			// The correlated agent_end was OBSERVED, so the durable row claims
			// terminalPublished (AC 19) — never assumed.
			const scopes = reconciliationStore.snapshotTerminalScopes();
			expect(scopes).toHaveLength(1);
			expect(scopes[0]).toMatchObject({ turnDisposition: "stopped", terminalPublished: true });
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host resolves EVERY concurrent terminal-publication waiter for one aborted turn", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-concurrent-publish-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		let seamCount = 0;
		let captureCalls = 0;
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => 7,
				getActivePromptHandle: () => "exact-run-handle",
				getActivePromptOwnerConnectionId: () => "client",
				cancelPendingPreflightForTerminalAbort: () => {},
				captureTerminalAbortSteeringSnapshot: () => {
					captureCalls += 1;
					return captureCalls;
				},
				abortPromptAndWaitWithTerminal: async (handle, options) => {
					seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
					// The turn emits exactly ONE correlated agent_end no matter how
					// many concurrent aborts stop it; both waiters are installed just
					// before their seam call, so fire it once BOTH have landed.
					seamCount += 1;
					if (seamCount === 2) {
						await handlers.get("agent_end")?.({ type: "agent_end" }, ctx);
					}
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			const abort = (id: string, idempotencyKey: string) =>
				transport.feed("client", {
					type: "control_request",
					id,
					operation: "turn.abort",
					input: { mode: "terminal" },
					idempotencyKey,
				} as SdkFrame);
			// Two concurrent aborts of the SAME active turn with DISTINCT keys:
			// both are admitted and both await the single agent_end.
			abort("conc-abort-1", "conc-key-1");
			abort("conc-abort-2", "conc-key-2");
			const deadline = Date.now() + 15_000;
			while (
				!transport.sent.some(frame => frame.id === "conc-abort-1" && frame.type === "control_response") ||
				!transport.sent.some(frame => frame.id === "conc-abort-2" && frame.type === "control_response")
			) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for the concurrent abort responses");
				await Bun.sleep(20);
			}
			// The onControlResponseDelivery observer writes responseState asynchronously
			// after the transport send; wait for BOTH durable rows to settle before
			// asserting, so the test is not racy on the observer's transactTerminalState
			// microtask drain.
			while (
				reconciliationStore.snapshotTerminalScopes().length < 2 ||
				reconciliationStore.snapshotTerminalScopes().some(scope => scope.responseState !== "sent")
			) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for durable responseState to settle");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "conc-abort-1")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			expect(transport.sent.find(frame => frame.id === "conc-abort-2")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			// BOTH durable rows observed the single publication — a latest-wins
			// single slot would leave one of them terminalPublished:false (review
			// thread P2).
			const scopes = reconciliationStore.snapshotTerminalScopes();
			expect(scopes).toHaveLength(2);
			for (const scope of scopes) {
				expect(scope).toMatchObject({ turnDisposition: "stopped", terminalPublished: true });
				// The stopped result was actually written: the delivery observer
				// matched the response payload hash (which must include the public
				// `ok` field) and advanced the durable state — a shape mismatch
				// would leave responseState pending despite the successful write
				// (review thread P2).
				expect(scope.responseState).toBe("sent");
			}
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host never claims terminalPublished without observing the agent_end publication", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-unpublished-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => 7,
				getActivePromptHandle: () => "exact-run-handle",
				getActivePromptOwnerConnectionId: () => "client",
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async (_handle, _options) => {
					// The worker settles but the lifecycle listener never completes:
					// the durable row must NOT claim the terminal event reached
					// clients (review thread P2).
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			transport.feed("client", {
				type: "control_request",
				id: "unpublished-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "unpublished-key",
			} as SdkFrame);
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "unpublished-abort")) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for the unpublished abort response");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "unpublished-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			// No agent_end was observed: the durable stopped row reports
			// terminalPublished:false, the fail-safe direction.
			const scopes = reconciliationStore.snapshotTerminalScopes();
			expect(scopes).toHaveLength(1);
			expect(scopes[0]).toMatchObject({ turnDisposition: "stopped", terminalPublished: false });
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host cancels only the preflights admitted at abort time, never a pipelined successor", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-preflight-snapshot-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			// Hold every prompt preflight open: acceptance is never signalled, so
			// each submission stays pending until the abort (or nothing) settles it.
			// Deferred via Promise.withResolvers per the repository contract.
			sendUserMessage: () => Promise.withResolvers<void>().promise,
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				// No active turn: the abort takes the idle no-effect path, which is
				// where cancelRequesterPreflights runs after the durable reservation.
				getTerminalTurnEpoch: () => undefined,
				getActivePromptHandle: () => undefined,
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async (_handle, _options) => {
					throw new Error("seam must not be called for an idle abort");
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			const prompt = (id: string) =>
				transport.feed("conn-a", {
					type: "control_request",
					id,
					operation: "turn.prompt",
					input: { text: `hold-${id}`, images: [] },
				} as SdkFrame);
			prompt("pre-1");
			// Let the serialized (ordered) turn.prompt work register its preflight
			// callback, so the abort's admission snapshot below sees it.
			await Bun.sleep(0);
			transport.feed("conn-a", {
				type: "control_request",
				id: "pre-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "pre-snapshot-key",
			} as SdkFrame);
			// A successor prompt pipelined by the SAME connection while the abort
			// awaits the reconciliation transaction: its preflight lands in the
			// live bucket AFTER the abort's admission snapshot and must survive.
			prompt("pre-2");
			const deadline = Date.now() + 15_000;
			while (
				!transport.sent.some(frame => frame.id === "pre-abort" && frame.type === "control_response") ||
				!transport.sent.some(frame => frame.id === "pre-1" && frame.type === "control_response")
			) {
				if (Date.now() > deadline)
					throw new Error("Timed out waiting for the abort and admitted-preflight responses");
				await Bun.sleep(20);
			}
			// The admitted preflight is cancelled by the abort.
			expect(transport.sent.find(frame => frame.id === "pre-1")).toMatchObject({
				ok: false,
				error: expect.objectContaining({ code: "busy" }),
			});
			expect(transport.sent.find(frame => frame.id === "pre-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "no_active_turn" }),
			});
			// The successor preflight was NOT part of the abort's snapshot: it is
			// neither cancelled nor failed, so no control response is emitted for it.
			expect(transport.sent.some(frame => frame.id === "pre-2" && frame.type === "control_response")).toBe(false);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host tracks ownership for skill-invoked turns so a foreign abort cannot stop them", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-skill-owner-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
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
		const ctx = {
			...extensionContext(transport.sessionId, cwd),
			// Declare the binding so the surface policy installs skill.invoke, and
			// accept the preflight so the skill turn is ADMITTED under conn-a.
			sdkBindings: () => ["invokeSkill"],
			invokeSkill: async (_name: string, _args: unknown, options: { onPreflightAccepted?: () => void }) => {
				options.onPreflightAccepted?.();
				return { accepted: true };
			},
		} as unknown as ExtensionContext;
		try {
			await handlers.get("session_start")?.({}, ctx);
			// Client A starts a skill: skill.invoke runs a real prompt through
			// submit(), so the ACCEPTING connection must own the active turn.
			transport.feed("conn-a", {
				type: "control_request",
				id: "skill-a",
				operation: "skill.invoke",
				input: { name: "some-skill", args: "" },
			} as SdkFrame);
			const skillDeadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "skill-a" && frame.type === "control_response")) {
				if (Date.now() > skillDeadline) throw new Error("Timed out waiting for the skill acceptance");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "skill-a")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ accepted: true }),
			});
			// Ownership is associated when the accepted submission STARTS its run
			// (agent_start), not at acceptance: fire the lifecycle event so the
			// skill run is owned by conn-a (review thread P1).
			await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			// Client B's terminal abort must NOT stop A's skill run: owner is A.
			transport.feed("conn-b", {
				type: "control_request",
				id: "skill-abort-b",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "skill-abort-b-key",
			} as SdkFrame);
			const abortDeadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "skill-abort-b" && frame.type === "control_response")) {
				if (Date.now() > abortDeadline) throw new Error("Timed out waiting for the foreign abort response");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "skill-abort-b")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "no_active_turn" }),
			});
			expect(seamCalls).toHaveLength(0);
			// A's own terminal abort still stops its skill run.
			transport.feed("conn-a", {
				type: "control_request",
				id: "skill-abort-a",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "skill-abort-a-key",
			} as SdkFrame);
			const ownDeadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "skill-abort-a" && frame.type === "control_response")) {
				if (Date.now() > ownDeadline) throw new Error("Timed out waiting for the owner abort response");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "skill-abort-a")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			expect(seamCalls).toEqual([{ handle: "exact-run-handle", scope: "turn" }]);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host does not transfer ownership to a queued submission until its run starts", async () => {
		// While client A's prompt is streaming, client B's prompt is accepted as
		// queued steering/follow-up: the owner must STAY with A until B's run
		// actually starts (agent_start), or B could terminal-abort A's running
		// turn while A is refused (review thread P1).
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-queued-owner-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			sendUserMessage: (
				_content: string,
				options: { onPreflightAccepted?: () => void; onPreflightAcceptCommit?: () => void } | undefined,
			) =>
				Promise.resolve(options?.onPreflightAcceptCommit?.()).then(() => {
					options?.onPreflightAccepted?.();
					return {};
				}),
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
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
			const prompt = (connectionId: string, id: string) =>
				transport.feed(connectionId, {
					type: "control_request",
					id,
					operation: "turn.prompt",
					input: { text: id, images: [] },
				} as SdkFrame);
			const waitResponse = async (id: string) => {
				const deadline = Date.now() + 15_000;
				while (!transport.sent.some(frame => frame.id === id && frame.type === "control_response")) {
					if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id}`);
					await Bun.sleep(20);
				}
			};
			// A submits and STARTS its run: owner becomes conn-a.
			prompt("conn-a", "prompt-a");
			await waitResponse("prompt-a");
			await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			// B submits and is ACCEPTED, but only queued (agent_start not fired).
			prompt("conn-b", "prompt-b");
			await waitResponse("prompt-b");
			expect(transport.sent.find(frame => frame.id === "prompt-b")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ accepted: true }),
			});
			// B's abort must NOT stop A's streaming turn: the owner is still A.
			transport.feed("conn-b", {
				type: "control_request",
				id: "queued-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "queued-abort-key",
			} as SdkFrame);
			await waitResponse("queued-abort");
			expect(transport.sent.find(frame => frame.id === "queued-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "no_active_turn" }),
			});
			expect(seamCalls).toHaveLength(0);
			// B's run now STARTS: ownership transfers to conn-b, and B's own abort
			// stops it.
			await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			transport.feed("conn-b", {
				type: "control_request",
				id: "queued-abort-2",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "queued-abort-2-key",
			} as SdkFrame);
			await waitResponse("queued-abort-2");
			expect(transport.sent.find(frame => frame.id === "queued-abort-2")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			expect(seamCalls).toEqual([{ handle: "exact-run-handle", scope: "turn" }]);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host retires steering-queued submissions so a later agent-initiated turn is not mis-owned", async () => {
		// While client A's prompt streams, client B's plain prompt is accepted as
		// queued STEERING and consumed inside the current run — it emits no
		// agent_start, so its pending entry must be retired. Otherwise the next
		// agent-initiated monitor/cron turn's agent_start would shift the stale
		// entry and let B terminal-abort a turn it did not submit (review thread
		// P1).
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-stale-owner-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			sendUserMessage: (
				_content: string,
				options: { onPreflightAccepted?: () => void; onPreflightAcceptCommit?: () => void } | undefined,
			) =>
				Promise.resolve(options?.onPreflightAcceptCommit?.()).then(() => {
					options?.onPreflightAccepted?.();
					return {};
				}),
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		let idle = true;
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
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
		const ctx = {
			...extensionContext(transport.sessionId, cwd),
			isIdle: () => idle,
		} as unknown as ExtensionContext;
		try {
			await handlers.get("session_start")?.({}, ctx);
			const prompt = (connectionId: string, id: string) =>
				transport.feed(connectionId, {
					type: "control_request",
					id,
					operation: "turn.prompt",
					input: { text: id, images: [] },
				} as SdkFrame);
			const waitResponse = async (id: string) => {
				const deadline = Date.now() + 15_000;
				while (!transport.sent.some(frame => frame.id === id && frame.type === "control_response")) {
					if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id}`);
					await Bun.sleep(20);
				}
			};
			// A submits while idle and STARTS its run: owner becomes conn-a.
			prompt("conn-a", "stale-a");
			await waitResponse("stale-a");
			await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			// A's turn is now streaming: B's plain prompt is queued as steering and
			// consumed in-run — its pending entry must NOT be created.
			idle = false;
			prompt("conn-b", "stale-b");
			await waitResponse("stale-b");
			// A later AGENT-INITIATED turn starts: the pending queue is empty, so
			// the owner stays conn-a (B's stale connection is not associated).
			await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			// B's abort must NOT stop the agent-initiated turn.
			transport.feed("conn-b", {
				type: "control_request",
				id: "stale-owner-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "stale-owner-abort-key",
			} as SdkFrame);
			await waitResponse("stale-owner-abort");
			expect(transport.sent.find(frame => frame.id === "stale-owner-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "no_active_turn" }),
			});
			expect(seamCalls).toHaveLength(0);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host retires a follow-up queued while streaming so a later agent-initiated turn is not mis-owned", async () => {
		// While client A's prompt streams, client B's follow-up is consumed by the
		// active loop (agent-loop.ts getFollowUpMessages) with NO new agent_start.
		// Its pending entry must not survive to a later agent-initiated turn, or
		// B could terminal-abort an unrelated monitor/cron turn (review thread
		// P1).
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-stale-followup-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			sendUserMessage: (
				_content: string,
				options: { onPreflightAccepted?: () => void; onPreflightAcceptCommit?: () => void } | undefined,
			) =>
				Promise.resolve(options?.onPreflightAcceptCommit?.()).then(() => {
					options?.onPreflightAccepted?.();
					return {};
				}),
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		let idle = true;
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
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
		const ctx = {
			...extensionContext(transport.sessionId, cwd),
			isIdle: () => idle,
		} as unknown as ExtensionContext;
		try {
			await handlers.get("session_start")?.({}, ctx);
			const waitResponse = async (id: string) => {
				const deadline = Date.now() + 15_000;
				while (!transport.sent.some(frame => frame.id === id && frame.type === "control_response")) {
					if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id}`);
					await Bun.sleep(20);
				}
			};
			// A starts its run while idle: owner becomes conn-a.
			transport.feed("conn-a", {
				type: "control_request",
				id: "fu-a",
				operation: "turn.prompt",
				input: { text: "a", images: [] },
			} as SdkFrame);
			await waitResponse("fu-a");
			await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			// A streams: B's follow-up is consumed in-run -> NO pending entry.
			idle = false;
			transport.feed("conn-b", {
				type: "control_request",
				id: "fu-b",
				operation: "turn.follow_up",
				input: { text: "follow up b" },
			} as SdkFrame);
			await waitResponse("fu-b");
			// A later agent-initiated turn starts: the pending queue is empty, so
			// B's stale connection is never associated as owner.
			await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			transport.feed("conn-b", {
				type: "control_request",
				id: "stale-followup-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "stale-followup-abort-key",
			} as SdkFrame);
			await waitResponse("stale-followup-abort");
			expect(transport.sent.find(frame => frame.id === "stale-followup-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "no_active_turn" }),
			});
			expect(seamCalls).toHaveLength(0);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host retires an accepted-then-failed submission so a later agent-initiated turn is not mis-owned", async () => {
		// An idle submission is accepted (pending entry pushed) and then REJECTS
		// before agent_start (e.g. the busy retry expires). The failed entry must
		// be retired — a later agent-initiated monitor/cron turn must not inherit
		// the failed submission's connection as owner (review thread P1).
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-failed-owner-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			sendUserMessage: (
				content: string | { text: string }[],
				options: { onPreflightAccepted?: () => void; onPreflightAcceptCommit?: () => void } | undefined,
			) => {
				const commit = Promise.resolve(options?.onPreflightAcceptCommit?.()).then(() => {
					options?.onPreflightAccepted?.();
					return {};
				});
				const text = typeof content === "string" ? content : (content[0]?.text ?? "");
				// The "fail-b" submission is accepted, then its run REJECTS.
				if (text === "fail-b")
					return commit.then(() => {
						throw new Error("provider failed after acceptance");
					});
				return commit;
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
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
			const prompt = (connectionId: string, id: string, text: string) =>
				transport.feed(connectionId, {
					type: "control_request",
					id,
					operation: "turn.prompt",
					input: { text, images: [] },
				} as SdkFrame);
			const waitResponse = async (id: string) => {
				const deadline = Date.now() + 15_000;
				while (!transport.sent.some(frame => frame.id === id && frame.type === "control_response")) {
					if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id}`);
					await Bun.sleep(20);
				}
			};
			// A submits while idle and STARTS its run: owner becomes conn-a.
			prompt("conn-a", "ok-a", "ok-a");
			await waitResponse("ok-a");
			await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			// B submits while idle (entry pushed), then its run REJECTS.
			prompt("conn-b", "fail-b", "fail-b");
			await waitResponse("fail-b");
			expect(transport.sent.find(frame => frame.id === "fail-b")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ accepted: true }),
			});
			// Let the async rejection settle and retire B's pending entry.
			await Bun.sleep(50);
			// A later agent-initiated turn starts: the pending queue is empty, so
			// B's failed submission is never associated as owner.
			await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			transport.feed("conn-b", {
				type: "control_request",
				id: "failed-owner-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "failed-owner-abort-key",
			} as SdkFrame);
			await waitResponse("failed-owner-abort");
			expect(transport.sent.find(frame => frame.id === "failed-owner-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "no_active_turn" }),
			});
			expect(seamCalls).toHaveLength(0);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host refuses terminal aborts of UNOWNED agent-initiated turns", async () => {
		// An agent-initiated turn (monitor/cron follow-up) has NO accepting SDK
		// connection: the active handle exists but the owner is undefined, so
		// every client must be refused — never authorized by an absent or stale
		// owner (review thread P1).
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-unowned-turn-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				// Active turn exists, but NO owner is recorded (no prompt/skill was
				// accepted by any SDK connection) — the seam getter is absent so the
				// runtime-tracked owner (undefined) is consulted.
				getTerminalTurnEpoch: () => 7,
				getActivePromptHandle: () => "agent-initiated-handle",
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
			transport.feed("client", {
				type: "control_request",
				id: "unowned-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "unowned-abort-key",
			} as SdkFrame);
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "unowned-abort" && frame.type === "control_response")) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for the unowned abort response");
				await Bun.sleep(20);
			}
			// No owner: the abort is refused without touching the seam.
			expect(transport.sent.find(frame => frame.id === "unowned-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "no_active_turn", terminal: "terminal_no_effect" }),
			});
			expect(seamCalls).toHaveLength(0);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host replays a no_effect_reserved row as uncertainty, never a fabricated no_active_turn", async () => {
		// A transitional no-effect reservation (the abort may still transition to
		// active while the reservation is awaited) must never replay as a
		// definitive no_active_turn: a duplicate in that window would otherwise
		// get no_active_turn while the original stops the prompt (review thread
		// P2).
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-reserved-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => undefined,
				getActivePromptHandle: () => undefined,
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async () => ({ status: "settled" }),
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			const keyHash = createHash("sha256").update("reserved-key").digest("hex");
			const inputHash = createHash("sha256")
				.update(JSON.stringify({ mode: "terminal", scope: "turn" }))
				.digest("hex");
			// Seed a mid-flight reserved reservation directly (the abort's own
			// writeNoEffect produces this disposition while the recheck is
			// pending).
			await reconciliationStore.transactTerminalState(state => ({
				scopes: [
					{
						selection: "turn",
						idempotencyKeyHash: keyHash,
						idempotencyInputHash: inputHash,
						turnDisposition: "no_effect_reserved",
						terminalPublished: false,
						ownedWorkDisposition: "not_requested",
						automaticDeliveryDisposition: "enabled",
						resumeOnOwnedCompletion: true,
						turnContinuationFence: {
							state: "retained",
							abortedAttemptEpoch: 0,
							blockedContinuationIds: [],
							predecessorTombstones: [],
							ownedCompletionPolicy: "enabled",
						},
						responseState: "pending",
						responsePayloadHash: inputHash,
						acceptedAt: Date.now(),
					},
					...state.scopes,
				],
				keys: state.keys,
			}));
			transport.feed("client", {
				type: "control_request",
				id: "reserved-replay",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "reserved-key",
			} as SdkFrame);
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "reserved-replay" && frame.type === "control_response")) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for the reserved-row replay");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "reserved-replay")).toMatchObject({
				ok: true,
				result: expect.objectContaining({
					turn: "uncertain",
					reason: "reservation_in_flight",
					replay: expect.objectContaining({ responseState: "pending" }),
				}),
			});
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host does not advance a pending marker's response state for a mismatched replayed payload", async () => {
		// When >256 concurrent requests evict an in-flight abort from the dispatch
		// cache, a same-key retry replays the PENDING marker as pending_replay. The
		// delivery observer must NOT mark the original marker sent for the
		// retry's uncertainty response: it only advances when the written
		// response's payload matches the row's stored hash (review thread P2).
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-pending-state-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => undefined,
				getActivePromptHandle: () => undefined,
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async () => ({ status: "settled" }),
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			const keyHash = createHash("sha256").update("pending-key").digest("hex");
			const inputHash = createHash("sha256")
				.update(JSON.stringify({ mode: "terminal", scope: "turn" }))
				.digest("hex");
			// Seed the ORIGINAL in-flight marker: pending, with the input-hash
			// placeholder as its payload hash.
			await reconciliationStore.transactTerminalState(state => ({
				scopes: [
					{
						selection: "turn",
						idempotencyKeyHash: keyHash,
						idempotencyInputHash: inputHash,
						turnDisposition: "pending",
						terminalPublished: false,
						ownedWorkDisposition: "not_requested",
						automaticDeliveryDisposition: "enabled",
						resumeOnOwnedCompletion: true,
						turnContinuationFence: {
							state: "retained",
							abortedAttemptEpoch: 0,
							blockedContinuationIds: [],
							predecessorTombstones: [],
							ownedCompletionPolicy: "enabled",
						},
						responseState: "pending",
						responsePayloadHash: inputHash,
						acceptedAt: Date.now(),
					},
					...state.scopes,
				],
				keys: state.keys,
			}));
			transport.feed("client", {
				type: "control_request",
				id: "pending-replay",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "pending-key",
			} as SdkFrame);
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "pending-replay" && frame.type === "control_response")) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for the pending-row replay");
				await Bun.sleep(20);
			}
			// The retry replays the pending marker as pending_replay...
			expect(transport.sent.find(frame => frame.id === "pending-replay")).toMatchObject({
				ok: true,
				result: expect.objectContaining({
					turn: "uncertain",
					reason: "replay_pending",
					replay: expect.objectContaining({ responseState: "pending" }),
				}),
			});
			// ...but the ORIGINAL marker's durable state must NOT be advanced by
			// the retry's mismatched payload.
			await Bun.sleep(50);
			expect(reconciliationStore.snapshotTerminalScopes()[0]!.responseState).toBe("pending");
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host replays an EVICTED no-effect reservation as no_active_turn, not uncertain", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-evicted-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const admissions = admissionBarrier(9);
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			onFrameAdmitted: admissions.onFrameAdmitted,
			terminalAbortSeams: {
				maxDurableTerminalReservationsForTests: 8,
				getReconciliationStore: () => reconciliationStore,
				// No active turn: every idle abort reserves a no-effect row.
				getTerminalTurnEpoch: () => undefined,
				getActivePromptHandle: () => undefined,
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
			const idleAbort = (id: string, idempotencyKey: string) =>
				transport.feed("client", {
					type: "control_request",
					id,
					operation: "turn.abort",
					input: { mode: "terminal" },
					idempotencyKey,
				} as SdkFrame);
			// Fill the completed-scope bound (256) and overflow once so the FIRST
			// no-effect row is evicted into a tombstone that preserves its
			// turnDisposition (review thread P2).
			for (let index = 0; index < 9; index++) idleAbort(`idle-${index}`, `evict-key-${index}`);
			await admissions.ready;
			await reconciliationStore.drain?.();
			expect(seamCalls).toHaveLength(0);
			// The overflowed reservation now exists only as a tombstone; replaying
			// its key must return the original no_active_turn/terminal_no_effect
			// result deterministically, never a fabricated uncertainty.
			transport.feed("client", {
				type: "control_request",
				id: "evicted-replay",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "evict-key-0",
			} as SdkFrame);
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "evicted-replay")) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for the evicted-key replay");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "evicted-replay")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "no_active_turn", terminal: "terminal_no_effect" }),
			});
			// A truly fresh key still reports no_active_turn with no seam call.
			transport.feed("client", {
				type: "control_request",
				id: "fresh-idle",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "fresh-key",
			} as SdkFrame);
			while (!transport.sent.some(frame => frame.id === "fresh-idle")) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for the fresh-key idle abort");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "fresh-idle")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "no_active_turn", terminal: "terminal_no_effect" }),
			});
			expect(seamCalls).toHaveLength(0);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host rejects a same-key different-scope race atomically inside the durable transaction", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-race-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => 7,
				getActivePromptHandle: () => "exact-run-handle",
				getActivePromptOwnerConnectionId: () => "client",
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
			// The winner's stopped response awaits the bounded agent_end
			// publication observation, so await both responses instead of a fixed
			// sleep (review thread P2).
			const raceDeadline = Date.now() + 15_000;
			while (
				!transport.sent.some(frame => frame.id === "race-turn" && frame.type === "control_response") ||
				!transport.sent.some(frame => frame.id === "race-owned" && frame.type === "control_response")
			) {
				if (Date.now() > raceDeadline)
					throw new Error("Timed out waiting for the same-key different-scope race responses");
				await Bun.sleep(20);
			}
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

	test("SDK-only host cancels exact owned jobs before reporting stopped_owned", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-owned-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		resetTerminalAbortRegistriesForTests();
		AsyncJobManager.setInstance(manager);
		AsyncJobManager.registerForEndpoint("owned-ep", manager);
		const gate = Promise.withResolvers<string>();
		let jobId: string | undefined;
		let registration: TurnRegistrationKey | undefined;
		try {
			jobId = manager.register("bash", "owned job", () => gate.promise);
			const generation = manager.getJob(jobId)?.generation;
			expect(generation).toBeTypeOf("string");
			registration = {
				endpointId: "owned-ep",
				endpointGeneration: 1,
				lineageIdHash: "sdk-owned-lineage",
				promptAttemptEpoch: 7,
				jobId,
				jobGeneration: generation as string,
			};
			registerOwnedRegistration(registration as never, { isJobTerminal: () => false });
			const seamCalls: Array<{ handle: string; scope: string }> = [];
			createSdkSessionRuntimeExtension(api, {
				agentDir: cwd,
				createTransport: async () => transport,
				terminalAbortSeams: {
					getReconciliationStore: () => reconciliationStore,
					getTerminalTurnEpoch: () => 7,
					getActivePromptHandle: () => "exact-run-handle",
					getActivePromptOwnerConnectionId: () => "client",
					cancelPendingPreflightForTerminalAbort: () => {},
					abortPromptAndWaitWithTerminal: async (handle, options) => {
						seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
						return {
							status: "settled",
							terminalScope: {
								scopeId: "scope-owned",
								abortedAttemptEpoch: 7,
								lineageIdHash: "sdk-owned-lineage",
							},
						};
					},
				},
			});
			const ctx = extensionContext(transport.sessionId, cwd);
			await handlers.get("session_start")?.({}, ctx);
			transport.feed("client", {
				type: "control_request",
				id: "owned-abort",
				operation: "turn.abort",
				input: { mode: "terminal", scope: "owned" },
				idempotencyKey: "owned-key",
			} as SdkFrame);
			// Let the background job unwind within the 500ms owned-settlement
			// grace so quiescence is provable.
			void Bun.sleep(50).then(() => gate.resolve("done"));
			const ownedDeadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "owned-abort" && frame.type === "control_response")) {
				if (Date.now() > ownedDeadline) throw new Error("Timed out waiting for the owned abort response");
				await Bun.sleep(20);
			}
			const response = transport.sent.find(frame => frame.id === "owned-abort");
			expect(response).toMatchObject({
				type: "control_response",
				ok: true,
				result: expect.objectContaining({ turn: "stopped", ownedWork: "stopped" }),
			});
			expect(seamCalls).toEqual([{ handle: "exact-run-handle", scope: "owned" }]);
			// The exact owned job was cancelled by settleOwnedWork before the
			// stopped disposition was reported.
			const settledStatus = jobId ? manager.getJob(jobId)?.status : undefined;
			expect(settledStatus).toBeDefined();
			expect(["cancelled", "completed", "failed"]).toContain(settledStatus as string);
		} finally {
			gate.resolve("done");
			if (registration) unregisterOwnedRegistration(registration as never);
			AsyncJobManager.unregisterManager(manager);
			AsyncJobManager.setInstance(undefined);
			await manager.dispose({ timeoutMs: 100 }).catch(() => {});
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host bounds completed terminal rows and retains key tombstones", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-bound-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const admissions = admissionBarrier(12);
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			onFrameAdmitted: admissions.onFrameAdmitted,
			terminalAbortSeams: {
				maxDurableTerminalReservationsForTests: 8,
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => undefined,
				getActivePromptHandle: () => undefined,
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async () => ({ status: "settled" }),
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			// Idle terminal aborts with distinct keys must not grow the
			// reconciliation document without limit: completed rows are bounded
			// and evicted keys become compact tombstones (review thread P2).
			for (let index = 0; index < 12; index++) {
				transport.feed("client", {
					type: "control_request",
					id: `bound-${index}`,
					operation: "turn.abort",
					input: { mode: "terminal" },
					idempotencyKey: `bound-key-${index}`,
				} as SdkFrame);
			}
			// Yield once so every fire-and-forget frame handler can admit its first
			// serialized transaction, then drain the exact durable queue. Polling all
			// responses under the file's five-second deadline made scheduler load part
			// of the persistence contract.
			await admissions.ready;
			await reconciliationStore.drain?.();
			expect(transport.sent.length).toBeGreaterThanOrEqual(12);
			expect(reconciliationStore.snapshotTerminalScopes().length).toBeLessThanOrEqual(8);
			expect(reconciliationStore.snapshotTerminalKeys().length).toBeGreaterThan(0);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host bounds distinct-key terminal markers on UNCERTAIN finalization", async () => {
		// Many concurrent terminal aborts (distinct keys) of one turn that fails
		// to settle must not leave an arbitrarily large reconciliation document:
		// the pending->uncertain finalize applies the same 256-row bound and
		// retains key tombstones (review thread P2).
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-uncertain-bound-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const admissions = admissionBarrier(12);
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			onFrameAdmitted: admissions.onFrameAdmitted,
			terminalAbortSeams: {
				maxDurableTerminalReservationsForTests: 8,
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => 7,
				getActivePromptHandle: () => "exact-run-handle",
				getActivePromptOwnerConnectionId: () => "client",
				cancelPendingPreflightForTerminalAbort: () => {},
				// The turn never settles: every abort finalizes its pending marker
				// to UNCERTAIN (worker_unsettled).
				abortPromptAndWaitWithTerminal: async () => ({ status: "unfenced" }),
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			for (let index = 0; index < 12; index++) {
				transport.feed("client", {
					type: "control_request",
					id: `uncertain-${index}`,
					operation: "turn.abort",
					input: { mode: "terminal" },
					idempotencyKey: `uncertain-key-${index}`,
				} as SdkFrame);
			}
			await admissions.ready;
			await reconciliationStore.drain?.();
			expect(transport.sent.length).toBeGreaterThanOrEqual(12);
			// The uncertain finalizes evicted the oldest rows into tombstones.
			expect(reconciliationStore.snapshotTerminalScopes().length).toBeLessThanOrEqual(8);
			expect(reconciliationStore.snapshotTerminalKeys().length).toBeGreaterThan(0);
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
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transports: Array<{ starts: number; stops: number }> = [];
		createSdkSessionRuntimeExtension(api, {
			agentDir: path.join(cwd, ".gjc", "agent"),
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
						const endpoint = path.join(stateRoot, "sdk", `${sessionId}.json`);
						await mkdir(path.dirname(endpoint), { recursive: true });
						await writeFile(endpoint, JSON.stringify({ sessionId, token, pid: process.pid }));
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
	test("keeps a local SDK-only host alive through broker failure and registers after recovery", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-broker-recovery-"));
		const agentDir = path.join(cwd, ".gjc", "agent");
		await mkdir(path.dirname(agentDir), { recursive: true });
		await writeFile(agentDir, "blocked");
		const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: any) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as any;
		const sessionId = "broker-recovery";
		createSdkSessionRuntimeExtension(api, {
			agentDir,
			createTransport: async ({ stateRoot, token }) => ({
				sessionId,
				stateRoot,
				token,
				onFrame: () => undefined,
				sendFrame: () => {},
				start: async () => {
					const endpoint = path.join(stateRoot, "sdk", `${sessionId}.json`);
					await mkdir(path.dirname(endpoint), { recursive: true });
					await writeFile(endpoint, JSON.stringify({ sessionId, token, pid: process.pid }));
					return { url: "ws://127.0.0.1:1" };
				},
				stop: async () => {},
			}),
		});
		const context = extensionContext(sessionId, cwd);
		let broker: Broker | undefined;
		try {
			await handlers.get("session_start")?.({}, context);
			await rm(agentDir);
			await mkdir(agentDir, { recursive: true });
			broker = new Broker({ agentDir });
			await broker.start();
			await handlers.get("turn_start")?.({}, context);
			expect(await broker.handleRequest("session.get_endpoint", { sessionId, endpointGeneration: 1 })).toMatchObject(
				{
					ok: true,
					result: { sessionId, token: expect.any(String) },
				},
			);
			await handlers.get("session_shutdown")?.({}, context);
			// DR-1 keeps the unregistered row listed, so the two refusals stay distinct:
			// a matching generation on a terminal row is terminally gone (no endpoint will
			// ever be issued again, and close takes its signal fallback), while a rotated
			// generation is still merely stale and worth re-reading.
			expect(await broker.handleRequest("session.get_endpoint", { sessionId, endpointGeneration: 1 })).toMatchObject(
				{
					ok: false,
					error: { code: "resource_gone", message: "session endpoint record is gone" },
				},
			);
			expect(await broker.handleRequest("session.get_endpoint", { sessionId, endpointGeneration: 2 })).toMatchObject(
				{
					ok: false,
					error: { code: "endpoint_stale", message: "session endpoint is stale" },
				},
			);
		} finally {
			await broker?.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("rejects lifecycle-required SDK-only startup when broker registration fails", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-broker-required-"));
		const agentDir = path.join(cwd, ".gjc", "agent");
		await mkdir(path.dirname(agentDir), { recursive: true });
		await writeFile(agentDir, "blocked");
		const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: any) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as any;
		createSdkSessionRuntimeExtension(api, {
			agentDir,
			brokerRegistrationRequired: true,
			createTransport: async ({ sessionId, stateRoot, token }) => ({
				sessionId,
				stateRoot,
				token,
				onFrame: () => undefined,
				sendFrame: () => {},
				start: async () => ({ url: "ws://127.0.0.1:1" }),
				stop: async () => {},
			}),
		});
		try {
			await expect(
				handlers.get("session_start")?.({}, extensionContext("broker-required", cwd)),
			).rejects.toBeDefined();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
interface PreflightHooks {
	onPreflightAccepted?: () => void;
	onPreflightAcceptCommit?: () => void | Promise<void>;
}

interface ResponseFrame {
	id?: string;
	ok?: boolean;
	result?: { status?: string; commandId?: string; turnId?: string; error?: { code: string; message: string } };
}

interface InvocationHarness {
	control(operation: string, input: Record<string, unknown>): Promise<ResponseFrame>;
	query(name: string, input: Record<string, unknown>): Promise<ResponseFrame>;
	emit(event: string): Promise<void>;
	stop(): Promise<void>;
}

/**
 * Drives the SDK host through its wire surface: control/query frames in,
 * response frames out. Nothing reaches into the reconciliation maps.
 */
async function invocationHarness(
	sessionId: string,
	cwd: string,
	hooks: {
		sendUserMessage?: (content: unknown, options?: PreflightHooks & { deliverAs?: string }) => Promise<void>;
		invokeSkill?: (name: string, args?: string, options?: PreflightHooks) => Promise<unknown>;
		abort?: () => void;
		isIdle?: () => boolean;
	},
): Promise<InvocationHarness> {
	const waiters = new Map<string, (frame: ResponseFrame) => void>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
	let deliver: ((connectionId: string, frame: SdkFrame) => void) | undefined;
	let nextId = 0;
	const api = {
		on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
			handlers.set(event, handler);
		},
		sendUserMessage: hooks.sendUserMessage ?? (async () => {}),
	} as unknown as ExtensionAPI;
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
		createTransport: async ({ sessionId: id, stateRoot, token }) => ({
			sessionId: id,
			stateRoot,
			token,
			onFrame(handler) {
				deliver = handler;
				return () => {
					if (deliver === handler) deliver = undefined;
				};
			},
			sendFrame(_connectionId, frame) {
				const response = frame as ResponseFrame;
				if (typeof response.id === "string") waiters.get(response.id)?.(response);
			},
			broadcastFrame: () => {},
			start: async () => ({ url: "ws://127.0.0.1:1" }),
			stop: async () => {},
		}),
	});
	const ctx = {
		cwd,
		workflowGate: undefined,
		sdkBindings: () => (hooks.invokeSkill ? ["invokeSkill"] : []),
		isIdle: hooks.isIdle ?? (() => true),
		abort: hooks.abort ?? (() => {}),
		...(hooks.invokeSkill ? { invokeSkill: hooks.invokeSkill } : {}),
		sessionManager: { getSessionId: () => sessionId, getSessionName: () => undefined },
	};
	await handlers.get("session_start")?.({}, ctx);
	const request = (frame: Record<string, unknown>): Promise<ResponseFrame> => {
		const id = `frame-${nextId}`;
		nextId += 1;
		const { promise, resolve } = Promise.withResolvers<ResponseFrame>();
		waiters.set(id, resolve);
		deliver?.("client", { ...frame, id } as SdkFrame);
		return promise;
	};
	return {
		control: (operation, input) => request({ type: "control_request", operation, input }),
		query: (name, input) => request({ type: "query_request", query: name, input }),
		emit: async event => {
			await handlers.get(event)?.({}, ctx);
		},
		stop: async () => {
			await handlers.get("session_shutdown")?.({}, ctx);
		},
	};
}

/** Polls a status query until the invocation reports a terminal reconciliation state. */
async function settledStatus(
	harness: InvocationHarness,
	name: string,
	input: Record<string, unknown>,
): Promise<NonNullable<ResponseFrame["result"]>> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const frame = await harness.query(name, input);
		const result = frame.result;
		if (result && (result.status === "failed" || result.status === "terminal_ok")) return result;
		await Bun.sleep(1);
	}
	throw new Error(`${name} never reported a terminal reconciliation status`);
}

describe("post-acceptance invocation terminalization", () => {
	test("a prompt killed by a provider stream interrupt reports a terminal failed status", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminalize-prompt-"));
		try {
			const harness = await invocationHarness("terminalize-prompt", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					throw Object.assign(
						new Error("upstream request failed: stream interrupted before terminal response event"),
						{ code: "upstream_stream_interrupted" },
					);
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "hello" });
			expect(accepted.ok).toBe(true);
			const { commandId, turnId } = accepted.result ?? {};
			// Provider text is redacted on the wire by contract (sanitizePromptFailure);
			// the failure reason survives as the safe-token code.
			expect(await settledStatus(harness, "turn.prompt_status", { commandId, turnId })).toMatchObject({
				status: "failed",
				error: { code: "upstream_stream_interrupted", message: "Prompt submission failed." },
			});
			await harness.stop();
		} finally {
			// Let the reconciliation store finish its atomic write before the state root disappears.
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("an aborted prompt reports a terminal failed status instead of hanging", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminalize-abort-"));
		try {
			const inflight = Promise.withResolvers<void>();
			const harness = await invocationHarness("terminalize-abort", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await inflight.promise;
				},
				abort: () => inflight.reject(Object.assign(new Error("turn aborted"), { code: "aborted" })),
			});
			const accepted = await harness.control("turn.prompt", { text: "hello" });
			const { commandId, turnId } = accepted.result ?? {};
			expect(await harness.control("turn.abort", {})).toMatchObject({ ok: true });
			expect(await settledStatus(harness, "turn.prompt_status", { commandId, turnId })).toMatchObject({
				status: "failed",
				error: { code: "aborted" },
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a failed skill invocation still reports a terminal failed status", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminalize-skill-"));
		try {
			const harness = await invocationHarness("terminalize-skill", cwd, {
				invokeSkill: async (_name, _args, options) => {
					await options?.onPreflightAcceptCommit?.();
					throw Object.assign(new Error("skill provider stream interrupted"), { code: "upstream_error" });
				},
			});
			const accepted = await harness.control("skill.invoke", { name: "ralplan" });
			expect(accepted.ok).toBe(true);
			const { commandId, turnId } = accepted.result ?? {};
			expect(await settledStatus(harness, "skill.invoke_status", { commandId, turnId })).toMatchObject({
				status: "failed",
				error: { code: "upstream_error" },
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("a completed prompt reports a terminal successful status", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminalize-completed-prompt-"));
		try {
			const harness = await invocationHarness("terminalize-completed-prompt", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "hello" });
			expect(accepted.ok).toBe(true);
			const { commandId, turnId } = accepted.result ?? {};
			expect(await settledStatus(harness, "turn.prompt_status", { commandId, turnId })).toMatchObject({
				status: "terminal_ok",
				terminalAt: expect.any(Number),
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("a queued follow-up prompt is not terminalized before the turn runs", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminalize-followup-"));
		try {
			const turnRunning = Promise.withResolvers<void>();
			const harness = await invocationHarness("terminalize-followup", cwd, {
				sendUserMessage: async (_content, options) => {
					if (options?.deliverAs === "followUp") {
						await options?.onPreflightAcceptCommit?.();
						// #queueFollowUp resolves immediately; the turn has not run yet.
						return;
					}
					await options?.onPreflightAcceptCommit?.();
					await turnRunning.promise;
				},
			});
			const accepted = await harness.control("turn.follow_up", { text: "hello" });
			expect(accepted.ok).toBe(true);
			const { commandId, turnId } = accepted.result ?? {};
			// The follow-up submission must NOT report terminal_ok while the turn is still pending.
			const status = await harness.query("turn.prompt_status", { commandId, turnId });
			expect(status.result?.status).toMatch(/accepted|in_flight|unknown/);
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("a prompt queued as steer while streaming is not terminalized before the turn runs", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminalize-prompt-while-busy-"));
		try {
			const harness = await invocationHarness("terminalize-prompt-while-busy", cwd, {
				sendUserMessage: async (_content, options) => {
					// Session is streaming: sendUserMessage diverts to #queueSteer and resolves.
					await options?.onPreflightAcceptCommit?.();
				},
				isIdle: () => false,
			});
			const accepted = await harness.control("turn.prompt", { text: "hello" });
			expect(accepted.ok).toBe(true);
			const { commandId, turnId } = accepted.result ?? {};
			// The diverted prompt must NOT report terminal_ok while the turn is still pending.
			const status = await harness.query("turn.prompt_status", { commandId, turnId });
			expect(status.result?.status).toMatch(/accepted|in_flight|unknown/);
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("a queued prompt stays non-terminal even if isIdle flips during the accept window", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminalize-race-"));
		let idle = false;
		try {
			const harness = await invocationHarness("terminalize-race", cwd, {
				sendUserMessage: async (_content, options) => {
					// The session is streaming when the submission starts (divert to steer).
					// During accept()->persist(), the prior turn unwinds and isIdle flips to true.
					await options?.onPreflightAcceptCommit?.();
					idle = true;
				},
				isIdle: () => idle,
			});
			const accepted = await harness.control("turn.prompt", { text: "hello" });
			expect(accepted.ok).toBe(true);
			const { commandId, turnId } = accepted.result ?? {};
			// The snapshot taken at dispatch time (idle=false) must hold: the prompt was
			// queued, so it must not report terminal_ok even though isIdle is now true.
			const status = await harness.query("turn.prompt_status", { commandId, turnId });
			expect(status.result?.status).toMatch(/accepted|in_flight|unknown/);
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a pre-acceptance failure rejects the submission without creating a record", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminalize-preflight-"));
		try {
			const harness = await invocationHarness("terminalize-preflight", cwd, {
				sendUserMessage: async () => {
					throw Object.assign(new Error("session is busy"), { code: "busy" });
				},
			});
			const rejected = await harness.control("turn.prompt", { text: "hello", clientRef: "preflight-ref" });
			expect(rejected.ok).toBe(false);
			const status = await harness.query("turn.prompt_status", { clientRef: "preflight-ref" });
			expect(status.result).toEqual({ status: "unknown" });
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a later provider error enriches but never re-opens an already terminal prompt", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminalize-once-"));
		try {
			const inflight = Promise.withResolvers<void>();
			const harness = await invocationHarness("terminalize-once", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await inflight.promise;
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "hello" });
			const { commandId, turnId } = accepted.result ?? {};
			await harness.emit("agent_start");
			await harness.emit("agent_end");
			const claimed = await settledStatus(harness, "turn.prompt_status", { commandId, turnId });
			expect(claimed).toMatchObject({ status: "terminal_ok" });
			inflight.reject(Object.assign(new Error("late provider failure"), { code: "upstream_error" }));
			await Bun.sleep(20);
			// A lifecycle frame arriving after the terminal must not resurrect the record either.
			await harness.emit("agent_start");
			const settled = await harness.query("turn.prompt_status", { commandId, turnId });
			// The late reason attaches to the settled record, so `error` is the only field that may
			// appear; status, terminalAt, and identity stay exactly as claimed.
			const { error: _claimedReason, ...claimedTerminal } = claimed;
			const { error: _lateReason, ...settledTerminal } = settled.result ?? {};
			expect(settledTerminal).toEqual(claimedTerminal);
			// The recorded reason is the sanitized late failure: never fabricated, never raw.
			expect(settled.result?.error).toEqual({ code: "upstream_error", message: "Prompt submission failed." });
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

test("SDK-only host never advances a finalized uncertain row for a mismatched replayed payload", async () => {
	// Review thread P2: before the payload-hash fix, an uncertain/no-effect row
	// kept the input-hash placeholder, and the response-state advance trusted
	// ANY non-pending placeholder — so a same-key retry whose response differed
	// from the original (e.g. pending_replay delivered late) could mark the
	// durable row sent. Finalization now stores the EXACT final payload hash,
	// so a mismatched delivery must leave the row pending.
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-uncertain-payload-"));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	const transport = memoryTransport();
	const reconciliationStore = createReconciliationStore({
		sessionFile: path.join(cwd, "session.json"),
		sessionId: transport.sessionId,
	});
	const seamCalls: Array<{ handle: string; scope: string }> = [];
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
		createTransport: async () => transport,
		terminalAbortSeams: {
			getReconciliationStore: () => reconciliationStore,
			getTerminalTurnEpoch: () => 7,
			getActivePromptHandle: () => "exact-run-handle",
			getActivePromptOwnerConnectionId: () => "client",
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
		const keyHash = createHash("sha256").update("uncertain-key").digest("hex");
		const inputHash = createHash("sha256")
			.update(JSON.stringify({ mode: "terminal", scope: "turn" }))
			.digest("hex");
		// Seed a FINALIZED uncertain row with responseState still pending (the
		// original response was never delivered). Post-fix finalization stores
		// the exact payload hash; simulating the pre-fix placeholder state must
		// not let a mismatched retry delivery advance the row.
		await reconciliationStore.transactTerminalState(state => ({
			scopes: [
				{
					selection: "turn",
					idempotencyKeyHash: keyHash,
					idempotencyInputHash: inputHash,
					turnDisposition: "uncertain",
					terminalPublished: false,
					ownedWorkDisposition: "uncertain",
					automaticDeliveryDisposition: "none",
					resumeOnOwnedCompletion: false,
					turnContinuationFence: {
						state: "retained",
						abortedAttemptEpoch: 0,
						blockedContinuationIds: [],
						predecessorTombstones: [],
						ownedCompletionPolicy: "disabled",
					},
					responseState: "pending",
					responsePayloadHash: inputHash,
					acceptedAt: Date.now(),
				},
				...state.scopes,
			],
			keys: state.keys,
		}));
		transport.feed("client", {
			type: "control_request",
			id: "uncertain-replay",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "uncertain-key",
		} as SdkFrame);
		const deadline = Date.now() + 15_000;
		while (!transport.sent.some(frame => frame.id === "uncertain-replay" && frame.type === "control_response")) {
			if (Date.now() > deadline) throw new Error("Timed out waiting for the uncertain-row replay");
			await Bun.sleep(20);
		}
		// The retry replays the finalized row (its payload differs from the
		// seeded placeholder), so the delivery must NOT advance the row.
		await Bun.sleep(50);
		expect(reconciliationStore.snapshotTerminalScopes()[0]!.responseState).toBe("pending");
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("SDK-only host FIFO-expires tombstones instead of failing the finalization at the cap", async () => {
	// Review thread P2: a long-lived session fills the evicted-key tombstone
	// collection with unique terminal-abort keys. The next finalization must
	// FIFO-expire the oldest tombstones instead of throwing — the destructive
	// stop may already have succeeded, and throwing would leave the client
	// with an error and its durable row pending, with subsequent aborts
	// repeating the failure.
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-tombstone-cap-"));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	const transport = memoryTransport();
	const reconciliationStore = createReconciliationStore({
		sessionFile: path.join(cwd, "session.json"),
		sessionId: transport.sessionId,
	});
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
		createTransport: async () => transport,
		terminalAbortSeams: {
			getReconciliationStore: () => reconciliationStore,
			getTerminalTurnEpoch: () => 7,
			getActivePromptHandle: () => "exact-run-handle",
			getActivePromptOwnerConnectionId: () => undefined,
			cancelPendingPreflightForTerminalAbort: () => {},
			abortPromptAndWaitWithTerminal: async (_handle, _options) => ({ status: "settled", terminalScope: {} }),
		},
	});
	const ctx = extensionContext(transport.sessionId, cwd);
	try {
		await handlers.get("session_start")?.({}, ctx);
		// Fill the tombstone collection to the 4096 cap.
		await reconciliationStore.transactTerminalState(state => ({
			scopes: state.scopes,
			keys: Array.from({ length: 4096 }, (_, i) => ({
				keyHash: createHash("sha256").update(`cap-key-${i}`).digest("hex"),
				inputHash: createHash("sha256").update(`cap-input-${i}`).digest("hex"),
				turnDisposition: "stopped" as const,
				ownedWorkDisposition: "left_running" as const,
				responseState: "pending" as const,
				responsePayloadHash: createHash("sha256").update("p").digest("hex"),
			})),
		}));
		// The next idle abort finalizes a no-effect reservation: the oldest
		// tombstone expires instead of the finalization throwing.
		transport.feed("client", {
			type: "control_request",
			id: "cap-abort",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "cap-abort-key",
		} as SdkFrame);
		const deadline = Date.now() + 15_000;
		while (!transport.sent.some(frame => frame.id === "cap-abort" && frame.type === "control_response")) {
			if (Date.now() > deadline) throw new Error("Timed out waiting for the cap abort response");
			await Bun.sleep(20);
		}
		expect(transport.sent.find(frame => frame.id === "cap-abort")).toMatchObject({
			ok: true,
			result: expect.objectContaining({ turn: "no_active_turn", terminal: "terminal_no_effect" }),
		});
		// The collection stays bounded at the cap.
		expect(reconciliationStore.snapshotTerminalKeys()).toHaveLength(4096);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("SDK-only host cancels only the aborting requester's preflight while another connection is admitted", async () => {
	// Review thread P1: a queued requester's terminal abort rejects its own
	// wrapper callback but must NOT invoke the session-wide preflight abort
	// while another connection has an active pending admission — the seam
	// cancels the session's single controller, which would kill the other
	// connection's preflight while the aborting requester's queued admission
	// may still start on the newly reset controller.
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-preflight-scope-"));
	let seamCancels = 0;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
		sendUserMessage: async (_content: string, options: { onPreflightAcceptCommit?: () => Promise<void> }) => {
			await options?.onPreflightAcceptCommit?.();
		},
	} as unknown as ExtensionAPI;
	const transport = memoryTransport();
	const reconciliationStore = createReconciliationStore({
		sessionFile: path.join(cwd, "session.json"),
		sessionId: transport.sessionId,
	});
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
		createTransport: async () => transport,
		terminalAbortSeams: {
			getReconciliationStore: () => reconciliationStore,
			getTerminalTurnEpoch: () => 7,
			getActivePromptHandle: () => "exact-run-handle",
			getActivePromptOwnerConnectionId: () => undefined,
			cancelPendingPreflightForTerminalAbort: () => {
				seamCancels++;
			},
			abortPromptAndWaitWithTerminal: async (_handle, _options) => ({ status: "settled", terminalScope: {} }),
		},
	});
	const ctx = extensionContext(transport.sessionId, cwd);
	try {
		await handlers.get("session_start")?.({}, ctx);
		const waitResponse = async (id: string) => {
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === id && frame.type === "control_response")) {
				if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id}`);
				await Bun.sleep(20);
			}
		};
		// Two connections admit prompts while idle; both preflights are pending.
		transport.feed("conn-a", {
			type: "control_request",
			id: "preflight-a",
			operation: "turn.prompt",
			input: { text: "a" },
		} as SdkFrame);
		await waitResponse("preflight-a");
		transport.feed("conn-b", {
			type: "control_request",
			id: "preflight-b",
			operation: "turn.prompt",
			input: { text: "b" },
		} as SdkFrame);
		await waitResponse("preflight-b");
		// Conn B terminal-aborts before its run starts: only B's wrapper
		// preflight may be cancelled; A's active preflight must survive.
		transport.feed("conn-b", {
			type: "control_request",
			id: "preflight-abort-b",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "preflight-abort-b-key",
		} as SdkFrame);
		await waitResponse("preflight-abort-b");
		// The session-wide seam was never invoked while another connection's
		// preflight was pending — only the aborting requester's wrapper
		// callback was rejected.
		expect(seamCancels).toBe(0);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("SDK-only host keeps the idle-submitted prompt's owner when isIdle flips during the accept window", async () => {
	// Review thread P1: the production AgentSession begins its in-flight
	// bookkeeping BEFORE the preflight acceptance callback, so re-reading
	// isIdle() inside accept() would observe the session as already streaming
	// and record no pending owner — the submitting connection could then never
	// terminal-abort its own prompt (the abort would report no_active_turn and
	// ACP would treat the cancellation as unacknowledged). The startsOwnTurn
	// decision must come from the PRE-DISPATCH idle snapshot.
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-startsown-snapshot-"));
	let idle = true;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
		sendUserMessage: async (_content: string, options: { onPreflightAcceptCommit?: () => Promise<void> }) => {
			await options?.onPreflightAcceptCommit?.();
			// The session's in-flight bookkeeping begins during the accept
			// window: a re-read of isIdle() now reports streaming.
			idle = false;
		},
	} as unknown as ExtensionAPI;
	const transport = memoryTransport();
	const reconciliationStore = createReconciliationStore({
		sessionFile: path.join(cwd, "session.json"),
		sessionId: transport.sessionId,
	});
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
		createTransport: async () => transport,
		terminalAbortSeams: {
			getReconciliationStore: () => reconciliationStore,
			getTerminalTurnEpoch: () => 7,
			getActivePromptHandle: () => "exact-run-handle",
			getActivePromptOwnerConnectionId: () => undefined,
			cancelPendingPreflightForTerminalAbort: () => {},
			abortPromptAndWaitWithTerminal: async () => ({ status: "settled", terminalScope: {} }),
		},
	});
	const ctx = { ...extensionContext(transport.sessionId, cwd), isIdle: () => idle } as ExtensionContext;
	try {
		await handlers.get("session_start")?.({}, ctx);
		transport.feed("client", {
			type: "control_request",
			id: "idle-owner-prompt",
			operation: "turn.prompt",
			input: { text: "hello" },
		} as SdkFrame);
		const deadline = Date.now() + 15_000;
		while (!transport.sent.some(frame => frame.id === "idle-owner-prompt" && frame.type === "control_response")) {
			if (Date.now() > deadline) throw new Error("Timed out waiting for the idle prompt acceptance");
			await Bun.sleep(20);
		}
		expect(transport.sent.find(frame => frame.id === "idle-owner-prompt")).toMatchObject({ ok: true });
		// The run starts: the dispatch-time idle snapshot recorded the pending
		// owner for the submitting connection.
		await handlers.get("agent_start")?.({}, ctx);
		transport.feed("client", {
			type: "control_request",
			id: "idle-owner-abort",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "idle-owner-abort-key",
		} as SdkFrame);
		const abortDeadline = Date.now() + 15_000;
		while (!transport.sent.some(frame => frame.id === "idle-owner-abort" && frame.type === "control_response")) {
			if (Date.now() > abortDeadline) throw new Error("Timed out waiting for the idle-prompt abort");
			await Bun.sleep(20);
		}
		expect(transport.sent.find(frame => frame.id === "idle-owner-abort")).toMatchObject({
			ok: true,
			result: expect.objectContaining({ turn: "stopped" }),
		});
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("SDK-only host advances a finalized stopped row when the retry replay matches the stored replay hash", async () => {
	// Review thread P2: a row finalized with responseState still pending (the
	// process exited before the original response was written) stores the
	// ORIGINAL payload hash; a same-key retry delivers the replay-shaped
	// payload (replay envelope appended). The finalization now also stores the
	// replay-shaped hash, so the written retry response advances the row from
	// pending to sent instead of leaving it durably pending forever.
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-stopped-replay-advance-"));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	const transport = memoryTransport();
	const reconciliationStore = createReconciliationStore({
		sessionFile: path.join(cwd, "session.json"),
		sessionId: transport.sessionId,
	});
	let captureCalls = 0;
	let discardCalls = 0;
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
		createTransport: async () => transport,
		terminalAbortSeams: {
			getReconciliationStore: () => reconciliationStore,
			getTerminalTurnEpoch: () => 7,
			getActivePromptHandle: () => "exact-run-handle",
			getActivePromptOwnerConnectionId: () => "client",
			cancelPendingPreflightForTerminalAbort: () => {},
			captureTerminalAbortSteeringSnapshot: () => {
				captureCalls += 1;
				return captureCalls;
			},
			discardTerminalAbortSteeringSnapshot: () => {
				discardCalls += 1;
			},
			abortPromptAndWaitWithTerminal: async (_handle, _options) => {
				return { status: "settled", terminalScope: {} };
			},
		},
	});
	const ctx = extensionContext(transport.sessionId, cwd);
	try {
		await handlers.get("session_start")?.({}, ctx);
		const keyHash = createHash("sha256").update("stopped-replay-key").digest("hex");
		const inputHash = createHash("sha256")
			.update(JSON.stringify({ mode: "terminal", scope: "turn" }))
			.digest("hex");
		const result = {
			ok: true,
			selection: "turn",
			turn: "stopped",
			ownedWork: "left_running",
			automaticDelivery: "enabled",
			resumeOnOwnedCompletion: true,
		};
		const payloadHash = createHash("sha256").update(JSON.stringify(result)).digest("hex");
		const replayResult = {
			...result,
			// The replay envelope carries the POST-CAS publication flag the
			// stopped-row CAS observed (agent_end published); the seeded
			// replay-shaped hash must match that exact envelope (review
			// thread P2).
			replay: { responseState: "pending", responsePayloadHash: payloadHash, terminalPublished: true },
		};
		const replayPayloadHash = createHash("sha256").update(JSON.stringify(replayResult)).digest("hex");
		// Seed the POST-finalization durable state: the original stopped result
		// hash plus the replay-shaped hash a same-key retry delivers.
		await reconciliationStore.transactTerminalState(state => ({
			scopes: [
				{
					selection: "turn",
					idempotencyKeyHash: keyHash,
					idempotencyInputHash: inputHash,
					turnDisposition: "stopped",
					terminalPublished: true,
					ownedWorkDisposition: "left_running",
					automaticDeliveryDisposition: "enabled",
					resumeOnOwnedCompletion: true,
					turnContinuationFence: {
						state: "retained",
						abortedAttemptEpoch: 0,
						blockedContinuationIds: [],
						predecessorTombstones: [],
						ownedCompletionPolicy: "disabled",
					},
					responseState: "pending",
					responsePayloadHash: payloadHash,
					replayPayloadHash,
					acceptedAt: Date.now(),
					terminalAt: Date.now(),
				},
				...state.scopes,
			],
			keys: state.keys,
		}));
		transport.feed("client", {
			type: "control_request",
			id: "stopped-replay",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "stopped-replay-key",
		} as SdkFrame);
		const deadline = Date.now() + 15_000;
		while (!transport.sent.some(frame => frame.id === "stopped-replay" && frame.type === "control_response")) {
			if (Date.now() > deadline) throw new Error("Timed out waiting for the stopped-row replay");
			await Bun.sleep(20);
		}
		// The written replay's payload matches the stored replay-shaped hash, so
		// the delivery observer advances the durable row to sent.
		const stateDeadline = Date.now() + 15_000;
		while (reconciliationStore.snapshotTerminalScopes()[0]!.responseState !== "sent") {
			if (Date.now() > stateDeadline) throw new Error("Timed out waiting for the stopped-row response state");
			await Bun.sleep(20);
		}
		expect(transport.sent.find(frame => frame.id === "stopped-replay")).toMatchObject({
			ok: true,
			result: expect.objectContaining({
				turn: "stopped",
				replay: expect.objectContaining({ responseState: "pending" }),
			}),
		});
		// The durable replay (dispatch-cache eviction equivalent: the row was
		// seeded before this runtime admitted anything) captured a snapshot at
		// admission and then DISCARDED it — the replay path never settles, so
		// the FIFO holds no stale entry for a later real abort to consume
		// (review thread P1).
		expect(captureCalls).toBe(1);
		expect(discardCalls).toBe(1);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("SDK-only host does not assign a follow-up requester ownership until the follow-up actually starts", async () => {
	// Review thread P1: a turn.follow_up accepted while ctx.isIdle() is true
	// but the follow-up is never promoted (compaction, transcript ending in a
	// user/tool-result message) must not record the requester in pending — a
	// later unrelated agent_start would shift the stale entry and let the
	// follow-up connection terminal-abort a turn it did not submit. Ownership
	// correlates only when the queued follow-up is actually promoted.
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-followup-stale-"));
	const idle = true;
	let promoted: (() => void) | undefined;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
		sendUserMessage: (
			_content: string,
			options:
				| {
						onPreflightAccepted?: () => void;
						onPreflightAcceptCommit?: () => void;
						onQueuedPromoted?: () => void;
				  }
				| undefined,
		) =>
			Promise.resolve(options?.onPreflightAcceptCommit?.()).then(() => {
				promoted = options?.onQueuedPromoted;
				options?.onPreflightAccepted?.();
				return {};
			}),
	} as unknown as ExtensionAPI;
	const transport = memoryTransport();
	const reconciliationStore = createReconciliationStore({
		sessionFile: path.join(cwd, "session.json"),
		sessionId: transport.sessionId,
	});
	const seamCalls: Array<{ handle: string; scope: string }> = [];
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
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
	const ctx = {
		...extensionContext(transport.sessionId, cwd),
		isIdle: () => idle,
	} as unknown as ExtensionContext;
	try {
		await handlers.get("session_start")?.({}, ctx);
		const waitResponse = async (id: string) => {
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === id && frame.type === "control_response")) {
				if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id}`);
				await Bun.sleep(20);
			}
		};
		// B submits a follow-up while idle. The follow-up is QUEUED (never starts
		// inline), and with no promotion (e.g. compaction holds the continuation)
		// no pending ownership entry may exist — even though isIdle is true.
		transport.feed("conn-b", {
			type: "control_request",
			id: "followup-b",
			operation: "turn.follow_up",
			input: { text: "followup-b" },
		} as SdkFrame);
		await waitResponse("followup-b");
		// The promotion hook exists but is NOT fired in this scenario.
		expect(promoted).toBeDefined();
		// An unrelated turn starts: the pending queue is empty, so the owner is
		// NOT conn-b.
		await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		// B's abort must NOT stop the unrelated turn.
		transport.feed("conn-b", {
			type: "control_request",
			id: "followup-abort",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "followup-abort-key",
		} as SdkFrame);
		await waitResponse("followup-abort");
		expect(transport.sent.find(frame => frame.id === "followup-abort")).toMatchObject({
			ok: true,
			result: expect.objectContaining({ turn: "no_active_turn" }),
		});
		expect(seamCalls).toHaveLength(0);
		// When the follow-up IS promoted, B owns its run and can abort it.
		promoted!();
		await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		transport.feed("conn-b", {
			type: "control_request",
			id: "followup-abort-2",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "followup-abort-key-2",
		} as SdkFrame);
		await waitResponse("followup-abort-2");
		expect(transport.sent.find(frame => frame.id === "followup-abort-2")).toMatchObject({
			ok: true,
			result: expect.objectContaining({ turn: "stopped" }),
		});
		expect(seamCalls).toEqual([{ handle: "exact-run-handle", scope: "turn" }]);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("SDK-only host lets every connection whose follow-up was promoted abort the shared run", async () => {
	// Review thread P2: two connections submit follow-ups while idle before any
	// scheduled continuation starts; ONE continuation drains both into one run.
	// The per-message promotion hooks (fired at actual dequeue) must make BOTH
	// connections owners of that run, so each can terminal-abort work it
	// submitted, while a foreign connection still cannot.
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-multi-followup-"));
	const promoted: Array<() => void> = [];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
		sendUserMessage: (
			_content: string,
			options:
				| {
						onPreflightAccepted?: () => void;
						onPreflightAcceptCommit?: () => void;
						onQueuedPromoted?: () => void;
				  }
				| undefined,
		) =>
			Promise.resolve(options?.onPreflightAcceptCommit?.()).then(() => {
				if (options?.onQueuedPromoted) promoted.push(options.onQueuedPromoted);
				options?.onPreflightAccepted?.();
				return {};
			}),
	} as unknown as ExtensionAPI;
	const transport = memoryTransport();
	const reconciliationStore = createReconciliationStore({
		sessionFile: path.join(cwd, "session.json"),
		sessionId: transport.sessionId,
	});
	const seamCalls: Array<{ handle: string; scope: string }> = [];
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
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
		const waitResponse = async (id: string) => {
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === id && frame.type === "control_response")) {
				if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id}`);
				await Bun.sleep(20);
			}
		};
		const followUp = (connectionId: string, id: string) =>
			transport.feed(connectionId, {
				type: "control_request",
				id,
				operation: "turn.follow_up",
				input: { text: id },
			} as SdkFrame);
		// A and B submit follow-ups while idle: no pending entries at accept.
		followUp("conn-a", "fu-a");
		await waitResponse("fu-a");
		followUp("conn-b", "fu-b");
		await waitResponse("fu-b");
		expect(promoted).toHaveLength(2);
		// ONE continuation drains both follow-ups into one run: both per-message
		// hooks fire at dequeue, then the run starts.
		for (const hook of promoted) hook();
		await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		// Both submitting connections can terminal-abort the shared run.
		for (const [connectionId, id] of [
			["conn-a", "multi-abort-a"],
			["conn-b", "multi-abort-b"],
		] as const) {
			transport.feed(connectionId, {
				type: "control_request",
				id,
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: `${id}-key`,
			} as SdkFrame);
			await waitResponse(id);
			expect(transport.sent.find(frame => frame.id === id)).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
		}
		expect(seamCalls).toHaveLength(2);
		// A foreign connection still cannot stop the run.
		transport.feed("conn-c", {
			type: "control_request",
			id: "multi-abort-c",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "multi-abort-c-key",
		} as SdkFrame);
		await waitResponse("multi-abort-c");
		expect(transport.sent.find(frame => frame.id === "multi-abort-c")).toMatchObject({
			ok: true,
			result: expect.objectContaining({ turn: "no_active_turn" }),
		});
		expect(seamCalls).toHaveLength(2);
		// Review thread P1: EVERY follow-up batched into the shared run must
		// reach a terminal record. A promotion that only transitioned the first
		// invocation left the remaining follow-ups durably accepted — their
		// result lookups would never complete and a restart would report them
		// failed even though they ran in the shared turn.
		await handlers.get("agent_end")?.({ type: "agent_end" }, ctx);
		{
			const terminalDeadline = Date.now() + 15_000;
			const promptStatuses = () =>
				reconciliationStore
					.snapshot()
					.filter(record => record.kind === "prompt")
					.map(record => record.status);
			while (promptStatuses().some(status => status !== "terminal_ok")) {
				if (Date.now() > terminalDeadline)
					throw new Error("Timed out waiting for the batched follow-up records to terminalize");
				await Bun.sleep(20);
			}
		}
		const batchedTerminals = reconciliationStore
			.snapshot()
			.filter(record => record.kind === "prompt" && record.status === "terminal_ok");
		expect(batchedTerminals).toHaveLength(2);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("SDK-only host rebinds the steering snapshot when the requester's turn wins the owner race", async () => {
	// Review thread P1: an abort admitted while another connection owns the
	// active turn captures its snapshot under that OLD turn; when the durable
	// no-effect reservation reveals that the ABORTING requester's own prompt
	// became active, the fall-through terminalizes that turn and must REBIND
	// the admission snapshot to it — otherwise the settlement rejects the
	// still-old token and the requester's turn keeps running.
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-snapshot-rebind-"));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	const transport = memoryTransport();
	const reconciliationStore = createReconciliationStore({
		sessionFile: path.join(cwd, "session.json"),
		sessionId: transport.sessionId,
	});
	let ownerReads = 0;
	let rebindCalls = 0;
	const settledOptions: Array<{ scope?: string; steeringSnapshotToken?: number }> = [];
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
		createTransport: async () => transport,
		terminalAbortSeams: {
			getReconciliationStore: () => reconciliationStore,
			getTerminalTurnEpoch: () => 7,
			getActivePromptHandle: () => "exact-run-handle",
			// First read: another connection owns the turn. The recheck after
			// the durable reservation: the aborting requester now owns it.
			getActivePromptOwnerConnectionId: () => (ownerReads++ === 0 ? undefined : "client"),
			cancelPendingPreflightForTerminalAbort: () => {},
			captureTerminalAbortSteeringSnapshot: () => 42,
			rebindTerminalAbortSteeringSnapshot: () => {
				rebindCalls += 1;
			},
			abortPromptAndWaitWithTerminal: async (_handle, options) => {
				settledOptions.push({
					scope: options.terminal?.scope,
					steeringSnapshotToken: options.terminal?.steeringSnapshotToken,
				});
				return { status: "settled", terminalScope: {} };
			},
		},
	});
	const ctx = extensionContext(transport.sessionId, cwd);
	try {
		await handlers.get("session_start")?.({}, ctx);
		transport.feed("client", {
			type: "control_request",
			id: "owner-race-abort",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "owner-race-key",
		} as SdkFrame);
		const deadline = Date.now() + 15_000;
		while (!transport.sent.some(frame => frame.id === "owner-race-abort" && frame.type === "control_response")) {
			if (Date.now() > deadline) throw new Error("Timed out waiting for the owner-race abort response");
			await Bun.sleep(20);
		}
		// The fall-through terminalized the requester's rechecked turn: the
		// admission snapshot was rebound to it and the settlement received the
		// token instead of a stale rejection.
		expect(rebindCalls).toBe(1);
		expect(settledOptions).toEqual([{ scope: "turn", steeringSnapshotToken: 42 }]);
		expect(transport.sent.find(frame => frame.id === "owner-race-abort")).toMatchObject({
			ok: true,
			result: expect.objectContaining({ turn: "stopped" }),
		});
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		await rm(cwd, { recursive: true, force: true });
	}
});
