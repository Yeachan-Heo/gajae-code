// app-server per-connection bounded outbound queue.
//
// Each transport connection gets its own bounded queue. When the queue saturates, the
// slow-client policy kicks in:
//   - stdio: pause reading stdin until the outbound drains (backpressure).
//   - websocket/unix: disconnect the connection after the queue exhausts (the connection
//     is too slow to keep up; reconnect will replay missed events via the event stream).

export interface BoundedOutboundOptions {
	/** Max queued outbound frames before slow-client policy triggers. */
	readonly capacity?: number;
	/** Called to actually send a frame to the transport. */
	readonly send: (frame: Uint8Array) => Promise<void>;
	/** Called when the queue saturates and the slow-client policy triggers. */
	readonly onSlowClient?: () => void;
}

const DEFAULT_CAPACITY = 256;

export class BoundedOutboundQueue {
	readonly #capacity: number;
	readonly #send: (frame: Uint8Array) => Promise<void>;
	readonly #onSlowClient?: () => void;
	#queue: Uint8Array[] = [];
	#flushing = false;
	#closed = false;
	#dropped = 0;

	constructor(options: BoundedOutboundOptions) {
		this.#capacity = options.capacity ?? DEFAULT_CAPACITY;
		this.#send = options.send;
		this.#onSlowClient = options.onSlowClient;
	}

	get queued(): number {
		return this.#queue.length;
	}
	get dropped(): number {
		return this.#dropped;
	}
	get closed(): boolean {
		return this.#closed;
	}

	/**
	 * Enqueue a frame. Returns true if accepted, false if the queue is closed or the
	 * slow-client policy has been triggered (caller should stop reading / disconnect).
	 */
	enqueue(frame: Uint8Array): boolean {
		if (this.#closed) return false;
		if (this.#queue.length >= this.#capacity) {
			this.#dropped++;
			this.#onSlowClient?.();
			return false;
		}
		this.#queue.push(frame);
		void this.#flush();
		return true;
	}

	/** Close the queue; no more frames accepted. Pending frames are flushed. */
	async close(): Promise<void> {
		this.#closed = true;
		await this.#drain();
	}

	async #flush(): Promise<void> {
		if (this.#flushing) return;
		this.#flushing = true;
		try {
			while (this.#queue.length > 0 && !this.#closed) {
				const frame = this.#queue.shift()!;
				try {
					await this.#send(frame);
				} catch {
					// Transport send failed; re-enqueue and stop (caller handles disconnect).
					this.#queue.unshift(frame);
					break;
				}
			}
		} finally {
			this.#flushing = false;
		}
	}

	async #drain(): Promise<void> {
		while (this.#queue.length > 0) {
			const frame = this.#queue.shift()!;
			try {
				await this.#send(frame);
			} catch {
				break;
			}
		}
	}
}
