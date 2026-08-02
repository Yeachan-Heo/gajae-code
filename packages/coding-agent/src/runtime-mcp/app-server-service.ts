import * as path from "node:path";
import { resolveMCPOAuthResourceOrigin, resolveMCPOAuthTokenEndpoint } from "@gajae-code/ai";
import { getAgentDir, getProjectDir } from "@gajae-code/utils";
import { AuthStorage, type OAuthCredential } from "../session/auth-storage";
import { readMCPConfigFile, updateMCPServer, writeMCPConfigFile } from "./config-writer";
import { type MCPLoadResult, MCPManager } from "./manager";
import { discoverOAuthEndpoints } from "./oauth-discovery";
import { type MCPOAuthConfig, MCPOAuthFlow } from "./oauth-flow";
import type { MCPServerConfig, MCPServerConnection } from "./types";

export interface McpAppServerServiceOptions {
	readonly cwd?: string;
	readonly agentDir?: string;
	readonly authStorage?: AuthStorage;
	readonly manager?: MCPManager;
	/** Testable persistence seams for MCP OAuth transaction fault injection. */
	readonly oauthPersistence?: {
		readonly updateServer?: typeof updateMCPServer;
		readonly writeConfig?: typeof writeMCPConfigFile;
	};
}

export interface McpOAuthLoginRequest {
	readonly name: string;
	readonly scopes?: readonly string[];
	readonly timeoutSecs?: number;
	readonly signal?: AbortSignal;
	readonly onCompletion?: (result: { success: boolean; error?: string; cause?: unknown }) => void | Promise<void>;
}

export interface McpOAuthLoginResult {
	readonly authorizationUrl: string;
}

export type McpToolRefresh = (tools: readonly unknown[]) => Promise<void>;

/** Shared runtime MCP lifecycle seam used by TUI and headless app-server callers. */
export async function reloadMcpRuntime(
	mcpManager: MCPManager,
	refreshTools?: McpToolRefresh,
	preflight?: () => void | Promise<void>,
): Promise<MCPLoadResult> {
	if (mcpManager.isConnectionSetSealed()) throw new Error("MCP connection set is sealed.");
	const preflightResult = preflight?.();
	if (preflightResult) await preflightResult;
	await mcpManager.disconnectAll();
	const result = await mcpManager.discoverAndConnect();
	if (refreshTools) await refreshTools(mcpManager.getTools());
	else await mcpManager.refreshAllTools();
	return result;
}

export function createMcpOAuthFlow(
	config: MCPOAuthConfig,
	controller: ConstructorParameters<typeof MCPOAuthFlow>[1],
): MCPOAuthFlow {
	return new MCPOAuthFlow(config, controller);
}

function configuredAgentDir(agentDir?: string): string {
	return path.resolve(agentDir ?? process.env.GJC_AGENT_DIR ?? process.env.GJC_CODING_AGENT_DIR ?? getAgentDir());
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeOAuthFailure(error: unknown): string {
	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	if (message.includes("timeout") || message.includes("timed out")) return "MCP OAuth login timed out.";
	if (message.includes("abort") || message.includes("cancel")) return "MCP OAuth login was cancelled.";
	if (message.includes("invalid_grant")) return "MCP OAuth authorization code was rejected.";
	if (message.includes("401") || message.includes("403") || message.includes("unauthorized"))
		return "MCP OAuth authorization was rejected.";
	if (message.includes("fetch failed") || message.includes("econnrefused") || message.includes("network"))
		return "MCP OAuth provider could not be reached.";
	if (message.includes("callback")) return "MCP OAuth callback failed.";
	return "MCP OAuth login failed.";
}

function oauthHints(config: MCPServerConfig): MCPOAuthConfig {
	const value = config as MCPServerConfig & { oauth?: Record<string, unknown>; auth?: Record<string, unknown> };
	const oauth: Record<string, unknown> = record(value.oauth) ? value.oauth : {};
	const auth: Record<string, unknown> = record(value.auth) ? value.auth : {};
	const callbackPort = oauth.callbackPort;
	return {
		authorizationUrl: stringValue(oauth.authorizationUrl) ?? stringValue(auth.authorizationUrl) ?? "",
		tokenUrl: stringValue(oauth.tokenUrl) ?? stringValue(auth.tokenUrl) ?? "",
		clientId: stringValue(oauth.clientId) ?? stringValue(auth.clientId),
		clientSecret: stringValue(oauth.clientSecret) ?? stringValue(auth.clientSecret),
		scopes: stringValue(oauth.scopes),
		redirectUri: stringValue(oauth.redirectUri),
		callbackPort:
			typeof callbackPort === "number" && Number.isInteger(callbackPort) && callbackPort > 0
				? callbackPort
				: undefined,
		callbackPath: stringValue(oauth.callbackPath),
	};
}

async function resolveEndpoints(conn: MCPServerConnection): Promise<MCPOAuthConfig | undefined> {
	if (conn.config.type !== "http" && conn.config.type !== "sse") return undefined;
	const hints = oauthHints(conn.config);
	let authorizationUrl = hints.authorizationUrl || undefined;
	let tokenUrl = hints.tokenUrl || undefined;
	if ((!authorizationUrl || !tokenUrl) && conn.config.url) {
		const discovered = await discoverOAuthEndpoints(conn.config.url);
		authorizationUrl ??= discovered?.authorizationUrl;
		tokenUrl ??= discovered?.tokenUrl;
		if (discovered) {
			hints.clientId ??= discovered.clientId;
			hints.scopes ??= discovered.scopes;
		}
	}
	if (!authorizationUrl || !tokenUrl) return undefined;
	return { ...hints, authorizationUrl, tokenUrl };
}

function sameConfig(left: MCPServerConfig, right: MCPServerConfig): boolean {
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return false;
	}
}

function sameSource(left: MCPServerConnection["_source"], right: MCPServerConnection["_source"]): boolean {
	return (
		left?.provider === right?.provider &&
		left?.providerName === right?.providerName &&
		left?.path === right?.path &&
		left?.level === right?.level
	);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const reason = signal.reason;
	if (reason instanceof Error) throw reason;
	throw new Error("MCP OAuth login was cancelled.");
}

function appendFailure(failures: unknown[], error: unknown): void {
	if (error instanceof AggregateError) failures.push(...error.errors);
	else failures.push(error);
}

/**
 * Runtime-owned MCP lifecycle/auth service for the headless app-server.
 * The service owns both the manager and auth storage; callers must close it.
 */
export class McpAppServerService {
	readonly manager: MCPManager;
	#authStorage: AuthStorage | undefined;
	readonly #ownsAuthStorage: boolean;
	readonly #readyPromise: Promise<void>;
	readonly #updateServer: typeof updateMCPServer;
	readonly #writeConfig: typeof writeMCPConfigFile;
	#closed = false;
	#closePromise: Promise<void> | undefined;
	#lifecyclePromise: Promise<unknown> | undefined;
	readonly #oauthLocks = new Map<string, Promise<void>>();
	readonly #activeOAuthFlows = new Map<string, { abort: AbortController; completion?: Promise<void> }>();
	readonly #activeOAuthCompletions = new Set<Promise<void>>();
	readonly #oauthCallbackCooldowns = new Map<string, Promise<void>>();

	constructor(options: McpAppServerServiceOptions = {}) {
		this.manager = options.manager ?? new MCPManager(options.cwd ?? getProjectDir());
		this.#ownsAuthStorage = options.authStorage === undefined;
		this.#authStorage = options.authStorage;
		this.#readyPromise = this.#initializeAuthStorage(options.agentDir);
		this.#updateServer = options.oauthPersistence?.updateServer ?? updateMCPServer;
		this.#writeConfig = options.oauthPersistence?.writeConfig ?? writeMCPConfigFile;
	}

	async #initializeAuthStorage(agentDir?: string): Promise<void> {
		const storage =
			this.#authStorage ?? (await AuthStorage.create(path.join(configuredAgentDir(agentDir), "auth.db")));
		this.#authStorage = storage;
		this.manager.setAuthStorage(storage);
	}

	async ready(): Promise<void> {
		if (this.#closed) throw new Error("MCP app-server service is closed.");
		await this.#readyPromise;
		if (this.#closed) throw new Error("MCP app-server service is closed.");
	}

	async #queueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
		await this.ready();
		if (this.#closed) throw new Error("MCP app-server service is closed.");
		const prior = this.#lifecyclePromise ?? Promise.resolve();
		const run = prior
			.catch(() => undefined)
			.then(async () => {
				if (this.#closed) throw new Error("MCP app-server service is closed.");
				return operation();
			});
		const tracked = run.finally(() => {
			if (this.#lifecyclePromise === tracked) this.#lifecyclePromise = undefined;
		});
		this.#lifecyclePromise = tracked;
		return tracked;
	}

	async discover(): Promise<MCPLoadResult> {
		return this.#queueLifecycle(() => this.manager.discoverAndConnect());
	}

	async reload(refreshTools?: McpToolRefresh, preflight?: () => void | Promise<void>): Promise<MCPLoadResult> {
		return this.#queueLifecycle(() => reloadMcpRuntime(this.manager, refreshTools, preflight));
	}

	getConnection(name: string): MCPServerConnection | undefined {
		return this.manager.getConnection(name);
	}

	getSource(name: string) {
		return this.manager.getSource(name);
	}

	getCwd(): string {
		return this.manager.getCwd();
	}

	async #withOAuthLock<T>(name: string, action: () => Promise<T>): Promise<T> {
		const prior = this.#oauthLocks.get(name) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const queued = prior.then(() => gate);
		this.#oauthLocks.set(name, queued);
		await prior;
		try {
			return await action();
		} finally {
			release();
			if (this.#oauthLocks.get(name) === queued) this.#oauthLocks.delete(name);
		}
	}

	async oauthLogin(request: McpOAuthLoginRequest): Promise<McpOAuthLoginResult> {
		if (this.#closed) throw new Error("MCP app-server service is closed.");
		throwIfAborted(request.signal);
		if (this.#activeOAuthFlows.has(request.name)) {
			throw Object.assign(new Error(`MCP OAuth login already in progress for server "${request.name}".`), {
				code: "busy",
			});
		}
		if (this.#oauthCallbackCooldowns.has(request.name)) {
			throw Object.assign(
				new Error(`MCP OAuth callback listener is still releasing for server "${request.name}".`),
				{
					code: "busy",
				},
			);
		}
		const flowState: { abort: AbortController; completion?: Promise<void> } = {
			abort: new AbortController(),
		};
		this.#activeOAuthFlows.set(request.name, flowState);
		try {
			await this.discover();
			throwIfAborted(flowState.abort.signal);
			const conn = this.manager.getConnection(request.name);
			if (!conn) throw new Error(`MCP server "${request.name}" is not connected.`);
			const expectedConfig = structuredClone(conn.config);
			const expectedSource = conn._source ?? this.manager.getSource(request.name);
			const endpoints = await resolveEndpoints(conn);
			if (!endpoints) throw new Error("MCP OAuth endpoints are unavailable for this server.");
			const resourceOrigin = resolveMCPOAuthResourceOrigin(
				conn.config.type === "http" || conn.config.type === "sse" ? conn.config.url : "",
			);
			const tokenEndpoint = resolveMCPOAuthTokenEndpoint(endpoints.tokenUrl);
			if (!resourceOrigin || !tokenEndpoint) throw new Error("MCP OAuth endpoints are invalid.");

			const authorization = Promise.withResolvers<string>();
			const timeoutSignal =
				request.timeoutSecs === undefined ? undefined : AbortSignal.timeout(request.timeoutSecs * 1_000);
			const signals = [flowState.abort.signal, request.signal, timeoutSignal].filter(
				(value): value is AbortSignal => value !== undefined,
			);
			const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
			throwIfAborted(signal);
			const flow = createMcpOAuthFlow(
				{ ...endpoints, tokenUrl: tokenEndpoint, scopes: request.scopes?.join(" ") ?? endpoints.scopes },
				{
					signal,
					onAuth: info => authorization.resolve(info.url),
				},
			);
			const completion = flow
				.login()
				.then(credentials =>
					this.#queueLifecycle(() =>
						this.#withOAuthLock(request.name, () =>
							this.#persistOAuthCredentials(
								request.name,
								conn,
								flow,
								credentials,
								endpoints,
								tokenEndpoint,
								expectedConfig,
								expectedSource,
								signal,
							),
						),
					),
				)
				.then(
					async () => {
						await request.onCompletion?.({ success: true });
					},
					async error => {
						authorization.reject(error);
						const completion: { success: false; error: string; cause?: unknown } = {
							success: false,
							error: sanitizeOAuthFailure(error),
						};
						Object.defineProperty(completion, "cause", { value: error, enumerable: false });
						await request.onCompletion?.(completion);
					},
				)
				.finally(async () => {
					let cooldown!: Promise<void>;
					cooldown = Bun.sleep(25).finally(() => {
						if (this.#activeOAuthFlows.get(request.name) === flowState)
							this.#activeOAuthFlows.delete(request.name);
						if (this.#oauthCallbackCooldowns.get(request.name) === cooldown)
							this.#oauthCallbackCooldowns.delete(request.name);
					});
					this.#oauthCallbackCooldowns.set(request.name, cooldown);
					await cooldown;
					this.#activeOAuthCompletions.delete(completion);
				});
			flowState.completion = completion;
			this.#activeOAuthCompletions.add(completion);
			void completion.catch(() => {});
			return { authorizationUrl: await authorization.promise };
		} catch (error) {
			if (!flowState.completion) {
				flowState.abort.abort(error);
				if (this.#activeOAuthFlows.get(request.name) === flowState) this.#activeOAuthFlows.delete(request.name);
			}
			throw error;
		}
	}

	async #persistOAuthCredentials(
		name: string,
		conn: MCPServerConnection,
		flow: MCPOAuthFlow,
		credentials: { access: string; refresh: string; expires: number },
		endpoints: MCPOAuthConfig,
		tokenEndpoint: string,
		expectedConfig: MCPServerConfig,
		expectedSource: MCPServerConnection["_source"],
		signal?: AbortSignal,
	): Promise<void> {
		throwIfAborted(signal);
		const storage = this.#authStorage ?? (await this.#readyPromise.then(() => this.manager.getAuthStorage()));
		if (!storage) throw new Error("MCP OAuth auth storage is unavailable.");
		const current = this.manager.getConnection(name);
		const source = this.manager.getSource(name);
		if (
			!current ||
			current !== conn ||
			!sameSource(source, expectedSource) ||
			!sameConfig(current.config, expectedConfig)
		) {
			throw new Error(
				"MCP OAuth login was discarded because the server configuration changed during authorization.",
			);
		}
		const currentEndpoints = await resolveEndpoints(current);
		if (
			!currentEndpoints ||
			currentEndpoints.authorizationUrl !== endpoints.authorizationUrl ||
			resolveMCPOAuthTokenEndpoint(currentEndpoints.tokenUrl) !== tokenEndpoint
		) {
			throw new Error("MCP OAuth login was discarded because the server endpoints changed during authorization.");
		}
		if (!source?.path || source.level === "native")
			throw new Error("MCP OAuth server configuration has no writable source.");
		const previousFile = await readMCPConfigFile(source.path);
		const previousConfig = structuredClone(current.config);
		const previousCredentialId = previousConfig.auth?.type === "oauth" ? previousConfig.auth.credentialId : undefined;
		const previousCredential = previousCredentialId ? storage.get(previousCredentialId) : undefined;
		const credentialId = `mcp_oauth_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
		const credential: OAuthCredential = {
			type: "oauth",
			...credentials,
			mcpBinding: {
				resourceOrigin: resolveMCPOAuthResourceOrigin(
					current.config.type === "http" || current.config.type === "sse" ? current.config.url : "",
				)!,
				tokenEndpoint,
			},
		};
		const updated = {
			...current.config,
			auth: {
				...(current.config.auth ?? {}),
				type: "oauth" as const,
				credentialId,
				tokenUrl: tokenEndpoint,
				clientId: flow.resolvedClientId ?? endpoints.clientId,
				clientSecret: flow.registeredClientSecret ?? endpoints.clientSecret,
			},
			oauth: {
				...(current.config.oauth ?? {}),
				clientId: flow.resolvedClientId ?? endpoints.clientId,
				clientSecret: flow.registeredClientSecret ?? endpoints.clientSecret,
			},
		} as MCPServerConfig;
		let credentialWriteAttempted = false;
		let configWriteAttempted = false;
		let managerConfigSetAttempted = false;
		let reconnectAttempted = false;
		let oldCredentialRemovalAttempted = false;
		try {
			throwIfAborted(signal);
			credentialWriteAttempted = true;
			await storage.set(credentialId, credential);
			throwIfAborted(signal);
			configWriteAttempted = true;
			await this.#updateServer(source.path, name, updated);
			throwIfAborted(signal);
			managerConfigSetAttempted = true;
			this.manager.setServerConfig(name, updated);
			throwIfAborted(signal);
			reconnectAttempted = true;
			const reconnected = await this.manager.reconnectServer(name);
			if (!reconnected) throw new Error("MCP server did not reconnect after OAuth login.");
			throwIfAborted(signal);
			if (previousCredentialId && previousCredentialId !== credentialId) {
				throwIfAborted(signal);
				oldCredentialRemovalAttempted = true;
				await storage.remove(previousCredentialId);
				throwIfAborted(signal);
			}
		} catch (primary) {
			const failures: unknown[] = [];
			failures.push(primary);
			const compensate = async (action: () => Promise<void> | void): Promise<void> => {
				try {
					await action();
				} catch (error) {
					appendFailure(failures, error);
				}
			};
			if (managerConfigSetAttempted) await compensate(() => this.manager.setServerConfig(name, previousConfig));
			if (configWriteAttempted) await compensate(() => this.#writeConfig(source.path, previousFile));
			if (oldCredentialRemovalAttempted && previousCredential) {
				await compensate(() => storage.set(previousCredentialId!, previousCredential));
			}
			if (credentialWriteAttempted) await compensate(() => storage.remove(credentialId));
			if (reconnectAttempted)
				await compensate(async () => {
					const restored = await this.manager.reconnectServer(name);
					if (!restored)
						throw new Error("MCP server did not reconnect while restoring the previous OAuth connection.");
				});
			if (failures.length > 1) {
				throw new AggregateError(
					failures,
					`MCP OAuth persistence failed and ${failures.length - 1} rollback operation(s) failed.`,
				);
			}
			throw primary;
		}
	}

	async close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		this.#closePromise = this.#close();
		return this.#closePromise;
	}

	async #close(): Promise<void> {
		const failures: unknown[] = [];
		const captureFailure = (error: unknown): void => appendFailure(failures, error);
		for (const flow of this.#activeOAuthFlows.values()) {
			try {
				flow.abort.abort(new Error("MCP app-server service closed."));
			} catch (error) {
				captureFailure(error);
			}
		}
		const activeCompletions = [...this.#activeOAuthCompletions];
		for (const result of await Promise.allSettled(activeCompletions)) {
			if (result.status === "rejected") captureFailure(result.reason);
		}
		const lifecycle = this.#lifecyclePromise;
		if (lifecycle) {
			try {
				await lifecycle;
			} catch (error) {
				captureFailure(error);
			}
		}
		try {
			await this.#readyPromise;
		} catch (error) {
			captureFailure(error);
		}
		try {
			this.manager.shutdown();
			await this.manager.waitForClosures();
		} catch (error) {
			captureFailure(error);
		}
		if (this.#ownsAuthStorage && this.#authStorage) {
			try {
				this.#authStorage.close();
			} catch (error) {
				captureFailure(error);
			}
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, `MCP app-server cleanup failed (${failures.length} operation(s)).`);
		}
	}
}

export function createMcpAppServerService(options: McpAppServerServiceOptions = {}): McpAppServerService {
	return new McpAppServerService(options);
}
