export type FallbackTriggerClass = "rate_limit" | "quota" | "auth" | "server" | "unknown" | "other";

export interface FallbackTrigger {
	class: FallbackTriggerClass;
	retryAfterMs?: number;
}

export type TransportHeaders = Headers | Record<string, string | undefined>;

/**
 * Structured facts from an upstream HTTP or transport failure. Retry decisions
 * must use these facts rather than provider- or application-owned error text.
 *
 * `headers` is always a plain record limited to the retained retry-signal
 * entries: facts travel on persisted `AssistantMessage`s and through
 * `structuredClone` snapshots (managed fallback attempt staging), so they must
 * never carry a live `Headers` instance — cloning one throws `DataCloneError`
 * ("The object can not be cloned.") and masks the real provider failure.
 */
export interface TransportFailureFacts {
	kind: "transport";
	status?: number;
	/** Canonical provider error code used for fallback classification. */
	providerCode?: string;
	/** Anthropic's typed `error.type`, preserved separately at the transport boundary. */
	anthropicErrorType?: string;
	/** OpenAI's typed `error.code`, preserved separately at the transport boundary. */
	openaiErrorCode?: string;
	headers?: Record<string, string>;
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
	try {
		return value instanceof Headers || (!!value && typeof value === "object");
	} catch {
		return false;
	}
}

function propertyOf(value: unknown, name: string): unknown {
	if (!value || typeof value !== "object") return undefined;
	try {
		return Reflect.get(value, name);
	} catch {
		return undefined;
	}
}

function finiteStatus(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Retry-signal headers retained on transport facts; everything else is dropped. */
const RETAINED_TRANSPORT_HEADERS = ["retry-after", "retry-after-ms"] as const;

const RETAINED_TRANSPORT_HEADER_SET: ReadonlySet<string> = new Set(RETAINED_TRANSPORT_HEADERS);

/**
 * Reduce transport headers to the retained retry-signal entries in a plain
 * record, so facts stay structured-cloneable and JSON-serializable and never
 * persist arbitrary response headers into session files.
 *
 * Exception-safe by contract: inspection uses only `Headers.get()` results
 * that are primitive strings or own data-descriptor record entries. Any
 * failure omits headers instead of throwing — status/providerCode facts
 * extracted by the caller must survive a hostile headers object.
 */
function retainedHeaderRecord(headers: TransportHeaders | undefined): Record<string, string> | undefined {
	if (headers === undefined) return undefined;
	let record: Record<string, string> | undefined;
	try {
		if (headers instanceof Headers) {
			for (const name of RETAINED_TRANSPORT_HEADERS) {
				const value = headers.get(name);
				if (typeof value !== "string") continue;
				record ??= {};
				record[name] = value;
			}
			return record;
		}
		for (const key of Object.keys(headers)) {
			const descriptor = Object.getOwnPropertyDescriptor(headers, key);
			if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") continue;
			const name = key.toLowerCase();
			if (!RETAINED_TRANSPORT_HEADER_SET.has(name)) continue;
			record ??= {};
			record[name] = descriptor.value;
		}
		return record;
	} catch {
		return undefined;
	}
}

/** Extracts only explicit HTTP/transport metadata; it never parses error text. */
export function transportFailureFacts(
	error: unknown,
	capturedResponse?: { status?: number; headers?: TransportHeaders },
): TransportFailureFacts | undefined {
	if (!error || typeof error !== "object") return undefined;
	const value = error as FallbackTriggerInput & { kind?: unknown; type?: unknown };
	const response = propertyOf(value, "response");
	const nestedError = propertyOf(value, "error");
	const status =
		finiteStatus(propertyOf(value, "status")) ??
		finiteStatus(propertyOf(response, "status")) ??
		finiteStatus(propertyOf(capturedResponse, "status"));
	const anthropicErrorType = stringValue(propertyOf(nestedError, "type")) ?? stringValue(propertyOf(value, "type"));
	const openaiErrorCode =
		stringValue(propertyOf(value, "openaiErrorCode")) ?? stringValue(propertyOf(nestedError, "code"));
	const providerCode =
		stringValue(propertyOf(value, "providerCode")) ??
		openaiErrorCode ??
		stringValue(propertyOf(value, "code")) ??
		anthropicErrorType;
	const errorHeaders = propertyOf(value, "headers");
	const responseHeaders = propertyOf(response, "headers");
	const capturedHeaders = propertyOf(capturedResponse, "headers");
	const rawHeaders = isTransportHeaders(errorHeaders)
		? errorHeaders
		: isTransportHeaders(responseHeaders)
			? responseHeaders
			: isTransportHeaders(capturedHeaders)
				? capturedHeaders
				: undefined;
	// Normalize BEFORE the existence gate so normalization is idempotent:
	// facts built from an error whose headers carry no retained retry signal
	// must not exist on the first pass and then vanish when re-normalized
	// (consumers deliberately re-run transportFailureFacts on embedded facts).
	const headers = retainedHeaderRecord(rawHeaders);
	const normalizedCode = providerCode?.toLowerCase();
	if (
		status === undefined &&
		headers === undefined &&
		!isQuotaCode(normalizedCode) &&
		!isAuthCode(normalizedCode) &&
		!isRateLimitCode(normalizedCode) &&
		!isContextOverflowCode(normalizedCode)
	) {
		return undefined;
	}
	return { kind: "transport", status, providerCode, anthropicErrorType, openaiErrorCode, headers };
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

function isContextOverflowCode(code: string | undefined): boolean {
	return code === "context_length_exceeded";
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
	const code = (facts.openaiErrorCode ?? facts.anthropicErrorType ?? facts.providerCode)?.toLowerCase();
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
