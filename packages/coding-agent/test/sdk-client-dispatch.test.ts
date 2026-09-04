import { expect, test } from "bun:test";
import { SdkClient, type SdkClientError, SdkPreparedDispatchError } from "../src/sdk/client/client";

/*
 * Dispatch-aware requests (#4640).
 *
 * A consumer that must synchronously mark the post-send dispatch boundary used
 * to have only two options: `control()`/`request()` — which settle correctly on
 * transport close but expose no send-boundary callback — or a raw `send()` +
 * `onFrame()` pair, which can never settle on a close after handoff and waits
 * for its own timeout. `beforeDispatch`/`onDispatch` close that gap while the
 * client keeps ownership of pending-request retirement.
 */

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
		if (this.onSendReentrant) this.onSendReentrant(value);
	}
	/** Synchronous hook fired from inside send() to emulate reentrant transport events. */
	onSendReentrant: ((value: string) => void) | undefined;

	emit(type: string, event = new Event(type)): void {
		for (const [listener, options] of [...(this.listeners.get(type) ?? [])]) {
			if (options.once) this.removeEventListener(type, listener);
			if (typeof listener === "function") listener.call(this, event);
			else listener.handleEvent(event);
		}
	}

	snapshot(type: string): FakeListener[] {
		return [...(this.listeners.get(type) ?? new Map<FakeListener, FakeListenerOptions>())].map(
			([listener]) => listener,
		);
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

const flush = () => {
	const { promise, resolve } = Promise.withResolvers<void>();
	queueMicrotask(resolve);
	return promise;
};

async function connect(client: SdkClient, connectionId = "connection"): Promise<FakeWebSocket> {
	const pending = client.connect();
	const socket = FakeWebSocket.instances.at(-1)!;
	socket.open();
	socket.message({ type: "hello", connectionId });
	await pending;
	return socket;
}

function sentFrame(socket: FakeWebSocket, index = 0): Record<string, unknown> {
	return JSON.parse(socket.sent[index]) as Record<string, unknown>;
}

test("onDispatch fires synchronously after frame handoff, never before", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client, "dispatch-connection");
		const order: string[] = [];

		client
			.request(
				{ type: "control_request", operation: "turn.prompt" },
				{
					onDispatch: () => {
						// Synchronous-after-send proof: the frame is already on the wire
						// when this callback runs, and no microtask has run in between.
						order.push(`dispatch socket.sent=${socket.sent.length}`);
					},
				},
			)
			.catch(() => undefined);

		// The whole dispatch ran synchronously inside request(); no awaits yet.
		await flush();
		expect(order).toEqual(["dispatch socket.sent=1"]);
		const frame = sentFrame(socket);
		expect(frame).toMatchObject({ type: "control_request", operation: "turn.prompt" });
		if (typeof frame.id !== "string") throw new Error("request id missing");
		socket.message({ type: "control_response", id: frame.id, ok: true, result: { accepted: true } });
		order.push("after-response");
		await flush();
		expect(order).toEqual(["dispatch socket.sent=1", "after-response"]);
		await client.close();
	});
});

test("onDispatch context carries the exact request identity and active generation", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client, "ctx-connection");
		const contexts: Array<{ id: unknown; connectionId: string | undefined; generation: number }> = [];

		const request = client.request(
			{ type: "control_request", operation: "session.list" },
			{
				onDispatch: context => {
					contexts.push({
						id: context.frame.id,
						connectionId: context.connectionId,
						generation: context.generation,
					});
				},
			},
		);
		await flush();
		const frame = sentFrame(socket);
		expect(contexts).toHaveLength(1);
		expect(contexts[0]?.id).toBe(frame.id);
		expect(contexts[0]?.connectionId).toBe("ctx-connection");
		expect(typeof contexts[0]?.generation).toBe("number");
		expect(contexts[0]!.generation).toBeGreaterThan(0);
		socket.message({ type: "control_response", id: frame.id, ok: true });
		await expect(request).resolves.toMatchObject({ ok: true });
		await client.close();
	});
});

test("socket close immediately after dispatch settles the request exactly once as uncertain", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0, timeoutMs: 10_000 });
		const socket = await connect(client);
		let dispatches = 0;
		let settlements = 0;

		const request = client.request(
			{ type: "control_request", operation: "turn.prompt" },
			{
				timeoutMs: 10_000,
				onDispatch: () => {
					dispatches++;
					// Close races the response: no reply will ever arrive.
					socket.readyState = FakeWebSocket.CLOSED;
					socket.emit("close");
				},
			},
		);
		request.catch(() => undefined).finally(() => settlements++);

		await flush();
		expect(dispatches).toBe(1);
		await expect(request).rejects.toMatchObject({ code: "uncertain_after_send" });
		await flush();
		// Exactly-once settlement: the pending map entry is gone, so a later
		// response frame for the same id cannot settle it a second time.
		const frame = sentFrame(socket);
		socket.message({ type: "control_response", id: frame.id, ok: true, result: { late: true } });
		await flush();
		expect(settlements).toBe(1);
		await client.close().catch(() => undefined);
	});
});

test("response beats close when the reply lands before the socket drops", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client);
		let boundaryReached = false;
		const request = client.request(
			{ type: "control_request", operation: "turn.prompt" },
			{
				timeoutMs: 10_000,
				onDispatch: () => {
					boundaryReached = true;
					const frame = sentFrame(socket);
					// Response arrives while the transport is still open.
					socket.message({ type: "control_response", id: frame.id, ok: true, result: { won: "response" } });
				},
			},
		);
		await flush();
		expect(boundaryReached).toBe(true);
		// The close happens after the response was already delivered.
		socket.readyState = FakeWebSocket.CLOSED;
		socket.emit("close");
		await expect(request).resolves.toMatchObject({ result: { won: "response" } });
		await client.close().catch(() => undefined);
	});
});

test("a close before the dispatch boundary stays retryable pre-send", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client);
		let boundaryReached = false;
		const cancelled = client.request(
			{ type: "control_request", operation: "turn.prompt" },
			{
				timeoutMs: 10_000,
				onDispatch: () => {
					boundaryReached = true;
				},
			},
		);
		// The socket drops before the client reached its dispatch boundary, so
		// nothing was written: retirement is pre-send (retryable), not uncertain.
		socket.readyState = FakeWebSocket.CLOSED;
		socket.emit("close");
		await expect(cancelled).rejects.toMatchObject({ code: "unavailable" });
		expect(boundaryReached).toBe(false);
		expect(socket.sent).toHaveLength(0);
		await client.close().catch(() => undefined);
	});
});

test("beforeDispatch throwing aborts before the wire and the request stays retryable", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client);
		let dispatched = 0;
		const abort = new Error("cancellation won before dispatch");

		const cancelled = client.request(
			{ type: "control_request", operation: "turn.prompt" },
			{
				beforeDispatch: () => {
					throw abort;
				},
				onDispatch: () => {
					dispatched++;
				},
			},
		);
		await expect(cancelled).rejects.toBe(abort);
		// Nothing was written, no boundary callback fired, no sent record exists.
		expect(socket.sent).toHaveLength(0);
		expect(dispatched).toBe(0);

		// The same client and socket immediately serve a retried request.
		const retried = client.request(
			{ type: "control_request", operation: "turn.prompt" },
			{
				onDispatch: () => {
					dispatched++;
				},
			},
		);
		await flush();
		expect(dispatched).toBe(1);
		const frame = sentFrame(socket);
		socket.message({ type: "control_response", id: frame.id, ok: true, result: { retried: true } });
		await expect(retried).resolves.toMatchObject({ result: { retried: true } });
		await client.close();
	});
});
test("mutating the frame inside beforeDispatch cannot desynchronize the sent identity", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client);
		let mutationThrew: unknown;
		let observedOperation: unknown;

		const request = client.request(
			{ type: "control_request", operation: "turn.prompt", input: { text: "hi", nested: { keep: true } } },
			{
				idempotencyKey: "immutable-boundary",
				beforeDispatch: context => {
					observedOperation = context.frame.operation;
					try {
						// A hostile or buggy consumer tries to rewrite the frame it
						// was handed: the advertised identity must stay immutable.
						(context.frame as { operation?: string }).operation = "tampered.operation";
						(context.frame as { id?: string }).id = "tampered-id";
						((context.frame as { input?: { nested?: { keep?: boolean } } }).input ?? {}).nested = {};
					} catch (error) {
						mutationThrew = error;
					}
				},
			},
		);
		request.catch(() => undefined);
		await flush();

		// The wire carries the exact serialized request, not a mutated view.
		const wireFrame = sentFrame(socket);
		expect(wireFrame.operation).toBe("turn.prompt");
		expect(wireFrame.id).not.toBe("tampered-id");
		expect(wireFrame.input).toEqual({ text: "hi", nested: { keep: true } });
		expect(observedOperation).toBe("turn.prompt");
		// Frozen in strict mode a mutation throws; in sloppy mode it is a no-op.
		// Either way the request identity that went out is the serialized bytes.
		if (mutationThrew !== undefined) expect(mutationThrew).toBeInstanceOf(TypeError);

		socket.readyState = FakeWebSocket.CLOSED;
		socket.emit("close");
		await expect(request).rejects.toMatchObject({ code: "uncertain_after_send" });
		const record = client.getSentRecord(wireFrame.id as string);
		if (!record) throw new Error("sent record missing after uncertain dispatch");
		// Reconciliation identity derives from the exact serialized bytes: the
		// tampering attempt left no trace on operation or fingerprint inputs.
		expect(record.operation).toBe("turn.prompt");
		expect(record.idempotencyKey).toBe("immutable-boundary");
		await client.close();
	});
});
test("beforeDispatch closing the client prevents the send and keeps the boundary honest", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client);
		let dispatched = 0;
		let boundary = 0;

		const request = client.request(
			{ type: "control_request", operation: "turn.prompt" },
			{
				timeoutMs: 10_000,
				beforeDispatch: () => {
					boundary++;
					// Arbitrary synchronous caller code closes the whole client
					// while the request is mid-dispatch.
					void client.close();
				},
				onDispatch: () => {
					dispatched++;
				},
			},
		);
		request.catch(() => undefined);
		await flush();

		// Retirement settled the request pre-send: nothing may be written,
		// no sent record may exist, and no post-send observer may fire.
		expect(boundary).toBe(1);
		// Independently observed transport evidence: zero wire writes.
		expect(socket.sent).toHaveLength(0);
		expect(dispatched).toBe(0);
		await expect(request).rejects.toMatchObject({ code: "connection_closed" });
		// And no reconciliation record exists for any id this client saw: the
		// wire stayed empty, so there is nothing to retain.
		for (const wireEntry of socket.sent) {
			const sentId = (JSON.parse(wireEntry) as Record<string, unknown>).id;
			expect(client.getSentRecord(sentId as string)).toBeUndefined();
		}
		// The request's own identity (recovered from the boundary context frame)
		// also has no retained record after the pre-send retirement.
		const boundaryFrameIds: string[] = [];
		{
			const probeClient = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
			const probeSocket = await connect(probeClient, "probe");
			let capturedId = "";
			const probeRequest = probeClient.request(
				{ type: "control_request", operation: "turn.prompt" },
				{
					beforeDispatch: context => {
						if (typeof context.frame.id === "string") capturedId = context.frame.id;
						void probeClient.close();
					},
				},
			);
			probeRequest.catch(() => undefined);
			await flush();
			expect(probeSocket.sent).toHaveLength(0);
			expect(probeClient.getSentRecord(capturedId)).toBeUndefined();
			boundaryFrameIds.push(capturedId);
			expect(boundaryFrameIds).toHaveLength(1);
			await probeClient.close().catch(() => undefined);
		}
		socket.readyState = FakeWebSocket.CLOSED;
		socket.emit("close");
		await client.close().catch(() => undefined);
	});
});

test("beforeDispatch retiring the socket prevents the send without resurrecting reconciliation state", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client);
		let dispatched = 0;

		const request = client.request(
			{ type: "control_request", operation: "turn.prompt" },
			{
				timeoutMs: 10_000,
				beforeDispatch: () => {
					// The transport drops mid-callback but the client stays open.
					socket.readyState = FakeWebSocket.CLOSED;
					socket.emit("close");
				},
				onDispatch: () => {
					dispatched++;
				},
			},
		);
		request.catch(() => undefined);
		await flush();

		expect(socket.sent).toHaveLength(0);
		expect(dispatched).toBe(0);
		// Nothing reached the wire, so retirement is pre-send: plain
		// connection_closed, never uncertain_after_send, and no sent record.
		await expect(request).rejects.toMatchObject({ code: "connection_closed" });
		const wireIds = socket.sent.map(entry => (JSON.parse(entry) as Record<string, unknown>).id);
		for (const wireId of wireIds) expect(client.getSentRecord(wireId as string)).toBeUndefined();
		await client.close().catch(() => undefined);
	});
});

test("beforeDispatch consuming the deadline fails the request without sending", async () => {
	await withFakeTransport(async clock => {
		const client = new SdkClient("ws://sdk.test", "token", {
			reconnectAttempts: 0,
			deadline: 2_000,
		});
		const socket = await connect(client);
		let dispatched = 0;
		let boundary = 0;

		const request = client.request(
			{ type: "control_request", operation: "turn.prompt" },
			{
				timeoutMs: 10_000,
				beforeDispatch: () => {
					boundary++;
					// Burn the entire remaining deadline inside the callback.
					clock.now = 5_000;
				},
				onDispatch: () => {
					dispatched++;
				},
			},
		);
		request.catch(() => undefined);
		await flush();

		expect(boundary).toBe(1);
		expect(socket.sent).toHaveLength(0);
		expect(dispatched).toBe(0);
		await expect(request).rejects.toMatchObject({ code: "timeout" });
		await client.close().catch(() => undefined);
	});
});

test("mutating the options idempotency key inside beforeDispatch cannot diverge the sent record", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client);
		const options: {
			timeoutMs?: number;
			idempotencyKey?: string;
			onDispatch?: () => void;
			beforeDispatch?: () => void;
		} = {
			timeoutMs: 10_000,
			idempotencyKey: "original-key",
		};

		let boundary = 0;
		options.beforeDispatch = () => {
			boundary++;
			// Serialization already captured the key; the caller rewrites its own
			// options object mid-dispatch, after the bytes were derived.
			options.idempotencyKey = "mutated-after-handoff";
		};
		const request = client.request({ type: "control_request", operation: "turn.prompt", input: { n: 1 } }, options);
		request.catch(() => undefined);
		await flush();
		expect(boundary).toBe(1);

		const wireFrame = sentFrame(socket);
		expect(wireFrame.idempotencyKey).toBe("original-key");
		socket.readyState = FakeWebSocket.CLOSED;
		socket.emit("close");
		await expect(request).rejects.toMatchObject({ code: "uncertain_after_send" });
		const record = client.getSentRecord(wireFrame.id as string);
		if (!record) throw new Error("sent record missing");
		// The retained identity is snapshotted from the serialized bytes, so the
		// post-handoff mutation of the caller's object cannot reach it.
		expect(record.idempotencyKey).toBe("original-key");
		await client.close();
	});
});

test("a getter-swapping options object cannot alter reconciliation identity after dispatch", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client);
		let currentKey = "stable-key";
		const hostileOptions: {
			timeoutMs?: number;
			beforeDispatch?: () => void;
			get idempotencyKey(): string | undefined;
		} = {
			timeoutMs: 10_000,
			get idempotencyKey() {
				return currentKey;
			},
		};

		let boundary = 0;
		let getterDuringBoundary: string | undefined;
		const request = client.request({ type: "control_request", operation: "turn.prompt" }, hostileOptions);
		// The swap must happen INSIDE beforeDispatch so the test discriminates
		// the pre-observer snapshot from any post-callback reread: with the
		// getter already swapped at the boundary, a post-callback reread of
		// `options.idempotencyKey` would retain the swapped value.
		hostileOptions.beforeDispatch = () => {
			boundary++;
			getterDuringBoundary = hostileOptions.idempotencyKey;
			currentKey = "swapped-inside-boundary";
		};
		request.catch(() => undefined);
		await flush();

		expect(boundary).toBe(1);
		expect(getterDuringBoundary).toBe("stable-key");
		// The getter now returns the swapped value; nothing rereads it.
		expect(hostileOptions.idempotencyKey).toBe("swapped-inside-boundary");

		const wireFrame = sentFrame(socket);
		expect(wireFrame.idempotencyKey).toBe("stable-key");
		socket.readyState = FakeWebSocket.CLOSED;
		socket.emit("close");
		await expect(request).rejects.toMatchObject({ code: "uncertain_after_send" });
		const record = client.getSentRecord(wireFrame.id as string);
		if (!record) throw new Error("sent record missing");
		// Identity was snapshotted before observers ran; the later getter
		// swap cannot retroactively change the retained record.
		expect(record.idempotencyKey).toBe("stable-key");
		await client.close();
	});
});

test("synchronous send failure rejects as unavailable without onDispatch firing", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client);
		socket.throwOnSend = new Error("EPIPE");
		let dispatched = 0;
		const failed = client.request(
			{ type: "control_request", operation: "turn.prompt" },
			{
				onDispatch: () => {
					dispatched++;
				},
			},
		);
		await expect(failed).rejects.toMatchObject({
			code: "unavailable",
			message: "SDK WebSocket send failed",
		});
		expect(dispatched).toBe(0);
		// A failed write is not execution-uncertain: no sent record is retained.
		expect(socket.sent).toHaveLength(0);
		await client.close();
	});
});

test("a throwing onDispatch observer cannot displace transport settlement", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0, timeoutMs: 10_000 });
		const socket = await connect(client);
		const request = client.request(
			{ type: "control_request", operation: "turn.prompt" },
			{
				timeoutMs: 10_000,
				onDispatch: () => {
					throw new Error("observer bug");
				},
			},
		);
		request.catch(() => undefined);
		await flush();
		// The frame reached the wire; the request stays pending for real
		// settlement. The observer's own exception is never the request outcome
		// while the operation may already be running on the host.
		expect(socket.sent).toHaveLength(1);
		socket.readyState = FakeWebSocket.CLOSED;
		socket.emit("close");
		await expect(request).rejects.toMatchObject({ code: "uncertain_after_send" });
		await client.close().catch(() => undefined);
	});
});

test("reconnect moves the dispatch boundary to the new generation only", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 1, reconnectBackoffMs: 10 });
		const first = await connect(client, "generation-1");
		const generations: number[] = [];
		const connectionIds: Array<string | undefined> = [];

		const request = client.request(
			{ type: "control_request", operation: "turn.prompt" },
			{
				timeoutMs: 10_000,
				onDispatch: context => {
					generations.push(context.generation);
					connectionIds.push(context.connectionId);
				},
			},
		);
		await flush();
		// Transport dies after handoff; the request settles uncertain, not hung.
		first.readyState = FakeWebSocket.CLOSED;
		first.emit("close");
		await expect(request).rejects.toMatchObject({ code: "uncertain_after_send" });

		// A fresh request dispatches on the replacement transport.
		const afterReconnect = client.request(
			{ type: "control_request", operation: "next" },
			{
				timeoutMs: 10_000,
				onDispatch: context => {
					generations.push(context.generation);
					connectionIds.push(context.connectionId);
				},
			},
		);
		await flush();
		const replacement = FakeWebSocket.instances[1];
		replacement.open();
		replacement.message({ type: "hello", connectionId: "generation-2" });
		for (let index = 0; index < 4; index++) await flush();
		const replacementFrame = sentFrame(replacement);
		replacement.message({ type: "control_response", id: replacementFrame.id, ok: true });
		await expect(afterReconnect).resolves.toMatchObject({ ok: true });

		expect(generations).toHaveLength(2);
		expect(generations[1]).toBeGreaterThan(generations[0]);
		expect(connectionIds[0]).toBe("generation-1");
		expect(connectionIds[1]).toBe("generation-2");
		await client.close();
	});
});

test("connected-only prepared dispatch fails pre-send without reconnecting", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 3, reconnectBackoffMs: 10 });
		const socket = await connect(client, "prepared");
		socket.readyState = FakeWebSocket.CLOSED;
		socket.emit("close");
		const instances = FakeWebSocket.instances.length;
		let dispatched = false;
		await expect(
			client.request(
				{ type: "control_request", operation: "turn.prompt" },
				{ connectedOnly: true, beforeDispatch: () => (dispatched = true) },
			),
		).rejects.toMatchObject({ code: "connection_closed" });
		expect(dispatched).toBe(false);
		expect(FakeWebSocket.instances).toHaveLength(instances);
		await client.close().catch(() => undefined);
	});
});

test("connected-only brands closed and expired clients as prepared failures", async () => {
	await withFakeTransport(async () => {
		const closed = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		await closed.close();
		await expect(
			closed.request({ type: "control_request", operation: "closed" }, { connectedOnly: true }),
		).rejects.toBeInstanceOf(SdkPreparedDispatchError);

		const expired = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0, deadline: Date.now() - 1 });
		await expect(
			expired.request({ type: "control_request", operation: "expired" }, { connectedOnly: true }),
		).rejects.toBeInstanceOf(SdkPreparedDispatchError);
		await expired.close().catch(() => undefined);
	});
});

test("connected-only keeps observer-triggered retirement prepared", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client, "prepared-observer");
		const request = client.request(
			{ type: "control_request", operation: "turn.prompt" },
			{
				connectedOnly: true,
				beforeDispatch: () => {
					socket.readyState = FakeWebSocket.CLOSED;
					socket.emit("close");
				},
			},
		);
		await expect(request).rejects.toBeInstanceOf(SdkPreparedDispatchError);
		expect(socket.sent).toHaveLength(0);
		await client.close().catch(() => undefined);
	});
});

test("connected-only preserves a post-wire unavailable response as non-prepared", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client, "prepared-response");
		const request = client.request({ type: "control_request", operation: "turn.prompt" }, { connectedOnly: true });
		await flush();
		const frame = sentFrame(socket);
		socket.message({
			type: "control_response",
			id: frame.id,
			ok: false,
			error: { code: "unavailable", message: "busy" },
		});
		try {
			await request;
			throw new Error("Expected unavailable response");
		} catch (error) {
			expect(error).toMatchObject({ code: "unavailable" });
			expect(error).not.toBeInstanceOf(SdkPreparedDispatchError);
		}
		await client.close();
	});
});

test("stale-generation close events never retire requests on the active transport", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 1, reconnectBackoffMs: 10 });
		const first = await connect(client, "stale-1");
		// Capture the retired transport's close listeners before it goes down.
		const staleCloseListeners = first.snapshot("close");
		first.readyState = FakeWebSocket.CLOSED;
		first.emit("close");

		const request = client.request(
			{ type: "control_request", operation: "active" },
			{
				timeoutMs: 10_000,
				onDispatch: () => undefined,
			},
		);
		await flush();
		const replacement = FakeWebSocket.instances[1];
		replacement.open();
		replacement.message({ type: "hello", connectionId: "active-2" });
		for (let index = 0; index < 4; index++) await flush();
		const activeFrame = sentFrame(replacement);

		// A late close event from the retired transport generation arrives while
		// a new request is pending on the active transport.
		for (const listener of staleCloseListeners) {
			const event = new Event("close");
			if (typeof listener === "function") listener.call(first, event);
			else listener.handleEvent(event);
		}
		// The active request must survive the stale event and settle by response.
		replacement.message({ type: "control_response", id: activeFrame.id, ok: true, result: { alive: true } });
		await expect(request).resolves.toMatchObject({ result: { alive: true } });
		await client.close();
	});
});

test("concurrent dispatch-aware requests settle independently with their own boundaries", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client, "concurrent");
		const boundaries: string[] = [];
		const seenIds = new Set<string>();

		const requests = [1, 2, 3].map(index =>
			client
				.request(
					{ type: "control_request", operation: `op-${index}` },
					{
						onDispatch: context => {
							if (typeof context.frame.id !== "string") throw new Error("id missing");
							if (seenIds.has(context.frame.id)) throw new Error("duplicate boundary id");
							seenIds.add(context.frame.id);
							boundaries.push(`op-${index}`);
						},
					},
				)
				.catch(error => ({ error: (error as SdkClientError).code })),
		);
		await flush();
		expect(boundaries).toEqual(["op-1", "op-2", "op-3"]);
		expect(socket.sent).toHaveLength(3);

		for (let index = 0; index < 3; index++) {
			const frame = sentFrame(socket, index);
			socket.message({ type: "control_response", id: frame.id, ok: true, result: { index } });
		}
		const outcomes = await Promise.all(requests);
		expect(outcomes.map(outcome => (outcome as { ok: boolean }).ok ?? outcome)).toEqual([true, true, true]);
		await client.close();
	});
});

test("control and global expose the same dispatch boundary as request", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client, "api-parity");
		const boundaryOperations: string[] = [];

		const controlRequest = client.control(
			"turn.prompt",
			{ text: "hi" },
			{
				onDispatch: context => {
					if (typeof context.frame.operation !== "string") throw new Error("operation missing");
					boundaryOperations.push(context.frame.operation);
				},
			},
		);
		const globalRequest = client.global(
			"session.list",
			{},
			{
				onDispatch: context => {
					if (typeof context.frame.operation !== "string") throw new Error("operation missing");
					boundaryOperations.push(context.frame.operation);
				},
			},
		);
		await flush();
		expect(boundaryOperations).toEqual(["turn.prompt", "session.list"]);
		const controlFrame = sentFrame(socket, 0);
		const globalFrame = sentFrame(socket, 1);
		expect(controlFrame).toMatchObject({ type: "control_request", operation: "turn.prompt" });
		expect(globalFrame).toMatchObject({ type: "broker_request", operation: "session.list" });
		socket.message({ type: "control_response", id: controlFrame.id, ok: true, result: { control: true } });
		socket.message({ type: "broker_response", id: globalFrame.id, ok: true, result: { global: true } });
		await expect(controlRequest).resolves.toMatchObject({ result: { control: true } });
		await expect(globalRequest).resolves.toMatchObject({ result: { global: true } });
		await client.close();
	});
});

test("query exposes the same dispatch boundary as request", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client, "query-parity");
		const boundaryOperations: string[] = [];

		const queryRequest = client.query("sessions.list", { filter: "active" }, "cursor-1", {
			onDispatch: context => {
				if (typeof context.frame.query !== "string") throw new Error("query missing");
				boundaryOperations.push(context.frame.query);
			},
		});
		await flush();
		expect(boundaryOperations).toEqual(["sessions.list"]);
		const frame = sentFrame(socket);
		expect(frame).toMatchObject({ type: "query_request", query: "sessions.list", cursor: "cursor-1" });
		socket.message({ type: "query_response", id: frame.id, ok: true, result: { items: [] } });
		await expect(queryRequest).resolves.toMatchObject({ ok: true });
		await client.close();
	});
});

test("an async beforeDispatch rejection fails pre-send and never escapes unhandled", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client);
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", onUnhandled);
		let dispatched = 0;
		try {
			const request = client.request(
				{ type: "control_request", operation: "turn.prompt" },
				{
					timeoutMs: 10_000,
					// An async observer returns a rejected promise: TS accepts it,
					// but the synchronous pre-send contract cannot wait for it.
					beforeDispatch: async () => {
						throw new Error("async observer aborted");
					},
					onDispatch: () => {
						dispatched++;
					},
				},
			);
			request.catch(() => undefined);
			await flush();
			// The dispatch aborts pre-send: nothing on the wire, no onDispatch,
			// retryable typed rejection — the caller's abort intent is honored.
			expect(socket.sent).toHaveLength(0);
			expect(dispatched).toBe(0);
			await expect(request).rejects.toMatchObject({ code: "invalid_input" });
			// Give the sunk rejection a microtask to (not) surface.
			await flush();
			await flush();
			expect(unhandled).toHaveLength(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			await client.close().catch(() => undefined);
		}
	});
});

test("an async onDispatch rejection is sunk without displacing settlement", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client);
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const request = client.request(
				{ type: "control_request", operation: "turn.prompt" },
				{
					timeoutMs: 10_000,
					onDispatch: async () => {
						throw new Error("async observer exploded");
					},
				},
			);
			request.catch(() => undefined);
			await flush();
			// The frame went out; the request stays pending for real settlement.
			expect(socket.sent).toHaveLength(1);
			const frame = sentFrame(socket);
			socket.message({ type: "control_response", id: frame.id, ok: true, result: { settled: true } });
			await expect(request).resolves.toMatchObject({ result: { settled: true } });
			await flush();
			await flush();
			expect(unhandled).toHaveLength(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			await client.close().catch(() => undefined);
		}
	});
});

test("client close after dispatch settles the request as uncertain, not hung", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0, timeoutMs: 10_000 });
		const socket = await connect(client);
		socket.deferClose = true;
		const request = client.request(
			{ type: "control_request", operation: "turn.prompt" },
			{
				timeoutMs: 10_000,
				onDispatch: () => {
					void client.close();
				},
			},
		);
		request.catch(() => undefined);
		await flush();
		expect(socket.readyState).toBe(FakeWebSocket.CLOSING);
		socket.readyState = FakeWebSocket.CLOSED;
		socket.emit("close");
		await expect(request).rejects.toMatchObject({ code: "uncertain_after_send" });
	});
});

test("socket error after dispatch settles unavailable as uncertain", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0, timeoutMs: 10_000 });
		const socket = await connect(client);
		const request = client.request({ type: "control_request", operation: "turn.prompt" });
		await flush();
		socket.emit("error", new Event("error"));
		await expect(request).rejects.toMatchObject({ code: "uncertain_after_send" });
		await client.close().catch(() => undefined);
	});
});

test("lifecycle requests retain reconciliation identity after a dispatch-aware uncertain send", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client);
		let sentId: string | undefined;
		const created = client.global(
			"session.create",
			{ cwd: "/repo" },
			{
				idempotencyKey: "dispatch-lifecycle",
				onDispatch: context => {
					if (typeof context.frame.id !== "string") throw new Error("id missing");
					sentId = context.frame.id;
				},
			},
		);
		await flush();
		const frame = sentFrame(socket);
		expect(frame.id).toBe(sentId);
		socket.readyState = FakeWebSocket.CLOSED;
		socket.emit("close");
		await expect(created).rejects.toMatchObject({ code: "uncertain_after_send" });
		const record = client.getSentRecord(sentId!);
		if (!record) throw new Error("sent record missing after uncertain dispatch");
		expect(record).toMatchObject({
			id: sentId,
			operation: "session.create",
			idempotencyKey: "dispatch-lifecycle",
		});
		await client.close();
	});
});

test("a send that synchronously closes the socket retires the request as sent, not pre-send", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0, timeoutMs: 10_000 });
		const socket = await connect(client);
		let dispatched = 0;
		let settlements = 0;

		socket.onSendReentrant = () => {
			// The transport dies INSIDE send(): reentrant close handling runs
			// before #request returns from the wire write.
			socket.readyState = FakeWebSocket.CLOSED;
			socket.emit("close");
		};

		const request = client.request(
			{ type: "control_request", operation: "turn.prompt" },
			{
				timeoutMs: 10_000,
				onDispatch: () => {
					dispatched++;
				},
			},
		);
		request.catch(() => undefined).finally(() => settlements++);

		await flush();
		// The handoff bookkeeping (sent + sent record) was established BEFORE
		// the write, so the reentrant retirement classified this request as
		// already-sent: uncertain_after_send, never pre-send, exactly once.
		await expect(request).rejects.toMatchObject({ code: "uncertain_after_send" });
		await flush();
		expect(settlements).toBe(1);
		// The boundary observer still fired exactly once for the accepted frame.
		expect(dispatched).toBe(1);
		const frame = sentFrame(socket);
		const record = client.getSentRecord(frame.id as string);
		if (!record) throw new Error("sent record missing after reentrant close");
		expect(record.operation).toBe("turn.prompt");
		await client.close().catch(() => undefined);
	});
});

test("a send that synchronously delivers the response settles exactly once with no duplicate retry state", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client);
		let settlements = 0;
		let dispatched = 0;

		socket.onSendReentrant = value => {
			// The server replies INSIDE send(): reentrant response handling runs
			// while the wire write is still on the stack.
			const frame = JSON.parse(value) as Record<string, unknown>;
			socket.message({ type: "control_response", id: frame.id, ok: true, result: { reentrant: true } });
		};

		const request = client.request(
			{ type: "control_request", operation: "turn.prompt" },
			{
				onDispatch: () => {
					dispatched++;
				},
			},
		);
		request.then(
			() => settlements++,
			() => settlements++,
		);

		await flush();
		await expect(request).resolves.toMatchObject({ result: { reentrant: true } });
		await flush();
		expect(settlements).toBe(1);
		expect(dispatched).toBe(1);
		// The already-settled request leaves no resurrected sent record behind.
		const frame = sentFrame(socket);
		expect(client.getSentRecord(frame.id as string)).toBeUndefined();
		await client.close();
	});
});

test("a send that throws after a reentrant close keeps the reentrant settlement", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client);
		socket.onSendReentrant = () => {
			// Close fires during send, then the write itself throws: the close
			// settlement (uncertain, because handoff state said sent) must not
			// be displaced by the send-failure rollback.
			socket.readyState = FakeWebSocket.CLOSED;
			socket.emit("close");
			throw new Error("EPIPE mid-send");
		};

		const request = client.request({ type: "control_request", operation: "turn.prompt" }, { timeoutMs: 10_000 });
		request.catch(() => undefined);
		await flush();
		// Bytes may or may not have been accepted before the throw; the close
		// already settled this request as sent-uncertain, and that stands.
		await expect(request).rejects.toMatchObject({ code: "uncertain_after_send" });
		await client.close().catch(() => undefined);
	});
});

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
