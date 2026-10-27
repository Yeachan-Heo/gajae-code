/**
 * Package-private closed mapping and builder for provider diagnostics.
 *
 * This module is unreachable from the package barrel and from a deep import
 * (`exports` maps `./adapter-internals/*` to null). It is where the vocabulary
 * actually lives, so no consumer can widen it: the mapping is expressed as
 * `switch` statements over string literals rather than a Map or an object
 * literal, because a `ReadonlyMap` is only a TypeScript annotation and even a
 * frozen container can be swapped or shadowed by a determined caller.
 */

import type {
	ProviderDiagnostic,
	ProviderDiagnosticCategory,
	ProviderDiagnosticEvidence,
} from "../provider-diagnostic";

/** Serialized budget for an emitted diagnostic. */
export const DIAGNOSTIC_MAX_BYTES = 512;

/**
 * Exact Anthropic `ErrorType` tokens (pinned SDK 0.94.0) mapped to a canonical
 * category. Exact-token only: no lowercasing, substring, regex or message
 * heuristics. `billing_error` proves a billing failure, NOT specifically quota
 * exhaustion, so it stays `unknown`; the pinned adapter evidences no quota or
 * context-window token, so those categories are reserved and unreachable here
 * rather than inferred.
 */
export function providerCategoryForCode(code: string): ProviderDiagnosticCategory | undefined {
	switch (code) {
		case "authentication_error":
			return "auth";
		case "rate_limit_error":
			return "rate_limit";
		case "invalid_request_error":
			return "invalid_request";
		case "overloaded_error":
		case "api_error":
		case "timeout_error":
			return "provider_unavailable";
		case "billing_error":
		case "permission_error":
		case "not_found_error":
			return "unknown";
		default:
			return undefined;
	}
}

/**
 * The status a recognized code is allowed to arrive with. A code that
 * contradicts the transport status is contradictory evidence, and contradictory
 * evidence produces no diagnostic at all.
 */
export function isCodeStatusCompatible(code: string, status: number): boolean {
	switch (code) {
		case "authentication_error":
			return status === 401;
		case "invalid_request_error":
			return status === 400;
		case "rate_limit_error":
			return status === 429;
		case "overloaded_error":
		case "api_error":
		case "timeout_error":
			return status >= 500 && status <= 599;
		case "billing_error":
			return status === 402;
		case "permission_error":
			return status === 403;
		case "not_found_error":
			return status === 404;
		default:
			return false;
	}
}

/** Status-only classification. 402/403/429 alone cannot decide a family. */
export function categoryForStatus(status: number): ProviderDiagnosticCategory {
	if (status === 401) return "auth";
	if (status === 400) return "invalid_request";
	if (status >= 500 && status <= 599) return "provider_unavailable";
	return "unknown";
}

export function isValidDiagnosticStatus(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599;
}

/** True only for a genuine plain data record; hostile objects fail closed. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
	try {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	} catch {
		return false;
	}
}

/** Fresh flat object, one validated field at a time, within the size budget. */
export function buildProviderDiagnostic(input: {
	category: ProviderDiagnosticCategory;
	httpStatus?: number;
	code?: string;
	evidence: ProviderDiagnosticEvidence;
}): ProviderDiagnostic | undefined {
	const diagnostic: ProviderDiagnostic = { category: input.category, evidence: input.evidence };
	if (input.httpStatus !== undefined) diagnostic.httpStatus = input.httpStatus;
	if (input.code !== undefined) diagnostic.code = input.code;
	const size = new TextEncoder().encode(JSON.stringify(diagnostic)).length;
	return size <= DIAGNOSTIC_MAX_BYTES ? diagnostic : undefined;
}

/**
 * Classify from already-extracted structured facts.
 *
 * `statusSupplied` distinguishes "the provider sent no status" (fine — a code
 * alone can classify) from "the provider sent a status this seam cannot trust"
 * (fail closed: no diagnostic at all).
 */
export function classifyProviderFacts(facts: {
	status: unknown;
	statusSupplied: boolean;
	code: string | undefined;
}): ProviderDiagnostic | undefined {
	if (facts.statusSupplied && !isValidDiagnosticStatus(facts.status)) return undefined;
	const status = facts.statusSupplied ? (facts.status as number) : undefined;
	const category = facts.code === undefined ? undefined : providerCategoryForCode(facts.code);
	if (facts.code !== undefined && category !== undefined) {
		if (status !== undefined && !isCodeStatusCompatible(facts.code, status)) return undefined;
		return buildProviderDiagnostic({
			category,
			...(status === undefined ? {} : { httpStatus: status }),
			code: facts.code,
			evidence: "structured_code",
		});
	}
	// An unrecognized provider code proves nothing and is discarded; only an
	// independently valid status may still classify.
	if (status === undefined) return undefined;
	return buildProviderDiagnostic({
		category: categoryForStatus(status),
		httpStatus: status,
		evidence: "structured_status",
	});
}

/**
 * Re-validate a diagnostic that crossed a boundary and return a CANONICAL fresh
 * object. Closed vocabulary alone is not enough: the fields must describe the
 * one classification the fixed mapping would have produced from the same
 * evidence, and every extra key is dropped by reconstruction rather than
 * carried along.
 */
export function sanitizeDiagnostic(value: unknown): ProviderDiagnostic | undefined {
	try {
		if (!isPlainRecord(value)) return undefined;
		let category: unknown;
		let evidence: unknown;
		let httpStatus: unknown;
		let code: unknown;
		try {
			category = value.category;
			evidence = value.evidence;
			httpStatus = value.httpStatus;
			code = value.code;
		} catch {
			return undefined;
		}
		if (typeof category !== "string") return undefined;
		if (evidence !== "structured_status" && evidence !== "structured_code") return undefined;
		if (httpStatus !== undefined && !isValidDiagnosticStatus(httpStatus)) return undefined;
		if (evidence === "structured_status") {
			if (code !== undefined) return undefined;
			if (!isValidDiagnosticStatus(httpStatus)) return undefined;
			if (category !== categoryForStatus(httpStatus)) return undefined;
			return buildProviderDiagnostic({ category, httpStatus, evidence });
		}
		if (typeof code !== "string") return undefined;
		const expected = providerCategoryForCode(code);
		if (expected === undefined || expected !== category) return undefined;
		if (httpStatus !== undefined && !isCodeStatusCompatible(code, httpStatus)) return undefined;
		return buildProviderDiagnostic({
			category,
			...(httpStatus === undefined ? {} : { httpStatus }),
			code,
			evidence,
		});
	} catch {
		return undefined;
	}
}
