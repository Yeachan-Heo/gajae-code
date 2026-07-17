import type { AssistantMessage, AssistantMessageEvent } from "../types";

interface EventQueueNode<T> {
	type: "event";
	event: T;
}

type QueueNode<T> = EventQueueNode<T> | { type: "consumer-drain"; drain: ConsumerDrain };

interface ConsumerDrain {
	settled: boolean;
	signal: AbortSignal;
	abortListener: () => void;
	resolve: () => void;
	reject: (reason: unknown) => void;
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

// Generic event stream class for async iteration

export class EventStream<T, R = T> implements AsyncIterable<T> {
	#queue: QueueNode<T>[] = [];
	#queueHead = 0;
	waiting: Array<{ resolve: (value: IteratorResult<T>) => void; reject: (err: unknown) => void }> = [];
	#pendingConsumerDrains = new Set<ConsumerDrain>();
	#activeConsumerCount = 0;
	done = false;
	#failed = false;
	#error: unknown = undefined;
	finalResultPromise: Promise<R>;
	resolveFinalResult!: (result: R) => void;
	rejectFinalResult!: (err: unknown) => void;
	isComplete: (event: T) => boolean;
	extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		const { promise, resolve, reject } = Promise.withResolvers<R>();
		// Prevent an unhandled rejection when fail() is called but nobody awaits result().
		// Callers who do await result() still receive the rejection normally.
		promise.catch(() => {});
		this.finalResultPromise = promise;
		this.resolveFinalResult = resolve;
		this.rejectFinalResult = reject;
		this.isComplete = isComplete;
		this.extractResult = extractResult;
	}

	#enqueue(node: QueueNode<T>): void {
		this.#queue.push(node);
	}

	#dequeue(): QueueNode<T> | undefined {
		if (this.#queueHead >= this.#queue.length) return undefined;
		const node = this.#queue[this.#queueHead]!;
		this.#queue[this.#queueHead] = undefined as unknown as QueueNode<T>;
		this.#queueHead++;
		if (this.#queueHead > 1024 && this.#queueHead * 2 >= this.#queue.length) {
			this.#queue = this.#queue.slice(this.#queueHead);
			this.#queueHead = 0;
		}
		return node;
	}

	get #queueLength(): number {
		return this.#queue.length - this.#queueHead;
	}

	/**
	 * Read-only snapshot of the not-yet-consumed events. Always a fresh copy:
	 * external code can never mutate internal queue state or observe head-index
	 * tombstones or private consumer-drain sentinels, so the deque cannot desynchronize.
	 */
	get queue(): T[] {
		return this.#queue.slice(this.#queueHead).flatMap(node => (node.type === "event" ? [node.event] : []));
	}

	/** Read-only test seam for outstanding consumer-drain waiters. */
	get pendingConsumerDrainCountForTests(): number {
		return this.#pendingConsumerDrains.size;
	}

	#settleConsumerDrain(drain: ConsumerDrain, status: "resolve" | "reject", reason?: unknown): void {
		if (drain.settled) return;
		drain.settled = true;
		this.#pendingConsumerDrains.delete(drain);
		drain.signal.removeEventListener("abort", drain.abortListener);
		if (status === "resolve") {
			drain.resolve();
		} else {
			drain.reject(reason);
		}
	}

	#settleAllConsumerDrains(status: "resolve" | "reject", reason?: unknown): void {
		for (const drain of this.#pendingConsumerDrains) {
			this.#settleConsumerDrain(drain, status, reason);
		}
	}

	#drainQueuedNodesToWaitingConsumers(): void {
		while (this.waiting.length > 0 && this.#queueLength > 0) {
			const node = this.#dequeue()!;
			if (node.type === "consumer-drain") {
				this.#settleConsumerDrain(node.drain, "resolve");

				continue;
			}
			this.waiting.shift()!.resolve({ value: node.event, done: false });
		}
	}

	#dequeueEvent(): EventQueueNode<T> | undefined {
		while (this.#queueLength > 0) {
			const node = this.#dequeue()!;
			if (node.type === "event") return node;
			this.#settleConsumerDrain(node.drain, "resolve");
		}
		return undefined;
	}

	push(event: T): void {
		if (this.done) return;
		try {
			if (this.isComplete(event)) {
				const result = this.extractResult(event);
				this.done = true;
				this.resolveFinalResult(result);
			}
		} catch (error) {
			this.fail(error);
			return;
		}
		this.deliver(event);
	}

	deliver(event: T): void {
		if (this.#queueLength === 0) {
			const waiter = this.waiting.shift();
			if (waiter) {
				waiter.resolve({ value: event, done: false });
				return;
			}
		}
		this.#enqueue({ type: "event", event });
		this.#drainQueuedNodesToWaitingConsumers();
	}

	/**
	 * Resolves after every event enqueued before this call has been yielded and
	 * the consumer asks the iterator for its next node. The private sentinel is
	 * never exposed through the async iterator.
	 */
	waitForConsumerDrain(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return Promise.reject(abortReason(signal));
		if (this.#failed) return Promise.reject(this.#error);
		if (this.done && this.#activeConsumerCount === 0) {
			if (this.#queueLength === 0) return Promise.resolve();
			return Promise.reject(new Error("Event stream ended before queued events could be drained"));
		}

		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let drain!: ConsumerDrain;
		const abortListener = () => this.#settleConsumerDrain(drain, "reject", abortReason(signal));

		drain = { settled: false, signal, abortListener, resolve, reject };
		this.#pendingConsumerDrains.add(drain);
		signal.addEventListener("abort", abortListener, { once: true });
		this.#enqueue({ type: "consumer-drain", drain });
		this.#drainQueuedNodesToWaitingConsumers();
		return promise;
	}

	end(result?: R): void {
		this.done = true;
		if (this.#activeConsumerCount === 0) {
			this.#settleAllConsumerDrains("reject", new Error("Event stream ended before consumer drain completed"));
		}

		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter.resolve({ value: undefined as any, done: true });
		}
	}

	endWaiting(): void {
		if (this.#activeConsumerCount === 0) {
			this.#settleAllConsumerDrains("reject", new Error("Event stream ended before consumer drain completed"));
		}
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter.resolve({ value: undefined as any, done: true });
		}
	}

	fail(err: unknown): void {
		if (this.done) return;
		this.done = true;
		this.#failed = true;
		this.#error = err;
		this.#settleAllConsumerDrains("reject", err);

		this.rejectFinalResult(err);
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter.reject(err);
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		this.#activeConsumerCount += 1;
		try {
			while (true) {
				const node = this.#dequeueEvent();
				if (node !== undefined) {
					yield node.event;
				} else if (this.#failed) {
					throw this.#error;
				} else if (this.done) {
					return;
				} else {
					const result = await new Promise<IteratorResult<T>>((resolve, reject) =>
						this.waiting.push({ resolve, reject }),
					);
					if (result.done) return;
					yield result.value;
				}
			}
		} finally {
			this.#activeConsumerCount -= 1;
			this.#settleAllConsumerDrains("reject", new Error("Event stream consumer stopped before drain completed"));
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			event => event.type === "done" || event.type === "error",
			event => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}
