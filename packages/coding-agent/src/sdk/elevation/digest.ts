import { createHash } from "node:crypto";
import { ELEVATION_ALLOWLIST_KEYS, isElevationAllowlisted } from "./allowlist";

/**
 * Fully qualified elevation request digest.
 *
 * An elevation grant binds the exact operation the operator approved. The
 * digest covers the complete `{kind, sdkId, input}` triple so substituting a
 * different operation or different input bytes changes the digest and the
 * gate presentation fails closed (`misused`). The top-level
 * `elevationRequestId` correlation field is deliberately excluded: it is the
 * durable correlation ID assigned to a request, not part of the approved
 * content, and the same content re-issued under a new ID must produce the
 * same digest.
 *
 * Only allowlisted operations can be elevated; anything else is refused so a
 * caller cannot mint a grant for an operation outside the elevation policy.
 */
export const ELEVATION_OPERATION_KINDS = ["control", "query", "global"] as const;
export type ElevationOperationKind = (typeof ELEVATION_OPERATION_KINDS)[number];

export interface ElevationOperation {
	kind: ElevationOperationKind;
	sdkId: string;
}

/**
 * Operations that require an elevation grant. Default SDK scope
 * (list/query/send/tail) stays grant-free; destructive lifecycle operations
 * and workflow approval operations are elevatable and therefore gated.
 */
export const ELEVATION_ALLOWLIST: readonly { kind: ElevationOperationKind; sdkId: string }[] =
	ELEVATION_OPERATION_KINDS.flatMap(kind =>
		[...ELEVATION_ALLOWLIST_KEYS]
			.filter(key => key.startsWith(`${kind}:`))
			.map(key => ({ kind, sdkId: key.slice(kind.length + 1) })),
	);

export function isElevatableOperation(kind: unknown, sdkId: unknown): boolean {
	return isElevationAllowlisted(kind, sdkId);
}

/**
 * Whether the `(kind, sdkId)` pair names a registry operation that the
 * elevation allowlist recognizes. Used by the ledger row validator so a
 * persisted row can never bind an operation outside the allowlist.
 */
export function isKnownElevationOperation(kind: unknown, sdkId: unknown): boolean {
	return isElevationAllowlisted(kind, sdkId);
}

/**
 * Canonical JSON encoding for elevation digest leaves.
 *
 * Intentionally byte-compatible with the broker's identity canonicalization
 * (`canonicalJson` in `sdk/broker/broker.ts`): object keys sorted, compact
 * separators, `undefined` fields preserved verbatim, arrays joined without
 * separators. The broker computes the request digest at issue time and the
 * ledger recomputes/compares the same encoding, so digest verification is
 * stable across issue, gate presentation, and answer.
 */
export function canonicalElevationJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalElevationJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalElevationJson(record[key])}`)
		.join(",")}}`;
}

export type ElevationDigestResult =
	| { ok: true; digest: string }
	| { ok: false; error: { code: string; message: string } };

const MAX_SDK_ID_LENGTH = 128;
const MAX_INPUT_JSON_DEPTH = 64;
const MAX_INPUT_JSON_FIELDS = 1024;

function isBoundedInputJson(value: unknown, depth = 0, budget = { fields: 0 }): boolean {
	if (depth > MAX_INPUT_JSON_DEPTH) return false;
	if (value === null || typeof value !== "object") return true;
	if (Array.isArray(value)) {
		if (value.length > MAX_INPUT_JSON_FIELDS) return false;
		return value.every(item => isBoundedInputJson(item, depth + 1, budget));
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	budget.fields += keys.length;
	return (
		budget.fields <= MAX_INPUT_JSON_FIELDS && keys.every(key => isBoundedInputJson(record[key], depth + 1, budget))
	);
}

/**
 * Computes the fully qualified digest for an elevation request.
 *
 * `input` is digested exactly as supplied except that a top-level
 * `elevationRequestId` field is removed first (it is the correlation ID, not
 * approved content). Operations outside `ELEVATION_ALLOWLIST` are refused
 * with `elevation_not_required` so the broker never mints a grant for an
 * operation that does not need one.
 */
export function elevationRequestDigest(request: {
	kind: unknown;
	sdkId: unknown;
	input: unknown;
}): ElevationDigestResult {
	const kind = request.kind;
	if (!ELEVATION_OPERATION_KINDS.includes(kind as ElevationOperationKind))
		return { ok: false, error: { code: "invalid_input", message: "kind must be control, query, or global" } };
	if (typeof request.sdkId !== "string" || request.sdkId.length === 0 || request.sdkId.length > MAX_SDK_ID_LENGTH)
		return { ok: false, error: { code: "invalid_input", message: "sdkId must be a non-empty bounded string" } };
	if (!isElevatableOperation(kind, request.sdkId))
		return {
			ok: false,
			error: { code: "elevation_not_required", message: `${request.sdkId} does not require elevation` },
		};
	if (typeof request.input !== "object" || request.input === null || Array.isArray(request.input))
		return { ok: false, error: { code: "invalid_input", message: "input must be a JSON object" } };
	if (!isBoundedInputJson(request.input))
		return { ok: false, error: { code: "invalid_input", message: "input exceeds the bounded JSON limits" } };
	const input = { ...(request.input as Record<string, unknown>) };
	delete input.elevationRequestId;
	const digest = createHash("sha256")
		.update(canonicalElevationJson({ kind: kind as ElevationOperationKind, sdkId: request.sdkId, input }))
		.digest("hex");
	return { ok: true, digest };
}
