/**
 * Deterministic quick-lane classifier (issue #3984).
 *
 * The deep-interview and ralplan skills describe a task-routing surface in
 * prose: small, clearly scoped, low-risk work should take a quick lane
 * (minimal orchestration) while vague, ambiguous, risky, or wide-breadth work
 * keeps the existing deep path. That gate existed only as prompt guidance, so
 * it was not auditable or testable. This module encodes the same signals as
 * deterministic, pure code so eligibility and exclusions are explicit and
 * regression-covered.
 *
 * The classifier is intentionally conservative and fail-closed:
 * - Any exclusion signal forces the `deep` lane, even when the task also names
 *   concrete files or symbols. Safety is never overridden by a concrete anchor.
 * - The `deep` lane preserves the existing deep/interview behavior untouched;
 *   this module only *classifies*, it never routes or mutates.
 * - A task with neither a concrete anchor nor an exclusion defaults to `deep`
 *   because boundness cannot be confirmed.
 */

export type QuickLane = "quick" | "deep";

export interface QuickLaneDecision {
	/** The routed lane: `quick` (bounded, direct execution) or `deep` (planning/interview path). */
	lane: QuickLane;
	/** Concrete anchors that made the task eligible for the quick lane (empty when `deep`). */
	reasons: string[];
	/** Exclusions that forced the deep lane (empty when `quick`). */
	exclusions: string[];
}

/** Build a standalone-word regex so keywords do not match inside joined identifiers or file names. */
function standalone(word: string): RegExp {
	return new RegExp(`(?<![A-Za-z0-9_-])${word}(?![A-Za-z0-9_-])`, "i");
}

/** Source/config file extensions treated as concrete file-path anchors. */
const FILE_EXT =
	"(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|md|markdown|json|jsonl|yml|yaml|toml|xml|sql|sh|bash|css|scss|html|vue|svelte|java|kt|scala|c|cpp|h|hpp|csv|txt|env|tf)";

/** Regex matching one concrete file-path anchor (also used to count distinct paths). */
const FILE_PATH_PATTERN = new RegExp(`(?:[A-Za-z0-9_@.+~\\-]+/)*[A-Za-z0-9_.@+\\-]+\\.${FILE_EXT}(?![A-Za-z0-9])`, "i");

/** Global variant of FILE_PATH_PATTERN for counting distinct file-path anchors. */
const FILE_PATH_PATTERN_GLOBAL = new RegExp(FILE_PATH_PATTERN.source, "gi");

/** Concrete anchors that establish quick-lane eligibility. */
const QUICK_SIGNALS: ReadonlyArray<{ id: string; label: string; pattern: RegExp }> = [
	{
		id: "file-path",
		label: "explicit file path",
		pattern: FILE_PATH_PATTERN,
	},
	{
		id: "issue-number",
		label: "issue/PR number",
		// Hex-color-shaped tokens (#rgb/#rgba/#rrggbb/#rrggbbaa) must not read as
		// issue/PR numbers: exclude 3-digit rgb short forms, any token containing
		// a hex letter (a-f), and 6/8-digit color forms. Pure 4+ digit numbers
		// like #4146 remain issue/PR references.
		pattern: /#(?!\d{3}\b|[0-9a-fA-F]*[a-fA-F][0-9a-fA-F]*\b|[0-9a-fA-F]{6,8}\b)\d+/,
	},
	{
		id: "named-symbol",
		label: "named symbol (camelCase / snake_case)",
		// lowerCamelCase and snake_case identifiers are unambiguous code anchors
		// and rarely appear in ordinary prose. PascalCase is deliberately
		// excluded to avoid false positives on proper nouns ("Google").
		pattern:
			/\b[a-z]{2,}[a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[A-Z][A-Z]+\b|\b[A-Z][a-z]+[A-Z][a-zA-Z0-9]*\b/,
	},
	{
		id: "named-symbol-pascal",
		label: "named symbol (PascalCase)",
		// Two or more capitalized segments ("UserService" = User+Service) are
		// unambiguous code anchors; single-segment proper nouns ("Google") and
		// lowercase-leading names ("iPhone") must not match.
		pattern: /\b[A-Z][a-z]+(?:[A-Z][a-z]*)+\b/,
	},
	{
		id: "explicit-test",
		label: "explicit test/validation request",
		pattern:
			/\b(?:bun test|unit test|integration test|regression(?: test)?|e2e(?: test)?|add (?:a )?(?:test|validation)|write (?:a )?(?:test|test case)|tests? for)\b/i,
	},
	{
		id: "test-runner",
		label: "test runner",
		pattern:
			/\b(?:run (?:pytest|vitest|jest|mocha|rspec|go test|cargo test|bun test|npm test|pnpm test|yarn test|deno test))\b/i,
	},
	{
		id: "numbered-steps",
		label: "numbered steps",
		pattern: /(?:^|\n)\s*\d+[.)]\s+/m,
	},
	{
		id: "acceptance-criteria",
		label: "acceptance criteria / expected behavior",
		pattern:
			/\b(?:acceptance criteria|expected behavior|should (?:be|work|return|pass|fail|not|throw)|must (?:be|work|return|pass|not|throw)|when .*expect)\b/i,
	},
	{
		id: "error-reference",
		label: "error/failure reference",
		pattern: /\b(?:error|exception|throws?|stack trace|fails? when|does not (?:work|load|start|run)|broken)\b/i,
	},
	{
		id: "code-block",
		label: "inline code or code fence",
		pattern: /`[^`\n]+`|\n```/,
	},
	{
		id: "explicit-override",
		label: "explicit quick-lane override (force: / !)",
		// The gate prose says "prefix `force:` or `!`" — only a prefix at the
		// very start of the trimmed request counts, never mid-text.
		pattern: /^(?:force:|!)\s*/,
	},
];

/** Safety/risk exclusions that always force the deep lane. */
const RISK_KEYWORDS = [
	"auth",
	"authentication",
	"authorization",
	"login",
	"logout",
	"security",
	"secure",
	"vulnerability",
	"migrate",
	"migration",
	"destructive",
	"compliance",
	"pii",
	"payment",
	"ledger",
	"legal",
	"credential",
	"secret",
	"password",
	"passphrase",
	"passwd",
	"privilege",
	"firewall",
	"encryption",
	"decrypt",
	"rollback",
	"audit",
	"breaking change",
	"public api",
	"api contract",
];

/** Explicit ambiguity / brainstorming exclusions that force the deep lane. */
const AMBIGUITY_KEYWORDS = [
	"i don't know",
	"i do not know",
	"not sure",
	"unsure",
	"vague",
	"explore",
	"brainstorm",
	"open-ended",
	"what should",
	"what would",
	"how should",
	"kind of",
	"something like",
	"a thing",
	"maybe",
];

/** Wide-breadth exclusions indicating multi-file / cross-contract scope. */
const BREADTH_KEYWORDS = [
	"all files",
	"all modules",
	"across modules",
	"across every",
	"everywhere",
	"across the board",
	"multiple modules",
	"many files",
	"entire",
	"whole codebase",
	"entire app",
	"whole app",
	"cross-cutting",
	"cross-contract",
	"the whole",
	"redesign",
	"redesigning",
	"rewrite",
	"rewriting",
	"from scratch",
];

const EXCLUSION_KEYWORDS: ReadonlyArray<{ id: string; label: string; words: readonly string[] }> = [
	{ id: "risk", label: "risk/safety-sensitive scope", words: RISK_KEYWORDS },
	{ id: "ambiguity", label: "ambiguous or exploratory scope", words: AMBIGUITY_KEYWORDS },
	{ id: "breadth", label: "multi-file / cross-contract breadth", words: BREADTH_KEYWORDS },
];

function matchesAny(text: string, words: readonly string[]): boolean {
	return words.some(word => standalone(word).test(text));
}

/**
 * Classify a task request into the quick lane (bounded, direct execution) or
 * the deep path (existing planning/interview orchestration).
 *
 * Order of operations (fail-closed):
 * 1. Exclusions are authoritative — any risk/ambiguity/breadth signal (including
 *    two or more distinct file-path anchors) forces `deep`, even when concrete
 *    anchors are present.
 * 2. Otherwise, any concrete anchor yields `quick`.
 * 3. Otherwise, `deep` (boundness could not be confirmed).
 */
export function classifyQuickLane(input: string): QuickLaneDecision {
	const text = input.trim();
	if (!text) {
		return { lane: "deep", reasons: [], exclusions: ["empty request"] };
	}

	const exclusions: string[] = [];
	for (const group of EXCLUSION_KEYWORDS) {
		if (matchesAny(text, group.words)) {
			exclusions.push(`${group.label} (matched keyword group "${group.id}")`);
		}
	}
	const distinctFilePaths = new Set(
		Array.from(text.matchAll(FILE_PATH_PATTERN_GLOBAL), match => match[0].toLowerCase()),
	);
	if (distinctFilePaths.size >= 2) {
		exclusions.push("multi-file / cross-contract breadth (matched 2 or more distinct file paths)");
	}
	if (exclusions.length > 0) {
		return { lane: "deep", reasons: [], exclusions };
	}

	const reasons: string[] = [];
	for (const signal of QUICK_SIGNALS) {
		if (signal.pattern.test(text)) {
			reasons.push(signal.label);
		}
	}
	if (reasons.length === 0) {
		return {
			lane: "deep",
			reasons: [],
			exclusions: ["no concrete anchor — boundedness cannot be confirmed"],
		};
	}
	return { lane: "quick", reasons, exclusions: [] };
}
