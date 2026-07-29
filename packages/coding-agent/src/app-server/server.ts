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
import { type ChildBridgeOptions, loadThread } from "./thread-runtime/child-bridge";
import type { ThreadRuntimeManager } from "./thread-runtime/thread-runtime-manager";
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
	/** The frame was deliberately dropped without a wire response. */
	readonly rejected?: "malformed" | "oversize";
}

export interface InboundContext extends HandlerContext {
	readonly connectionId?: string;
	readonly broker?: ServerRequestBroker;
	readonly threadStartAdapter?: ChildBridgeOptions;
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

function isErrorResponse(value: unknown): value is { code: number; message: string } {
	if (!isRecord(value)) return false;
	return (
		typeof value.code === "number" &&
		Number.isFinite(value.code) &&
		Number.isInteger(value.code) &&
		typeof value.message === "string"
	);
}

/** Process one inbound frame. The async boundary serializes connection processing. */
export async function processInbound(
	state: ConnectionState,
	_manager: ThreadRuntimeManager,
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
					return { response: serializeResult(verdict.id, runtime.response, transport) ?? undefined };
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
