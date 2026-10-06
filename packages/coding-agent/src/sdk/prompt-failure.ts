/**
 * Safe failure shaping shared by SDK transports and reconciliation stores.
 * Provider error text is retained only in the local diagnostic log; wire and
 * persisted reconciliation details expose a fixed redacted message.
 */
import type { ProviderDiagnostic } from "@gajae-code/ai/core";
import { sanitizeProviderDiagnostic } from "@gajae-code/ai/core";
import { sanitizeExternalCrashV1 } from "../crash/sanitize";
import type {
	SdkPromptFailureCategory,
	SdkPromptFailurePhase,
	SdkPromptFailureRetryability,
	SdkPromptTerminalOutcome,
} from "./prompt-status";

export const PROMPT_FAILURE_CODE_MAX = 64;
const LOCAL_FAILURE_LOG_MAX = 16_384;
export const FAILURE_CAUSE_DIAGNOSTIC_MAX = 200; // Max length for failureCauseDiagnostic field

export const PROMPT_FAILURE_MESSAGE_SUBMISSION = "Prompt submission failed.";
export const PROMPT_FAILURE_MESSAGE_POST_START_PROVIDER = "Provider failure after execution started.";
export const PROMPT_FAILURE_MESSAGE_POST_START_AGENT = "Agent run failed after execution started.";
export const PROMPT_FAILURE_MESSAGE_DEADLINE = "Prompt deadline exceeded.";

/** Evidence that decides whether a failure happened before or after the run started. */
export interface PromptFailureEvidence {
	startedAt?: number;
	hasActivity?: boolean;
}

/** Start/activity evidence for phase derivation from a reconciliation record. */
export function failureEvidence(record: { startedAt?: number }, hasActivity?: boolean): PromptFailureEvidence {
	return {
		...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
		...(hasActivity === true ? { hasActivity: true } : {}),
	};
}

/**
 * Bounded classifier sets. Only these safe tokens may select a category; any
 * other value (including `undefined`) stays `unknown` instead of guessing, so
 * an unrecognized or provider-invented code cannot masquerade as a known class.
 */
const PROVIDER_TRANSPORT_CODES = new Set([
	"provider_down",
	"provider_unavailable",
	"upstream_stream_interrupted",
	"upstream_error",
	"transport_reset",
	"stream_first_event_timeout",
	"empty_response",
	"server_is_overloaded",
]);
const PROVIDER_REJECTED_CODES = new Set(["provider_rejected", "provider_http_402", "provider_http_429"]);
const AGENT_RUNTIME_CODES = new Set([
	"agent_failed",
	"internal",
	"local_snapshot_failure",
	"local_buffer_overflow",
	"argument_validation",
	"execution",
	"io_error",
	"skill_runtime",
	"escaped_arguments_discarded",
	"prompt_failed",
	"aborted",
]);

/** Whether the run had already started when the failure was recorded. */
export function promptFailurePhase(evidence: PromptFailureEvidence): SdkPromptFailurePhase {
	return evidence.startedAt !== undefined || evidence.hasActivity === true ? "post_start" : "submission";
}

export function isSdkPromptFailurePhase(value: unknown): value is SdkPromptFailurePhase {
	return value === "submission" || value === "post_start";
}

/** Allowlisted origin category for a bounded safe classifier + provenance. */
export function promptFailureCategory(
	code: string | undefined,
	provenance: "agent_failed" | "deadline",
): SdkPromptFailureCategory {
	if (provenance === "deadline" || code === "prompt_deadline_exceeded") return "deadline";
	if (code === undefined) return "unknown";
	if (PROVIDER_TRANSPORT_CODES.has(code) || /^provider_http_5\d\d$/.test(code)) return "provider_transport";
	if (PROVIDER_REJECTED_CODES.has(code) || /^provider_http_4\d\d$/.test(code)) return "provider_rejected";
	if (AGENT_RUNTIME_CODES.has(code)) return "agent_runtime";
	return "unknown";
}

/**
 * Whether the bounded category says an identical re-submission could still
 * succeed. Read off the category alone, so it cannot drift from the sets above.
 *
 * `provider_transport` is the only transient class: every classifier in
 * `PROVIDER_TRANSPORT_CODES` (and the 5xx range) describes the link to the
 * provider failing, never a judgement about the request, so the same bytes may
 * well succeed on a second attempt. That is exactly the class the shipped
 * first-turn gate (`isStartupReadinessFailure`, issue #5574) already treats as
 * re-submittable, so the wire signal and the internal gate stay in agreement.
 *
 * Everything else is terminal for this turn: `provider_rejected` is the provider
 * judging this request (quota, refusal, 4xx) and re-sending it reproduces the
 * rejection; `deadline` means the turn's budget is spent, which a re-submit does
 * not restore; `agent_runtime` is a local fault that re-running the same prompt
 * re-enters. `unknown` stays `unknown` — the module's standing contract is to
 * preserve uncertain attribution rather than guess a recovery for it.
 *
 * This is advisory classification for the caller, not a retry gate: nothing in
 * this repo's retry paths consults it.
 */
export function promptFailureRetryability(category: SdkPromptFailureCategory): SdkPromptFailureRetryability {
	if (category === "provider_transport") return "transient";
	if (category === "unknown") return "unknown";
	return "terminal";
}

/**
 * Whether a value is a safe bounded classifier token — the same rule
 * `sanitizePromptFailure` and `assistantFailureCode` apply before retaining one.
 * Anything else is provider text rather than a classifier and must not be
 * forwarded to a caller.
 */
export function isSafePromptFailureCode(value: unknown): value is string {
	return typeof value === "string" && value.length <= PROMPT_FAILURE_CODE_MAX && /^[A-Za-z0-9._-]+$/.test(value);
}

/**
 * Phase- and category-aware safe wording. A post-start failure is never
 * described as a submission rejection; the wording says only what the bounded
 * category actually proves.
 */
export function promptFailureMessage(phase: SdkPromptFailurePhase, category: SdkPromptFailureCategory): string {
	if (category === "deadline") return PROMPT_FAILURE_MESSAGE_DEADLINE;
	if (phase === "submission") return PROMPT_FAILURE_MESSAGE_SUBMISSION;
	if (category === "provider_transport" || category === "provider_rejected")
		return PROMPT_FAILURE_MESSAGE_POST_START_PROVIDER;
	return PROMPT_FAILURE_MESSAGE_POST_START_AGENT;
}

/**
 * Recompute `phase`, `category` and `message` for a failed outcome from the
 * bounded classifier plus the record's start/activity evidence. Non-failed
 * outcomes pass through untouched. Idempotent. Revalidates failureCauseDiagnostic.
 */
export function rephaseFailedOutcome(
	outcome: SdkPromptTerminalOutcome,
	evidence: PromptFailureEvidence,
): SdkPromptTerminalOutcome {
	if (outcome.kind !== "failed") return outcome;
	const category = promptFailureCategory(outcome.providerCode ?? outcome.code, outcome.provenance);
	const phase = promptFailurePhase(evidence);
	const message = promptFailureMessage(phase, category);
	// A decoded durable outcome may carry a malformed diagnostic, or a valid core
	// with extra keys the sanitizer would drop. Replace it with the canonical
	// object either way: comparing only presence let a valid-core value keep
	// arbitrary extras (and their bytes) all the way to the public result.
	const diagnostic = sanitizeProviderDiagnostic(outcome.providerDiagnostic);
	const diagnosticChanged = !isCanonicalDiagnostic(outcome.providerDiagnostic, diagnostic);
	const failureCauseDiagnosticValid = isValidFailureCauseDiagnostic(outcome.failureCauseDiagnostic);
	if (
		category === outcome.category &&
		phase === outcome.phase &&
		message === outcome.message &&
		!diagnosticChanged &&
		failureCauseDiagnosticValid
	)
		return outcome;
	const rephased = { ...outcome, category, phase, message };
	if (diagnostic === undefined) delete rephased.providerDiagnostic;
	else rephased.providerDiagnostic = diagnostic;
	if (!failureCauseDiagnosticValid) delete rephased.failureCauseDiagnostic;
	return rephased;
}

/** Build a complete failed outcome from a bounded classifier and evidence. */
export function failedPromptOutcome(input: {
	code: "prompt_failed" | "prompt_deadline_exceeded";
	provenance: "agent_failed" | "deadline";
	providerCode?: string;
	phase?: SdkPromptFailurePhase;
	evidence: PromptFailureEvidence;
	/** Revalidated here; a malformed value is dropped, never partially kept. */
	providerDiagnostic?: ProviderDiagnostic;
	/** Error to extract bounded diagnostic from for operator logs (#408). */
	error?: unknown;
}): Extract<SdkPromptTerminalOutcome, { kind: "failed" }> {
	const category = promptFailureCategory(input.providerCode ?? input.code, input.provenance);
	const phase = input.phase ?? promptFailurePhase(input.evidence);
	return {
		kind: "failed",
		code: input.code,
		message: promptFailureMessage(phase, category),
		provenance: input.provenance,
		phase,
		category,
		...(input.providerCode !== undefined ? { providerCode: input.providerCode } : {}),
		...providerDiagnosticField(input.providerDiagnostic),
		...(input.error !== undefined ? { failureCauseDiagnostic: failureCauseDiagnostic(input.error) } : {}),
	};
}

/**
 * Whether the stored value is already exactly the canonical diagnostic: same
 * presence, same own keys, same values. An extra key, a changed value or a
 * non-record makes it non-canonical, so callers rewrite it.
 */
function isCanonicalDiagnostic(stored: unknown, canonical: ProviderDiagnostic | undefined): boolean {
	if (canonical === undefined) return stored === undefined;
	if (stored === null || typeof stored !== "object") return false;
	try {
		// Fail closed on anything that is not a plain own-data record: an inherited
		// `toJSON`, a getter, a symbol key or a non-enumerable property can carry a
		// payload that matching keys and values never reveal, and returning the
		// original would publish it verbatim.
		if (Object.getPrototypeOf(stored) !== Object.prototype) return false;
		if (Object.getOwnPropertySymbols(stored).length > 0) return false;
		const storedNames = Object.getOwnPropertyNames(stored);
		const canonicalNames = Object.getOwnPropertyNames(canonical);
		if (storedNames.length !== canonicalNames.length) return false;
		return canonicalNames.every(name => {
			const descriptor = Object.getOwnPropertyDescriptor(stored, name);
			if (!descriptor?.enumerable || !("value" in descriptor)) return false;
			return descriptor.value === (canonical as unknown as Record<string, unknown>)[name];
		});
	} catch {
		return false;
	}
}

/**
 * Public projection of a terminal outcome: a fresh object whose optional
 * diagnostics are re-validated and rebuilt, so a caller that mutates the returned
 * DTO cannot reach stored reconciliation state.
 */
export function publicTerminalOutcome<T extends SdkPromptTerminalOutcome | undefined>(outcome: T): T {
	if (outcome === undefined || outcome.kind !== "failed") return outcome;
	// Remove the stored values FIRST, then re-add only validated canonical
	// snapshots: spreading an empty validation result over the original left a
	// rejected diagnostic in place, which is exactly the value that must not ship.
	const failed = outcome as Extract<SdkPromptTerminalOutcome, { kind: "failed" }>;
	const projected: Extract<SdkPromptTerminalOutcome, { kind: "failed" }> = { ...failed };
	delete projected.providerDiagnostic;
	delete projected.failureCauseDiagnostic;
	const validated = providerDiagnosticField(failed.providerDiagnostic);
	if (validated.providerDiagnostic !== undefined) projected.providerDiagnostic = validated.providerDiagnostic;
	// Drop malformed or tampered diagnostics rather than republishing secrets.
	const diagnostic = redactedFailureCauseDiagnostic(failed.failureCauseDiagnostic);
	if (diagnostic !== undefined) {
		projected.failureCauseDiagnostic = diagnostic;
	}
	return projected as T;
}

/** `{ providerDiagnostic }` only when the value survives closed revalidation. */
export function providerDiagnosticField(value: unknown): { providerDiagnostic?: ProviderDiagnostic } {
	const providerDiagnostic = sanitizeProviderDiagnostic(value);
	return providerDiagnostic === undefined ? {} : { providerDiagnostic };
}

/**
 * Bounded provider diagnostic carried by an `agent_failed` diagnostic. The
 * value is revalidated here, so neither a legacy record nor a hostile payload
 * can inject an unchecked classification.
 */
export function failureProviderDiagnostic(failure: unknown): ProviderDiagnostic | undefined {
	try {
		const candidate = failure as { providerDiagnostic?: unknown } | undefined;
		return sanitizeProviderDiagnostic(candidate?.providerDiagnostic);
	} catch {
		return undefined;
	}
}

/**
 * Bounded safe classifier read off a terminal assistant message: the provider's
 * own `errorCode`, else the typed transport fact's `providerCode`. Only a safe
 * token is accepted; anything else is dropped rather than forwarded.
 */
export function assistantFailureCode(assistant: unknown): string | undefined {
	try {
		const candidate = assistant as { errorCode?: unknown; transportFailure?: { providerCode?: unknown } } | undefined;
		const direct = candidate?.errorCode;
		if (typeof direct === "string" && direct.length <= PROMPT_FAILURE_CODE_MAX && /^[A-Za-z0-9._-]+$/.test(direct))
			return direct;
		const transport = candidate?.transportFailure?.providerCode;
		if (
			typeof transport === "string" &&
			transport.length <= PROMPT_FAILURE_CODE_MAX &&
			/^[A-Za-z0-9._-]+$/.test(transport)
		)
			return transport;
		return undefined;
	} catch {
		return undefined;
	}
}

/** Safe-token code capped at 64; arbitrary failure text is never retained. */
export function sanitizePromptFailure(error: unknown): { code: string; message: string } {
	let rawCode = "";
	try {
		const candidate = error as { code?: unknown } | undefined;
		rawCode = typeof candidate?.code === "string" ? candidate.code : "";
	} catch {
		// Untrusted error records may expose throwing accessors.
	}
	const code = rawCode.length <= PROMPT_FAILURE_CODE_MAX && /^[A-Za-z0-9._-]+$/.test(rawCode) ? rawCode : "internal";
	return { code, message: "Prompt submission failed." };
}

/**
 * Publication/recovery projection of a failure cause: the existing bounded
 * `code`/`message` exactly as before, plus the validated optional diagnostic
 * when the cause carried one.
 *
 * Kept separate from `sanitizePromptFailure` on purpose: that result is what
 * durable records store as `error`, and widening the persisted failure shape is
 * not part of this contract.
 */
export function publishedPromptFailure(error: unknown): {
	code: string;
	message: string;
	providerDiagnostic?: ProviderDiagnostic;
} {
	return { ...sanitizePromptFailure(error), ...providerDiagnosticField(failureProviderDiagnostic(error)) };
}

/**
 * Whether a value is a valid failure cause diagnostic. Exact shape: string, non-empty,
 * length ≤200. Extra keys, modified type, or absence makes it invalid so callers
 * rewrite it. Used by reconciliation validation and durable outcome republish gates.
 */
export function isValidFailureCauseDiagnostic(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= FAILURE_CAUSE_DIAGNOSTIC_MAX;
}

/** Revalidate stored diagnostics with outbound sanitizer; a value changed by sanitization is not trusted. */
export function redactedFailureCauseDiagnostic(value: unknown): string | undefined {
	if (!isValidFailureCauseDiagnostic(value)) return undefined;
	const verdict = sanitizeExternalCrashV1(value, FAILURE_CAUSE_DIAGNOSTIC_MAX);
	return verdict.ok && verdict.value === value ? verdict.value : undefined;
}

/**
 * `agent_failed` events carry an error already sanitized to the fixed public
 * message, plus the diagnostic AgentSession captured from the original error.
 * Attach that diagnostic to the lifecycle failure cause so the host retains it.
 */
export function agentFailedLifecycleCause(error: unknown, diagnostic: string | undefined): unknown {
	if (diagnostic === undefined || error === null || typeof error !== "object") return error;
	return { ...error, failureCauseDiagnostic: diagnostic };
}

/** Diagnostic for a lifecycle failure cause: a carried diagnostic wins over re-deriving one from the (sanitized) error. */
export function lifecycleFailureCauseDiagnostic(failureCause: unknown): string | undefined {
	if (failureCause !== null && typeof failureCause === "object" && "failureCauseDiagnostic" in failureCause) {
		const carried = redactedFailureCauseDiagnostic(failureCause.failureCauseDiagnostic);
		if (carried !== undefined) return carried;
	}
	return failureCauseDiagnostic(failureCause);
}

/**
 * Extract a bounded failure cause diagnostic for operator logs: error class name,
 * first line of message, and exit code/signal if available. Bounded to 200 chars,
 * sanitized for outbound publication (strips paths, URLs, ANSI, credentials, identifiers).
 * Used for #408 to provide real cause in terminal_failure logs.
 */
export function failureCauseDiagnostic(error: unknown): string | undefined {
	if (error === null || error === undefined) return undefined;
	try {
		let className = "Error";
		let message = "";
		let exitSignal = "";

		if (error instanceof Error) {
			className = error.constructor?.name || "Error";
			// Extract first line of message only
			const firstLine = (error.message || "").split("\n")[0] || "";
			message = firstLine.slice(0, 100);
			// Check for exitCode, signal, or code properties on Error instances
			const errorAsObj = error as { signal?: unknown; exitCode?: unknown; code?: unknown };
			if (
				typeof errorAsObj.signal === "string" &&
				["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGINT"].includes(errorAsObj.signal)
			) {
				exitSignal = `signal=${errorAsObj.signal}`;
			} else if (
				typeof errorAsObj.exitCode === "number" &&
				Number.isInteger(errorAsObj.exitCode) &&
				errorAsObj.exitCode >= 0 &&
				errorAsObj.exitCode <= 255
			) {
				exitSignal = `exit=${errorAsObj.exitCode}`;
			} else if (
				typeof errorAsObj.code === "number" &&
				Number.isInteger(errorAsObj.code) &&
				errorAsObj.code >= 0 &&
				errorAsObj.code <= 255
			) {
				exitSignal = `code=${errorAsObj.code}`;
			}
		} else if (typeof error === "string") {
			message = error.split("\n")[0]?.slice(0, 100) || "";
		} else if (error !== null && typeof error === "object") {
			const candidate = error as {
				code?: unknown;
				message?: unknown;
				signal?: unknown;
				exitCode?: unknown;
				className?: unknown;
			};
			if (typeof candidate.className === "string") className = candidate.className;
			if (typeof candidate.message === "string") {
				const firstLine = candidate.message.split("\n")[0] || "";
				message = firstLine.slice(0, 100);
			}
			if (
				typeof candidate.signal === "string" &&
				["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGINT"].includes(candidate.signal)
			) {
				exitSignal = `signal=${candidate.signal}`;
			} else if (
				typeof candidate.exitCode === "number" &&
				Number.isInteger(candidate.exitCode) &&
				candidate.exitCode >= 0 &&
				candidate.exitCode <= 255
			) {
				exitSignal = `exit=${candidate.exitCode}`;
			} else if (
				typeof candidate.code === "number" &&
				Number.isInteger(candidate.code) &&
				candidate.code >= 0 &&
				candidate.code <= 255
			) {
				exitSignal = `code=${candidate.code}`;
			}
		}

		const parts = [className, message, exitSignal].filter(Boolean);
		const diagnostic = parts.join(" ");
		// Sanitize for outbound publication: strips paths, URLs, ANSI, credentials, and high-entropy identifiers
		const verdict = sanitizeExternalCrashV1(diagnostic, FAILURE_CAUSE_DIAGNOSTIC_MAX);
		if (!verdict.ok) return undefined;
		// Enforce the cap after sanitization: sanitizeExternalCrashV1 may append …[truncated]
		// which can exceed the original maxBytes, so re-truncate if necessary.
		const sanitized = verdict.value;
		if (Buffer.byteLength(sanitized, "utf8") <= FAILURE_CAUSE_DIAGNOSTIC_MAX) return sanitized;
		const bytes = Buffer.from(sanitized, "utf8");
		let end = FAILURE_CAUSE_DIAGNOSTIC_MAX;
		while (end > 0 && ((bytes[end - 1] ?? 0) & 0xc0) === 0x80) end--;
		if (end > 0 && (bytes[end - 1] ?? 0) >= 0xc0) end--;
		return bytes.subarray(0, end).toString("utf8");
	} catch {
		return undefined;
	}
}

/** Best-effort local diagnostic text that never crosses the SDK boundary. */
export function formatPromptFailureForLocalLog(error: unknown): string {
	try {
		let detail: string;
		if (error instanceof Error) {
			const stack = error.stack;
			detail = typeof stack === "string" ? stack : error.message;
		} else if (typeof error === "string") detail = error;
		else if (error !== null && typeof error === "object") {
			const candidate = error as { code?: unknown; message?: unknown };
			const code = typeof candidate.code === "string" ? candidate.code : undefined;
			const message = typeof candidate.message === "string" ? candidate.message : undefined;
			detail =
				[code, message].filter((value): value is string => value !== undefined).join(": ") ||
				"<object prompt failure>";
		} else detail = String(error);
		return detail.length <= LOCAL_FAILURE_LOG_MAX ? detail : `${detail.slice(0, LOCAL_FAILURE_LOG_MAX)}…`;
	} catch {
		return "<unserializable prompt failure>";
	}
}
