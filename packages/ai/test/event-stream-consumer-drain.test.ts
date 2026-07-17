import { describe, expect, it } from "bun:test";
import { EventStream } from "../src/utils/event-stream";

type Event = { id: string };

function deferred<T = void>(): PromiseWithResolvers<T> {
	return Promise.withResolvers<T>();
}

function createStream(): EventStream<Event, void> {
	return new EventStream<Event, void>(
		() => false,
		() => undefined,
	);
}

function createTrackedAbortController(): {
	controller: AbortController;
	listenerCount: () => number;
	addCalls: () => number;
} {
	const controller = new AbortController();
	const signal = controller.signal;
	const originalAddEventListener = signal.addEventListener.bind(signal);
	const originalRemoveEventListener = signal.removeEventListener.bind(signal);
	const listeners = new Set<unknown>();

	let adds = 0;

	Object.defineProperties(signal, {
		addEventListener: {
			value: (type: string, listener: unknown, options?: boolean | AddEventListenerOptions) => {
				if (type === "abort") {
					adds += 1;
					listeners.add(listener);
				}
				originalAddEventListener(type as "abort", listener as never, options);
			},
		},
		removeEventListener: {
			value: (type: string, listener: unknown, options?: boolean | EventListenerOptions) => {
				if (type === "abort") listeners.delete(listener);
				originalRemoveEventListener(type as "abort", listener as never, options);
			},
		},
	});

	return {
		controller,
		listenerCount: () => listeners.size,
		addCalls: () => adds,
	};
}

describe("EventStream.waitForConsumerDrain", () => {
	it("waits for FIFO consumer bodies before resolving the private sentinel", async () => {
		const stream = createStream();
		const enteredA = deferred();
		const releaseA = deferred();
		const enteredB = deferred();
		const releaseB = deferred();
		const seen: string[] = [];
		const consumer = (async () => {
			for await (const event of stream) {
				seen.push(event.id);
				if (event.id === "A") {
					enteredA.resolve();
					await releaseA.promise;
				} else if (event.id === "B") {
					enteredB.resolve();
					await releaseB.promise;
				}
			}
		})();

		stream.push({ id: "A" });
		await enteredA.promise;
		stream.push({ id: "B" });
		const drain = stream.waitForConsumerDrain(new AbortController().signal);
		let settled = false;
		void drain.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		await Promise.resolve();
		expect(settled).toBe(false);
		releaseA.resolve();
		await enteredB.promise;
		await Promise.resolve();
		expect(settled).toBe(false);
		releaseB.resolve();
		await expect(drain).resolves.toBeUndefined();
		expect(seen).toEqual(["A", "B"]);

		stream.end();
		await consumer;
	});

	it("preserves concurrent sentinel ordering without yielding sentinel events", async () => {
		const stream = createStream();
		const iterator = stream[Symbol.asyncIterator]();
		stream.push({ id: "A" });
		expect(await iterator.next()).toMatchObject({ done: false, value: { id: "A" } });

		const order: string[] = [];
		const first = stream.waitForConsumerDrain(new AbortController().signal).then(() => order.push("first"));
		const second = stream.waitForConsumerDrain(new AbortController().signal).then(() => order.push("second"));
		expect(stream.pendingConsumerDrainCountForTests).toBe(2);
		expect(stream.queue).toEqual([]);

		const next = iterator.next();
		await Promise.all([first, second]);
		expect(order).toEqual(["first", "second"]);
		expect(stream.pendingConsumerDrainCountForTests).toBe(0);

		stream.end();
		expect(await next).toEqual({ value: undefined, done: true });
	});

	it("rejects queued sentinels on source abort and leaves tombstones inert", async () => {
		const stream = createStream();
		const enteredA = deferred();
		const releaseA = deferred();
		const enteredB = deferred();
		const releaseB = deferred();
		const consumer = (async () => {
			for await (const event of stream) {
				if (event.id === "A") {
					enteredA.resolve();
					await releaseA.promise;
				} else if (event.id === "B") {
					enteredB.resolve();
					await releaseB.promise;
				}
			}
		})();

		stream.push({ id: "A" });
		await enteredA.promise;
		stream.push({ id: "B" });
		const tracked = createTrackedAbortController();
		const drain = stream.waitForConsumerDrain(tracked.controller.signal);
		let settlements = 0;
		void drain.then(
			() => {
				settlements += 1;
			},
			() => {
				settlements += 1;
			},
		);
		expect(tracked.addCalls()).toBe(1);
		expect(tracked.listenerCount()).toBe(1);

		const reason = new Error("source aborted");
		tracked.controller.abort(reason);
		await expect(drain).rejects.toBe(reason);
		expect(stream.pendingConsumerDrainCountForTests).toBe(0);
		expect(tracked.listenerCount()).toBe(0);
		expect(settlements).toBe(1);

		releaseA.resolve();
		await enteredB.promise;
		releaseB.resolve();
		await Promise.resolve();
		expect(settlements).toBe(1);

		stream.end();
		await consumer;
	});

	it("rejects an already-aborted source without enqueuing or registering a listener", async () => {
		const stream = createStream();
		const tracked = createTrackedAbortController();
		const reason = new Error("already aborted");
		tracked.controller.abort(reason);

		await expect(stream.waitForConsumerDrain(tracked.controller.signal)).rejects.toBe(reason);
		expect(stream.pendingConsumerDrainCountForTests).toBe(0);
		expect(stream.queue).toEqual([]);
		expect(tracked.addCalls()).toBe(0);
		expect(tracked.listenerCount()).toBe(0);
	});

	it("does not report a successful drain before a held consumer body finishes when the stream ends", async () => {
		const stream = createStream();
		const entered = deferred();
		const release = deferred();
		const consumer = (async () => {
			for await (const _event of stream) {
				entered.resolve();
				await release.promise;
			}
		})();

		stream.push({ id: "held" });
		await entered.promise;
		const drain = stream.waitForConsumerDrain(new AbortController().signal);
		let settled = false;
		void drain.then(() => {
			settled = true;
		});
		stream.end();
		await Promise.resolve();
		expect(settled).toBe(false);

		release.resolve();
		await expect(drain).resolves.toBeUndefined();
		await consumer;
	});

	it("waits for queued events when drain admission happens after end", async () => {
		const stream = createStream();
		const enteredA = deferred();
		const releaseA = deferred();
		const seen: string[] = [];
		const consumer = (async () => {
			for await (const event of stream) {
				seen.push(event.id);
				if (event.id === "A") {
					enteredA.resolve();
					await releaseA.promise;
				}
			}
		})();

		stream.push({ id: "A" });
		await enteredA.promise;
		stream.push({ id: "B" });
		stream.end();
		const drain = stream.waitForConsumerDrain(new AbortController().signal);
		let settled = false;
		void drain.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		releaseA.resolve();
		await expect(drain).resolves.toBeUndefined();
		expect(seen).toEqual(["A", "B"]);
		await consumer;
	});

	it("waits for queued events when a terminal event precedes drain admission", async () => {
		const stream = new EventStream<Event, void>(
			event => event.id === "done",
			() => undefined,
		);
		const entered = deferred();
		const release = deferred();
		const seen: string[] = [];
		const consumer = (async () => {
			for await (const event of stream) {
				seen.push(event.id);
				if (event.id === "held") {
					entered.resolve();
					await release.promise;
				}
			}
		})();

		stream.push({ id: "held" });
		await entered.promise;
		stream.push({ id: "queued" });
		stream.push({ id: "done" });
		const drain = stream.waitForConsumerDrain(new AbortController().signal);
		let settled = false;
		void drain.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		release.resolve();
		await expect(drain).resolves.toBeUndefined();
		expect(seen).toEqual(["held", "queued", "done"]);
		await consumer;
	});

	it("rejects and detaches unconsumed pending drains when streams end or fail", async () => {
		const ended = createStream();
		const endTracked = createTrackedAbortController();
		const endDrain = ended.waitForConsumerDrain(endTracked.controller.signal);
		expect(ended.pendingConsumerDrainCountForTests).toBe(1);
		ended.end();
		await expect(endDrain).rejects.toThrow("Event stream ended before consumer drain completed");
		expect(ended.pendingConsumerDrainCountForTests).toBe(0);
		expect(endTracked.listenerCount()).toBe(0);

		const failed = createStream();
		const failTracked = createTrackedAbortController();
		const failure = new Error("stream failed");
		const failDrain = failed.waitForConsumerDrain(failTracked.controller.signal);
		expect(failed.pendingConsumerDrainCountForTests).toBe(1);
		failed.fail(failure);
		await expect(failDrain).rejects.toBe(failure);
		expect(failed.pendingConsumerDrainCountForTests).toBe(0);
		expect(failTracked.listenerCount()).toBe(0);
	});
});
