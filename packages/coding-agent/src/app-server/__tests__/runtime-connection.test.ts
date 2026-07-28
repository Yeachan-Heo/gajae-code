import { expect, test } from "bun:test";
import { createAppServerRuntime } from "../create-app-server";

const enc = (value: string) => new TextEncoder().encode(value);
const dec = (value: Uint8Array) => JSON.parse(new TextDecoder().decode(value)) as Record<string, unknown>;
const itemStarted = (id: string, startedAtMs = 0) => ({
	item: { content: [], id, type: "userMessage" },
	startedAtMs,
	threadId: "thread-a",
	turnId: "turn-a",
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
