// This is the ownership/admission primitive. The acceptor/server layer (assembled in P5)
// wires acquireSpawnToken/register/detach/terminate into the real broker lifecycle-session
// spawn/resume/close path; this module does not spawn child processes itself.
//
// app-server ThreadRuntimeManager: multi-thread ownership with bounded admission.
//
// Per the plan D2/D14: one worker/child process per loaded thread, managed by this class.
// Admission limits:
//   - maxLoadedThreads: global cap (atomic reservation before semaphore)
//   - spawn semaphore: bounded concurrent startup
//   - per-connection pending-load limit
//   - LRU/TTL eviction of inactive OWNED children (never-evict active turns/approvals)
//   - capacity exhaustion returns -32011 (conflict)
//
// Ownership model (D2):
//   - create/fork -> spawned (owned; terminate() on shutdown)
//   - resume reused:true -> attached (not owned; detach() on shutdown, never close)
//   - authority tuple: {endpointGeneration, endpointIncarnation, endpointMtimeMs, pid}
//     captured at load and passed to every owned session.close for fencing.
//
// The caller (acceptor/server) wires register/detach/terminate to real lifecycle-session
// operations. This class does NOT spawn child processes itself — it owns the admission,
// ownership, eviction, and authority-fencing bookkeeping.

export type ThreadOwnership = "spawned" | "attached";

export interface EndpointAuthority {
	endpointGeneration: number;
	endpointIncarnation: string;
	endpointMtimeMs: number;
	pid: number;
}

export interface ManagedThread {
	readonly threadId: string;
	readonly ownership: ThreadOwnership;
	readonly authority: EndpointAuthority | undefined;
	readonly loadedAt: number;
	readonly connectionId: string | undefined;
	activeTurn: boolean;
	pendingApprovals: number;
	lastActivity: number;
}

/** A spawn semaphore token. The caller acquires it before async child spawn and releases after. */
export interface SpawnToken {
	readonly release: () => void;
}

export interface AdmissionConfig {
	readonly maxLoadedThreads: number;
	readonly perConnectionPendingLimit: number;
	readonly idleTtlMs: number;
	readonly spawnSemaphore: number;
}

const DEFAULT_CONFIG: AdmissionConfig = {
	maxLoadedThreads: 16,
	perConnectionPendingLimit: 4,
	idleTtlMs: 30 * 60 * 1000,
	spawnSemaphore: 4,
};

/**
 * Callback the manager invokes when an owned child is evicted or terminated, so the
 * caller can fence and close the real lifecycle session using the captured authority.
 */
export type CloseOwnedCallback = (threadId: string, ownership: ThreadOwnership, authority: EndpointAuthority | undefined) => void;

export class ThreadRuntimeManager {
	readonly #threads = new Map<string, ManagedThread>();
	readonly #connectionLoads = new Map<string, number>();
	readonly #config: AdmissionConfig;
	readonly #activeSpawns = { current: 0 };
	#closeOwned: CloseOwnedCallback | undefined;

	constructor(config: Partial<AdmissionConfig> = {}) {
		this.#config = { ...DEFAULT_CONFIG, ...config };
	}

	get loadedCount(): number {
		return this.#threads.size;
	}
	get config(): AdmissionConfig {
		return this.#config;
	}

	/** Set the callback invoked when an owned child is evicted/terminated. */
	onCloseOwned(callback: CloseOwnedCallback): void {
		this.#closeOwned = callback;
	}

	/**
	 * Acquire a spawn semaphore token. The caller MUST call `token.release()` after
	 * the async child spawn/load completes (or fails). Returns a token or throws
	 * conflict if the semaphore is exhausted. This bounds concurrent async startups.
	 */
	acquireSpawnToken(): SpawnToken {
		if (this.#activeSpawns.current >= this.#config.spawnSemaphore) {
			throw Object.assign(new Error("Spawn semaphore exhausted; too many concurrent thread startups."), { code: "conflict" });
		}
		(this.#activeSpawns as { current: number }).current++;
		let released = false;
		return {
			release: () => {
				if (!released) {
					released = true;
					(this.#activeSpawns as { current: number }).current--;
				}
			},
		};
	}

	/**
	 * Register a loaded thread. Returns the ManagedThread or throws on capacity exhaustion.
	 * The caller must have already acquired a spawn token (acquireSpawnToken) before calling
	 * this if async startup bounding is needed. Rejects duplicate threadId.
	 */
	register(
		threadId: string,
		ownership: ThreadOwnership,
		authority: EndpointAuthority | undefined,
		connectionId?: string,
	): ManagedThread {
		// Reject duplicates — a loaded thread cannot be overwritten.
		if (this.#threads.has(threadId)) {
			throw Object.assign(new Error(`Thread ${threadId} is already loaded.`), { code: "conflict" });
		}
		// Capacity check (atomic reservation).
		if (this.#threads.size >= this.#config.maxLoadedThreads) {
			this.evictIdleOwned();
			if (this.#threads.size >= this.#config.maxLoadedThreads) {
				throw Object.assign(new Error("Thread capacity exhausted."), { code: "conflict" });
			}
		}
		// Per-connection pending-load limit.
		if (connectionId !== undefined) {
			const count = this.#connectionLoads.get(connectionId) ?? 0;
			if (count >= this.#config.perConnectionPendingLimit) {
				throw Object.assign(new Error("Per-connection thread load limit exceeded."), { code: "conflict" });
			}
		}
		const now = Date.now();
		const thread: ManagedThread = {
			threadId,
			ownership,
			authority,
			loadedAt: now,
			connectionId,
			activeTurn: false,
			pendingApprovals: 0,
			lastActivity: now,
		};
		this.#threads.set(threadId, thread);
		if (connectionId !== undefined) {
			this.#connectionLoads.set(connectionId, (this.#connectionLoads.get(connectionId) ?? 0) + 1);
		}
		return thread;
	}

	get(threadId: string): ManagedThread | undefined {
		return this.#threads.get(threadId);
	}

	setActiveTurn(threadId: string, active: boolean): void {
		const thread = this.#threads.get(threadId);
		if (thread) {
			(thread as { activeTurn: boolean }).activeTurn = active;
			(thread as { lastActivity: number }).lastActivity = Date.now();
		}
	}

	adjustPendingApprovals(threadId: string, delta: number): void {
		const thread = this.#threads.get(threadId);
		if (thread) {
			(thread as { pendingApprovals: number }).pendingApprovals = Math.max(0, thread.pendingApprovals + delta);
		}
	}

	/** Release a per-connection load count when a thread is removed. */
	#releaseConnectionLoad(thread: ManagedThread): void {
		if (thread.connectionId !== undefined) {
			const count = this.#connectionLoads.get(thread.connectionId) ?? 0;
			if (count <= 1) {
				this.#connectionLoads.delete(thread.connectionId);
			} else {
				this.#connectionLoads.set(thread.connectionId, count - 1);
			}
		}
	}

	/**
	 * Evict idle owned children past their TTL. Never evicts threads with active turns
	 * or pending approvals. Evicts oldest-first (LRU). Invokes the closeOwned callback
	 * for fenced termination of the real child process.
	 */
	evictIdleOwned(): number {
		const now = Date.now();
		const evictable: ManagedThread[] = [];
		for (const thread of this.#threads.values()) {
			if (thread.ownership !== "spawned") continue;
			if (thread.activeTurn || thread.pendingApprovals > 0) continue;
			if (now - thread.lastActivity >= this.#config.idleTtlMs) {
				evictable.push(thread);
			}
		}
		evictable.sort((a, b) => a.lastActivity - b.lastActivity);
		for (const thread of evictable) {
			this.#threads.delete(thread.threadId);
			this.#releaseConnectionLoad(thread);
			this.#closeOwned?.(thread.threadId, thread.ownership, thread.authority);
		}
		return evictable.length;
	}

	/**
	 * Detach a thread. Only valid for ATTACHED ownership — detaching a spawned thread
	 * is a contract violation (spawned threads must be terminated, not detached).
	 * Does NOT call session.close — the underlying session is left alive.
	 */
	detach(threadId: string): boolean {
		const thread = this.#threads.get(threadId);
		if (!thread) return false;
		if (thread.ownership !== "attached") {
			throw Object.assign(new Error(`Cannot detach spawned thread ${threadId}; use terminate().`), { code: "conflict" });
		}
		this.#threads.delete(threadId);
		this.#releaseConnectionLoad(thread);
		return true;
	}

	/**
	 * Terminate a thread. Only valid for SPAWNED ownership — terminating an attached
	 * thread is a contract violation (attached threads must be detached, not terminated).
	 * Invokes the closeOwned callback with the captured authority for fenced session.close.
	 */
	terminate(threadId: string): EndpointAuthority | undefined {
		const thread = this.#threads.get(threadId);
		if (!thread) return undefined;
		if (thread.ownership !== "spawned") {
			throw Object.assign(new Error(`Cannot terminate attached thread ${threadId}; use detach().`), { code: "conflict" });
		}
		this.#threads.delete(threadId);
		this.#releaseConnectionLoad(thread);
		this.#closeOwned?.(thread.threadId, thread.ownership, thread.authority);
		return thread.authority;
	}

	/** Clean up all threads on shutdown: detach attached, terminate spawned. */
	shutdown(): { detached: string[]; terminated: string[] } {
		const detached: string[] = [];
		const terminated: string[] = [];
		for (const [threadId, thread] of this.#threads) {
			if (thread.ownership === "attached") {
				detached.push(threadId);
			} else {
				terminated.push(threadId);
				this.#closeOwned?.(threadId, thread.ownership, thread.authority);
			}
		}
		this.#threads.clear();
		this.#connectionLoads.clear();
		return { detached, terminated };
	}
}
