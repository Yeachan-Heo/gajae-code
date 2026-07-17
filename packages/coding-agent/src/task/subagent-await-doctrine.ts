/**
 * Single source of truth for subagent await/cancel doctrine.
 * Imported by tool prompts, task handoff text, and workflow skills.
 */
export const SUBAGENT_AWAIT_TIMEOUT_DOCTRINE =
	"An await timeout only bounds the wait. It is not subagent failure evidence and must not be used as a cancellation reason; inspect or continue independent work, and cancel only when the subagent has actually failed, gone off-track, or become unrecoverably wrong.";

export const SUBAGENT_CANCEL_ONLY_WHEN_WRONG_DOCTRINE =
	"Cancel only when the subagent has actually failed, gone off-track, or become unrecoverably wrong; an await timeout alone is never a cancellation reason.";
