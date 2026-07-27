// app-server server: assembles transport + router + runtime into a running server.
//
// This is the integration layer that wires the ThreadRuntimeManager (admission),
// ConnectionState (handshake), dispatch (direction-split routing), and the transport
// acceptor (stdio/ws/unix/off) into a single running server instance.
//
// The server reads inbound frames through the framing codec, routes them through
// the connection-state handshake gate and the direction-split dispatcher, and emits
// responses/errors through the framing codec. Thread lifecycle operations acquire
// spawn tokens through the child-bridge.

import { decodeLine, encodeMessage, type FrameCodecOptions } from "./transport/framing";
import { serializeError, serializeResult, appServerError } from "./transport/errors";
import { ConnectionState } from "./router/connection-state";
import { classifyInbound, dispatchClientRequest } from "./router/dispatch";
import { ThreadRuntimeManager } from "./thread-runtime/thread-runtime-manager";
import type { ListenMode } from "./transport/listen";
import type { HandlerRegistry } from "./suites/handlers";

export interface AppServerOptions {
	readonly mode: ListenMode;
	readonly maxLoadedThreads?: number;
	readonly frameCodec?: FrameCodecOptions;
}

export interface InboundResult {
	readonly response?: Uint8Array;
	readonly notification?: boolean;
}

/**
 * Process one decoded inbound line through the full server pipeline.
 * Returns the outbound response frame (if any), or undefined for notifications/malformed.
 * This is the core integration point: framing -> connection-state -> dispatch -> errors.
 */
export function processInbound(
	state: ConnectionState,
	manager: ThreadRuntimeManager,
	line: Uint8Array,
	frameCodec?: FrameCodecOptions,
	transport: "stdio" | "websocket" | "unix" = "websocket",
	handlerRegistry?: HandlerRegistry,
): InboundResult {
	const decoded = decodeLine(line, frameCodec);

	if (decoded.kind === "oversize") {
		// Per-transport oversize handling.
		if (transport === "stdio") {
			// GJC-only -32600 id:null, data omitted.
			return { response: serializeError(null, "invalidRequest", "stdio") };
		}
		// ws/unix: caller closes 1009; no response frame.
		return {};
	}

	if (decoded.kind === "malformed") {
		// Dropped silently, no wire response.
		return {};
	}

	// decoded.kind === "message"
	const classification = classifyInbound(decoded.raw);

	if (classification.direction === "invalid") {
		return { response: serializeError(classification.id, "invalidRequest", transport) ?? undefined };
	}

	if (classification.direction === "clientNotification") {
		// Special-case: initialized notification completes the handshake.
		if (classification.method === "initialized") {
			state.completeInitialize();
		}
		// All notifications are consumed silently (no response per JSON-RPC).
		return { notification: true };
	}

	// Special-case: initialize performs the handshake (beginInitialize + return success).
	if (classification.direction === "clientRequest" && classification.method === "initialize") {
		const authz = state.authorize("initialize");
		if (!authz.ok) {
			return { response: serializeError(classification.id, authz.key, transport) ?? undefined };
		}
		state.beginInitialize(classification.params as Parameters<ConnectionState["beginInitialize"]>[0] | undefined);
		// Return a minimal initialize result. The real result shape will come from the
		// vendored types once the initialize handler is wired in P4.
		return { response: serializeResult(classification.id, { ok: true }, transport) ?? undefined };
	}

	// Request dispatch for all other methods.
	const verdict = dispatchClientRequest(state, classification);

	switch (verdict.kind) {
		case "notInitialized":
			return { response: serializeError(verdict.id, "notInitialized", transport) ?? undefined };
		case "alreadyInitialized":
			return { response: serializeError(verdict.id, "alreadyInitialized", transport) ?? undefined };
		case "methodNotFound":
			return { response: serializeError(verdict.id, "methodNotFound", transport) ?? undefined };
		case "notSupported":
			return { response: serializeError(verdict.id, "notSupported", transport) ?? undefined };
	case "handle":
	// Thread lifecycle methods exercise the ThreadRuntimeManager admission path.
		// NOTE: This is the P2 admission integration — it proves the manager is wired and
		// thread ownership is tracked. The full thread/start handler with real session
		// creation, item streaming, and protocol-grounded response shapes is P4 (backable
		// suites). Per the vendored protocol, thread/start generates the threadId (server-side),
		// thread/resume accepts an existing threadId, and thread/fork copies history.
		if (classification.method === "thread/start" || classification.method === "thread/resume" || classification.method === "thread/fork") {
			const params = (decoded.raw.params ?? {}) as Record<string, unknown>;
			// thread/start generates a new threadId; resume/fork accept an existing one.
			const threadId = classification.method === "thread/start"
				? `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
				: String(params.threadId ?? params.id ?? `thread-${Date.now()}`);
			const ownership = classification.method === "thread/resume" ? "attached" as const : "spawned" as const;
			try {
				manager.register(threadId, ownership, undefined);
			} catch (error) {
				const key = (error as { code?: string }).code === "conflict" ? "conflict" : "internalError";
				return { response: serializeError(verdict.id, key, transport) ?? undefined };
			}
			return { response: serializeResult(verdict.id, { threadId, status: "loaded" }, transport) ?? undefined };
		}
	// All other methods: dispatch through the handler registry if one is wired.
		const handler = handlerRegistry?.get(classification.method);
		if (handler) {
			try {
				const handlerResult = handler(decoded.raw.params);
				if (handlerResult.ok) {
					return { response: serializeResult(verdict.id, handlerResult.result, transport) ?? undefined };
				}
				return { response: serializeError(verdict.id, handlerResult.errorKey, transport) ?? undefined };
			} catch {
				return { response: serializeError(verdict.id, "internalError", transport) ?? undefined };
			}
		}
		return { response: serializeError(verdict.id, "notSupported", transport) ?? undefined };
		default:
			return { response: serializeError(undefined, "internalError", transport) ?? undefined };
	}
}