/**
 * Message to show a person when an operation fails.
 *
 * Typed errors may carry `operatorMessage` wording meant for the operator
 * instead of an internal code; without it the raw message is all we have.
 */
export function operatorFacingMessage(error: unknown): string {
	if (error !== null && typeof error === "object") {
		const guidance = (error as { operatorMessage?: unknown }).operatorMessage;
		if (typeof guidance === "string" && guidance.trim().length > 0) return guidance;
	}
	if (error instanceof Error) return error.message;
	return String(error);
}
