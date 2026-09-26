/**
 * Bounded, redaction-safe provider failure classification — public surface.
 *
 * The diagnostic exists so a consumer can tell an auth rejection apart from a
 * rate limit or an upstream outage WITHOUT reading provider text. Every field is
 * a closed-vocabulary literal or a validated integer status.
 *
 * This module exposes exactly what a consumer needs: the DTO types, the byte
 * budget, a revalidating reader for a value that crossed a boundary, and a
 * reader for the adapter-owned carrier. The vocabulary, the builder and the
 * classifier live in `./adapter-internals/provider-diagnostic-mapping`, which
 * the package `exports` map blocks from deep import, so no consumer can widen
 * the closed allowlist the validator depends on or mint a diagnostic.
 */

import { peekProviderDiagnostic } from "./adapter-internals/provider-diagnostic-carrier";
import { DIAGNOSTIC_MAX_BYTES, sanitizeDiagnostic } from "./adapter-internals/provider-diagnostic-mapping";

/** Closed failure families. `unknown` is preserved rather than guessed. */
export type ProviderDiagnosticCategory =
	| "auth"
	| "rate_limit"
	| "quota"
	| "context_limit"
	| "invalid_request"
	| "provider_unavailable"
	| "unknown";

/** Which structured provider field the category was derived from. */
export type ProviderDiagnosticEvidence = "structured_status" | "structured_code";

export interface ProviderDiagnostic {
	category: ProviderDiagnosticCategory;
	/** Provider HTTP status, integer 400..599 only. Absent for in-stream errors. */
	httpStatus?: number;
	/** Canonical provider classifier token from the closed allowlist. */
	code?: string;
	evidence: ProviderDiagnosticEvidence;
}

/** Serialized budget for the emitted diagnostic. */
export const PROVIDER_DIAGNOSTIC_MAX_BYTES = DIAGNOSTIC_MAX_BYTES;

/**
 * Re-validate a diagnostic that crossed a boundary (wire DTO, durable record,
 * managed snapshot) and return a CANONICAL FRESH object.
 *
 * The returned value is always rebuilt field by field, so a record whose core
 * fields are valid but which carries extra keys (or an oversized payload in
 * one) cannot pass through untouched. Anything whose fields do not describe the
 * one classification the fixed mapping implies is dropped WHOLE — a malformed
 * diagnostic must never invalidate the legacy record carrying it, and must
 * never be forwarded as if it were trusted.
 */
export function sanitizeProviderDiagnostic(value: unknown): ProviderDiagnostic | undefined {
	return sanitizeDiagnostic(value);
}

/**
 * Read the adapter-owned diagnostic carried alongside a thrown provider error,
 * as a freshly validated snapshot. A self-declared `providerDiagnostic`
 * property on a foreign error reads as absent, because it never entered the
 * carrier, and a caller that mutates the returned object cannot affect what the
 * carrier holds.
 */
export function readProviderDiagnostic(error: unknown): ProviderDiagnostic | undefined {
	return sanitizeDiagnostic(peekProviderDiagnostic(error));
}
