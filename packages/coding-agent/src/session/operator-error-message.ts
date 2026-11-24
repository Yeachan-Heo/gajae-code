/**
 * Operator-facing text for errors raised by session operations.
 *
 * Session persistence errors keep a stable machine code in `message` (for example
 * `managed_append_identity_mismatch`) and carry the human explanation, including the
 * recovery, in `operatorMessage`. Every surface that shows such an error to a person
 * must show the operator text; machine fields (`code`) stay as they are.
 */

const MAX_CAUSE_DEPTH = 8;

function ownOperatorMessage(error: Error): string | undefined {
	const operatorMessage = (error as { operatorMessage?: unknown }).operatorMessage;
	return typeof operatorMessage === "string" && operatorMessage.trim().length > 0 ? operatorMessage : undefined;
}

/**
 * Operator text for `error`: its own `operatorMessage`, or the nearest one in its `cause`
 * chain.
 *
 * A wrapper that only re-raises the persistence error (same message or the same machine
 * code) renders the operator text alone. A wrapper with its own message, such as a failed
 * rollback or an invariant failure that happened while handling the refusal, keeps that
 * message first so the operator text cannot hide the real failure.
 */
export function findOperatorMessage(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	const own = ownOperatorMessage(error);
	if (own) return own;
	let current: unknown = error.cause;
	for (let depth = 1; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
		const operatorMessage = ownOperatorMessage(current);
		if (operatorMessage) {
			const code = (current as { code?: unknown }).code;
			const outer = error.message.trim();
			if (outer.length === 0 || outer === current.message || outer === code) return operatorMessage;
			return `${outer}${/[.!?]$/.test(outer) ? "" : "."} ${operatorMessage}`;
		}
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
