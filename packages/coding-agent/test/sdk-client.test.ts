import { afterEach, expect, test } from "bun:test";
import { SdkClient, SdkClientError } from "../src/sdk/client";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

function start(
	handler: (frame: Record<string, unknown>, socket: any) => void,
	options: { sendHello?: boolean } = {},
): {
	url: string;
	token: string;
	stop: () => Promise<void>;
} {
	const token = "sdk-client-test-token";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).searchParams.get("token") !== token)
				return new Response("Unauthorized", { status: 401 });
			if (!server.upgrade(request, { data: undefined })) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket) {
				if (options.sendHello !== false)
					socket.send(JSON.stringify({ type: "hello", connectionId: "client-test" }));
			},
			message(socket, raw) {
				handler(JSON.parse(String(raw)), socket);
			},
		},
	});
	servers.push(server);
	return { url: `ws://127.0.0.1:${server.port}`, token, stop: () => server.stop(true) };
}

test("SdkClient correlates direct v3 control/query frames and typed errors", async () => {
	const host = start((frame, socket) => {
		if (frame.operation === "bad")
			socket.send(
				JSON.stringify({
					type: "control_response",
					id: frame.id,
					ok: false,
					error: { code: "unknown_operation", message: "bad operation" },
				}),
			);
		else
			socket.send(
				JSON.stringify({
					type: frame.type === "query_request" ? "query_response" : "control_response",
					id: frame.id,
					ok: true,
					echoed: frame,
				}),
			);
	});
	const client = await SdkClient.connect(host.url, host.token);
	await expect(client.control("turn.prompt", { text: "hello" })).resolves.toMatchObject({
		ok: true,
		echoed: { operation: "turn.prompt" },
	});
	await expect(client.query("session.metadata", {}, "next")).resolves.toMatchObject({
		ok: true,
		echoed: { query: "session.metadata", cursor: "next" },
	});
	try {
		await client.control("bad");
		expect.unreachable();
	} catch (error) {
		expect(error).toBeInstanceOf(SdkClientError);
		expect((error as SdkClientError).code).toBe("unknown_operation");
	}
	await client.close();
});

test("SdkClient surfaces malformed transport frames as typed protocol errors", async () => {
	const host = start((frame, socket) => {
		if (frame.operation === "malformed") socket.send("not-json");
		else socket.send(JSON.stringify({ type: "control_command_result", id: frame.id, message: "not-json" }));
	});
	const client = await SdkClient.connect(host.url, host.token);
	await expect(client.control("malformed")).rejects.toMatchObject({ code: "protocol_error" });
	await expect(client.control("malformed_seam")).rejects.toMatchObject({ code: "protocol_error" });
	await client.close();
});

test("SdkClient reports connection_closed when a sent request loses its response", async () => {
	let accepted: Record<string, unknown> | undefined;
	const host = start((frame, socket) => {
		accepted = frame;
		socket.close(1000, "done");
	});
	const client = await SdkClient.connect(host.url, host.token, { timeoutMs: 1_000 });
	await expect(client.control("close")).rejects.toMatchObject({ code: "connection_closed" });
	expect(accepted).toMatchObject({ type: "control_request", operation: "close" });
	await client.close();
});

test("SdkClient times out and reconnects after a server restart", async () => {
	let port = 0;
	const token = "sdk-client-reconnect-token";
	const startAtPort = () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port,
			fetch(request) {
				if (new URL(request.url).searchParams.get("token") !== token)
					return new Response("Unauthorized", { status: 401 });
				if (!server.upgrade(request, { data: undefined })) return new Response("Upgrade failed", { status: 400 });
			},
			websocket: {
				open(socket) {
					socket.send(JSON.stringify({ type: "hello", connectionId: `client-${Date.now()}` }));
				},
				message(socket, raw) {
					const frame = JSON.parse(String(raw)) as Record<string, unknown>;
					if (frame.operation !== "wait")
						socket.send(JSON.stringify({ type: "control_response", id: frame.id, ok: true }));
				},
			},
		});
		port = server.port ?? port;
		servers.push(server);
		return server;
	};
	const first = startAtPort();
	const client = await SdkClient.connect(`ws://127.0.0.1:${port}`, token, { timeoutMs: 30, reconnectBackoffMs: 5 });
	await expect(client.control("wait")).rejects.toMatchObject({ code: "timeout" });
	await first.stop(true);
	servers.splice(servers.indexOf(first), 1);
	await Bun.sleep(50);
	startAtPort();
	await expect(client.control("after_restart")).resolves.toMatchObject({ ok: true });
	await client.close();
});

test("SdkClient ignores a stale failed socket while a retried request is in flight", async () => {
	const token = "sdk-client-stale-socket-token";
	let connections = 0;
	let firstSocket: any;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).searchParams.get("token") !== token)
				return new Response("Unauthorized", { status: 401 });
			if (!server.upgrade(request, { data: undefined })) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket) {
				connections++;
				if (connections === 1) firstSocket = socket;
				else socket.send(JSON.stringify({ type: "hello", connectionId: "retry-connection" }));
			},
			message(socket, raw) {
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				firstSocket?.close(1000, "late first connection close");
				socket.send(JSON.stringify({ type: "control_response", id: frame.id, ok: true }));
			},
		},
	});
	servers.push(server);
	const client = await SdkClient.connect(`ws://127.0.0.1:${server.port}`, token, {
		timeoutMs: 15,
		reconnectAttempts: 1,
		reconnectBackoffMs: 1,
	});
	const response = client.control("turn.prompt", { text: "still connected" }, { timeoutMs: 1_000 });
	await expect(response).resolves.toMatchObject({ ok: true });
	expect(connections).toBe(2);
	await client.close();
});

test("SdkClient reports a missing hello as a protocol error before a later deadline", async () => {
	const host = start(() => {}, { sendHello: false });
	await expect(
		SdkClient.connect(host.url, host.token, {
			timeoutMs: 75,
			deadline: Date.now() + 1_000,
			reconnectAttempts: 0,
		}),
	).rejects.toMatchObject({
		code: "reconnect_exhausted",
		details: expect.objectContaining({
			code: "protocol_error",
			message: "SDK server did not send a hello frame.",
		}),
	});
});

test("SdkClient reports a missing hello as a deadline error after its deadline", async () => {
	const host = start(() => {}, { sendHello: false });
	await expect(
		SdkClient.connect(host.url, host.token, {
			timeoutMs: 250,
			deadline: Date.now() + 100,
			reconnectAttempts: 0,
		}),
	).rejects.toMatchObject({ code: "timeout", message: "SDK client deadline elapsed." });
});
test("SdkClient bounds a peer that accepts TCP but never completes the WebSocket upgrade", async () => {
	const hangingUpgrade = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			return Promise.withResolvers<Response>().promise;
		},
	});
	try {
		const started = Date.now();
		await expect(
			SdkClient.connect(`ws://127.0.0.1:${hangingUpgrade.port}`, "unused", {
				timeoutMs: 75,
				reconnectAttempts: 0,
			}),
		).rejects.toMatchObject({
			code: "reconnect_exhausted",
			details: expect.objectContaining({ code: "timeout" }),
		});
		expect(Date.now() - started).toBeLessThan(500);
	} finally {
		hangingUpgrade.stop(true);
	}
});

test("SdkClient never replays sent work onto a replacement connection", async () => {
	const token = "sdk-client-no-replay-token";
	const received: Array<{ connection: number; frame: Record<string, unknown> }> = [];
	let connection = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).searchParams.get("token") !== token)
				return new Response("Unauthorized", { status: 401 });
			if (!server.upgrade(request, { data: undefined })) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket) {
				connection++;
				socket.send(JSON.stringify({ type: "hello", connectionId: `no-replay-${connection}` }));
			},
			message(socket, raw) {
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				received.push({ connection, frame });
				if (frame.operation === "mutate") socket.close(1000, "close after accept");
				else socket.send(JSON.stringify({ type: "control_response", id: frame.id, ok: true }));
			},
		},
	});
	servers.push(server);
	const client = await SdkClient.connect(`ws://127.0.0.1:${server.port}`, token);
	await expect(client.control("mutate", { value: 1 })).rejects.toMatchObject({ code: "connection_closed" });
	await expect(client.control("after_close", { value: 2 })).resolves.toMatchObject({ ok: true });
	expect(received.filter(entry => entry.frame.operation === "mutate")).toHaveLength(1);
	expect(received.filter(entry => entry.frame.operation === "after_close")).toHaveLength(1);
	expect(received.map(entry => entry.frame.id)).toEqual(
		expect.arrayContaining([expect.any(String), expect.any(String)]),
	);
	expect(received[0].frame.id).not.toBe(received[1].frame.id);
	await client.close();
});

type FakeListener = ((event: Event) => void) | { handleEvent(event: Event): void };
type FakeListenerOptions = { once?: boolean };

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];
	readonly listeners = new Map<string, Map<FakeListener, FakeListenerOptions>>();
	readonly sent: string[] = [];
	readonly closeCalls: unknown[][] = [];
	readyState = FakeWebSocket.CONNECTING;
	throwOnSend: Error | undefined;

	constructor(readonly url: string | URL) {
		FakeWebSocket.instances.push(this);
	}

	addEventListener(type: string, listener: FakeListener, options?: FakeListenerOptions): void {
		const listeners = this.listeners.get(type) ?? new Map<FakeListener, FakeListenerOptions>();
		listeners.set(listener, options ?? {});
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: FakeListener): void {
		this.listeners.get(type)?.delete(listener);
	}

	close(...args: unknown[]): void {
		this.closeCalls.push(args);
		this.readyState = FakeWebSocket.CLOSED;
	}

	send(value: string): void {
		if (this.throwOnSend) throw this.throwOnSend;
		this.sent.push(value);
	}

	snapshot(type: string): FakeListener[] {
		return [...(this.listeners.get(type)?.keys() ?? [])];
	}

	emit(type: string, event = new Event(type)): void {
		for (const [listener, options] of [...(this.listeners.get(type) ?? [])]) {
			if (options.once) this.removeEventListener(type, listener);
			if (typeof listener === "function") listener.call(this, event);
			else listener.handleEvent(event);
		}
	}

	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.emit("open");
	}

	message(frame: unknown): void {
		const event = new MessageEvent("message", { data: typeof frame === "string" ? frame : JSON.stringify(frame) });
		this.emit("message", event);
	}
}

type FakeTimerHandle = { readonly id: number; unref: () => FakeTimerHandle };
type FakeTimerTask = { readonly callback: () => void; readonly due: number; readonly order: number };

class FakeClock {
	#nextId = 1;
	#nextOrder = 1;
	now = 1_000;
	readonly tasks = new Map<FakeTimerHandle, FakeTimerTask>();

	setTimeout(callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]): FakeTimerHandle {
		const handle: FakeTimerHandle = { id: this.#nextId++, unref: () => handle };
		this.tasks.set(handle, {
			callback: () => callback(...args),
			due: this.now + Math.max(0, delay),
			order: this.#nextOrder++,
		});
		return handle;
	}

	clearTimeout(handle: FakeTimerHandle): void {
		this.tasks.delete(handle);
	}

	elapse(milliseconds: number): void {
		this.now += milliseconds;
	}

	advanceBy(milliseconds: number): void {
		this.advanceTo(this.now + milliseconds);
	}

	advanceTo(target: number): void {
		if (target < this.now) throw new Error("Fake clock cannot move backwards");
		for (;;) {
			const entry = [...this.tasks.entries()]
				.filter(([, task]) => task.due <= target)
				.sort((left, right) => left[1].due - right[1].due || left[1].order - right[1].order)[0];
			if (!entry) break;
			this.now = entry[1].due;
			this.tasks.delete(entry[0]);
			entry[1].callback();
		}
		this.now = target;
	}

	runNext(): void {
		const entry = [...this.tasks.entries()].sort(
			(left, right) => left[1].due - right[1].due || left[1].order - right[1].order,
		)[0];
		if (!entry) throw new Error("No fake timer is pending");
		this.advanceTo(entry[1].due);
	}
}

async function withFakeTimers(run: (clock: FakeClock) => Promise<void>): Promise<void> {
	const setTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
	const clearTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
	const dateNowDescriptor = Object.getOwnPropertyDescriptor(Date, "now");
	const clock = new FakeClock();
	Object.defineProperty(globalThis, "setTimeout", {
		configurable: true,
		value: clock.setTimeout.bind(clock) as unknown as typeof setTimeout,
	});
	Object.defineProperty(globalThis, "clearTimeout", {
		configurable: true,
		value: clock.clearTimeout.bind(clock) as unknown as typeof clearTimeout,
	});
	Object.defineProperty(Date, "now", { configurable: true, value: () => clock.now });
	try {
		await run(clock);
	} finally {
		if (setTimeoutDescriptor) Object.defineProperty(globalThis, "setTimeout", setTimeoutDescriptor);
		if (clearTimeoutDescriptor) Object.defineProperty(globalThis, "clearTimeout", clearTimeoutDescriptor);
		if (dateNowDescriptor) Object.defineProperty(Date, "now", dateNowDescriptor);
	}
}

async function withFakeWebSockets(run: () => Promise<void>): Promise<void> {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
	FakeWebSocket.instances = [];
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
	try {
		await run();
	} finally {
		if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor);
		else Reflect.deleteProperty(globalThis, "WebSocket");
	}
}

const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));

test("SdkClient fences queued stale callbacks with a colliding replacement request ID", async () => {
	await withFakeWebSockets(async () => {
		const client = new SdkClient("ws://fake", "token", { reconnectAttempts: 0 });
		const opening = client.connect();
		const first = FakeWebSocket.instances[0];
		const firstOpen = first.snapshot("open");
		first.open();
		first.message({ type: "hello", connectionId: "first" });
		await opening;

		const firstClose = first.snapshot("close");
		const firstError = first.snapshot("error");
		const firstMessage = first.snapshot("message");
		first.readyState = FakeWebSocket.CLOSED;
		for (const listener of firstClose) {
			if (typeof listener === "function") listener(new Event("close"));
			else listener.handleEvent(new Event("close"));
		}

		const replacementRequest = client.control("replacement");
		for (let index = 0; index < 4; index++) await flush();
		const second = FakeWebSocket.instances[1];
		second.open();
		second.message({ type: "hello", connectionId: "second" });
		for (let index = 0; index < 4; index++) await flush();
		for (const listener of firstOpen) {
			if (typeof listener === "function") listener(new Event("open"));
			else listener.handleEvent(new Event("open"));
		}
		const replacementId = (JSON.parse(second.sent[0]) as { id: string }).id;

		for (const listener of firstError) {
			if (typeof listener === "function") listener(new Event("error"));
			else listener.handleEvent(new Event("error"));
		}
		for (const listener of firstMessage) {
			if (typeof listener === "function") listener(new MessageEvent("message", { data: "not-json" }));
			else listener.handleEvent(new MessageEvent("message", { data: "not-json" }));
		}
		for (const listener of firstMessage) {
			if (typeof listener === "function")
				listener(
					new MessageEvent("message", {
						data: JSON.stringify({ type: "control_response", id: replacementId, ok: true }),
					}),
				);
			else
				listener.handleEvent(
					new MessageEvent("message", {
						data: JSON.stringify({ type: "control_response", id: replacementId, ok: true }),
					}),
				);
		}

		second.message({ type: "control_response", id: replacementId, ok: true });
		await expect(replacementRequest).resolves.toMatchObject({ ok: true });
		await client.close();
	});
});

test("SdkClient terminal close rejects opening, hello, and backoff waiters without resurrection", async () => {
	await withFakeWebSockets(async () => {
		const openingClient = new SdkClient("ws://fake", "token", { reconnectAttempts: 1 });
		const opening = openingClient.connect();
		await openingClient.close();
		await expect(opening).rejects.toMatchObject({ code: "connection_closed" });

		const helloClient = new SdkClient("ws://fake", "token", { reconnectAttempts: 1 });
		const hello = helloClient.connect();
		FakeWebSocket.instances[1].open();
		await helloClient.close();
		await expect(hello).rejects.toMatchObject({ code: "connection_closed" });

		const backoffClient = new SdkClient("ws://fake", "token", { reconnectAttempts: 1, reconnectBackoffMs: 1_000 });
		const backoff = backoffClient.connect();
		FakeWebSocket.instances[2].emit("error");
		for (let index = 0; index < 4; index++) await flush();
		await backoffClient.close();
		await expect(backoff).rejects.toMatchObject({ code: "connection_closed" });
	});
});

test("SdkClient deterministically owns open, hello, request, and backoff timers", async () => {
	await withFakeWebSockets(async () => {
		await withFakeTimers(async clock => {
			const openTimeoutClient = new SdkClient("ws://fake", "token", { reconnectAttempts: 0 });
			const openTimeout = openTimeoutClient.connect();
			clock.runNext();
			await expect(openTimeout).rejects.toMatchObject({ code: "reconnect_exhausted" });

			const helloTimeoutClient = new SdkClient("ws://fake", "token", { reconnectAttempts: 0 });
			const helloTimeout = helloTimeoutClient.connect();
			FakeWebSocket.instances[1].open();
			clock.runNext();
			await expect(helloTimeout).rejects.toMatchObject({ code: "reconnect_exhausted" });

			const requestTimeoutClient = new SdkClient("ws://fake", "token");
			const requestConnected = requestTimeoutClient.connect();
			const requestSocket = FakeWebSocket.instances[2];
			requestSocket.open();
			requestSocket.message({ type: "hello", connectionId: "request-timeout" });
			await requestConnected;

			const beforeDeadline = requestTimeoutClient.control("before-deadline", {}, { timeoutMs: 50 });
			await flush();
			const beforeDeadlineId = (JSON.parse(requestSocket.sent[0]) as { id: string }).id;
			expect([...clock.tasks.values()].map(task => task.due - clock.now)).toEqual([50]);
			clock.setTimeout(
				() => requestSocket.message({ type: "control_response", id: beforeDeadlineId, ok: true }),
				49,
			);
			clock.advanceBy(49);
			await expect(beforeDeadline).resolves.toMatchObject({ ok: true });
			expect(clock.tasks.size).toBe(0);

			const atDeadline = requestTimeoutClient.control("at-deadline", {}, { timeoutMs: 50 });
			await flush();
			const atDeadlineId = (JSON.parse(requestSocket.sent[1]) as { id: string }).id;
			expect([...clock.tasks.values()].map(task => task.due - clock.now)).toEqual([50]);
			clock.advanceBy(50);
			await expect(atDeadline).rejects.toMatchObject({ code: "timeout" });
			requestSocket.message({ type: "control_response", id: atDeadlineId, ok: true });
			expect(clock.tasks.size).toBe(0);
			await requestTimeoutClient.close();
			const backoffClient = new SdkClient("ws://fake", "token", {
				reconnectAttempts: 1,
				reconnectBackoffMs: 100,
			});
			const backoff = backoffClient.connect();
			FakeWebSocket.instances[3].emit("error");
			for (let index = 0; index < 4; index++) await flush();
			clock.runNext();
			for (let index = 0; index < 4; index++) await flush();
			const replacement = FakeWebSocket.instances[4];
			replacement.open();
			replacement.message({ type: "hello", connectionId: "after-backoff" });
			await backoff;
			await backoffClient.close();
		});
	});
});

test("SdkClient settles an open-to-hello deadline crossover and releases the retry cycle", async () => {
	await withFakeWebSockets(async () => {
		await withFakeTimers(async clock => {
			const client = new SdkClient("ws://fake", "token", {
				deadline: clock.now + 10,
				reconnectAttempts: 0,
			});
			const connecting = client.connect();
			const socket = FakeWebSocket.instances[0];
			clock.elapse(10);
			socket.open();
			await expect(connecting).rejects.toMatchObject({ code: "timeout", message: "SDK client deadline elapsed." });
			expect(clock.tasks.size).toBe(0);
			expect(socket.closeCalls).toHaveLength(1);
			expect([...socket.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
			socket.emit("message", new MessageEvent("message", { data: JSON.stringify({ type: "hello" }) }));
			await expect(client.connect()).rejects.toMatchObject({ code: "timeout" });
			await client.close();
		});
	});
});

test("SdkClient settles response-versus-close races exactly once", async () => {
	await withFakeWebSockets(async () => {
		const responseFirstClient = new SdkClient("ws://fake", "token");
		const responseFirstConnected = responseFirstClient.connect();
		const responseFirstSocket = FakeWebSocket.instances[0];
		responseFirstSocket.open();
		responseFirstSocket.message({ type: "hello", connectionId: "response-first" });
		await responseFirstConnected;
		const responseFirst = responseFirstClient.control("response-first");
		await flush();
		const responseFirstId = (JSON.parse(responseFirstSocket.sent[0]) as { id: string }).id;
		responseFirstSocket.message({ type: "control_response", id: responseFirstId, ok: true });
		responseFirstSocket.emit("close");
		await expect(responseFirst).resolves.toMatchObject({ ok: true });
		await responseFirstClient.close();

		const closeFirstClient = new SdkClient("ws://fake", "token");
		const closeFirstConnected = closeFirstClient.connect();
		const closeFirstSocket = FakeWebSocket.instances[1];
		closeFirstSocket.open();
		closeFirstSocket.message({ type: "hello", connectionId: "close-first" });
		await closeFirstConnected;
		const closeFirst = closeFirstClient.control("close-first");
		await flush();
		const closeFirstId = (JSON.parse(closeFirstSocket.sent[0]) as { id: string }).id;
		closeFirstSocket.emit("close");
		closeFirstSocket.message({ type: "control_response", id: closeFirstId, ok: true });
		await expect(closeFirst).rejects.toMatchObject({ code: "connection_closed" });
		await closeFirstClient.close();
	});
});

test("SdkClient permits direct send on the authoritative open socket before hello", async () => {
	await withFakeWebSockets(async () => {
		const client = new SdkClient("ws://fake", "token");
		const connected = client.connect();
		const socket = FakeWebSocket.instances[0];
		socket.open();
		client.send({ type: "provider_heartbeat" });
		expect(JSON.parse(socket.sent[0])).toMatchObject({ type: "provider_heartbeat" });
		socket.message({ type: "hello", connectionId: "send-before-hello" });
		await connected;
		await client.close();
	});
});
test("SdkClient rolls back a failed direct incarnation send", async () => {
	await withFakeWebSockets(async () => {
		const client = new SdkClient("ws://fake", "token");
		const connected = client.connect();
		const socket = FakeWebSocket.instances[0];
		socket.open();
		socket.message({ type: "hello", connectionId: "send" });
		await connected;
		socket.throwOnSend = new Error("send failed");
		await expect(client.control("send")).rejects.toMatchObject({ code: "unavailable" });
		expect(socket.sent).toHaveLength(0);
		await client.close();
	});
});

test("SdkClient delivers the authoritative initial hello to pre-connect frame handlers", async () => {
	await withFakeWebSockets(async () => {
		const client = new SdkClient("ws://fake", "token");
		const frames: Array<Record<string, unknown>> = [];
		client.onFrame(frame => frames.push(frame));
		const connected = client.connect();
		const socket = FakeWebSocket.instances[0];
		socket.open();
		socket.message({ type: "hello", connectionId: "initial-frame" });
		await connected;
		expect(frames).toEqual([{ type: "hello", connectionId: "initial-frame" }]);
		await client.close();
	});
});

test("SdkClient ignores duplicate and empty hellos while preserving changed-ID rotation", async () => {
	await withFakeWebSockets(async () => {
		const client = new SdkClient("ws://fake", "token");
		let reconnects = 0;
		client.onReconnect(() => reconnects++);
		const connected = client.connect();
		const socket = FakeWebSocket.instances[0];
		socket.open();
		socket.message({ type: "hello", connectionId: "stable" });
		await connected;
		socket.message({ type: "hello", connectionId: "stable" });
		socket.message({ type: "hello", connectionId: "" });
		expect(client.connectionId).toBe("stable");
		expect(reconnects).toBe(0);
		socket.message({ type: "hello", connectionId: "changed" });
		socket.message({ type: "hello", connectionId: "changed" });
		expect(client.connectionId).toBe("changed");
		expect(reconnects).toBe(1);
		await client.close();
	});
});
