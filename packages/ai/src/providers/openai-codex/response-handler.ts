import { toNumber } from "../../utils";

export type CodexRateLimit = {
	used_percent?: number;
	window_minutes?: number;
	resets_at?: number;
};

export type CodexRateLimits = {
	primary?: CodexRateLimit;
	secondary?: CodexRateLimit;
};

export type CodexErrorInfo = {
	message: string;
	status: number;
	code?: string;
	friendlyMessage?: string;
	rateLimits?: CodexRateLimits;
	raw?: string;
};
// Matches the gate's bare rejection body ("Request blocked." / "Request
// blocked (…)") but never messages that merely mention blocking mid-text.
const REQUEST_BLOCKED_MESSAGE_RE = /^\s*request blocked\b/i;

export async function parseCodexError(response: Response): Promise<CodexErrorInfo> {
	const raw = await response.text();
	let message = raw || response.statusText || "Request failed";
	let friendlyMessage: string | undefined;
	let rateLimits: CodexRateLimits | undefined;
	let code: string | undefined;

	try {
		const parsed = JSON.parse(raw) as { error?: Record<string, unknown>; detail?: unknown };
		const err = parsed?.error ?? {};

		const headers = response.headers;
		const primary = {
			used_percent: toNumber(headers.get("x-codex-primary-used-percent")),
			window_minutes: toInt(headers.get("x-codex-primary-window-minutes")),
			resets_at: toInt(headers.get("x-codex-primary-reset-at")),
		};
		const secondary = {
			used_percent: toNumber(headers.get("x-codex-secondary-used-percent")),
			window_minutes: toInt(headers.get("x-codex-secondary-window-minutes")),
			resets_at: toInt(headers.get("x-codex-secondary-reset-at")),
		};
		rateLimits =
			primary.used_percent !== undefined || secondary.used_percent !== undefined
				? { primary, secondary }
				: undefined;

		code =
			typeof (err as { code?: unknown }).code === "string"
				? (err as { code: string }).code
				: typeof (err as { type?: unknown }).type === "string"
					? (err as { type: string }).type
					: undefined;
		const resetsAt = (err as { resets_at?: number }).resets_at ?? primary.resets_at ?? secondary.resets_at;
		const mins = resetsAt ? Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60000)) : undefined;

		if (/usage_limit_reached|usage_not_included/i.test(code ?? "")) {
			const planType = (err as { plan_type?: string }).plan_type;
			const plan = planType ? ` (${String(planType).toLowerCase()} plan)` : "";
			const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
			friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
		} else if (/rate_limit_exceeded/i.test(code ?? "") || response.status === 429) {
			const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
			friendlyMessage = `ChatGPT rate limit exceeded.${when}`.trim();
		}

		const errMessage = (err as { message?: string }).message;
		// The chatgpt.com/backend-api gate rejects with a bare-`detail` body
		// (`{"detail": "Request blocked."}`) that carries no `error.*` envelope.
		const detail =
			typeof parsed?.detail === "string"
				? parsed.detail
				: typeof (parsed?.detail as { message?: unknown } | undefined)?.message === "string"
					? (parsed.detail as { message: string }).message
					: undefined;
		message = errMessage || detail || friendlyMessage || message;
	} catch {
		// raw body not JSON
	}

	// A bare "Request blocked" body (detail-shaped JSON or plain text) is the
	// pre-model gate's form of the deterministic `invalid_prompt` content
	// rejection. It never carries a structured code, so classify it explicitly
	// here; otherwise `isInvalidPromptError`, the codex non-retryable event set,
	// and the session-level circuit breaker all miss it and the failure surfaces
	// as an unexplained, unrepairable "Request Blocked".
	if (!code && REQUEST_BLOCKED_MESSAGE_RE.test(message)) {
		code = "invalid_prompt";
		friendlyMessage = `${message.trim().replace(/\.+$/, "")} (code=invalid_prompt)`;
	}

	return {
		message,
		status: response.status,
		friendlyMessage,
		code,
		rateLimits,
		raw: raw,
	};
}

function toInt(v: string | null): number | undefined {
	if (v == null) return undefined;
	const n = parseInt(v, 10);
	return Number.isFinite(n) ? n : undefined;
}
