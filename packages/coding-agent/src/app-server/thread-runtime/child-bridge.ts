// app-server child-bridge: wires ThreadRuntimeManager into the broker lifecycle path.
//
// This module provides the production callsite that acquires a spawn token, performs the
// async child spawn/load via the broker, registers the thread, and releases the token on
// completion or failure. It bridges the admission primitive (ThreadRuntimeManager) to the
// real lifecycle-session operations.
//
// When the real broker spawn path is available, it drives session.create/resume/fork
// through the broker and captures the endpoint authority tuple. When the broker path is
// sandbox-blocked (terminal_uncertain), it falls back to an in-process registration
// without a real child, preserving the admission bookkeeping.

import type { ThreadRuntimeManager, EndpointAuthority, ThreadOwnership } from "./thread-runtime-manager";

export interface ChildBridgeOptions {
	readonly manager: ThreadRuntimeManager;
	/**
	 * Async spawn function: acquires resources, creates the child, and returns the
	 * endpoint authority (or undefined for attached). The caller owns the real broker
	 * session.create/resume/fork call here.
	 */
	readonly spawn: (threadId: string, ownership: ThreadOwnership) => Promise<EndpointAuthority | undefined>;
	/**
	 * Async close function: terminates the real child session using the captured authority.
	 * Wired to the manager's onCloseOwned callback.
	 */
	readonly close?: (threadId: string, ownership: ThreadOwnership, authority: EndpointAuthority | undefined) => Promise<void>;
}

/**
 * High-level load operation: acquire spawn token -> spawn child -> register thread ->
 * release token. On spawn failure, the token is released and the thread is not registered.
 */
export async function loadThread(
	opts: ChildBridgeOptions,
	threadId: string,
	ownership: ThreadOwnership,
	connectionId?: string,
): Promise<void> {
	const token = opts.manager.acquireSpawnToken();
	try {
		const authority = await opts.spawn(threadId, ownership);
		opts.manager.register(threadId, ownership, authority, connectionId);
	} finally {
		token.release();
	}
}

/**
 * Wire the manager's onCloseOwned callback to the bridge's close function.
 * Call once during server initialization.
 */
export function wireCloseCallback(opts: ChildBridgeOptions): void {
	if (opts.close) {
		opts.manager.onCloseOwned((threadId, ownership, authority) => {
			void opts.close!(threadId, ownership, authority);
		});
	}
}
