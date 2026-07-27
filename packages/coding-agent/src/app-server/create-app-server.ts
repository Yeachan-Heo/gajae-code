// app-server server assembly: creates and wires all components into a running server.
//
// This is the production entry point that instantiates a HandlerRegistry with
// registerBuiltinHandlers(), creates a ThreadRuntimeManager, and exposes processInbound
// pre-wired with both. Transport callers (acceptor/listen) use this facade rather than
// assembling the components manually.

import { processInbound, type InboundResult } from "./server";
import { ConnectionState } from "./router/connection-state";
import { ThreadRuntimeManager, type AdmissionConfig } from "./thread-runtime/thread-runtime-manager";
import { HandlerRegistry, registerBuiltinHandlers } from "./suites/handlers";
import type { FrameCodecOptions } from "./transport/framing";

export interface AppServer {
	readonly state: ConnectionState;
	readonly manager: ThreadRuntimeManager;
	readonly registry: HandlerRegistry;
	process: (line: Uint8Array, transport?: "stdio" | "websocket" | "unix") => InboundResult;
}

/**
 * Create a production app-server instance with all components wired:
 * - ConnectionState for per-connection handshake
 * - ThreadRuntimeManager for multi-thread admission
 * - HandlerRegistry with all built-in handlers registered
 *
 * Each call creates an independent connection state; the acceptor creates one per
 * accepted connection.
 */
export function createAppServer(config?: Partial<AdmissionConfig>, frameCodec?: FrameCodecOptions): AppServer {
	const state = new ConnectionState();
	const manager = new ThreadRuntimeManager(config);
	const registry = new HandlerRegistry();
	registerBuiltinHandlers(registry);
	return {
		state,
		manager,
		registry,
		process: (line, transport = "websocket") => processInbound(state, manager, line, frameCodec, transport, registry),
	};
}
