/**
 * MCP Server Manager.
 *
 * Discovers, connects to, and manages MCP servers.
 * Handles tool loading and lifecycle.
 */

import { realpathSync } from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { isCanonicalMCPOAuthBinding, resolveMCPOAuthResourceOrigin, type TSchema } from "@gajae-code/ai/core";
import { logger } from "@gajae-code/utils";
import type { SourceMeta } from "../capability/types";
import * as configValue from "../config/resolve-config-value";
import type { Settings } from "../config/settings";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { AuthStorage, OAuthCredential } from "../session/auth-storage";
import {
	getPrompt,
	listPrompts,
	listResources,
	listResourceTemplates,
	listTools,
	readResource,
	serverSupportsPrompts,
	serverSupportsResources,
} from "./client";
import { loadAllMCPConfigs, validateServerConfig } from "./config";
import {
	MCPConnectionPool,
	MCPPoolAcquireAbortError,
	type MCPPoolEvent,
	type MCPPoolLease,
	MCPPoolLeaseObsoleteError,
	MCPPoolLeaseReleaseError,
} from "./pool";
import type { MCPProtocolObservation } from "./protocol";
import type { MCPToolDetails } from "./tool-bridge";
import { DeferredMCPTool, MCPTool } from "./tool-bridge";
import type { MCPToolCache } from "./tool-cache";
import { HttpTransport } from "./transports/http";
import type {
	MCPGetPromptResult,
	MCPInputRequestHandler,
	MCPPrompt,
	MCPRequestOptions,
	MCPResource,
	MCPResourceReadResult,
	MCPResourceTemplate,
	MCPServerConfig,
	MCPServerConnection,
	MCPToolDefinition,
} from "./types";
import { MCPExpectedFailure, MCPNotificationMethods } from "./types";

type ToolLoadResult = {
	connection: MCPServerConnection;
	serverTools: MCPToolDefinition[];
};

type TrackedPromise<T> = {
	promise: Promise<T>;
	status: "pending" | "fulfilled" | "rejected";
	value?: T;
	reason?: unknown;
};
type ConnectionTask = {
	name: string;
	config: MCPServerConfig;
	tracked: TrackedPromise<ToolLoadResult>;
	connectionPromise: Promise<MCPServerConnection>;
	toolsPromise: Promise<ToolLoadResult>;
	connectionAbort: AbortController;
	connectionEpoch: number;
	disconnectEpoch: number;
};

type ScopedOperation = {
	id: number;
	name: string;
	lifecycleEpoch: number;
	controller: AbortController;
	lease?: MCPPoolLease;
	leaseReady: Promise<MCPPoolLease | undefined>;
	resolveLeaseReady: (lease: MCPPoolLease | undefined) => void;
	releasePromise?: Promise<void>;
	completion: Promise<unknown>;
};
type DeferredSharedRebind = {
	lease: MCPPoolLease;
	managerEpoch: number;
};
type ActiveSharedRebind = {
	lease: MCPPoolLease;
	promise: Promise<void>;
};
type RetiredLeaseRelease = {
	name: string;
	connection: MCPServerConnection;
	poolKey: string;
	promise: Promise<void>;
};

const STARTUP_TIMEOUT_MS = 250;
const STARTUP_TIMEOUT_GRACE_MS = 500;
/**
 * Default ceiling on how long `discoverAndConnect` waits for a server batch to
 * come up. Deliberately short: a config with a large `timeout` must not be able
 * to hang ordinary startup. ACP lifecycle launches carry their own, larger
 * budget derived from the readiness deadline (see `maxStartupTimeoutMs`).
 */
const MAX_STARTUP_TIMEOUT_MS = 1_750;
const DEFAULT_EXACT_CONFIG_STARTUP_TIMEOUT_MS = 30_000;

export function resolveStartupTimeoutMs(configs: MCPServerConfig[], maxStartupTimeoutMs?: number): number {
	const ceiling =
		typeof maxStartupTimeoutMs === "number" && Number.isFinite(maxStartupTimeoutMs) && maxStartupTimeoutMs > 0
			? Math.max(STARTUP_TIMEOUT_MS, maxStartupTimeoutMs)
			: MAX_STARTUP_TIMEOUT_MS;
	const configuredTimeouts = configs
		.map(config => config.timeout)
		.filter((timeout): timeout is number => typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0);
	if (configuredTimeouts.length === 0) return STARTUP_TIMEOUT_MS;
	return Math.min(ceiling, Math.max(STARTUP_TIMEOUT_MS, Math.max(...configuredTimeouts) + STARTUP_TIMEOUT_GRACE_MS));
}

export function resolveExactConfigStartupTimeoutMs(configs: MCPServerConfig[]): number {
	const effectiveTimeouts = configs.map(config => {
		const timeout = config.timeout;
		return typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
			? timeout
			: DEFAULT_EXACT_CONFIG_STARTUP_TIMEOUT_MS;
	});
	if (effectiveTimeouts.length === 0) return STARTUP_TIMEOUT_MS;
	return Math.max(...effectiveTimeouts) + STARTUP_TIMEOUT_GRACE_MS;
}

/**
 * Whether `config` declared a connection window that is still open `elapsedMs`
 * into startup.
 *
 * The startup wait bounds how long session start blocks; a declared `timeout`
 * bounds how long the server itself may take to come up (`connectToServer`
 * enforces it). Those are different budgets: the wait elapsing says nothing
 * about whether the operator's declared window has been spent.
 */
export function withinDeclaredConnectionWindow(config: MCPServerConfig, elapsedMs: number): boolean {
	const timeout = config.timeout;
	if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return false;
	return elapsedMs < timeout;
}

function trackPromise<T>(promise: Promise<T>): TrackedPromise<T> {
	const tracked: TrackedPromise<T> = { promise, status: "pending" };
	promise.then(
		value => {
			tracked.status = "fulfilled";
			tracked.value = value;
		},
		reason => {
			tracked.status = "rejected";
			tracked.reason = reason;
		},
	);
	return tracked;
}
const EXPECTED_CONFIG_RESOLUTION_CODES = new Set([
	"EACCES",
	"EISDIR",
	"ELOOP",
	"ENAMETOOLONG",
	"ENOENT",
	"ENOTDIR",
	"EPERM",
	"ESTALE",
]);

function isExpectedConfigResolutionFailure(error: unknown): boolean {
	if (error instanceof DOMException && error.name === "AbortError") return true;
	if (!(error instanceof Error)) return false;
	if (error.name === "AbortError") return true;
	const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
	return code !== undefined && EXPECTED_CONFIG_RESOLUTION_CODES.has(code);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) return Bun.sleep(ms);
	if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error("Aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function canonicalMCPWorkingDirectory(candidate: string): string {
	const absolute = path.resolve(candidate);
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

export class MCPManagerLifecycleError extends Error {
	readonly code = "MCP_MANAGER_LIFECYCLE_CLOSED" as const;
	readonly phase: "disconnect" | "reconnect";

	constructor(phase: "disconnect" | "reconnect", cause?: unknown) {
		super(
			`MCP manager is ${phase === "disconnect" ? "disconnecting" : "rotating MCP connections"}${
				cause instanceof Error ? `: ${cause.message}` : ""
			}`,
			cause instanceof Error ? { cause } : undefined,
		);
		this.name = "MCPManagerLifecycleError";
		this.phase = phase;
	}
}

/**
 * Stable, total ordering on MCP tools by name.
 *
 * Anthropic prompt caching keys on byte-identical tool definitions: any reorder
 * of the tools array invalidates the tools cache breakpoint and forces a full
 * prefix rebuild on the next request. MCP servers connect/reconnect at arbitrary
 * times, so the natural "insertion order" of `#tools` is non-deterministic.
 * Sorting after every mutation makes the array bytes independent of connection
 * sequence.
 */
export function sortMCPToolsByName<T extends { name: string }>(tools: T[]): T[] {
	tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return tools;
}

export function resolveSubscriptionPostAction(
	notificationsEnabled: boolean,
	currentEpoch: number,
	subscriptionEpoch: number,
): "rollback" | "ignore" | "apply" {
	if (!notificationsEnabled) return "rollback";
	if (currentEpoch !== subscriptionEpoch) return "ignore";
	return "apply";
}
/** Result of loading MCP tools */
export interface MCPLoadResult {
	/** Loaded tools as CustomTool instances */
	tools: CustomTool<TSchema, MCPToolDetails>[];
	/** Connection errors by server name */
	errors: Map<string, string>;
	/** Connected server names */
	connectedServers: string[];
	/** Extracted Exa API keys from filtered MCP servers */
	exaApiKeys: string[];
}

/** Options for discovering and connecting to MCP servers */
export interface MCPDiscoverOptions {
	/** Whether to load project-level config (default: true) */
	enableProjectConfig?: boolean;
	/** Whether to filter out Exa MCP servers (default: true) */
	filterExa?: boolean;
	/** Whether to filter out browser MCP servers when builtin browser tool is enabled (default: false) */
	filterBrowser?: boolean;
	/** Only connect servers with autoload !== false (default: false) */
	autoloadOnly?: boolean;
	/**
	 * Restrict discovery to GJC's native `.gjc` scopes (user + project).
	 * Runtime MCP authority for GJC sessions; Claude Code/Codex files are
	 * explicit import sources into `.gjc`, not implicit runtime authorities.
	 */
	nativeOnly?: boolean;
	/** Called when starting to connect to servers */
	onConnecting?: (serverNames: string[]) => void;
	/** Load only this explicit MCP config file. */
	configPath?: string;
	/** Idle retention for shared MCP pool entries. */
	sharedPoolIdleMs?: number;
	/** Selected session profile for user-scope config discovery. */
	agentDir?: string;
	/** Selected session settings for capability policy. */
	settings?: Settings;
}

export interface MCPManagerOptions {
	/** Restrict this instance to tools from an explicit MCP config. */
	toolsOnly?: boolean;
	/**
	 * Ceiling for the startup wait, in milliseconds. Only ACP lifecycle launches
	 * set this, so a slow ACP MCP handshake gets the readiness budget while every
	 * other consumer keeps the short default. Non-positive or non-finite values
	 * are ignored and the default applies.
	 */
	maxStartupTimeoutMs?: number;
	/** Connection pool used for every physical MCP open/close. */
	pool?: MCPConnectionPool;
	/** Session identity included in per-session pool keys. */
	sessionId?: string;
	/** Idle retention for shared pool entries. */
	sharedPoolIdleMs?: number;
	/** Test seam for deterministic reconnect backoff scheduling. */
	sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
	/** Test seam for fencing the acquisition-to-registration replacement race. */
	afterLeaseAcquiredForTests?: (name: string, lease: MCPPoolLease) => void | Promise<void>;
	agentDir?: string;
	settings?: Settings;
}

/**
 * MCP Server Manager.
 *
 * Manages connections to MCP servers and provides tools to the agent.
 */
export class MCPManager {
	static #instance: MCPManager | undefined;

	/**
	 * Process-global compatibility holder used only by legacy lifecycle/test seams.
	 * Production MCP routing uses the scope-held facade carried through ResolveContext.
	 */
	static instance(): MCPManager | undefined {
		return MCPManager.#instance;
	}

	/** Install or clear the process-global compatibility holder. */
	static setInstance(value: MCPManager | undefined): void {
		MCPManager.#instance = value;
	}

	/** Reset the process-global instance. Test-only. */
	static resetForTests(): void {
		MCPManager.#instance = undefined;
	}

	#connections = new Map<string, MCPServerConnection>();
	readonly #pool: MCPConnectionPool;
	readonly #sessionId: string;
	readonly #leases = new Map<string, MCPPoolLease>();
	readonly #leaseEventUnsubscribers = new Map<string, () => void>();
	readonly #leaseByConnection = new Map<MCPServerConnection, MCPPoolLease>();
	readonly #retryableLeaseReleases = new Map<MCPPoolLease, { name: string; connection: MCPServerConnection }>();
	readonly #scopedOperations = new Map<number, ScopedOperation>();
	readonly #retiredLeaseReleases = new Set<RetiredLeaseRelease>();
	#nextScopedOperationId = 1;
	#tools: CustomTool<TSchema, MCPToolDetails>[] = [];
	#pendingConnections = new Map<string, Promise<MCPServerConnection>>();
	#pendingConnectionControllers = new Map<string, AbortController>();
	#pendingToolLoads = new Map<string, Promise<ToolLoadResult>>();
	#sources = new Map<string, SourceMeta>();
	#authStorage: AuthStorage | null = null;
	#inputRequestHandler: MCPInputRequestHandler | null = null;
	#onNotification?: (serverName: string, method: string, params: unknown) => void;
	#onToolsChanged?: (tools: CustomTool<TSchema, MCPToolDetails>[]) => void;
	#onResourcesChanged?: (serverName: string, uri: string) => void;
	#onPromptsChanged?: (serverName: string) => void;
	#notificationsEnabled = false;
	#notificationsEpoch = 0;
	#subscribedResources = new Map<string, Set<string>>();
	#pendingResourceRefresh = new Map<string, { connection: MCPServerConnection; promise: Promise<void> }>();
	#pendingReconnections = new Map<string, Promise<MCPServerConnection | null>>();
	#deferredSharedRebinds = new Map<string, DeferredSharedRebind>();
	#activeSharedRebinds = new Map<string, ActiveSharedRebind>();
	#disconnectEpochs = new Map<string, number>();
	#reconnectBackoffs = new Map<string, AbortController>();
	/** Preserved configs for reconnection after connection loss. */
	#serverConfigs = new Map<string, MCPServerConfig>();
	/** Monotonic epoch incremented on disconnectAll to invalidate stale reconnections. */
	#epoch = 0;
	#scopedLifecycle: "open" | "disconnecting" | "reconnecting" = "open";
	#scopedLifecycleEpoch = 0;
	readonly #toolsOnly: boolean;
	#toolsOnlyConfigLoaded = false;
	#connectionSetSealed = false;

	#serverError(message: string): string {
		return this.#toolsOnly ? "MCP server unavailable" : message;
	}
	#assertRawMCPAccessAllowed(): void {
		if (this.#toolsOnly) throw new Error("Tools-only MCP manager does not allow raw MCP access");
	}
	#beginScopedLifecycle(phase: "disconnecting" | "reconnecting"): number {
		this.#scopedLifecycle = phase;
		this.#scopedLifecycleEpoch += 1;
		return this.#scopedLifecycleEpoch;
	}

	#finishScopedLifecycle(epoch: number): void {
		if (this.#scopedLifecycleEpoch !== epoch) return;
		this.#scopedLifecycle = "open";
		this.#drainDeferredSharedRebinds();
	}

	#assertScopedAdmission(): number {
		if (this.#scopedLifecycle !== "open") {
			throw new MCPManagerLifecycleError(this.#scopedLifecycle === "disconnecting" ? "disconnect" : "reconnect");
		}
		return this.#scopedLifecycleEpoch;
	}
	#assertConnectionSetMutable(): void {
		if (this.#connectionSetSealed) throw new Error("MCP manager connection set is sealed");
	}

	sealConnectionSet(): void {
		this.#connectionSetSealed = true;
	}

	isConnectionSetSealed(): boolean {
		return this.#connectionSetSealed;
	}

	async #acquireLease(
		name: string,
		resolvedConfig: MCPServerConfig,
		originalConfig: MCPServerConfig,
		connectionAbort: AbortController,
		trackManagerLease = true,
	): Promise<MCPPoolLease> {
		const sharedConfig = originalConfig.sharing === "shared";
		const sharedEligible =
			sharedConfig &&
			(resolvedConfig.type === "http" ||
				resolvedConfig.type === "sse" ||
				(resolvedConfig.type === "stdio" && this.#toolsOnly));
		if (sharedConfig && !sharedEligible) {
			logger.debug("MCP shared pooling is limited to tools-only stdio and remote HTTP/SSE in W6", {
				path: `mcp:${name}`,
			});
		}
		const lease = await this.#pool.acquire(name, resolvedConfig, {
			keyConfig: originalConfig,
			sharingMode: sharedEligible ? "shared" : "per-session",
			sessionId: sharedEligible ? undefined : this.#sessionId,
			signal: connectionAbort.signal,
			advertiseRoots: !this.#toolsOnly,
			effectiveCwd: resolvedConfig.type === "stdio" ? (resolvedConfig.cwd ?? this.cwd) : this.cwd,
			capabilityProfile: this.#toolsOnly ? "tools-only" : "roots",
			effectiveHeaders:
				resolvedConfig.type === "http" || resolvedConfig.type === "sse" ? resolvedConfig.headers : undefined,
			onRequest: (method, params) => this.#handleServerRequest(method, params),
		});
		if (trackManagerLease) this.#leaseByConnection.set(lease.connection, lease);
		if (!this.#toolsOnly) lease.updateRoots(this.#getRoots().roots);
		return lease;
	}

	#queueDeferredSharedRebind(name: string, lease: MCPPoolLease, managerEpoch: number): void {
		if (this.#epoch !== managerEpoch || this.#scopedLifecycle === "disconnecting") return;
		this.#deferredSharedRebinds.set(name, { lease, managerEpoch });
	}

	#scheduleSharedRebind(name: string, lease: MCPPoolLease): void {
		if (this.#scopedLifecycle === "disconnecting") return;
		const active = this.#activeSharedRebinds.get(name);
		if (active) {
			if (active.lease !== lease) this.#queueDeferredSharedRebind(name, lease, this.#epoch);
			return;
		}
		let tracked: Promise<void>;
		tracked = this.#rebindAfterSharedRestart(name, lease)
			.catch(error => {
				logger.debug("MCP shared lease replacement failed", { path: `mcp:${name}`, error });
			})
			.finally(() => {
				const current = this.#activeSharedRebinds.get(name);
				if (current?.promise !== tracked) return;
				this.#activeSharedRebinds.delete(name);
				this.#drainDeferredSharedRebinds();
			});
		this.#activeSharedRebinds.set(name, { lease, promise: tracked });
	}

	#drainDeferredSharedRebinds(): void {
		if (this.#scopedLifecycle !== "open" || this.#deferredSharedRebinds.size === 0) return;
		for (const [name, pending] of this.#deferredSharedRebinds.entries()) {
			if (pending.managerEpoch !== this.#epoch) {
				this.#deferredSharedRebinds.delete(name);
				continue;
			}
			if (this.#activeSharedRebinds.has(name)) continue;
			this.#deferredSharedRebinds.delete(name);
			this.#scheduleSharedRebind(name, pending.lease);
		}
	}

	#connectionForLease(connection: MCPServerConnection): MCPServerConnection {
		return this.#leaseByConnection.get(connection)?.connectionForLease() ?? connection;
	}

	/**
	 * Register `connection`'s lease as the current lease for `name` and install
	 * the reconnect trigger. Called only once a connect/reconnect attempt is
	 * accepted as current; an earlier registered lease is superseded and
	 * released.
	 */
	#registerLease(name: string, connection: MCPServerConnection): void {
		const lease = this.#leaseByConnection.get(connection);
		if (!lease) return;
		const previous = this.#leases.get(name);
		if (previous === lease) {
			if (!this.#toolsOnly) lease.updateRoots(this.#getRoots().roots);
			return;
		}
		this.#leaseEventUnsubscribers.get(name)?.();
		this.#leaseEventUnsubscribers.delete(name);
		previous &&
			this.#releaseLease(name, previous.connection).catch(error => {
				const diagnostic = new MCPPoolLeaseReleaseError(name, previous.key, error);
				logger.error("MCP stale lease release failed", {
					path: `mcp:${name}`,
					serverName: name,
					poolKey: previous.key,
					error: diagnostic,
				});
			});
		this.#leases.set(name, lease);
		if (!this.#toolsOnly) lease.updateRoots(this.#getRoots().roots);
		this.#leaseEventUnsubscribers.set(
			name,
			lease.onEvent((event: MCPPoolEvent) => {
				if (event.type === "replacement") {
					if (event.success && !this.#pendingReconnections.has(name)) this.#scheduleSharedRebind(name, lease);
					return;
				}
				if (event.type === "notification") {
					this.#handleServerNotification(name, event.method, event.params);
					return;
				}
				if (event.type !== "close" || this.#connectionSetSealed) return;
				void this.reconnectServer(name);
			}),
		);
	}

	async #rebindAfterSharedRestart(name: string, lease: MCPPoolLease): Promise<void> {
		const managerEpoch = this.#epoch;
		if (this.#scopedLifecycle === "disconnecting") return;
		if (this.#scopedLifecycle === "reconnecting") {
			this.#queueDeferredSharedRebind(name, lease, managerEpoch);
			return;
		}
		const lifecycleEpoch = this.#assertScopedAdmission();
		const currentLease = this.#leases.get(name);
		if (currentLease && currentLease !== lease) return;
		const oldConnection = lease.connection;
		const config = this.#serverConfigs.get(name) ?? oldConnection.config;
		const source = this.#sources.get(name) ?? oldConnection._source;
		if (currentLease === lease) {
			await this.#releaseLease(name, oldConnection);
			this.#connections.delete(name);
		}
		const lifecycleAfterRelease = this.#scopedLifecycle as "open" | "disconnecting" | "reconnecting";
		if (lifecycleAfterRelease === "disconnecting" || this.#epoch !== managerEpoch) return;
		if (lifecycleAfterRelease === "reconnecting") {
			this.#queueDeferredSharedRebind(name, lease, managerEpoch);
			return;
		}
		if (this.#scopedLifecycleEpoch !== lifecycleEpoch) {
			this.#queueDeferredSharedRebind(name, lease, managerEpoch);
			this.#drainDeferredSharedRebinds();
			return;
		}
		try {
			await this.#connectAndWireServer(
				name,
				config,
				source,
				managerEpoch,
				this.#disconnectEpochs.get(name) ?? 0,
				lifecycleEpoch,
			);
		} catch (error) {
			const lifecycleAfterConnect = this.#scopedLifecycle as "open" | "disconnecting" | "reconnecting";
			if (error instanceof MCPPoolLeaseObsoleteError) {
				if (this.#epoch === managerEpoch && lifecycleAfterConnect !== "disconnecting") {
					this.#queueDeferredSharedRebind(name, lease, managerEpoch);
					this.#drainDeferredSharedRebinds();
				}
				return;
			}
			if (this.#epoch !== managerEpoch || lifecycleAfterConnect === "disconnecting") return;
			if (this.#scopedLifecycleEpoch !== lifecycleEpoch) {
				this.#queueDeferredSharedRebind(name, lease, managerEpoch);
				this.#drainDeferredSharedRebinds();
				return;
			}
			logger.debug("MCP shared lease rebind failed", { path: `mcp:${name}`, error });
		}
	}

	/**
	 * Release the lease registered under `name`.
	 *
	 * When `connection` is provided, the release only applies if the registered
	 * lease still belongs to that connection; a stale connect/reconnect task must
	 * never tear down a newer lease registered under the same server name.
	 */
	async #releaseLease(name: string, connection?: MCPServerConnection, retainFailure = true): Promise<void> {
		const registered = this.#leases.get(name);
		if (connection) {
			// Release exactly the lease that belongs to this connection, whether or
			// not it is the currently registered one; never tear down a newer lease
			// registered under the same server name by a later attempt.
			const lease = this.#leaseByConnection.get(connection);
			if (!lease) return;
			if (registered === lease) {
				this.#leaseEventUnsubscribers.get(name)?.();
				this.#leaseEventUnsubscribers.delete(name);
				this.#leases.delete(name);
			}
			try {
				await lease.release();
				this.#retryableLeaseReleases.delete(lease);
				this.#leaseByConnection.delete(connection);
			} catch (error) {
				if (retainFailure) this.#retryableLeaseReleases.set(lease, { name, connection });
				throw error;
			}
			return;
		}
		if (!registered) return;
		this.#leaseEventUnsubscribers.get(name)?.();
		this.#leaseEventUnsubscribers.delete(name);
		this.#leases.delete(name);
		try {
			await registered.release();
			this.#retryableLeaseReleases.delete(registered);
			this.#leaseByConnection.delete(registered.connection);
		} catch (error) {
			if (retainFailure) this.#retryableLeaseReleases.set(registered, { name, connection: registered.connection });
			throw error;
		}
	}

	async #releaseScopedLease(operation: ScopedOperation): Promise<void> {
		if (!operation.releasePromise) {
			operation.releasePromise = operation.leaseReady.then(async lease => {
				if (!lease) return;
				try {
					await lease.release();
					this.#retryableLeaseReleases.delete(lease);
				} catch (error) {
					this.#retryableLeaseReleases.set(lease, { name: operation.name, connection: lease.connection });
					throw error;
				}
			});
		}
		return operation.releasePromise;
	}

	async #retireScopedOperations(name: string, reason: Error): Promise<void> {
		const operations = [...this.#scopedOperations.values()].filter(operation => operation.name === name);
		for (const operation of operations) operation.controller.abort(reason);
		const releases = await Promise.allSettled(operations.map(operation => this.#releaseScopedLease(operation)));
		for (const [index, result] of releases.entries()) {
			if (result.status === "rejected") {
				const operation = operations[index];
				this.#logLeaseReleaseFailure(
					operation?.name ?? name,
					operation?.lease?.connection,
					result.reason,
					operation?.lease?.key,
				);
			}
		}
	}

	async #shutdownScopedOperations(reason: Error): Promise<unknown[]> {
		const operations = [...this.#scopedOperations.values()];
		for (const operation of operations) operation.controller.abort(reason);
		const releases = await Promise.allSettled(operations.map(operation => this.#releaseScopedLease(operation)));
		const failures: unknown[] = [];
		for (const [index, result] of releases.entries()) {
			if (result.status === "rejected") {
				const operation = operations[index];
				failures.push(
					this.#logLeaseReleaseFailure(
						operation?.name ?? "unknown",
						operation?.lease?.connection,
						result.reason,
						operation?.lease?.key,
					),
				);
			}
		}
		await Promise.allSettled(operations.map(operation => operation.completion));
		return failures;
	}
	#leaseReleaseDiagnostic(
		name: string,
		connection: MCPServerConnection | undefined,
		error: unknown,
		poolKey?: string,
	): MCPPoolLeaseReleaseError {
		const lease = connection ? this.#leaseByConnection.get(connection) : this.#leases.get(name);
		return new MCPPoolLeaseReleaseError(name, poolKey ?? lease?.key ?? "unknown", error);
	}

	#logLeaseReleaseFailure(
		name: string,
		connection: MCPServerConnection | undefined,
		error: unknown,
		poolKey?: string,
	): MCPPoolLeaseReleaseError {
		const diagnostic = this.#leaseReleaseDiagnostic(name, connection, error, poolKey);
		logger.error("MCP lease release failed", {
			path: `mcp:${name}`,
			serverName: name,
			poolKey: diagnostic.poolKey,
			error: diagnostic,
		});
		return diagnostic;
	}

	#trackRetiredLeaseRelease(name: string, connection: MCPServerConnection, promise: Promise<void>): void {
		const lease = this.#leaseByConnection.get(connection);
		const retired: RetiredLeaseRelease = {
			name,
			connection,
			poolKey: lease?.key ?? "unknown",
			promise,
		};
		this.#retiredLeaseReleases.add(retired);
		void promise.then(
			() => {
				this.#retiredLeaseReleases.delete(retired);
			},
			() => {
				// Keep rejected retired releases for disconnectAll aggregation.
			},
		);
	}

	async #drainRetiredLeaseReleases(): Promise<unknown[]> {
		const failures: unknown[] = [];
		for (;;) {
			const retired = [...this.#retiredLeaseReleases];
			if (retired.length === 0) {
				await Promise.resolve();
				if (this.#retiredLeaseReleases.size === 0) return failures;
				continue;
			}
			const results = await Promise.allSettled(retired.map(item => item.promise));
			for (const item of retired) this.#retiredLeaseReleases.delete(item);
			for (const [index, result] of results.entries()) {
				if (result.status !== "rejected") continue;
				const item = retired[index];
				failures.push(
					result.reason instanceof MCPPoolLeaseReleaseError
						? result.reason
						: this.#logLeaseReleaseFailure(
								item?.name ?? "unknown",
								item?.connection,
								result.reason,
								item?.poolKey,
							),
				);
			}
		}
	}
	async #releaseLeasePreservingPrimary(name: string, connection: MCPServerConnection): Promise<void> {
		try {
			await this.#releaseLease(name, connection);
		} catch (cleanupError) {
			this.#logLeaseReleaseFailure(name, connection, cleanupError);
		}
	}

	#isCurrentConnection(
		name: string,
		_config: MCPServerConfig,
		globalEpoch: number,
		disconnectEpoch: number,
		connection: MCPServerConnection,
	): boolean {
		return (
			this.#serverConfigs.has(name) &&
			this.#epoch === globalEpoch &&
			(this.#disconnectEpochs.get(name) ?? 0) === disconnectEpoch &&
			this.#connections.get(name) === connection
		);
	}

	readonly #maxStartupTimeoutMs: number | undefined;
	readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
	readonly #afterLeaseAcquiredForTests?: (name: string, lease: MCPPoolLease) => void | Promise<void>;
	readonly #agentDir: string | undefined;
	readonly #settings: Settings | undefined;

	constructor(
		private cwd: string,
		private toolCache: MCPToolCache | null = null,
		options: MCPManagerOptions = {},
	) {
		this.#toolsOnly = options.toolsOnly === true;
		this.#maxStartupTimeoutMs = options.maxStartupTimeoutMs;
		this.#sleep = options.sleep ?? delay;
		this.#afterLeaseAcquiredForTests = options.afterLeaseAcquiredForTests;
		this.#agentDir = options.agentDir;
		this.#settings = options.settings;
		this.cwd = canonicalMCPWorkingDirectory(this.cwd);
		this.#pool = options.pool ?? new MCPConnectionPool({ sharedPoolIdleMs: options.sharedPoolIdleMs });
		this.#sessionId = options.sessionId ?? crypto.randomUUID();
	}

	isToolsOnly(): boolean {
		return this.#toolsOnly;
	}

	/**
	 * Set a callback to receive all server notifications.
	 */
	setOnNotification(handler: (serverName: string, method: string, params: unknown) => void): void {
		if (this.#toolsOnly) return;
		this.#onNotification = handler;
	}

	/**
	 * Set a callback to fire when any server's tools change.
	 */
	setOnToolsChanged(handler: (tools: CustomTool<TSchema, MCPToolDetails>[]) => void): void {
		if (this.#toolsOnly) return;
		this.#onToolsChanged = handler;
	}

	/**
	 * Set a callback to fire when any server's resources change.
	 */
	setOnResourcesChanged(handler: (serverName: string, uri: string) => void): void {
		if (this.#toolsOnly) return;
		this.#onResourcesChanged = handler;
	}

	/**
	 * Set a callback to fire when any server's prompts change.
	 */
	setOnPromptsChanged(handler: (serverName: string) => void): void {
		if (this.#toolsOnly) return;
		this.#onPromptsChanged = handler;
		// Fire immediately for servers that already have prompts loaded
		for (const [name, connection] of this.#connections) {
			if (connection.prompts?.length) {
				handler(name);
			}
		}
	}

	async #subscribeAndTrack(
		name: string,
		connection: MCPServerConnection,
		uris: string[],
		notificationEpoch: number,
	): Promise<void> {
		const lease = this.#leaseByConnection.get(connection);
		if (!lease) return;
		try {
			await lease.setResourceSubscriptions(uris);
		} catch (error) {
			logger.error("Failed to subscribe to MCP resources", { path: `mcp:${name}`, error });
			return;
		}
		const action = resolveSubscriptionPostAction(
			this.#notificationsEnabled,
			this.#notificationsEpoch,
			notificationEpoch,
		);
		if (action === "rollback") {
			try {
				await lease.setResourceSubscriptions([]);
			} catch (error) {
				logger.error("Failed to rollback stale MCP resource subscription", { path: `mcp:${name}`, error });
			}
			return;
		}
		if (action === "ignore") return;
		this.#subscribedResources.set(name, new Set(uris));
	}

	setNotificationsEnabled(enabled: boolean): void {
		if (this.#toolsOnly) return;
		const wasEnabled = this.#notificationsEnabled;
		this.#notificationsEnabled = enabled;
		if (enabled === wasEnabled) return;

		this.#notificationsEpoch += 1;
		const notificationEpoch = this.#notificationsEpoch;

		if (enabled) {
			// Subscribe to all connected servers that support it
			for (const [name, connection] of this.#connections) {
				if (connection.capabilities.resources?.subscribe && connection.resources) {
					const uris = connection.resources.map(r => r.uri);
					this.#subscribeAndTrack(name, connection, uris, notificationEpoch);
				}
			}
			return;
		}

		// Unsubscribe from all servers through their leases. Release also clears any
		// remaining aggregate subscription state, so no physical transport call bypasses the pool.
		for (const [name, connection] of this.#connections) {
			const lease = this.#leaseByConnection.get(connection);
			if (!lease) continue;
			void lease.setResourceSubscriptions([]).catch(error => {
				logger.error("Failed to unsubscribe MCP resources", { path: `mcp:${name}`, error });
			});
		}
		this.#subscribedResources.clear();
	}

	/**
	 * Set the auth storage for resolving OAuth credentials.
	 */
	setAuthStorage(authStorage: AuthStorage): void {
		this.#authStorage = authStorage;
	}

	/**
	 * Register the handler for modern MRTR `input_required` results (structured
	 * elicitation/roots/sampling input requests). Runtimes with an interactive
	 * question surface (e.g. ACP `elicitation/create`) register here; without a
	 * handler, `input_required` fails explicitly instead of hanging.
	 */
	setInputRequestHandler(handler: MCPInputRequestHandler | null): void {
		this.#inputRequestHandler = handler;
	}

	/**
	 * Discover and connect to all MCP servers from .mcp.json files.
	 * Returns tools and any connection errors.
	 */
	async discoverAndConnect(options?: MCPDiscoverOptions): Promise<MCPLoadResult> {
		this.#assertConnectionSetMutable();
		const hasConfigPath = options?.configPath !== undefined;
		if (this.#toolsOnly !== hasConfigPath) {
			throw new Error(
				this.#toolsOnly
					? "Tools-only MCP manager requires an explicit config path"
					: "Explicit MCP config requires a tools-only MCP manager",
			);
		}
		if (this.#toolsOnly && this.#toolsOnlyConfigLoaded) {
			throw new Error("Tools-only MCP manager already loaded an explicit config");
		}
		if (this.#toolsOnly) this.#toolsOnlyConfigLoaded = true;
		const { configs, exaApiKeys, sources, configurationWarning } = await loadAllMCPConfigs(this.cwd, {
			enableProjectConfig: options?.enableProjectConfig,
			filterExa: options?.filterExa,
			filterBrowser: options?.filterBrowser,
			autoloadOnly: options?.autoloadOnly,
			nativeOnly: options?.nativeOnly,
			configPath: options?.configPath,
			agentDir: options?.agentDir ?? this.#agentDir,
			settings: options?.settings ?? this.#settings,
		});
		const result = await this.#connectServers(configs, sources, options?.onConnecting);
		if (configurationWarning) result.errors.set("$config", "MCP configuration unavailable");
		result.exaApiKeys = exaApiKeys;
		return result;
	}

	/**
	 * Connect to specific MCP servers.
	 * Connections are made in parallel for faster startup.
	 */
	async connectServers(
		configs: Record<string, MCPServerConfig>,
		sources: Record<string, SourceMeta>,
		onConnecting?: (serverNames: string[]) => void,
	): Promise<MCPLoadResult> {
		this.#assertRawMCPAccessAllowed();
		this.#assertConnectionSetMutable();
		return this.#connectServers(configs, sources, onConnecting);
	}

	async #connectServers(
		configs: Record<string, MCPServerConfig>,
		sources: Record<string, SourceMeta>,
		onConnecting?: (serverNames: string[]) => void,
	): Promise<MCPLoadResult> {
		const errors = new Map<string, string>();
		const connectedServers = new Set<string>();
		const allTools: CustomTool<TSchema, MCPToolDetails>[] = [];
		const reportedErrors = new Set<string>();
		let allowBackgroundLogging = false;
		let shouldPublishToolSnapshot = true;

		// Prepare connection tasks
		const connectionTasks: ConnectionTask[] = [];

		for (const [name, config] of Object.entries(configs)) {
			if (sources[name]) {
				this.#sources.set(name, sources[name]);
				const existing = this.#connections.get(name);
				if (existing) {
					existing._source = sources[name];
				}
			}

			// Skip if already connected.
			if (this.#connections.has(name)) {
				connectedServers.add(name);
				allTools.push(
					...this.#tools.filter(
						tool => (tool instanceof MCPTool || tool instanceof DeferredMCPTool) && tool.mcpServerName === name,
					),
				);
				continue;
			}

			if (
				this.#pendingConnections.has(name) ||
				this.#pendingToolLoads.has(name) ||
				this.#pendingReconnections.has(name)
			) {
				continue;
			}

			// Validate config
			const validationErrors = validateServerConfig(name, config);
			if (validationErrors.length > 0) {
				errors.set(name, this.#serverError(validationErrors.join("; ")));
				reportedErrors.add(name);
				continue;
			}

			// Save config early so reconnection works even if the initial connect times out
			// and falls back to cached/deferred tools.
			this.#serverConfigs.set(name, config);

			const connectionEpoch = this.#epoch;
			const disconnectEpoch = this.#disconnectEpochs.get(name) ?? 0;
			const connectionAbort = new AbortController();
			this.#pendingConnectionControllers.set(name, connectionAbort);
			// Resolve auth config before connecting, but do so per-server in parallel.
			const acquireInitialLease = async (): Promise<MCPPoolLease> => {
				const resolvedConfig = await this.#resolveAuthConfig(config);
				let lease: MCPPoolLease | undefined;
				try {
					lease = await this.#acquireLease(name, resolvedConfig, config, connectionAbort);
					await this.#afterLeaseAcquiredForTests?.(name, lease);
					return lease;
				} catch (error) {
					if (lease) await this.#releaseLeasePreservingPrimary(name, lease.connection);
					throw error;
				}
			};
			let connectionPromise!: Promise<MCPServerConnection>;
			connectionPromise = (async () => {
				try {
					let lease = await acquireInitialLease();
					for (;;) {
						const connection = lease.connection;
						// Store original config (without resolved tokens) to keep
						// cache keys stable and avoid leaking rotating credentials.
						connection.config = config;
						if (sources[name]) {
							connection._source = sources[name];
						}
						const stillPending = this.#pendingConnections.get(name) === connectionPromise;
						const stillCurrent =
							this.#epoch === connectionEpoch &&
							(this.#disconnectEpochs.get(name) ?? 0) === disconnectEpoch &&
							this.#serverConfigs.get(name) === config &&
							!connectionAbort.signal.aborted;
						if (!stillPending || !stillCurrent) {
							const disconnectError = new Error(`Server "${name}" was disconnected during connection`);
							await this.#releaseLeasePreservingPrimary(name, connection);
							throw disconnectError;
						}
						if (!this.#pool.isCurrentLease(lease)) {
							const obsoleteError = new MCPPoolLeaseObsoleteError(name, lease.key, lease.generation);
							await this.#releaseLeasePreservingPrimary(name, connection);
							if (
								this.#epoch !== connectionEpoch ||
								(this.#disconnectEpochs.get(name) ?? 0) !== disconnectEpoch ||
								this.#serverConfigs.get(name) !== config ||
								connectionAbort.signal.aborted
							) {
								throw obsoleteError;
							}
							lease = await acquireInitialLease();
							continue;
						}
						this.#pendingConnections.delete(name);
						this.#pendingConnectionControllers.delete(name);
						this.#connections.set(name, connection);
						this.#registerLease(name, connection);
						this.#serverConfigs.set(name, config);

						// Wire auth refresh for HTTP transports, and reconnect for any transport.
						if (connection.transport instanceof HttpTransport && config.auth?.type === "oauth") {
							connection.transport.onAuthError = async () => {
								const refreshed = await this.#resolveAuthConfig(config, true);
								if (refreshed.type === "http" || refreshed.type === "sse") {
									return refreshed.headers ?? null;
								}
								return null;
							};
						}

						return connection;
					}
				} catch (error) {
					if (this.#pendingConnections.get(name) === connectionPromise) {
						this.#pendingConnections.delete(name);
						if (this.#pendingConnectionControllers.get(name) === connectionAbort) {
							this.#pendingConnectionControllers.delete(name);
						}
					}
					throw error;
				}
			})();
			this.#pendingConnections.set(name, connectionPromise);

			const toolsPromise = connectionPromise.then(async connection => {
				let serverTools: Awaited<ReturnType<typeof listTools>>;
				try {
					serverTools = await listTools(this.#connectionForLease(connection));
				} catch (error) {
					if (this.#connections.get(name) === connection) this.#connections.delete(name);
					await this.#releaseLeasePreservingPrimary(name, connection);
					throw error;
				}
				if (
					connectionAbort.signal.aborted ||
					!this.#isCurrentConnection(name, config, connectionEpoch, disconnectEpoch, connection)
				) {
					const disconnectError = new Error(`Server "${name}" was disconnected during tool loading`);
					await this.#releaseLeasePreservingPrimary(name, connection);
					throw disconnectError;
				}
				return { connection, serverTools };
			});
			this.#pendingToolLoads.set(name, toolsPromise);

			const tracked = trackPromise(toolsPromise);
			connectionTasks.push({
				name,
				config,
				tracked,
				connectionPromise,
				toolsPromise,
				connectionAbort,
				connectionEpoch,
				disconnectEpoch,
			});

			void toolsPromise
				.then(async ({ connection, serverTools }) => {
					if (connectionAbort.signal.aborted) return;
					if (this.#pendingToolLoads.get(name) !== toolsPromise) return;
					if (
						connectionAbort.signal.aborted ||
						!this.#isCurrentConnection(name, config, connectionEpoch, disconnectEpoch, connection)
					)
						return;
					this.#pendingToolLoads.delete(name);
					const reconnect = () => this.reconnectServer(name);
					const customTools = MCPTool.fromTools(this.#connectionForLease(connection), serverTools, reconnect, {
						noReplay: config.sharing === "shared",
						inputHandler: () => this.#inputRequestHandler ?? undefined,
					});
					this.#replaceServerTools(name, customTools);
					if (!this.#toolsOnly) this.#onToolsChanged?.(this.#tools);
					if (!this.#toolsOnly) void this.toolCache?.set(name, config, serverTools);
					if (!this.#toolsOnly) await this.#loadServerResourcesAndPrompts(name, connection);
				})
				.catch(error => {
					if (this.#pendingToolLoads.get(name) !== toolsPromise) return;
					this.#pendingToolLoads.delete(name);
					if (!allowBackgroundLogging || reportedErrors.has(name) || this.#toolsOnly) return;
					const message = error instanceof Error ? error.message : String(error);
					logger.error("MCP tool load failed", { path: `mcp:${name}`, error: message });
				});
		}

		// Notify about servers we're connecting to
		if (connectionTasks.length > 0 && onConnecting) {
			try {
				onConnecting(connectionTasks.map(task => task.name));
			} catch (error) {
				await this.#cleanupConnectionTasks(connectionTasks);
				throw error;
			}
		}

		if (connectionTasks.length > 0) {
			const configs = connectionTasks.map(task => task.config);
			// An exact config is explicit operator intent, so its declared connection
			// windows govern startup. Ordinary discovery keeps the short ceiling.
			const startupTimeoutMs =
				this.#toolsOnly && this.#maxStartupTimeoutMs === undefined
					? resolveExactConfigStartupTimeoutMs(configs)
					: resolveStartupTimeoutMs(configs, this.#maxStartupTimeoutMs);
			const firstUnexpectedFailure = Promise.withResolvers<{ reason: unknown }>();
			if (this.#toolsOnly) {
				for (const task of connectionTasks) {
					void task.toolsPromise.catch(reason => {
						if (!(reason instanceof MCPExpectedFailure)) firstUnexpectedFailure.resolve({ reason });
					});
				}
			}
			const startupStartedAt = Date.now();
			const startupOutcome = await Promise.race([
				Promise.allSettled(connectionTasks.map(task => task.tracked.promise)).then(() => undefined),
				delay(startupTimeoutMs).then(() => undefined),
				firstUnexpectedFailure.promise,
			]);
			const unexpectedTask = connectionTasks.find(
				task =>
					task.tracked.status === "rejected" &&
					this.#toolsOnly &&
					!(task.tracked.reason instanceof MCPExpectedFailure),
			);
			const unexpectedFailure =
				startupOutcome ?? (unexpectedTask ? { reason: unexpectedTask.tracked.reason } : undefined);
			if (unexpectedFailure) {
				await this.#cleanupConnectionTasks(connectionTasks);
				throw unexpectedFailure.reason;
			}

			const cachedTools = new Map<string, MCPToolDefinition[]>();
			const pendingTasks = connectionTasks.filter(task => task.tracked.status === "pending");

			if (pendingTasks.length > 0) {
				if (this.toolCache && !this.#toolsOnly) {
					await Promise.all(
						pendingTasks.map(async task => {
							const cached = await this.toolCache?.get(task.name, task.config);
							if (cached) {
								cachedTools.set(task.name, cached);
							}
						}),
					);
				}

				const pendingWithoutCache = pendingTasks.filter(task => !cachedTools.has(task.name));
				if (pendingWithoutCache.length > 0) {
					// The startup wait elapsing means "stop blocking session start", not
					// "this server failed". A server whose operator declared a `timeout`
					// (`gjc mcp add --timeout`) asked to wait that long for it, so while it
					// is still inside that window it keeps connecting in the background
					// under `connectToServer`'s own timeout, and the background tool load
					// adopts it. Only a server that declared no window, or already spent it,
					// is torn down and reported. Exact-config (`toolsOnly`) startup still
					// fails fast: it builds a catalog once, so a missing server is an error.
					const startupElapsedMs = Date.now() - startupStartedAt;
					for (const task of pendingWithoutCache) {
						if (!this.#toolsOnly && withinDeclaredConnectionWindow(task.config, startupElapsedMs)) {
							logger.warn("MCP server still connecting after the startup wait", {
								path: `mcp:${task.name}`,
								startupWaitMs: startupTimeoutMs,
								declaredTimeoutMs: task.config.timeout,
							});
							continue;
						}
						const message = `MCP server connection timed out during startup: ${task.name}`;
						errors.set(task.name, this.#serverError(message));
						reportedErrors.add(task.name);
						task.connectionAbort.abort(new Error(message));
						if (this.#pendingConnections.has(task.name)) this.#pendingConnections.delete(task.name);
						if (this.#pendingToolLoads.get(task.name) === task.toolsPromise)
							this.#pendingToolLoads.delete(task.name);
						this.#pendingConnectionControllers.delete(task.name);
						void this.#disconnectServer(task.name).catch(error => {
							this.#logLeaseReleaseFailure(task.name, undefined, error);
						});
					}
					// Abort and disconnect in the background: a misbehaving stdio/MCP transport can
					// ignore AbortSignal and keep startup blocked indefinitely, but it must not remain
					// registered if it eventually connects.
				}
			}

			for (const task of connectionTasks) {
				const { name } = task;
				if (task.tracked.status === "fulfilled") {
					const value = task.tracked.value;
					if (!value) continue;
					const { connection, serverTools } = value;
					if (this.#pendingToolLoads.has(name) && this.#pendingToolLoads.get(name) !== task.toolsPromise) continue;
					if (
						!this.#isCurrentConnection(name, task.config, task.connectionEpoch, task.disconnectEpoch, connection)
					) {
						shouldPublishToolSnapshot = false;
						continue;
					}
					connectedServers.add(name);
					const reconnect = () => this.reconnectServer(name);
					try {
						allTools.push(
							...MCPTool.fromTools(this.#connectionForLease(connection), serverTools, reconnect, {
								noReplay: task.config.sharing === "shared",
								inputHandler: () => this.#inputRequestHandler ?? undefined,
							}),
						);
					} catch (error) {
						await this.#cleanupConnectionTasks(connectionTasks);
						throw error;
					}
				} else if (task.tracked.status === "rejected") {
					const reason = task.tracked.reason;
					const message = reason instanceof Error ? reason.message : String(reason);
					errors.set(name, this.#serverError(message));
					reportedErrors.add(name);
					if (this.#toolsOnly && reason instanceof MCPExpectedFailure) {
						await this.#disconnectServer(name).catch(error => {
							this.#logLeaseReleaseFailure(name, this.#connections.get(name), error);
						});
					}
					if ((this.#disconnectEpochs.get(name) ?? 0) !== task.disconnectEpoch) {
						shouldPublishToolSnapshot = false;
					}
				} else {
					const cached = cachedTools.get(name);
					if (cached) {
						const source = this.#sources.get(name);
						const reconnect = () => this.reconnectServer(name);
						try {
							allTools.push(
								...DeferredMCPTool.fromTools(
									name,
									cached,
									() => this.#waitForConnection(name).then(connection => this.#connectionForLease(connection)),
									source,
									reconnect,
									{
										noReplay: task.config.sharing === "shared",
										inputHandler: () => this.#inputRequestHandler ?? undefined,
									},
								),
							);
						} catch (error) {
							await this.#cleanupConnectionTasks(connectionTasks);
							throw error;
						}
					}
				}
			}
		}

		// Stable sort by name so the order is independent of connection completion.
		// See `sortMCPToolsByName` for the cache-stability rationale.
		sortMCPToolsByName(allTools);
		if (this.#toolsOnly && new Set(allTools.map(tool => tool.name)).size !== allTools.length) {
			await this.#cleanupConnectionTasks(connectionTasks);
			throw new Error("MCP tool catalog contains duplicate tool names");
		}

		// Update cached tools
		if (shouldPublishToolSnapshot) this.#tools = allTools;
		allowBackgroundLogging = true;

		return {
			tools: [...allTools],
			errors,
			connectedServers: Array.from(connectedServers),
			exaApiKeys: [], // Will be populated by discoverAndConnect
		};
	}

	#replaceServerTools(name: string, tools: CustomTool<TSchema, MCPToolDetails>[]): void {
		this.#tools = this.#tools.filter(
			tool => !((tool instanceof MCPTool || tool instanceof DeferredMCPTool) && tool.mcpServerName === name),
		);
		this.#tools.push(...tools);
		// Stable sort by name so reconnect order does not perturb the array.
		// See `sortMCPToolsByName` for the cache-stability rationale.
		sortMCPToolsByName(this.#tools);
	}

	#triggerNotificationRefresh(serverName: string, kind: "tools" | "resources" | "prompts"): void {
		const refresh = (() => {
			switch (kind) {
				case "tools":
					return this.refreshServerTools(serverName);
				case "resources":
					return this.refreshServerResources(serverName);
				case "prompts":
					return this.refreshServerPrompts(serverName);
			}
		})();
		void refresh.catch(error => {
			logger.debug("Failed MCP notification refresh", { path: `mcp:${serverName}`, kind, error });
		});
	}
	#handleServerNotification(serverName: string, method: string, params: unknown): void {
		logger.debug("MCP notification received", { path: `mcp:${serverName}`, method });

		switch (method) {
			case MCPNotificationMethods.TOOLS_LIST_CHANGED:
				this.#triggerNotificationRefresh(serverName, "tools");
				break;
			case MCPNotificationMethods.RESOURCES_LIST_CHANGED:
				this.#triggerNotificationRefresh(serverName, "resources");
				break;
			case MCPNotificationMethods.RESOURCES_UPDATED: {
				const uri = (params as { uri?: string })?.uri;
				const subscribed = this.#subscribedResources.get(serverName);
				if (uri && subscribed?.has(uri)) {
					this.#onResourcesChanged?.(serverName, uri);
				}
				break;
			}
			case MCPNotificationMethods.PROMPTS_LIST_CHANGED:
				this.#triggerNotificationRefresh(serverName, "prompts");
				break;
			default:
				logger.debug("Ignoring unknown MCP notification", { path: `mcp:${serverName}`, method });
				return;
		}
		this.#onNotification?.(serverName, method, params);
	}

	/** Handle server-to-client JSON-RPC requests (e.g. ping, roots/list). */
	async #handleServerRequest(method: string, _params: unknown): Promise<unknown> {
		if (this.#toolsOnly && method !== "ping") {
			throw Object.assign(new Error(`Unsupported server request: ${method}`), { code: -32601 });
		}
		switch (method) {
			case "ping":
				return {};
			case "roots/list":
				return this.#getRoots();
			default:
				throw Object.assign(new Error(`Unsupported server request: ${method}`), { code: -32601 });
		}
	}

	#getRoots(): { roots: Array<{ uri: string; name: string }> } {
		return {
			roots: [
				{
					uri: url.pathToFileURL(this.cwd).href,
					name: path.basename(this.cwd),
				},
			],
		};
	}

	/**
	 * Get all loaded tools.
	 */
	getTools(): CustomTool<TSchema, MCPToolDetails>[] {
		return [...this.#tools];
	}

	/**
	 * Get a specific connection.
	 */
	getConnection(name: string): MCPServerConnection | undefined {
		this.#assertRawMCPAccessAllowed();
		return this.#connections.get(name);
	}

	/**
	 * Get current connection status for a server.
	 */
	getConnectionStatus(name: string): "connected" | "connecting" | "disconnected" {
		if (this.#connections.has(name)) return "connected";
		if (
			this.#pendingConnections.has(name) ||
			this.#pendingToolLoads.has(name) ||
			this.#pendingReconnections.has(name)
		)
			return "connecting";
		return "disconnected";
	}

	/**
	 * Get the authoritative protocol observation for a connected server
	 * (preference, negotiated era/version, downgrade decision, deprecation state).
	 * Secret-free; the single observation model consumed by customization doctor
	 * (#4288) and /extensions (#4291). Returns undefined when not connected.
	 */
	getProtocolObservation(name: string): MCPProtocolObservation | undefined {
		return this.#connections.get(name)?.protocol;
	}

	/**
	 * Snapshot of protocol observations for all connected servers.
	 */
	getProtocolObservations(): ReadonlyMap<string, MCPProtocolObservation> {
		const snapshot = new Map<string, MCPProtocolObservation>();
		for (const [name, connection] of this.#connections) {
			snapshot.set(name, connection.protocol);
		}
		return snapshot;
	}

	/**
	 * Get the source metadata for a server.
	 */
	getSource(name: string): SourceMeta | undefined {
		return this.#sources.get(name) ?? this.#connections.get(name)?._source;
	}

	/**
	 * Wait for a connection to complete (or fail).
	 */
	async waitForConnection(name: string): Promise<MCPServerConnection> {
		this.#assertRawMCPAccessAllowed();
		return this.#waitForConnection(name);
	}

	async #waitForConnection(name: string): Promise<MCPServerConnection> {
		const connection = this.#connections.get(name);
		if (connection) return connection;
		const pending = this.#pendingConnections.get(name);
		if (pending) return pending;
		// If a reconnection is in flight, wait for it to complete
		const reconnecting = this.#pendingReconnections.get(name);
		if (reconnecting) {
			const result = await reconnecting;
			if (result) return result;
		}
		throw new Error(`MCP server not connected: ${name}`);
	}

	/**
	 * Resolve auth and shell-command substitutions in config before connecting.
	 */
	async prepareConfig(config: MCPServerConfig): Promise<MCPServerConfig> {
		this.#assertRawMCPAccessAllowed();
		return this.#resolveAuthConfig(config);
	}

	/** Acquire a prepared, pool-owned lease for a scoped transient operation. */
	async withPreparedLease<T>(
		name: string,
		config: MCPServerConfig,
		fn: (lease: MCPPoolLease) => Promise<T> | T,
		options: { signal?: AbortSignal } = {},
	): Promise<T> {
		this.#assertRawMCPAccessAllowed();
		const lifecycleEpoch = this.#assertScopedAdmission();
		const leaseReady = Promise.withResolvers<MCPPoolLease | undefined>();
		const operation: ScopedOperation = {
			id: this.#nextScopedOperationId++,
			name,
			lifecycleEpoch,
			controller: new AbortController(),
			leaseReady: leaseReady.promise,
			resolveLeaseReady: leaseReady.resolve,
			completion: Promise.resolve(),
		};
		this.#scopedOperations.set(operation.id, operation);
		const completion = this.#runPreparedLease(operation, config, fn, options);
		operation.completion = completion;
		void completion.catch(() => {});
		try {
			return await completion;
		} finally {
			if (this.#scopedOperations.get(operation.id) === operation) this.#scopedOperations.delete(operation.id);
		}
	}

	async #runPreparedLease<T>(
		operation: ScopedOperation,
		config: MCPServerConfig,
		fn: (lease: MCPPoolLease) => Promise<T> | T,
		options: { signal?: AbortSignal },
	): Promise<T> {
		const callerSignal = options.signal;
		const onAbort = () =>
			operation.controller.abort(callerSignal?.reason ?? new Error(`MCP operation aborted: ${operation.name}`));
		if (callerSignal) {
			if (callerSignal.aborted) onAbort();
			else callerSignal.addEventListener("abort", onAbort, { once: true });
		}

		let removeAbortListener: (() => void) | undefined;
		const abortPromise = new Promise<never>((_resolve, reject) => {
			const rejectIfAborted = () => {
				if (operation.controller.signal.aborted) {
					reject(operation.controller.signal.reason ?? new Error(`MCP operation aborted: ${operation.name}`));
				}
			};
			if (operation.controller.signal.aborted) rejectIfAborted();
			else {
				operation.controller.signal.addEventListener("abort", rejectIfAborted, { once: true });
				removeAbortListener = () => operation.controller.signal.removeEventListener("abort", rejectIfAborted);
			}
		});

		let lease: MCPPoolLease | undefined;
		let result!: T;
		let failed = false;
		let primaryError: unknown;
		try {
			const resolvedConfigPromise = this.#resolveAuthConfig(config);
			void resolvedConfigPromise.catch(() => {});
			const resolvedConfig = await Promise.race([resolvedConfigPromise, abortPromise]);
			if (operation.lifecycleEpoch !== this.#scopedLifecycleEpoch || this.#scopedLifecycle !== "open") {
				throw new MCPManagerLifecycleError(this.#scopedLifecycle === "disconnecting" ? "disconnect" : "reconnect");
			}
			lease = await this.#acquireLease(operation.name, resolvedConfig, config, operation.controller, false);
			operation.lease = lease;
			operation.resolveLeaseReady(lease);

			const callbackPromise = Promise.resolve().then(() => {
				if (operation.controller.signal.aborted) {
					throw operation.controller.signal.reason ?? new Error(`MCP operation aborted: ${operation.name}`);
				}
				return fn(lease!);
			});
			void callbackPromise.catch(error => {
				logger.debug("MCP scoped operation callback failed after cancellation", {
					path: `mcp:${operation.name}`,
					error,
				});
			});
			result = await Promise.race([callbackPromise, abortPromise]);
		} catch (error) {
			failed = true;
			primaryError = error;
		} finally {
			if (!lease) operation.resolveLeaseReady(undefined);
			removeAbortListener?.();
		}

		try {
			await this.#releaseScopedLease(operation);
		} catch (cleanupError) {
			const diagnostic = this.#logLeaseReleaseFailure(operation.name, lease?.connection, cleanupError, lease?.key);
			if (!failed) throw diagnostic;
		} finally {
			callerSignal?.removeEventListener("abort", onAbort);
		}
		if (!failed && operation.controller.signal.aborted) {
			failed = true;
			primaryError = operation.controller.signal.reason ?? new Error(`MCP operation aborted: ${operation.name}`);
		}
		if (failed) throw primaryError;
		return result;
	}

	/** Read-only test seam for pending retired lease-release records. */
	get retiredLeaseReleaseCountForTests(): number {
		return this.#retiredLeaseReleases.size;
	}
	/**
	 * Get all connected server names.
	 */
	getConnectedServers(): string[] {
		return Array.from(this.#connections.keys());
	}

	/**
	 * Get all known server names (connected, connecting, or discovered).
	 */
	getAllServerNames(): string[] {
		return Array.from(
			new Set([...this.#sources.keys(), ...this.#connections.keys(), ...this.#pendingConnections.keys()]),
		);
	}

	/**
	 * Disconnect from a specific server.
	 */
	async disconnectServer(name: string): Promise<void> {
		this.#assertRawMCPAccessAllowed();
		this.#assertConnectionSetMutable();
		await this.#disconnectServer(name);
	}

	async #disconnectServer(name: string): Promise<void> {
		const nextEpoch = (this.#disconnectEpochs.get(name) ?? 0) + 1;
		this.#disconnectEpochs.set(name, nextEpoch);
		this.#pendingConnectionControllers.get(name)?.abort(new Error(`MCP server disconnected: ${name}`));
		this.#pendingConnectionControllers.delete(name);
		this.#reconnectBackoffs.get(name)?.abort(new Error(`MCP server disconnected: ${name}`));
		this.#reconnectBackoffs.delete(name);
		this.#pendingConnections.delete(name);
		this.#pendingToolLoads.delete(name);
		this.#pendingReconnections.delete(name);
		this.#sources.delete(name);
		this.#serverConfigs.delete(name);
		this.#pendingResourceRefresh.delete(name);
		const connection = this.#connections.get(name);

		this.#subscribedResources.delete(name);

		let closeError: unknown;
		if (connection) {
			try {
				await this.#releaseLease(name);
			} catch (error) {
				closeError = this.#logLeaseReleaseFailure(name, connection, error);
			}
			if (this.#connections.get(name) === connection) this.#connections.delete(name);
		}

		// Remove tools from this server and notify consumers
		const hadTools = this.#tools.some(
			tool => (tool instanceof MCPTool || tool instanceof DeferredMCPTool) && tool.mcpServerName === name,
		);
		this.#tools = this.#tools.filter(
			tool => !((tool instanceof MCPTool || tool instanceof DeferredMCPTool) && tool.mcpServerName === name),
		);
		if (hadTools) this.#onToolsChanged?.(this.#tools);

		// Notify prompt consumers so stale commands are cleared
		if (connection?.prompts?.length) this.#onPromptsChanged?.(name);
		if (closeError) throw closeError;
	}

	#abortConnectionTask(task: ConnectionTask): void {
		task.connectionAbort.abort(new Error(`MCP server startup aborted: ${task.name}`));
		if (this.#pendingConnectionControllers.get(task.name) === task.connectionAbort) {
			this.#pendingConnectionControllers.delete(task.name);
		}
		if (this.#pendingConnections.get(task.name) === task.connectionPromise) {
			this.#pendingConnections.delete(task.name);
		}
		if (this.#pendingToolLoads.get(task.name) === task.toolsPromise) {
			this.#pendingToolLoads.delete(task.name);
		}
		if ((this.#disconnectEpochs.get(task.name) ?? 0) === task.disconnectEpoch) {
			this.#disconnectEpochs.set(task.name, task.disconnectEpoch + 1);
		}
	}

	async #terminateConnectionTask(task: ConnectionTask): Promise<void> {
		const connection = await task.connectionPromise.catch(async error => {
			if (error instanceof MCPPoolAcquireAbortError && error.cleanup) {
				await error.cleanup.catch(cleanupError => {
					logger.error("MCP aborted acquire cleanup failed", { path: `mcp:${task.name}`, error: cleanupError });
				});
			}
			logger.debug("MCP connection task did not publish before cleanup", { path: `mcp:${task.name}`, error });
			return undefined;
		});
		if (!connection || this.#connections.get(task.name) !== connection) return;

		try {
			await this.#releaseLeasePreservingPrimary(task.name, connection);
		} finally {
			if (this.#connections.get(task.name) === connection) this.#connections.delete(task.name);
		}
	}

	async #cleanupConnectionTasks(tasks: ConnectionTask[]): Promise<void> {
		for (const task of tasks) this.#abortConnectionTask(task);
		const terminations = await Promise.allSettled(tasks.map(task => this.#terminateConnectionTask(task)));
		for (const result of terminations) {
			if (result.status === "rejected") logger.error("MCP startup cleanup failed", { error: result.reason });
		}
		const disconnections = await Promise.allSettled(tasks.map(task => this.#disconnectServer(task.name)));
		for (const [index, result] of disconnections.entries()) {
			if (result.status === "rejected") {
				this.#logLeaseReleaseFailure(tasks[index]?.name ?? "unknown", undefined, result.reason);
			}
		}
	}

	/**
	 * Disconnect from all servers.
	 */
	async disconnectAll(): Promise<void> {
		const lifecycleEpoch = this.#beginScopedLifecycle("disconnecting");
		this.#deferredSharedRebinds.clear();
		try {
			// Invalidate any in-flight reconnection attempts that outlive this call.
			// They captured the old epoch; after increment they'll detect staleness.
			this.#epoch++;
			const scopedReleaseFailures = await this.#shutdownScopedOperations(new Error("MCP manager disconnected"));
			const releaseResults = await Promise.allSettled(
				[...this.#leases.keys()].map(async name => {
					const lease = this.#leases.get(name);
					try {
						await this.#releaseLease(name);
					} catch (error) {
						throw this.#logLeaseReleaseFailure(name, lease?.connection, error, lease?.key);
					}
				}),
			);

			for (const controller of this.#pendingConnectionControllers.values()) {
				controller.abort(new Error("MCP manager disconnected"));
			}
			this.#pendingConnectionControllers.clear();
			this.#pendingConnections.clear();
			this.#pendingToolLoads.clear();
			for (const controller of this.#reconnectBackoffs.values()) {
				controller.abort(new Error("MCP manager disconnected"));
			}
			this.#reconnectBackoffs.clear();
			this.#pendingReconnections.clear();
			const retiredReleaseFailures = await this.#drainRetiredLeaseReleases();
			this.#deferredSharedRebinds.clear();
			this.#pendingResourceRefresh.clear();
			this.#sources.clear();
			this.#serverConfigs.clear();
			this.#connections.clear();
			this.#tools = [];
			this.#subscribedResources.clear();
			const releaseFailures = [
				...scopedReleaseFailures,
				...releaseResults
					.filter((result): result is PromiseRejectedResult => result.status === "rejected")
					.map(result => result.reason),
				...retiredReleaseFailures,
			];
			if (releaseFailures.length > 0) {
				throw new AggregateError(
					releaseFailures,
					`MCP manager disconnectAll failed for ${releaseFailures.length} lease${releaseFailures.length === 1 ? "" : "s"}`,
				);
			}
		} finally {
			this.#finishScopedLifecycle(lifecycleEpoch);
		}
	}

	/** Release this manager's session leases and all associated MCP state. */
	async releaseLeases(): Promise<void> {
		await this.disconnectAll();
	}

	/**
	 * Reconnect to a server after a connection failure.
	 * Tears down the stale connection, re-resolves auth, establishes a new
	 * connection, reloads tools, and notifies consumers.
	 * Concurrent calls for the same server share one reconnection attempt.
	 * Returns the new connection, or null if reconnection failed.
	 */
	async reconnectServer(name: string): Promise<MCPServerConnection | null> {
		if (this.#connectionSetSealed) return null;
		if (this.#scopedLifecycle === "disconnecting") return null;
		const pending = this.#pendingReconnections.get(name);
		if (pending) return pending;

		const lease = this.#leases.get(name);
		const sharedKey = lease?.sharingMode === "shared" ? lease.key : undefined;
		let attempt: Promise<MCPServerConnection | null>;
		if (sharedKey && !this.#pool.claimRestart(sharedKey)) {
			attempt = this.#pool.awaitRestart(sharedKey).then(async success => {
				if (success) await this.#rebindAfterSharedRestart(name, lease!);
				return this.#connections.get(name) ?? null;
			});
		} else {
			attempt = this.#doReconnect(name);
			if (sharedKey) {
				attempt = attempt
					.then(
						result => {
							this.#pool.broadcastReplacement(sharedKey, result !== null);
							this.#pool.finishRestart(
								sharedKey,
								result === null ? new Error(`MCP restart failed: ${name}`) : undefined,
							);
							return result;
						},
						error => {
							this.#pool.broadcastReplacement(sharedKey, false);
							this.#pool.finishRestart(sharedKey, error);
							throw error;
						},
					)
					.finally(() => this.#pool.releaseRestart(sharedKey));
			}
		}
		this.#pendingReconnections.set(name, attempt);
		return attempt.finally(() => {
			if (this.#pendingReconnections.get(name) === attempt) this.#pendingReconnections.delete(name);
		});
	}

	async #doReconnect(name: string): Promise<MCPServerConnection | null> {
		const oldConnection = this.#connections.get(name);
		const config = oldConnection?.config ?? this.#serverConfigs.get(name);
		const source = this.#sources.get(name) ?? oldConnection?._source;
		if (!config) return null;
		const lifecycleEpoch = this.#beginScopedLifecycle("reconnecting");
		try {
			return await this.#performReconnect(name, oldConnection, config, source);
		} finally {
			this.#finishScopedLifecycle(lifecycleEpoch);
		}
	}

	async #performReconnect(
		name: string,
		oldConnection: MCPServerConnection | undefined,
		config: MCPServerConfig,
		source: SourceMeta | undefined,
	): Promise<MCPServerConnection | null> {
		logger.debug("MCP reconnecting", { path: `mcp:${name}` });

		// Close the old transport without removing tools or notifying consumers.
		// Tools stay available (stale) while we establish the new connection.
		const reconnectEpoch = this.#disconnectEpochs.get(name) ?? 0;
		await this.#retireScopedOperations(name, new Error(`MCP server reconnecting: ${name}`));
		const oldLease = this.#leases.get(name);
		if (oldLease) this.#pool.retireLease(oldLease);
		if (oldConnection) {
			const releasePromise = this.#releaseLease(name, oldConnection, false).catch(error => {
				throw this.#logLeaseReleaseFailure(name, oldConnection, error);
			});
			if (oldConnection.transport.closeBeforeReconnect !== false) {
				try {
					await releasePromise;
				} finally {
					this.#connections.delete(name);
				}
			} else {
				// Fire-and-forget HTTP/SSE close so a slow DELETE does not delay retries.
				this.#trackRetiredLeaseRelease(name, oldConnection, releasePromise);
				void releasePromise.catch(error => {
					logger.error("MCP reconnect transport cleanup failed", { path: `mcp:${name}`, error });
				});
				this.#connections.delete(name);
			}
		}
		this.#pendingConnections.delete(name);
		const backoffAbort = new AbortController();
		this.#reconnectBackoffs.set(name, backoffAbort);
		this.#pendingToolLoads.delete(name);

		try {
			// Retry with backoff — the server may still be starting up.
			const delays = [500, 1000, 2000, 4000];
			for (let attempt = 0; attempt <= delays.length; attempt++) {
				if ((this.#disconnectEpochs.get(name) ?? 0) !== reconnectEpoch || backoffAbort.signal.aborted) {
					logger.debug("MCP reconnect aborted before attempt after server disconnected", {
						path: `mcp:${name}`,
						storedEpoch: reconnectEpoch,
						currentEpoch: this.#disconnectEpochs.get(name) ?? 0,
					});
					return null;
				}
				try {
					const connection = await this.#connectAndWireServer(name, config, source, this.#epoch, reconnectEpoch);
					logger.debug("MCP reconnected", { path: `mcp:${name}`, tools: connection.tools?.length ?? 0 });
					return connection;
				} catch (error) {
					if ((this.#disconnectEpochs.get(name) ?? 0) !== reconnectEpoch || backoffAbort.signal.aborted) {
						logger.debug("MCP reconnect aborted after server disconnected", {
							path: `mcp:${name}`,
							storedEpoch: reconnectEpoch,
							currentEpoch: this.#disconnectEpochs.get(name) ?? 0,
						});
						return null;
					}

					const msg = error instanceof Error ? error.message : String(error);
					if (attempt < delays.length) {
						logger.debug("MCP reconnect attempt failed, retrying", {
							path: `mcp:${name}`,
							attempt: attempt + 1,
							error: msg,
						});
						await this.#sleep(delays[attempt]!, backoffAbort.signal).catch(error => {
							if (!backoffAbort.signal.aborted)
								logger.error("MCP reconnect backoff failed", { path: `mcp:${name}`, error });
						});
					} else {
						logger.error("MCP reconnect failed after retries", { path: `mcp:${name}`, error: msg });
						// Don't remove stale tools — keep them in the registry so they
						// remain selected. Calls will fail with MCP errors, which
						// triggers the tool-level reconnect, or the user can run
						// /mcp reconnect <name> manually.
					}
				}
			}
		} finally {
			if (this.#reconnectBackoffs.get(name) === backoffAbort) {
				this.#reconnectBackoffs.delete(name);
			}
		}
		return null;
	}

	/** Establish a new connection to a server, wire handlers, load tools. */
	async #connectAndWireServer(
		name: string,
		config: MCPServerConfig,
		source: SourceMeta | undefined,
		globalEpoch: number,
		disconnectEpoch: number,
		lifecycleEpoch?: number,
	): Promise<MCPServerConnection> {
		const assertLifecycle = (): void => {
			if (
				lifecycleEpoch === undefined ||
				(this.#scopedLifecycle === "open" && this.#scopedLifecycleEpoch === lifecycleEpoch)
			)
				return;
			throw new MCPManagerLifecycleError(this.#scopedLifecycle === "disconnecting" ? "disconnect" : "reconnect");
		};
		assertLifecycle();
		const resolvedConfig = await this.#resolveAuthConfig(config);
		assertLifecycle();
		const connectionAbort = new AbortController();
		this.#pendingConnectionControllers.set(name, connectionAbort);
		let connection: MCPServerConnection;
		let acquiredLease: MCPPoolLease | undefined;
		try {
			acquiredLease = await this.#acquireLease(name, resolvedConfig, config, connectionAbort);
			await this.#afterLeaseAcquiredForTests?.(name, acquiredLease);
			connection = acquiredLease.connection;
		} catch (error) {
			if (acquiredLease) await this.#releaseLeasePreservingPrimary(name, acquiredLease.connection);
			throw error;
		} finally {
			if (this.#pendingConnectionControllers.get(name) === connectionAbort) {
				this.#pendingConnectionControllers.delete(name);
			}
		}
		const lease = acquiredLease;
		if (!lease) throw new Error(`MCP lease acquisition returned no lease for ${name}`);

		connection.config = config;
		if (source) connection._source = source;

		// Bail out if the server was disconnected or the manager was reset
		// while we were connecting (e.g. /mcp reload called disconnectAll).
		if (
			!this.#serverConfigs.has(name) ||
			this.#epoch !== globalEpoch ||
			(this.#disconnectEpochs.get(name) ?? 0) !== disconnectEpoch ||
			(lifecycleEpoch !== undefined &&
				(this.#scopedLifecycle !== "open" || this.#scopedLifecycleEpoch !== lifecycleEpoch))
		) {
			const disconnectError = new Error(`Server "${name}" was disconnected during reconnection`);
			await this.#releaseLeasePreservingPrimary(name, connection);
			throw disconnectError;
		}
		if (!this.#pool.isCurrentLease(lease)) {
			const obsoleteError = new MCPPoolLeaseObsoleteError(name, lease.key, lease.generation);
			await this.#releaseLeasePreservingPrimary(name, connection);
			throw obsoleteError;
		}

		this.#connections.set(name, connection);
		this.#registerLease(name, connection);

		// Wire auth refresh for HTTP transports, and reconnect for any transport.
		if (connection.transport instanceof HttpTransport && config.auth?.type === "oauth") {
			connection.transport.onAuthError = async () => {
				const refreshed = await this.#resolveAuthConfig(config, true);
				if (refreshed.type === "http" || refreshed.type === "sse") {
					return refreshed.headers ?? null;
				}
				return null;
			};
		}
		try {
			const serverTools = await listTools(this.#connectionForLease(connection));
			if (!this.#isCurrentConnection(name, config, globalEpoch, disconnectEpoch, connection)) {
				const disconnectError = new Error(`Server "${name}" was disconnected during tool loading`);
				await this.#releaseLeasePreservingPrimary(name, connection);
				throw disconnectError;
			}
			const reconnect = () => this.reconnectServer(name);
			const customTools = MCPTool.fromTools(this.#connectionForLease(connection), serverTools, reconnect, {
				noReplay: config.sharing === "shared",
				inputHandler: () => this.#inputRequestHandler ?? undefined,
			});
			void this.toolCache?.set(name, config, serverTools);
			this.#replaceServerTools(name, customTools);
			this.#onToolsChanged?.(this.#tools);
			void this.#loadServerResourcesAndPrompts(name, connection);
			return connection;
		} catch (error) {
			// Clean up the connection to avoid zombie transports
			await this.#releaseLeasePreservingPrimary(name, connection);
			if (this.#connections.get(name) === connection) this.#connections.delete(name);
			throw error;
		}
	}

	/**
	 * Best-effort loading of resources, resource subscriptions, and prompts.
	 * Shared between initial connection and reconnection.
	 */
	async #loadServerResourcesAndPrompts(name: string, connection: MCPServerConnection): Promise<void> {
		if (this.#toolsOnly) return;
		if (serverSupportsResources(connection.capabilities)) {
			try {
				const facade = this.#connectionForLease(connection);
				const [resources] = await Promise.all([listResources(facade), listResourceTemplates(facade)]);

				if (this.#notificationsEnabled && connection.capabilities.resources?.subscribe) {
					const uris = resources.map(r => r.uri);
					const notificationEpoch = this.#notificationsEpoch;
					this.#subscribeAndTrack(name, connection, uris, notificationEpoch);
				}
			} catch (error) {
				logger.debug("Failed to load MCP resources", { path: `mcp:${name}`, error });
			}
		}

		if (serverSupportsPrompts(connection.capabilities)) {
			try {
				await listPrompts(this.#connectionForLease(connection));
				this.#onPromptsChanged?.(name);
			} catch (error) {
				logger.debug("Failed to load MCP prompts", { path: `mcp:${name}`, error });
			}
		}
	}

	/**
	 * Refresh tools from a specific server.
	 */
	async refreshServerTools(name: string): Promise<void> {
		if (this.#toolsOnly) return;
		const connection = this.#connections.get(name);
		if (!connection) return;
		const globalEpoch = this.#epoch;
		const disconnectEpoch = this.#disconnectEpochs.get(name) ?? 0;

		// Clear cached tools and any server-supplied freshness hints
		connection.tools = undefined;
		connection.toolsFreshUntil = undefined;
		connection.toolsCacheScope = undefined;

		// Reload tools
		const facade = this.#connectionForLease(connection);
		const serverTools = await listTools(facade);
		if (!this.#isCurrentConnection(name, connection.config, globalEpoch, disconnectEpoch, connection)) return;
		const reconnect = () => this.reconnectServer(name);
		const customTools = MCPTool.fromTools(facade, serverTools, reconnect, {
			noReplay: connection.config.sharing === "shared",
			inputHandler: () => this.#inputRequestHandler ?? undefined,
		});
		void this.toolCache?.set(name, connection.config, serverTools);

		// Replace tools from this server
		this.#replaceServerTools(name, customTools);
		this.#onToolsChanged?.(this.#tools);
	}

	/**
	 * Refresh tools from all servers.
	 */
	async refreshAllTools(): Promise<void> {
		if (this.#toolsOnly) return;
		const promises = Array.from(this.#connections.keys()).map(name => this.refreshServerTools(name));
		await Promise.allSettled(promises);
	}

	/**
	 * Refresh resources from a specific server.
	 */
	async refreshServerResources(name: string): Promise<void> {
		if (this.#toolsOnly) return;
		const connection = this.#connections.get(name);
		if (!connection || !serverSupportsResources(connection.capabilities)) return;

		const existing = this.#pendingResourceRefresh.get(name);
		if (existing && existing.connection === connection) return existing.promise;

		const doRefresh = async (): Promise<void> => {
			// Clear cached resources
			connection.resources = undefined;
			connection.resourceTemplates = undefined;

			// Reload
			const facade = this.#connectionForLease(connection);
			const [resources] = await Promise.all([listResources(facade), listResourceTemplates(facade)]);
			if (this.#notificationsEnabled && connection.capabilities.resources?.subscribe) {
				const lease = this.#leaseByConnection.get(connection);
				if (!lease) return;
				const newUris = new Set(resources.map(r => r.uri));
				const notificationEpoch = this.#notificationsEpoch;
				try {
					await lease.setResourceSubscriptions([...newUris]);
				} catch (error) {
					logger.error("Failed to re-subscribe to MCP resources", { path: `mcp:${name}`, error });
					return;
				}
				const action = resolveSubscriptionPostAction(
					this.#notificationsEnabled,
					this.#notificationsEpoch,
					notificationEpoch,
				);
				if (action === "rollback") {
					try {
						await lease.setResourceSubscriptions([]);
					} catch (error) {
						logger.error("Failed to rollback stale MCP resource subscription", { path: `mcp:${name}`, error });
					}
					return;
				}
				if (action === "ignore") return;
				this.#subscribedResources.set(name, newUris);
			}
		};

		const promise = doRefresh().finally(() => {
			const pending = this.#pendingResourceRefresh.get(name);
			if (pending?.promise === promise) {
				this.#pendingResourceRefresh.delete(name);
			}
		});
		this.#pendingResourceRefresh.set(name, { connection, promise });
		return promise;
	}

	/**
	 * Refresh prompts from a specific server.
	 */
	async refreshServerPrompts(name: string): Promise<void> {
		if (this.#toolsOnly) return;
		const connection = this.#connections.get(name);
		if (!connection || !serverSupportsPrompts(connection.capabilities)) return;

		connection.prompts = undefined;
		await listPrompts(this.#connectionForLease(connection));

		this.#onPromptsChanged?.(name);
	}

	/**
	 * Get resources and templates for a specific server.
	 */
	getServerResources(name: string): { resources: MCPResource[]; templates: MCPResourceTemplate[] } | undefined {
		if (this.#toolsOnly) return undefined;
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return {
			resources: connection.resources ?? [],
			templates: connection.resourceTemplates ?? [],
		};
	}

	/**
	 * Read a specific resource from a server.
	 */
	async readServerResource(
		name: string,
		uri: string,
		options?: MCPRequestOptions,
	): Promise<MCPResourceReadResult | undefined> {
		if (this.#toolsOnly) return undefined;
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return readResource(this.#connectionForLease(connection), uri, options);
	}

	/**
	 * Get prompts for a specific server.
	 */
	getServerPrompts(name: string): MCPPrompt[] | undefined {
		if (this.#toolsOnly) return undefined;
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return connection.prompts ?? [];
	}

	/**
	 * Get a specific prompt from a server.
	 */
	async executePrompt(
		name: string,
		promptName: string,
		args?: Record<string, string>,
		options?: MCPRequestOptions,
	): Promise<MCPGetPromptResult | undefined> {
		if (this.#toolsOnly) return undefined;
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return getPrompt(this.#connectionForLease(connection), promptName, args, options);
	}

	/**
	 * Get connected-server instructions for request-scoped untrusted user-role context.
	 */
	getServerInstructions(): Map<string, string> {
		if (this.#toolsOnly) return new Map();
		const instructions = new Map<string, string>();
		for (const [name, connection] of this.#connections) {
			if (connection.instructions) {
				instructions.set(name, connection.instructions);
			}
		}
		return instructions;
	}

	/**
	 * Get notification state for display.
	 */
	getNotificationState(): { enabled: boolean; subscriptions: Map<string, ReadonlySet<string>> } {
		return {
			enabled: this.#notificationsEnabled,
			subscriptions: this.#subscribedResources as Map<string, ReadonlySet<string>>,
		};
	}

	/**
	 * Resolve OAuth credentials and shell commands in config.
	 */
	async #resolveAuthConfig(config: MCPServerConfig, forceRefresh = false): Promise<MCPServerConfig> {
		let resolved: MCPServerConfig = { ...config };

		const auth = config.auth;
		if (auth?.type === "oauth") {
			if (!auth.credentialId || !this.#authStorage || (config.type !== "http" && config.type !== "sse")) {
				throw new MCPExpectedFailure();
			}
			const credentialId = auth.credentialId;
			let credential = this.#authStorage.get(credentialId);
			const binding = credential?.type === "oauth" ? credential.mcpBinding : undefined;
			const endpointOrigin = resolveMCPOAuthResourceOrigin(config.url);
			if (
				credential?.type !== "oauth" ||
				!binding ||
				!isCanonicalMCPOAuthBinding(binding) ||
				binding.resourceOrigin !== endpointOrigin ||
				(auth.tokenUrl !== undefined && auth.tokenUrl !== binding.tokenEndpoint)
			) {
				throw new MCPExpectedFailure();
			}

			// Proactive refresh: 5-minute buffer before expiry
			// Force refresh: on 401/403 auth errors (revoked tokens, clock skew, missing expires)
			const REFRESH_BUFFER_MS = 5 * 60_000;
			const shouldRefresh =
				forceRefresh || (credential.expires && Date.now() >= credential.expires - REFRESH_BUFFER_MS);
			if (shouldRefresh && credential.refresh) {
				let refreshedCredential: OAuthCredential | undefined;
				try {
					refreshedCredential = await this.#authStorage.forceRefreshOAuthCredential(credentialId, credential, {
						clientId: auth.clientId,
						clientSecret: auth.clientSecret,
					});
				} catch {
					if (forceRefresh) throw new MCPExpectedFailure();
					if (this.#toolsOnly) {
						logger.debug("MCP OAuth refresh failed");
					} else {
						logger.warn("MCP OAuth refresh failed, using existing token");
					}
				}
				if (refreshedCredential) {
					const refreshedBinding = refreshedCredential.mcpBinding;
					if (
						!refreshedBinding ||
						refreshedBinding.resourceOrigin !== binding.resourceOrigin ||
						refreshedBinding.tokenEndpoint !== binding.tokenEndpoint
					) {
						throw new MCPExpectedFailure();
					}
					credential = refreshedCredential;
				}
			}
			resolved = {
				...config,
				headers: {
					...config.headers,
					Authorization: `Bearer ${credential.access}`,
				},
			};
		}
		if (this.#toolsOnly && resolved.type === "stdio") {
			resolved = { ...resolved, noInheritEnv: true };
		}

		const resolveValue = async (value: string): Promise<string | undefined> => {
			try {
				const resolvedValue = await configValue.resolveConfigValue(value);
				if (this.#toolsOnly && !resolvedValue) throw new MCPExpectedFailure();
				return resolvedValue;
			} catch (error) {
				if (this.#toolsOnly && isExpectedConfigResolutionFailure(error)) {
					throw new MCPExpectedFailure(error);
				}
				throw error;
			}
		};

		if (resolved.type !== "http" && resolved.type !== "sse") {
			if (resolved.env) {
				const nextEnv: Record<string, string> = {};
				for (const [key, value] of Object.entries(resolved.env)) {
					const resolvedValue = await resolveValue(value);
					if (resolvedValue) nextEnv[key] = resolvedValue;
				}
				resolved = { ...resolved, env: nextEnv };
			}
		} else {
			if (resolved.headers) {
				const nextHeaders: Record<string, string> = {};
				for (const [key, value] of Object.entries(resolved.headers)) {
					const resolvedValue = await resolveValue(value);
					if (resolvedValue) nextHeaders[key] = resolvedValue;
				}
				resolved = { ...resolved, headers: nextHeaders };
			}
		}

		if (resolved.type === "stdio") {
			resolved = { ...resolved, cwd: canonicalMCPWorkingDirectory(resolved.cwd ?? this.cwd) };
		}
		return resolved;
	}
}

/**
 * Create an MCP manager and discover servers.
 * Convenience function for quick setup.
 */
export async function createMCPManager(
	cwd: string,
	options?: MCPDiscoverOptions,
): Promise<{
	manager: MCPManager;
	result: MCPLoadResult;
}> {
	const manager =
		options?.configPath !== undefined
			? new MCPManager(cwd, null, {
					toolsOnly: true,
					sharedPoolIdleMs: options?.sharedPoolIdleMs,
					agentDir: options?.agentDir,
					settings: options?.settings,
				})
			: new MCPManager(cwd, null, {
					sharedPoolIdleMs: options?.sharedPoolIdleMs,
					agentDir: options?.agentDir,
					settings: options?.settings,
				});
	const result = await manager.discoverAndConnect(options);
	return { manager, result };
}
