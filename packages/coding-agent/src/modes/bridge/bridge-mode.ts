import * as path from "node:path";
import type { ExtensionUIContext } from "../../extensibility/extensions";
import type { AgentSession } from "../../session/agent-session";
import type { ClientBridgePermissionOutcome } from "../../session/client-bridge";
import type { RpcCommand, RpcResponse, RpcWorkflowGateResponse } from "../rpc/rpc-types";
import { dispatchRpcCommand } from "../shared/agent-wire/command-dispatch";
import { isRpcCommand } from "../shared/agent-wire/command-validation";
import {
	BridgeFrameSequencer,
	toBridgeEventFrame,
	toBridgeWorkflowGateFrame,
} from "../shared/agent-wire/event-envelope";
import type { BridgeCapability } from "../shared/agent-wire/handshake";
import {
	type BridgeHandshakeRequest,
	isBridgeHandshakeRequest,
	negotiateBridgeHandshake,
} from "../shared/agent-wire/handshake";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "../shared/agent-wire/host-tool-bridge";
import { isRpcHostUriResult, RpcHostUriBridge } from "../shared/agent-wire/host-uri-bridge";
import type { BridgeFrameType } from "../shared/agent-wire/protocol";
import {
	BRIDGE_COMMAND_SCOPES,
	type BridgeCommandScope,
	isRpcCommandAllowed,
	isRpcCommandType,
	scopeForRpcCommand,
} from "../shared/agent-wire/scopes";
import { UiRequestBroker } from "../shared/agent-wire/ui-request-broker";
import type { BridgeUiResult } from "../shared/agent-wire/ui-result";
import { defaultAuditPath, UnattendedAuditLog } from "../shared/agent-wire/unattended-audit";
import { modelSupportsTokenCostMetrics, UnattendedSessionControlPlane } from "../shared/agent-wire/unattended-session";
import { FileGateStore } from "../shared/agent-wire/workflow-gate-broker";
import { assertSafeBridgeBind, isBridgeTokenAuthorized } from "./auth";
import { type BridgePermissionRequestPayload, createBridgeClientBridge } from "./bridge-client-bridge";
import { BridgeExtensionUIContext, type BridgeUiRequestPayload } from "./bridge-ui-context";
import { BridgeEventStream } from "./event-stream";

const DEFAULT_BRIDGE_HOST = "127.0.0.1";
const DEFAULT_BRIDGE_PORT = 4077;

const SERVER_CAPABILITIES: readonly BridgeCapability[] = [
	"events",
	"prompt",
	"permission",
	"elicitation",
	"ui.declarative",
	"host_tools",
	"host_uri",
	"workflow_gate",
];

const DEFAULT_BRIDGE_SCOPES: readonly BridgeCommandScope[] = ["prompt"];
interface BridgeEndpointMatrix {
	events: boolean;
	commands: boolean;
	control: boolean;
	uiResponses: boolean;
	hostToolResults: boolean;
	hostUriResults: boolean;
}

const FAIL_CLOSED_BRIDGE_ENDPOINTS: BridgeEndpointMatrix = {
	events: false,
	commands: false,
	control: false,
	uiResponses: false,
	hostToolResults: false,
	hostUriResults: false,
};

const MAX_IDEMPOTENCY_RECORDS = 1_000;

const SERVER_FRAME_TYPES: readonly BridgeFrameType[] = [
	"ready",
	"event",
	"response",
	"ui_request",
	"permission_request",
	"host_tool_call",
	"host_uri_request",
	"reset",
	"workflow_gate",
	"error",
];

interface BridgeFetchHandlerOptions {
	sessionId: string;
	token: string;
	eventStream?: BridgeEventStream;
	commandDispatcher?: (command: RpcCommand) => Promise<RpcResponse>;
	commandScopes?: readonly BridgeCommandScope[];
	idempotencyCache?: BridgeIdempotencyCache;
	permissionBroker?: UiRequestBroker<BridgePermissionRequestPayload, ClientBridgePermissionOutcome>;
	uiBroker?: UiRequestBroker<BridgeUiRequestPayload, BridgeUiResult<unknown>>;
	hostToolBridge?: RpcHostToolBridge;
	hostUriBridge?: RpcHostUriBridge;
	endpointMatrix?: Partial<BridgeEndpointMatrix>;
	unattendedControlPlane?: UnattendedSessionControlPlane;
}

interface BridgeIdempotencyRecord {
	route: string;
	ownerToken?: string;
	body: string | Promise<string>;
	response: unknown | Promise<unknown>;
	pending?: boolean;
}

type BridgeIdempotencyCache = Map<string, BridgeIdempotencyRecord>;

function idempotencyConflict(): Response {
	return jsonResponse(409, { error: "idempotency_conflict" });
}

function cachedIdempotencyResponse(
	cache: BridgeIdempotencyCache | undefined,
	key: string | undefined,
	record: Omit<BridgeIdempotencyRecord, "response">,
): Response | Promise<Response> | undefined {
	if (!key) return undefined;
	const cached = cache?.get(key);
	if (!cached) return undefined;
	return Promise.resolve(cached.body).then(body => {
		if (body !== record.body || cached.route !== record.route) return idempotencyConflict();
		if (cached.ownerToken !== record.ownerToken)
			return jsonResponse(403, { status: "rejected", code: "not_controller" });
		return Promise.resolve(cached.response).then(response => jsonResponse(200, response));
	});
}

function rememberIdempotencyResponse(
	cache: BridgeIdempotencyCache | undefined,
	key: string | undefined,
	record: BridgeIdempotencyRecord,
): void {
	if (!key) return;
	cache?.set(key, record);
	if (cache && cache.size > MAX_IDEMPOTENCY_RECORDS) {
		for (const [candidateKey, candidate] of cache) {
			if (!candidate.pending) {
				cache.delete(candidateKey);
				break;
			}
		}
	}
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function parseBridgeScopes(value: string | undefined): readonly BridgeCommandScope[] {
	if (!value?.trim()) return DEFAULT_BRIDGE_SCOPES;
	const allowed = new Set(BRIDGE_COMMAND_SCOPES);
	const scopes = new Set<BridgeCommandScope>(DEFAULT_BRIDGE_SCOPES);
	for (const raw of value.split(",")) {
		const scope = raw.trim();
		if (!scope) continue;
		if (!allowed.has(scope as BridgeCommandScope)) throw new Error(`Invalid GJC_BRIDGE_SCOPES entry: ${scope}`);
		scopes.add(scope as BridgeCommandScope);
	}
	return [...scopes];
}

function hasScope(scopes: readonly BridgeCommandScope[] | undefined, scope: BridgeCommandScope): boolean {
	return new Set(scopes ?? DEFAULT_BRIDGE_SCOPES).has(scope);
}
function bridgeEndpointMatrix(options: BridgeFetchHandlerOptions): BridgeEndpointMatrix {
	return { ...FAIL_CLOSED_BRIDGE_ENDPOINTS, ...options.endpointMatrix };
}

function disabledEndpointResponse(endpoint: keyof BridgeEndpointMatrix): Response {
	return jsonResponse(403, { error: "endpoint_disabled", endpoint });
}

function bridgeHelpResponse(matrix: BridgeEndpointMatrix): Response {
	return jsonResponse(200, {
		status: "experimental_gated",
		message: "Bridge mode is experimental; session-control endpoints fail closed by default.",
		endpoints: matrix,
	});
}

function auditOutcomeFor(event: string): "accepted" | "rejected" | "denied" | "exceeded" | "aborted" | "info" {
	if (event.includes("denied")) return "denied";
	if (event.includes("exceeded")) return "exceeded";
	if (event.includes("abort")) return "aborted";
	if (event.includes("rejected") || event.includes("conflict")) return "rejected";
	if (event.includes("accepted") || event.includes("negotiated") || event.includes("emitted")) return "accepted";
	return "info";
}

function frameTypeForDispatchOutput(obj: RpcResponse | object): BridgeFrameType {
	const type = typeof obj === "object" && obj !== null && "type" in obj ? (obj as { type?: unknown }).type : undefined;
	if (type === "host_tool_call" || type === "host_tool_cancel") return "host_tool_call";
	if (type === "host_uri_request" || type === "host_uri_cancel") return "host_uri_request";
	if (type === "extension_ui_request") return "ui_request";
	if (type === "response") return "response";
	return "response";
}

export function createBridgeFetchHandler(options: BridgeFetchHandlerOptions): (request: Request) => Promise<Response> {
	return async request => {
		const endpointMatrix = bridgeEndpointMatrix(options);
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/healthz") {
			return jsonResponse(200, { status: "ok" });
		}
		if (request.method === "GET" && url.pathname === "/v1/help") {
			return bridgeHelpResponse(endpointMatrix);
		}

		if (request.method === "GET" && url.pathname === `/v1/sessions/${options.sessionId}/events`) {
			if (!isBridgeTokenAuthorized(request.headers.get("Authorization"), { token: options.token })) {
				return jsonResponse(401, { error: "unauthorized" });
			}
			if (!endpointMatrix.events) return disabledEndpointResponse("events");
			const lastSeqRaw = url.searchParams.get("last_seq");
			if (lastSeqRaw !== null && !/^\d+$/.test(lastSeqRaw)) return jsonResponse(400, { error: "invalid_last_seq" });
			const lastSeq = lastSeqRaw === null ? 0 : Number.parseInt(lastSeqRaw, 10);
			return options.eventStream?.response(lastSeq) ?? jsonResponse(503, { error: "events_unavailable" });
		}

		if (!isBridgeTokenAuthorized(request.headers.get("Authorization"), { token: options.token })) {
			return jsonResponse(401, { error: "unauthorized" });
		}

		if (request.method === "POST" && url.pathname === "/v1/handshake") {
			let payload: BridgeHandshakeRequest;
			try {
				payload = (await request.json()) as BridgeHandshakeRequest;
			} catch {
				return jsonResponse(400, { error: "invalid_json" });
			}
			if (!isBridgeHandshakeRequest(payload)) {
				return jsonResponse(400, { error: "invalid_request" });
			}
			let acceptedUnattended = options.unattendedControlPlane?.isUnattended() ? payload.unattended : undefined;
			if (
				acceptedUnattended === undefined &&
				payload.unattended !== undefined &&
				endpointMatrix.events &&
				options.unattendedControlPlane
			) {
				try {
					options.unattendedControlPlane.negotiate(payload.unattended);
					acceptedUnattended = payload.unattended;
				} catch (err) {
					const error =
						err instanceof Error && "code" in err
							? { code: (err as { code: unknown }).code, message: err.message }
							: { error: err instanceof Error ? err.message : String(err) };
					return jsonResponse(403, error);
				}
			}
			return jsonResponse(
				200,
				negotiateBridgeHandshake(payload, {
					sessionId: options.sessionId,
					capabilities: endpointMatrix.events ? SERVER_CAPABILITIES : [],
					scopes: endpointMatrix.commands ? (options.commandScopes ?? DEFAULT_BRIDGE_SCOPES) : [],
					endpoints: {
						events: endpointMatrix.events ? `/v1/sessions/${options.sessionId}/events` : "",
						commands: endpointMatrix.commands ? `/v1/sessions/${options.sessionId}/commands` : "",
						uiResponses: endpointMatrix.uiResponses
							? `/v1/sessions/${options.sessionId}/ui-responses/{correlation_id}`
							: "",
						claimControl: endpointMatrix.control ? `/v1/sessions/${options.sessionId}/control:claim` : "",
						disconnectControl: endpointMatrix.control
							? `/v1/sessions/${options.sessionId}/control:disconnect`
							: "",
						hostToolResults: endpointMatrix.hostToolResults
							? `/v1/sessions/${options.sessionId}/host-tool-results/{correlation_id}`
							: "",
						hostUriResults: endpointMatrix.hostUriResults
							? `/v1/sessions/${options.sessionId}/host-uri-results/{correlation_id}`
							: "",
					},
					frameTypes: endpointMatrix.events ? SERVER_FRAME_TYPES : [],
					acceptedUnattended,
				}),
			);
		}

		if (request.method === "POST" && url.pathname === `/v1/sessions/${options.sessionId}/commands`) {
			if (!endpointMatrix.commands) return disabledEndpointResponse("commands");
			if (!options.commandDispatcher) return jsonResponse(503, { error: "commands_unavailable" });
			const idempotencyKey = request.headers.get("Idempotency-Key") ?? undefined;
			const existingRecord = idempotencyKey ? options.idempotencyCache?.get(idempotencyKey) : undefined;
			let body = "";
			let payload: unknown;
			let pendingResponse: PromiseWithResolvers<unknown> | undefined;
			try {
				if (existingRecord) {
					body = await request.text();
					const cached = cachedIdempotencyResponse(options.idempotencyCache, idempotencyKey, {
						route: url.pathname,
						body,
					});
					if (cached) return await cached;
				} else {
					const bodyPromise = request.text();
					pendingResponse = Promise.withResolvers<unknown>();
					void pendingResponse.promise.catch(() => undefined);
					rememberIdempotencyResponse(options.idempotencyCache, idempotencyKey, {
						route: url.pathname,
						body: bodyPromise,
						response: pendingResponse.promise,
						pending: true,
					});
					body = await bodyPromise;
				}
				payload = JSON.parse(body) as unknown;
			} catch {
				options.idempotencyCache?.delete(idempotencyKey ?? "");
				pendingResponse?.reject(new Error("invalid_json"));
				return jsonResponse(400, { error: "invalid_json" });
			}
			const type =
				typeof payload === "object" && payload !== null && "type" in payload
					? (payload as { type?: unknown }).type
					: undefined;
			if (!isRpcCommandType(type)) {
				options.idempotencyCache?.delete(idempotencyKey ?? "");
				pendingResponse?.reject(new Error("invalid_command"));
				return jsonResponse(400, { error: "invalid_command" });
			}
			if (!isRpcCommand(payload)) {
				options.idempotencyCache?.delete(idempotencyKey ?? "");
				pendingResponse?.reject(new Error("invalid_command"));
				return jsonResponse(400, { error: "invalid_command" });
			}
			const scopes = new Set(options.commandScopes ?? DEFAULT_BRIDGE_SCOPES);
			if (!isRpcCommandAllowed(type, scopes)) {
				options.idempotencyCache?.delete(idempotencyKey ?? "");
				pendingResponse?.reject(new Error("scope_denied"));
				return jsonResponse(403, { error: "scope_denied", scope: scopeForRpcCommand(type) });
			}
			try {
				const response = await options.commandDispatcher(payload);
				pendingResponse?.resolve(response);
				const cachedRecord = idempotencyKey ? options.idempotencyCache?.get(idempotencyKey) : undefined;
				if (cachedRecord) cachedRecord.pending = false;
				return jsonResponse(200, response);
			} catch (err) {
				options.idempotencyCache?.delete(idempotencyKey ?? "");
				pendingResponse?.reject(err);
				throw err;
			}
		}
		if (request.method === "POST" && url.pathname === `/v1/sessions/${options.sessionId}/control:claim`) {
			if (!endpointMatrix.control) return disabledEndpointResponse("control");
			if (!hasScope(options.commandScopes, "control"))
				return jsonResponse(403, { error: "scope_denied", scope: "control" });
			if (options.permissionBroker?.ownerToken || options.uiBroker?.ownerToken)
				return jsonResponse(409, { error: "controller_busy" });
			const ownerToken = request.headers.get("X-GJC-Bridge-Owner-Token") ?? crypto.randomUUID();
			const permissionClaim = options.permissionBroker?.claimController(ownerToken);
			const uiClaim = options.uiBroker?.claimController(ownerToken);
			if (permissionClaim?.status === "busy" || uiClaim?.status === "busy")
				return jsonResponse(409, { error: "controller_busy" });
			return jsonResponse(200, { status: "claimed", ownerToken });
		}
		if (request.method === "POST" && url.pathname === `/v1/sessions/${options.sessionId}/control:disconnect`) {
			if (!endpointMatrix.control) return disabledEndpointResponse("control");
			if (!hasScope(options.commandScopes, "control"))
				return jsonResponse(403, { error: "scope_denied", scope: "control" });
			const ownerToken = request.headers.get("X-GJC-Bridge-Owner-Token") ?? "";
			const permissionReleased = options.permissionBroker?.disconnectController(ownerToken) ?? true;
			const uiReleased = options.uiBroker?.disconnectController(ownerToken) ?? true;
			return permissionReleased && uiReleased
				? jsonResponse(200, { status: "released" })
				: jsonResponse(403, { status: "rejected", code: "not_controller" });
		}

		const uiResponsePrefix = `/v1/sessions/${options.sessionId}/ui-responses/`;
		if (request.method === "POST" && url.pathname.startsWith(uiResponsePrefix)) {
			if (!endpointMatrix.uiResponses) return disabledEndpointResponse("uiResponses");
			if (!hasScope(options.commandScopes, "control"))
				return jsonResponse(403, { error: "scope_denied", scope: "control" });
			const correlationId = decodeURIComponent(url.pathname.slice(uiResponsePrefix.length));
			const ownerToken = request.headers.get("X-GJC-Bridge-Owner-Token") ?? "";
			const idempotencyKey = request.headers.get("Idempotency-Key") ?? undefined;
			let body = "";
			let payload: unknown;
			try {
				body = await request.text();
				const cached = cachedIdempotencyResponse(options.idempotencyCache, idempotencyKey, {
					route: url.pathname,
					ownerToken,
					body,
				});
				if (cached) return await cached;
				payload = JSON.parse(body) as unknown;
			} catch {
				return jsonResponse(400, { error: "invalid_json" });
			}
			if (
				payload !== null &&
				typeof payload === "object" &&
				"gate_id" in payload &&
				"answer" in payload &&
				(correlationId === (payload as RpcWorkflowGateResponse).gate_id || correlationId.startsWith("wg_"))
			) {
				try {
					const resolution = await options.unattendedControlPlane?.resolveGate({
						gate_id: (payload as RpcWorkflowGateResponse).gate_id,
						answer: (payload as RpcWorkflowGateResponse).answer,
						idempotency_key: (payload as RpcWorkflowGateResponse).idempotency_key ?? idempotencyKey,
					});
					if (resolution) {
						rememberIdempotencyResponse(options.idempotencyCache, idempotencyKey, {
							route: url.pathname,
							ownerToken,
							body,
							response: resolution,
						});
						return jsonResponse(200, resolution);
					}
				} catch (err) {
					const error =
						err instanceof Error && "code" in err
							? { code: (err as { code: unknown }).code, message: err.message }
							: { error: err instanceof Error ? err.message : String(err) };
					return jsonResponse(409, error);
				}
			}
			const permissionResult = options.permissionBroker?.respond(
				correlationId,
				ownerToken,
				payload as ClientBridgePermissionOutcome,
			);
			if (permissionResult?.status === "accepted") {
				rememberIdempotencyResponse(options.idempotencyCache, idempotencyKey, {
					route: url.pathname,
					ownerToken,
					body,
					response: permissionResult,
				});
				return jsonResponse(200, permissionResult);
			}
			const uiResult = options.uiBroker?.respond(correlationId, ownerToken, payload as BridgeUiResult<unknown>);
			if (uiResult?.status === "accepted") {
				rememberIdempotencyResponse(options.idempotencyCache, idempotencyKey, {
					route: url.pathname,
					ownerToken,
					body,
					response: uiResult,
				});
				return jsonResponse(200, uiResult);
			}
			const rejection = uiResult ?? permissionResult ?? { status: "rejected", code: "unknown_request" };
			return jsonResponse(
				rejection.status === "rejected" && rejection.code === "not_controller" ? 403 : 409,
				rejection,
			);
		}
		const hostToolResultPrefix = `/v1/sessions/${options.sessionId}/host-tool-results/`;
		if (request.method === "POST" && url.pathname.startsWith(hostToolResultPrefix)) {
			if (!endpointMatrix.hostToolResults) return disabledEndpointResponse("hostToolResults");
			if (!hasScope(options.commandScopes, "host_tools"))
				return jsonResponse(403, { error: "scope_denied", scope: "host_tools" });
			if (!options.hostToolBridge) return jsonResponse(503, { error: "host_tools_unavailable" });
			const id = decodeURIComponent(url.pathname.slice(hostToolResultPrefix.length));
			let payload: unknown;
			try {
				payload = await request.json();
			} catch {
				return jsonResponse(400, { error: "invalid_json" });
			}
			const frame = typeof payload === "object" && payload !== null ? { ...payload, id } : { id };
			let handled = false;
			if (isRpcHostToolUpdate(frame)) {
				handled = options.hostToolBridge.handleUpdate(frame);
			} else if (isRpcHostToolResult(frame)) {
				handled = options.hostToolBridge.handleResult(frame);
			} else {
				return jsonResponse(400, { error: "invalid_host_tool_result" });
			}
			return handled ? jsonResponse(200, { status: "accepted" }) : jsonResponse(404, { error: "unknown_request" });
		}

		const hostUriResultPrefix = `/v1/sessions/${options.sessionId}/host-uri-results/`;
		if (request.method === "POST" && url.pathname.startsWith(hostUriResultPrefix)) {
			if (!endpointMatrix.hostUriResults) return disabledEndpointResponse("hostUriResults");
			if (!hasScope(options.commandScopes, "host_uri"))
				return jsonResponse(403, { error: "scope_denied", scope: "host_uri" });
			if (!options.hostUriBridge) return jsonResponse(503, { error: "host_uri_unavailable" });
			const id = decodeURIComponent(url.pathname.slice(hostUriResultPrefix.length));
			let payload: unknown;
			try {
				payload = await request.json();
			} catch {
				return jsonResponse(400, { error: "invalid_json" });
			}
			const frame = typeof payload === "object" && payload !== null ? { ...payload, id } : { id };
			if (!isRpcHostUriResult(frame)) return jsonResponse(400, { error: "invalid_host_uri_result" });
			return options.hostUriBridge.handleResult(frame)
				? jsonResponse(200, { status: "accepted" })
				: jsonResponse(404, { error: "unknown_request" });
		}
		return jsonResponse(404, { error: "not_found" });
	};
}

export async function runBridgeMode(
	session: AgentSession,
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
): Promise<never> {
	const token = Bun.env.GJC_BRIDGE_TOKEN;
	if (!token) {
		throw new Error("GJC_BRIDGE_TOKEN is required for --mode bridge");
	}
	const hostname = Bun.env.GJC_BRIDGE_HOST ?? DEFAULT_BRIDGE_HOST;
	const port = Bun.env.GJC_BRIDGE_PORT ? Number.parseInt(Bun.env.GJC_BRIDGE_PORT, 10) : DEFAULT_BRIDGE_PORT;
	if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
		throw new Error(`Invalid GJC_BRIDGE_PORT: ${Bun.env.GJC_BRIDGE_PORT}`);
	}
	const commandScopes = parseBridgeScopes(Bun.env.GJC_BRIDGE_SCOPES);

	const certPath = Bun.env.GJC_BRIDGE_TLS_CERT;
	const keyPath = Bun.env.GJC_BRIDGE_TLS_KEY;
	const tlsConfigured = Boolean(certPath && keyPath);
	assertSafeBridgeBind({ hostname, port, tlsConfigured });

	const tls = tlsConfigured
		? {
				cert: await Bun.file(certPath!).text(),
				key: await Bun.file(keyPath!).text(),
			}
		: undefined;

	const eventStream = new BridgeEventStream();
	const sequencer = new BridgeFrameSequencer(session.sessionId);
	const permissionBroker = new UiRequestBroker<BridgePermissionRequestPayload, ClientBridgePermissionOutcome>({
		emitRequest: (correlationId, request) => {
			eventStream.publish(sequencer.next("permission_request", request, correlationId));
		},
	});
	const uiBroker = new UiRequestBroker<BridgeUiRequestPayload, BridgeUiResult<unknown>>({
		emitRequest: (correlationId, request) => {
			eventStream.publish(sequencer.next("ui_request", request, correlationId));
		},
	});
	const uiContext = new BridgeExtensionUIContext({
		broker: uiBroker,
		emit: payload => eventStream.publish(sequencer.next("ui_request", payload)),
	});
	setToolUIContext?.(uiContext, true);
	session.setClientBridge(createBridgeClientBridge(permissionBroker));
	session.subscribe(event => eventStream.publish(toBridgeEventFrame(event, sequencer)));
	const output = (obj: RpcResponse | object) => {
		eventStream.publish(sequencer.next(frameTypeForDispatchOutput(obj), obj));
	};
	const hostToolBridge = new RpcHostToolBridge(output);
	const hostUriBridge = new RpcHostUriBridge(output);
	const idempotencyCache: BridgeIdempotencyCache = new Map();
	const auditLog = new UnattendedAuditLog(defaultAuditPath(session.sessionId, session.sessionManager.getCwd()), {
		redactAnswers: true,
	});
	const recordAudit = (event: { event: string; [key: string]: unknown }) => {
		const payload =
			typeof event.payload === "object" && event.payload !== null
				? (event.payload as Record<string, unknown>)
				: undefined;
		const gateId =
			typeof event.gate_id === "string"
				? event.gate_id
				: typeof payload?.gate_id === "string"
					? payload.gate_id
					: undefined;
		auditLog.record({
			run_id: session.sessionId,
			session_id: session.sessionId,
			actor: typeof event.actor === "string" ? event.actor : undefined,
			event: event.event,
			outcome: auditOutcomeFor(event.event),
			dedupe_key: `${event.event}:${gateId ?? "run"}:${JSON.stringify(payload ?? event)}`,
			gate_id: gateId,
			stage: typeof event.stage === "string" ? (event.stage as never) : undefined,
			kind: typeof event.kind === "string" ? (event.kind as never) : undefined,
			scope: typeof payload?.scope === "string" ? payload.scope : undefined,
			action: typeof payload?.action === "string" ? payload.action : undefined,
			budget: event.event === "budget_exceeded" ? (payload as never) : undefined,
			answer_hash: typeof event.answer_hash === "string" ? event.answer_hash : undefined,
			error: payload && event.event.endsWith("denied") ? payload : undefined,
		});
	};
	const gateStore = new FileGateStore(
		path.join(session.sessionManager.getCwd(), ".gjc", "state", "workflow-gates", `${session.sessionId}.json`),
	);
	const unattendedControlPlane = new UnattendedSessionControlPlane({
		runId: session.sessionId,
		sessionId: session.sessionId,
		emitFrame: gate => eventStream.publish(toBridgeWorkflowGateFrame(gate, sequencer)),
		store: gateStore,
		audit: recordAudit,
		providerSupportsTokenCostMetrics: modelSupportsTokenCostMetrics(session.model),
		getUsageSnapshot: () => {
			const stats = session.getSessionStats();
			return { tokens: stats.tokens.total, costUsd: stats.cost };
		},
	});
	session.setWorkflowGateEmitter(unattendedControlPlane);
	unattendedControlPlane
		.recover()
		.catch(err =>
			eventStream.publish(sequencer.next("error", { error: err instanceof Error ? err.message : String(err) })),
		);

	Bun.serve({
		hostname,
		port,
		...(tls ? { tls } : {}),
		fetch: createBridgeFetchHandler({
			sessionId: session.sessionId,
			token,
			eventStream,
			idempotencyCache,
			permissionBroker,
			uiBroker,
			hostToolBridge,
			hostUriBridge,
			commandScopes,
			unattendedControlPlane,
			commandDispatcher: command =>
				dispatchRpcCommand(command, {
					session,
					output,
					hostToolRegistry: hostToolBridge,
					hostUriRegistry: hostUriBridge,
					createUiContext: () => uiContext,
					unattendedControlPlane,
				}),
		}),
	});

	return new Promise<never>(() => {});
}
