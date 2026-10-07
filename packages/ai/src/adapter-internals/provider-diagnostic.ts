/**
 * Adapter-private minting of provider failure diagnostics.
 *
 * This module is NOT reachable from the package barrel or from a deep import
 * (`exports` maps `./adapter-internals/*` to null): only a provider adapter may
 * turn provider metadata into a `ProviderDiagnostic`, and only from evidence the
 * provider itself supplied in a structured field of a transport error it
 * actually issued. Consumers get the DTO types and the revalidating
 * `sanitizeProviderDiagnostic` from `../provider-diagnostic`, which cannot mint.
 *
 * Reading rules for untrusted provider data, applied everywhere below: fixed
 * field names only, read once behind guards, no key enumeration, no recursion,
 * and never `message`/`headers`/`requestID`/`stack`/`toJSON`, which cannot prove
 * what the provider said.
 */

import { APIError } from "@anthropic-ai/sdk";
import type { ProviderDiagnostic } from "../provider-diagnostic";
import { classifyProviderFacts, isPlainRecord } from "./provider-diagnostic-mapping";

/** Largest SSE error envelope this seam will parse at all. */
const SSE_ERROR_ENVELOPE_MAX_BYTES = 8_192;

/**
 * Structured classification of an Anthropic SDK `APIError`.
 *
 * The `instanceof` gate is the provenance proof: only the pinned SDK's own
 * transport constructs an `APIError`, so a compat layer, callback, or agent
 * catch object that self-declares `status`/`type` is refused. Reads exactly
 * three fixed fields once: `status`, the direct `type`, and the nested
 * `error.error.type`; direct and nested codes that disagree yield nothing.
 */
export function anthropicProviderDiagnosticFromError(error: unknown): ProviderDiagnostic | undefined {
	try {
		if (!(error instanceof APIError)) return undefined;
		let nestedType: unknown;
		const candidate = error as { status?: unknown; type?: unknown; error?: unknown };
		const status: unknown = candidate.status;
		const statusSupplied = status !== undefined && status !== null;
		const directType: unknown = candidate.type;
		const body = candidate.error;
		if (isPlainRecord(body)) {
			const nested = body.error;
			if (isPlainRecord(nested)) nestedType = nested.type;
		}
		if (directType !== undefined && directType !== null && typeof directType !== "string") return undefined;
		if (nestedType !== undefined && nestedType !== null && typeof nestedType !== "string") return undefined;
		const direct = typeof directType === "string" ? directType : undefined;
		const nested = typeof nestedType === "string" ? nestedType : undefined;
		if (direct !== undefined && nested !== undefined && direct !== nested) return undefined;
		const code = direct ?? nested;
		if (code === undefined && !statusSupplied) return undefined;
		return classifyProviderFacts({ status, statusSupplied, code });
	} catch {
		// A hostile, revoked or half-constructed provider error must never be
		// classified, and must never escape the failure handler.
		return undefined;
	}
}

/**
 * Structured classification of an explicit Anthropic SSE `event: error`
 * envelope, read at the protocol seam before the payload collapses into an
 * `Error` message. The transport status of a streamed error is HTTP 200, so a
 * stream error never carries an HTTP status.
 */
export function anthropicProviderDiagnosticFromSseErrorData(data: string): ProviderDiagnostic | undefined {
	try {
		if (typeof data !== "string") return undefined;
		if (new TextEncoder().encode(data).length > SSE_ERROR_ENVELOPE_MAX_BYTES) return undefined;
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			return undefined;
		}
		if (!isPlainRecord(parsed) || parsed.type !== "error") return undefined;
		const body = parsed.error;
		if (!isPlainRecord(body)) return undefined;
		const code = body.type;
		if (typeof code !== "string") return undefined;
		return classifyProviderFacts({ status: undefined, statusSupplied: false, code });
	} catch {
		return undefined;
	}
}

export { attachProviderDiagnostic } from "./provider-diagnostic-carrier";
