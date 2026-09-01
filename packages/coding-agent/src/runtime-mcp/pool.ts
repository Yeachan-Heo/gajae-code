/**
 * MCP physical connection pool and per-consumer leases.
 *
 * Shared and per-session keys are both supported. Shared entries are owned by
 * multiple leases and roots/resource subscriptions are connection-global unions.
 */
import { logger } from "@gajae-code/utils";
import { connectToServer, subscribeToResources, unsubscribeFromResources } from "./client";
import {
	buildMCPPoolKeyIdentity,
	computeMCPPoolKey,
	type MCPPoolKeyIdentity,
	type MCPPoolKeyOptions,
	type MCPPoolSharingMode,
} from "./pool-key";
import {
	MCPNotificationMethods,
	type MCPRequestOptions,
	type MCPServerConfig,
	type MCPServerConnection,
	type MCPTransport,
} from "./types";

export type { MCPPoolCapabilityProfile, MCPPoolKeyIdentity, MCPPoolKeyOptions, MCPPoolSharingMode } from "./pool-key";

export class MCPPoolLeaseReleaseError extends Error {
	readonly code = "MCP_POOL_LEASE_RELEASE_FAILED" as const;
	readonly serverName: string;
	readonly poolKey: string;

	constructor(serverName: string, poolKey: string, cause: unknown) {
		super(
			`Failed to release stale MCP lease for ${serverName} (${poolKey}): ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
			cause instanceof Error ? { cause } : undefined,
		);
		this.name = "MCPPoolLeaseReleaseError";
		this.serverName = serverName;
		this.poolKey = poolKey;
	}
}

export class MCPPoolLeaseObsoleteError extends Error {
	readonly code = "MCP_POOL_LEASE_OBSOLETE" as const;
	readonly serverName: string;
	readonly poolKey: string;
	readonly generation: number;

	constructor(serverName: string, poolKey: string, generation: number) {
		super(`MCP lease for ${serverName} (${poolKey}) generation ${generation} is no longer current`);
		this.name = "MCPPoolLeaseObsoleteError";
		this.serverName = serverName;
		this.poolKey = poolKey;
		this.generation = generation;
	}
}

export class MCPPoolAcquireAbortError extends Error {
	readonly code = "MCP_POOL_ACQUIRE_ABORTED" as const;
	readonly serverName: string;
	readonly poolKey: string;
	cleanup?: Promise<unknown>;

	constructor(serverName: string, poolKey: string, cause: unknown, cleanup?: Promise<unknown>) {
		super(
			`MCP connection acquisition aborted for ${serverName} (${poolKey}): ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
			cause instanceof Error ? { cause } : undefined,
		);
		this.name = "MCPPoolAcquireAbortError";
		this.serverName = serverName;
		this.poolKey = poolKey;
		this.cleanup = cleanup;
	}
}

export class MCPPoolLeaseInvalidatedError extends Error {
	readonly code = "MCP_POOL_LEASE_INVALIDATED" as const;
	readonly serverName: string;
	readonly poolKey: string;

	constructor(serverName: string, poolKey: string, cause?: unknown) {
		super(
			`MCP lease is no longer available for ${serverName} (${poolKey})${
				cause instanceof Error ? `: ${cause.message}` : ""
			}`,
			cause instanceof Error ? { cause } : undefined,
		);
		this.name = "MCPPoolLeaseInvalidatedError";
		this.serverName = serverName;
		this.poolKey = poolKey;
	}
}

export type MCPPoolEvent =
	| { type: "notification"; method: string; params: unknown }
	| { type: "close"; error?: Error }
	| { type: "error"; error: Error }
	| { type: "replacement"; success: boolean };

export interface MCPPoolHealthEvent {
	type: "notification" | "close" | "error" | "connecting" | "connected" | "closing" | "closed";
	at: number;
	message?: string;
}

export interface MCPPoolHealth {
	key: string;
	serverName: string;
	transport: "stdio" | "http" | "sse";
	state: "connecting" | "connected" | "closing" | "closed" | "error";
	refCount: number;
	events: MCPPoolHealthEvent[];
}

export interface MCPPoolAcquireOptions extends MCPPoolKeyOptions {
	signal?: AbortSignal;
	/** Advertise roots/list to the server (defaults to true). */
	advertiseRoots?: boolean;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
}

export interface MCPConnectionPoolOptions {
	sharedPoolIdleMs?: number;
	connect?: (
		name: string,
		config: MCPServerConfig,
		options: {
			signal?: AbortSignal;
			advertiseRoots?: boolean;
			onNotification?: (method: string, params: unknown) => void;
			onRequest?: (method: string, params: unknown) => Promise<unknown>;
			cwd?: string;
		},
	) => Promise<MCPServerConnection>;
}

type HealthListener = (health: MCPPoolHealth[]) => void;
type LeaseListener = (event: MCPPoolEvent) => void;

type PoolEntry = {
	generation: number;
	key: string;
	name: string;
	config: MCPServerConfig;
	identity: MCPPoolKeyIdentity;
	connection: MCPServerConnection;
	refCount: number;
	leases: Set<MCPPoolLeaseImpl>;
	rootsByLease: Map<MCPPoolLeaseImpl, Array<{ uri: string; name: string }>>;
	pending?: PendingEntry;
	resourceSubscriptionCounts: Map<string, number>;
	resourceSubscriptionUpdate: Promise<void>;
	state: MCPPoolHealth["state"];
	events: MCPPoolHealthEvent[];
	idleTimer?: ReturnType<typeof setTimeout>;
	transportCloseStarted?: boolean;
	closePromise?: Promise<void>;
	rootsNotificationScheduled?: boolean;
};

type PendingAcquisition = {
	entry: PoolEntry;
	claim: () => void;
};

type PendingWaiter = {
	resolve: (acquisition: PendingAcquisition) => void;
	reject: (reason?: unknown) => void;
	settled: boolean;
	claimed: boolean;
	removeAbortListener?: () => void;
};

type PendingEntry = {
	claims: number;
	promise: Promise<PoolEntry>;
	resolve: (entry: PoolEntry) => void;
	reject: (reason?: unknown) => void;
	waiters: Set<PendingWaiter>;
	settled: boolean;
	cancelled: boolean;
	entry?: PoolEntry;
	cancellationReason?: unknown;
	openAbortController: AbortController;
	openSignal?: AbortSignal;
	settlement?: Promise<unknown>;
};

function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 512 ? `${message.slice(0, 509)}...` : message;
}

/** Do not expose configured URLs, headers, or credentials in health output. */
function redactedHealthMessage(error: unknown): string {
	return errorMessage(error)
		.replace(/https?:\/\/\S+/gi, "<endpoint>")
		.replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
		.replace(/\b(?:token|secret|password|authorization|api[-_]?key)\s*[=:]\s*\S+/gi, "$1=<redacted>");
}

function transportName(config: MCPServerConfig): "stdio" | "http" | "sse" {
	return config.type ?? "stdio";
}

/** A lease over one physical MCP connection. */
export interface MCPPoolLease {
	readonly generation: number;
	readonly key: string;
	readonly serverName: string;
	readonly name: string;
	readonly sharingMode: MCPPoolSharingMode;
	readonly connection: MCPServerConnection;
	connectionForLease(): MCPServerConnection;
	request<T = unknown>(method: string, params?: Record<string, unknown>, options?: MCPRequestOptions): Promise<T>;
	notify(method: string, params?: Record<string, unknown>): Promise<void>;
	setResourceSubscriptions(uris: string[]): Promise<void>;
	/** Update the connection-global root union contribution for this lease. */
	updateRoots(roots: Array<{ uri: string; name: string }>): void;
	onEvent(listener: LeaseListener): () => void;
	release(): Promise<void>;
}

class MCPPoolLeaseImpl implements MCPPoolLease {
	readonly generation: number;
	readonly key: string;
	readonly serverName: string;
	readonly connection: MCPServerConnection;
	readonly #pool: MCPConnectionPool;
	readonly #entry: PoolEntry;
	readonly #listeners = new Set<LeaseListener>();
	#released = false;
	#releasePromise?: Promise<void>;
	#releaseStarted = false;
	#invalidatedError?: MCPPoolLeaseInvalidatedError;
	#subscriptions = new Set<string>();
	#subscriptionUpdate: Promise<void> = Promise.resolve();
	#connectionFacade?: MCPServerConnection;

	constructor(pool: MCPConnectionPool, entry: PoolEntry) {
		this.#pool = pool;
		this.#entry = entry;
		this.generation = entry.generation;
		this.key = entry.key;
		this.serverName = entry.name;
		this.connection = entry.connection;
	}
	get name(): string {
		return this.serverName;
	}
	get sharingMode(): MCPPoolSharingMode {
		return this.#entry.identity.sharingMode;
	}

	request<T = unknown>(method: string, params?: Record<string, unknown>, options?: MCPRequestOptions): Promise<T> {
		this.assertLive();
		return this.connection.transport.request<T>(method, params, options);
	}

	notify(method: string, params?: Record<string, unknown>): Promise<void> {
		this.assertLive();
		return this.connection.transport.notify(method, params);
	}

	connectionForLease(): MCPServerConnection {
		if (!this.#connectionFacade) {
			const physical = this.#entry.connection;
			const lease = this;
			const transport: MCPTransport = {
				get connected() {
					return !lease.#released && !lease.#invalidatedError && physical.transport.connected;
				},
				request: (method, params, options) => lease.request(method, params, options),
				notify: (method, params) => lease.notify(method, params),
				close: () => lease.release(),
				closeBeforeReconnect: physical.transport.closeBeforeReconnect,
			};
			const facade = { ...physical, transport };
			for (const property of ["tools", "resources", "resourceTemplates", "prompts"] as const) {
				Object.defineProperty(facade, property, {
					configurable: true,
					enumerable: true,
					get: () => physical[property],
					set: value => {
						physical[property] = value;
					},
				});
			}
			this.#connectionFacade = facade;
		}
		return this.#connectionFacade!;
	}

	async setResourceSubscriptions(uris: string[]): Promise<void> {
		if (this.#invalidatedError) throw this.#invalidatedError;
		if (this.#releaseStarted || this.#released) return;
		this.assertLive();
		const next = new Set(uris);
		const update = this.#subscriptionUpdate.then(async () => {
			this.assertLive();
			await this.#pool.updateLeaseSubscriptions(this.#entry, this.#subscriptions, next);
			this.#subscriptions = next;
		});
		this.#subscriptionUpdate = update.catch(() => {});
		await update;
	}

	updateRoots(roots: Array<{ uri: string; name: string }>): void {
		this.assertLive();
		this.#pool.updateLeaseRoots(this.#entry, this, roots);
	}

	onEvent(listener: LeaseListener): () => void {
		if (this.#invalidatedError) throw this.#invalidatedError;
		if (this.#released) return () => {};
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	emit(event: MCPPoolEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch (error) {
				logger.debug("MCP pool lease event handler failed", { error });
			}
		}
	}
	isCurrent(): boolean {
		return this.#pool.isCurrentGeneration(this.key, this.generation);
	}
	retireFromPool(): void {
		this.#pool.retireEntry(this.#entry);
	}

	invalidate(cause?: unknown): void {
		if (this.#released) return;
		this.#invalidatedError = new MCPPoolLeaseInvalidatedError(this.serverName, this.key, cause);
		this.#releaseStarted = true;
		this.#released = true;
		this.#listeners.clear();
		this.#pool.updateLeaseRoots(this.#entry, this, []);
		this.#subscriptions = new Set();
	}
	async release(): Promise<void> {
		if (this.#released) return;
		if (this.#releasePromise) return this.#releasePromise;
		this.#releaseStarted = true;
		const releasePromise = (async () => {
			await this.#subscriptionUpdate;
			await this.#pool.releaseLease(this.#entry, this, this.#subscriptions);
		})();
		this.#releasePromise = releasePromise.then(
			() => {
				this.#released = true;
				this.#listeners.clear();
				this.#entry.rootsByLease.delete(this);
				this.#subscriptions = new Set();
			},
			error => {
				this.#releasePromise = undefined;
				throw error;
			},
		);
		return this.#releasePromise;
	}

	get subscriptions(): ReadonlySet<string> {
		return this.#subscriptions;
	}

	private assertLive(): void {
		if (this.#invalidatedError) throw this.#invalidatedError;
		if (this.#releaseStarted) throw new Error(`MCP lease releasing: ${this.serverName}`);
		if (this.#released) throw new Error(`MCP lease released: ${this.serverName}`);
	}
}

/** Owns physical MCP connections and exposes ref-counted leases. */
export class MCPConnectionPool {
	readonly #entries = new Map<string, PoolEntry>();
	readonly #entryGenerations = new Map<string, number>();
	readonly #pending = new Map<string, PendingEntry>();
	readonly #allLeases = new Set<MCPPoolLeaseImpl>();
	readonly #retiredEntries = new Set<PoolEntry>();
	readonly #restartOwners = new Set<string>();
	readonly #restartWaiters = new Map<string, { promise: Promise<boolean>; resolve: (value: boolean) => void }>();
	readonly #healthListeners = new Set<HealthListener>();
	readonly #sharedPoolIdleMs: number;
	readonly #connect: NonNullable<MCPConnectionPoolOptions["connect"]>;
	#shuttingDown = false;
	readonly #shutdownController = new AbortController();

	constructor(options: MCPConnectionPoolOptions = {}) {
		this.#sharedPoolIdleMs =
			typeof options.sharedPoolIdleMs === "number" &&
			Number.isFinite(options.sharedPoolIdleMs) &&
			options.sharedPoolIdleMs >= 0
				? options.sharedPoolIdleMs
				: 300_000;
		this.#connect =
			options.connect ?? ((name, config, connectOptions) => connectToServer(name, config, connectOptions));
	}

	get size(): number {
		return this.#entries.size;
	}

	isCurrentLease(lease: MCPPoolLease): boolean {
		return lease instanceof MCPPoolLeaseImpl && lease.isCurrent();
	}

	isCurrentGeneration(key: string, generation: number): boolean {
		const entry = this.#entries.get(key);
		return entry?.generation === generation && entry.state === "connected" && !entry.transportCloseStarted;
	}
	/** Remove a lease's physical entry from key lookup before lifecycle rotation. */
	retireLease(lease: MCPPoolLease): void {
		if (lease instanceof MCPPoolLeaseImpl) lease.retireFromPool();
	}

	/** @internal physical-entry retirement used by manager rotation. */
	retireEntry(entry: PoolEntry): void {
		this.#retiredEntries.add(entry);
		if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
	}

	/** Claim the single restart owner for a physical pool entry. */
	claimRestart(key: string): boolean {
		if (this.#restartOwners.has(key)) return false;
		this.#restartOwners.add(key);
		const deferred = Promise.withResolvers<boolean>();
		this.#restartWaiters.set(key, deferred);
		return true;
	}

	awaitRestart(key: string): Promise<boolean> {
		return this.#restartWaiters.get(key)?.promise ?? Promise.resolve(false);
	}

	finishRestart(key: string, error?: unknown): void {
		const waiter = this.#restartWaiters.get(key);
		if (!waiter) return;
		waiter.resolve(error === undefined);
		queueMicrotask(() => {
			if (this.#restartWaiters.get(key) === waiter) this.#restartWaiters.delete(key);
		});
	}

	releaseRestart(key: string): void {
		this.#restartOwners.delete(key);
		const waiter = this.#restartWaiters.get(key);
		if (!waiter) return;
		waiter.resolve(false);
		this.#restartWaiters.delete(key);
	}

	async acquire(name: string, config: MCPServerConfig, options: MCPPoolAcquireOptions = {}): Promise<MCPPoolLease> {
		if (this.#shuttingDown) throw new Error("MCP connection pool is shut down");
		const keyOptions: MCPPoolKeyOptions = options;
		const key = computeMCPPoolKey(name, config, keyOptions);

		let entry = this.#entries.get(key);
		let claim: () => void = () => {};
		if (entry?.pending) {
			const acquisition = await this.waitForPendingEntry(key, name, entry.pending, options.signal);
			entry = acquisition.entry;
			claim = acquisition.claim;
		}
		if (!entry) {
			let pending = this.#pending.get(key);
			if (!pending) pending = this.startPendingEntry(key, name, config, options);
			const acquisition = await this.waitForPendingEntry(key, name, pending, options.signal);
			entry = acquisition.entry;
			claim = acquisition.claim;
		}
		if (options.signal?.aborted) {
			throw new MCPPoolAcquireAbortError(
				name,
				key,
				options.signal.reason ?? new Error(`MCP connection acquisition aborted: ${name}`),
			);
		}
		claim();
		if (entry.idleTimer) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = undefined;
		}
		entry.refCount += 1;
		const lease = new MCPPoolLeaseImpl(this, entry);
		entry.leases.add(lease);
		this.#allLeases.add(lease);
		entry.rootsByLease.set(lease, []);
		this.record(entry, "connected");
		return lease;
	}

	private waitForPendingEntry(
		key: string,
		name: string,
		pending: PendingEntry,
		signal?: AbortSignal,
	): Promise<PendingAcquisition> {
		const { promise, resolve, reject } = Promise.withResolvers<PendingAcquisition>();
		const waiter: PendingWaiter = { resolve, reject, settled: false, claimed: false };
		pending.waiters.add(waiter);
		const settle = (fn: () => void): void => {
			if (waiter.settled) return;
			waiter.settled = true;
			pending.waiters.delete(waiter);
			waiter.removeAbortListener?.();
			fn();
		};
		const abortWaiter = (): void => {
			const reason = new MCPPoolAcquireAbortError(
				name,
				key,
				signal?.reason ?? new Error(`MCP connection acquisition aborted: ${name}`),
				pending.settlement,
			);
			settle(() => reject(reason));
			if (pending.waiters.size === 0 && !pending.settled) this.cancelPendingEntry(key, pending, reason);
		};
		if (signal) {
			if (signal.aborted) abortWaiter();
			else {
				signal.addEventListener("abort", abortWaiter, { once: true });
				waiter.removeAbortListener = () => signal.removeEventListener("abort", abortWaiter);
			}
		}
		pending.promise.then(
			entry =>
				settle(() =>
					resolve({
						entry,
						claim: () => {
							if (waiter.claimed) return;
							waiter.claimed = true;
							pending.claims += 1;
						},
					}),
				),
			error => settle(() => reject(error)),
		);
		return promise;
	}

	private scheduleZeroClaimCleanup(key: string, pending: PendingEntry, entry: PoolEntry): void {
		queueMicrotask(() =>
			queueMicrotask(() => {
				if (
					pending.settled &&
					pending.waiters.size === 0 &&
					pending.claims === 0 &&
					entry.refCount === 0 &&
					this.#entries.get(key) === entry
				) {
					void this.closeEntry(entry).catch(error =>
						logger.error("MCP zero-claim handoff cleanup failed", {
							path: `mcp:${entry.name}`,
							poolKey: key,
							error,
						}),
					);
				}
			}),
		);
	}

	private cancelPendingEntry(key: string, pending: PendingEntry, reason: unknown): void {
		if (pending.cancelled || pending.settled) return;
		pending.cancelled = true;
		pending.cancellationReason = reason;
		pending.openAbortController.abort(reason);
		if (this.#pending.get(key) === pending) this.#pending.delete(key);
		if (pending.entry && this.#entries.get(key) === pending.entry) this.#entries.delete(key);
		pending.reject(reason);
	}

	private startPendingEntry(
		key: string,
		name: string,
		config: MCPServerConfig,
		options: MCPPoolAcquireOptions,
	): PendingEntry {
		const { promise, resolve, reject } = Promise.withResolvers<PoolEntry>();
		const pending: PendingEntry = {
			promise,
			claims: 0,
			resolve,
			reject,
			waiters: new Set(),
			settled: false,
			cancelled: false,
			openAbortController: new AbortController(),
		};
		this.#pending.set(key, pending);

		const settlement = this.openEntry(key, name, config, options, pending)
			.then(
				async entry => {
					if (!pending.cancelled && entry.state === "connected") {
						pending.settled = true;
						entry.pending = undefined;
						pending.resolve(entry);
						this.scheduleZeroClaimCleanup(key, pending, entry);
						return;
					}
					if (!pending.cancelled) {
						pending.cancelled = true;
						pending.cancellationReason = new Error(`MCP connection closed during acquisition: ${name}`);
						pending.settled = true;
						pending.reject(pending.cancellationReason);
					}
					try {
						await this.closeEntry(entry);
					} catch (error) {
						logger.error("MCP cancelled acquire cleanup failed", { path: `mcp:${name}`, poolKey: key, error });
					}
				},
				error => {
					pending.settled = true;
					pending.reject(error);
				},
			)
			.finally(() => {
				if (this.#pending.get(key) === pending) this.#pending.delete(key);
			});
		pending.settlement = settlement;
		void settlement.catch(() => {});
		void pending.promise.catch(() => {});
		return pending;
	}

	private async openEntry(
		key: string,
		name: string,
		config: MCPServerConfig,
		options: MCPPoolAcquireOptions,
		pending: PendingEntry,
	): Promise<PoolEntry> {
		const identity = buildMCPPoolKeyIdentity(name, config, options);
		const generation = (this.#entryGenerations.get(key) ?? 0) + 1;
		this.#entryGenerations.set(key, generation);
		const placeholder = { type: "stdio", name, config } as unknown as MCPServerConnection;
		const entry: PoolEntry = {
			generation,
			key,
			name,
			config,
			identity,
			connection: placeholder,
			refCount: 0,
			leases: new Set<MCPPoolLeaseImpl>(),
			rootsByLease: new Map<MCPPoolLeaseImpl, Array<{ uri: string; name: string }>>(),
			pending,
			resourceSubscriptionCounts: new Map<string, number>(),
			resourceSubscriptionUpdate: Promise.resolve(),
			state: "connecting",
			events: [],
		};
		pending.entry = entry;
		this.record(entry, "connecting");
		try {
			const openSignal = AbortSignal.any([pending.openAbortController.signal, this.#shutdownController.signal]);
			pending.openSignal = openSignal;
			const connection = await this.#connect(name, config, {
				signal: openSignal,
				advertiseRoots: options.advertiseRoots,
				onNotification: options.onNotification,
				onRequest: options.onRequest,
				cwd: options.effectiveCwd,
			});
			entry.connection = connection;
			if (pending.cancelled || this.#pending.get(key) !== pending || this.#shuttingDown) {
				try {
					await connection.transport.close();
				} catch (closeError) {
					logger.error("MCP late transport close failed", {
						path: `mcp:${name}`,
						poolKey: key,
						error: closeError,
					});
				}
				throw pending.cancellationReason ?? new Error(`MCP connection acquisition abandoned: ${name}`);
			}
			this.#entries.set(key, entry);
			this.installTransportHandlers(entry, options);
			entry.state = "connected";
			this.record(entry, "connected");
			return entry;
		} catch (error) {
			entry.state = "error";
			this.record(entry, "error", error);
			throw error;
		}
	}

	private installTransportHandlers(entry: PoolEntry, options: MCPPoolAcquireOptions): void {
		const transport = entry.connection.transport;
		transport.onNotification = (method, params) => {
			if (
				!Object.values(MCPNotificationMethods).includes(
					method as (typeof MCPNotificationMethods)[keyof typeof MCPNotificationMethods],
				)
			) {
				this.record(entry, "error", new Error(`Unsupported MCP notification: ${method}`));
				return;
			}
			this.record(entry, "notification", `${method}`);
			options.onNotification?.(method, params);
			this.emit(entry, { type: "notification", method, params });
		};
		transport.onError = error => {
			this.record(entry, "error", error);
			this.emit(entry, { type: "error", error });
		};
		transport.onClose = () => {
			if (entry.state === "closed" || entry.state === "closing") return;
			entry.state = "closed";
			entry.transportCloseStarted = !transport.connected;
			if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
			this.record(entry, "close");
			this.emit(entry, { type: "close" });
		};
		transport.onRequest = async (method, params) => {
			if (method === "roots/list" && entry.identity.capabilityProfile === "roots") {
				const roots = new Map<string, { uri: string; name: string }>();
				for (const lease of entry.leases) {
					for (const root of entry.rootsByLease.get(lease) ?? []) roots.set(root.uri, root);
				}
				return { roots: [...roots.values()] };
			}
			if (options.onRequest) return options.onRequest(method, params);
			throw Object.assign(new Error(`Unsupported server request: ${method}`), { code: -32601 });
		};
	}

	private emit(entry: PoolEntry, event: MCPPoolEvent): void {
		for (const lease of entry.leases) lease.emit(event);
	}
	broadcastReplacement(key: string, success: boolean): void {
		for (const entry of [...this.#entries.values(), ...this.#retiredEntries]) {
			if (entry.key !== key) continue;
			this.emit(entry, { type: "replacement", success });
		}
	}
	updateLeaseRoots(entry: PoolEntry, lease: MCPPoolLeaseImpl, roots: Array<{ uri: string; name: string }>): void {
		entry.rootsByLease.set(
			lease,
			roots.map(root => ({ ...root })),
		);
		this.#scheduleRootsNotification(entry);
	}

	#scheduleRootsNotification(entry: PoolEntry): void {
		if (
			this.#shuttingDown ||
			entry.connection.protocol.era === "modern" ||
			entry.rootsNotificationScheduled ||
			entry.state === "closed" ||
			entry.transportCloseStarted
		)
			return;
		entry.rootsNotificationScheduled = true;
		queueMicrotask(() => {
			entry.rootsNotificationScheduled = false;
			if (this.#shuttingDown || entry.state === "closed" || entry.transportCloseStarted) return;
			void entry.connection.transport
				.notify("notifications/roots/list_changed")
				.catch(error =>
					logger.debug("MCP roots/list_changed notification failed", { path: `mcp:${entry.name}`, error }),
				);
		});
	}

	/** @internal Lease-facing aggregate subscription refcount update; not public API. */
	updateLeaseSubscriptions(entry: PoolEntry, previous: ReadonlySet<string>, next: ReadonlySet<string>): Promise<void> {
		const update = entry.resourceSubscriptionUpdate.then(async () => {
			const removed = [...previous].filter(uri => !next.has(uri));
			const added = [...next].filter(uri => !previous.has(uri));
			const nextCounts = new Map(entry.resourceSubscriptionCounts);
			const unsubscribe: string[] = [];
			for (const uri of removed) {
				const count = nextCounts.get(uri) ?? 0;
				if (count <= 1) {
					nextCounts.delete(uri);
					unsubscribe.push(uri);
				} else {
					nextCounts.set(uri, count - 1);
				}
			}
			if (unsubscribe.length > 0)
				await unsubscribeFromResources(entry.connection, unsubscribe, { throwOnError: true });

			const subscribe: string[] = [];
			for (const uri of added) {
				const count = nextCounts.get(uri) ?? 0;
				nextCounts.set(uri, count + 1);
				if (count === 0) subscribe.push(uri);
			}
			if (subscribe.length > 0) {
				try {
					await subscribeToResources(entry.connection, subscribe, { throwOnError: true });
				} catch (error) {
					if (unsubscribe.length > 0) {
						try {
							await subscribeToResources(entry.connection, unsubscribe, { throwOnError: true });
						} catch (restoreError) {
							throw new AggregateError(
								[error, restoreError],
								"MCP resource subscription transaction rollback failed",
							);
						}
					}
					throw error;
				}
			}
			entry.resourceSubscriptionCounts = nextCounts;
		});
		entry.resourceSubscriptionUpdate = update.catch(() => {});
		return update;
	}

	async releaseLease(entry: PoolEntry, lease: MCPPoolLeaseImpl, subscriptions: ReadonlySet<string>): Promise<void> {
		if (!entry.leases.has(lease)) return;
		if (entry.state === "closed" || entry.transportCloseStarted) {
			entry.resourceSubscriptionCounts.clear();
			entry.leases.delete(lease);
			entry.rootsByLease.delete(lease);
			this.#allLeases.delete(lease);
			entry.refCount = Math.max(0, entry.refCount - 1);
			if (entry.refCount === 0) await this.closeEntry(entry);
			return;
		}
		const subscriptionUpdate = this.updateLeaseSubscriptions(entry, subscriptions, new Set());
		await subscriptionUpdate;
		entry.leases.delete(lease);
		entry.rootsByLease.delete(lease);
		this.#scheduleRootsNotification(entry);
		this.#allLeases.delete(lease);
		entry.refCount = Math.max(0, entry.refCount - 1);
		if (entry.refCount > 0) return;
		if (entry.identity.sharingMode === "shared" && this.#sharedPoolIdleMs > 0) {
			this.#scheduleIdleClose(entry);
			return;
		}
		try {
			await this.closeEntry(entry);
		} catch (error) {
			let releaseError: unknown = error;
			try {
				await this.updateLeaseSubscriptions(entry, new Set(), subscriptions);
			} catch (restoreError) {
				releaseError = new AggregateError([error, restoreError], "MCP lease release rollback failed");
			}
			entry.leases.add(lease);
			entry.rootsByLease.set(lease, []);
			this.#allLeases.add(lease);
			entry.refCount += 1;
			throw releaseError;
		}
	}

	#scheduleIdleClose(entry: PoolEntry): void {
		if (
			this.#shuttingDown ||
			this.#sharedPoolIdleMs <= 0 ||
			entry.refCount !== 0 ||
			entry.state !== "connected" ||
			entry.transportCloseStarted
		)
			return;
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		entry.idleTimer = setTimeout(() => {
			entry.idleTimer = undefined;
			void this.closeEntry(entry).catch(error => {
				logger.debug("MCP pool idle close failed", { error });
				// A transient close failure leaves a connected, unleased shared entry
				// in the pool. Keep retrying its idle close rather than leaking the
				// transport until a later acquire happens to touch this key.
				this.#scheduleIdleClose(entry);
			});
		}, this.#sharedPoolIdleMs);
	}

	private closeEntry(entry: PoolEntry): Promise<void> {
		if (entry.closePromise) return entry.closePromise;
		const wasRetired = this.#retiredEntries.has(entry);
		const closePromise = Promise.resolve().then(async () => {
			if (entry.idleTimer) {
				clearTimeout(entry.idleTimer);
				entry.idleTimer = undefined;
			}
			if (entry.transportCloseStarted) {
				entry.state = "closed";
				entry.resourceSubscriptionCounts.clear();
				for (const lease of entry.leases) this.#allLeases.delete(lease);
				entry.leases.clear();
				entry.rootsByLease.clear();
				if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
				this.#retiredEntries.delete(entry);
				entry.events.length = 0;
				return;
			}
			entry.transportCloseStarted = true;
			entry.state = "closing";
			this.record(entry, "closing");
			if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
			let closed = false;
			try {
				await entry.connection.transport.close();
				closed = true;
			} catch (error) {
				this.record(entry, "error", error);
				throw error;
			} finally {
				if (closed) {
					entry.state = "closed";
					entry.resourceSubscriptionCounts.clear();
					this.record(entry, "closed");
				} else {
					entry.transportCloseStarted = false;
					entry.state = wasRetired || !entry.connection.transport.connected ? "error" : "connected";
					if (
						entry.state === "connected" &&
						this.#entryGenerations.get(entry.key) === entry.generation &&
						!this.#entries.has(entry.key)
					)
						this.#entries.set(entry.key, entry);
					if (
						entry.state === "connected" &&
						entry.refCount === 0 &&
						entry.identity.sharingMode === "shared" &&
						this.#sharedPoolIdleMs > 0 &&
						!this.#shuttingDown
					)
						this.#scheduleIdleClose(entry);
				}
			}
		});
		entry.closePromise = closePromise.finally(() => {
			entry.closePromise = undefined;
			if (entry.state === "closed") this.#retiredEntries.delete(entry);
		});
		return entry.closePromise;
	}

	private record(entry: PoolEntry, type: MCPPoolHealthEvent["type"], error?: unknown): void {
		entry.events.push({
			type,
			at: Date.now(),
			...(error === undefined ? {} : { message: redactedHealthMessage(error) }),
		});
		if (entry.events.length > 20) entry.events.splice(0, entry.events.length - 20);
		this.notifyHealthChanged();
	}

	private notifyHealthChanged(): void {
		const health = this.getHealth();
		for (const listener of this.#healthListeners) {
			try {
				listener(health);
			} catch (error) {
				logger.debug("MCP pool health listener failed", { error });
			}
		}
	}

	getHealth(): MCPPoolHealth[] {
		return [...this.#entries.values()].map(entry => ({
			key: entry.key,
			serverName: entry.name,
			transport: transportName(entry.config),
			state: entry.state,
			refCount: entry.refCount,
			events: entry.events.slice(-20).map(event => ({
				...event,
				...(event.message ? { message: event.message.slice(0, 512) } : {}),
			})),
		}));
	}

	onHealthChanged(listener: HealthListener): () => void {
		this.#healthListeners.add(listener);
		return () => this.#healthListeners.delete(listener);
	}

	async shutdown(): Promise<void> {
		if (this.#shuttingDown) return;
		this.#shuttingDown = true;
		const reason = new Error("MCP connection pool shut down");
		this.#shutdownController.abort(reason);
		for (const [key, pending] of this.#pending) {
			if (!pending.cancelled) {
				pending.cancelled = true;
				pending.cancellationReason = reason;
				pending.openAbortController.abort(reason);
				pending.reject(reason);
			}
			for (const waiter of pending.waiters) {
				waiter.settled = true;
				waiter.removeAbortListener?.();
				waiter.reject(reason);
			}
			pending.waiters.clear();
			if (this.#pending.get(key) === pending) this.#pending.delete(key);
		}
		for (const lease of this.#allLeases) lease.invalidate(reason);
		this.#allLeases.clear();
		const entries = [...new Set([...this.#entries.values(), ...this.#retiredEntries])];
		for (const entry of entries) {
			for (const lease of entry.leases) lease.invalidate(reason);
			entry.leases.clear();
			entry.rootsByLease.clear();
		}
		const closeResults = await Promise.allSettled(entries.map(entry => this.closeEntry(entry)));
		for (const [index, result] of closeResults.entries()) {
			if (result.status === "rejected") {
				const entry = entries[index];
				logger.error("MCP pool shutdown close failed", {
					serverName: entry?.name,
					poolKey: entry?.key,
					error: result.reason,
				});
			}
		}
		this.#entries.clear();
		this.#retiredEntries.clear();
		this.#restartOwners.clear();
		for (const waiter of this.#restartWaiters.values()) waiter.resolve(false);
		this.#restartWaiters.clear();
		this.#pending.clear();
		this.notifyHealthChanged();
	}
}

export { buildMCPPoolKeyIdentity, computeMCPPoolKey, MCPPoolConfigError } from "./pool-key";
