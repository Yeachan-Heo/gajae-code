// app-server inbound dispatch pipeline.

import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import packageMetadata from "../../package.json" with { type: "json" };
import { experimentalValidators, stableValidators } from "./protocol-source/schema-validators.generated";
import type { ConnectionState } from "./router/connection-state";
import { classifyInbound, dispatchClientRequest } from "./router/dispatch";
import type { ServerRequestBroker } from "./server-requests/broker";
import type { HandlerContext, HandlerRegistry } from "./suites/handlers";
import {
	type ChildBridgeOptions,
	type LoadedThreadRuntime,
	loadThread,
	projectThreadResponse,
} from "./thread-runtime/child-bridge";
import type { ThreadRuntimeManager } from "./thread-runtime/thread-runtime-manager";
import { type TurnController, TurnControllerError } from "./thread-runtime/turn-controller";
import { readAndReconstructTurns } from "./thread-runtime/turn-projection";
import { serializeError, serializeResult } from "./transport/errors";
import { decodeLine, encodeMessage, type FrameCodecOptions } from "./transport/framing";
import type { ListenMode } from "./transport/listen";

export interface AppServerOptions {
	readonly mode: ListenMode;
	readonly maxLoadedThreads?: number;
	readonly frameCodec?: FrameCodecOptions;
}

export interface InboundResult {
	readonly response?: Uint8Array;
	readonly notification?: boolean;
	readonly rollbackUndeliveredResponse?: () => Promise<void>;
	readonly responseDelivered?: () => Promise<void>;
	/** The frame was deliberately dropped without a wire response. */
	readonly rejected?: "malformed" | "oversize";
}

export interface InboundContext extends HandlerContext {
	readonly connectionId?: string;
	readonly isActive?: () => boolean;
	readonly broker?: ServerRequestBroker;
	readonly threadStartAdapter?: ChildBridgeOptions;
	readonly turnController?: TurnController;
	readonly unsubscribe?: (threadId: string) => void;
}

function isClientResponse(
	frame: Record<string, unknown>,
	id: string | number | undefined,
): frame is Record<string, unknown> & { id: string | number } {
	const hasResult = Object.hasOwn(frame, "result");
	const hasError = Object.hasOwn(frame, "error");
	return !Object.hasOwn(frame, "method") && id !== undefined && hasResult !== hasError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createUndeliveredResponseRollback(
	manager: ThreadRuntimeManager,
	context: InboundContext | undefined,
	runtime: LoadedThreadRuntime,
	unsubscribe = true,
): () => Promise<void> {
	let rollback: Promise<void> | undefined;
	return () => {
		rollback ??= (async () => {
			if (unsubscribe) {
				try {
					await context?.unsubscribe?.(runtime.threadId);
				} catch {
					// Connection teardown may already have removed the subscription.
				}
			}
			const managed = manager.get(runtime.threadId);
			if (!managed || managed.sessionId !== runtime.sessionId || managed.client !== runtime.client) return;
			if (managed.closeRuntime) {
				manager.remove(runtime.threadId, false);
				try {
					await managed.closeRuntime();
				} catch {
					// The identity-fenced runtime was removed and every close stage was attempted.
				}
			} else {
				manager.remove(runtime.threadId);
			}
		})();
		return rollback;
	};
}

function isErrorResponse(value: unknown): value is { code: number; message: string } {
	if (!isRecord(value)) return false;
	return (
		typeof value.code === "number" &&
		Number.isFinite(value.code) &&
		Number.isInteger(value.code) &&
		typeof value.message === "string"
	);
}

const turnStartUnsupportedOverrides = [
	"responsesapiClientMetadata",
	"additionalContext",
	"environments",
	"cwd",
	"runtimeWorkspaceRoots",
	"approvalPolicy",
	"approvalsReviewer",
	"sandbox",
	"sandboxPolicy",
	"permissions",
	"model",
	"serviceTier",
	"effort",
	"summary",
	"personality",
	"outputSchema",
	"collaborationMode",
	"multiAgentMode",
] as const;

const threadResumeOverrides = [
	"history",
	"path",
	"model",
	"modelProvider",
	"serviceTier",
	"cwd",
	"runtimeWorkspaceRoots",
	"approvalPolicy",
	"approvalsReviewer",
	"sandbox",
	"permissions",
	"config",
	"baseInstructions",
	"developerInstructions",
	"personality",
	"excludeTurns",
	"initialTurnsPage",
] as const;

function hasNonNullProperty(record: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(record, key) && record[key] !== undefined && record[key] !== null;
}

function supportsTurnStart(params: Record<string, unknown>): boolean {
	if (turnStartUnsupportedOverrides.some(key => hasNonNullProperty(params, key))) return false;
	if (!Array.isArray(params.input) || params.input.length === 0) return false;
	return params.input.every(item => {
		if (!isRecord(item) || item.type !== "text") return false;
		return typeof item.text === "string" && item.text.trim().length > 0;
	});
}

function supportsThreadResume(params: Record<string, unknown>): boolean {
	return !threadResumeOverrides.some(key => hasNonNullProperty(params, key));
}

function turnControllerCode(error: unknown): string | undefined {
	if (error instanceof TurnControllerError) return error.code;
	if (isRecord(error) && typeof error.code === "string") return error.code;
	return undefined;
}

function turnControllerErrorKey(error: unknown): "busy" | "idempotencyConflict" | "internalError" {
	switch (turnControllerCode(error)) {
		case "busy":
			return "busy";
		case "idempotency_conflict":
			return "idempotencyConflict";
		default:
			return "internalError";
	}
}

function createResponseDelivery(context: InboundContext | undefined, threadId: string): () => Promise<void> {
	let delivery: Promise<void> | undefined;
	return () => {
		delivery ??= Promise.resolve().then(async () => {
			await context?.subscribe?.(threadId);
		});
		return delivery;
	};
}

function createLoadedResumeRollback(context: InboundContext | undefined, threadId: string): () => Promise<void> {
	let rollback: Promise<void> | undefined;
	return () => {
		rollback ??= Promise.resolve().then(async () => {
			try {
				await context?.unsubscribe?.(threadId);
			} catch {
				// Connection teardown may already have removed the subscription.
			}
		});
		return rollback;
	};
}

async function handleTurnStart(
	state: ConnectionState,
	manager: ThreadRuntimeManager,
	id: string | number,
	params: unknown,
	transport: "stdio" | "websocket" | "unix",
	context: InboundContext | undefined,
): Promise<InboundResult> {
	const controller = context?.turnController;
	if (!controller) return { response: serializeError(id, "notSupported", transport) ?? undefined };
	if (!isRecord(params)) return { response: serializeError(id, "notSupported", transport) ?? undefined };
	const threadId = params.threadId;
	if (typeof threadId !== "string" || threadId.length === 0)
		return { response: serializeError(id, "notFound", transport) ?? undefined };
	const managed = manager.get(threadId);
	if (managed?.lifecycle !== "active" || !managed.client)
		return { response: serializeError(id, "notFound", transport) ?? undefined };
	if (!supportsTurnStart(params)) return { response: serializeError(id, "notSupported", transport) ?? undefined };

	let rollbackUndelivered: (() => Promise<void>) | undefined;
	try {
		const candidate: unknown = await controller.start({ threadId, params });
		if (!isRecord(candidate) || !isRecord(candidate.response))
			throw new Error("Turn controller returned a malformed start handle.");
		if (typeof candidate.responseDelivered !== "function" || typeof candidate.rollbackUndelivered !== "function")
			throw new Error("Turn controller returned an incomplete start handle.");
		const responseDelivered = candidate.responseDelivered as () => Promise<void>;
		rollbackUndelivered = candidate.rollbackUndelivered as () => Promise<void>;
		const validators = state.capabilities?.experimentalApi ? experimentalValidators : stableValidators;
		const validate = validators.clientRequestResults["turn/start"];
		if (!validate?.(candidate.response)) throw new Error("Turn controller returned an invalid response.");
		const response = serializeResult(id, candidate.response, transport);
		if (!response) throw new Error("Turn response could not be serialized.");
		return { response, responseDelivered, rollbackUndeliveredResponse: rollbackUndelivered };
	} catch (error) {
		if (rollbackUndelivered) {
			try {
				await rollbackUndelivered();
			} catch {
				// Preserve the original controller or validation failure.
			}
		}
		return { response: serializeError(id, turnControllerErrorKey(error), transport) ?? undefined };
	}
}

async function handleThreadResume(
	state: ConnectionState,
	manager: ThreadRuntimeManager,
	id: string | number,
	params: unknown,
	transport: "stdio" | "websocket" | "unix",
	context: InboundContext | undefined,
	threadStartBridge: ChildBridgeOptions | undefined,
): Promise<InboundResult> {
	if (!isRecord(params)) return { response: serializeError(id, "notSupported", transport) ?? undefined };
	const threadId = params.threadId;
	if (typeof threadId !== "string" || threadId.length === 0)
		return { response: serializeError(id, "notFound", transport) ?? undefined };
	if (!supportsThreadResume(params)) return { response: serializeError(id, "notSupported", transport) ?? undefined };

	const experimentalApi = state.capabilities?.experimentalApi === true;
	const loaded = manager.get(threadId);
	if (loaded?.lifecycle === "active" && loaded.client) {
		if (!loaded.effectiveSettings) return { response: serializeError(id, "internalError", transport) ?? undefined };
		try {
			const cwd = loaded.effectiveSettings.cwd;
			const turns = await readAndReconstructTurns(loaded.client);
			const response = projectThreadResponse(
				{ sessionId: loaded.sessionId, cwd, effectiveSettings: loaded.effectiveSettings },
				experimentalApi,
				turns,
				"thread/resume",
			);
			const validators = experimentalApi ? experimentalValidators : stableValidators;
			if (!validators.clientRequestResults["thread/resume"]?.(response))
				throw new Error("Invalid thread/resume response.");
			const serialized = serializeResult(id, response, transport);
			if (!serialized) throw new Error("Thread resume response could not be serialized.");
			if (context?.isActive && !context.isActive()) throw new Error("Requester connection is inactive.");
			return {
				response: serialized,
				responseDelivered: createResponseDelivery(context, threadId),
				rollbackUndeliveredResponse: createLoadedResumeRollback(context, threadId),
			};
		} catch {
			return { response: serializeError(id, "internalError", transport) ?? undefined };
		}
	}
	if (loaded) return { response: serializeError(id, "notFound", transport) ?? undefined };

	if (typeof threadStartBridge?.create !== "function")
		return { response: serializeError(id, "notSupported", transport) ?? undefined };
	const resumeBridge: ChildBridgeOptions = {
		...threadStartBridge,
		manager,
		subscribe: undefined,
		unsubscribe: undefined,
	};
	let runtime: LoadedThreadRuntime | undefined;
	let rollbackUndelivered: (() => Promise<void>) | undefined;
	try {
		runtime = await loadThread(resumeBridge, {
			threadId,
			ownership: "attached",
			connectionId: context?.connectionId,
			params,
			experimentalApi,
		});
		rollbackUndelivered = createUndeliveredResponseRollback(manager, context, runtime, false);
		if (runtime.threadId !== threadId) throw new Error("Attached child returned a different thread id.");
		const turns = await readAndReconstructTurns(runtime.client);
		const response = projectThreadResponse(
			{ sessionId: runtime.sessionId, cwd: runtime.cwd, effectiveSettings: runtime.effectiveSettings },
			experimentalApi,
			turns,
			"thread/resume",
		);
		const validators = experimentalApi ? experimentalValidators : stableValidators;
		if (!validators.clientRequestResults["thread/resume"]?.(response))
			throw new Error("Invalid thread/resume response.");
		const serialized = serializeResult(id, response, transport);
		if (!serialized) throw new Error("Thread resume response could not be serialized.");
		if (context?.isActive && !context.isActive()) throw new Error("Requester connection is inactive.");
		return {
			response: serialized,
			responseDelivered: createResponseDelivery(context, threadId),
			rollbackUndeliveredResponse: rollbackUndelivered,
		};
	} catch {
		if (rollbackUndelivered) {
			try {
				await rollbackUndelivered();
			} catch {
				// The identity-fenced attached runtime was removed and every close stage was attempted.
			}
		}
		return { response: serializeError(id, "internalError", transport) ?? undefined };
	}
}

/** Process one inbound frame. The async boundary serializes connection processing. */
export async function processInbound(
	state: ConnectionState,
	manager: ThreadRuntimeManager,
	line: Uint8Array,
	frameCodec?: FrameCodecOptions,
	transport: "stdio" | "websocket" | "unix" = "websocket",
	handlerRegistry?: HandlerRegistry,
	context?: InboundContext,
): Promise<InboundResult> {
	const decoded = decodeLine(line, frameCodec);
	if (decoded.kind === "oversize") {
		return transport === "stdio"
			? { response: serializeError(null, "invalidRequest", "stdio") }
			: { rejected: "oversize" };
	}
	if (decoded.kind === "malformed") return { rejected: "malformed" };

	if (isClientResponse(decoded.raw, decoded.id)) {
		const id = String(decoded.id);
		const request = context?.broker?.getPending(id);
		if (request) {
			if (Object.hasOwn(decoded.raw, "result")) {
				const validators = state.capabilities?.experimentalApi ? experimentalValidators : stableValidators;
				const validate = validators.serverRequestResults[request.method];
				// Invalid server-request results are ignored and logged; they must not settle an
				// approval that may still be answered by another eligible client.
				if (!validate?.(decoded.raw.result)) {
					logger.warn("Ignoring invalid app-server client response", {
						connectionId: context?.connectionId,
						id,
						method: request.method,
					});
					return { notification: true };
				}
				context?.broker?.resolve(id, context.connectionId ?? "", decoded.raw.result);
			} else if (isErrorResponse(decoded.raw.error)) {
				context?.broker?.resolveError(id, context.connectionId ?? "", decoded.raw.error);
			} else {
				logger.warn("Ignoring invalid app-server client error response", {
					connectionId: context?.connectionId,
					id,
					method: request.method,
				});
			}
		}
		return { notification: true };
	}

	const classification = classifyInbound(decoded.raw, decoded.id);
	if (classification.direction === "invalid") {
		return { response: serializeError(classification.id ?? null, "invalidRequest", transport) ?? undefined };
	}
	if (classification.direction === "clientNotification") {
		if (
			classification.method === "initialized" &&
			stableValidators.clientNotificationParams.initialized(classification.params)
		)
			state.completeInitialize();
		return { notification: true };
	}
	if (classification.direction === "clientRequest" && classification.method === "initialize") {
		const authz = state.authorize("initialize");
		if (!authz.ok) return { response: serializeError(classification.id, authz.key, transport) ?? undefined };
		// Initialize selects stable validation because its capabilities have not been negotiated yet.
		if (!stableValidators.clientRequestParams.initialize(classification.params))
			return { response: serializeError(classification.id, "invalidParams", transport) ?? undefined };
		state.beginInitialize(classification.params as Parameters<ConnectionState["beginInitialize"]>[0] | undefined);
		const result = {
			userAgent: `gjc/${packageMetadata.version}`,
			codexHome: process.env.GJC_AGENT_DIR ?? path.join(os.homedir(), ".gjc", "agent"),
			platformFamily: os.type(),
			platformOs: process.platform,
		};
		if (!stableValidators.clientRequestResults.initialize(result))
			return { response: serializeError(classification.id, "internalError", transport) ?? undefined };
		return { response: serializeResult(classification.id, result, transport) ?? undefined };
	}

	const verdict = dispatchClientRequest(state, classification);
	const threadStartBridge = context?.threadStartAdapter;
	switch (verdict.kind) {
		case "notInitialized":
			return { response: serializeError(verdict.id, "notInitialized", transport) ?? undefined };
		case "alreadyInitialized":
			return { response: serializeError(verdict.id, "alreadyInitialized", transport) ?? undefined };
		case "methodNotFound":
			return { response: serializeError(verdict.id, "methodNotFound", transport) ?? undefined };
		case "notSupported":
			return { response: serializeError(verdict.id, "notSupported", transport) ?? undefined };
		case "invalidParams":
			return { response: serializeError(verdict.id, "invalidParams", transport) ?? undefined };
		case "handle": {
			if (classification.method === "turn/start")
				return await handleTurnStart(state, manager, verdict.id, verdict.params, transport, context);
			if (classification.method === "thread/resume")
				return await handleThreadResume(
					state,
					manager,
					verdict.id,
					verdict.params,
					transport,
					context,
					threadStartBridge,
				);
			if (classification.method === "thread/start") {
				if (typeof threadStartBridge?.create !== "function")
					return { response: serializeError(verdict.id, "notSupported", transport) ?? undefined };
				const params = isRecord(verdict.params) ? verdict.params : {};
				try {
					const runtime = await loadThread(threadStartBridge, {
						connectionId: context?.connectionId,
						params,
						experimentalApi: state.capabilities?.experimentalApi === true,
						subscribe: context?.subscribe ? threadId => context.subscribe?.(threadId) : undefined,
						unsubscribe: context?.unsubscribe ? threadId => context.unsubscribe?.(threadId) : undefined,
					});
					const rollbackUndeliveredResponse = createUndeliveredResponseRollback(manager, context, runtime);
					if (context?.isActive && !context.isActive()) {
						await rollbackUndeliveredResponse();
						throw new Error("Requester connection is inactive.");
					}
					const response = serializeResult(verdict.id, runtime.response, transport);
					if (!response) {
						await rollbackUndeliveredResponse();
						throw new Error("Thread start response could not be serialized.");
					}
					return { response, rollbackUndeliveredResponse };
				} catch (error) {
					const key = isRecord(error) && error.code === "conflict" ? "conflict" : "internalError";
					return { response: serializeError(verdict.id, key, transport) ?? undefined };
				}
			}
			const handler = handlerRegistry?.get(classification.method);
			if (!handler) return { response: serializeError(verdict.id, "notSupported", transport) ?? undefined };
			try {
				const handlerResult = await handler(decoded.raw.params, context);
				if (!handlerResult.ok)
					return { response: serializeError(verdict.id, handlerResult.errorKey, transport) ?? undefined };
				// A handler response must conform to the profile negotiated by initialize. Fail
				// closed with -32603 rather than emitting a result that clients cannot decode.
				const validators = state.capabilities?.experimentalApi ? experimentalValidators : stableValidators;
				const validate = validators.clientRequestResults[classification.method];
				if (!validate?.(handlerResult.result))
					return { response: serializeError(verdict.id, "internalError", transport) ?? undefined };
				return { response: serializeResult(verdict.id, handlerResult.result, transport) ?? undefined };
			} catch {
				return { response: serializeError(verdict.id, "internalError", transport) ?? undefined };
			}
		}
		default:
			return { response: encodeMessage({ id: undefined, error: { code: -32603, message: "Internal error" } }) };
	}
}
