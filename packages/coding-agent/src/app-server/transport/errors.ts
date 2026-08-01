// app-server errors: typed JSON-RPC error envelopes for the codex-compatible wire.
//
// Sole authority for standard codes: the vendored same-commit serialized golden envelopes
// at protocol-source/vendor/app-server.behavior.json (key `errorEnvelopes`), captured from
// upstream commit 81da9deb. Upstream `JSONRPCErrorError.data` is `Option<Value>` with
// `#[serde(skip_serializing_if = "Option::is_none")]`, so standard errors OMIT the `data`
// key entirely (never `"data": null`), and `JSONRPCError.id` is a non-nullable `RequestId`
// (`string | integer`). We mirror the serialized wire bytes exactly; we do NOT translate
// Rust fields into a competing shape.
//
// GJC-only app-server extensions (notFound/conflict/cancelled/idempotencyConflict/etc.)
// have no upstream golden; their code/message are pinned in {@link GJC_ONLY_ENVELOPES} as
// an explicit GJC operational decision and are audited separately in meta.json so the
// parity gate can distinguish them from upstream golden envelopes.
//
// Every envelope emitted to the wire goes through {@link serializeError}. The internal
// typed cause (exception text, secrets, correlation ids) is retained in logs via the
// optional `internal` field and is NEVER placed on the wire.

import { goldenErrorEnvelopes } from "../protocol-source/behavior/generated-behavior";
import type { JsonRpcId } from "./framing";

/**
 * Canonical error keys. Golden-backed keys have a serialized wire envelope in the vendored
 * behavior fixture; GJC-only keys are pinned in {@link GJC_ONLY_ENVELOPES}.
 */
export type AppServerErrorKey =
	// Golden-backed (vendored behavior.json errorEnvelopes)
	| "invalidRequest"
	| "methodNotFound"
	| "invalidParams"
	| "internalError"
	| "overloaded"
	| "notInitialized"
	| "alreadyInitialized"
	| "notSupported"
	// GJC-only app-server extensions (pinned below, audited separately)
	| "notFound"
	| "conflict"
	| "cancelled"
	| "idempotencyConflict"
	| "audienceForbidden"
	| "audienceSelectorRequired"
	| "busy";

/** GJC-only error codes/messages (no upstream golden). */
const GJC_ONLY_ENVELOPES: Readonly<Record<string, { code: number; message: string }>> = {
	notFound: { code: -32010, message: "Not found." },
	conflict: { code: -32011, message: "Conflict." },
	cancelled: { code: -32012, message: "Cancelled." },
	idempotencyConflict: { code: -32013, message: "Idempotency conflict." },
	audienceForbidden: { code: -32014, message: "A matching replay token is required for this requesterRef." },
	audienceSelectorRequired: { code: -32015, message: "requesterRef is required to replay audience-scoped events." },
	busy: { code: -32016, message: "Resource is busy." },
};

/** Map a canonical key to its pinned code/message. Golden-backed first, then GJC-only. */
export function goldenEnvelope(key: AppServerErrorKey): { code: number; message: string } {
	const golden = goldenErrorEnvelopes[key];
	if (golden) return { code: golden.error.code, message: golden.error.message };
	const gjc = GJC_ONLY_ENVELOPES[key];
	if (gjc) return { code: gjc.code, message: gjc.message };
	throw new Error(`unbacked app-server error key: ${key}`);
}

export interface AppServerError extends Error {
	readonly key: AppServerErrorKey;
	readonly code: number;
	readonly internal?: unknown;
}

/** Construct a typed error for internal use. Never place `internal` on the wire. */
export function appServerError(key: AppServerErrorKey, internal?: unknown): AppServerError {
	const { code, message } = goldenEnvelope(key);
	const error = new Error(message) as AppServerError;
	error.name = "AppServerError";
	(error as { key: AppServerErrorKey }).key = key;
	(error as { code: number }).code = code;
	(error as { internal?: unknown }).internal = internal;
	return error;
}

export type WireId = JsonRpcId | null | undefined;

/**
 * Serialize a response frame carrying an error. `data` is NEVER included (upstream omits
 * it for every standard code via `skip_serializing_if`). `id` is echoed verbatim as a
 * decoded string|integer, EXCEPT for the stdio oversize policy where the frame was never
 * decoded and the caller passes `null`.
 *
 * Notifications (id undefined) cannot receive an error response per JSON-RPC; callers must
 * not invoke this for a notification. We guard by returning `undefined` in that case.
 */
export function serializeError(
	id: WireId,
	key: AppServerErrorKey,
	transport: "stdio" | "websocket" | "unix" = "websocket",
	messageOverride?: string,
): Uint8Array | undefined {
	if (id === undefined) return undefined;
	const { code, message } = goldenEnvelope(key);
	const envelope: Record<string, unknown> = { id, error: { code, message: messageOverride ?? message } };
	const body = JSON.stringify(envelope);
	if (transport === "stdio") return new TextEncoder().encode(`${body}\n`);
	return new TextEncoder().encode(body);
}

/** Serialize a successful response frame (result present, no error). */
export function serializeResult(
	id: WireId,
	result: unknown,
	transport: "stdio" | "websocket" | "unix" = "websocket",
): Uint8Array | undefined {
	if (id === undefined) return undefined;
	const body = JSON.stringify({ id, result });
	if (transport === "stdio") return new TextEncoder().encode(`${body}\n`);
	return new TextEncoder().encode(body);
}
