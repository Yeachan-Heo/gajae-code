// app-server subscriptions: per-connection subscription tracking and notification fan-out.
//
// Per the plan D8: auto-subscribe on thread/start, thread/resume, thread/fork;
// thread/unsubscribe removes this connection from that thread's events;
// exact-match optOutNotificationMethods suppression; directed responses;
// bounded per-connection outbound queues with slow-client policy.

export interface Subscription {
	readonly connectionId: string;
	readonly threadId: string;
}

/** Registry of which connections are subscribed to which threads. */
export class ThreadSubscriptionIndex {
	// threadId -> Set<connectionId>
	readonly #subscriptions = new Map<string, Set<string>>();
	// connectionId -> Set<threadId> (reverse index for disconnect cleanup)
	readonly #connectionThreads = new Map<string, Set<string>>();

	get subscribedThreads(): number {
		return this.#subscriptions.size;
	}

	/** Auto-subscribe a connection to a thread. Idempotent. */
	subscribe(connectionId: string, threadId: string): void {
		let conns = this.#subscriptions.get(threadId);
		if (!conns) {
			conns = new Set();
			this.#subscriptions.set(threadId, conns);
		}
		conns.add(connectionId);
		let threads = this.#connectionThreads.get(connectionId);
		if (!threads) {
			threads = new Set();
			this.#connectionThreads.set(connectionId, threads);
		}
		threads.add(threadId);
	}

	/** Unsubscribe a connection from a thread. */
	unsubscribe(connectionId: string, threadId: string): boolean {
		const conns = this.#subscriptions.get(threadId);
		if (!conns?.delete(connectionId)) return false;
	if (conns.size === 0) this.#subscriptions.delete(threadId);
		// Clean up the reverse index entry for this connection.
		const connThreads = this.#connectionThreads.get(connectionId);
		if (connThreads) {
			connThreads.delete(threadId);
			if (connThreads.size === 0) this.#connectionThreads.delete(connectionId);
		}
		return true;
	}

	/** Get all connection IDs subscribed to a thread. */
	getSubscribers(threadId: string): ReadonlySet<string> {
		return this.#subscriptions.get(threadId) ?? new Set();
	}

	/** Get all threads a connection is subscribed to. */
	getSubscriptions(connectionId: string): ReadonlySet<string> {
		return this.#connectionThreads.get(connectionId) ?? new Set();
	}

	/** Clean up ALL subscriptions for a disconnected connection. Returns removed thread IDs. */
	handleDisconnect(connectionId: string): string[] {
		const threads = this.#connectionThreads.get(connectionId);
		if (!threads) return [];
		const removed: string[] = [];
		for (const threadId of threads) {
			const conns = this.#subscriptions.get(threadId);
			conns?.delete(connectionId);
			if (conns && conns.size === 0) this.#subscriptions.delete(threadId);
			removed.push(threadId);
		}
		this.#connectionThreads.delete(connectionId);
		return removed;
	}

	/** Whether a connection is subscribed to a thread. */
	isSubscribed(connectionId: string, threadId: string): boolean {
		return this.#subscriptions.get(threadId)?.has(connectionId) ?? false;
	}
}

/** Registry of active connections with their capabilities and opt-out state. */
export class ConnectionRegistry {
	readonly #connections = new Map<string, { optOuts: ReadonlySet<string> }>();

	register(connectionId: string, optOuts: ReadonlySet<string> = new Set()): void {
		this.#connections.set(connectionId, { optOuts });
	}

	unregister(connectionId: string): void {
		this.#connections.delete(connectionId);
	}

	isActive(connectionId: string): boolean {
		return this.#connections.has(connectionId);
	}

	/** Whether this connection opts out of a specific notification method. */
	optsOutOf(connectionId: string, method: string): boolean {
		return this.#connections.get(connectionId)?.optOuts.has(method) ?? false;
	}

	get activeCount(): number {
		return this.#connections.size;
	}
}
