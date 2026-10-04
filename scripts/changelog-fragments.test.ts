import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	changelogForFragment,
	compareUnreleasedEdit,
	consumeFragments,
	foldFragmentsIntoChangelog,
	fragmentDirectoryFor,
	fragmentNoteLines,
	isConsumedFragmentNote,
	listFragmentFilesInDirectory,
	locateUnreleased,
	parseFragment,
	readFragment,
	readPackageFragments,
	unreleasedBody,
} from "./changelog-fragments";
import { releasedChangelogContent } from "./release";

const repoRoot = path.join(import.meta.dir, "..");
const cliPath = path.join(import.meta.dir, "changelog-fragments.ts");
const historyGuardPath = path.join(import.meta.dir, "changelog-history-guard.ts");
const CHANGELOG = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- An older fix.\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- Something shipped.\n";
const tempDirs: string[] = [];

type Result = { exitCode: number; stdout: string; stderr: string };

async function tempDir(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-changelog-fragments-"));
	tempDirs.push(root);
	return root;
}

async function put(root: string, file: string, content: string): Promise<string> {
	const target = path.join(root, file);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, content);
	return target;
}

async function run(command: readonly string[], cwd: string): Promise<Result> {
	const child = Bun.spawn([...command], {
		cwd,
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_AUTHOR_NAME: "Fragment Test",
			GIT_AUTHOR_EMAIL: "fragment-test@example.invalid",
			GIT_COMMITTER_NAME: "Fragment Test",
			GIT_COMMITTER_EMAIL: "fragment-test@example.invalid",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

const git = (cwd: string, args: readonly string[]) => run(["git", ...args], cwd);

async function commit(root: string, message: string): Promise<void> {
	await git(root, ["add", "-A"]);
	expect((await git(root, ["commit", "-q", "-m", message])).exitCode).toBe(0);
}

async function init(root: string): Promise<void> {
	expect((await git(root, ["init", "-q", "-b", "dev"])).exitCode).toBe(0);
	await put(root, "packages/coding-agent/CHANGELOG.md", CHANGELOG);
	await commit(root, "base");
}

function note(text: string, file = "fragment.md") {
	return { path: file, sections: parseFragment(text, file) };
}

function insert(content: string, entry: string): string {
	return content.replace("### Fixed\n\n", `### Fixed\n\n${entry}\n`);
}
/** What the release fold produces: a newly cut version section carrying the note. */
function cutRelease(note: string): string {
	return CHANGELOG.replace(
		"## [1.0.0] - 2026-01-01",
		`## [1.0.1] - 2026-01-02\n\n### Fixed\n\n${note}\n\n## [1.0.0] - 2026-01-01`,
	);
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("fragment contract", () => {
	test("accepts sections and rejects malformed headings, prose, and empty sections", () => {
		expect(parseFragment("### Fixed\n\n- A fix.\n\n### Added\n\n- A feature.\n", "f.md")).toHaveLength(2);
		for (const source of [
			"## [Unreleased]\n\n- note\n",
			"### Fixed\n\n#### detail\n\n- note\n",
			"prose\n\n### Fixed\n\n- note\n",
			"### Fixed\n\nprose\n",
			"\n",
		]) {
			expect(() => parseFragment(source, "f.md")).toThrow();
		}
	});

	test("validates names and rejects nested fragment directories", async () => {
		const root = await tempDir();
		await put(root, "My Note.md", "### Fixed\n\n- note\n");
		await expect(readFragment(path.join(root, "My Note.md"))).rejects.toThrow(/must match/);
		await fs.mkdir(path.join(root, "changelog.d", "nested"), { recursive: true });
		await expect(listFragmentFilesInDirectory(path.join(root, "changelog.d"))).rejects.toThrow(/directly under/);
	});

	test("discovers package fragments and rejects an orphan package", async () => {
		const root = await tempDir();
		await put(root, "packages/example/CHANGELOG.md", CHANGELOG);
		const file = await put(root, "packages/example/changelog.d/1-note.md", "### Fixed\n\n- note\n");
		const fragments = await readPackageFragments(path.join(root, "packages/example/CHANGELOG.md"));
		expect(fragments).toHaveLength(1);
		expect(fragments[0]?.path).toBe(file);
		await put(root, "packages/ghost/changelog.d/1-note.md", "### Fixed\n\n- orphan\n");
		const result = await run(["bun", cliPath, "check"], root);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("which has no CHANGELOG.md");
	});
});

describe("fold and release", () => {
	test("merges sections in deterministic order without touching released history", () => {
		const folded = foldFragmentsIntoChangelog(
			"# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n",
			[note("### Fixed\n\n- Later fix.\n"), note("### Added\n\n- New feature.\n", "2.md")],
			"packages/coding-agent/CHANGELOG.md",
		);
		expect(folded.indexOf("### Added")).toBeLessThan(folded.indexOf("### Fixed"));
		expect(folded.match(/### Fixed/g)).toHaveLength(1);
		expect(folded).toContain("- Later fix.");
		expect(folded.slice(folded.indexOf("## [1.0.0]")).includes("Later fix")).toBe(false);
		expect(unreleasedBody(folded)).toContain("Later fix");
		expect(locateUnreleased(folded)?.end).toBeGreaterThan(0);
	});

	test("fails closed without [Unreleased] and consumes only folded fragments", async () => {
		expect(() => foldFragmentsIntoChangelog("## [1.0.0]\n", [note("### Fixed\n\n- note\n")], "x/CHANGELOG.md")).toThrow(/no '## \[Unreleased\]' section/);
		const root = await tempDir();
		const first = await put(root, "changelog.d/1.md", "### Fixed\n\n- first\n");
		const second = await put(root, "changelog.d/2.md", "### Fixed\n\n- second\n");
		await consumeFragments([await readFragment(first)]);
		expect(await Bun.file(first).exists()).toBe(false);
		expect(await Bun.file(second).exists()).toBe(true);
	});

	test("release cut ships and consumes pending notes", async () => {
		const root = await tempDir();
		const changelog = await put(root, "packages/coding-agent/CHANGELOG.md", CHANGELOG);
		await put(root, "packages/coding-agent/changelog.d/5491.md", "### Fixed\n\n- Release note.\n");
		const fragments = await readPackageFragments(changelog);
		const folded = foldFragmentsIntoChangelog(await Bun.file(changelog).text(), fragments, changelog);
		const next = releasedChangelogContent(folded, "1.1.0", "2026-03-04", changelog);
		await Bun.write(changelog, next);
		await consumeFragments(fragments);
		expect(next).toContain("## [1.1.0] - 2026-03-04");
		expect(next.slice(next.indexOf("## [1.1.0]")).includes("Release note.")).toBe(true);
		expect(await listFragmentFilesInDirectory(fragmentDirectoryFor(changelog))).toEqual([]);
	});
});

describe("pull request guards", () => {
	test("detects shared edits and permits an unchanged body", () => {
		const file = "packages/coding-agent/CHANGELOG.md";
		expect(compareUnreleasedEdit(file, CHANGELOG, insert(CHANGELOG, "- direct edit"))?.message).toContain("shared");
		expect(compareUnreleasedEdit(file, CHANGELOG, CHANGELOG)).toBeUndefined();
		expect(compareUnreleasedEdit(file, CHANGELOG, CHANGELOG.replace("## [Unreleased]\n\n", ""))).toBeDefined();
	});

	test("real git proves direct insertions conflict while distinct fragments merge", async () => {
		const root = await tempDir();
		await init(root);
		await git(root, ["checkout", "-q", "-b", "pr-a"]);
		await put(root, "packages/coding-agent/CHANGELOG.md", insert(CHANGELOG, "- A"));
		await commit(root, "a");
		await git(root, ["checkout", "-q", "dev"]);
		await git(root, ["checkout", "-q", "-b", "pr-b"]);
		await put(root, "packages/coding-agent/CHANGELOG.md", insert(CHANGELOG, "- B"));
		await commit(root, "b");
		await git(root, ["checkout", "-q", "pr-a"]);
		const direct = await git(root, ["merge", "--no-edit", "pr-b"]);
		expect(direct.exitCode).not.toBe(0);
		expect((await git(root, ["diff", "--name-only", "--diff-filter=U"])).stdout.trim()).toBe("packages/coding-agent/CHANGELOG.md");
		expect((await git(root, ["merge", "--abort"])).exitCode).toBe(0);
		await git(root, ["checkout", "-q", "dev"]);
		await git(root, ["checkout", "-q", "-b", "frag-a"]);
		await put(root, "packages/coding-agent/changelog.d/a.md", "### Fixed\n\n- A\n");
		await commit(root, "fragment a");
		await git(root, ["checkout", "-q", "dev"]);
		await git(root, ["checkout", "-q", "-b", "frag-b"]);
		await put(root, "packages/coding-agent/changelog.d/b.md", "### Fixed\n\n- B\n");
		await commit(root, "fragment b");
		await git(root, ["checkout", "-q", "frag-a"]);
		expect((await git(root, ["merge", "--no-edit", "frag-b"])).exitCode).toBe(0);
		expect((await git(root, ["diff", "--name-only", "--diff-filter=U"])).stdout.trim()).toBe("");
	});
});

describe("CLI entrypoints", () => {
	test("check validates the repository and history guard rejects direct edits", async () => {
		const checked = await run(["bun", cliPath, "check"], repoRoot);
		expect(checked.exitCode).toBe(0);
		expect(checked.stderr).toBe("");
		const root = await tempDir();
		await init(root);
		const base = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
		await git(root, ["checkout", "-q", "-b", "feature"]);
		await put(root, "packages/coding-agent/CHANGELOG.md", insert(CHANGELOG, "- direct"));
		await commit(root, "direct");
		const guarded = await run(["bun", historyGuardPath, "--base", base], root);
		expect(guarded.exitCode).toBe(1);
		expect(guarded.stderr).toContain("edits the shared");
	});
});
describe("release-consumed fragment deletions", () => {
	const fragment = "### Fixed\n\n- A shipped fix.\n";
	const unshipped = "### Fixed\n\n- An unshipped fix.\n";

	test("matches a fragment to its package CHANGELOG and extracts only note lines", () => {
		expect(changelogForFragment("packages/coding-agent/changelog.d/x.md")).toBe("packages/coding-agent/CHANGELOG.md");
		expect(changelogForFragment("crates/pi-natives/changelog.d/x.md")).toBeUndefined();
		expect(changelogForFragment("packages/coding-agent/CHANGELOG.md")).toBeUndefined();
		expect(fragmentNoteLines(fragment)).toEqual(["- A shipped fix."]);
	});

	test("exempts a note this change shipped and fails closed everywhere else", () => {
		// What the release fold produces: a new version section carrying the note.
		const shipped = cutRelease("- A shipped fix.");
		expect(isConsumedFragmentNote(fragment, CHANGELOG, shipped)).toBe(true);
		// The note never landed: deleting the fragment would drop it silently.
		expect(isConsumedFragmentNote(fragment, CHANGELOG, CHANGELOG)).toBe(false);
		// The note was already in an older release, so this change did not ship it. Content
		// alone must never exempt a deletion — that is the loophole the guard exists for.
		expect(isConsumedFragmentNote(fragment, shipped, shipped)).toBe(false);
		// The note is parked under a version heading that already existed, so no release cut
		// a section for it. Nothing put it there but the PR itself.
		expect(isConsumedFragmentNote(fragment, CHANGELOG, insert(CHANGELOG, "- A shipped fix."))).toBe(false);
		// A new section that does not carry the note ships nothing.
		expect(isConsumedFragmentNote(fragment, CHANGELOG, cutRelease("- Something else."))).toBe(false);
		// A date-only move is not a release cut, so a note parked beside it does not ship.
		const dateTweak = CHANGELOG.replace("2026-01-01", "2026-01-09").replace(
			"### Fixed\n\n",
			"### Fixed\n\n- A shipped fix.\n",
		);
		expect(isConsumedFragmentNote(fragment, CHANGELOG, dateTweak)).toBe(false);
		// An empty newly cut section does not host a note parked elsewhere.
		expect(
			isConsumedFragmentNote(
				fragment,
				CHANGELOG,
				`${insert(CHANGELOG, "- A shipped fix.")}\n## [9.9.9] - 2026-01-03\n\n### Fixed\n\n- Unrelated.\n`,
			),
		).toBe(false);
		// Padding a version heading's identifier must not forge a newly cut section: the
		// history guard trims, so it sees the same released version and no removal.
		const paddedHeading = CHANGELOG.replace("## [1.0.0]", "## [ 1.0.0 ]").replace(
			"### Fixed\n\n",
			"### Fixed\n\n- A shipped fix.\n",
		);
		expect(isConsumedFragmentNote(fragment, CHANGELOG, paddedHeading)).toBe(false);
		expect(isConsumedFragmentNote(undefined, CHANGELOG, shipped)).toBe(false);
		expect(isConsumedFragmentNote(fragment, undefined, shipped)).toBe(false);
		expect(isConsumedFragmentNote(fragment, CHANGELOG, undefined)).toBe(false);
		expect(isConsumedFragmentNote("### Fixed\n\n", CHANGELOG, shipped)).toBe(false);
	});

	test("documents the exact-line contract: a reformatted note is not treated as shipped", () => {
		// foldFragmentsIntoChangelog copies fragment lines verbatim, so a wrapped or
		// re-indented CHANGELOG entry is intentionally not an exemption. This is a
		// fail-closed false positive (a blocked release PR), never a silent drop.
		expect(isConsumedFragmentNote(fragment, CHANGELOG, cutRelease("- A shipped\n  fix."))).toBe(false);
	});

	test("the guard permits a backmerge that consumes a released fragment and still rejects a dropped note", async () => {
		// The released CHANGELOG has an empty [Unreleased] body, so folding a note into a
		// new version section is the only edit and the shared-body guard stays quiet.
		const released = "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- Something shipped.\n";
		const shipped = released.replace(
			"## [1.0.0] - 2026-01-01",
			"## [1.1.0] - 2026-10-04\n\n### Fixed\n\n- A shipped fix.\n\n## [1.0.0] - 2026-01-01",
		);
		const root = await tempDir();
		expect((await git(root, ["init", "-q", "-b", "dev"])).exitCode).toBe(0);
		await put(root, "packages/coding-agent/CHANGELOG.md", released);
		// Both fragments exist at the base so each one shows up as a deletion at the head.
		await put(root, "packages/coding-agent/changelog.d/x.md", fragment);
		await put(root, "packages/coding-agent/changelog.d/keep.md", unshipped);
		await commit(root, "base");
		const base = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();

		// The release flow folds x's note into the CHANGELOG and consumes x.
		await put(root, "packages/coding-agent/CHANGELOG.md", shipped);
		await git(root, ["rm", "-q", "packages/coding-agent/changelog.d/x.md"]);
		await commit(root, "release consumes x");
		const consumed = await run(["bun", historyGuardPath, "--base", base], root);
		expect(consumed.stderr).not.toContain("is deleted by this pull request");
		expect(consumed.exitCode).toBe(0);

		await git(root, ["rm", "-q", "packages/coding-agent/changelog.d/keep.md"]);
		await commit(root, "drops an unreleased note");
		const dropped = await run(["bun", historyGuardPath, "--base", base], root);
		expect(dropped.exitCode).toBe(1);
		expect(dropped.stderr).toContain("keep.md");
		expect(dropped.stderr).toContain("is deleted by this pull request");
	});
});
