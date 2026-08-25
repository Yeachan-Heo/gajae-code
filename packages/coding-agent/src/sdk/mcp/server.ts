import { getAgentDir } from "@gajae-code/utils";
import { ensureBroker } from "../broker/ensure";
import { lifecycleRequestTimeoutMs } from "../broker/startup-budget";
import { SdkClientError } from "../client/client";
import { createBrokerSessionLifecycleService } from "../lifecycle/broker-client";
import type {
	SessionLifecycleMutationRequest,
	SessionLifecycleOperation,
	SessionLifecycleService,
} from "../lifecycle/service";
import { validateAdapterControl, validateAdapterSecretFields } from "../protocol/adapter-validation";
import { adapterDispositionError, findOperation } from "../protocol/operation-registry";
import { type SessionAttachment, SessionRouter, SessionRouterError } from "../router";
import { SessionListTraversalError, sessionListPageFromResponse, traverseSessionList } from "../session-list";

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
	agentDir?: string;
	router?: SessionRouter;
	lifecycleService?: SessionLifecycleService;
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
						idempotencyKey: {
							type: "string",
							description: "Bounded idempotency key; required for turn.abort mode:terminal.",
						},
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
	if (error instanceof SessionRouterError) return { ok: false, error: { code: error.phase, message: error.message } };
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

const MCP_LIFECYCLE_ACTOR = { id: "gjc-sdk-mcp", namespace: "sdk:mcp" } as const;
const ROUTER_START_TIMEOUT_MS = 3_000;
const ROUTER_STOP_TIMEOUT_MS = 5_000;
type LifecycleMutationOperation = Exclude<SessionLifecycleOperation, "session.list">;

function isLifecycleOperation(operation: string): operation is LifecycleMutationOperation {
	return (
		operation === "session.create" ||
		operation === "session.fork" ||
		operation === "session.resume" ||
		operation === "session.close" ||
		operation === "session.delete" ||
		operation === "session.reconcile_uncertain"
	);
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = Promise.withResolvers<never>();
	try {
		timer = setTimeout(() => timeout.reject(new SdkClientError("timeout", message)), timeoutMs);
		return await Promise.race([promise, timeout.promise]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

class McpSessionListBrokerResponseError extends Error {
	readonly #response: Arguments;

	constructor(response: Arguments) {
		super("session.list failed");
		this.name = "McpSessionListBrokerResponseError";
		this.#response = response;
	}

	get response(): Arguments {
		return this.#response;
	}
}

async function paginatedSessionList(
	router: SessionRouter,
	input: Arguments = {},
	requestKey = `${MCP_LIFECYCLE_ACTOR.namespace}:session.list`,
): Promise<unknown> {
	try {
		const pages = await traverseSessionList(
			input,
			async pageInput => {
				const rawResponse = await router.listBrokerSessions(pageInput, requestKey);
				const response = isObject(rawResponse) ? rawResponse : undefined;
				if (response?.ok === false) throw new McpSessionListBrokerResponseError(response);
				return response;
			},
			response => sessionListPageFromResponse(response),
		);
		const aggregate: Arguments = {};
		const sessions: unknown[] = [];
		for (const { page } of pages) {
			for (const [key, value] of Object.entries(page))
				if (key !== "sessions" && key !== "continuationCursor") aggregate[key] = value;
			sessions.push(...page.sessions);
		}
		const result = { ...aggregate, sessions };
		const firstResponse = pages[0]?.response;
		return firstResponse && Object.hasOwn(firstResponse, "result") ? { ...firstResponse, result } : result;
	} catch (error) {
		if (error instanceof McpSessionListBrokerResponseError) return error.response;
		if (error instanceof SessionListTraversalError)
			return { ok: false, error: { code: "protocol_error", message: error.message } };
		throw error;
	}
}

function textResult(
	payload: unknown,
	isError: boolean,
): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
	return { content: [{ type: "text", text: JSON.stringify(payload) }], isError };
}

/** Creates the model-facing MCP adapter with Router-owned live session authority. */
export function createSdkMcpServer(options: SdkMcpServerOptions = {}) {
	const agentDir = options.agentDir ?? getAgentDir();
	const router = options.router ?? new SessionRouter({ agentDir });
	const lifecycleService = options.lifecycleService ?? createBrokerSessionLifecycleService(agentDir);
	let startPromise: Promise<void> | undefined;
	let closePromise: Promise<void> | undefined;
	async function start(): Promise<void> {
		if (closePromise) throw new SdkClientError("connection_closed", "SDK MCP server is closed.");
		if (!startPromise) {
			const authoritative = router.start();
			let tracked!: Promise<void>;
			tracked = authoritative.catch(error => {
				if (startPromise === tracked) startPromise = undefined;
				throw error;
			});
			startPromise = tracked;
		}
		await bounded(startPromise, ROUTER_START_TIMEOUT_MS, "SDK session Router startup timed out.");
	}

	async function close(): Promise<void> {
		closePromise ??= (async () => {
			await bounded(router.stop(), ROUTER_STOP_TIMEOUT_MS, "SDK session Router shutdown timed out.");
		})();
		await closePromise;
	}

	async function withSession(sessionId: string, frame: Record<string, unknown>): Promise<unknown> {
		try {
			await start();
			const attachment: SessionAttachment | null = router.attachment(sessionId);
			if (!attachment)
				return { ok: false, error: { code: "not_found", message: `SDK session not found: ${sessionId}` } };
			return await router.request(sessionId, frame, attachment.generation, attachment);
		} catch (error) {
			return resultError(error);
		}
	}

	async function runLifecycle(
		operation: LifecycleMutationOperation,
		input: Arguments,
		requestKey: string,
	): Promise<unknown> {
		const timeoutMs = lifecycleRequestTimeoutMs(operation, input);
		return await lifecycleService.execute({
			operation,
			actor: MCP_LIFECYCLE_ACTOR,
			capability: operation,
			requestKey,
			target: input,
			...(timeoutMs === undefined ? {} : { timeoutMs }),
		} as unknown as SessionLifecycleMutationRequest);
	}

	async function callTool(name: string, args: Arguments = {}): Promise<unknown> {
		if (name === "gjc_session_list") {
			try {
				await ensureBroker({ agentDir });
				await start();
				return await paginatedSessionList(router);
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
			const idempotencyKey =
				args.idempotencyKey === undefined ? undefined : (asString(args, "idempotencyKey") ?? undefined);
			if (args.idempotencyKey !== undefined && !idempotencyKey)
				return {
					ok: false,
					error: { code: "invalid_input", message: "idempotencyKey must be a non-empty string" },
				};
			// Forward the key on the control frame: terminal abort requires it,
			// and without it every {mode:"terminal"} control is rejected (review
			// thread P1).
			return await withSession(sessionId, {
				type: "control_request",
				operation,
				input,
				confirm: args.confirm === true,
				...(idempotencyKey === undefined ? {} : { idempotencyKey }),
			});
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
			return await withSession(sessionId, {
				type: "query_request",
				query,
				input,
				...(cursor === undefined ? {} : { cursor }),
			});
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
			try {
				if (operation === "session.list") {
					await ensureBroker({ agentDir });
					await start();
					return await paginatedSessionList(router, input);
				}
				if (!isLifecycleOperation(operation))
					return {
						ok: false,
						error: { code: "unknown_operation", message: `Unknown global operation: ${operation}` },
					};
				return await runLifecycle(operation, input, idempotencyKey!);
			} catch (error) {
				return resultError(error);
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

	return {
		callTool,
		handleJsonRpc,
		handle: handleJsonRpc,
		start,
		close,
		tools: SDK_MCP_TOOL_NAMES.map(schema),
	};
}

/**
 * Runs the SDK MCP server over stdio (newline-delimited JSON-RPC), the shipped
 * `gjc mcp-serve sdk` entrypoint. SessionRouter owns live endpoint authority and starts lazily
 * on the first live-session tool, then stops after stdin and in-flight requests drain.
 */
export async function runSdkMcpStdio(options: SdkMcpServerOptions = {}): Promise<void> {
	const server = createSdkMcpServer(options);
	let buffer = "";
	const inflight = new Set<Promise<void>>();
	try {
		process.stdin.setEncoding("utf8");

		const track = (work: Promise<void>): void => {
			inflight.add(work);
			void work.finally(() => inflight.delete(work));
		};

		const stdinDone = Promise.withResolvers<void>();
		{
			const onData = (chunk: string) => {
				buffer += chunk;
				let index = buffer.indexOf("\n");
				while (index >= 0) {
					const line = buffer.slice(0, index).trim();
					buffer = buffer.slice(index + 1);
					index = buffer.indexOf("\n");
					if (!line) continue;
					track(
						(async () => {
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
						})(),
					);
				}
			};
			const onEnd = () => {
				process.stdin.off("data", onData);
				process.stdin.off("end", onEnd);
				process.stdin.off("error", onError);
				stdinDone.resolve();
			};
			const onError = (error: Error) => {
				process.stdin.off("data", onData);
				process.stdin.off("end", onEnd);
				process.stdin.off("error", onError);
				stdinDone.reject(error);
			};
			process.stdin.on("data", onData);
			process.stdin.on("end", onEnd);
			process.stdin.on("error", onError);
		}
		await stdinDone.promise;

		// Stdin EOF must not drop in-flight tools/call handlers (WS connect/query).
		// Awaiting them also prevents the process from exiting before responses flush.
		await Promise.allSettled([...inflight]);
	} finally {
		await server.close();
	}
}
