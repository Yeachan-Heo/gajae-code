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

interface OperatorMessageMatch {
	operatorMessage: string;
	/** The outer error's own message when it reports a different failure than the refusal. */
	wrapperMessage: string | undefined;
}

/**
 * The operator message of `error` or of the nearest error in its `cause` chain. A wrapper
 * that only re-raises the persistence error (same message or the same machine code) has no
 * message of its own; any other wrapper's message is returned separately.
 */
function matchOperatorMessage(error: unknown): OperatorMessageMatch | undefined {
	if (!(error instanceof Error)) return undefined;
	const own = ownOperatorMessage(error);
	if (own) return { operatorMessage: own, wrapperMessage: undefined };
	let current: unknown = error.cause;
	for (let depth = 1; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
		const operatorMessage = ownOperatorMessage(current);
		if (operatorMessage) {
			const code = (current as { code?: unknown }).code;
			const outer = error.message.trim();
			const reraise = outer.length === 0 || outer === current.message || outer === code;
			return { operatorMessage, wrapperMessage: reraise ? undefined : outer };
		}
		current = current.cause;
	}
	return undefined;
}

/**
 * Boundary-safe operator text for SDK, ACP and other protocol surfaces: the fixed,
 * path-free `operatorMessage` of `error` or of the refusal it purely re-raises. A wrapper
 * that reports its own failure yields `undefined`, because its message may carry local
 * paths or other detail those surfaces keep opaque.
 */
export function findOperatorMessage(error: unknown): string | undefined {
	const match = matchOperatorMessage(error);
	return match && match.wrapperMessage === undefined ? match.operatorMessage : undefined;
}

/**
 * Operator text for a person reading a local surface (TUI, print mode, CLI stderr). A
 * wrapper with its own failure, such as a failed rollback or an invariant failure raised
 * while handling the refusal, keeps that message first so the operator text cannot hide
 * the real failure.
 */
export function composeOperatorMessage(error: unknown): string | undefined {
	const match = matchOperatorMessage(error);
	if (!match) return undefined;
	const outer = match.wrapperMessage;
	if (outer === undefined) return match.operatorMessage;
	return `${outer}${/[.!?]$/.test(outer) ? "" : "."} ${match.operatorMessage}`;
}

/**
 * Text to show a person on a local surface for `error`: its operator message (composed
 * with a wrapper's own failure, see {@link composeOperatorMessage}) when one exists, otherwise
 * `error.message`. A non-Error value renders as `fallback`, so each call site keeps its
 * existing rendering for thrown non-errors.
 */
export function operatorErrorMessage(error: unknown, fallback = "Unknown error occurred"): string {
	return composeOperatorMessage(error) ?? (error instanceof Error ? error.message : fallback);
}
