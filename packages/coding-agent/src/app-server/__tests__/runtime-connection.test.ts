import { expect, test } from "bun:test";
import { createAppServerRuntime } from "../create-app-server";
import type { ChildCreateResult, SessionClient } from "../thread-runtime/child-bridge";
import { DEFAULT_OUTBOUND_QUEUE_CAPACITY } from "../transport/connection";

const enc = (value: string) => new TextEncoder().encode(value);
const dec = (value: Uint8Array) => JSON.parse(new TextDecoder().decode(value)) as Record<string, unknown>;
const itemStarted = (id: string, startedAtMs = 0) => ({
	item: { content: [], id, type: "userMessage" },
	startedAtMs,
	threadId: "thread-a",
	turnId: "turn-a",
});

const effectiveSettings = (sessionId: string, cwd: string) => ({
	model: "requested-model",
	modelProvider: "openai",
	serviceTier: null,
	cwd,
	instructionSources: [],
	approvalPolicy: "untrusted",
	approvalsReviewer: "user",
	sandbox: { type: "dangerFullAccess" },
	reasoningEffort: null,
	thread: {
		id: sessionId,
		sessionId,
		forkedFromId: null,
		parentThreadId: null,
		preview: "preview",
		ephemeral: false,
		isPinned: false,
		modelProvider: "openai",
		createdAt: 0,
		updatedAt: 0,
		recencyAt: null,
		status: { type: "idle" },
		path: null,
		cwd,
		cliVersion: "1",
		source: "cli",
		threadSource: null,
		agentNickname: null,
		agentRole: null,
		gitInfo: null,
		name: null,
		turns: [],
	},
});

type ChildFrameHandler = (frame: Record<string, unknown>) => void;

interface InjectedChild {
	readonly child: ChildCreateResult;
	emitFrame(frame: Record<string, unknown>): void;
}

function injectedChild(sessionId: string): InjectedChild {
	let frameHandler: ChildFrameHandler = () => {};
	let revision = 0;
	const client: SessionClient = {
		onFrame: handler => {
			frameHandler = handler;
			return () => {};
		},
		onReconnect: _handler => () => {},
		onReconnectFailed: _handler => () => {},
		request: async () => ({}),
		query: async () => ({}),
		control: async operation => {
			if (operation === "turn.prompt") return { accepted: true, commandId: "child-command", turnId: "child-turn" };
			if (operation === "projection.append") return { revision: ++revision };
			return {};
		},
		close: async () => {},
	};
	return {
		child: {
			sessionId,
			cwd: "/tmp",
			authority: {
				endpointGeneration: 1,
				endpointIncarnation: "a".repeat(64),
				endpointMtimeMs: 1,
				pid: 1234,
			},
			client,
			awaitReady: async () => {},
			closeChild: async () => {},
			effectiveSettings: effectiveSettings(sessionId, "/tmp"),
		},
		emitFrame: frame => frameHandler(frame),
	};
}

const lifecycleFrame = (type: "agent_start" | "agent_end"): Record<string, unknown> => ({
	type,
	commandId: "child-command",
	turnId: "child-turn",
	...(type === "agent_end" ? { messages: [], stopReason: "completed" } : {}),
});

async function initialize(connection: { process(line: Uint8Array): Promise<void> }): Promise<void> {
	await connection.process(
		enc('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}'),
	);
	await connection.process(enc('{"method":"initialized"}'));
}

test("runtime connection: response is published before a handler notification", async () => {
	const frames: Uint8Array[] = [];
	const runtime = createAppServerRuntime();
	runtime.registry.register("fs/readFile", (_params, context) => {
		context?.broadcastThread?.("thread-a", "item/started", itemStarted("item-a"));
		return { ok: true, result: { dataBase64: "" } };
	});
	const connection = runtime.createConnection(frame => {
		frames.push(frame);
	});
	await initialize(connection);
	frames.length = 0;
	runtime.subscriptions.subscribe(connection.id, "thread-a");
	await connection.process(enc('{"id":3,"method":"fs/readFile","params":{"path":"/tmp/test"}}'));
	await Bun.sleep(0);

	expect(dec(frames.at(-2)!)).toMatchObject({ id: 3, result: { dataBase64: "" } });
	expect(dec(frames.at(-1)!)).toEqual({ method: "item/started", params: itemStarted("item-a") });
});

test("runtime connection: invalid client response does not settle an approval, but a valid response does", async () => {
	const runtime = createAppServerRuntime();
	const connection = runtime.createConnection(() => {});
	const request = runtime.broker.create("server-1", "execCommandApproval", {}, "thread-a", new Set([connection.id]));
	expect(request).toBeDefined();

	await connection.process(enc('{"id":"server-1","result":{"decision":"invalid"}}'));
	expect(runtime.broker.pendingCount).toBe(1);

	await connection.process(enc('{"id":"server-1","result":{"decision":"approved"}}'));
	expect(runtime.broker.pendingCount).toBe(0);
});

test("runtime connection: a valid client error response settles an approval as an error", async () => {
	const runtime = createAppServerRuntime();
	const connection = runtime.createConnection(() => {});
	const request = runtime.broker.create("server-1", "execCommandApproval", {}, "thread-a", new Set([connection.id]));
	expect(request).toBeDefined();

	await connection.process(enc('{"id":"server-1","error":{"code":-32603,"message":"Internal error"}}'));
	expect(runtime.broker.pendingCount).toBe(0);
	expect(request).toMatchObject({
		status: "resolved",
		outcome: "error",
		error: { code: -32603, message: "Internal error" },
	});
});

test("runtime connection: client responses carrying both or neither result and error do not settle an approval", async () => {
	const runtime = createAppServerRuntime();
	const connection = runtime.createConnection(() => {});
	runtime.broker.create("server-1", "execCommandApproval", {}, "thread-a", new Set([connection.id]));

	for (const frame of [
		'{"id":"server-1"}',
		'{"id":"server-1","result":{"decision":"approved"},"error":{"code":-32603,"message":"Internal error"}}',
	]) {
		await connection.process(enc(frame));
		expect(runtime.broker.pendingCount).toBe(1);
	}
});

test("runtime connection: outbound notification validation drops invalid params and emits valid params", async () => {
	const frames: Uint8Array[] = [];
	const runtime = createAppServerRuntime();
	const source = runtime.createConnection(() => {});
	const target = runtime.createConnection(frame => {
		frames.push(frame);
	});
	await initialize(source);
	await target.process(
		enc(
			'{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"},"capabilities":{"experimentalApi":true}}}',
		),
	);
	await target.process(enc('{"method":"initialized"}'));
	frames.length = 0;
	runtime.subscriptions.subscribe(target.id, "thread-a");
	runtime.registry.register("fs/readFile", (_params, context) => {
		context?.emitTo?.(target.id, "process/exited", { exitCode: "0" });
		context?.broadcastThread?.("thread-a", "process/exited", { exitCode: "0" });
		context?.emitTo?.(target.id, "process/exited", {
			exitCode: 0,
			processHandle: "p",
			stderr: "",
			stderrCapReached: false,
			stdout: "",
			stdoutCapReached: false,
		});
		return { ok: true, result: { dataBase64: "" } };
	});
	await source.process(enc('{"id":2,"method":"fs/readFile","params":{"path":"/tmp/test"}}'));
	await Bun.sleep(0);

	expect(frames.map(dec)).toContainEqual({
		method: "process/exited",
		params: {
			exitCode: 0,
			processHandle: "p",
			stderr: "",
			stderrCapReached: false,
			stdout: "",
			stdoutCapReached: false,
		},
	});
	expect(frames.map(dec)).not.toContainEqual({ method: "process/exited", params: { exitCode: "0" } });
});

test("runtime connection: outbound server-request validation drops invalid params and sends valid params", async () => {
	const frames: Uint8Array[] = [];
	const runtime = createAppServerRuntime();
	const source = runtime.createConnection(() => {});
	const target = runtime.createConnection(frame => {
		frames.push(frame);
	});
	await initialize(source);
	await initialize(target);
	runtime.subscriptions.subscribe(target.id, "thread-a");
	frames.length = 0;
	runtime.registry.register("fs/readFile", (_params, context) => {
		expect(
			context?.requestClient?.("thread-a", "applyPatchApproval", {
				callId: "call",
				conversationId: "thread",
				fileChanges: { "a.ts": { type: "add", content: 1 } },
			}),
		).toBeUndefined();
		return { ok: true, result: { dataBase64: "" } };
	});
	await source.process(enc('{"id":2,"method":"fs/readFile","params":{"path":"/tmp/test"}}'));
	await Bun.sleep(0);
	expect(runtime.broker.pendingCount).toBe(0);
	expect(frames.map(dec)).not.toContainEqual(expect.objectContaining({ method: "applyPatchApproval" }));

	runtime.registry.register("fs/readFile", (_params, context) => {
		expect(
			context?.requestClient?.("thread-a", "applyPatchApproval", {
				callId: "call",
				conversationId: "thread",
				fileChanges: { "a.ts": { type: "add", content: "text" } },
			}),
		).toBe("server-1");
		return { ok: true, result: { dataBase64: "" } };
	});
	await source.process(enc('{"id":3,"method":"fs/readFile","params":{"path":"/tmp/test"}}'));
	await Bun.sleep(0);
	expect(runtime.broker.pendingCount).toBe(1);
	expect(frames.map(dec)).toContainEqual({
		id: "server-1",
		method: "applyPatchApproval",
		params: { callId: "call", conversationId: "thread", fileChanges: { "a.ts": { type: "add", content: "text" } } },
	});
});

test("runtime connection: close removes subscriptions and approval eligibility", async () => {
	const runtime = createAppServerRuntime();
	const connection = runtime.createConnection(() => {});
	await initialize(connection);
	runtime.subscriptions.subscribe(connection.id, "thread-a");
	runtime.broker.create("server-1", "execCommandApproval", {}, "thread-a", new Set([connection.id]));

	await connection.close();
	expect(runtime.subscriptions.isSubscribed(connection.id, "thread-a")).toBe(false);
	expect(runtime.broker.pendingCount).toBe(0);
});

test("runtime connection: writer rejection rejects the request that produced the frame", async () => {
	const runtime = createAppServerRuntime();
	let failWriter = false;
	const connection = runtime.createConnection(async () => {
		if (failWriter) throw new Error("writer failed");
	});
	await initialize(connection);
	failWriter = true;
	await expect(
		connection.process(enc('{"id":2,"method":"fs/readFile","params":{"path":"/tmp/test"}}')),
	).rejects.toThrow("writer failed");
	await expect(connection.close()).rejects.toThrow("writer failed");
});

test("runtime connection: close fences an in-flight handler before shared cleanup", async () => {
	let releaseHandler: (() => void) | undefined;
	const handlerStarted = Promise.withResolvers<void>();
	const runtime = createAppServerRuntime();
	const connection = runtime.createConnection(() => {});
	await connection.process(
		enc('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}'),
	);
	await connection.process(enc('{"method":"initialized"}'));
	runtime.subscriptions.subscribe(connection.id, "thread-a");
	runtime.registry.register("fs/readFile", async (_params, context) => {
		handlerStarted.resolve();
		await new Promise<void>(resolve => {
			releaseHandler = resolve;
		});
		context?.subscribe?.("thread-b");
		context?.requestClient?.("thread-a", "execCommandApproval", {});
		return { ok: true, result: {} };
	});
	const processing = connection.process(enc('{"id":3,"method":"fs/readFile","params":{"path":"/tmp/test"}}'));
	await handlerStarted.promise;
	let closed = false;
	const closing = connection.close().then(() => {
		closed = true;
	});
	await Bun.sleep(0);
	expect(closed).toBe(false);
	expect(runtime.subscriptions.isSubscribed(connection.id, "thread-a")).toBe(false);
	releaseHandler!();
	await processing;
	await closing;
	expect(runtime.subscriptions.isSubscribed(connection.id, "thread-b")).toBe(false);
	expect(runtime.broker.pendingCount).toBe(0);
});

test("runtime connection: filters experimental thread notifications per receiving connection", async () => {
	const stableFrames: Uint8Array[] = [];
	const experimentalFrames: Uint8Array[] = [];
	const runtime = createAppServerRuntime();
	const source = runtime.createConnection(() => {});
	const stable = runtime.createConnection(frame => {
		stableFrames.push(frame);
	});
	const experimental = runtime.createConnection(frame => {
		experimentalFrames.push(frame);
	});
	await initialize(source);
	await initialize(stable);
	await experimental.process(
		enc(
			'{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"},"capabilities":{"experimentalApi":true}}}',
		),
	);
	await experimental.process(enc('{"method":"initialized"}'));
	runtime.subscriptions.subscribe(stable.id, "thread-a");
	runtime.subscriptions.subscribe(experimental.id, "thread-a");
	runtime.registry.register("fs/readFile", (_params, context) => {
		context?.broadcastThread?.("thread-a", "process/exited", {
			exitCode: 0,
			processHandle: "p",
			stderr: "",
			stderrCapReached: false,
			stdout: "",
			stdoutCapReached: false,
		});
		return { ok: true, result: {} };
	});
	await source.process(enc('{"id":2,"method":"fs/readFile","params":{"path":"/tmp/test"}}'));
	await Bun.sleep(0);
	expect(stableFrames.map(dec)).not.toContainEqual(expect.objectContaining({ method: "process/exited" }));
	expect(experimentalFrames.map(dec)).toContainEqual({
		method: "process/exited",
		params: {
			exitCode: 0,
			processHandle: "p",
			stderr: "",
			stderrCapReached: false,
			stdout: "",
			stdoutCapReached: false,
		},
	});
});

test("runtime connection: slow writer backpressures the 256-frame queue without dropping or reordering notifications", async () => {
	const frames: Uint8Array[] = [];
	let blockWriter = false;
	let unblockWriter: (() => void) | undefined;
	let sequence = 0;
	const runtime = createAppServerRuntime();
	runtime.registry.register("fs/readFile", (_params, context) => {
		context?.broadcastThread?.("thread-a", "item/started", itemStarted(`item-${sequence}`, sequence++));
		return { ok: true, result: { ok: true } };
	});
	const connection = runtime.createConnection(async frame => {
		if (blockWriter)
			await new Promise<void>(resolve => {
				unblockWriter = resolve;
			});
		frames.push(frame);
	});
	await initialize(connection);
	runtime.subscriptions.subscribe(connection.id, "thread-a");
	await Bun.sleep(0);
	frames.length = 0;
	blockWriter = true;

	const requests = Array.from({ length: 130 }, (_, index) =>
		connection.process(enc(`{"id":${index + 3},"method":"fs/readFile","params":{"path":"/tmp/test"}}`)),
	);
	let allProcessed = false;
	void Promise.all(requests).then(() => {
		allProcessed = true;
	});
	await Bun.sleep(0);

	// 130 requests emit 260 frames (a response and sequenced notification each), exceeding the 256-frame bound.
	expect(allProcessed).toBe(false);
	blockWriter = false;
	unblockWriter!();
	await Promise.all(requests);
	await Bun.sleep(0);

	const notifications = frames.map(dec).filter(frame => frame.method === "item/started");
	expect(notifications).toHaveLength(130);
	expect(notifications.map(frame => (frame.params as { startedAtMs: number }).startedAtMs)).toEqual(
		Array.from({ length: 130 }, (_, index) => index),
	);
});

test("runtime connection: production runtime constructor broadcasts thread events only to subscribed connections", async () => {
	const framesA: Uint8Array[] = [];
	const framesB: Uint8Array[] = [];
	const framesC: Uint8Array[] = [];
	// This is the production construction path used by commands/app-server.ts before each ws open handler.
	const runtime = createAppServerRuntime();
	const connectionA = runtime.createConnection(frame => {
		framesA.push(frame);
	}, "websocket");
	const connectionB = runtime.createConnection(frame => {
		framesB.push(frame);
	}, "websocket");
	const connectionC = runtime.createConnection(frame => {
		framesC.push(frame);
	}, "websocket");
	runtime.registry.register("fs/readFile", (_params, context) => {
		context?.broadcastThread?.("thread-a", "item/started", itemStarted("connection-a"));
		return { ok: true, result: { ok: true } };
	});

	await initialize(connectionA);
	await initialize(connectionB);
	await initialize(connectionC);
	runtime.subscriptions.subscribe(connectionB.id, "thread-a");
	await Bun.sleep(0);
	framesA.length = 0;
	framesB.length = 0;
	framesC.length = 0;

	await connectionA.process(enc('{"id":2,"method":"fs/readFile","params":{"path":"/tmp/test"}}'));
	await Bun.sleep(0);

	expect(framesB.map(dec)).toContainEqual({ method: "item/started", params: itemStarted("connection-a") });
	expect(framesC.map(dec)).not.toContainEqual({ method: "item/started", params: itemStarted("connection-a") });
});

test("runtime connection: a rejected frame closes the connection instead of silently continuing", async () => {
	const runtime = createAppServerRuntime();
	const frames: Uint8Array[] = [];
	const connection = runtime.createConnection(frame => {
		frames.push(frame);
	}, "websocket");

	// Malformed JSON must stay silent on the wire (locked constraint) but must NOT leave the
	// connection open and indistinguishable from a handled frame.
	await connection.process(enc("{ this is not json"));
	await Bun.sleep(0);
	expect(frames.length).toBe(0);

	// A well-formed request after the rejection must be ignored, proving the connection closed
	// rather than merely dropping the bad frame.
	await connection.process(
		enc('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"t","version":"1.0.0"}}}'),
	);
	await Bun.sleep(0);
	expect(frames.length).toBe(0);
});

test("runtime connection: an illegal request id is reported as null, never echoed", async () => {
	// JSON-RPC requires a null id when the request id could not be parsed. Echoing the raw
	// value would put the same illegal id back on the wire.
	for (const raw of [
		'{"id":-0,"method":"initialize","params":{"clientInfo":{"name":"t","version":"1"}}}',
		'{"id":1.5,"method":"initialize","params":{"clientInfo":{"name":"t","version":"1"}}}',
		'{"id":9007199254740993,"method":"initialize","params":{"clientInfo":{"name":"t","version":"1"}}}',
	]) {
		const runtime = createAppServerRuntime();
		const frames: Uint8Array[] = [];
		const connection = runtime.createConnection(frame => {
			frames.push(frame);
		}, "websocket");
		await connection.process(enc(raw));
		await Bun.sleep(0);
		const response = dec(frames[0]!) as { id: unknown; error: { code: number } };
		expect(response.id).toBeNull();
		expect(response.error.code).toBe(-32600);
	}

	// A legal integer id is still echoed.
	const runtime = createAppServerRuntime();
	const frames: Uint8Array[] = [];
	const connection = runtime.createConnection(frame => {
		frames.push(frame);
	}, "websocket");
	await connection.process(enc('{"id":7,"method":"initialize","params":{"clientInfo":{"name":"t","version":"1"}}}'));
	await Bun.sleep(0);
	expect((dec(frames[0]!) as { id: unknown }).id).toBe(7);
});

test("runtime connection: production assembly forwards thread/start to the injected transaction adapter", async () => {
	let createCalls = 0;
	const runtime = createAppServerRuntime({}, undefined, {
		threadStartAdapter: {
			create: async () => {
				createCalls += 1;
				throw new Error("injected create failed");
			},
		},
	});
	const frames: Uint8Array[] = [];
	const connection = runtime.createConnection(frame => {
		frames.push(frame);
	});
	await initialize(connection);
	frames.length = 0;

	await connection.process(
		enc(
			'{"id":2,"method":"thread/start","params":{"cwd":"/tmp","allowProviderModelFallback":false,"experimentalRawEvents":false}}',
		),
	);
	await Bun.sleep(0);

	expect(createCalls).toBe(1);
	expect(dec(frames[0]!)).toMatchObject({ id: 2, error: { code: -32603 } });
	expect(runtime.manager.loadedCount).toBe(0);
	expect(runtime.manager.pendingCount).toBe(0);
});

test("runtime connection: injected child frames reach the caller hook and shared turn controller once", async () => {
	const sessionId = "runtime-turn-hook-session";
	const child = injectedChild(sessionId);
	let callerFrameCount = 0;
	const runtime = createAppServerRuntime({}, undefined, {
		threadStartAdapter: {
			create: async () => child.child,
			onFrame: (_child, frame) => {
				callerFrameCount += 1;
				expect(frame).toEqual(lifecycleFrame("agent_end"));
			},
		},
	});
	const frames: Uint8Array[] = [];
	const connection = runtime.createConnection(frame => {
		frames.push(frame);
	});
	await initialize(connection);
	await connection.process(
		enc(
			'{"id":2,"method":"thread/start","params":{"cwd":"/tmp","allowProviderModelFallback":false,"experimentalRawEvents":false}}',
		),
	);
	frames.length = 0;
	await connection.process(
		enc(
			'{"id":3,"method":"turn/start","params":{"threadId":"runtime-turn-hook-session","input":[{"type":"text","text":"hello","text_elements":[]}]}}',
		),
	);
	child.emitFrame(lifecycleFrame("agent_end"));
	await Bun.sleep(0);
	await Bun.sleep(0);

	const methods = frames
		.map(dec)
		.filter(frame => typeof frame.method === "string")
		.map(frame => frame.method);
	expect(callerFrameCount).toBe(1);
	expect(methods.filter(method => method === "turn/completed")).toHaveLength(1);
	expect(runtime.turnController.activeTurnCount).toBe(0);
});

test("runtime connection: turn notifications wait behind a blocked turn/start response", async () => {
	const sessionId = "runtime-turn-order-session";
	const child = injectedChild(sessionId);
	const frames: Uint8Array[] = [];
	const writerEntered = Promise.withResolvers<void>();
	const releaseWriter = Promise.withResolvers<void>();
	let blockWriter = false;
	const runtime = createAppServerRuntime({}, undefined, {
		threadStartAdapter: { create: async () => child.child },
	});
	const connection = runtime.createConnection(async frame => {
		if (blockWriter) {
			writerEntered.resolve();
			await releaseWriter.promise;
		}
		frames.push(frame);
	});
	await initialize(connection);
	await connection.process(
		enc(
			'{"id":2,"method":"thread/start","params":{"cwd":"/tmp","allowProviderModelFallback":false,"experimentalRawEvents":false}}',
		),
	);
	frames.length = 0;
	blockWriter = true;
	const processing = connection.process(
		enc(
			'{"id":3,"method":"turn/start","params":{"threadId":"runtime-turn-order-session","input":[{"type":"text","text":"hello","text_elements":[]}]}}',
		),
	);
	await writerEntered.promise;
	child.emitFrame(lifecycleFrame("agent_end"));
	expect(frames.map(dec)).not.toContainEqual(expect.objectContaining({ method: "turn/started" }));
	blockWriter = false;
	releaseWriter.resolve();
	await processing;

	const decoded = frames.map(dec);
	const responseIndex = decoded.findIndex(frame => frame.id === 3);
	const startedIndex = decoded.findIndex(frame => frame.method === "turn/started");
	expect(responseIndex).toBeGreaterThanOrEqual(0);
	expect(startedIndex).toBeGreaterThan(responseIndex);
});

test("runtime connection: shared turn notifications fan out to subscribers and survive requester close", async () => {
	const sessionId = "runtime-turn-fanout-session";
	const child = injectedChild(sessionId);
	const requesterFrames: Uint8Array[] = [];
	const observerFrames: Uint8Array[] = [];
	const runtime = createAppServerRuntime({}, undefined, {
		threadStartAdapter: { create: async () => child.child },
	});
	const requester = runtime.createConnection(frame => {
		requesterFrames.push(frame);
	});
	const observer = runtime.createConnection(frame => {
		observerFrames.push(frame);
	});
	await initialize(requester);
	await initialize(observer);
	await requester.process(
		enc(
			'{"id":2,"method":"thread/start","params":{"cwd":"/tmp","allowProviderModelFallback":false,"experimentalRawEvents":false}}',
		),
	);
	runtime.subscriptions.subscribe(observer.id, sessionId);
	requesterFrames.length = 0;
	observerFrames.length = 0;
	await requester.process(
		enc(
			'{"id":3,"method":"turn/start","params":{"threadId":"runtime-turn-fanout-session","input":[{"type":"text","text":"hello","text_elements":[]}]}}',
		),
	);

	expect(requesterFrames.map(dec).filter(frame => frame.method === "turn/started")).toHaveLength(1);
	expect(observerFrames.map(dec).filter(frame => frame.method === "turn/started")).toHaveLength(1);
	await requester.close();
	child.emitFrame(lifecycleFrame("agent_end"));
	await Bun.sleep(0);
	await Bun.sleep(0);

	expect(requesterFrames.map(dec).filter(frame => frame.method === "turn/completed")).toHaveLength(0);
	expect(observerFrames.map(dec).filter(frame => frame.method === "turn/completed")).toHaveLength(1);
});

test("runtime connection: response delivery hook runs after the response writer accepts the frame", async () => {
	const sessionId = "runtime-turn-delivery-session";
	const child = injectedChild(sessionId);
	const events: string[] = [];
	const runtime = createAppServerRuntime({}, undefined, {
		threadStartAdapter: { create: async () => child.child },
	});
	const connection = runtime.createConnection(frame => {
		const message = dec(frame);
		if (message.id === 3) events.push("response-written");
		if (message.method === "turn/started") events.push("turn-started");
	});
	await initialize(connection);
	await connection.process(
		enc(
			'{"id":2,"method":"thread/start","params":{"cwd":"/tmp","allowProviderModelFallback":false,"experimentalRawEvents":false}}',
		),
	);
	await connection.process(
		enc(
			'{"id":3,"method":"turn/start","params":{"threadId":"runtime-turn-delivery-session","input":[{"type":"text","text":"hello","text_elements":[]}]}}',
		),
	);

	expect(events).toEqual(["response-written", "turn-started"]);
});

test("runtime connection: requester close during thread/start readiness rolls back the published runtime", async () => {
	const readyEntered = Promise.withResolvers<void>();
	const releaseReady = Promise.withResolvers<void>();
	let clientClose = 0;
	let childClose = 0;
	let observerClose = 0;
	let reverseLeaseClose = 0;
	const sessionId = "runtime-connection-session";
	const cwd = "/tmp";
	const client = {
		onFrame: () => () => {
			observerClose += 1;
		},
		onReconnect: () => () => {
			observerClose += 1;
		},
		onReconnectFailed: () => () => {
			observerClose += 1;
		},
		request: async () => ({}),
		query: async () => ({}),
		control: async () => ({}),
		close: async () => {
			clientClose += 1;
		},
	};
	const runtime = createAppServerRuntime({}, undefined, {
		threadStartAdapter: {
			create: async () => ({
				sessionId,
				cwd,
				authority: {
					endpointGeneration: 1,
					endpointIncarnation: "c".repeat(64),
					endpointMtimeMs: 1,
					pid: 1234,
				},
				client,
				awaitReady: async () => {
					readyEntered.resolve();
					await releaseReady.promise;
				},
				closeChild: async () => {
					childClose += 1;
				},
				effectiveSettings: effectiveSettings(sessionId, cwd),
			}),
			attachReverseLeaseController: async () => ({
				close: async () => {
					reverseLeaseClose += 1;
				},
			}),
		},
	});
	const frames: Uint8Array[] = [];
	const connection = runtime.createConnection(frame => {
		frames.push(frame);
	});
	await initialize(connection);
	frames.length = 0;

	const processing = connection.process(
		enc(
			'{"id":2,"method":"thread/start","params":{"cwd":"/tmp","allowProviderModelFallback":false,"experimentalRawEvents":false}}',
		),
	);
	await readyEntered.promise;
	const closing = connection.close();
	releaseReady.resolve();
	await Promise.all([processing, closing]);

	expect(frames).toHaveLength(0);
	expect(runtime.manager.loadedCount).toBe(0);
	expect(runtime.manager.pendingCount).toBe(0);
	expect(clientClose).toBe(1);
	expect(childClose).toBe(1);
	expect(observerClose).toBe(3);
	expect(reverseLeaseClose).toBe(1);
	expect(runtime.subscriptions.isSubscribed(connection.id, sessionId)).toBe(false);
});

test("runtime connection: close before thread/start subscription mutation leaves no stale subscriber", async () => {
	let clientClose = 0;
	let childClose = 0;
	let observerClose = 0;
	let reverseLeaseClose = 0;
	let closing!: Promise<void>;
	const sessionId = "runtime-connection-subscribe-session";
	const cwd = "/tmp";
	const client = {
		onFrame: () => () => {
			observerClose += 1;
		},
		onReconnect: () => () => {
			observerClose += 1;
		},
		onReconnectFailed: () => () => {
			observerClose += 1;
		},
		request: async () => ({}),
		query: async () => ({}),
		control: async () => ({}),
		close: async () => {
			clientClose += 1;
		},
	};
	const runtime = createAppServerRuntime({}, undefined, {
		threadStartAdapter: {
			create: async () => ({
				sessionId,
				cwd,
				authority: {
					endpointGeneration: 2,
					endpointIncarnation: "d".repeat(64),
					endpointMtimeMs: 1,
					pid: 1234,
				},
				client,
				awaitReady: async () => {},
				closeChild: async () => {
					childClose += 1;
				},
				effectiveSettings: effectiveSettings(sessionId, cwd),
			}),
			attachReverseLeaseController: async () => ({
				close: async () => {
					reverseLeaseClose += 1;
				},
			}),
		},
	});
	const frames: Uint8Array[] = [];
	const connection = runtime.createConnection(frame => {
		frames.push(frame);
	});
	const subscribe = runtime.subscriptions.subscribe.bind(runtime.subscriptions);
	runtime.subscriptions.subscribe = (connectionId, threadId) => {
		closing = connection.close();
		subscribe(connectionId, threadId);
	};
	await initialize(connection);
	frames.length = 0;

	const processing = connection.process(
		enc(
			'{"id":2,"method":"thread/start","params":{"cwd":"/tmp","allowProviderModelFallback":false,"experimentalRawEvents":false}}',
		),
	);
	await processing;
	await closing;

	expect(frames).toHaveLength(0);
	expect(runtime.manager.loadedCount).toBe(0);
	expect(runtime.manager.pendingCount).toBe(0);
	expect(clientClose).toBe(1);
	expect(childClose).toBe(1);
	expect(observerClose).toBe(3);
	expect(reverseLeaseClose).toBe(1);
	expect(runtime.subscriptions.isSubscribed(connection.id, sessionId)).toBe(false);
});

test("runtime connection: outbound backpressure close rolls back an undelivered thread/start", async () => {
	const writerEntered = Promise.withResolvers<void>();
	const releaseWriter = Promise.withResolvers<void>();
	let blockWriter = false;
	let clientClose = 0;
	let childClose = 0;
	let observerClose = 0;
	const sessionId = "runtime-backpressure-session";
	const cwd = "/tmp";
	const runtime = createAppServerRuntime({}, undefined, {
		threadStartAdapter: {
			create: async () => ({
				sessionId,
				cwd,
				authority: {
					endpointGeneration: 3,
					endpointIncarnation: "f".repeat(64),
					endpointMtimeMs: 1,
					pid: 1234,
				},
				client: {
					onFrame: () => () => {
						observerClose += 1;
					},
					onReconnect: () => () => {
						observerClose += 1;
					},
					onReconnectFailed: () => () => {
						observerClose += 1;
					},
					request: async () => ({}),
					query: async () => ({}),
					control: async () => ({}),
					close: async () => {
						clientClose += 1;
					},
				},
				awaitReady: async () => {},
				closeChild: async () => {
					childClose += 1;
				},
				effectiveSettings: effectiveSettings(sessionId, cwd),
			}),
		},
	});
	const frames: Uint8Array[] = [];
	const connection = runtime.createConnection(async frame => {
		if (blockWriter) {
			writerEntered.resolve();
			await releaseWriter.promise;
		}
		frames.push(frame);
	});
	const queueConnection = connection as typeof connection & {
		enqueueMessage(message: Record<string, unknown>): Promise<void>;
	};
	await initialize(connection);
	frames.length = 0;
	blockWriter = true;

	const queuedNotifications: Promise<void>[] = [];
	queuedNotifications.push(
		queueConnection.enqueueMessage({ method: "item/started", params: itemStarted("queued-0") }),
	);
	await writerEntered.promise;
	for (let index = 1; index < DEFAULT_OUTBOUND_QUEUE_CAPACITY; index += 1) {
		queuedNotifications.push(
			queueConnection.enqueueMessage({ method: "item/started", params: itemStarted(`queued-${index}`) }),
		);
	}
	const processing = connection.process(
		enc(
			'{"id":2,"method":"thread/start","params":{"cwd":"/tmp","allowProviderModelFallback":false,"experimentalRawEvents":false}}',
		),
	);
	for (let attempt = 0; attempt < 100 && runtime.manager.loadedCount === 0; attempt += 1) await Bun.sleep(1);
	expect(runtime.manager.loadedCount).toBe(1);
	expect(runtime.subscriptions.isSubscribed(connection.id, sessionId)).toBe(true);

	const closing = connection.close();
	await processing;
	expect(runtime.manager.loadedCount).toBe(0);
	expect(runtime.manager.pendingCount).toBe(0);
	expect(runtime.subscriptions.isSubscribed(connection.id, sessionId)).toBe(false);
	expect(clientClose).toBe(1);
	expect(childClose).toBe(1);
	expect(observerClose).toBe(3);

	releaseWriter.resolve();
	await Promise.all([closing, ...queuedNotifications]);
	expect(frames.some(frame => dec(frame).id === 2)).toBe(false);
});

test("runtime connection: an approval accept and a deny each settle the awaiting request on the wire", async () => {
	for (const scenario of [
		{ name: "accept", response: { decision: "approved" }, expected: "resolved" },
		{ name: "deny", response: { decision: { denied: { rejection: "not allowed" } } }, expected: "denied" },
	]) {
		const runtime = createAppServerRuntime();
		const frames: Uint8Array[] = [];
		const connection = runtime.createConnection(frame => {
			frames.push(frame);
		});
		await initialize(connection);
		runtime.subscriptions.subscribe(connection.id, "thread-a");
		frames.length = 0;

		// The handler asks the client for an approval; the broker owns the awaitable settlement.
		let requestId: string | undefined;
		runtime.registry.register("fs/readFile", (_params, context) => {
			requestId = context?.requestClient?.("thread-a", "execCommandApproval", {
				conversationId: "thread-a",
				callId: "call-1",
				approvalId: null,
				command: ["ls"],
				cwd: "/tmp",
				reason: null,
				parsedCmd: [],
			});
			return { ok: true, result: { dataBase64: "" } };
		});
		await connection.process(enc('{"id":3,"method":"fs/readFile","params":{"path":"/tmp/test"}}'));
		await Bun.sleep(0);

		expect(requestId, scenario.name).toBeDefined();
		const settled = runtime.broker.getPending(requestId!)?.settled;
		expect(settled, scenario.name).toBeDefined();
		// The approval request reached the subscribed client on the wire.
		expect(frames.map(dec), scenario.name).toContainEqual(
			expect.objectContaining({ id: requestId, method: "execCommandApproval" }),
		);

		// The client's decision travels back through the real inbound path and settles the waiter.
		await connection.process(enc(JSON.stringify({ id: requestId, result: scenario.response })));
		await expect(settled, scenario.name).resolves.toMatchObject({
			kind: scenario.expected,
			connectionId: connection.id,
		});
		expect(runtime.broker.pendingCount, scenario.name).toBe(0);
	}
});

test("runtime connection: a client that never received a request cannot settle it", async () => {
	const runtime = createAppServerRuntime();
	const frames: Uint8Array[] = [];
	const receiver = runtime.createConnection(frame => {
		frames.push(frame);
	});
	// This connection is subscribed and therefore eligible, but its writer always fails, so it never
	// actually receives the approval frame.
	let unreachableFails = false;
	const unreachable = runtime.createConnection(() => {
		if (unreachableFails) throw new Error("writer is gone");
	});
	await initialize(receiver);
	await initialize(unreachable);
	runtime.subscriptions.subscribe(receiver.id, "thread-a");
	runtime.subscriptions.subscribe(unreachable.id, "thread-a");
	frames.length = 0;
	// Only the approval publication fails for this connection, not its handshake.
	unreachableFails = true;

	let requestId: string | undefined;
	runtime.registry.register("fs/readFile", (_params, context) => {
		requestId = context?.requestClient?.("thread-a", "execCommandApproval", {
			conversationId: "thread-a",
			callId: "call-1",
			approvalId: null,
			command: ["ls"],
			cwd: "/tmp",
			reason: null,
			parsedCmd: [],
		});
		return { ok: true, result: { dataBase64: "" } };
	});
	await receiver.process(enc('{"id":3,"method":"fs/readFile","params":{"path":"/tmp/test"}}'));
	await Bun.sleep(5);

	expect(requestId).toBeDefined();
	const pending = runtime.broker.getPending(requestId!);
	expect(pending).toBeDefined();
	// The unreachable connection was dropped from the eligible set, so its answer is refused.
	expect(runtime.broker.resolve(requestId!, unreachable.id, { decision: "approved" })).toBe(false);
	// The connection that actually got the frame can still answer.
	expect(runtime.broker.resolve(requestId!, receiver.id, { decision: "approved" })).toBe(true);
	await expect(pending!.settled).resolves.toMatchObject({ kind: "resolved", connectionId: receiver.id });
});

test("runtime connection: manager shutdown settles a pending approval", async () => {
	const runtime = createAppServerRuntime();
	const connection = runtime.createConnection(() => {});
	await initialize(connection);
	runtime.subscriptions.subscribe(connection.id, "thread-a");

	let requestId: string | undefined;
	runtime.registry.register("fs/readFile", (_params, context) => {
		requestId = context?.requestClient?.("thread-a", "execCommandApproval", {
			conversationId: "thread-a",
			callId: "call-1",
			approvalId: null,
			command: ["ls"],
			cwd: "/tmp",
			reason: null,
			parsedCmd: [],
		});
		return { ok: true, result: { dataBase64: "" } };
	});
	runtime.manager.register("thread-a", "spawned", undefined, connection.id);
	await connection.process(enc('{"id":3,"method":"fs/readFile","params":{"path":"/tmp/test"}}'));
	await Bun.sleep(5);

	const settled = runtime.broker.getPending(requestId!)?.settled;
	expect(settled).toBeDefined();
	// Shutdown removes every thread, so it owes the same departing-thread guarantee as evict/remove:
	// the waiter must settle rather than hang until timeout.
	runtime.manager.shutdown();
	await expect(settled).resolves.toMatchObject({ kind: "cancelled" });
	expect(runtime.broker.pendingCount).toBe(0);
});
