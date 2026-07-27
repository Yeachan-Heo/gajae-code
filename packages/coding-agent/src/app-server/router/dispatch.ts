// app-server dispatch: direction-split JSON-RPC dispatch driven by the four generated catalogs.
//
// The codex protocol is split by JSON-RPC message direction (D6):
//   - client REQUESTS         -> resolve a handler or the standard not-supported error;
//                                implemented|not_supported only where a response is legal.
//   - client NOTIFICATIONS    -> validate then consume with NO response (JSON-RPC forbids
//                                an error response to a notification); unknown/unsupported
//                                client notifications are validated+ignored, never answered.
//   - server REQUESTS         -> emit-side only (approvals/elicitation); correlated, not dispatched here.
//   - server NOTIFICATIONS    -> emit-side only; validated against the catalog before send.
//
// Experimental methods are gated by the connection's `experimentalApi` capability: a stable
// client requesting an experimental method gets `notSupported` (the method exists in the
// catalog but is not enabled for this connection), matching the upstream capability contract.

import {
	clientNotifications,
	clientRequests,
} from "../protocol-source/catalogs.generated";
import type { CatalogEntry } from "../protocol-source/catalogs.generated";
import { supportManifest, type SupportManifestRow } from "../protocol-source/support-manifest.generated";
import type { ConnectionState } from "./connection-state";
import type { AppServerErrorKey } from "../transport/errors";

export type MessageDirection = "clientRequest" | "clientNotification";

/** A categorized inbound client message. */
export type InboundClassification =
	| { direction: "clientRequest"; method: string; stability: "stable" | "experimental"; id: string | number; params: unknown; support: SupportManifestRow["support"] }
	| { direction: "clientNotification"; method: string; stability: "stable" | "experimental"; params: unknown }
	| { direction: "unknown"; method: string; id: string | number }
	| { direction: "invalid"; reason: AppServerErrorKey; id: string | number | undefined };

const clientRequestByName = new Map<string, CatalogEntry>();
for (const entry of clientRequests) clientRequestByName.set(entry.method, entry);
const clientNotificationByName = new Map<string, CatalogEntry>();
for (const entry of clientNotifications) clientNotificationByName.set(entry.method, entry);
const supportByName = new Map<string, SupportManifestRow>();
for (const row of supportManifest) supportByName.set(row.method, row);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Classify one decoded inbound frame. `frame` is the raw JSON object (jsonrpc already
 * stripped by the framing codec). This is PURE — it performs no side effects and sends
 * nothing; the caller decides what to emit based on the classification.
 */
export function classifyInbound(frame: Record<string, unknown>): InboundClassification {
	const method = typeof frame.method === "string" ? frame.method : "";
	// id presence distinguishes a request from a notification.
	const hasId = Object.hasOwn(frame, "id") && frame.id !== undefined && frame.id !== null;
	const id = hasId ? (frame.id as string | number) : undefined;
	// Within the hasId branch, narrow id to a legal JSON-RPC id before returning it on an `unknown` frame.
	const requestId: string | number | undefined = typeof id === "string" || typeof id === "number" ? id : undefined;

	if (!method) {
		return { direction: "invalid", reason: "invalidRequest", id };
	}
	if (hasId) {
		const catalogEntry = clientRequestByName.get(method);
		if (!catalogEntry) {
			// An id-bearing frame with an unknown method is methodNotFound (it expects a response).
			return { direction: "unknown", method, id: requestId ?? "" };
		}
		// A request whose id is not a legal JSON-RPC id type is invalid.
		if (typeof id !== "string" && typeof id !== "number") {
			return { direction: "invalid", reason: "invalidRequest", id };
		}
		const support = supportByName.get(method)?.support ?? "planned";
		return {
			direction: "clientRequest",
			method,
			stability: catalogEntry.stability,
			id,
			params: frame.params,
			support,
		};
	}
	// No id => notification.
	const notifEntry = clientNotificationByName.get(method);
	if (!notifEntry) {
		// A notification with an unknown method is still a notification (no id). JSON-RPC
		// forbids an error response to a notification, so this is consumed silently here.
		return { direction: "clientNotification", method, stability: "stable", params: frame.params };
	}
	return {
		direction: "clientNotification",
		method,
		stability: notifEntry.stability,
		params: frame.params,
	};
}

/**
 * Resolve how a classified client REQUEST should be handled on a given connection.
 * Returns the dispatch verdict the caller acts on:
 *   - `handle`         -> invoke the registered handler (method is implemented AND permitted);
 *   - `notSupported`   -> emit -32081 (backend-less per the manifest, or experimental+capability-gated);
 *   - `experimentalGate`-> a stable-connection request for an experimental method: emit `notSupported`;
 *   - `notInitialized` / `alreadyInitialized` -> the handshake gate refused;
 *   - `methodNotFound` -> unknown method with an id.
 */
export type DispatchVerdict =
	| { kind: "handle"; method: string; id: string | number; params: unknown }
	| { kind: "notSupported"; method: string; id: string | number; reason: "backendLess" | "experimentalGate" }
	| { kind: "notInitialized"; id: string | number }
	| { kind: "alreadyInitialized"; id: string | number }
	| { kind: "methodNotFound"; method: string; id: string | number };

export function dispatchClientRequest(
	state: ConnectionState,
	classification: InboundClassification,
): DispatchVerdict {
	if (classification.direction === "unknown") {
		return { kind: "methodNotFound", method: classification.method, id: classification.id };
	}
	// Notifications and invalid frames are not request-dispatched here; the caller routes them.
	if (classification.direction !== "clientRequest") {
		throw new Error(`dispatchClientRequest received a non-request classification: ${classification.direction}`);
	}
	// Handshake gate.
	const authz = state.authorize(classification.method);
	if (!authz.ok) {
		return authz.key === "alreadyInitialized"
			? { kind: "alreadyInitialized", id: classification.id }
			: { kind: "notInitialized", id: classification.id };
	}
	// Experimental capability gate.
	if (classification.stability === "experimental" && !state.capabilities?.experimentalApi) {
		return { kind: "notSupported", method: classification.method, id: classification.id, reason: "experimentalGate" };
	}
	// Support manifest gate.
	if (classification.support === "not_supported") {
		return { kind: "notSupported", method: classification.method, id: classification.id, reason: "backendLess" };
	}
	return { kind: "handle", method: classification.method, id: classification.id, params: classification.params };
}

/**
 * Whether an outbound server notification should actually be sent on this connection, given
 * its capabilities (opt-out allowlist + experimental gating). Server notifications are
 * emit-side; this guards the send, it does not dispatch.
 */
export function shouldEmitNotification(
	state: ConnectionState,
	method: string,
	stability: "stable" | "experimental",
): boolean {
	if (state.optsOutOf(method)) return false;
	if (stability === "experimental" && !state.capabilities?.experimentalApi) return false;
	return true;
}

/** Type guard helpers for tests/external callers. */
export function isClientRequestMethod(method: string): boolean {
	return clientRequestByName.has(method);
}
export function isClientNotificationMethod(method: string): boolean {
	return clientNotificationByName.has(method);
}

export { isObject };
