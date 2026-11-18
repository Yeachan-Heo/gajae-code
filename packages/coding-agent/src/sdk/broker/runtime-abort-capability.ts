import { randomBytes } from "node:crypto";

/**
 * Process-local marker that lets the Broker reach the operator terminal-abort gate
 * of a session it did not launch.
 *
 * A Broker-launched host proves Broker routing with its `GJC_LIFECYCLE_REQUEST_ID`,
 * which the Broker already holds in the session index. A TUI or direct CLI host
 * has no lifecycle request, so it mints this marker instead and publishes it in
 * its own `host_registered` index row. The marker never leaves the index or the
 * runtime: it is not part of endpoint discovery, session-list results, or any
 * SDK response, so an SDK client that only holds the endpoint token cannot claim
 * operator authority.
 */
let mintedCapability: string | undefined;

/** True when this process is a Broker-launched lifecycle host. */
function hasLifecycleRequest(): boolean {
	const lifecycleRequestId = process.env.GJC_LIFECYCLE_REQUEST_ID;
	return typeof lifecycleRequestId === "string" && lifecycleRequestId.length > 0;
}

/**
 * The marker this process publishes in its own endpoint registration, minted on
 * first use. A lifecycle host publishes none: its lifecycle request id already
 * carries the same authority, and two markers would make the gate ambiguous.
 */
export function publishableRuntimeAbortCapability(): string | undefined {
	if (hasLifecycleRequest()) return undefined;
	mintedCapability ??= randomBytes(32).toString("base64url");
	return mintedCapability;
}

/**
 * The marker this process has already published, if any. The abort gate accepts
 * only a published marker: a process that never registered an endpoint has
 * nothing the Broker could have read back.
 */
export function publishedRuntimeAbortCapability(): string | undefined {
	return hasLifecycleRequest() ? undefined : mintedCapability;
}
