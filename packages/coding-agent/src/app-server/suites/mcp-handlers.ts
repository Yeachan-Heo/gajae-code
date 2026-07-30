import { callTool, listResources, listResourceTemplates, listTools } from "../../runtime-mcp/client";
import { MCPManager } from "../../runtime-mcp/manager";
import type { MCPServerConnection } from "../../runtime-mcp/types";
import type { HandlerResult, MethodHandler } from "./handlers";

type RecordValue = Record<string, unknown>;

const invalid = (): HandlerResult => ({ ok: false, errorKey: "invalidParams" });
const notFound = (): HandlerResult => ({ ok: false, errorKey: "notFound" });
const internal = (): HandlerResult => ({ ok: false, errorKey: "internalError" });

function record(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function manager(): MCPManager | undefined {
	return MCPManager.instance();
}

function connection(name: unknown): MCPServerConnection | undefined {
	return typeof name === "string" && name.length > 0 ? manager()?.getConnection(name) : undefined;
}

function authStatus(conn: MCPServerConnection | undefined): "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth" {
	const auth = conn?.config.auth;
	if (!auth) return "unsupported";
	if (auth.type === "oauth") return "oAuth";
	return "bearerToken";
}

/** Project GJC's live MCP manager onto the pinned status response. */
export const mcpServerStatusListHandler: MethodHandler = async params => {
	if (!record(params)) return invalid();
	const cursor = params.cursor;
	const limit = params.limit;
	const detail = params.detail;
	if (cursor !== undefined && cursor !== null && typeof cursor !== "string") return invalid();
	if (limit !== undefined && limit !== null && (!Number.isInteger(limit) || (limit as number) < 0)) return invalid();
	if (detail !== undefined && detail !== null && detail !== "full" && detail !== "toolsAndAuthOnly") return invalid();
	const mcp = manager();
	if (!mcp) return { ok: true, result: { data: [] } };

	const names = mcp.getAllServerNames().sort();
	const start = cursor === undefined || cursor === null || cursor === "" ? 0 : Number.parseInt(cursor, 10);
	if (!Number.isInteger(start) || start < 0 || start > names.length) return invalid();
	const pageSize = limit === undefined || limit === null ? names.length : (limit as number);
	const selected = names.slice(start, start + pageSize);
	const data = await Promise.all(
		selected.map(async name => {
			const conn = mcp.getConnection(name);
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

/** Invoke a tool through GJC's connected MCP client. */
export const mcpServerToolCallHandler: MethodHandler = async params => {
	if (
		!record(params) ||
		typeof params.threadId !== "string" ||
		typeof params.server !== "string" ||
		typeof params.tool !== "string"
	)
		return invalid();
	const args = params.arguments;
	if (args !== undefined && !record(args)) return invalid();
	const conn = connection(params.server);
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
export const mcpServerResourceReadHandler: MethodHandler = async params => {
	if (!record(params) || typeof params.server !== "string" || typeof params.uri !== "string") return invalid();
	const mcp = manager();
	if (!mcp?.getConnection(params.server)) return notFound();
	try {
		const result = await mcp.readServerResource(params.server, params.uri);
		return result === undefined ? notFound() : { ok: true, result };
	} catch {
		return internal();
	}
};

export const mcpHandlers: Record<string, MethodHandler> = {
	"mcpServerStatus/list": mcpServerStatusListHandler,
	"mcpServer/tool/call": mcpServerToolCallHandler,
	"mcpServer/resource/read": mcpServerResourceReadHandler,
};
