#!/usr/bin/env bun

/**
 * Changelog fragments: one file per change, folded in at release time.
 *
 * Why this exists
 * ---------------
 * Contributors used to append their release note under `## [Unreleased]` in
 * `packages/<pkg>/CHANGELOG.md`, so every pull request edited the same lines of
 * the same file. Git cannot auto-merge two insertions at the same position, so
 * the second of any two in-flight PRs is always dirty after the first merges —
 * and the exact-head approval contract charges a full reviewer round-trip for
 * the rebase that clears it. Issue #5491 measured one six-line change paying
 * three rebases and two approval rounds, with `CHANGELOG.md` the only conflicted
 * path every time. Distinct fragment file names cannot conflict, so the shared
 * insertion point stops existing rather than merely conflicting less often.
 *
 * Contract
 * --------
 * A change adds `packages/<pkg>/changelog.d/<slug>.md` holding one or more
 * `### <Section>` blocks whose entries are `- ` bullets. `scripts/release.ts`
 * folds every pending fragment into that package's `[Unreleased]` body and
 * deletes the consumed files as part of the release commit; it is the single
 * assembly point.
 *
 * `check` validates the fragments present in the working tree. `guard` runs on
 * pull requests: it fails a PR that edits a guarded `## [Unreleased]` section
 * directly or consumes a fragment, because both re-create the conflict or drop
 * an unreleased note outside the release flow.
 */

import { $ } from "bun";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Directory holding pending fragments, relative to each package root. */
export const FRAGMENT_DIRECTORY = "changelog.d";

/** Fragment file names must be unique, lowercase, and conflict-free by construction. */
const FRAGMENT_NAME = /^[a-z0-9][a-z0-9._-]*\.md$/;

/** Only package changelogs carry release history and a shared insertion point. */
const GUARDED_CHANGELOG = /^packages\/[^/]+\/CHANGELOG\.md$/;
const FRAGMENT_PATH = /^packages\/[^/]+\/changelog\.d\/[^/]+$/;

const UNRELEASED_HEADING = /^##\s+\[Unreleased\]\s*$/u;
const ANY_VERSION_HEADING = /^##\s+/u;
const SECTION_HEADING = /^###\s+(.+?)\s*$/u;
const ANY_HEADING = /^#+\s/u;
const BULLET = /^\s*-\s+\S/u;

/**
 * Order used when a release introduces a heading that is new to the body.
 * Existing bodies keep their own order so a release diff stays readable.
 */
export const SECTION_ORDER = [
	"Added",
	"Changed",
	"Deprecated",
	"Removed",
	"Fixed",
	"Security",
	"Breaking Changes",
	"Documentation",
	"Performance",
	"Tests",
] as const;

export interface ChangelogSection {
	heading: string;
	lines: string[];
}

export interface ChangelogFragment {
	path: string;
	sections: ChangelogSection[];
}

export interface ChangelogError {
	file: string;
	message: string;
}

export class ChangelogFragmentError extends Error {
	readonly file: string;

	constructor(file: string, message: string) {
		super(`${file}: ${message}`);
		this.name = "ChangelogFragmentError";
		this.file = file;
	}
}

function fragmentHint(file: string, baseRef: string): string {
	const directory = fragmentDirectoryFor(file);
	return (
		`Put the note in ${directory}/<slug>.md as a '### <Section>' heading with '- ' bullet entries, ` +
		`and restore the shared section with: git checkout ${baseRef} -- ${file}`
	);
}

/** The `changelog.d` directory that feeds a package changelog. */
export function fragmentDirectoryFor(changelog: string): string {
	return path.join(path.dirname(changelog), FRAGMENT_DIRECTORY);
}

function trimBlankLines(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && (lines[start] ?? "").trim() === "") start++;
	while (end > start && (lines[end - 1] ?? "").trim() === "") end--;
	return lines.slice(start, end).map(line => line.replace(/[ \t]+$/u, ""));
}

function sectionKey(heading: string): string {
	return heading.trim().toLowerCase();
}

function sectionRank(heading: string): number {
	const key = sectionKey(heading);
	const index = SECTION_ORDER.findIndex(candidate => candidate.toLowerCase() === key);
	return index === -1 ? SECTION_ORDER.length : index;
}

/**
 * Validate a fragment body and split it into its `### <Section>` blocks.
 *
 * Fragments are intentionally narrow: exactly `### <Section>` headings with
 * bullet entries. Anything else (a `##` version heading, a nested heading, free
 * prose before the first section, a section with no bullet) would land in the
 * changelog in a shape nothing else expects, so it fails closed here.
 */
export function parseFragment(content: string, file: string): ChangelogSection[] {
	const sections: ChangelogSection[] = [];
	let current: ChangelogSection | undefined;

	for (const [index, line] of content.split(/\r?\n/u).entries()) {
		if (ANY_HEADING.test(line)) {
			const heading = SECTION_HEADING.exec(line)?.[1]?.trim();
			if (!heading) {
				throw new ChangelogFragmentError(
					file,
					`line ${index + 1} is not a fragment section heading; a fragment uses only '### <Section>' headings`,
				);
			}
			current = { heading, lines: [] };
			sections.push(current);
			continue;
		}
		if (current) {
			current.lines.push(line);
			continue;
		}
		if (line.trim() !== "") {
			throw new ChangelogFragmentError(
				file,
				`line ${index + 1} appears before any section heading; a fragment must open with '### <Section>'`,
			);
		}
	}

	if (sections.length === 0) {
		throw new ChangelogFragmentError(file, "fragment declares no '### <Section>' heading");
	}
	for (const section of sections) {
		if (!section.lines.some(line => BULLET.test(line))) {
			throw new ChangelogFragmentError(file, `section '### ${section.heading}' has no '- ' bullet entry`);
		}
	}
	return sections;
}

/** Read and validate one fragment file. */
export async function readFragment(file: string): Promise<ChangelogFragment> {
	const name = path.basename(file);
	if (!FRAGMENT_NAME.test(name)) {
		throw new ChangelogFragmentError(
			file,
			`fragment file name ${JSON.stringify(name)} must match ${FRAGMENT_NAME.source} (lowercase, no spaces, ends in .md)`,
		);
	}
	return { path: file, sections: parseFragment(await Bun.file(file).text(), file) };
}

function isMissingPath(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/** Every file directly under a package's `changelog.d`, in deterministic order. */
export async function listFragmentFilesInDirectory(directory: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (isMissingPath(error)) return [];
		throw error;
	}
	const files: string[] = [];
	for (const entry of entries) {
		const candidate = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			throw new ChangelogFragmentError(candidate, `fragments must be files directly under ${directory}/`);
		}
		files.push(candidate);
	}
	return files.sort();
}

interface PackageFragments {
	changelog: string;
	directory: string;
	fragments: ChangelogFragment[];
}

/** Pending fragments for one package changelog, validated and in deterministic order. */
export async function readPackageFragments(changelog: string): Promise<ChangelogFragment[]> {
	const fragments: ChangelogFragment[] = [];
	for (const file of await listFragmentFilesInDirectory(fragmentDirectoryFor(changelog))) {
		fragments.push(await readFragment(file));
	}
	return fragments;
}

/** Delete the fragments a release just folded into its package changelog. */
export async function consumeFragments(fragments: readonly ChangelogFragment[]): Promise<void> {
	for (const fragment of fragments) await Bun.file(fragment.path).delete();
}

/** Repository-relative form of a path, so git output and disk paths compare equal. */
function toRepoPath(file: string): string {
	return file.split(path.sep).join("/");
}

/**
 * Collect and validate every package's pending fragments.
 *
 * Discovery walks `packages/<pkg>/changelog.d` rather than the changelogs, so a
 * fragment filed against a package that has no `CHANGELOG.md` fails closed
 * instead of being silently dropped at the next release.
 */
export async function collectPackageFragments(
	root = ".",
): Promise<{ packages: PackageFragments[]; errors: ChangelogError[] }> {
	const packages: PackageFragments[] = [];
	const errors: ChangelogError[] = [];
	const packagesRoot = path.join(root, "packages");

	let entries: Dirent[];
	try {
		entries = await fs.readdir(packagesRoot, { withFileTypes: true });
	} catch (error) {
		if (isMissingPath(error)) return { packages, errors };
		throw error;
	}

	for (const attempt of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!attempt.isDirectory()) continue;
		const packageDir = path.join(packagesRoot, attempt.name);
		const directory = path.join(packageDir, FRAGMENT_DIRECTORY);

		let files: string[];
		try {
			files = await listFragmentFilesInDirectory(directory);
		} catch (error) {
			errors.push(asChangelogError(error, toRepoPath(directory)));
			continue;
		}
		if (files.length === 0) continue;

		const changelog = path.join(packageDir, "CHANGELOG.md");
		if (!(await Bun.file(changelog).exists())) {
			errors.push({
				file: toRepoPath(directory),
				message:
					`holds fragments for ${toRepoPath(packageDir)}, which has no CHANGELOG.md, so they would never be ` +
					`folded into a changelog. Add the package changelog or file the note against a package that has one.`,
			});
			continue;
		}

		const fragments: ChangelogFragment[] = [];
		for (const file of files) {
			try {
				fragments.push(await readFragment(file));
			} catch (error) {
				errors.push(asChangelogError(error, file));
			}
		}
		packages.push({ changelog, directory, fragments });
	}
	return { packages, errors };
}

function asChangelogError(error: unknown, fallbackFile: string): ChangelogError {
	if (error instanceof ChangelogFragmentError) return { file: error.file, message: error.message };
	return { file: fallbackFile, message: error instanceof Error ? error.message : String(error) };
}

interface UnreleasedRegion {
	/** Index of the `## [Unreleased]` line. */
	heading: number;
	/** Index of the first line after the section (exclusive). */
	end: number;
}

/** Locate the `## [Unreleased]` section, if the changelog has one. */
export function locateUnreleased(content: string): UnreleasedRegion | undefined {
	const lines = content.split("\n");
	for (let index = 0; index < lines.length; index++) {
		if (!UNRELEASED_HEADING.test(lines[index] ?? "")) continue;
		let end = lines.length;
		for (let next = index + 1; next < lines.length; next++) {
			if (ANY_VERSION_HEADING.test(lines[next] ?? "")) {
				end = next;
				break;
			}
		}
		return { heading: index, end };
	}
	return undefined;
}

/** The raw body of the `## [Unreleased]` section, without its heading. */
export function unreleasedBody(content: string): string | undefined {
	const region = locateUnreleased(content);
	if (!region) return undefined;
	return content.split("\n").slice(region.heading + 1, region.end).join("\n");
}

function splitSections(body: string): { preamble: string[]; sections: ChangelogSection[] } {
	const preamble: string[] = [];
	const sections: ChangelogSection[] = [];
	let current: ChangelogSection | undefined;
	for (const line of body.split("\n")) {
		const heading = SECTION_HEADING.exec(line)?.[1]?.trim();
		if (heading !== undefined) {
			current = { heading, lines: [] };
			sections.push(current);
			continue;
		}
		if (current) current.lines.push(line);
		else preamble.push(line);
	}
	return { preamble, sections };
}

function renderBodyLines(preamble: readonly string[], sections: readonly ChangelogSection[]): string[] {
	const blocks: string[] = [];
	const head = trimBlankLines(preamble);
	if (head.length > 0) blocks.push(head.join("\n"));
	for (const section of sections) {
		const entries = trimBlankLines(section.lines);
		blocks.push(entries.length === 0 ? `### ${section.heading}` : `### ${section.heading}\n\n${entries.join("\n")}`);
	}
	if (blocks.length === 0) return [""];
	return ["", ...blocks.join("\n\n").split("\n"), ""];
}

/**
 * Merge pending fragments into an `[Unreleased]` body.
 *
 * Sections the body already carries keep their position and gain the fragment
 * entries (one `### Added` per release, not one per fragment). Headings the body
 * does not have yet are appended in `SECTION_ORDER`.
 */
export function mergeUnreleasedBody(
	body: string,
	fragments: readonly ChangelogFragment[],
): { preamble: string[]; sections: ChangelogSection[] } {
	const { preamble, sections } = splitSections(body);
	const byHeading = new Map<string, ChangelogSection>();
	for (const section of sections) byHeading.set(sectionKey(section.heading), section);

	const introduced: ChangelogSection[] = [];
	for (const fragment of fragments) {
		for (const section of fragment.sections) {
			const key = sectionKey(section.heading);
			const existing = byHeading.get(key);
			if (existing) {
				existing.lines = [...trimBlankLines(existing.lines), "", ...trimBlankLines(section.lines)];
				continue;
			}
			const created: ChangelogSection = { heading: section.heading, lines: [...section.lines] };
			byHeading.set(key, created);
			introduced.push(created);
		}
	}

	introduced.sort((left, right) => sectionRank(left.heading) - sectionRank(right.heading));
	return { preamble, sections: [...sections, ...introduced] };
}

/**
 * Fold every pending fragment into the changelog's `[Unreleased]` section.
 * Returns the content unchanged when there is nothing to fold, and fails closed
 * when fragments exist but the changelog has no section to fold them into.
 */
export function foldFragmentsIntoChangelog(
	content: string,
	fragments: readonly ChangelogFragment[],
	file: string,
): string {
	if (fragments.length === 0) return content;
	const region = locateUnreleased(content);
	if (!region) {
		throw new ChangelogFragmentError(
			file,
			`has pending fragments under ${fragmentDirectoryFor(file)}/ but no '## [Unreleased]' section to fold them into`,
		);
	}
	const lines = content.split("\n");
	const body = lines.slice(region.heading + 1, region.end).join("\n");
	const merged = mergeUnreleasedBody(body, fragments);
	return [
		...lines.slice(0, region.heading + 1),
		...renderBodyLines(merged.preamble, merged.sections),
		...lines.slice(region.end),
	].join("\n");
}

/**
 * Compare the `[Unreleased]` body of one guarded changelog across a range.
 *
 * `dev` requires a PR head to contain the immutable event base, so a difference
 * here is the pull request's own edit to the shared region — the insertion that
 * makes every other in-flight PR conflict and that costs the rebase a fresh
 * exact-head approval.
 */
export function compareUnreleasedEdit(
	file: string,
	baseText: string | undefined,
	headText: string | undefined,
	baseRef = "origin/dev",
): ChangelogError | undefined {
	if (baseText === undefined) return undefined;
	const before = unreleasedBody(baseText);
	if (before === undefined) return undefined;

	const after = headText === undefined ? undefined : unreleasedBody(headText);
	if (after === undefined) {
		return {
			file,
			message:
				`removes the '## [Unreleased]' section. Only the release flow consumes it ` +
				`(scripts/release.ts); a pull request never deletes it. ${fragmentHint(file, baseRef)}`,
		};
	}
	if (trimBlankLines(before.split("\n")).join("\n") === trimBlankLines(after.split("\n")).join("\n")) {
		return undefined;
	}
	return {
		file,
		message:
			`edits the shared '## [Unreleased]' section directly. Those are the exact lines every other in-flight PR also ` +
			`edits, which is what makes this PR dirty after any other merge and invalidates its exact-head approval ` +
			`(issue #5491). ${fragmentHint(file, baseRef)}`,
	};
}

function isGuardedChangelog(changedPath: string): boolean {
	return GUARDED_CHANGELOG.test(changedPath);
}

function isFragmentPath(changedPath: string): boolean {
	return FRAGMENT_PATH.test(changedPath);
}

async function gitShow(rev: string, file: string): Promise<string | undefined> {
	const result = await $`git show ${`${rev}:${file}`}`.quiet().nothrow();
	return result.exitCode === 0 ? result.text() : undefined;
}

async function gitDiffPaths(base: string, head: string, diffFilter: string | undefined): Promise<string[]> {
	const result =
		diffFilter === undefined
			? await $`git diff --name-only ${base} ${head}`.quiet().nothrow()
			: await $`git diff --name-only --diff-filter=${diffFilter} ${base} ${head}`.quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`git diff ${base}..${head} failed: ${result.stderr.toString().trim()}`);
	}
	return result
		.text()
		.split("\n")
		.map(line => line.trim())
		.filter(line => line !== "");
}

async function resolveBase(explicit: string | undefined): Promise<string> {
	if (explicit) return explicit;
	const fromEnv = process.env.GITHUB_BASE_SHA?.trim();
	if (fromEnv) return fromEnv;
	const mergeBase = await $`git merge-base HEAD origin/dev`.quiet().nothrow();
	if (mergeBase.exitCode !== 0) {
		throw new Error("no base: pass --base <sha>, set GITHUB_BASE_SHA, or fetch origin/dev");
	}
	return mergeBase.text().trim();
}

function readFlag(argv: readonly string[], name: string): string | undefined {
	const prefix = `--${name}=`;
	const inline = argv.find(argument => argument.startsWith(prefix));
	if (inline !== undefined) return inline.slice(prefix.length);
	const index = argv.indexOf(`--${name}`);
	return index >= 0 ? argv[index + 1] : undefined;
}

function report(errors: readonly ChangelogError[]): void {
	for (const error of errors) console.error(`::error file=${error.file}::${error.message}`);
}

/** Validate every pending fragment and the section each one folds into. */
async function runCheck(): Promise<number> {
	const { packages, errors } = await collectPackageFragments();
	if (errors.length === 0) {
		for (const entry of packages) {
			try {
				const content = await Bun.file(entry.changelog).text();
				foldFragmentsIntoChangelog(content, entry.fragments, entry.changelog);
			} catch (error) {
				errors.push(asChangelogError(error, entry.changelog));
			}
		}
	}
	if (errors.length > 0) {
		report(errors);
		return 1;
	}
	const fragments = packages.reduce((total, entry) => total + entry.fragments.length, 0);
	console.log(`changelog-fragments: ${fragments} fragment(s) across ${packages.length} package(s) validated`);
	return 0;
}

/** Pull-request guard: no direct `[Unreleased]` edits, no consumed fragments. */
export async function collectPullRequestFragmentViolations(
	base: string,
	head: string,
	baseRef: string,
): Promise<ChangelogError[]> {
	const errors: ChangelogError[] = [];

	for (const file of (await gitDiffPaths(base, head, undefined)).filter(isGuardedChangelog)) {
		const [before, after] = await Promise.all([gitShow(base, file), gitShow(head, file)]);
		const violation = compareUnreleasedEdit(file, before, after, baseRef);
		if (violation) errors.push(violation);
	}

	for (const file of (await gitDiffPaths(base, head, "D")).filter(isFragmentPath)) {
		errors.push({
			file,
			message:
				`is deleted by this pull request. Only the release flow folds and consumes fragments ` +
				`(scripts/release.ts); deleting one here drops an unreleased note without shipping it.`,
		});
	}

	const collected = await collectPackageFragments();
	errors.push(...collected.errors);
	for (const entry of collected.packages) {
		try {
			foldFragmentsIntoChangelog(await Bun.file(entry.changelog).text(), entry.fragments, entry.changelog);
		} catch (error) {
			errors.push(asChangelogError(error, entry.changelog));
		}
	}
	return errors;
}

async function runGuard(baseFlag: string | undefined, headFlag: string | undefined): Promise<number> {
	const base = await resolveBase(baseFlag);
	const head = headFlag ?? "HEAD";
	const errors = await collectPullRequestFragmentViolations(
		base,
		head,
		process.env.GITHUB_BASE_REF ?? "origin/dev",
	);

	if (errors.length > 0) {
		report(errors);
		return 1;
	}
	const { packages } = await collectPackageFragments();
	const fragments = packages.reduce((total, entry) => total + entry.fragments.length, 0);
	console.log(
		`changelog-fragments: no direct [Unreleased] edits, ${fragments} fragment(s) valid (${base.slice(0, 12)}..${head})`,
	);
	return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
	const [first] = argv;
	const command = first !== undefined && !first.startsWith("-") ? first : "check";
	const rest = command === first ? argv.slice(1) : argv;
	if (command === "check") return runCheck();
	if (command === "guard") return runGuard(readFlag(rest, "base"), readFlag(rest, "head"));
	throw new Error(`unknown command ${JSON.stringify(command)}; expected 'check' or 'guard'`);
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
