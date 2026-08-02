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
}

export interface McpOAuthLoginRequest {
	readonly name: string;
	readonly scopes?: readonly string[];
	readonly timeoutSecs?: number;
	readonly signal?: AbortSignal;
	readonly onCompletion?: (result: { success: boolean; error?: string }) => void | Promise<void>;
}

export interface McpOAuthLoginResult {
	readonly authorizationUrl: string;
}

export type McpToolRefresh = (tools: readonly unknown[]) => Promise<void>;

/** Shared runtime MCP lifecycle seam used by TUI and headless app-server callers. */
export async function reloadMcpRuntime(mcpManager: MCPManager, refreshTools?: McpToolRefresh): Promise<MCPLoadResult> {
	if (mcpManager.isConnectionSetSealed()) throw new Error("MCP connection set is sealed.");
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

/**
 * Runtime-owned MCP lifecycle/auth service for the headless app-server.
 * The service owns both the manager and auth storage; callers must close it.
 */
export class McpAppServerService {
	readonly manager: MCPManager;
	#authStorage: AuthStorage | undefined;
	readonly #ownsAuthStorage: boolean;
	readonly #readyPromise: Promise<void>;
	#closed = false;
	#lifecyclePromise: Promise<unknown> | undefined;
	readonly #oauthLocks = new Map<string, Promise<void>>();

	constructor(options: McpAppServerServiceOptions = {}) {
		this.manager = options.manager ?? new MCPManager(options.cwd ?? getProjectDir());
		this.#ownsAuthStorage = options.authStorage === undefined;
		this.#authStorage = options.authStorage;
		this.#readyPromise = this.#initializeAuthStorage(options.agentDir);
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
	}

	async #queueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
		await this.ready();
		const prior = this.#lifecyclePromise ?? Promise.resolve();
		const run = prior.catch(() => undefined).then(operation);
		const tracked = run.finally(() => {
			if (this.#lifecyclePromise === tracked) this.#lifecyclePromise = undefined;
		});
		this.#lifecyclePromise = tracked;
		return tracked;
	}

	async discover(): Promise<MCPLoadResult> {
		return this.#queueLifecycle(() => this.manager.discoverAndConnect());
	}

	async reload(refreshTools?: McpToolRefresh): Promise<MCPLoadResult> {
		return this.#queueLifecycle(() => reloadMcpRuntime(this.manager, refreshTools));
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
		await this.discover();
		const conn = this.manager.getConnection(request.name);
		if (!conn) throw new Error(`MCP server "${request.name}" is not connected.`);
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
		const signal =
			request.signal && timeoutSignal
				? AbortSignal.any([request.signal, timeoutSignal])
				: (request.signal ?? timeoutSignal);
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
						this.#persistOAuthCredentials(request.name, conn, flow, credentials, endpoints, tokenEndpoint),
					),
				),
			)
			.then(
				async () => {
					await request.onCompletion?.({ success: true });
				},
				async error => {
					await request.onCompletion?.({ success: false, error: sanitizeOAuthFailure(error) });
				},
			);
		void completion;
		return { authorizationUrl: await authorization.promise };
	}

	async #persistOAuthCredentials(
		name: string,
		conn: MCPServerConnection,
		flow: MCPOAuthFlow,
		credentials: { access: string; refresh: string; expires: number },
		endpoints: MCPOAuthConfig,
		tokenEndpoint: string,
	): Promise<void> {
		const storage = this.#authStorage ?? (await this.#readyPromise.then(() => this.manager.getAuthStorage()));
		if (!storage) throw new Error("MCP OAuth auth storage is unavailable.");
		const source = conn._source ?? this.manager.getSource(name);
		if (!source?.path || source.level === "native")
			throw new Error("MCP OAuth server configuration has no writable source.");
		const previousFile = await readMCPConfigFile(source.path);
		const previousConfig = structuredClone(conn.config);
		const credentialId = `mcp_oauth_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
		const credential: OAuthCredential = {
			type: "oauth",
			...credentials,
			mcpBinding: {
				resourceOrigin: resolveMCPOAuthResourceOrigin(
					conn.config.type === "http" || conn.config.type === "sse" ? conn.config.url : "",
				)!,
				tokenEndpoint,
			},
		};
		const updated = {
			...conn.config,
			auth: {
				...(conn.config.auth ?? {}),
				type: "oauth" as const,
				credentialId,
				tokenUrl: tokenEndpoint,
				clientId: flow.resolvedClientId ?? endpoints.clientId,
				clientSecret: flow.registeredClientSecret ?? endpoints.clientSecret,
			},
			oauth: {
				...(conn.config.oauth ?? {}),
				clientId: flow.resolvedClientId ?? endpoints.clientId,
				clientSecret: flow.registeredClientSecret ?? endpoints.clientSecret,
			},
		} as MCPServerConfig;
		let configWritten = false;
		let credentialWritten = false;
		try {
			await storage.set(credentialId, credential);
			credentialWritten = true;
			await updateMCPServer(source.path, name, updated);
			configWritten = true;
			this.manager.setServerConfig(name, updated);
			const reconnected = await this.manager.reconnectServer(name);
			if (!reconnected) throw new Error("MCP server did not reconnect after OAuth login.");
		} catch (error) {
			this.manager.setServerConfig(name, previousConfig);
			if (configWritten) await writeMCPConfigFile(source.path, previousFile).catch(() => {});
			if (credentialWritten) await storage.remove(credentialId).catch(() => {});
			await this.manager.reconnectServer(name).catch(() => {});
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.manager.disconnectAll().catch(() => {});
		if (this.#ownsAuthStorage) {
			const storage = await this.#readyPromise.then(() => this.manager.getAuthStorage()).catch(() => undefined);
			storage?.close();
		}
	}
}

export function createMcpAppServerService(options: McpAppServerServiceOptions = {}): McpAppServerService {
	return new McpAppServerService(options);
}
