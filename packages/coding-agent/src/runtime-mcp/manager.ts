/**
 * MCP Server Manager.
 *
 * Discovers, connects to, and manages MCP servers.
 * Handles tool loading and lifecycle.
 */
import * as path from "node:path";
import * as url from "node:url";
import type { TSchema } from "@gajae-code/ai";
import { logger } from "@gajae-code/utils";
import type { SourceMeta } from "../capability/types";
import * as configValue from "../config/resolve-config-value";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { AuthStorage } from "../session/auth-storage";
import {
	connectToServer,
	disconnectServer,
	getPrompt,
	listPrompts,
	listResources,
	listResourceTemplates,
	listTools,
	readResource,
	serverSupportsPrompts,
	serverSupportsResources,
	subscribeToResources,
	unsubscribeFromResources,
} from "./client";
import { loadAllMCPConfigs, validateServerConfig } from "./config";
import { refreshMCPOAuthToken } from "./oauth-flow";
import type { MCPToolDetails } from "./tool-bridge";
import { DeferredMCPTool, MCPTool } from "./tool-bridge";
import type { MCPToolCache } from "./tool-cache";
import { HttpTransport } from "./transports/http";
import type {
	MCPGetPromptResult,
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

const STARTUP_TIMEOUT_MS = 250;
const STARTUP_TIMEOUT_GRACE_MS = 500;
const MAX_STARTUP_TIMEOUT_MS = 1_750;

function resolveStartupTimeoutMs(configs: MCPServerConfig[]): number {
	const configuredTimeouts = configs
		.map(config => config.timeout)
		.filter((timeout): timeout is number => typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0);
	if (configuredTimeouts.length === 0) return STARTUP_TIMEOUT_MS;
	return Math.min(
		MAX_STARTUP_TIMEOUT_MS,
		Math.max(STARTUP_TIMEOUT_MS, Math.max(...configuredTimeouts) + STARTUP_TIMEOUT_GRACE_MS),
	);
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
	/** Called when starting to connect to servers */
	onConnecting?: (serverNames: string[]) => void;
	/** Load only this explicit MCP config file. */
	configPath?: string;
}

export interface MCPManagerOptions {
	/** Restrict this instance to tools from an explicit MCP config. */
	toolsOnly?: boolean;
}

/**
 * MCP Server Manager.
 *
 * Manages connections to MCP servers and provides tools to the agent.
 */
export class MCPManager {
	static #instance: MCPManager | undefined;

	/** Process-global instance shared by internal URL protocol handlers and tools. */
	static instance(): MCPManager | undefined {
		return MCPManager.#instance;
	}

	/** Install or clear the process-global instance. */
	static setInstance(value: MCPManager | undefined): void {
		MCPManager.#instance = value;
	}

	/** Reset the process-global instance. Test-only. */
	static resetForTests(): void {
		MCPManager.#instance = undefined;
	}

	#connections = new Map<string, MCPServerConnection>();
	#tools: CustomTool<TSchema, MCPToolDetails>[] = [];
	#pendingConnections = new Map<string, Promise<MCPServerConnection>>();
	#pendingConnectionControllers = new Map<string, AbortController>();
	#pendingToolLoads = new Map<string, Promise<ToolLoadResult>>();
	#sources = new Map<string, SourceMeta>();
	#authStorage: AuthStorage | null = null;
	#onNotification?: (serverName: string, method: string, params: unknown) => void;
	#onToolsChanged?: (tools: CustomTool<TSchema, MCPToolDetails>[]) => void;
	#onResourcesChanged?: (serverName: string, uri: string) => void;
	#onPromptsChanged?: (serverName: string) => void;
	#notificationsEnabled = false;
	#notificationsEpoch = 0;
	#subscribedResources = new Map<string, Set<string>>();
	#pendingResourceRefresh = new Map<string, { connection: MCPServerConnection; promise: Promise<void> }>();
	#pendingReconnections = new Map<string, Promise<MCPServerConnection | null>>();
	#disconnectEpochs = new Map<string, number>();
	#reconnectBackoffs = new Map<string, AbortController>();
	/** Preserved configs for reconnection after connection loss. */
	#serverConfigs = new Map<string, MCPServerConfig>();
	/** Monotonic epoch incremented on disconnectAll to invalidate stale reconnections. */
	#epoch = 0;
	readonly #toolsOnly: boolean;
	#toolsOnlyConfigLoaded = false;
	#connectionSetSealed = false;

	#serverError(message: string): string {
		return this.#toolsOnly ? "MCP server unavailable" : message;
	}
	#assertRawMCPAccessAllowed(): void {
		if (this.#toolsOnly) throw new Error("Tools-only MCP manager does not allow raw MCP access");
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

	constructor(
		private cwd: string,
		private toolCache: MCPToolCache | null = null,
		options: MCPManagerOptions = {},
	) {
		this.#toolsOnly = options.toolsOnly === true;
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

	#subscribeAndTrack(name: string, connection: MCPServerConnection, uris: string[], notificationEpoch: number): void {
		void subscribeToResources(connection, uris)
			.then(() => {
				const action = resolveSubscriptionPostAction(
					this.#notificationsEnabled,
					this.#notificationsEpoch,
					notificationEpoch,
				);
				if (action === "rollback") {
					void unsubscribeFromResources(connection, uris).catch(error => {
						logger.debug("Failed to rollback stale MCP resource subscription", {
							path: `mcp:${name}`,
							error,
						});
					});
					return;
				}
				if (action === "ignore") {
					return;
				}
				this.#subscribedResources.set(name, new Set(uris));
			})
			.catch(error => {
				logger.debug("Failed to subscribe to MCP resources", { path: `mcp:${name}`, error });
			});
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

		// Unsubscribe from all servers
		for (const [name, connection] of this.#connections) {
			const uris = this.#subscribedResources.get(name);
			if (uris && uris.size > 0) {
				void unsubscribeFromResources(connection, Array.from(uris)).catch(error => {
					logger.debug("Failed to unsubscribe MCP resources", { path: `mcp:${name}`, error });
				});
			}
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
			configPath: options?.configPath,
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
			const connectionPromise = (async () => {
				const resolvedConfig = await this.#resolveAuthConfig(config);
				return connectToServer(name, resolvedConfig, {
					advertiseRoots: !this.#toolsOnly,
					signal: connectionAbort.signal,
					onNotification: this.#toolsOnly
						? undefined
						: (method, params) => {
								this.#handleServerNotification(name, method, params);
							},
					onRequest: (method, params) => {
						return this.#handleServerRequest(method, params);
					},
				});
			})().then(
				async connection => {
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
					if (stillPending) {
						this.#pendingConnections.delete(name);
						this.#pendingConnectionControllers.delete(name);
					}
					if (!stillPending || !stillCurrent) {
						connection.transport.onClose = undefined;
						await connection.transport.close().catch(() => {});
						throw new Error(`Server "${name}" was disconnected during connection`);
					}
					this.#connections.set(name, connection);
					this.#serverConfigs.set(name, config);

					// Wire auth refresh for HTTP transports so 401s trigger token refresh.
					if (connection.transport instanceof HttpTransport && config.auth?.type === "oauth") {
						connection.transport.onAuthError = async () => {
							const refreshed = await this.#resolveAuthConfig(config, true);
							if (refreshed.type === "http" || refreshed.type === "sse") {
								return refreshed.headers ?? null;
							}
							return null;
						};
					}

					if (!this.#toolsOnly) {
						// Re-establish connection if the transport closes (server restart,
						// network interruption).
						connection.transport.onClose = () => {
							logger.debug("MCP transport lost, triggering reconnect", { path: `mcp:${name}` });
							void this.reconnectServer(name);
						};
					}

					return connection;
				},
				error => {
					if (this.#pendingConnections.get(name) === connectionPromise) {
						this.#pendingConnections.delete(name);
						this.#pendingConnectionControllers.delete(name);
					}
					throw error;
				},
			);
			this.#pendingConnections.set(name, connectionPromise);

			const toolsPromise = connectionPromise.then(async connection => {
				let serverTools: Awaited<ReturnType<typeof listTools>>;
				try {
					serverTools = await listTools(connection);
				} catch (error) {
					connection.transport.onClose = undefined;
					if (this.#connections.get(name) === connection) this.#connections.delete(name);
					await connection.transport.close().catch(() => {});
					throw error;
				}
				if (
					connectionAbort.signal.aborted ||
					!this.#isCurrentConnection(name, config, connectionEpoch, disconnectEpoch, connection)
				) {
					connection.transport.onClose = undefined;
					await connection.transport.close().catch(() => {});
					throw new Error(`Server "${name}" was disconnected during tool loading`);
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
					const reconnect = this.#toolsOnly ? undefined : () => this.reconnectServer(name);
					const customTools = MCPTool.fromTools(connection, serverTools, reconnect);
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
			const startupTimeoutMs = resolveStartupTimeoutMs(connectionTasks.map(task => task.config));
			const firstUnexpectedFailure = Promise.withResolvers<{ reason: unknown }>();
			if (this.#toolsOnly) {
				for (const task of connectionTasks) {
					void task.toolsPromise.catch(reason => {
						if (!(reason instanceof MCPExpectedFailure)) firstUnexpectedFailure.resolve({ reason });
					});
				}
			}
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
					for (const task of pendingWithoutCache) {
						const message = `MCP server connection timed out during startup: ${task.name}`;
						errors.set(task.name, this.#serverError(message));
						reportedErrors.add(task.name);
						task.connectionAbort.abort(new Error(message));
						if (this.#pendingConnections.has(task.name)) this.#pendingConnections.delete(task.name);
						if (this.#pendingToolLoads.get(task.name) === task.toolsPromise)
							this.#pendingToolLoads.delete(task.name);
						this.#pendingConnectionControllers.delete(task.name);
						void this.#disconnectServer(task.name).catch(() => {});
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
					const reconnect = this.#toolsOnly ? undefined : () => this.reconnectServer(name);
					try {
						allTools.push(...MCPTool.fromTools(connection, serverTools, reconnect));
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
						await this.#disconnectServer(name);
					}
					if ((this.#disconnectEpochs.get(name) ?? 0) !== task.disconnectEpoch) {
						shouldPublishToolSnapshot = false;
					}
				} else {
					const cached = cachedTools.get(name);
					if (cached) {
						const source = this.#sources.get(name);
						const reconnect = this.#toolsOnly ? undefined : () => this.reconnectServer(name);
						try {
							allTools.push(
								...DeferredMCPTool.fromTools(
									name,
									cached,
									() => this.#waitForConnection(name),
									source,
									reconnect,
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
				break;
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

		const subscribedUris = this.#subscribedResources.get(name);
		if (subscribedUris && subscribedUris.size > 0 && connection) {
			void unsubscribeFromResources(connection, Array.from(subscribedUris)).catch(() => {});
		}
		this.#subscribedResources.delete(name);

		let closeError: unknown;
		if (connection) {
			// Detach onClose to prevent spurious reconnect from close()
			connection.transport.onClose = undefined;
			try {
				await disconnectServer(connection);
			} catch (error) {
				closeError = error;
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
		const connection = await task.connectionPromise.catch(() => undefined);
		if (!connection || this.#connections.get(task.name) !== connection) return;

		connection.transport.onClose = undefined;
		try {
			await disconnectServer(connection);
		} catch {
			// Preserve the primary startup failure over best-effort transport cleanup failures.
		} finally {
			if (this.#connections.get(task.name) === connection) this.#connections.delete(task.name);
		}
	}

	async #cleanupConnectionTasks(tasks: ConnectionTask[]): Promise<void> {
		for (const task of tasks) this.#abortConnectionTask(task);
		await Promise.allSettled(tasks.map(task => this.#terminateConnectionTask(task)));
		await Promise.allSettled(tasks.map(task => this.#disconnectServer(task.name)));
	}

	/**
	 * Disconnect from all servers.
	 */
	async disconnectAll(): Promise<void> {
		// Invalidate any in-flight reconnection attempts that outlive this call.
		// They captured the old epoch; after increment they'll detect staleness.
		this.#epoch++;
		// Detach onClose before closing to prevent spurious reconnect attempts
		for (const conn of this.#connections.values()) {
			conn.transport.onClose = undefined;
		}
		const promises = Array.from(this.#connections.values()).map(conn => disconnectServer(conn));
		await Promise.allSettled(promises);

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
		this.#pendingResourceRefresh.clear();
		this.#sources.clear();
		this.#serverConfigs.clear();
		this.#connections.clear();
		this.#tools = [];
		this.#subscribedResources.clear();
	}

	/**
	 * Reconnect to a server after a connection failure.
	 * Tears down the stale connection, re-resolves auth, establishes a new
	 * connection, reloads tools, and notifies consumers.
	 * Concurrent calls for the same server share one reconnection attempt.
	 * Returns the new connection, or null if reconnection failed.
	 */
	async reconnectServer(name: string): Promise<MCPServerConnection | null> {
		if (this.#toolsOnly || this.#connectionSetSealed) return null;
		const pending = this.#pendingReconnections.get(name);
		if (pending) return pending;

		const attempt = this.#doReconnect(name);
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

		logger.debug("MCP reconnecting", { path: `mcp:${name}` });

		// Close the old transport without removing tools or notifying consumers.
		// Tools stay available (stale) while we establish the new connection.
		const reconnectEpoch = this.#disconnectEpochs.get(name) ?? 0;
		if (oldConnection) {
			// Detach onClose to prevent re-entrant reconnect from the close itself
			oldConnection.transport.onClose = undefined;
			const closePromise = oldConnection.transport.close().catch(() => {});
			if (oldConnection.transport.closeBeforeReconnect) {
				await closePromise;
			} else {
				// Fire-and-forget: don't await HTTP/SSE close — HttpTransport.close()
				// sends a DELETE with config.timeout (30s default), and blocking here
				// delays the reconnect loop by that amount on every server restart.
				void closePromise;
			}
			this.#connections.delete(name);
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
						await delay(delays[attempt], backoffAbort.signal).catch(() => undefined);
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
	): Promise<MCPServerConnection> {
		const resolvedConfig = await this.#resolveAuthConfig(config);
		const connectionAbort = new AbortController();
		this.#pendingConnectionControllers.set(name, connectionAbort);
		let connection: MCPServerConnection;
		try {
			connection = await connectToServer(name, resolvedConfig, {
				signal: connectionAbort.signal,
				onNotification: (method, params) => {
					this.#handleServerNotification(name, method, params);
				},
				onRequest: (method, params) => {
					return this.#handleServerRequest(method, params);
				},
			});
		} finally {
			if (this.#pendingConnectionControllers.get(name) === connectionAbort) {
				this.#pendingConnectionControllers.delete(name);
			}
		}

		connection.config = config;
		if (source) connection._source = source;

		// Bail out if the server was disconnected or the manager was reset
		// while we were connecting (e.g. /mcp reload called disconnectAll).
		if (
			!this.#serverConfigs.has(name) ||
			this.#epoch !== globalEpoch ||
			(this.#disconnectEpochs.get(name) ?? 0) !== disconnectEpoch
		) {
			await connection.transport.close().catch(() => {});
			throw new Error(`Server "${name}" was disconnected during reconnection`);
		}

		this.#connections.set(name, connection);

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
		connection.transport.onClose = () => {
			logger.debug("MCP transport lost, triggering reconnect", { path: `mcp:${name}` });
			void this.reconnectServer(name);
		};
		try {
			const serverTools = await listTools(connection);
			if (!this.#isCurrentConnection(name, config, globalEpoch, disconnectEpoch, connection)) {
				connection.transport.onClose = undefined;
				await connection.transport.close().catch(() => {});
				throw new Error(`Server "${name}" was disconnected during tool loading`);
			}
			const reconnect = () => this.reconnectServer(name);
			const customTools = MCPTool.fromTools(connection, serverTools, reconnect);
			void this.toolCache?.set(name, config, serverTools);
			this.#replaceServerTools(name, customTools);
			this.#onToolsChanged?.(this.#tools);
			void this.#loadServerResourcesAndPrompts(name, connection);
			return connection;
		} catch (error) {
			// Clean up the connection to avoid zombie transports
			connection.transport.onClose = undefined;
			await connection.transport.close().catch(() => {});
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
				const [resources] = await Promise.all([listResources(connection), listResourceTemplates(connection)]);

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
				await listPrompts(connection);
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

		// Clear cached tools
		connection.tools = undefined;

		// Reload tools
		const serverTools = await listTools(connection);
		if (!this.#isCurrentConnection(name, connection.config, globalEpoch, disconnectEpoch, connection)) return;
		const reconnect = () => this.reconnectServer(name);
		const customTools = MCPTool.fromTools(connection, serverTools, reconnect);
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
			const [resources] = await Promise.all([listResources(connection), listResourceTemplates(connection)]);
			if (this.#notificationsEnabled && connection.capabilities.resources?.subscribe) {
				const newUris = new Set(resources.map(r => r.uri));
				const oldUris = this.#subscribedResources.get(name);
				const notificationEpoch = this.#notificationsEpoch;

				// Unsubscribe URIs that were removed
				if (oldUris) {
					const removed = [...oldUris].filter(uri => !newUris.has(uri));
					if (removed.length > 0) {
						try {
							await unsubscribeFromResources(connection, removed);
						} catch (error) {
							logger.debug("Failed to unsubscribe stale MCP resources", { path: `mcp:${name}`, error });
						}
					}
				}

				// Subscribe to the current set and update tracking atomically
				try {
					const allUris = [...newUris];
					await subscribeToResources(connection, allUris);
					const action = resolveSubscriptionPostAction(
						this.#notificationsEnabled,
						this.#notificationsEpoch,
						notificationEpoch,
					);
					if (action === "rollback") {
						await unsubscribeFromResources(connection, allUris).catch(error => {
							logger.debug("Failed to rollback stale MCP resource subscription", { path: `mcp:${name}`, error });
						});
						return;
					}
					if (action === "ignore") {
						return;
					}
					this.#subscribedResources.set(name, newUris);
				} catch (error) {
					logger.debug("Failed to re-subscribe to MCP resources", { path: `mcp:${name}`, error });
				}
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
		await listPrompts(connection);

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
		return readResource(connection, uri, options);
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
		return getPrompt(connection, promptName, args, options);
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
		if (auth?.type === "oauth" && auth.credentialId && this.#authStorage) {
			const credentialId = auth.credentialId;
			let credential = this.#authStorage.get(credentialId);
			if (credential?.type === "oauth") {
				// Proactive refresh: 5-minute buffer before expiry
				// Force refresh: on 401/403 auth errors (revoked tokens, clock skew, missing expires)
				const REFRESH_BUFFER_MS = 5 * 60_000;
				const shouldRefresh =
					forceRefresh || (credential.expires && Date.now() >= credential.expires - REFRESH_BUFFER_MS);
				let refreshedCredential:
					| {
							type: "oauth";
							access: string;
							refresh: string;
							expires: number;
					  }
					| undefined;
				if (shouldRefresh && credential.refresh && auth.tokenUrl) {
					try {
						const refreshed = await refreshMCPOAuthToken(
							auth.tokenUrl,
							credential.refresh,
							auth.clientId,
							auth.clientSecret,
						);
						refreshedCredential = { type: "oauth", ...refreshed };
					} catch (error) {
						if (!(error instanceof MCPExpectedFailure)) throw error;
						if (this.#toolsOnly) {
							logger.debug("MCP OAuth refresh failed");
						} else {
							logger.warn("MCP OAuth refresh failed, using existing token");
						}
					}
				}
				if (refreshedCredential) {
					await this.#authStorage.set(credentialId, refreshedCredential);
					credential = refreshedCredential;
				}

				if (resolved.type === "http" || resolved.type === "sse") {
					resolved = {
						...resolved,
						headers: {
							...resolved.headers,
							Authorization: `Bearer ${credential.access}`,
						},
					};
				} else {
					resolved = {
						...resolved,
						env: {
							...resolved.env,
							OAUTH_ACCESS_TOKEN: credential.access,
						},
					};
				}
			}
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
		options?.configPath !== undefined ? new MCPManager(cwd, null, { toolsOnly: true }) : new MCPManager(cwd);
	const result = await manager.discoverAndConnect(options);
	return { manager, result };
}
