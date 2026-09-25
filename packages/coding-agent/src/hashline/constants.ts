/** Lines of context shown either side of a hash mismatch. */
export const MISMATCH_CONTEXT = 2;

/** Lines searched either side of a stale anchor for where its content moved. */
export const MISMATCH_RELOCATE_WINDOW = 20;

/** Filler hash used for the interior of a multi-line range; not validated. */
export const RANGE_INTERIOR_HASH = "**";

/** Optional patch envelope start marker; silently consumed when present. */
export const BEGIN_PATCH_MARKER = "*** Begin Patch";

/** Optional patch envelope end marker; terminates parsing when encountered. */
export const END_PATCH_MARKER = "*** End Patch";

/**
 * Recovery sentinel emitted by the agent loop when a contaminated
 * `to=functions.edit` stream is truncated mid-call (see
 * `docs/ERRATA-GPT5-HARMONY.md`). Behaves like `END_PATCH_MARKER` for
 * parsing — terminates the line loop — and additionally surfaces a
 * warning in the tool result so the model knows to re-issue any
 * remaining edits.
 */
export const ABORT_MARKER = "*** Abort";

/** Warning text appended to the tool result when ABORT_MARKER terminates parsing. */
export const ABORT_WARNING =
	"Tool stream truncated mid-call due to detected output corruption. Applied ops above are valid. Re-issue any remaining edits.";
