import * as path from "node:path";
import { resolveMCPOAuthResourceOrigin, resolveMCPOAuthTokenEndpoint } from "@gajae-code/ai";
import { getMCPConfigPath, getProjectDir } from "@gajae-code/utils";
import { createMcpOAuthFlow, reloadMcpRuntime } from "../../modes/controllers/runtime-mcp-command-controller";
import { callTool, listResources, listResourceTemplates, listTools } from "../../runtime-mcp/client";
import { readMCPConfigFile, updateMCPServer } from "../../runtime-mcp/config-writer";
import { MCPManager } from "../../runtime-mcp/manager";
import { discoverOAuthEndpoints } from "../../runtime-mcp/oauth-discovery";
import type { MCPServerConfig, MCPServerConnection } from "../../runtime-mcp/types";
import type { OAuthCredential } from "../../session/auth-storage";
import type { HandlerContext, HandlerResult, MethodHandler } from "./handlers";

type RecordValue = Record<string, unknown>;
type OAuthHints = {
	authorizationUrl?: string;
	tokenUrl?: string;
	clientId?: string;
	clientSecret?: string;
	scopes?: string;
	redirectUri?: string;
	callbackPort?: number;
	callbackPath?: string;
};
type OAuthEndpoints = OAuthHints & { authorizationUrl: string; tokenUrl: string };

const invalid = (): HandlerResult => ({ ok: false, errorKey: "invalidParams" });
const notFound = (): HandlerResult => ({ ok: false, errorKey: "notFound" });
const internal = (): HandlerResult => ({ ok: false, errorKey: "internalError" });

function record(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hostContext(context?: HandlerContext): HandlerContext | undefined {
	return context;
}

function manager(context?: HandlerContext): MCPManager | undefined {
	return hostContext(context)?.mcpManager ?? MCPManager.instance();
}

function createManager(context?: HandlerContext): MCPManager | undefined {
	const existing = manager(context);
	if (existing) return existing;
	try {
		const created = new MCPManager(getProjectDir());
		MCPManager.setInstance(created);
		return created;
	} catch {
		return undefined;
	}
}

async function discoverManager(context?: HandlerContext): Promise<MCPManager | undefined> {
	const existing = manager(context);
	if (existing) return existing;
	const created = createManager(context);
	if (!created) return undefined;
	try {
		await created.discoverAndConnect();
		return created;
	} catch {
		await created.disconnectAll().catch(() => {});
		if (MCPManager.instance() === created) MCPManager.resetForTests();
		return undefined;
	}
}

function connection(name: unknown, context?: HandlerContext): MCPServerConnection | undefined {
	if (typeof name !== "string" || name.length === 0) return undefined;
	try {
		return manager(context)?.getConnection(name);
	} catch {
		return undefined;
	}
}

function authStatus(conn: MCPServerConnection | undefined): "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth" {
	const auth = conn?.config.auth;
	if (!auth) return "unsupported";
	if (auth.type === "oauth") return "oAuth";
	return "bearerToken";
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function oauthHints(config: MCPServerConfig): OAuthHints {
	const value = config as MCPServerConfig & { oauth?: RecordValue; auth?: RecordValue };
	const oauth: RecordValue = record(value.oauth) ? value.oauth : {};
	const auth: RecordValue = record(value.auth) ? value.auth : {};
	const callbackPort = oauth.callbackPort;
	return {
		authorizationUrl: stringValue(oauth.authorizationUrl) ?? stringValue(auth.authorizationUrl),
		tokenUrl: stringValue(oauth.tokenUrl) ?? stringValue(auth.tokenUrl),
		clientId: stringValue(oauth.clientId) ?? stringValue(auth.clientId),
		clientSecret: stringValue(oauth.clientSecret) ?? stringValue(auth.clientSecret),
		redirectUri: stringValue(oauth.redirectUri),
		callbackPort:
			typeof callbackPort === "number" && Number.isInteger(callbackPort) && callbackPort > 0
				? callbackPort
				: undefined,
		callbackPath: stringValue(oauth.callbackPath),
	};
}

async function resolveOAuthEndpoints(conn: MCPServerConnection): Promise<OAuthEndpoints | undefined> {
	const config = conn.config;
	if (config.type !== "http" && config.type !== "sse") return undefined;
	const hints = oauthHints(config);
	let authorizationUrl = hints.authorizationUrl;
	let tokenUrl = hints.tokenUrl;
	if ((!authorizationUrl || !tokenUrl) && config.url) {
		const discovered = await discoverOAuthEndpoints(config.url);
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

async function configuredMcpPath(name: string, cwd: string = getProjectDir()): Promise<string | undefined> {
	const candidates = [
		getMCPConfigPath("user", cwd),
		getMCPConfigPath("project", cwd),
		path.join(cwd, "mcp.json"),
		path.join(cwd, ".mcp.json"),
	];
	for (const filePath of candidates) {
		try {
			const config = await readMCPConfigFile(filePath);
			if (config.mcpServers?.[name]) return filePath;
		} catch {
			// A malformed lower-priority file must not hide a valid higher-priority source.
		}
	}
	return undefined;
}

function emitOAuthCompletion(
	context: HandlerContext | undefined,
	name: string,
	threadId: string | undefined,
	success: boolean,
	error?: string,
): void {
	const connectionId = context?.connectionId;
	if (!connectionId) return;
	context.emitTo?.(connectionId, "mcpServer/oauthLogin/completed", {
		name,
		...(threadId ? { threadId } : {}),
		success,
		...(error ? { error } : {}),
	});
}

async function persistOAuthCredentials(
	mcp: MCPManager,
	name: string,
	conn: MCPServerConnection,
	flow: { resolvedClientId?: string; registeredClientSecret?: string },
	credentials: { access: string; refresh: string; expires: number },
	endpoints: OAuthEndpoints,
	context: HandlerContext | undefined,
): Promise<void> {
	const authStorage = mcp.getAuthStorage();
	if (!authStorage) throw new Error("MCP OAuth credentials cannot be persisted without auth storage.");
	const resourceOrigin = resolveMCPOAuthResourceOrigin(
		conn.config.type === "http" || conn.config.type === "sse" ? conn.config.url : "",
	);
	const tokenEndpoint = resolveMCPOAuthTokenEndpoint(endpoints.tokenUrl);
	if (!resourceOrigin || !tokenEndpoint) throw new Error("MCP OAuth endpoints are not valid canonical HTTP URLs.");

	const credentialId = `mcp_oauth_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
	const oauthCredential: OAuthCredential = {
		type: "oauth",
		...credentials,
		mcpBinding: { resourceOrigin, tokenEndpoint },
	};
	await authStorage.set(credentialId, oauthCredential);

	const hints = oauthHints(conn.config);
	const updated = {
		...conn.config,
		auth: {
			...(conn.config.auth ?? {}),
			type: "oauth" as const,
			credentialId,
			tokenUrl: tokenEndpoint,
			clientId: flow.resolvedClientId ?? hints.clientId,
			clientSecret: flow.registeredClientSecret ?? hints.clientSecret,
		},
		oauth: {
			...(conn.config.oauth ?? {}),
			clientId: flow.resolvedClientId ?? hints.clientId,
			clientSecret: flow.registeredClientSecret ?? hints.clientSecret,
		},
	} as MCPServerConfig;
	const filePath = await configuredMcpPath(name, mcp.getCwd());
	if (filePath) await updateMCPServer(filePath, name, updated);
	conn.config = updated;
	const reconnected = await mcp.reconnectServer(name);
	if (!reconnected) throw new Error(`MCP server "${name}" could not reconnect after OAuth login.`);
	if (context?.refreshMcpTools) await context.refreshMcpTools(mcp.getTools());
	else await mcp.refreshAllTools();
}

/** Project GJC's live MCP manager onto the pinned status response. */
export const mcpServerStatusListHandler: MethodHandler = async (params, context) => {
	if (!record(params)) return invalid();
	const cursor = params.cursor;
	const limit = params.limit;
	const detail = params.detail;
	if (cursor !== undefined && cursor !== null && typeof cursor !== "string") return invalid();
	if (limit !== undefined && limit !== null && (!Number.isInteger(limit) || (limit as number) < 0)) return invalid();
	if (detail !== undefined && detail !== null && detail !== "full" && detail !== "toolsAndAuthOnly") return invalid();
	const mcp = manager(context);
	if (!mcp) return { ok: true, result: { data: [] } };

	const names = mcp.getAllServerNames().sort();
	const start = cursor === undefined || cursor === null || cursor === "" ? 0 : Number.parseInt(cursor, 10);
	if (!Number.isInteger(start) || start < 0 || start > names.length) return invalid();
	const pageSize = limit === undefined || limit === null ? names.length : (limit as number);
	const selected = names.slice(start, start + pageSize);
	const data = await Promise.all(
		selected.map(async name => {
			const conn = connection(name, context);
			if (!conn) {
				return {
					name,
					serverInfo: null,
					tools: {},
					resources: [],
					resourceTemplates: [],
					authStatus: authStatus(conn),
				};
			}
			if (detail === "toolsAndAuthOnly") {
				return {
					name,
					serverInfo: conn.serverInfo,
					tools: Object.fromEntries((conn.tools ?? []).map(tool => [tool.name, tool])),
					resources: [],
					resourceTemplates: [],
					authStatus: authStatus(conn),
				};
			}
			try {
				const [tools, resources, resourceTemplates] = await Promise.all([
					listTools(conn),
					listResources(conn),
					listResourceTemplates(conn),
				]);
				return {
					name,
					serverInfo: conn.serverInfo,
					tools: Object.fromEntries(tools.map(tool => [tool.name, tool])),
					resources,
					resourceTemplates,
					authStatus: authStatus(conn),
				};
			} catch {
				return {
					name,
					serverInfo: conn.serverInfo,
					tools: Object.fromEntries((conn.tools ?? []).map(tool => [tool.name, tool])),
					resources: conn.resources ?? [],
					resourceTemplates: conn.resourceTemplates ?? [],
					authStatus: authStatus(conn),
				};
			}
		}),
	);
	const result: RecordValue = { data };
	if (start + selected.length < names.length) result.nextCursor = String(start + selected.length);
	return { ok: true, result };
};

/** Reload configured MCP servers through the same lifecycle seam used by `/mcp reload`. */
export const mcpServerReloadHandler: MethodHandler = async (params, context) => {
	if (params !== undefined && params !== null && !record(params)) return invalid();
	const mcp = createManager(context);

	if (!mcp) return notFound();
	try {
		await reloadMcpRuntime(mcp, hostContext(context)?.refreshMcpTools);
		return { ok: true, result: {} };
	} catch {
		return internal();
	}
};

/** Invoke a tool through GJC's connected MCP client. */
export const mcpServerToolCallHandler: MethodHandler = async (params, context) => {
	if (
		!record(params) ||
		typeof params.threadId !== "string" ||
		typeof params.server !== "string" ||
		typeof params.tool !== "string"
	)
		return invalid();
	const args = params.arguments;
	if (args !== undefined && !record(args)) return invalid();
	const conn = connection(params.server, context);
	if (!conn) return notFound();
	try {
		const tools = await listTools(conn);
		if (!tools.some(tool => tool.name === params.tool)) return notFound();
		const result = await callTool(conn, params.tool, (args ?? {}) as Record<string, unknown>);
		return { ok: true, result };
	} catch {
		return internal();
	}
};

/** Read a resource through GJC's connected MCP client. */
export const mcpServerResourceReadHandler: MethodHandler = async (params, context) => {
	if (!record(params) || typeof params.server !== "string" || typeof params.uri !== "string") return invalid();
	const mcp = manager(context);
	if (!connection(params.server, context)) return notFound();
	try {
		const result = await mcp?.readServerResource(params.server, params.uri);
		return result === undefined ? notFound() : { ok: true, result };
	} catch {
		return internal();
	}
};

/** Start GJC's interactive MCP OAuth flow and return its real authorization URL. */
export const mcpServerOauthLoginHandler: MethodHandler = async (params, context) => {
	if (!record(params) || typeof params.name !== "string" || params.name.trim().length === 0) return invalid();
	const name = params.name.trim();
	const threadId = params.threadId === undefined ? undefined : stringValue(params.threadId);
	if (params.threadId !== undefined && !threadId) return invalid();
	const scopes = params.scopes;
	if (scopes !== undefined && (!Array.isArray(scopes) || !scopes.every(scope => typeof scope === "string")))
		return invalid();
	const timeoutSecs = params.timeoutSecs;
	if (
		timeoutSecs !== undefined &&
		(typeof timeoutSecs !== "number" ||
			!Number.isFinite(timeoutSecs) ||
			!Number.isInteger(timeoutSecs) ||
			timeoutSecs <= 0)
	)
		return invalid();
	const mcp = await discoverManager(context);
	const conn = connection(name, context);
	if (!mcp || !conn) return notFound();
	if (conn.config.type !== "http" && conn.config.type !== "sse") return invalid();

	let endpoints: OAuthEndpoints | undefined;
	try {
		endpoints = await resolveOAuthEndpoints(conn);
	} catch {
		return internal();
	}
	if (!endpoints) return invalid();
	const resourceOrigin = resolveMCPOAuthResourceOrigin(conn.config.url);
	const tokenEndpoint = resolveMCPOAuthTokenEndpoint(endpoints.tokenUrl);
	if (!resourceOrigin || !tokenEndpoint) return invalid();

	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(new Error("MCP OAuth login timed out.")), (timeoutSecs ?? 300) * 1_000);
	const authorization = Promise.withResolvers<string>();
	let authorizationPublished = false;
	let flow: ReturnType<typeof createMcpOAuthFlow>;
	try {
		flow = createMcpOAuthFlow(
			{
				authorizationUrl: endpoints.authorizationUrl,
				tokenUrl: tokenEndpoint,
				clientId: endpoints.clientId,
				clientSecret: endpoints.clientSecret,
				scopes: scopes?.join(" ") || endpoints.scopes,
				redirectUri: endpoints.redirectUri,
				callbackPort: endpoints.callbackPort,
				callbackPath: endpoints.callbackPath,
			},
			{
				signal: abort.signal,
				onAuth: info => {
					authorizationPublished = true;
					authorization.resolve(info.url);
				},
			},
		);
	} catch {
		clearTimeout(timer);
		return invalid();
	}

	const completion = flow.login();
	void completion
		.then(async credentials => {
			try {
				await persistOAuthCredentials(
					mcp,
					name,
					conn,
					flow,
					credentials,
					{ ...endpoints, tokenUrl: tokenEndpoint },
					hostContext(context),
				);
				emitOAuthCompletion(context, name, threadId, true);
			} catch (error) {
				emitOAuthCompletion(
					context,
					name,
					threadId,
					false,
					error instanceof Error ? error.message : "MCP OAuth credentials could not be persisted.",
				);
			}
		})
		.catch(error => {
			if (!authorizationPublished) authorization.reject(error);
			emitOAuthCompletion(
				context,
				name,
				threadId,
				false,
				error instanceof Error ? error.message : "MCP OAuth login failed.",
			);
		})
		.finally(() => clearTimeout(timer));

	try {
		return { ok: true, result: { authorizationUrl: await authorization.promise } };
	} catch {
		return internal();
	}
};

export const mcpHandlers: Record<string, MethodHandler> = {
	"config/mcpServer/reload": mcpServerReloadHandler,
	"mcpServerStatus/list": mcpServerStatusListHandler,
	"mcpServer/tool/call": mcpServerToolCallHandler,
	"mcpServer/resource/read": mcpServerResourceReadHandler,
	"mcpServer/oauth/login": mcpServerOauthLoginHandler,
};
