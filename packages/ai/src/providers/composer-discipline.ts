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
 * system prompt on openai-completions, openai-responses, and cursor RPC paths.
 */

/** Matches composer-harness model ids on any provider (xai grok-composer-*, cursor composer-* / composer2.*). */
const COMPOSER_MODEL_ID_PATTERN = /(?:^|[/:._-])(?:grok-)?composer(?:[/:._-]|(?=\d)|$)/i;

export function isComposerHarnessModel(modelId: string): boolean {
	return COMPOSER_MODEL_ID_PATTERN.test(modelId);
}

export const COMPOSER_EDIT_DISCIPLINE_PROMPT = `File-editing discipline for this Composer harness (this OVERRIDES contrary habits from your training):

- Discover file names ONLY with the find tool; search file contents ONLY with the search tool; read file bodies or line ranges ONLY with the read tool. NEVER inspect repository files through shell commands (ls, find, fd, cat, sed, awk, grep, rg, head, tail, less, more) or scripts — that output carries no hashline anchors and bypasses the agent's safety limits.
- Modify files ONLY with the edit/write tools. NEVER mutate files through shell redirection, tee, sed -i, perl -pi, inline python/node/bun scripts, or other out-of-band writes — those writes invalidate every known anchor and break edit recovery.
- A line anchor (e.g. "42sr") is a line number plus a 2-char content hash. You CANNOT compute the hash yourself: copy anchors verbatim from the MOST RECENT read/search/edit output of that exact file. NEVER guess, renumber, or arithmetically shift an anchor.
- After ANY edit to a file (including your own), anchors you saw earlier are stale. Re-read the edited region, or copy the fresh anchors printed in the edit result, before issuing the next edit.
- If an edit is rejected with "anchors do not match", the rejection message prints the current lines WITH fresh anchors. Retry using exactly those printed anchors.
- Tool-call arguments must be the exact JSON/schema object requested by the tool. Do not include Markdown, commentary, analysis text, or invented fields inside tool arguments.
- Use bash only for terminal operations such as tests, builds, package scripts, and git commands. A shell command string must contain only the command itself; NEVER interleave reasoning or commentary into command strings or heredocs.`;
