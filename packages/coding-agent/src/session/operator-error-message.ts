/**
 * Operator-facing text for errors raised by session operations.
 *
 * Session persistence errors keep a stable machine code in `message` (for example
 * `managed_append_identity_mismatch`) and carry the human explanation, including the
 * recovery, in `operatorMessage`. Every surface that shows such an error to a person
 * must show the operator text; machine fields (`code`) stay as they are.
 */

const MAX_CAUSE_DEPTH = 8;

/**
 * The `operatorMessage` of `error` or of the nearest error in its `cause` chain, so a
 * wrapper that keeps the persistence error as its cause still renders the operator text.
 */
export function findOperatorMessage(error: unknown): string | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
		const operatorMessage = (current as { operatorMessage?: unknown }).operatorMessage;
		if (typeof operatorMessage === "string" && operatorMessage.trim().length > 0) return operatorMessage;
		current = current.cause;
	}
	return undefined;
}

/**
 * Text to show a person for `error`: its operator message when one exists, otherwise
 * `error.message`. A non-Error value renders as `fallback`, so each call site keeps its
 * existing rendering for thrown non-errors.
 */
export function operatorErrorMessage(error: unknown, fallback = "Unknown error occurred"): string {
	return findOperatorMessage(error) ?? (error instanceof Error ? error.message : fallback);
}
