import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SdkClient, SdkClientError } from "../src/sdk/client/client";

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
	deferClose = false;

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
		this.readyState = this.deferClose ? FakeWebSocket.CLOSING : FakeWebSocket.CLOSED;
	}

	send(value: string): void {
		if (this.throwOnSend) throw this.throwOnSend;
		this.sent.push(value);
	}

	emit(type: string, event = new Event(type)): void {
		for (const [listener, options] of [...(this.listeners.get(type) ?? [])]) {
			if (options.once) this.removeEventListener(type, listener);
			if (typeof listener === "function") listener.call(this, event);
			else listener.handleEvent(event);
		}
	}

	snapshot(type: string): FakeListener[] {
		return [...(this.listeners.get(type)?.keys() ?? [])];
	}

	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.emit("open");
	}

	message(frame: unknown): void {
		this.emit(
			"message",
			new MessageEvent("message", { data: typeof frame === "string" ? frame : JSON.stringify(frame) }),
		);
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
}

async function withFakeTransport(run: (clock: FakeClock) => Promise<void>): Promise<void> {
	const webSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
	const setTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
	const clearTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
	const dateNowDescriptor = Object.getOwnPropertyDescriptor(Date, "now");
	const clock = new FakeClock();
	FakeWebSocket.instances = [];
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
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
		if (webSocket) Object.defineProperty(globalThis, "WebSocket", webSocket);
		else Reflect.deleteProperty(globalThis, "WebSocket");
		if (setTimeoutDescriptor) Object.defineProperty(globalThis, "setTimeout", setTimeoutDescriptor);
		if (clearTimeoutDescriptor) Object.defineProperty(globalThis, "clearTimeout", clearTimeoutDescriptor);
		if (dateNowDescriptor) Object.defineProperty(Date, "now", dateNowDescriptor);
	}
}

const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));

async function connect(client: SdkClient, connectionId = "connection"): Promise<FakeWebSocket> {
	const pending = client.connect();
	const socket = FakeWebSocket.instances.at(-1)!;
	socket.open();
	socket.message({ type: "hello", connectionId });
	await pending;
	return socket;
}

function sent(socket: FakeWebSocket, index = 0): Record<string, unknown> {
	return JSON.parse(socket.sent[index]) as Record<string, unknown>;
}

test("SdkClient gates requests on hello and correlates success and typed errors", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token");
		const connecting = client.connect();
		const socket = FakeWebSocket.instances[0];
		socket.open();
		const request = client.control("turn.prompt", { text: "hello" });
		await flush();
		expect(socket.sent).toHaveLength(0);
		socket.message({ type: "hello", connectionId: "hello-gated" });
		await connecting;
		await flush();
		const frame = sent(socket);
		expect(frame).toMatchObject({ type: "control_request", operation: "turn.prompt", input: { text: "hello" } });
		if (typeof frame.id !== "string") throw new Error("request id missing");

		socket.message({ type: "control_response", id: frame.id, ok: true, result: { accepted: true } });
		await expect(request).resolves.toMatchObject({ result: { accepted: true } });
		expect(client.getSentRecord(frame.id)).toBeUndefined();

		const failed = client.control("missing");
		await flush();
		const failedFrame = sent(socket, 1);
		if (typeof failedFrame.id !== "string") throw new Error("failed request id missing");

		socket.message({
			type: "control_response",
			id: failedFrame.id,
			ok: false,
			error: { code: "unknown_operation", message: "missing" },
		});
		await expect(failed).rejects.toBeInstanceOf(SdkClientError);
		await expect(failed).rejects.toMatchObject({ code: "unknown_operation", message: "missing" });
		expect(client.getSentRecord(failedFrame.id)).toBeUndefined();

		await client.close();
	});
});

test("SdkClient accepts hello that races ahead of the open handler", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token");
		const connecting = client.connect();
		const socket = FakeWebSocket.instances[0];
		// Deliver hello while still in the opening phase (before open()).
		socket.message({ type: "server_hello", connectionId: "early" });
		socket.open();
		await connecting;
		const request = client.query("session.metadata", {});
		await flush();
		const frame = sent(socket);
		expect(frame).toMatchObject({ type: "query_request", query: "session.metadata" });
		socket.message({ type: "query_response", id: frame.id, ok: true, result: { sessionId: "live" } });
		await expect(request).resolves.toMatchObject({ ok: true, result: { sessionId: "live" } });
		await client.close();
	});
});

test("SdkClient close resolves only after the owned transport closes", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token");
		const socket = await connect(client);
		socket.deferClose = true;
		let settled = false;
		const closing = client.close().then(() => {
			settled = true;
		});
		await flush();
		expect(settled).toBe(false);
		expect(socket.readyState).toBe(FakeWebSocket.CLOSING);
		socket.readyState = FakeWebSocket.CLOSED;
		socket.emit("close");
		await closing;
		expect(settled).toBe(true);
	});
});

test("SdkClient concurrent close callers await the same transport close", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token");
		const socket = await connect(client);
		socket.deferClose = true;
		const first = client.close();
		const second = client.close();
		expect(second).toBe(first);
		await flush();
		expect(socket.closeCalls).toHaveLength(1);
		socket.readyState = FakeWebSocket.CLOSED;
		socket.emit("close");
		await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
	});
});

test("SdkClient close rejects with a typed timeout when transport close stalls", async () => {
	await withFakeTransport(async clock => {
		const client = new SdkClient("ws://sdk.test", "token", { timeoutMs: 50 });
		const socket = await connect(client);
		socket.deferClose = true;
		const closing = client.close();
		clock.advanceBy(50);
		await expect(closing).rejects.toMatchObject({
			code: "timeout",
			message: "SDK WebSocket close timed out after 50ms",
		});
		expect(socket.snapshot("close")).toHaveLength(0);
	});
});

test("SdkClient close still issues socket close after the operation deadline elapses (no transport leak)", async () => {
	await withFakeTransport(async clock => {
		const client = new SdkClient("ws://sdk.test", "token", { timeoutMs: 50, deadline: clock.now + 10 });
		const socket = await connect(client);
		clock.advanceBy(100); // operation deadline (now + 10) is now in the past
		const closing = client.close();
		await flush();
		// Regression: close must always issue socket.close() bounded by its own close
		// grace, never gate on the expired request deadline and throw before closing.
		expect(socket.closeCalls.length).toBeGreaterThanOrEqual(1);
		await closing;
		expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
	});
});

test("SdkClient settles owner responses before isolated frame observers", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token");
		const socket = await connect(client);
		const observed: string[] = [];
		let closePromise: Promise<void> | undefined;
		client.onFrame(() => {
			throw new Error("observer failure");
		});
		client.onFrame(frame => {
			observed.push(String(frame.type));
			closePromise = client.close();
		});
		client.onFrame(() => {
			observed.push("after-close");
		});

		const request = client.control("settle-before-observers");
		await flush();
		const frame = sent(socket);
		socket.message({ type: "control_response", id: frame.id, ok: true, result: { settled: true } });

		await expect(request).resolves.toMatchObject({ result: { settled: true } });
		expect(observed).toEqual(["control_response", "after-close"]);
		await closePromise;
	});
});

test("SdkClient rejects malformed frames and marks a lost sent response uncertain", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client);
		const malformed = client.control("malformed");
		await flush();
		socket.message("not-json");
		await expect(malformed).rejects.toMatchObject({ code: "protocol_error" });

		const lost = client.control("lost");
		await flush();
		socket.readyState = FakeWebSocket.CLOSED;
		socket.emit("close");
		await expect(lost).rejects.toMatchObject({ code: "uncertain_after_send" });

		await client.close();
	});
});

test("SdkClient distinguishes pre-send closure from a sent lifecycle request and reconciles the durable lookup", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client);
		socket.throwOnSend = new SdkClientError("connection_closed", "Socket closed before write");
		const beforeSend = client.global("session.create", { cwd: "/repo" }, { idempotencyKey: "before-send" });
		await expect(beforeSend).rejects.toMatchObject({ code: "connection_closed" });
		expect(socket.sent).toHaveLength(0);

		socket.throwOnSend = undefined;
		const secret = "mcp-credential-not-for-sent-record";
		const lifecycleInput = {
			cwd: "/repo",
			mcp: {
				headers: { authorization: `Bearer ${secret}` },
				env: { MCP_TOKEN: secret },
			},
		};
		const expectedFingerprint = createHash("sha256")
			.update(JSON.stringify({ operation: "session.create", input: lifecycleInput }))
			.digest("hex");
		const afterSend = client.global("session.create", lifecycleInput, { idempotencyKey: "after-send" });
		await flush();
		const sentFrame = sent(socket);
		if (typeof sentFrame.id !== "string") throw new Error("lifecycle request id missing");
		socket.readyState = FakeWebSocket.CLOSED;
		socket.emit("close");
		let uncertain: unknown;
		try {
			await afterSend;
		} catch (error) {
			uncertain = error;
		}
		if (!(uncertain instanceof SdkClientError)) throw new Error("sent lifecycle request was not uncertain");
		expect(uncertain).toMatchObject({
			code: "uncertain_after_send",
			details: {
				id: sentFrame.id,
				operation: "session.create",
				idempotencyKey: "after-send",
				fingerprint: expectedFingerprint,
			},
		});
		expect(JSON.stringify(uncertain.details)).not.toContain(secret);
		const record = client.getSentRecord(sentFrame.id);
		if (!record) throw new Error("sent lifecycle record missing");
		expect(record.fingerprint).toBe(expectedFingerprint);
		expect(JSON.stringify(record)).not.toContain(secret);

		const reconciliation = client.lookupLifecycle(record);
		for (let index = 0; index < 4; index++) await flush();
		const replacement = FakeWebSocket.instances.at(-1);
		if (!replacement || replacement === socket) throw new Error("lookup replacement socket missing");
		replacement.open();
		replacement.message({ type: "broker_hello", connectionId: "lookup" });
		for (let index = 0; index < 4; index++) await flush();
		const lookupFrame = sent(replacement);
		if (typeof lookupFrame.id !== "string") throw new Error("lookup request id missing");
		expect(lookupFrame).toMatchObject({
			type: "broker_request",
			operation: "broker.lookup_lifecycle",
			input: { operation: "session.create", fingerprint: record.fingerprint },
			idempotencyKey: "after-send",
		});
		replacement.message({
			type: "broker_response",
			id: lookupFrame.id,
			ok: true,
			result: { sessionId: "durably-persisted" },
		});
		await expect(reconciliation).resolves.toMatchObject({ result: { sessionId: "durably-persisted" } });
		expect(client.getSentRecord(record.id)).toBeUndefined();
		await client.close();
	});
});

test("SdkClient owns request timeout, reconnect backoff, and absolute deadline deterministically", async () => {
	await withFakeTransport(async clock => {
		const client = new SdkClient("ws://sdk.test", "token", {
			timeoutMs: 50,
			reconnectAttempts: 1,
			reconnectBackoffMs: 10,
		});
		const socket = await connect(client);
		const timedOut = client.control("wait");
		await flush();
		clock.advanceBy(50);
		await expect(timedOut).rejects.toMatchObject({ code: "uncertain_after_send" });

		socket.readyState = FakeWebSocket.CLOSED;
		socket.emit("close");
		const afterReconnect = client.control("after-reconnect");
		await flush();
		clock.advanceBy(10);
		await flush();
		const replacement = FakeWebSocket.instances[1];
		replacement.open();
		replacement.message({ type: "hello", connectionId: "replacement" });
		for (let index = 0; index < 4; index++) await flush();
		const frame = sent(replacement);
		replacement.message({ type: "control_response", id: frame.id, ok: true });
		await expect(afterReconnect).resolves.toMatchObject({ ok: true });
		await client.close();

		const deadlineClient = new SdkClient("ws://sdk.test", "token", { deadline: clock.now + 5, reconnectAttempts: 0 });
		const deadlineConnect = deadlineClient.connect();
		clock.advanceBy(5);
		await expect(deadlineConnect).rejects.toMatchObject({ code: "timeout" });
		await expect(deadlineClient.control("after-deadline")).rejects.toMatchObject({ code: "timeout" });
		await deadlineClient.close();
	});
});

test("SdkClient isolates reconnect observers from transport settlement", async () => {
	await withFakeTransport(async clock => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 1, reconnectBackoffMs: 10 });
		const first = await connect(client, "first");
		const notifications: string[] = [];
		client.onReconnect(() => {
			throw new Error("observer failure");
		});
		client.onReconnect(() => {
			notifications.push("reconnected");
		});

		first.readyState = FakeWebSocket.CLOSED;
		first.emit("close");
		const request = client.control("after-reconnect-observer");
		await flush();
		clock.advanceBy(10);
		await flush();
		const replacement = FakeWebSocket.instances[1];
		replacement.open();
		replacement.message({ type: "hello", connectionId: "second" });
		for (let index = 0; index < 4; index++) await flush();
		const frame = sent(replacement);
		replacement.message({ type: "control_response", id: frame.id, ok: true });

		await expect(request).resolves.toMatchObject({ ok: true });
		expect(notifications).toEqual(["reconnected"]);
		await client.close();
	});
});

test("SdkClient preserves typed reconnect exhaustion across hostile failure observers", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const notifications: string[] = [];
		client.onReconnectFailed(() => {
			throw new Error("observer failure");
		});
		client.onReconnectFailed(error => {
			notifications.push(error.code);
		});

		const connecting = client.connect();
		FakeWebSocket.instances[0].emit("error");
		await expect(connecting).rejects.toMatchObject({ code: "reconnect_exhausted" });
		expect(notifications).toEqual(["reconnect_exhausted"]);
		await client.close();
	});
});

test("SdkClient terminal close rejects opening, hello, and retry waiters", async () => {
	await withFakeTransport(async () => {
		const openingClient = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 1 });
		const opening = openingClient.connect();
		await openingClient.close();
		await expect(opening).rejects.toMatchObject({ code: "connection_closed" });

		const helloClient = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 1 });
		const hello = helloClient.connect();
		FakeWebSocket.instances[1].open();
		await helloClient.close();
		await expect(hello).rejects.toMatchObject({ code: "connection_closed" });

		const retryClient = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 1, reconnectBackoffMs: 10 });
		const retry = retryClient.connect();
		FakeWebSocket.instances[2].emit("error");
		for (let index = 0; index < 4; index++) await flush();
		await retryClient.close();
		let cancelled: SdkClientError | undefined;
		try {
			await retry;
		} catch (error) {
			cancelled = error as SdkClientError;
		}
		expect(cancelled).toMatchObject({ code: "connection_closed" });
		// Closing mid-backoff is the cancellation least likely to be noticed, so it has to
		// carry the same attribution as the rest and keep the transport error that led here.
		expect(cancelled?.reconnect).toMatchObject({ reason: "cancelled", attemptBudget: 1 });
		expect(cancelled?.details).toBeDefined();
	});
});

test("SdkClient attributes a deadline-truncated reconnect budget", async () => {
	await withFakeTransport(async clock => {
		// A budget sized in attempts, terminated by wall-clock: the exact shape an ACP
		// session hits, where 23 slots exist but a deadline ends the cycle early.
		const reconnectAttempts = 5;
		const client = new SdkClient("ws://sdk.test", "token", {
			reconnectAttempts,
			reconnectBackoffMs: 10,
			deadline: Date.now() + 15,
		});
		const connecting = client.connect();
		let failure: SdkClientError | undefined;
		const settled = connecting.catch((error: unknown) => {
			failure = error as SdkClientError;
		});
		for (let index = 0; index < 4; index++) await flush();
		FakeWebSocket.instances[0].emit("error");
		for (let index = 0; index < 4; index++) await flush();
		clock.advanceBy(15);
		for (let index = 0; index < 4; index++) await flush();

		await settled;
		expect(failure).toMatchObject({ code: "timeout" });
		expect(failure?.reconnect).toMatchObject({ reason: "deadline" });
		// Slots left unused is the evidence that the budget was cut short rather than spent.
		expect(failure?.reconnect?.attemptsConsumed).toBeLessThan(reconnectAttempts);
		await client.close();
	});
});

test("SdkClient keeps a default one-shot client deadline-dominant", async () => {
	await withFakeTransport(async clock => {
		// Defaults, not a zero-retry client: the fast-fail path an ordinary request
		// client gets without configuring anything must stay deadline-dominant.
		const client = new SdkClient("ws://sdk.test", "token", { deadline: Date.now() + 30, timeoutMs: 50 });
		const connecting = client.connect();
		let failure: SdkClientError | undefined;
		const settled = connecting.catch((error: unknown) => {
			failure = error as SdkClientError;
		});
		for (let index = 0; index < 4; index++) await flush();
		FakeWebSocket.instances[0].emit("error");
		for (let index = 0; index < 4; index++) await flush();
		clock.advanceBy(30);
		for (let index = 0; index < 4; index++) await flush();

		await settled;
		expect(failure).toMatchObject({ code: "timeout" });
		expect(failure?.reconnect).toMatchObject({ reason: "deadline" });
		expect(failure?.reconnect?.attemptsConsumed).toBeLessThan(failure!.reconnect!.attemptBudget);
		await client.close();
	});
});

test("SdkClient fences stale socket callbacks and never replays sent mutations", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const first = await connect(client, "first");
		const staleMessage = first.snapshot("message");
		first.readyState = FakeWebSocket.CLOSED;
		first.emit("close");

		const replacementRequest = client.control("replacement");
		for (let index = 0; index < 4; index++) await flush();
		const second = FakeWebSocket.instances[1];
		second.open();
		second.message({ type: "hello", connectionId: "second" });
		for (let index = 0; index < 4; index++) await flush();
		const observedResponseIds: string[] = [];
		client.onFrame(frame => {
			if (typeof frame.id === "string") observedResponseIds.push(frame.id);
		});
		const replacementFrame = sent(second);
		if (typeof replacementFrame.id !== "string") throw new Error("replacement request id missing");
		for (const listener of staleMessage) {
			const event = new MessageEvent("message", {
				data: JSON.stringify({ type: "control_response", id: replacementFrame.id, ok: true }),
			});
			if (typeof listener === "function") listener(event);
			else listener.handleEvent(event);
		}
		expect(observedResponseIds).toEqual([]);
		second.message({ type: "control_response", id: replacementFrame.id, ok: true });
		await expect(replacementRequest).resolves.toMatchObject({ ok: true });
		expect(observedResponseIds).toEqual([replacementFrame.id]);

		const mutation = client.control("mutate", { value: 1 });
		await flush();
		const mutationFrame = sent(second, 1);
		second.readyState = FakeWebSocket.CLOSED;
		second.emit("close");
		await expect(mutation).rejects.toMatchObject({ code: "uncertain_after_send" });

		const next = client.control("after-close");
		for (let index = 0; index < 4; index++) await flush();
		const third = FakeWebSocket.instances[2];
		third.open();
		third.message({ type: "hello", connectionId: "third" });
		for (let index = 0; index < 4; index++) await flush();
		const nextFrame = sent(third);
		third.message({ type: "control_response", id: nextFrame.id, ok: true });
		await expect(next).resolves.toMatchObject({ ok: true });
		expect(second.sent.filter(value => sent(second, second.sent.indexOf(value)).operation === "mutate")).toHaveLength(
			1,
		);
		expect(third.sent.some(value => (JSON.parse(value) as Record<string, unknown>).id === mutationFrame.id)).toBe(
			false,
		);
		await client.close();
	});
});

test("SdkClient clamps reconnect backoff to the configured per-attempt ceiling", async () => {
	await withFakeTransport(async clock => {
		const reconnectAttempts = 5;
		const reconnectBackoffMs = 100;
		const reconnectMaxBackoffMs = 200;
		const client = new SdkClient("ws://sdk.test", "token", {
			reconnectAttempts,
			reconnectBackoffMs,
			reconnectMaxBackoffMs,
		});
		const uncapped = Array.from({ length: reconnectAttempts }, (_, attempt) => reconnectBackoffMs * 2 ** attempt);
		const expected = uncapped.map(backoff => Math.min(backoff, reconnectMaxBackoffMs));

		const start = clock.now;
		const connecting = client.connect();
		const observed: number[] = [];
		for (let attempt = 0; attempt <= reconnectAttempts; attempt++) {
			const socket = FakeWebSocket.instances[attempt];
			if (!socket) throw new Error(`missing socket for attempt ${attempt}`);
			socket.emit("error");
			for (let index = 0; index < 4; index++) await flush();
			if (attempt === reconnectAttempts) break;
			// The failed incarnation clears its open timer, so only the backoff sleep is pending.
			const pending = [...clock.tasks.values()].map(task => task.due - clock.now);
			expect(pending).toHaveLength(1);
			observed.push(pending[0]);
			clock.advanceBy(pending[0]);
			for (let index = 0; index < 4; index++) await flush();
		}

		let exhausted: SdkClientError | undefined;
		try {
			await connecting;
		} catch (error) {
			exhausted = error as SdkClientError;
		}
		expect(exhausted).toMatchObject({ code: "reconnect_exhausted" });
		expect(exhausted?.reconnect).toMatchObject({
			reason: "attempts_exhausted",
			attemptsConsumed: reconnectAttempts,
			attemptBudget: reconnectAttempts,
		});
		// `details` stays the terminating transport error: consumers read it directly
		// (`session-cli` matches ENOENT/ECONNREFUSED there), so diagnostics must not displace it.
		expect(exhausted?.details).toBeInstanceOf(SdkClientError);
		expect(FakeWebSocket.instances).toHaveLength(reconnectAttempts + 1);
		expect(observed).toEqual(expected);
		expect(Math.max(...observed)).toBe(reconnectMaxBackoffMs);
		expect(clock.now - start).toBe(expected.reduce((total, backoff) => total + backoff, 0));
		expect(clock.now - start).toBeLessThan(uncapped.reduce((total, backoff) => total + backoff, 0));
		await client.close();
	});
});
