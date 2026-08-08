/**
 * Conservative transforms applied to a bash command before execution.
 *
 * Two fixups are applied, each anchored to the end of a top-level segment
 * (segments split on `;`, `&&`, `||`, and background `&`):
 *
 *  1. Trailing `| head [args]` / `| tail [args]` (and the `|&` variant) — these
 *     pipes exist purely to limit output length. The harness already truncates
 *     bash output and exposes the full result via an artifact, so they only
 *     hide content the agent wanted.
 *
 *  2. A redundant trailing `2>&1` left on a segment that has no remaining pipe
 *     or other redirect. The harness already merges stderr into stdout, so the
 *     duplication is purely cosmetic — and often a leftover after fixup (1)
 *     drops a downstream pipe.
 *
 * The heavy lifting (tokenization, quoting, heredoc handling, command
 * substitution, nested compound commands) lives in Rust under
 * `pi_shell::fixup`, driven by the real `brush-parser` AST. This module is a
 * thin sync wrapper plus user-facing notice formatting.
 */

import type { applyBashFixups as applyBashFixupsFn } from "@gajae-code/natives";

let nativeApplyBashFixups: typeof applyBashFixupsFn | undefined;

function applyBashFixupsNative(command: string): ReturnType<typeof applyBashFixupsFn> {
	nativeApplyBashFixups ??= (require("@gajae-code/natives") as { applyBashFixups: typeof applyBashFixupsFn })
		.applyBashFixups;
	return nativeApplyBashFixups(command);
}

export interface BashFixupResult {
	/** Possibly-rewritten command. */
	command: string;
	/** Substrings that were stripped, in the order they were removed. */
	stripped: string[];
}

/**
 * Apply both fixups to a bash command. On any parse failure, multi-line input,
 * or no-op transform, returns the input verbatim with `stripped: []`.
 */
export function applyBashFixups(command: string): BashFixupResult {
	return applyBashFixupsNative(command);
}
