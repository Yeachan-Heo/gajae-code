import { expect, test } from "bun:test";
import { ACP_SESSION_RECONNECT, AcpSdkAdapter } from "../src/sdk/acp";
import { HEARTBEAT_TTL_MS } from "../src/sdk/bus/daemon-paths";

type FakeListener = ((event: Event) => void) | { handleEvent(event: Event): void };
type FakeListenerOptions = { once?: boolean };

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];
	readonly listeners = new Map<string, Map<FakeListener, FakeListenerOptions>>();
	readyState = FakeWebSocket.CONNECTING;

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

	close(): void {
		this.readyState = FakeWebSocket.CLOSED;
	}

	send(): void {}

	emit(type: string, event = new Event(type)): void {
		for (const [listener, options] of [...(this.listeners.get(type) ?? [])]) {
			if (options.once) this.removeEventListener(type, listener);
			if (typeof listener === "function") listener.call(this, event);
			else listener.handleEvent(event);
		}
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
		const target = this.now + milliseconds;
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

	pendingDelays(): number[] {
		return [...this.tasks.values()].map(task => task.due - this.now);
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

const flush = (): Promise<void> => new Promise<void>(resolve => queueMicrotask(resolve));

function expectedBackoffs(): number[] {
	return Array.from({ length: ACP_SESSION_RECONNECT.reconnectAttempts }, (_, attempt) =>
		Math.min(ACP_SESSION_RECONNECT.reconnectBackoffMs * 2 ** attempt, ACP_SESSION_RECONNECT.reconnectMaxBackoffMs),
	);
}

/** Drives a dead endpoint to reconnect exhaustion and records every backoff sleep. */
async function drainReconnects(clock: FakeClock, attempt = 0): Promise<number[]> {
	const observed: number[] = [];
	for (let index = attempt; ; index++) {
		const socket = FakeWebSocket.instances[index];
		if (!socket) break;
		socket.emit("error");
		for (let tick = 0; tick < 4; tick++) await flush();
		const pending = clock.pendingDelays();
		if (pending.length === 0) break;
		// The failed incarnation clears its open timer, so only the backoff sleep is pending.
		expect(pending).toHaveLength(1);
		observed.push(pending[0]);
		clock.advanceBy(pending[0]);
		for (let tick = 0; tick < 4; tick++) await flush();
	}
	return observed;
}

test("ACP session reconnect budget outlives the host heartbeat TTL", () => {
	const backoffs = expectedBackoffs();
	const totalBudgetMs = backoffs.reduce((total, backoff) => total + backoff, 0);
	// The host drops a session whose client has not ponged within HEARTBEAT_TTL_MS,
	// so a shorter client budget makes every host-reaped stall unrecoverable.
	expect(totalBudgetMs).toBeGreaterThan(HEARTBEAT_TTL_MS);
	// Recovery must stay prompt: no single sleep may swallow the whole TTL.
	expect(Math.max(...backoffs)).toBe(ACP_SESSION_RECONNECT.reconnectMaxBackoffMs);
	expect(ACP_SESSION_RECONNECT.reconnectMaxBackoffMs).toBeLessThan(HEARTBEAT_TTL_MS);
});

test("AcpSdkAdapter constructor path gives its SdkClient the ACP reconnect budget", async () => {
	await withFakeTransport(async clock => {
		const adapter = new AcpSdkAdapter({ url: "ws://acp.test", token: "token" });
		const starting = adapter.start();
		const observed = await drainReconnects(clock);
		await expect(starting).rejects.toMatchObject({ code: "reconnect_exhausted" });
		expect(observed).toEqual(expectedBackoffs());
		expect(FakeWebSocket.instances).toHaveLength(ACP_SESSION_RECONNECT.reconnectAttempts + 1);
		await adapter.close();
	});
});

test("AcpSdkAdapter.connect gives its SdkClient the ACP reconnect budget", async () => {
	await withFakeTransport(async clock => {
		const connecting = AcpSdkAdapter.connect({ url: "ws://acp.test", token: "token" });
		const observed = await drainReconnects(clock);
		await expect(connecting).rejects.toMatchObject({ code: "reconnect_exhausted" });
		expect(observed).toEqual(expectedBackoffs());
		expect(FakeWebSocket.instances).toHaveLength(ACP_SESSION_RECONNECT.reconnectAttempts + 1);
	});
});
