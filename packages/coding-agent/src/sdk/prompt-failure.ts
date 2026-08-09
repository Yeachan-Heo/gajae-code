/**
 * Safe failure shaping shared by SDK transports and reconciliation stores.
 * Provider error text is retained only in the local diagnostic log; wire and
 * persisted reconciliation details expose a fixed redacted message.
 */
export const PROMPT_FAILURE_CODE_MAX = 64;
const LOCAL_FAILURE_LOG_MAX = 16_384;

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
