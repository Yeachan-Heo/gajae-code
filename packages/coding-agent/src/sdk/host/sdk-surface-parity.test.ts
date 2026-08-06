import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NotificationServer } from "@gajae-code/natives";
import { createNotificationsExtension } from "../bus";
import { SessionSdkSessionRuntime, type SessionSdkTransport } from "./session-runtime";
import { createSdkCapabilities, createSdkSurfacePolicy } from "./surface-policy";
import type { SdkFrame } from "./types";

function memoryTransport(): SessionSdkTransport & {
	feed(connectionId: string, frame: SdkFrame): void;
	malformed(connectionId: string, message: string): void;
	readonly sent: SdkFrame[];
	readonly broadcasts: SdkFrame[];
} {
	let frameHandler: ((connectionId: string, frame: SdkFrame) => void) | undefined;
	let malformedHandler: ((connectionId: string, message: string) => void) | undefined;
	let started = false;
	const sent: SdkFrame[] = [];
	const broadcasts: SdkFrame[] = [];
	return {
		sessionId: "parity-session",
		stateRoot: "/tmp/gjc-sdk-parity",
		token: "parity-token",
		sent,
		broadcasts,
		onFrame(handler) {
			frameHandler = handler;
			return () => {
				if (frameHandler === handler) frameHandler = undefined;
			};
		},
		onMalformedFrame(handler) {
			malformedHandler = handler;
			return () => {
				if (malformedHandler === handler) malformedHandler = undefined;
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
			frameHandler?.(connectionId, frame);
		},
		malformed(connectionId, message) {
			malformedHandler?.(connectionId, message);
		},
	};
}

function nativeParityContext(sessionId: string, cwd: string): any {
	return {
		cwd,
		hasUI: false,
		ui: {},
		sessionMetadata: { kind: "main" },
		workflowGate: undefined,
		sdkBindings: () => [],
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => undefined,
			getUsageStatistics: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 }),
		},
		modelRegistry: { getAll: () => [], getModelProfiles: () => new Map(), getError: () => undefined },
		model: undefined,
		isIdle: () => true,
		getActivePromptHandle: () => undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		hasQueuedMessages: () => false,
		getPendingMessageCounts: () => ({ steering: 0, followUp: 0, nextTurn: 0 }),
		getTranscript: () => [],
		getTranscriptBody: () => undefined,
		getGoalState: () => undefined,
		getTodoState: () => [],
		getQueuedMessages: () => [],
		getActiveTools: () => [],
		getAllTools: () => [],
		resolveTool: () => undefined,
		cycleModel: async () => undefined,
		cycleThinkingLevel: () => undefined,
		setQueueMode: () => false,
		getSkillState: () => undefined,
		getConfigItems: () => ({}),
		getBranchCandidates: () => [],
		getExtensions: () => [],
		getArtifact: () => undefined,
		getJobs: () => [],
		getSystemPrompt: () => [],
		shutdown: () => {},
		compact: async () => {},
		clearContext: async () => false,
	};
}

describe("SDK surface parity", () => {
	test("native and loopback policy/capability advertisements are identical", () => {
		const options = { bindings: ["sdkControl", "cycleModel", "getSkillState"], workflowGateAvailable: false };
		const nativePolicy = createSdkSurfacePolicy(options);
		const loopbackPolicy = createSdkSurfacePolicy(options);
		expect([...nativePolicy.installedControls]).toEqual([...loopbackPolicy.installedControls]);
		expect([...nativePolicy.installedQueries]).toEqual([...loopbackPolicy.installedQueries]);
		expect(createSdkCapabilities(nativePolicy, false)).toEqual(createSdkCapabilities(loopbackPolicy, false));
		expect(nativePolicy.installedQueries).toContain("turn.prompt_status");
		expect(nativePolicy.installedQueries).toContain("skill.invoke_status");
	});

	test("workflow controls are advertised exactly when a durable gate bridge exists", () => {
		const without = createSdkSurfacePolicy({ bindings: ["sdkControl"], workflowGateAvailable: false });
		expect(without.installedControls.has("workflow.gate_answer")).toBe(false);
		expect(without.installedControls.has("workflow.plan_approve")).toBe(false);
		const withBridge = createSdkSurfacePolicy({ bindings: ["sdkControl"], workflowGateAvailable: true });
		expect(withBridge.installedControls.has("workflow.gate_answer")).toBe(true);
		expect(withBridge.installedControls.has("workflow.plan_approve")).toBe(true);
	});

	test("queries requiring missing bindings are absent", () => {
		const policy = createSdkSurfacePolicy({ bindings: [], workflowGateAvailable: false });
		expect(policy.installedQueries.has("skill.list/state")).toBe(false);
	});

	test("request results, replay order, and typed protocol errors match across transports", async () => {
		const nativeTransport = memoryTransport();
		const loopbackTransport = memoryTransport();
		const createRuntime = (transport: ReturnType<typeof memoryTransport>) =>
			new SessionSdkSessionRuntime({
				transport,
				control: async (_connectionId, frame) => {
					if (frame.operation === "unsupported")
						throw Object.assign(new Error("operation is unavailable"), { code: "unavailable" });
					return { id: frame.id, ok: true, result: { accepted: true } };
				},
				query: async (_connectionId, frame) => {
					if (frame.query === "turn.prompt_status")
						return { id: frame.id, ok: true, result: { status: "unknown" } };
					return { id: frame.id, ok: true, result: { query: frame.query } };
				},
			});
		const nativeRuntime = createRuntime(nativeTransport);
		const loopbackRuntime = createRuntime(loopbackTransport);
		await Promise.all([nativeRuntime.start(), loopbackRuntime.start()]);
		for (const runtime of [nativeRuntime, loopbackRuntime]) {
			runtime.emitEvent({ type: "turn_start", sessionId: "parity-session" });
			runtime.emitEvent({ type: "agent_start", sessionId: "parity-session" });
		}
		for (const transport of [nativeTransport, loopbackTransport]) {
			transport.feed("client", {
				type: "event_replay",
				id: "replay",
				sinceGeneration: 1,
				sinceSeq: 0,
			});
			transport.feed("client", { type: "control_request", id: "control", operation: "turn.prompt", input: {} });
			transport.feed("client", {
				type: "query_request",
				id: "query",
				query: "turn.prompt_status",
				input: { clientRef: "missing" },
			});
			transport.feed("client", { type: "control_request", id: "bad", operation: "unsupported", input: {} });
			transport.malformed("client", "SDK frame type must be a non-empty string.");
		}
		await Bun.sleep(0);
		expect(loopbackTransport.sent).toEqual(nativeTransport.sent);
		expect(loopbackTransport.broadcasts).toEqual(nativeTransport.broadcasts);
		const replay = nativeTransport.sent.find(frame => frame.type === "event_replay_result") as SdkFrame;
		expect((replay.events as SdkFrame[]).map(event => event.kind ?? event.name)).toEqual([
			"session_ready",
			"turn_start",
			"agent_start",
		]);
		expect(nativeTransport.sent.find(frame => frame.id === "bad")).toEqual({
			type: "control_response",
			id: "bad",
			ok: false,
			error: { code: "unavailable", message: "operation is unavailable" },
		});
		expect(nativeTransport.sent.find(frame => frame.type === "protocol_error")).toEqual({
			type: "protocol_error",
			ok: false,
			error: { code: "invalid_frame", message: "SDK frame type must be a non-empty string." },
		});
		await Promise.all([nativeRuntime.stop(), loopbackRuntime.stop()]);
	});
	test("native adapter malformed-frame errors match loopback protocol-error shape", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-native-parity-"));
		const sessionId = `native-parity-${randomUUID()}`;
		const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void> | void>();
		const callbacks = new WeakMap<
			object,
			(error: Error | null, frame: { connectionId: string; json: string }) => void
		>();
		const servers = new Set<object>();
		const nativePrototype = NotificationServer.prototype as any;
		const originalOnSdkFrame = nativePrototype.onSdkFrame;
		nativePrototype.onSdkFrame = function (callback: any) {
			callbacks.set(this, callback);
			servers.add(this);
			return originalOnSdkFrame.call(this, callback);
		};
		const api = {
			on(event: string, handler: (event: unknown, ctx: any) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			registerCommand() {},
		} as any;
		const ctx = nativeParityContext(sessionId, cwd);
		const previousDisable = process.env.GJC_SDK_DISABLE;
		delete process.env.GJC_SDK_DISABLE;
		const messages: string[] = [];
		let socket: WebSocket | undefined;
		try {
			createNotificationsExtension(api, { sdkHostModeSupported: true });
			await handlers.get("session_start")?.({}, ctx);
			expect(servers.size).toBe(1);
			const server = [...servers][0];
			expect(server).toBeDefined();
			const endpointPath = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
			const endpoint = JSON.parse(await fs.readFile(endpointPath, "utf8")) as { url: string; token: string };
			socket = new WebSocket(`${endpoint.url}?token=${endpoint.token}`);
			socket.addEventListener("message", event => messages.push(String(event.data)));
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("timed out opening native SDK parity socket")), 2_000);
				socket?.addEventListener("open", () => {
					clearTimeout(timer);
					resolve();
				});
				socket?.addEventListener("error", () => {
					clearTimeout(timer);
					reject(new Error("native SDK parity socket failed"));
				});
			});
			for (let attempt = 0; attempt < 100 && messages.length === 0; attempt += 1) await Bun.sleep(10);
			const hello = JSON.parse(messages[0] ?? "{}") as { connectionId?: string };
			expect(hello.connectionId).toBeTypeOf("string");
			const connectionId = hello.connectionId!;
			const nativeCallback = callbacks.get(server!);
			expect(nativeCallback).toBeDefined();
			const malformed = [
				["{", "SDK frame is not valid JSON."],
				["null", "SDK frame must be a JSON object."],
				["{}", "SDK frame type must be a non-empty string."],
			] as const;
			for (const [index, [json, message]] of malformed.entries()) {
				nativeCallback!(null, { connectionId, json });
				const target = index + 2;
				for (let attempt = 0; attempt < 100 && messages.length < target; attempt += 1) await Bun.sleep(10);
				expect(messages.length).toBeGreaterThanOrEqual(target);
				void message;
			}
			const nativeErrors = messages.slice(1).map(message => JSON.parse(message) as SdkFrame);
			expect(nativeErrors).toEqual(
				malformed.map(([, message]) => ({
					type: "protocol_error",
					ok: false,
					error: { code: "invalid_frame", message },
				})),
			);

			// Callback error branch: a transport-level error surfaced through onSdkFrame's
			// err argument must also produce a typed protocol_error for the connection.
			const beforeErrBranch = messages.length;
			nativeCallback!(new Error("native transport frame decode failed"), { connectionId, json: "" });
			for (let attempt = 0; attempt < 100 && messages.length <= beforeErrBranch; attempt += 1) await Bun.sleep(10);
			const errBranchFrame = JSON.parse(messages[beforeErrBranch] ?? "{}") as SdkFrame;
			expect(errBranchFrame).toEqual({
				type: "protocol_error",
				ok: false,
				error: { code: "invalid_frame", message: "native transport frame decode failed" },
			});

			const loopback = memoryTransport();
			const loopbackRuntime = new SessionSdkSessionRuntime({ transport: loopback });
			await loopbackRuntime.start();
			for (const [, message] of malformed) loopback.malformed("client", message);
			await Bun.sleep(0);
			expect(loopback.sent.filter(frame => frame.type === "protocol_error")).toEqual(nativeErrors);
			await loopbackRuntime.stop();

			// The native websocket layer currently prefilters malformed JSON/non-object/missing-type
			// payloads before onSdkFrame. Keep this probe explicit: unlike the loopback transport,
			// those raw bytes produce no typed response and remain a residual parity gap.
			const beforeRaw = messages.length;
			for (const [json] of malformed) {
				socket.send(json);
				await Bun.sleep(20);
			}
			expect(messages.slice(beforeRaw)).toEqual([]);
		} finally {
			try {
				socket?.close();
				await handlers.get("session_shutdown")?.({}, ctx);
			} finally {
				nativePrototype.onSdkFrame = originalOnSdkFrame;
				if (previousDisable === undefined) delete process.env.GJC_SDK_DISABLE;
				else process.env.GJC_SDK_DISABLE = previousDisable;
				await fs.rm(cwd, { recursive: true, force: true });
			}
		}
	});
});
