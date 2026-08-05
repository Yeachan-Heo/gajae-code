import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SdkTransportLifecycleError } from "./websocket-transport";
import { createSdkSessionRuntimeExtension, SessionSdkSessionRuntime, type SessionSdkTransport } from "./session-runtime";
import { createSdkCapabilities, createSdkSurfacePolicy } from "./surface-policy";
import type { SdkFrame } from "./types";

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
							throw new SdkTransportLifecycleError("endpoint_remove_failed", "injected endpoint removal failure");
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
