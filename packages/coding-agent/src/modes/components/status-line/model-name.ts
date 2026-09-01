/**
 * Shortest recognizable model label, derived purely from the model id.
 *
 * The rail and the footer both render this form, so a narrow terminal spends
 * its cells on the part of the id that actually identifies the model:
 *
 *   `anthropic/claude-sonnet-4-5-20250929` -> `sonnet-4.5`
 *   `openai/gpt-4o-2024-05-13`             -> `gpt-4o`
 *   `google/gemini-3-pro`                  -> `gemini-3-pro`
 *   `qwen2.5:7b`                           -> `qwen2.5:7b`
 *
 * Deliberately a pure heuristic with no curated override table: every provider
 * in `models.json` must degrade sanely without per-model maintenance. The
 * function never returns an empty string — an id that the heuristic would
 * strip to nothing falls back to the previous, longer form.
 */

/**
 * Vendor family words that carry no information once the provider prefix is
 * gone. Deliberately minimal: `gpt` and `gemini` are part of how those models
 * are named and are kept.
 */
const VENDOR_FAMILY_WORDS: ReadonlySet<string> = new Set(["claude"]);

/** Trailing snapshot dates and build stamps: `-20250929`, `-2024-05-13`, `-v2`. */
const DATE_OR_BUILD_SUFFIX = /-(?:\d{4}-\d{2}-\d{2}|\d{8}|\d{6}|v\d+(?:\.\d+)*)$/;

/**
 * Split version parts read as one number: `sonnet-4-5` -> `sonnet-4.5`.
 *
 * Deliberately narrow, because several id shapes look like a version pair and
 * are not:
 * - the trailing group must be a complete numeric token, so dashed size and
 *   variant tokens survive (`llama-3-8b-instruct` keeps its `3-8b`);
 * - it may not be zero-padded, so snapshot tails stay literal
 *   (`gpt-4-0314`, `gemini-2.5-pro-preview-05-06`);
 * - it is at most two digits, so month-year tails stay literal
 *   (`command-r-08-2024`).
 */
const SPLIT_VERSION = /(\d)-([1-9]\d?)(?![\dA-Za-z])/g;

/**
 * Control and formatting characters (newlines, tabs, escape sequences, and
 * bidi overrides) break row-width accounting, TUI rendering, or both, and a
 * model id is external data. Stripping rather than substituting keeps the
 * label compact; it also removes ZWJ, which only matters for emoji ids that no
 * provider registry produces.
 */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

const NO_MODEL_LABEL = "no-model";

export function shortenModelId(rawId: string | undefined | null): string {
	const raw = (rawId ?? "").replace(CONTROL_CHARACTERS, "").trim();
	if (!raw) return NO_MODEL_LABEL;

	// Provider prefix: `anthropic/claude-…`, `openrouter/anthropic/claude-…`.
	const afterProvider = raw.slice(raw.lastIndexOf("/") + 1).trim() || raw;

	const withoutDate = afterProvider.replace(DATE_OR_BUILD_SUFFIX, "") || afterProvider;

	let name = withoutDate;
	const dashIndex = name.indexOf("-");
	if (dashIndex > 0) {
		const head = name.slice(0, dashIndex).toLowerCase();
		const rest = name.slice(dashIndex + 1);
		if (rest && VENDOR_FAMILY_WORDS.has(head)) name = rest;
	}

	name = name.replace(SPLIT_VERSION, "$1.$2");

	return name || withoutDate || afterProvider;
}
