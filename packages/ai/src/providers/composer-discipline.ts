/**
 * Anchor/edit discipline for composer-harness models (xai grok-composer-*,
 * cursor composer-*).
 *
 * Composer models are trained on a proprietary coding-agent harness
 * (Cursor / Grok Build) and carry habits that break this agent's hashline
 * edit workflow when driven through a generic provider. Observed in live
 * sessions with grok-composer-2.5-fast:
 *
 *  - they print files with shell commands (`sed -n`, `cat`, `grep -n`) or
 *    python heredocs whose output carries NO line anchors, then FABRICATE the
 *    2-char anchor hash the edit tool requires (e.g. guessed "617hp" where
 *    the file had "617ca" → "Edit rejected: N anchors do not match");
 *  - they mutate files out-of-band via python heredocs (pathlib write_text /
 *    str.replace), which invalidates every previously seen anchor and defeats
 *    the read-cache snapshot that powers stale-anchor recovery;
 *  - they arithmetically renumber anchors after their own edits instead of
 *    copying them from the latest tool output;
 *  - they leak reasoning prose into heredoc bodies, producing shell/python
 *    syntax errors.
 *
 * This prompt is the per-request countermeasure, pinned ahead of the host
 * system prompt on both the openai-completions path and the cursor RPC path.
 */

/** Matches composer-harness model ids on any provider (xai grok-composer-*, cursor composer-*). */
export function isComposerHarnessModel(modelId: string): boolean {
	return modelId.toLowerCase().includes("composer");
}

export const COMPOSER_EDIT_DISCIPLINE_PROMPT = `File-editing discipline for this harness (this OVERRIDES contrary habits from your training):

- Read file contents ONLY with the provided read/search tools. NEVER print files through shell commands (sed, cat, awk, head, grep) or scripts — that output carries no line anchors, and the edit tool accepts ONLY anchors.
- Modify files ONLY with the provided edit/write tools. NEVER mutate files through shell redirection, sed -i, or inline python scripts — out-of-band writes invalidate every known anchor and break edit recovery.
- A line anchor (e.g. "42sr") is a line number plus a 2-char content hash. You CANNOT compute the hash yourself: copy anchors verbatim from the MOST RECENT read/search/edit output of that exact file. NEVER guess, renumber, or arithmetically shift an anchor.
- After ANY edit to a file (including your own), anchors you saw earlier are stale. Re-read the edited region, or copy the fresh anchors printed in the edit result, before issuing the next edit.
- If an edit is rejected with "anchors do not match", the rejection message prints the current lines WITH fresh anchors. Retry using exactly those printed anchors.
- A shell command string must contain only the command itself. NEVER interleave reasoning or commentary into command strings or heredocs.`;
