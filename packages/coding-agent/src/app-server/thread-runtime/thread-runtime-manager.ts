// app-server ThreadRuntimeManager: multi-thread ownership with bounded admission.
//
// One worker/child process is retained for each loaded thread. Admission is reserved before
// asynchronous child startup so a slow create cannot oversubscribe the global or connection
// limits. The reservation is committed only after the child is semantically ready and all
// effective settings have been read.

import type { SessionClient } from "./child-bridge";

export type ThreadOwnership = "spawned" | "attached";

export interface EndpointAuthority {
	endpointGeneration: number;
	endpointIncarnation: string;
	endpointMtimeMs: number;
	pid: number;
}

export interface ThreadSnapshot {
	readonly id?: string;
	readonly sessionId?: string;
	readonly forkedFromId: string | null;
	readonly parentThreadId: string | null;
	readonly preview: string;
	readonly ephemeral: boolean;
	readonly isPinned: boolean;
	readonly modelProvider: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly recencyAt: number | null;
	readonly status: unknown;
	readonly path: string | null;
	readonly cwd: string;
	readonly cliVersion: string;
	readonly source: unknown;
	readonly threadSource: unknown;
	readonly agentNickname: string | null;
	readonly agentRole: string | null;
	readonly gitInfo: unknown;
	readonly name: string | null;
	readonly turns: readonly unknown[];
	readonly extra?: Record<string, never> | null;
	readonly historyMode?: "legacy" | "paginated";
	readonly canAcceptDirectInput?: boolean | null;
}

export interface ThreadEffectiveSettings {
	readonly model: string;
	readonly modelProvider: string;
	readonly serviceTier: string | null;
	readonly cwd: string;
	readonly instructionSources: readonly string[];
	readonly approvalPolicy: unknown;
	readonly approvalsReviewer: unknown;
	readonly sandbox: unknown;
	readonly reasoningEffort: unknown;
	readonly thread: ThreadSnapshot;
	readonly runtimeWorkspaceRoots?: readonly string[];
	readonly activePermissionProfile?: unknown;
	readonly multiAgentMode?: unknown;
}

export type ManagedThreadLifecycle = "committing" | "active";

export interface ManagedThread {
	readonly threadId: string;
	readonly sessionId: string;
	readonly ownership: ThreadOwnership;
	readonly authority: EndpointAuthority | undefined;
	readonly cwd: string | undefined;
	readonly client: SessionClient | undefined;
	readonly effectiveSettings: ThreadEffectiveSettings | undefined;
	readonly closeChild: ((authority: EndpointAuthority | undefined) => Promise<void> | void) | undefined;
	readonly closeRuntime: (() => Promise<void>) | undefined;
	readonly loadedAt: number;
	readonly connectionId: string | undefined;
	lifecycle: ManagedThreadLifecycle;
	activeTurn: boolean;
	pendingApprovals: number;
	lastActivity: number;
}

/** A spawn semaphore token. */
export interface SpawnToken {
	readonly release: () => void;
}

/** A global/per-connection admission reservation. */
export interface AdmissionReservation {
	readonly threadId: string;
	readonly connectionId: string | undefined;
	readonly commit: () => void;
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
 * The manager invokes this callback when an owned runtime is evicted or terminated. The
 * optional retained client is supplied so the bridge can close the transport exactly once;
 * the optional child closer carries the authority-fenced lifecycle shutdown.
 */
export type CloseOwnedCallback = (
	threadId: string,
	ownership: ThreadOwnership,
	authority: EndpointAuthority | undefined,
	client?: SessionClient,
	closeChild?: (authority: EndpointAuthority | undefined) => Promise<void> | void,
	closeRuntime?: () => Promise<void>,
) => void;

type RegisterOptions = {
	readonly reservation?: AdmissionReservation;
	readonly sessionId?: string;
	readonly cwd?: string;
	readonly client?: SessionClient;
	readonly effectiveSettings?: ThreadEffectiveSettings;
	readonly closeChild?: (authority: EndpointAuthority | undefined) => Promise<void> | void;
	readonly closeRuntime?: () => Promise<void>;
	readonly lifecycle?: ManagedThreadLifecycle;
};

function conflict(message: string): Error & { code: "conflict" } {
	return Object.assign(new Error(message), { code: "conflict" as const });
}

export class ThreadRuntimeManager {
	readonly #threads = new Map<string, ManagedThread>();
	readonly #connectionLoads = new Map<string, number>();
	readonly #pendingConnections = new Map<string, number>();
	readonly #pendingThreadIds = new Set<string>();
	readonly #reservations = new Set<AdmissionReservation>();
	readonly #config: AdmissionConfig;
	#activeSpawns = 0;
	#closeOwned: CloseOwnedCallback | undefined;
	#onThreadGone: ((threadId: string, reason: "removed" | "evicted" | "detached" | "terminated") => void) | undefined;

	constructor(config: Partial<AdmissionConfig> = {}) {
		this.#config = { ...DEFAULT_CONFIG, ...config };
	}

	get loadedCount(): number {
		return this.#threads.size;
	}

	get pendingCount(): number {
		return this.#reservations.size;
	}

	get config(): AdmissionConfig {
		return this.#config;
	}

	/** Set the callback invoked when an owned child is evicted/terminated. */
	onCloseOwned(callback: CloseOwnedCallback): void {
		this.#closeOwned = callback;
	}

	/**
	 * Observe a thread leaving the manager for any reason. The app-server runtime uses this to
	 * settle every pending approval for that thread, so a removed/evicted child can never leave a
	 * broker waiter hanging.
	 */
	onThreadGone(callback: (threadId: string, reason: "removed" | "evicted" | "detached" | "terminated") => void): void {
		this.#onThreadGone = callback;
	}

	/** Add a close callback without replacing an already-installed lifecycle callback. */
	addCloseOwned(callback: CloseOwnedCallback): void {
		const previous = this.#closeOwned;
		if (!previous) {
			this.#closeOwned = callback;
			return;
		}
		this.#closeOwned = (threadId, ownership, authority, client, closeChild, closeRuntime) => {
			try {
				previous(threadId, ownership, authority, client, closeChild, closeRuntime);
			} finally {
				callback(threadId, ownership, authority, client, closeChild, closeRuntime);
			}
		};
	}

	/**
	 * Reserve a global and optional per-connection admission slot. The reservation must be
	 * committed by register() or explicitly released on every failed startup path.
	 */
	reserve(threadId: string, connectionId?: string): AdmissionReservation {
		if (this.#threads.has(threadId) || this.#pendingThreadIds.has(threadId))
			throw conflict(`Thread ${threadId} is already loaded or loading.`);
		if (this.#threads.size + this.#reservations.size >= this.#config.maxLoadedThreads) {
			this.evictIdleOwned();
			if (this.#threads.size + this.#reservations.size >= this.#config.maxLoadedThreads)
				throw conflict("Thread capacity exhausted.");
		}
		if (connectionId !== undefined) {
			const loaded = this.#connectionLoads.get(connectionId) ?? 0;
			const pending = this.#pendingConnections.get(connectionId) ?? 0;
			if (loaded + pending >= this.#config.perConnectionPendingLimit)
				throw conflict("Per-connection thread load limit exceeded.");
		}

		let released = false;
		let committed = false;
		const reservation: AdmissionReservation = {
			threadId,
			connectionId,
			commit: () => {
				if (released) throw new Error("Admission reservation has already been released.");
				if (committed) return;
				committed = true;
				this.#pendingThreadIds.delete(threadId);
				this.#releasePendingConnection(connectionId);
				this.#reservations.delete(reservation);
			},
			release: () => {
				if (released || committed) return;
				released = true;
				this.#pendingThreadIds.delete(threadId);
				this.#releasePendingConnection(connectionId);
				this.#reservations.delete(reservation);
			},
		};
		this.#pendingThreadIds.add(threadId);
		this.#reservations.add(reservation);
		if (connectionId !== undefined)
			this.#pendingConnections.set(connectionId, (this.#pendingConnections.get(connectionId) ?? 0) + 1);
		return reservation;
	}

	/** A spawn semaphore token. */
	acquireSpawnToken(): SpawnToken {
		if (this.#activeSpawns >= this.#config.spawnSemaphore)
			throw conflict("Spawn semaphore exhausted; too many concurrent thread startups.");
		this.#activeSpawns++;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this.#activeSpawns--;
			},
		};
	}

	/**
	 * Register a loaded thread. A reservation commits the previously reserved admission slot;
	 * direct callers retain the historical capacity/per-connection checks.
	 */
	register(
		threadId: string,
		ownership: ThreadOwnership,
		authority: EndpointAuthority | undefined,
		connectionId?: string,
		options: RegisterOptions = {},
	): ManagedThread {
		const reservation = options.reservation;
		if (this.#threads.has(threadId)) throw conflict(`Thread ${threadId} is already loaded.`);
		if (this.#pendingThreadIds.has(threadId) && reservation?.threadId !== threadId)
			throw conflict(`Thread ${threadId} is already loading.`);
		if (reservation) {
			if (!this.#reservations.has(reservation)) throw conflict("Admission reservation is not active.");
			if (reservation.connectionId !== connectionId)
				throw conflict("Admission reservation connection does not match publication.");
		} else {
			if (this.#threads.size + this.#reservations.size >= this.#config.maxLoadedThreads) {
				this.evictIdleOwned();
				if (this.#threads.size + this.#reservations.size >= this.#config.maxLoadedThreads)
					throw conflict("Thread capacity exhausted.");
			}
			if (connectionId !== undefined) {
				const count = this.#connectionLoads.get(connectionId) ?? 0;
				const pending = this.#pendingConnections.get(connectionId) ?? 0;
				if (count + pending >= this.#config.perConnectionPendingLimit)
					throw conflict("Per-connection thread load limit exceeded.");
			}
		}

		const now = Date.now();
		const thread: ManagedThread = {
			threadId,
			sessionId: options.sessionId ?? threadId,
			ownership,
			authority,
			cwd: options.cwd,
			client: options.client,
			effectiveSettings: options.effectiveSettings,
			closeChild: options.closeChild,
			closeRuntime: options.closeRuntime,
			loadedAt: now,
			connectionId,
			lifecycle: options.lifecycle ?? "active",
			activeTurn: false,
			pendingApprovals: 0,
			lastActivity: now,
		};
		this.#threads.set(threadId, thread);
		if (connectionId !== undefined)
			this.#connectionLoads.set(connectionId, (this.#connectionLoads.get(connectionId) ?? 0) + 1);
		if (reservation) reservation.commit();
		return thread;
	}

	get(threadId: string): ManagedThread | undefined {
		return this.#threads.get(threadId);
	}

	/** Mark a published committing runtime active after subscription completes. */
	markActive(threadId: string): ManagedThread | undefined {
		const thread = this.#threads.get(threadId);
		if (thread?.lifecycle !== "committing") return undefined;
		thread.lifecycle = "active";
		thread.lastActivity = Date.now();
		return thread;
	}
	setActiveTurn(threadId: string, active: boolean): void {
		const thread = this.#threads.get(threadId);
		if (thread) {
			thread.activeTurn = active;
			thread.lastActivity = Date.now();
		}
	}

	adjustPendingApprovals(threadId: string, delta: number): void {
		const thread = this.#threads.get(threadId);
		if (thread) thread.pendingApprovals = Math.max(0, thread.pendingApprovals + delta);
	}

	/** Remove a published runtime and invoke the bridge close hook when requested. */
	remove(threadId: string, close = true): boolean {
		const thread = this.#threads.get(threadId);
		if (!thread) return false;
		this.#threads.delete(threadId);
		this.#releaseConnectionLoad(thread);
		this.#onThreadGone?.(threadId, "removed");
		if (close) this.#invokeClose(thread);
		return true;
	}

	#releasePendingConnection(connectionId: string | undefined): void {
		if (connectionId === undefined) return;
		const count = this.#pendingConnections.get(connectionId) ?? 0;
		if (count <= 1) this.#pendingConnections.delete(connectionId);
		else this.#pendingConnections.set(connectionId, count - 1);
	}

	/** Release a per-connection load count when a thread is removed. */
	#releaseConnectionLoad(thread: ManagedThread): void {
		if (thread.connectionId === undefined) return;
		const count = this.#connectionLoads.get(thread.connectionId) ?? 0;
		if (count <= 1) this.#connectionLoads.delete(thread.connectionId);
		else this.#connectionLoads.set(thread.connectionId, count - 1);
	}

	#invokeClose(thread: ManagedThread): void {
		this.#closeOwned?.(
			thread.threadId,
			thread.ownership,
			thread.authority,
			thread.client,
			thread.closeChild,
			thread.closeRuntime,
		);
	}

	/**
	 * Evict idle owned children past their TTL. Never evicts threads that are committing,
	 * have active turns, or have pending approvals. Evicts oldest-first (LRU), passing each
	 * captured authority to the close callback.
	 */
	evictIdleOwned(): number {
		const now = Date.now();
		const evictable: ManagedThread[] = [];
		for (const thread of this.#threads.values()) {
			if (thread.ownership !== "spawned") continue;
			if (thread.lifecycle === "committing") continue;
			if (thread.activeTurn || thread.pendingApprovals > 0) continue;
			if (now - thread.lastActivity >= this.#config.idleTtlMs) evictable.push(thread);
		}
		evictable.sort((a, b) => a.lastActivity - b.lastActivity);
		for (const thread of evictable) {
			this.#threads.delete(thread.threadId);
			this.#releaseConnectionLoad(thread);
			this.#onThreadGone?.(thread.threadId, "evicted");
			this.#invokeClose(thread);
		}
		return evictable.length;
	}

	/** Detach an attached thread without closing the underlying session. */
	detach(threadId: string): boolean {
		const thread = this.#threads.get(threadId);
		if (!thread) return false;
		if (thread.ownership !== "attached") throw conflict(`Cannot detach spawned thread ${threadId}; use terminate().`);
		this.#threads.delete(threadId);
		this.#releaseConnectionLoad(thread);
		this.#onThreadGone?.(threadId, "detached");
		return true;
	}

	/** Terminate a spawned thread with authority-fenced close semantics. */
	terminate(threadId: string): EndpointAuthority | undefined {
		const thread = this.#threads.get(threadId);
		if (!thread) return undefined;
		if (thread.ownership !== "spawned") throw conflict(`Cannot terminate attached thread ${threadId}; use detach().`);
		this.#threads.delete(threadId);
		this.#releaseConnectionLoad(thread);
		this.#onThreadGone?.(threadId, "terminated");
		this.#invokeClose(thread);
		return thread.authority;
	}

	/** Clean up all threads on shutdown: detach attached, terminate spawned. */
	shutdown(): { detached: string[]; terminated: string[] } {
		const detached: string[] = [];
		const terminated: string[] = [];
		const threads = [...this.#threads.values()];
		for (const thread of threads) {
			if (thread.ownership === "attached") detached.push(thread.threadId);
			else terminated.push(thread.threadId);
		}
		for (const reservation of [...this.#reservations]) reservation.release();
		this.#threads.clear();
		this.#connectionLoads.clear();
		for (const thread of threads) {
			if (thread.ownership === "spawned") this.#invokeClose(thread);
		}
		return { detached, terminated };
	}
}
