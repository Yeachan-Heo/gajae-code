import { expect } from "bun:test";

type FakeListener = ((event: Event) => void) | { handleEvent(event: Event): void };
type FakeListenerOptions = { once?: boolean };

export class FakeWebSocket {
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

	/** Frames the client handed to this socket, in order, as sent JSON. */
	readonly sent: string[] = [];
	/** Answers a frame this socket carried out, the way a live peer would. */
	onSend: ((data: string) => void) | undefined;

	send(data?: string): void {
		if (typeof data !== "string") return;
		this.sent.push(data);
		this.onSend?.(data);
	}

	/** Completes the dial: the client speaks only once its socket is open. */
	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.emit("open");
	}

	/** Delivers one server frame to the client. */
	deliver(frame: Record<string, unknown>): void {
		this.emit("message", new MessageEvent("message", { data: JSON.stringify(frame) }));
	}

	/**
	 * Loses an already-open socket the way a dropped connection does: the peer is
	 * gone and the client is told, but nothing about the session ended.
	 */
	drop(): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.emit("close");
	}

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

export class FakeClock {
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

export async function withFakeTransport(run: (clock: FakeClock) => Promise<void>): Promise<void> {
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

export type SessionReconnectBudget = Readonly<{
	reconnectAttempts: number;
	reconnectBackoffMs: number;
	reconnectMaxBackoffMs: number;
}>;

/** The exact sleep schedule a client configured with `budget` must follow. */
export function expectedBackoffs(budget: SessionReconnectBudget): number[] {
	return Array.from({ length: budget.reconnectAttempts }, (_, attempt) =>
		Math.min(budget.reconnectBackoffMs * 2 ** attempt, budget.reconnectMaxBackoffMs),
	);
}

/** Drives a dead endpoint to reconnect exhaustion and records every backoff sleep. */
export async function drainReconnects(clock: FakeClock, attempt = 0): Promise<number[]> {
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
