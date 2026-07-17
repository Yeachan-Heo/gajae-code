import path from "node:path";
import { getAgentDir } from "@gajae-code/utils";
import { ensureBroker } from "../broker/ensure";
import { SdkClient, SdkClientError } from "../client/client";
import {
	listSdkSessionEndpoints,
	readSdkBrokerDiscovery,
	readSdkSessionEndpoint,
	SdkDiscoveryError,
} from "../client/discovery";
import { validateAdapterControl, validateAdapterSecretFields } from "../protocol/adapter-validation";
import { adapterDispositionError, findOperation } from "../protocol/operation-registry";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "gjc-sdk-mcp";
const ENDPOINT_CREDENTIAL_OPERATION = "session.get_endpoint";

type Arguments = Record<string, unknown>;
type JsonRpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: unknown };
type JsonRpcResponse = {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string };
};

export interface SdkMcpServerOptions {
	repo?: string;
	agentDir?: string;
	connect?: (url: string, token: string) => Promise<SdkClient>;
}

export const SDK_MCP_TOOL_NAMES = [
	"gjc_session_control",
	"gjc_session_query",
	"gjc_session_global",
	"gjc_session_list",
] as const;

function schema(name: (typeof SDK_MCP_TOOL_NAMES)[number]): Record<string, unknown> {
	const common = { type: "object", additionalProperties: false };
	switch (name) {
		case "gjc_session_control":
			return {
				name,
				description: "Run a typed SDK control operation for one session.",
				inputSchema: {
					...common,
					required: ["sessionId", "operation"],
					properties: {
						sessionId: { type: "string" },
						operation: { type: "string" },
						input: { type: "object" },
						confirm: { type: "boolean", description: "Required for destructive controls." },
					},
				},
			};
		case "gjc_session_query":
			return {
				name,
				description: "Run a typed SDK query for one session.",
				inputSchema: {
					...common,
					required: ["sessionId", "query"],
					properties: {
						sessionId: { type: "string" },
						query: { type: "string" },
						input: { type: "object" },
						cursor: { type: "string" },
					},
				},
			};
		case "gjc_session_global":
			return {
				name,
				description: "Run a typed agent-global SDK broker operation.",
				inputSchema: {
					...common,
					required: ["operation"],
					properties: {
						operation: { type: "string" },
						input: { type: "object" },
						idempotencyKey: {
							type: "string",
							description:
								"Required for session.create, session.fork, session.resume, session.close, and session.delete.",
						},
					},
				},
			};
		case "gjc_session_list":
			return {
				name,
				description: "List locally discoverable SDK session IDs.",
				inputSchema: { ...common, properties: {} },
			};
	}
}

function isObject(value: unknown): value is Arguments {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(args: Arguments, name: string): string | null {
	return typeof args[name] === "string" && args[name] ? (args[name] as string) : null;
}

function resultError(error: unknown): { ok: false; error: { code: string; message: string; path?: string } } {
	if (error instanceof SdkDiscoveryError)
		return { ok: false, error: { code: error.code, path: path.basename(error.path), message: error.message } };
	if (error instanceof SdkClientError) return { ok: false, error: { code: error.code, message: error.message } };
	return {
		ok: false,
		error: { code: "unavailable", message: error instanceof Error ? error.message : "SDK request failed" },
	};
}

function endpointCredentialForbidden(): {
	ok: false;
	error: { code: "endpoint_credential_forbidden"; message: string };
} {
	return {
		ok: false,
		error: { code: "endpoint_credential_forbidden", message: "session.get_endpoint is not available through MCP" },
	};
}

function invalidControl(error: { code: string; message: string }): {
	ok: false;
	error: { code: string; message: string };
} {
	return { ok: false, error };
}

function mcpOperationError(
	kind: "control" | "global" | "query",
	operation: string,
): { code: string; message: string } | undefined {
	const row = findOperation(kind, operation);
	if (!row) return adapterDispositionError("mcp", kind, operation, true);
	if (kind === "global" && operation === ENDPOINT_CREDENTIAL_OPERATION) return endpointCredentialForbidden().error;
	return adapterDispositionError("mcp", kind, operation, true);
}

function isLifecycleOperation(operation: string): boolean {
	return (
		operation === "session.create" ||
		operation === "session.fork" ||
		operation === "session.resume" ||
		operation === "session.close" ||
		operation === "session.delete"
	);
}
function redactLifecycleCredentials(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactLifecycleCredentials);
	if (!isObject(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "endpoint" && key !== "token")
			.map(([key, nested]) => [key, redactLifecycleCredentials(nested)]),
	);
}

function textResult(
	payload: unknown,
	isError: boolean,
): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
	return { content: [{ type: "text", text: JSON.stringify(payload) }], isError };
}

/** Creates the model-facing MCP adapter using only SDK discovery records and v3 WebSockets. */
export function createSdkMcpServer(options: SdkMcpServerOptions = {}) {
	const repo = options.repo ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const connect = options.connect ?? ((url, token) => SdkClient.connect(url, token));

	async function withSession(sessionId: string, action: (client: SdkClient) => Promise<unknown>): Promise<unknown> {
		let client: SdkClient | undefined;
		try {
			const endpoint = await readSdkSessionEndpoint(repo, sessionId);
			if (!endpoint)
				return { ok: false, error: { code: "not_found", message: `SDK session not found: ${sessionId}` } };
			client = await connect(endpoint.url, endpoint.token);
			return await action(client);
		} catch (error) {
			return resultError(error);
		} finally {
			await client?.close();
		}
	}

	async function callTool(name: string, args: Arguments = {}): Promise<unknown> {
		if (name === "gjc_session_list") {
			try {
				const { endpoints, warnings } = await listSdkSessionEndpoints(repo);
				return { ok: true, sessions: endpoints.map(({ sessionId }) => ({ sessionId })), warnings };
			} catch (error) {
				return resultError(error);
			}
		}
		if (name === "gjc_session_control") {
			const sessionId = asString(args, "sessionId");
			const operation = asString(args, "operation");
			if (!sessionId || !operation)
				return { ok: false, error: { code: "invalid_input", message: "sessionId and operation are required" } };
			const input = isObject(args.input) ? args.input : {};
			const dispositionError = mcpOperationError("control", operation);
			if (dispositionError) return invalidControl(dispositionError);
			const secretError = validateAdapterSecretFields(operation, input);
			if (secretError) return invalidControl(secretError);
			const invalid = validateAdapterControl(operation, input);
			if (invalid) return invalidControl(invalid);
			return await withSession(sessionId, client =>
				client.control(operation, input, { confirm: args.confirm === true }),
			);
		}
		if (name === "gjc_session_query") {
			const sessionId = asString(args, "sessionId");
			const query = asString(args, "query");
			if (!sessionId || !query)
				return { ok: false, error: { code: "invalid_input", message: "sessionId and query are required" } };
			const cursor = args.cursor === undefined ? undefined : asString(args, "cursor");
			if (args.cursor !== undefined && cursor === null)
				return { ok: false, error: { code: "invalid_input", message: "cursor must be a string" } };
			const input = isObject(args.input) ? args.input : {};
			const dispositionError = mcpOperationError("query", query);
			if (dispositionError) return invalidControl(dispositionError);
			return await withSession(sessionId, client => client.query(query, input, cursor ?? undefined));
		}
		if (name === "gjc_session_global") {
			const operation = asString(args, "operation");
			if (!operation) return { ok: false, error: { code: "invalid_input", message: "operation is required" } };
			const input = isObject(args.input) ? args.input : {};
			const dispositionError = mcpOperationError("global", operation);
			if (dispositionError) return invalidControl(dispositionError);
			const secretError = validateAdapterSecretFields(operation, input);
			if (secretError) return invalidControl(secretError);
			const idempotencyKey =
				args.idempotencyKey === undefined ? undefined : (asString(args, "idempotencyKey") ?? undefined);
			if (args.idempotencyKey !== undefined && !idempotencyKey)
				return {
					ok: false,
					error: { code: "invalid_input", message: "idempotencyKey must be a non-empty string" },
				};
			if (isLifecycleOperation(operation) && !idempotencyKey)
				return {
					ok: false,
					error: { code: "invalid_input", message: "idempotencyKey is required for lifecycle operations" },
				};
			let client: SdkClient | undefined;
			try {
				await ensureBroker({ agentDir });
				const broker = await readSdkBrokerDiscovery(agentDir);
				if (!broker) return { ok: false, error: { code: "not_found", message: "SDK broker not found" } };
				client = await connect(broker.url, broker.token);
				const response = await client.global(operation, input, { idempotencyKey });
				return isLifecycleOperation(operation) ? redactLifecycleCredentials(response) : response;
			} catch (error) {
				return resultError(error);
			} finally {
				await client?.close();
			}
		}
		return { ok: false, error: { code: "unknown_tool", message: `Unknown SDK MCP tool: ${name}` } };
	}

	async function handleJsonRpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
		const id = request.id ?? null;
		if (request.method === "initialize")
			return {
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: SERVER_NAME },
				},
			};
		if (request.method === "tools/list")
			return { jsonrpc: "2.0", id, result: { tools: SDK_MCP_TOOL_NAMES.map(schema) } };
		if (request.method === "tools/call") {
			const params = isObject(request.params) ? request.params : {};
			const payload = await callTool(
				typeof params.name === "string" ? params.name : "",
				isObject(params.arguments) ? params.arguments : {},
			);
			const failed = isObject(payload) && payload.ok === false;
			return { jsonrpc: "2.0", id, result: textResult(payload, failed) };
		}
		return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown_method:${request.method}` } };
	}

	return { callTool, handleJsonRpc, handle: handleJsonRpc, tools: SDK_MCP_TOOL_NAMES.map(schema) };
}

/**
 * Runs the SDK MCP server over stdio (newline-delimited JSON-RPC), the shipped
 * `gjc mcp-serve sdk` entrypoint. Pure SDK client: session control/query flows
 * through discovery records and v3 WebSockets only.
 */
export async function runSdkMcpStdio(options: SdkMcpServerOptions = {}): Promise<void> {
	const server = createSdkMcpServer(options);
	let buffer = "";
	process.stdin.setEncoding("utf8");
	await new Promise<void>(resolve => {
		process.stdin.on("data", (chunk: string) => {
			buffer += chunk;
			let index = buffer.indexOf("\n");
			while (index >= 0) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf("\n");
				if (!line) continue;
				void (async () => {
					let request: JsonRpcRequest;
					try {
						request = JSON.parse(line) as JsonRpcRequest;
					} catch {
						process.stdout.write(
							`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse_error" } })}\n`,
						);
						return;
					}
					const response = await server.handleJsonRpc(request);
					// JSON-RPC notifications (no id) receive no response.
					if (request.id !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
				})();
			}
		});
		process.stdin.on("end", () => resolve());
	});
}
