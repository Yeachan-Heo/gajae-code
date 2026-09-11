/**
 * Safe failure shaping shared by SDK transports and reconciliation stores.
 * Provider error text is retained only in the local diagnostic log; wire and
 * persisted reconciliation details expose a fixed redacted message.
 */
import type { SdkPromptFailureCategory, SdkPromptFailurePhase, SdkPromptTerminalOutcome } from "./prompt-status";

export const PROMPT_FAILURE_CODE_MAX = 64;
const LOCAL_FAILURE_LOG_MAX = 16_384;

export const PROMPT_FAILURE_MESSAGE_SUBMISSION = "Prompt submission failed.";
export const PROMPT_FAILURE_MESSAGE_POST_START_PROVIDER = "Provider failure after execution started.";
export const PROMPT_FAILURE_MESSAGE_POST_START_AGENT = "Agent run failed after execution started.";
export const PROMPT_FAILURE_MESSAGE_DEADLINE = "Prompt deadline exceeded.";

/** Evidence that decides whether a failure happened before or after the run started. */
export interface PromptFailureEvidence {
	startedAt?: number;
	hasActivity?: boolean;
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

export function isSdkPromptFailureCategory(value: unknown): value is SdkPromptFailureCategory {
	return (
		value === "provider_transport" ||
		value === "provider_rejected" ||
		value === "agent_runtime" ||
		value === "deadline" ||
		value === "unknown"
	);
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
 * outcomes pass through untouched. Idempotent.
 */
export function rephaseFailedOutcome(
	outcome: SdkPromptTerminalOutcome,
	evidence: PromptFailureEvidence,
): SdkPromptTerminalOutcome {
	if (outcome.kind !== "failed") return outcome;
	const category = promptFailureCategory(outcome.providerCode ?? outcome.code, outcome.provenance);
	const phase = promptFailurePhase(evidence);
	const message = promptFailureMessage(phase, category);
	if (category === outcome.category && phase === outcome.phase && message === outcome.message) return outcome;
	return { ...outcome, category, phase, message };
}

/** Build a complete failed outcome from a bounded classifier and evidence. */
export function failedPromptOutcome(input: {
	code: "prompt_failed" | "prompt_deadline_exceeded";
	provenance: "agent_failed" | "deadline";
	providerCode?: string;
	phase?: SdkPromptFailurePhase;
	evidence: PromptFailureEvidence;
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
	};
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
