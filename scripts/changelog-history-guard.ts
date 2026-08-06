#!/usr/bin/env bun

/**
 * Guard: a pull request must not remove released CHANGELOG history.
 *
 * Why this exists
 * ---------------
 * `packages/<pkg>/CHANGELOG.md` deliberately has no `merge=union` driver (see the
 * comment in `.gitattributes`): union never conflicts, it concatenates both
 * sides of an overlapping hunk, which silently filed entries into versions that
 * had already shipped. Removing the driver was correct, but it also means a
 * rebase now produces a *real* conflict in these files for the first time — and
 * a bad resolution can drop the file's entire history without any marker.
 *
 * That is not hypothetical. Within ten minutes of the driver being removed, ten
 * open pull requests across six authors force-pushed heads whose CHANGELOG was
 * a single newline, having lost every released section. Nothing in CI noticed:
 * the files still parsed, no test read them, and the diff was just a large
 * deletion among a legitimate change.
 *
 * Contract
 * --------
 * Every `## [<version>]` heading present in a `packages/<pkg>/CHANGELOG.md` at the
 * merge base must still be present at the head. Adding headings is fine.
 * Editing entry text is fine. Removing a released section is not.
 *
 * `## [Unreleased]` is exempt in one direction only: it may disappear, because
 * a release commit legitimately consumes it. It may not take released sections
 * with it.
 */

import { $ } from "bun";

/** `## [1.2.3] - 2026-01-01` or `## [Unreleased]`. */
const RELEASE_HEADING = /^##\s+\[([^\]]+)\]/;
const UNRELEASED = "unreleased";
/** Only package changelogs carry release history worth guarding. */
const GUARDED_PATH = /^packages\/[^/]+\/CHANGELOG\.md$/;

export interface ChangelogHistoryViolation {
	file: string;
	/** Release headings present at the base and missing at the head. */
	removed: string[];
	baseHeadingCount: number;
	headHeadingCount: number;
}

/** Released version headings, in file order, excluding `[Unreleased]`. */
export function releaseHeadings(text: string): string[] {
	const headings: string[] = [];
	for (const line of text.split("\n")) {
		const match = RELEASE_HEADING.exec(line);
		if (!match) continue;
		const version = match[1] ?? "";
		if (version.trim().toLowerCase() === UNRELEASED) continue;
		headings.push(version.trim());
	}
	return headings;
}

/**
 * Compare one changelog across a range.
 *
 * A file that did not exist at the base cannot have lost history, and a file
 * deleted at the head is a different review conversation (and is visible in the
 * diff as a deletion), so both return no violation here.
 */
export function compareHistory(
	file: string,
	baseText: string | undefined,
	headText: string | undefined,
): ChangelogHistoryViolation | undefined {
	if (baseText === undefined || headText === undefined) return undefined;
	const before = releaseHeadings(baseText);
	const after = new Set(releaseHeadings(headText));
	const removed = before.filter(version => !after.has(version));
	if (removed.length === 0) return undefined;
	return { file, removed, baseHeadingCount: before.length, headHeadingCount: after.size };
}

async function gitShow(rev: string, file: string): Promise<string | undefined> {
	const result = await $`git show ${`${rev}:${file}`}`.quiet().nothrow();
	return result.exitCode === 0 ? result.text() : undefined;
}

async function changedChangelogs(base: string, head: string): Promise<string[]> {
	const result = await $`git diff --name-only ${base} ${head}`.quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`git diff ${base}..${head} failed: ${result.stderr.toString().trim()}`);
	}
	return result
		.text()
		.split("\n")
		.map(line => line.trim())
		.filter(line => GUARDED_PATH.test(line));
}

export async function collectViolations(base: string, head: string): Promise<ChangelogHistoryViolation[]> {
	const violations: ChangelogHistoryViolation[] = [];
	for (const file of await changedChangelogs(base, head)) {
		const [baseText, headText] = await Promise.all([gitShow(base, file), gitShow(head, file)]);
		const violation = compareHistory(file, baseText, headText);
		if (violation) violations.push(violation);
	}
	return violations;
}

async function resolveBase(explicit: string | undefined): Promise<string> {
	if (explicit) return explicit;
	const fromEnv = process.env.GITHUB_BASE_SHA?.trim();
	if (fromEnv) return fromEnv;
	const mergeBase = await $`git merge-base HEAD origin/dev`.quiet().nothrow();
	if (mergeBase.exitCode !== 0) {
		throw new Error("no base: pass --base=<sha>, set GITHUB_BASE_SHA, or fetch origin/dev");
	}
	return mergeBase.text().trim();
}

function readFlag(argv: string[], name: string): string | undefined {
	const prefix = `--${name}=`;
	const inline = argv.find(arg => arg.startsWith(prefix));
	if (inline) return inline.slice(prefix.length);
	const index = argv.indexOf(`--${name}`);
	return index >= 0 ? argv[index + 1] : undefined;
}

/** At most this many removed versions are listed before the message summarizes. */
const MAX_LISTED = 8;

export function formatViolation(violation: ChangelogHistoryViolation): string {
	const listed = violation.removed.slice(0, MAX_LISTED).join(", ");
	const more = violation.removed.length > MAX_LISTED ? ` (+${violation.removed.length - MAX_LISTED} more)` : "";
	return (
		`${violation.file} removes ${violation.removed.length} released section(s): ${listed}${more}. ` +
		`Base had ${violation.baseHeadingCount} released headings, this head has ${violation.headHeadingCount}. ` +
		`Released history is append-only. If a rebase conflicted here, resolve it by keeping BOTH sides' entries ` +
		`under "## [Unreleased]" — never by dropping released sections. Recover with: ` +
		`git checkout ${process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/dev"} -- ${violation.file}`
	);
}

export async function main(argv: string[]): Promise<number> {
	const base = await resolveBase(readFlag(argv, "base"));
	const head = readFlag(argv, "head") ?? "HEAD";
	const violations = await collectViolations(base, head);
	if (violations.length === 0) {
		console.log(`changelog-history-guard: no released sections removed (${base.slice(0, 12)}..${head})`);
		return 0;
	}
	for (const violation of violations) console.error(`::error file=${violation.file}::${formatViolation(violation)}`);
	return 1;
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
