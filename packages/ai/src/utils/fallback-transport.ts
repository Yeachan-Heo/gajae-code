export type FallbackTriggerClass = "rate_limit" | "quota" | "auth" | "server" | "other";

export interface FallbackTrigger {
	class: FallbackTriggerClass;
	retryAfterMs?: number;
}

export type TransportHeaders = Headers | Record<string, string | undefined>;

/**
 * Structured facts from an upstream HTTP or transport failure. Retry decisions
 * must use these facts rather than provider- or application-owned error text.
 */
export interface TransportFailureFacts {
	kind: "transport";
	status?: number;
	providerCode?: string;
	headers?: TransportHeaders;
}

/** Opaque per-invocation marker required by managed fallback transport calls. */
export interface FallbackAttemptToken {
	readonly modelKey: string;
	readonly attemptId: string | number;
}

const issuedAttemptTokens = new WeakSet<object>();
const consumedAttemptTokens = new WeakSet<object>();

/**
 * Marks a single outer fallback invocation. Accounting belongs to the caller;
 * this token prevents managed transport calls from silently bypassing it.
 */
export function beginAttempt(modelKey: string, attemptId: string | number): FallbackAttemptToken {
	const token = Object.freeze({ modelKey, attemptId });
	issuedAttemptTokens.add(token);
	return token;
}

export function assertManagedAttempt(
	options: { fallbackManaged?: boolean; fallbackAttempt?: FallbackAttemptToken } | undefined,
): void {
	if (!options?.fallbackManaged) return;
	const token = options.fallbackAttempt;
	if (!token || !issuedAttemptTokens.has(token)) {
		throw new Error("fallbackManaged transport invocation requires a token returned by beginAttempt()");
	}
	if (consumedAttemptTokens.has(token)) {
		throw new Error("fallbackManaged transport invocation cannot reuse a beginAttempt() token");
	}
	consumedAttemptTokens.add(token);
}

/**
 * Compatibility input for callers that have not yet wrapped their HTTP facts
 * in the discriminated form. Only its structured fields are inspected.
 */
export interface FallbackTriggerInput {
	status?: number;
	providerCode?: string;
	code?: string;
	headers?: TransportHeaders;
	response?: { status?: number; headers?: TransportHeaders };
	error?: { code?: string; type?: string };
}

function isTransportHeaders(value: unknown): value is TransportHeaders {
	return value instanceof Headers || (!!value && typeof value === "object");
}

/** Extracts only explicit HTTP/transport metadata; it never parses error text. */
export function transportFailureFacts(
	error: unknown,
	capturedResponse?: { status?: number; headers?: TransportHeaders },
): TransportFailureFacts | undefined {
	if (!error || typeof error !== "object") return undefined;
	const value = error as FallbackTriggerInput & { kind?: unknown; type?: unknown };
	const status =
		typeof value.status === "number"
			? value.status
			: typeof value.response?.status === "number"
				? value.response.status
				: capturedResponse?.status;
	const providerCode =
		typeof value.providerCode === "string"
			? value.providerCode
			: typeof value.code === "string"
				? value.code
				: typeof value.error?.code === "string"
					? value.error.code
					: typeof value.type === "string"
						? value.type
						: typeof value.error?.type === "string"
							? value.error.type
							: undefined;
	const headers = isTransportHeaders(value.headers)
		? value.headers
		: isTransportHeaders(value.response?.headers)
			? value.response.headers
			: capturedResponse?.headers;
	const normalizedCode = providerCode?.toLowerCase();
	if (
		status === undefined &&
		headers === undefined &&
		!isQuotaCode(normalizedCode) &&
		!isAuthCode(normalizedCode) &&
		!isRateLimitCode(normalizedCode)
	) {
		return undefined;
	}
	return { kind: "transport", status, providerCode, headers };
}

function headersOf(headers: TransportHeaders | undefined): Headers | undefined {
	if (headers instanceof Headers) return headers;
	return headers ? new Headers(headers as Record<string, string>) : undefined;
}

function parseRetryAfterSeconds(value: string | null, now = Date.now()): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function parseRetryAfterMilliseconds(value: string | null): number | undefined {
	if (!value) return undefined;
	const milliseconds = Number(value);
	return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.round(milliseconds) : undefined;
}

function isQuotaCode(code: string | undefined): boolean {
	return (
		code === "insufficient_quota" ||
		code === "quota_exceeded" ||
		code === "quota_exhausted" ||
		code === "usage_limit_reached" ||
		code === "usage_not_included" ||
		code === "out_of_credits"
	);
}

function isAuthCode(code: string | undefined): boolean {
	return (
		code === "authentication_error" ||
		code === "invalid_api_key" ||
		code === "invalid_token" ||
		code === "token_expired" ||
		code === "unauthorized" ||
		code === "forbidden"
	);
}

function isRateLimitCode(code: string | undefined): boolean {
	return (
		code === "rate_limit" ||
		code === "rate_limit_error" ||
		code === "rate_limit_exceeded" ||
		code === "too_many_requests"
	);
}

/** Classifies only typed upstream transport facts without consuming response bodies. */
export function classifyFallbackTrigger(
	errorOrFacts: TransportFailureFacts | FallbackTriggerInput | unknown,
): FallbackTrigger {
	const facts = transportFailureFacts(errorOrFacts);
	if (!facts) return { class: "other" };
	const headers = headersOf(facts.headers);
	const retryAfterMs =
		parseRetryAfterMilliseconds(headers?.get("retry-after-ms") ?? null) ??
		parseRetryAfterSeconds(headers?.get("retry-after") ?? null);
	const code = facts.providerCode?.toLowerCase();
	const triggerClass: FallbackTriggerClass = isQuotaCode(code)
		? "quota"
		: facts.status === 401 || facts.status === 403 || isAuthCode(code)
			? "auth"
			: facts.status === 429 || isRateLimitCode(code)
				? "rate_limit"
				: facts.status !== undefined && facts.status >= 500 && facts.status <= 599
					? "server"
					: "other";
	return retryAfterMs === undefined ? { class: triggerClass } : { class: triggerClass, retryAfterMs };
}
