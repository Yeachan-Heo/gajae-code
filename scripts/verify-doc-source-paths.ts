#!/usr/bin/env bun

/**
 * Documentation source-path verifier.
 *
 * `check:public-sync` regenerates the embedded docs index and compares it byte for
 * byte, so it catches a doc that was added or edited without regeneration. It cannot
 * catch a doc whose *prose* cites a source file that no longer exists: the index
 * faithfully embeds the stale text. Nothing else in the repo reads a doc's citations
 * back against the tree either, so a rename or a delete silently strands every
 * `packages/.../foo.ts` mention in `docs/` and the reader follows a dead path.
 *
 * This gate closes that hole. It scans markdown under `docs/` for backtick-quoted,
 * repo-relative source paths and resolves each one against the repo root, failing
 * with a file:line report for every citation that does not exist on disk.
 *
 * Two citation shapes are intentionally exempt:
 *
 *  - **Pinned citations.** A path may carry an `@<rev>` suffix when the doc is
 *    describing a specific upstream revision rather than this checkout
 *    (e.g. `crates/pi-natives/src/block.rs@a85bd52...`). Those describe another
 *    tree by construction and are checked only when the pin names the current HEAD.
 *  - **Allowlisted paths.** A small, explicitly reasoned set of historical
 *    citations for files this repo deliberately does not vendor. Every entry must
 *    carry a written reason; an unreadable or unreasoned allowlist is a failure.
 *
 * Run with `--fail` to exit non-zero on any unresolved citation (CI mode).
 */

import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const docsRoot = path.join(repoRoot, "docs");

/** A citation whose target is intentionally absent from this checkout. */
interface AllowlistEntry {
	/** Doc file the exemption applies to (repo-relative). Scoping by file keeps an
	 * entry from silencing the same stale path anywhere else in the docs tree. */
	readonly file: string;
	/** Repo-relative path as written in the doc, without any `@<rev>` pin. */
	readonly path: string;
	/** Why this citation is allowed to point at a path this repo does not contain. */
	readonly reason: string;
}

/**
 * Citations that record history rather than pointing at live code. Every entry is
 * scoped to one doc and one path so it cannot mask a rename elsewhere, and every
 * entry states why. Keep this list as short as the genuine cases allow, and prefer
 * fixing a citation over exempting it.
 */
const ALLOWLIST: readonly AllowlistEntry[] = [
	{
		file: "docs/rust-porting-inventory.md",
		path: "packages/coding-agent/src/utils/mupdf.ts",
		reason: "Listed in the B-PDF `deleted paths` column: this file was removed when the PDF port adopted pdf-inspector.",
	},
	{
		file: "docs/rust-porting-inventory.md",
		path: "packages/coding-agent/src/utils/mupdf-wasm.ts",
		reason: "Listed in the B-PDF `deleted paths` column: removed with the MuPDF port.",
	},
	{
		file: "docs/rust-porting-inventory.md",
		path: "packages/coding-agent/src/utils/mupdf-embedded.ts",
		reason: "Listed in the B-PDF `deleted paths` column: removed with the MuPDF port.",
	},
	{
		file: "docs/rust-porting-inventory.md",
		path: "crates/pi-natives/src/tokens.rs",
		reason: "B-TOKENS `local target` names the upstream-only module; the row is `rejected` and the file was never vendored locally.",
	},
	{
		file: "docs/rust-porting-inventory.md",
		path: "crates/pi-natives/src/block.rs",
		reason: "B-BLOCK `local target` names the upstream-only module; the row is `rejected` and the reason column records that it is not vendored.",
	},
	{
		file: "docs/sdk-owned-session-lifecycle-handoff.md",
		path: "packages/coding-agent/src/sdk/bus/lifecycle-orchestrator.ts",
		reason:
			"A pre-refactor handoff record; the path was a planned module name that was never created. The doc annotates each mention with the module that actually landed.",
	},
	{
		file: "docs/rust-porting-inventory.md",
		path: "crates/pi-natives/src/vcs.rs",
		reason:
			"B-VCS/A-PI-VCS `local target` names the upstream-only module; both rows are `rejected` (the D5 size/perf gate failed), so vcs.rs was never vendored locally.",
	},
	{
		file: "docs/rust-porting-inventory.md",
		path: "crates/pi-natives/src/edit_fuzzy.rs",
		reason: "Listed in the D-TRANSITIONAL-TS `deleted paths` column: the module and its exports were removed with the 2.7 matcher adoption.",
	},
	{
		file: "docs/prompt-architect-reports/recovered-context/3-SkillMiscPrompts.recovered.md",
		path: "packages/coding-agent/src/defaults/gjc/skills/team/SKILL.md",
		reason: "Verbatim session-recovery record kept for audit history; it reports a path a past session read, and is not maintained as current guidance.",
	},
];

/** `@<rev>` pins the citation to a revision other than the current checkout. */
const REV_PIN = /@[0-9a-f]{7,40}$/u;

/** Same pin, unanchored, for judging a whole line rather than one span. */
const LINE_REV_PIN = /@[0-9a-f]{7,40}\b/u;

/**
 * A backtick span is a citation candidate when it is a bare repo-relative path: it
 * starts at one of the tracked roots, contains no whitespace, no glob, no scheme,
 * and no placeholder angle brackets. Requiring a leading tracked root keeps prose
 * like `src/foo.ts` (ambiguous, and usually relative to a *package*) out of scope
 * rather than guessing which package the doc meant.
 */
const CITATION_SPAN = /`((?:packages|crates|scripts|docs)\/[^\s`"'()<>[\]{}*?!|$,]+)`/gu;

/** Trailing punctuation that markdown prose glues onto a path. */
const TRAILING_PUNCTUATION = /[.,;:]+$/u;

/** Extensions we treat as a source citation rather than a symbolic label. */
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|rs|json|jsonc|md|toml|ya?ml|sh|py|css|js|jsx)$/u;
interface Citation {
	readonly file: string;
	readonly line: number;
	readonly text: string;
	readonly target: string;
	readonly pinned: boolean;
	/** The doc cites this path in order to say it does not exist. */
	readonly negated: boolean;
}

/**
 * A citation is upstream-provenance when its own span carries an `@<rev>` pin, or
 * when a sibling backtick span in the same table cell does. The rust-porting
 * inventory records an upstream-path cell as `dir/file.rs`, `dir/other/@<sha>` —
 * the pin lands on one span in that cell and governs the cell as a group, so
 * reading only the individual span would report the pinned row as broken.
 *
 * The scope stops at the cell boundary (`|`, newline, or a blank line). A wider
 * line-scoped rule would let one pinned column silently disable existence checking
 * for every other column on the row, which is where real drift hides.
 */
function cellHasRevisionPin(content: string, index: number): boolean {
	const isCellBoundary = (character: string | undefined): boolean =>
		character === undefined || character === "\n" || character === "|";
	let start = index;
	while (start > 0 && !isCellBoundary(content[start - 1])) start--;
	let end = index;
	while (end < content.length && !isCellBoundary(content[end])) end++;
	// The pin is not necessarily last in the cell, so search rather than anchor.
	return LINE_REV_PIN.test(content.slice(start, end).replace(/`/gu, ""));
}

/**
 * Whether a citation is accompanied by a claim that it is gone.
 *
 * A doc may cite a path in order to say it does not exist ("there is no
 * `crates/pi-natives/src/work.rs`", "`x.ts` was deleted"). Those citations are
 * accurate, so the gate must read the prose around them instead of flagging the path.
 *
 * Only positional attachment is recognized: a marker immediately before the span, or a
 * marker/copula shortly after it. The marker must therefore attach to the citation
 * rather than merely share its sentence, so a negation about something else ("This
 * does not exist: see `live.ts`") or a marker word inside the path itself ("`absent.ts`"
 * as a live filename) cannot excuse a real citation.
 *
 * A claim phrased as an appositive parenthesis is deliberately NOT recognized. Static
 * text cannot settle whether a parenthesis describes the adjacent path or another
 * subject: "(the setting was renamed to `other/file.ts`)" and "(the other config never
 * created this)" both look like removal claims while saying nothing about the citation
 * beside them, and every wording-based binding tried here either missed real claims or
 * silently accepted stale ones. A doc recording a path's removal in an appositive is
 * covered by a reasoned allowlist entry instead of a guess.
 */
function hasAttachedNegation(content: string, index: number): boolean {
	const spanEnd = index + 1 + (content.slice(index + 1).indexOf("`") + 1);
	const lineStart = content.lastIndexOf("\n", index) + 1;
	const before = content.slice(Math.max(lineStart, index - NEGATION_LOOKBEHIND), index);
	const after = content.slice(spanEnd, spanEnd + NEGATION_LOOKAHEAD);
	// "... is no `x.ts`", "... `x.ts` was deleted".
	return ATTACHED_BEFORE.test(before) || ATTACHED_AFTER.test(after);
}

/** How far before/after a citation to look for an attached negation marker. */
const NEGATION_LOOKBEHIND = 48;
const NEGATION_LOOKAHEAD = 64;

/**
 * A marker attached immediately before a citation: "there is no `x.ts`", "the
 * removed `x.ts`". The marker must sit on the same line and not cross a backtick, so
 * a marker on a previous line, or one inside another span ("Use `not` then `x.ts`"),
 * cannot exempt a citation it does not describe.
 */
const ATTACHED_BEFORE =
	/(?:^|\s)(?:no|not|never|removed|deleted|absent|missing|without|renamed|gone|retired|withdrawn|dropped|unvendored)\s+[\w"'-]{0,24}$/u;

/**
 * A marker attached shortly after a citation: "`x.ts` was deleted", "`x.ts` is
 * absent", "`x.ts` never shipped". Requires a copula or auxiliary between the path
 * and the marker so a marker belonging to the next clause does not qualify.
 */
const ATTACHED_AFTER =
	/^\s*(?:`)?\s*(?:was|were|is|are|has|have|had|never|no longer|got|been)?\s*(?:removed|deleted|absent|missing|renamed|gone|retired|withdrawn|dropped|unvendored|never created|never shipped|never landed|no longer exists)\b/u;

function lineOf(content: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset; index++) {
		if (content.charCodeAt(index) === 10) line++;
	}
	return line;
}

function listMarkdownFiles(dir: string): string[] {
	const found: string[] = [];
	for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
		const absolute = path.join(dir, dirent.name);
		if (dirent.isDirectory()) {
			if (dirent.name === "node_modules" || dirent.name.startsWith(".")) continue;
			found.push(...listMarkdownFiles(absolute));
			continue;
		}
		if (dirent.isFile() && dirent.name.endsWith(".md")) found.push(absolute);
	}
	return found;
}

function collectCitations(label: string, content: string): Citation[] {
	const citations: Citation[] = [];
	for (const match of content.matchAll(CITATION_SPAN)) {
		const span = match[1]!.replace(TRAILING_PUNCTUATION, "");
		// A `#`/`?` segment is an anchor or query, and an `@<rev>` is a revision pin;
		// neither is part of the path we resolve.
		const withoutAnchor = span.split(/[#?]/u)[0]!;
		const pinned = REV_PIN.test(withoutAnchor) || cellHasRevisionPin(content, match.index ?? 0);
		const target = withoutAnchor.replace(REV_PIN, "");
		if (!SOURCE_EXTENSIONS.test(target)) continue;
		const negated = hasAttachedNegation(content, match.index ?? 0);
		citations.push({
			file: label,
			line: lineOf(content, match.index ?? 0),
			text: span,
			target,
			pinned,
			negated,
		});
	}
	return citations;
}

function loadAllowlist(): AllowlistEntry[] {
	const seen = new Set<string>();
	for (const entry of ALLOWLIST) {
		if (entry.reason.trim().length === 0) {
			throw new Error(`Allowlist entry ${entry.file}:${entry.path} has no reason. Every exemption must be justified.`);
		}
		const key = `${entry.file}\u0000${entry.path}`;
		if (seen.has(key)) {
			throw new Error(`Allowlist entry ${entry.file}:${entry.path} is duplicated.`);
		}
		seen.add(key);
	}
	return [...ALLOWLIST];
}

export interface DocSourcePathReport {
	readonly citations: readonly Citation[];
	readonly unresolved: readonly Citation[];
}

/**
 * Resolve every citation in `documents` against `root`. Exported so the gate's
 * fail-closed behavior is testable against synthetic docs and a synthetic root
 * without touching the real docs tree.
 */
export function auditDocumentSourcePaths(
	root: string,
	documents: ReadonlyArray<{ readonly file: string; readonly content: string }>,
	allowlist: readonly AllowlistEntry[] = ALLOWLIST,
): DocSourcePathReport {
	const exempted = new Set(allowlist.map(entry => `${entry.file}\u0000${entry.path}`));
	const citations: Citation[] = [];
	for (const document of documents) {
		citations.push(...collectCitations(document.file, document.content));
	}
	const unresolved = citations.filter(citation => {
		if (exempted.has(`${citation.file}\u0000${citation.target}`)) return false;
		// A pinned citation describes another revision; this checkout cannot be its judge.
		if (citation.pinned) return false;
		// A statement that the path is gone is accurate on its own.
		if (citation.negated) return false;
		return !fs.existsSync(path.join(root, citation.target));
	});
	return { citations, unresolved };
}

/** The real docs tree as `auditDocumentSourcePaths` input. */
function readDocsTree(): Array<{ file: string; content: string }> {
	return listMarkdownFiles(docsRoot)
		.sort()
		.map(file => ({ file: path.relative(repoRoot, file), content: fs.readFileSync(file, "utf8") }));
}

function main(): void {
	const failMode = process.argv.includes("--fail");
	const allowlist = loadAllowlist();

	if (!fs.existsSync(docsRoot)) {
		console.log("docs/ does not exist; nothing to verify.");
		return;
	}

	const documents = readDocsTree();
	const { citations, unresolved } = auditDocumentSourcePaths(repoRoot, documents, allowlist);
	const files = documents.map(document => document.file);

	console.log(
		`doc source-path verifier - scanned ${files.length} markdown file(s) under docs/, ` +
			`${citations.length} source citation(s).`,
	);

	if (unresolved.length > 0) {
		console.log("\n[UNRESOLVED-SOURCE-PATH]");
		for (const citation of [...unresolved].sort((a, b) =>
			a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
		)) {
			console.log(`    ${citation.file}:${citation.line}: ${citation.text} -> no such path`);
		}
	}

	if (allowlist.length > 0) {
		console.log(`\nAllowlisted citation(s): ${allowlist.length}`);
		for (const entry of allowlist) console.log(`    ${entry.file}: ${entry.path} - ${entry.reason}`);
	}

	console.log(`\nSummary: ${unresolved.length} unresolved source citation(s).`);

	if (failMode && unresolved.length > 0) {
		console.error(
			"\ndoc source-path gate FAIL: documentation cites source paths that do not exist. " +
				"Point each citation at the file that implements the behavior today, or add a " +
				"reasoned allowlist entry if the target is deliberately not vendored.",
		);
		process.exit(1);
	}
}

// Only run the gate when executed directly; importing it (for the focused test)
// must not scan the tree or exit the process.
if (import.meta.main) main();
