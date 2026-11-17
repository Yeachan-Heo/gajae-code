#!/usr/bin/env bun

/** Per-change release-note fragments, folded by scripts/release.ts. */

import { $ } from "bun";
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const FRAGMENT_DIRECTORY = "changelog.d";
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

const FRAGMENT_NAME = /^[a-z0-9][a-z0-9._-]*\.md$/;
const GUARDED_CHANGELOG = /^packages\/[^/]+\/CHANGELOG\.md$/;
const FRAGMENT_PATH = /^packages\/[^/]+\/changelog\.d\/[^/]+$/;
const UNRELEASED_HEADING = /^##\s+\[Unreleased\]\s*$/u;
const VERSION_HEADING = /^##\s+/u;
const VERSIONED_HEADING = /^##\s+\[([^\]]+)\]/u;
const UNRELEASED_VERSION = "unreleased";
const SECTION_HEADING = /^###\s+(.+?)\s*$/u;
const ANY_HEADING = /^#+\s/u;
const BULLET = /^\s*-\s+\S/u;

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

function sectionKey(heading: string): string {
	return heading.trim().toLowerCase();
}

function sectionRank(heading: string): number {
	const index = SECTION_ORDER.findIndex(value => value.toLowerCase() === sectionKey(heading));
	return index === -1 ? SECTION_ORDER.length : index;
}

function trimBlankLines(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && (lines[start] ?? "").trim() === "") start += 1;
	while (end > start && (lines[end - 1] ?? "").trim() === "") end -= 1;
	return lines.slice(start, end).map(line => line.replace(/[ \t]+$/u, ""));
}

/** Parse the deliberately narrow fragment format. */
export function parseFragment(content: string, file: string): ChangelogSection[] {
	const sections: ChangelogSection[] = [];
	let current: ChangelogSection | undefined;

	for (const [index, line] of content.split(/\r?\n/u).entries()) {
		if (ANY_HEADING.test(line)) {
			const heading = SECTION_HEADING.exec(line)?.[1]?.trim();
			if (!heading) {
				throw new ChangelogFragmentError(
					file,
					`line ${index + 1} is not a fragment section heading; use only '### <Section>' headings`,
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

/** Fragments are direct children and are sorted for deterministic releases. */
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

export function fragmentDirectoryFor(changelog: string): string {
	return path.join(path.dirname(changelog), FRAGMENT_DIRECTORY);
}

export async function readPackageFragments(changelog: string): Promise<ChangelogFragment[]> {
	const fragments: ChangelogFragment[] = [];
	for (const file of await listFragmentFilesInDirectory(fragmentDirectoryFor(changelog))) {
		fragments.push(await readFragment(file));
	}
	return fragments;
}

export async function consumeFragments(fragments: readonly ChangelogFragment[]): Promise<void> {
	for (const fragment of fragments) await Bun.file(fragment.path).delete();
}

function toRepoPath(file: string): string {
	return file.split(path.sep).join("/");
}

interface PackageFragments {
	changelog: string;
	directory: string;
	fragments: ChangelogFragment[];
}

function asChangelogError(error: unknown, fallbackFile: string): ChangelogError {
	if (error instanceof ChangelogFragmentError) return { file: error.file, message: error.message };
	return { file: fallbackFile, message: error instanceof Error ? error.message : String(error) };
}

/** Discover every package fragment and reject orphan or malformed notes. */
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

	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.isDirectory()) continue;
		const packageDir = path.join(packagesRoot, entry.name);
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
					`holds fragments for ${toRepoPath(packageDir)}, which has no CHANGELOG.md, so they would never be folded into a changelog. ` +
					"Add the package changelog or file the note against a package that has one.",
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

interface UnreleasedRegion {
	heading: number;
	end: number;
}

export function locateUnreleased(content: string): UnreleasedRegion | undefined {
	const lines = content.split("\n");
	for (let heading = 0; heading < lines.length; heading += 1) {
		if (!UNRELEASED_HEADING.test(lines[heading] ?? "")) continue;
		let end = lines.length;
		for (let next = heading + 1; next < lines.length; next += 1) {
			if (VERSION_HEADING.test(lines[next] ?? "")) {
				end = next;
				break;
			}
		}
		return { heading, end };
	}
	return undefined;
}

export function unreleasedBody(content: string): string | undefined {
	const region = locateUnreleased(content);
	return region ? content.split("\n").slice(region.heading + 1, region.end).join("\n") : undefined;
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
		} else if (current) {
			current.lines.push(line);
		} else {
			preamble.push(line);
		}
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
	return blocks.length === 0 ? [""] : ["", ...blocks.join("\n\n").split("\n"), ""];
}

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
			} else {
				const created = { heading: section.heading, lines: [...section.lines] };
				byHeading.set(key, created);
				introduced.push(created);
			}
		}
	}
	introduced.sort((left, right) => sectionRank(left.heading) - sectionRank(right.heading));
	return { preamble, sections: [...sections, ...introduced] };
}

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
	return [...lines.slice(0, region.heading + 1), ...renderBodyLines(merged.preamble, merged.sections), ...lines.slice(region.end)].join("\n");
}

function fragmentHint(file: string, baseRef: string): string {
	return (
		`Put the note in ${fragmentDirectoryFor(file)}/<slug>.md as a '### <Section>' heading with '- ' bullet entries, ` +
		`and restore the shared section with: git checkout ${baseRef} -- ${file}`
	);
}

/** Return a violation when a PR changes the shared unreleased body. */
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
				`removes the '## [Unreleased]' section. Only the release flow consumes it (scripts/release.ts); a pull request never deletes it. ` +
				fragmentHint(file, baseRef),
		};
	}
	if (trimBlankLines(before.split("\n")).join("\n") === trimBlankLines(after.split("\n")).join("\n")) return undefined;
	return {
		file,
		message:
			`edits the shared '## [Unreleased]' section directly. Those are the exact lines every other in-flight PR also edits, which is what makes this PR dirty after any other merge and invalidates its exact-head approval (issue #5491). ` +
			fragmentHint(file, baseRef),
	};
}

function isGuardedChangelog(file: string): boolean {
	return GUARDED_CHANGELOG.test(file);
}

function isFragmentPath(file: string): boolean {
	return FRAGMENT_PATH.test(file);
}

async function gitShow(revision: string, file: string): Promise<string | undefined> {
	const result = await $`git show ${`${revision}:${file}`}`.quiet().nothrow();
	return result.exitCode === 0 ? result.text() : undefined;
}

async function gitDiffPaths(base: string, head: string, filter?: string): Promise<string[]> {
	const result = filter === undefined
		? await $`git diff --name-only ${base} ${head}`.quiet().nothrow()
		: await $`git diff --name-only --diff-filter=${filter} ${base} ${head}`.quiet().nothrow();
	if (result.exitCode !== 0) throw new Error(`git diff ${base}..${head} failed: ${result.stderr.toString().trim()}`);
	return result.text().split("\n").map(line => line.trim()).filter(Boolean);
}

async function resolveBase(explicit: string | undefined): Promise<string> {
	if (explicit) return explicit;
	const fromEnv = process.env.GITHUB_BASE_SHA?.trim();
	if (fromEnv) return fromEnv;
	const result = await $`git merge-base HEAD origin/dev`.quiet().nothrow();
	if (result.exitCode !== 0) throw new Error("no base: pass --base <sha>, set GITHUB_BASE_SHA, or fetch origin/dev");
	return result.text().trim();
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

export async function runCheck(): Promise<number> {
	const { packages, errors } = await collectPackageFragments();
	if (errors.length === 0) {
		for (const entry of packages) {
			try {
				foldFragmentsIntoChangelog(await Bun.file(entry.changelog).text(), entry.fragments, entry.changelog);
			} catch (error) {
				errors.push(asChangelogError(error, entry.changelog));
			}
		}
	}
	if (errors.length > 0) {
		report(errors);
		return 1;
	}
	const count = packages.reduce((total, entry) => total + entry.fragments.length, 0);
	console.log(`changelog-fragments: ${count} fragment(s) across ${packages.length} package(s) validated`);
	return 0;
}

/** Collapse whitespace so a fragment bullet and its folded changelog line compare equal. */
function normalizeNote(line: string): string {
	return line.replace(/\s+/gu, " ").trim();
}

/** Released version a heading declares, or undefined for `[Unreleased]` and ordinary headings. */
function releasedVersion(line: string): string | undefined {
	const version = VERSIONED_HEADING.exec(line)?.[1]?.trim().toLowerCase();
	return version === undefined || version === UNRELEASED_VERSION ? undefined : version;
}

interface ImportedReleaseSection {
	version: string;
	notes: Set<string>;
}

/**
 * Released sections this range imports: their heading is present at `head` and absent from
 * the same changelog at `base`. Bodies stay per section, so evidence cannot be assembled
 * across sections, from `[Unreleased]`, or from a release dev already had.
 */
function importedReleaseSections(head: string | undefined, base: string | undefined): ImportedReleaseSection[] {
	if (head === undefined) return [];
	const existing = new Set<string>();
	for (const line of (base ?? "").split("\n")) {
		const version = releasedVersion(line);
		if (version !== undefined) existing.add(version);
	}
	const sections: ImportedReleaseSection[] = [];
	let current: ImportedReleaseSection | undefined;
	for (const line of head.split("\n")) {
		if (VERSION_HEADING.test(line)) {
			const version = releasedVersion(line);
			current = version === undefined || existing.has(version) ? undefined : { version, notes: new Set() };
			if (current !== undefined) sections.push(current);
			continue;
		}
		if (current !== undefined && BULLET.test(line)) current.notes.add(normalizeNote(line));
	}
	return sections;
}

/** `- ` notes a fragment declares, whitespace-normalized. */
function declaredNotes(fragment: string): string[] {
	return fragment
		.split(/\r?\n/u)
		.filter(line => BULLET.test(line))
		.map(normalizeNote);
}

function changelogForFragment(file: string): string {
	return `${file.slice(0, file.indexOf(`/${FRAGMENT_DIRECTORY}/`))}/CHANGELOG.md`;
}

/**
 * Fold evidence for a deleted fragment: every `- ` note it declared appears verbatim
 * (whitespace-normalized) inside one released `## [x.y.z]` section that this range imports.
 *
 * A release can fold a dev-origin fragment into changelog text `main` already tracks while
 * never deleting the fragment in its own commit, because `main` never tracked the file. The
 * `vX.Y.Z` tag then records no deletion for `releaseConsumedFragments` to find, so the folded
 * notes are the only surviving evidence that the note shipped. `[Unreleased]` never counts:
 * text parked there has not shipped.
 */
async function foldedIntoImportedRelease(
	base: string,
	file: string,
	importedFor: (changelog: string) => Promise<ImportedReleaseSection[]>,
): Promise<boolean> {
	const source = await gitShow(base, file);
	if (source === undefined) return false;
	const declared = declaredNotes(source);
	if (declared.length === 0) return false;
	const imported = await importedFor(changelogForFragment(file));
	return imported.some(section => declared.every(note => section.notes.has(note)));
}

export async function collectPullRequestFragmentViolations(
	base: string,
	head: string,
	baseRef: string,
): Promise<ChangelogError[]> {
	const errors: ChangelogError[] = [];
	for (const file of (await gitDiffPaths(base, head)).filter(isGuardedChangelog)) {
		const [before, after] = await Promise.all([gitShow(base, file), gitShow(head, file)]);
		const violation = compareUnreleasedEdit(file, before, after, baseRef);
		if (violation) errors.push(violation);
	}
	const consumed = await releaseConsumedFragments(base, head);
	const imports = new Map<string, Promise<ImportedReleaseSection[]>>();
	const importedFor = (changelog: string): Promise<ImportedReleaseSection[]> => {
		let imported = imports.get(changelog);
		if (imported === undefined) {
			imported = Promise.all([gitShow(head, changelog), gitShow(base, changelog)]).then(([now, before]) =>
				importedReleaseSections(now, before),
			);
			imports.set(changelog, imported);
		}
		return imported;
	};
	for (const file of (await gitDiffPaths(base, head, "D")).filter(isFragmentPath)) {
		if (consumed.has(file)) continue;
		if (await foldedIntoImportedRelease(base, file, importedFor)) continue;
		errors.push({
			file,
			message:
				"is deleted by this pull request. Only the release flow folds and consumes fragments (scripts/release.ts); deleting one here drops an unreleased note without shipping it. " +
				`No reachable stable release tag in this range deleted it, and not all of its '- ' notes appear inside one released '## [x.y.z]' section that this pull request imports into ${changelogForFragment(file)}.`,
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

const STABLE_RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

/**
 * Fragments consumed by a release that this range brings in, keyed by path.
 *
 * Release provenance is the stable `vX.Y.Z` tag that `scripts/release.ts` places on
 * its version-bump commit, and that commit is where the fragments are folded and
 * deleted. A release backmerge merges a tag that is reachable from `head` but not from
 * `base`, so the deletions that tagged commit made are legitimate in this range. Any
 * other deletion needs its own evidence, which `foldedIntoImportedRelease` supplies when
 * the released changelog already carries the fragment's notes; absent both, it is a
 * violation.
 */
async function releaseConsumedFragments(base: string, head: string): Promise<Set<string>> {
	const listed = await $`git tag --list ${"v*"} --merged ${head} --no-merged ${base}`.quiet().nothrow();
	if (listed.exitCode !== 0) throw new Error(`git tag --merged ${head} failed: ${listed.stderr.toString().trim()}`);
	const consumed = new Set<string>();
	const tags = listed.text().split("\n").map(line => line.trim()).filter(tag => STABLE_RELEASE_TAG.test(tag));
	for (const tag of tags) {
		for (const file of await gitDiffPaths(`${tag}^1`, tag, "D")) {
			if (isFragmentPath(file)) consumed.add(file);
		}
	}
	return consumed;
}

export async function runGuard(baseFlag: string | undefined, headFlag: string | undefined): Promise<number> {
	const base = await resolveBase(baseFlag);
	const head = headFlag ?? "HEAD";
	const errors = await collectPullRequestFragmentViolations(base, head, process.env.GITHUB_BASE_REF ?? "origin/dev");
	if (errors.length > 0) {
		report(errors);
		return 1;
	}
	const { packages } = await collectPackageFragments();
	const count = packages.reduce((total, entry) => total + entry.fragments.length, 0);
	console.log(`changelog-fragments: no direct [Unreleased] edits, ${count} fragment(s) valid (${base.slice(0, 12)}..${head})`);
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

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
