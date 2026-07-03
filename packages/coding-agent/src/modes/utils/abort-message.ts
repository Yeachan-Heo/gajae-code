const STREAM_IDLE_TIMEOUT_PATTERN = /\bstream stalled while waiting for the next event\b/i;
const GENERIC_ABORT_PATTERN = /^Request was aborted\.?$/i;
const ABORT_DISPLAY_LABEL_PATTERN = /^(?:Operation aborted|Aborted after \d+ retry attempts?)(?::|$)/;

export function buildAbortDisplayMessage({
	errorMessage,
	retryAttempt,
}: {
	errorMessage?: string;
	retryAttempt: number;
}): string {
	const existingDisplayMessage = normalizeExistingAbortDisplayMessage(errorMessage);
	if (existingDisplayMessage) return existingDisplayMessage;

	const baseMessage =
		retryAttempt > 0
			? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
			: "Operation aborted";
	const cause = normalizeAbortCause(errorMessage);
	if (!cause) return baseMessage;

	return `${baseMessage}: ${cause}${streamIdleTimeoutHint(cause)}`;
}

function normalizeExistingAbortDisplayMessage(errorMessage: string | undefined): string {
	const trimmed = errorMessage?.trim();
	if (!trimmed || !ABORT_DISPLAY_LABEL_PATTERN.test(trimmed)) return "";
	return trimmed;
}

function normalizeAbortCause(errorMessage: string | undefined): string {
	const trimmed = errorMessage?.trim();
	if (!trimmed || GENERIC_ABORT_PATTERN.test(trimmed)) return "";
	return trimmed;
}

function streamIdleTimeoutHint(cause: string): string {
	if (!STREAM_IDLE_TIMEOUT_PATTERN.test(cause)) return "";
	const separator = /[.!?]$/.test(cause) ? " " : ". ";
	return `${separator}Hint: set GJC_STREAM_IDLE_TIMEOUT_MS=300000 for slow reasoning/proxy streams, or GJC_STREAM_IDLE_TIMEOUT_MS=0 to disable the watchdog.`;
}
