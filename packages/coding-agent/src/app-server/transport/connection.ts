// app-server per-connection bounded outbound queue.
//
// Each transport connection gets its own bounded queue. A slow writer pauses producers
// until the outbound queue drains, preserving every accepted frame in FIFO order.

export interface BoundedOutboundOptions {
	/** Max queued outbound frames before producers wait for capacity. */
	readonly capacity?: number;
	/** Called to actually send a frame to the transport. */
	readonly send: (frame: Uint8Array) => Promise<void>;
}

export const DEFAULT_OUTBOUND_QUEUE_CAPACITY = 256;

export class BoundedOutboundQueue {
	readonly #capacity: number;
	readonly #send: (frame: Uint8Array) => Promise<void>;
	#queue: Array<{ frame: Uint8Array; completion: PromiseWithResolvers<void> }> = [];
	#spaceWaiters: Array<() => void> = [];
	#closed = false;
	#failure: Error | undefined;
	#flushPromise: Promise<void> | undefined;

	constructor(options: BoundedOutboundOptions) {
		this.#capacity = options.capacity ?? DEFAULT_OUTBOUND_QUEUE_CAPACITY;
		this.#send = options.send;
	}

	get queued(): number {
		return this.#queue.length;
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** Enqueue a frame, waiting for room rather than dropping a slow client's frames. */
	async enqueue(frame: Uint8Array): Promise<boolean> {
		while (!this.#closed && !this.#failure && this.#queue.length >= this.#capacity) {
			await new Promise<void>(resolve => this.#spaceWaiters.push(resolve));
		}
		if (this.#failure) throw this.#failure;
		if (this.#closed) return false;
		const completion = Promise.withResolvers<void>();
		this.#queue.push({ frame, completion });
		this.#startFlush();
		await completion.promise;
		return true;
	}

	/** Close the queue; no more frames accepted. A terminal writer failure is reported to the caller. */
	async close(): Promise<void> {
		this.#closed = true;
		this.#releaseAllSpace();
		await this.#flushPromise;
		if (this.#failure) throw this.#failure;
	}

	#releaseSpace(): void {
		this.#spaceWaiters.shift()?.();
	}

	#releaseAllSpace(): void {
		for (const resolve of this.#spaceWaiters.splice(0)) resolve();
	}

	#fail(error: unknown): void {
		if (this.#failure) return;
		this.#failure = error instanceof Error ? error : new Error(String(error));
		for (const queued of this.#queue.splice(0)) queued.completion.reject(this.#failure);
		this.#releaseAllSpace();
	}

	#startFlush(): void {
		if (this.#flushPromise || this.#failure) return;
		let settled: Promise<void>;
		settled = this.#flush().finally(() => {
			if (this.#flushPromise !== settled) return;
			this.#flushPromise = undefined;
			if (this.#queue.length > 0 && !this.#failure) this.#startFlush();
		});
		this.#flushPromise = settled;
	}

	async #flush(): Promise<void> {
		while (this.#queue.length > 0 && !this.#failure) {
			const queued = this.#queue[0]!;
			try {
				await this.#send(queued.frame);
				this.#queue.shift();
				queued.completion.resolve();
				this.#releaseSpace();
			} catch (error) {
				this.#fail(error);
			}
		}
	}
}
