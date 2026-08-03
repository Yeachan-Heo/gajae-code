import { type McpAppServerService, reloadMcpRuntime } from "../../runtime-mcp/app-server-service";
import { callTool, listResources, listResourceTemplates, listTools } from "../../runtime-mcp/client";
import type { MCPManager } from "../../runtime-mcp/manager";
import type { MCPServerConnection } from "../../runtime-mcp/types";
import type { HandlerContext, HandlerResult, MethodHandler } from "./handlers";

type RecordValue = Record<string, unknown>;

const invalid = (): HandlerResult => ({ ok: false, errorKey: "invalidParams" });
const notFound = (): HandlerResult => ({ ok: false, errorKey: "notFound" });
const internal = (): HandlerResult => ({ ok: false, errorKey: "internalError" });

function record(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Project MCP values into plain JSON before the app-server's outbound validator.
 * MCP tool schemas are normalized for the agent and carry non-enumerable symbol
 * stamps; this boundary deliberately copies only enumerable data properties.
 */
function projectWireJson(value: unknown, seen = new WeakSet<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "object") return undefined;
	if (seen.has(value)) return undefined;
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			const result: unknown[] = [];
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				const projected =
					descriptor?.enumerable && "value" in descriptor ? projectWireJson(descriptor.value, seen) : undefined;
				result.push(projected === undefined ? null : projected);
			}
			return result;
		}
		const result: RecordValue = {};
		for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
			if (!descriptor.enumerable || !("value" in descriptor)) continue;
			const projected = projectWireJson(descriptor.value, seen);
			if (projected !== undefined)
				Object.defineProperty(result, key, {
					value: projected,
					enumerable: true,
					writable: true,
					configurable: true,
				});
		}
		return result;
	} finally {
		seen.delete(value);
	}
}

function projectWireObject(value: RecordValue): RecordValue {
	const projected = projectWireJson(value);
	return record(projected) ? projected : {};
}

function service(context?: HandlerContext): McpAppServerService | undefined {
	return context?.mcpService;
}

function manager(context?: HandlerContext): MCPManager | undefined {
	return service(context)?.manager ?? context?.mcpManager;
}

function connection(name: unknown, context?: HandlerContext): MCPServerConnection | undefined {
	if (typeof name !== "string" || name.length === 0) return undefined;
	return manager(context)?.getConnection(name);
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
	if (!mcp) return { ok: true, result: projectWireObject({ data: [] }) };

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
	return { ok: true, result: projectWireObject(result) };
};

/** Reload configured MCP servers through the runtime-owned lifecycle service. */
export const mcpServerReloadHandler: MethodHandler = async (params, context) => {
	if (params !== undefined && params !== null && !record(params)) return invalid();
	try {
		const mcpService = service(context);
		if (mcpService) {
			await mcpService.reload(context?.refreshMcpTools, context?.assertMcpReloadAllowed);
			return { ok: true, result: {} };
		}
		const mcp = manager(context);
		if (!mcp) return notFound();
		await reloadMcpRuntime(mcp, context?.refreshMcpTools, context?.assertMcpReloadAllowed);
		return { ok: true, result: {} };
	} catch (error) {
		if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "busy") {
			return { ok: false, errorKey: "busy" };
		}
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
		return { ok: true, result: projectWireJson(result) };
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
		return result === undefined ? notFound() : { ok: true, result: projectWireJson(result) };
	} catch {
		return internal();
	}
};

/** Start the runtime-owned MCP OAuth flow and return its real authorization URL. */
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
	const mcpService = service(context);
	if (!mcpService) return notFound();
	try {
		const result = await mcpService.oauthLogin({
			name,
			scopes,
			timeoutSecs,
			signal: context?.signal,
			onCompletion: completion => {
				context?.emitTo?.(context.connectionId ?? "", "mcpServer/oauthLogin/completed", {
					name,
					...(threadId ? { threadId } : {}),
					success: completion.success,
					...(completion.error ? { error: completion.error } : {}),
				});
			},
		});
		return { ok: true, result };
	} catch (error) {
		if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "busy")
			return { ok: false, errorKey: "busy" };
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("not connected")) return notFound();
		if (message.includes("unavailable") || message.includes("invalid")) return invalid();
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
