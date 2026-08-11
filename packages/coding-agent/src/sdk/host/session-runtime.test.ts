import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "../../extensibility/extensions";
import { Broker } from "../broker/broker";
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

function extensionContext(sessionId: string, cwd: string): any {
	return {
		cwd,
		workflowGate: undefined,
		sdkBindings: () => [],
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => undefined,
		},
	};
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
			expect(await broker.handleRequest("session.get_endpoint", { sessionId, endpointGeneration: 1 })).toMatchObject(
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
		isIdle: () => true,
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
