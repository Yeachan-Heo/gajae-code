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

import type { CatalogEntry } from "../protocol-source/catalogs.generated";
import { clientNotifications, clientRequests } from "../protocol-source/catalogs.generated";
import { experimentalValidators, stableValidators } from "../protocol-source/schema-validators.generated";
import { type SupportManifestRow, supportManifest } from "../protocol-source/support-manifest.generated";
import type { AppServerErrorKey } from "../transport/errors";
import { coerceId } from "../transport/framing";
import type { ConnectionState } from "./connection-state";

export type MessageDirection = "clientRequest" | "clientNotification";

/** A categorized inbound client message. */
export type InboundClassification =
	| {
			direction: "clientRequest";
			method: string;
			stability: "stable" | "experimental";
			id: string | number;
			params: unknown;
			support: SupportManifestRow["support"];
	  }
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
export function classifyInbound(
	frame: Record<string, unknown>,
	decodedId: string | number | undefined = coerceId(frame.id),
): InboundClassification {
	const method = typeof frame.method === "string" ? frame.method : "";
	// An `id` member distinguishes requests from notifications. Its value was normalized by
	// decodeLine so this routing layer cannot accidentally accept a different id domain.
	const hasId = Object.hasOwn(frame, "id");
	const id = decodedId;

	if (!method) {
		// A frame with no method is invalid. Report only the sanitized id: echoing a raw id that
		// coerceId already rejected would put an illegal id back on the wire.
		return { direction: "invalid", reason: "invalidRequest", id };
	}
	if (hasId) {
		if (id === undefined) {
			// The frame carried an `id` member that coerceId rejected as illegal (non-integer,
			// -0, out of safe range, empty string). JSON-RPC requires a null id in that error
			// envelope: echoing the raw value would emit the same illegal id back to the peer.
			return {
				direction: "invalid",
				reason: "invalidRequest",
				id: undefined,
			};
		}
		const catalogEntry = clientRequestByName.get(method);
		if (!catalogEntry) {
			// An id-bearing frame with an unknown method is methodNotFound (it expects a response).
			return { direction: "unknown", method, id };
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
	| { kind: "invalidParams"; id: string | number }
	| { kind: "notSupported"; method: string; id: string | number; reason: "backendLess" | "experimentalGate" }
	| { kind: "notInitialized"; id: string | number }
	| { kind: "alreadyInitialized"; id: string | number }
	| { kind: "methodNotFound"; method: string; id: string | number };

export function dispatchClientRequest(state: ConnectionState, classification: InboundClassification): DispatchVerdict {
	if (classification.direction === "unknown") {
		return { kind: "methodNotFound", method: classification.method, id: classification.id };
	}
	// Notifications and invalid frames are not request-dispatched here; the caller routes them.
	if (classification.direction !== "clientRequest") {
		throw new Error(`dispatchClientRequest received a non-request classification: ${classification.direction}`);
	}
	// Experimental capability gate.
	if (classification.stability === "experimental" && !state.capabilities?.experimentalApi) {
		return { kind: "notSupported", method: classification.method, id: classification.id, reason: "experimentalGate" };
	}
	// Handshake gate. This precedes param validation so an uninitialized caller gets the
	// locked -32600 envelope rather than leaking schema detail about a request it may not
	// make yet.
	const authz = state.authorize(classification.method);
	if (!authz.ok) {
		return authz.key === "alreadyInitialized"
			? { kind: "alreadyInitialized", id: classification.id }
			: { kind: "notInitialized", id: classification.id };
	}
	// Support manifest gate. An unbacked method is -32081 regardless of param shape.
	if (classification.support !== "implemented") {
		return { kind: "notSupported", method: classification.method, id: classification.id, reason: "backendLess" };
	}
	// Validate wire params before any handler, broker, prompt, or session boundary. The
	// vendored schemas intentionally tolerate unknown object keys where they omit
	// additionalProperties.
	const validators = state.capabilities?.experimentalApi ? experimentalValidators : stableValidators;
	const validate = validators.clientRequestParams[classification.method];
	// A method absent from the negotiated profile has no validator. That is a support gap,
	// not a param error, so it must surface as the locked -32081 rather than -32602.
	if (!validate) {
		return { kind: "notSupported", method: classification.method, id: classification.id, reason: "backendLess" };
	}
	if (!validate(classification.params)) return { kind: "invalidParams", id: classification.id };
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
