import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type ChangelogFragment,
	compareUnreleasedEdit,
	consumeFragments,
	foldFragmentsIntoChangelog,
	fragmentDirectoryFor,
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

const CHANGELOG = [
	"# Changelog",
	"",
	"## [Unreleased]",
	"",
	"### Fixed",
	"",
	"- An older fix.",
	"",
	"## [1.0.0] - 2026-01-01",
	"",
	"### Added",
	"",
	"- Something shipped.",
	"",
].join("\n");

/** The exact insertion the old contributor contract asked for: a bullet under [Unreleased]. */
function prependUnreleasedBullet(content: string, entry: string): string {
	return content.replace("### Fixed\n\n", `### Fixed\n\n${entry}\n`);
}

const temporaryDirectories: string[] = [];

async function makeTempDir(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-changelog-fragments-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function writeFile(root: string, relativePath: string, content: string): Promise<string> {
	const file = path.join(root, relativePath);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, content);
	return file;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function runCommand(command: readonly string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<CommandResult> {
	const proc = Bun.spawn([...command], {
		cwd,
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_AUTHOR_NAME: "Fragment Test",
			GIT_AUTHOR_EMAIL: "fragment-test@example.invalid",
			GIT_COMMITTER_NAME: "Fragment Test",
			GIT_COMMITTER_EMAIL: "fragment-test@example.invalid",
			...extraEnv,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function git(cwd: string, args: readonly string[]): Promise<CommandResult> {
	return runCommand(["git", ...args], cwd);
}

async function commitAll(root: string, message: string): Promise<void> {
	await git(root, ["add", "-A"]);
	const commit = await git(root, ["commit", "-q", "-m", message]);
	expect(commit.exitCode).toBe(0);
}

async function initRepo(root: string): Promise<void> {
	expect((await git(root, ["init", "-q", "-b", "dev"])).exitCode).toBe(0);
	await writeFile(root, "packages/coding-agent/CHANGELOG.md", CHANGELOG);
	await commitAll(root, "base");
}

async function unmergedPaths(root: string): Promise<string[]> {
	const result = await git(root, ["diff", "--name-only", "--diff-filter=U"]);
	return result.stdout.split("\n").filter(line => line.trim() !== "");
}

function fragment(file: string, content: string): ChangelogFragment {
	return { path: file, sections: parseFragment(content, file) };
}

describe("fragment validation", () => {
	test("accepts section blocks whose entries are bullets", () => {
		const sections = parseFragment("### Fixed\n\n- A fix (#1).\n\n### Added\n\n- A feature.\n", "f.md");

		expect(sections.map(section => section.heading)).toEqual(["Fixed", "Added"]);
		expect(sections[0]?.lines.some(line => line.includes("A fix"))).toBe(true);
	});

	test("rejects a fragment that carries its own version heading", () => {
		expect(() => parseFragment("## [Unreleased]\n\n- A note.\n", "f.md")).toThrow(/only '### <Section>' headings/);
	});

	test("rejects nested headings so the folded section cannot grow subheadings", () => {
		expect(() => parseFragment("### Fixed\n\n#### Detail\n\n- A note.\n", "f.md")).toThrow(/only '### <Section>' headings/);
	});

	test("rejects prose before the first section heading", () => {
		expect(() => parseFragment("Some context.\n\n### Fixed\n\n- A note.\n", "f.md")).toThrow(/before any section heading/);
	});

	test("rejects a section with no bullet entry", () => {
		expect(() => parseFragment("### Fixed\n\nNothing to say.\n", "f.md")).toThrow(/has no '- ' bullet entry/);
	});

	test("rejects an empty fragment", () => {
		expect(() => parseFragment("\n", "f.md")).toThrow(/declares no '### <Section>' heading/);
	});

	test("rejects fragment file names that are not lowercase slugs", async () => {
		const root = await makeTempDir();
		const awkward = await writeFile(root, "My Note.md", "### Fixed\n\n- A note.\n");
		await expect(readFragment(awkward)).rejects.toThrow(/must match/);

		const acceptable = await writeFile(root, "5491-rebase-free-release-notes.md", "### Fixed\n\n- A note.\n");
		await expect(readFragment(acceptable)).resolves.toMatchObject({ path: acceptable });
	});

	test("rejects nested directories inside changelog.d", async () => {
		const root = await makeTempDir();
		await fs.mkdir(path.join(root, "changelog.d", "nested"), { recursive: true });

		await expect(listFragmentFilesInDirectory(path.join(root, "changelog.d"))).rejects.toThrow(
			/fragments must be files directly under/,
		);
	});

	test("treats a missing changelog.d directory as no fragments", async () => {
		const root = await makeTempDir();
		await expect(listFragmentFilesInDirectory(path.join(root, "packages", "x", "changelog.d"))).resolves.toEqual([]);
	});

	test("derives the fragment directory from the package changelog", () => {
		expect(fragmentDirectoryFor(path.join("packages", "coding-agent", "CHANGELOG.md"))).toBe(
			path.join("packages", "coding-agent", "changelog.d"),
		);
	});
});

describe("folding fragments into [Unreleased]", () => {
	test("returns the changelog unchanged when there is nothing pending", () => {
		expect(foldFragmentsIntoChangelog(CHANGELOG, [], "packages/coding-agent/CHANGELOG.md")).toBe(CHANGELOG);
	});

	test("introduces new sections in canonical order", () => {
		const folded = foldFragmentsIntoChangelog(
			"# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n- shipped\n",
			[
				fragment("a.md", "### Fixed\n\n- Fixed later.\n"),
				fragment("b.md", "### Added\n\n- Added first.\n"),
			],
			"packages/coding-agent/CHANGELOG.md",
		);

		expect(folded.indexOf("### Added")).toBeLessThan(folded.indexOf("### Fixed"));
		expect(folded).toContain("- Added first.\n");
		expect(folded).toContain("- Fixed later.\n");
	});

	test("merges fragment entries into an existing section instead of duplicating its heading", () => {
		const folded = foldFragmentsIntoChangelog(
			CHANGELOG,
			[fragment("a.md", "### Fixed\n\n- Fixed by A.\n"), fragment("b.md", "### Fixed\n\n- Fixed by B.\n")],
			"packages/coding-agent/CHANGELOG.md",
		);

		expect(folded.match(/### Fixed/g)).toHaveLength(1);
		expect(folded).toContain("- An older fix.");
		expect(folded).toContain("- Fixed by A.");
		expect(folded).toContain("- Fixed by B.");
		expect(folded).toContain("## [1.0.0] - 2026-01-01");
	});

	test("never lets pending notes land in a released section", () => {
		const folded = foldFragmentsIntoChangelog(
			CHANGELOG,
			[fragment("a.md", "### Fixed\n\n- Fixed now.\n")],
			"packages/coding-agent/CHANGELOG.md",
		);

		const releasedSection = folded.slice(folded.indexOf("## [1.0.0] - 2026-01-01"));
		expect(releasedSection).not.toContain("Fixed now.");
	});

	test("is idempotent once the fragments have been folded", () => {
		const fragments = [fragment("a.md", "### Fixed\n\n- Fixed now.\n")];
		const once = foldFragmentsIntoChangelog(CHANGELOG, fragments, "packages/coding-agent/CHANGELOG.md");

		expect(foldFragmentsIntoChangelog(once, [], "packages/coding-agent/CHANGELOG.md")).toBe(once);
		expect(unreleasedBody(once)).toContain("- Fixed now.");
	});

	test("fails closed when fragments exist but the changelog has no [Unreleased] section", () => {
		expect(() =>
			foldFragmentsIntoChangelog(
				"# Changelog\n\n## [1.0.0] - 2026-01-01\n\n- shipped\n",
				[fragment("a.md", "### Fixed\n\n- Fixed now.\n")],
				"packages/coding-agent/CHANGELOG.md",
			),
		).toThrow(/no '## \[Unreleased\]' section/);
	});

	test("consumes exactly the fragments it folded", async () => {
		const root = await makeTempDir();
		const file = await writeFile(root, "changelog.d/1-fixed.md", "### Fixed\n\n- Fixed now.\n");
		const consumed = await readFragment(file);
		const untouched = await writeFile(root, "changelog.d/2-fixed.md", "### Fixed\n\n- Still pending.\n");

		await consumeFragments([consumed]);

		expect(await Bun.file(file).exists()).toBe(false);
		expect(await Bun.file(untouched).exists()).toBe(true);
	});

	test("locates the [Unreleased] section without swallowing released history", () => {
		const region = locateUnreleased(CHANGELOG);
		expect(region).toBeDefined();
		expect(CHANGELOG.split("\n")[region!.end]).toBe("## [1.0.0] - 2026-01-01");
		expect(unreleasedBody(CHANGELOG)).toContain("- An older fix.");
		expect(unreleasedBody("# Changelog\n\n## [1.0.0] - 2026-01-01\n")).toBeUndefined();
	});
});

describe("direct [Unreleased] edits", () => {
	const file = "packages/coding-agent/CHANGELOG.md";

	test("rejects an insertion under [Unreleased] and names the fragment path", () => {
		const violation = compareUnreleasedEdit(file, CHANGELOG, prependUnreleasedBullet(CHANGELOG, "- Fixed by A."));

		expect(violation).toBeDefined();
		expect(violation!.message).toContain("edits the shared '## [Unreleased]' section directly");
		expect(violation!.message).toContain("changelog.d");
	});

	test("rejects removing an unreleased entry", () => {
		const violation = compareUnreleasedEdit(file, CHANGELOG, CHANGELOG.replace("- An older fix.\n", ""));

		expect(violation).toBeDefined();
	});

	test("rejects dropping the [Unreleased] heading in a pull request", () => {
		const violation = compareUnreleasedEdit(file, CHANGELOG, CHANGELOG.replace("## [Unreleased]\n\n", ""));

		expect(violation).toBeDefined();
		expect(violation!.message).toContain("removes the '## [Unreleased]' section");
	});

	test("accepts a head that leaves the shared section untouched", () => {
		expect(compareUnreleasedEdit(file, CHANGELOG, CHANGELOG)).toBeUndefined();
		expect(compareUnreleasedEdit(file, undefined, CHANGELOG)).toBeUndefined();
		expect(compareUnreleasedEdit(file, CHANGELOG, undefined)).toBeDefined();
	});
});

describe("merge behavior that made the shared insertion point expensive", () => {
	test("two pull requests inserting under [Unreleased] conflict, two fragments do not", async () => {
		const root = await makeTempDir();
		await initRepo(root);
		const changelogPath = path.join(root, "packages/coding-agent/CHANGELOG.md");

		// The old contributor contract: both branches insert at the same position.
		await git(root, ["checkout", "-q", "-b", "pr-a"]);
		await writeFile(root, "packages/coding-agent/CHANGELOG.md", prependUnreleasedBullet(CHANGELOG, "- Fixed by A (#1)."));
		await commitAll(root, "pr a");

		await git(root, ["checkout", "-q", "dev"]);
		await git(root, ["checkout", "-q", "-b", "pr-b"]);
		await writeFile(root, "packages/coding-agent/CHANGELOG.md", prependUnreleasedBullet(CHANGELOG, "- Fixed by B (#2)."));
		await commitAll(root, "pr b");

		await git(root, ["checkout", "-q", "pr-a"]);
		const conflicted = await git(root, ["merge", "--no-edit", "pr-b"]);
		expect(conflicted.exitCode).not.toBe(0);
		expect(await unmergedPaths(root)).toEqual(["packages/coding-agent/CHANGELOG.md"]);
		expect((await git(root, ["merge", "--abort"])).exitCode).toBe(0);

		// The fragment contract: distinct file names cannot conflict.
		await git(root, ["checkout", "-q", "dev"]);
		await git(root, ["checkout", "-q", "-b", "frag-a"]);
		await writeFile(root, "packages/coding-agent/changelog.d/1-fixed-by-a.md", "### Fixed\n\n- Fixed by A (#1).\n");
		await commitAll(root, "fragment a");

		await git(root, ["checkout", "-q", "dev"]);
		await git(root, ["checkout", "-q", "-b", "frag-b"]);
		await writeFile(root, "packages/coding-agent/changelog.d/2-fixed-by-b.md", "### Fixed\n\n- Fixed by B (#2).\n");
		await commitAll(root, "fragment b");

		await git(root, ["checkout", "-q", "frag-a"]);
		const merged = await git(root, ["merge", "--no-edit", "frag-b"]);
		expect(merged.exitCode).toBe(0);
		expect(await unmergedPaths(root)).toEqual([]);
		expect(await Bun.file(changelogPath).text()).toBe(CHANGELOG);

		// Both notes still reach the shipped changelog at release time.
		const directory = fragmentDirectoryFor("packages/coding-agent/CHANGELOG.md");
		const fragments: ChangelogFragment[] = [];
		for (const name of await listFragmentFilesInDirectory(path.join(root, directory))) {
			fragments.push(await readFragment(name));
		}
		expect(fragments).toHaveLength(2);
		const folded = foldFragmentsIntoChangelog(CHANGELOG, fragments, "packages/coding-agent/CHANGELOG.md");
		expect(folded.match(/### Fixed/g)).toHaveLength(1);
		expect(folded).toContain("- Fixed by A (#1).");
		expect(folded).toContain("- Fixed by B (#2).");
	});
});

describe("release cut", () => {
	test("ships pending fragments in the versioned section and consumes them", async () => {
		const root = await makeTempDir();
		const changelog = await writeFile(root, "packages/coding-agent/CHANGELOG.md", CHANGELOG);
		await writeFile(
			root,
			"packages/coding-agent/changelog.d/5491-release-notes.md",
			"### Fixed\n\n- Fixed by the release note (#5491).\n",
		);

		// Mirrors scripts/release.ts: read pending fragments, fold them, cut the
		// version, then consume exactly what was folded.
		const fragments = await readPackageFragments(changelog);
		expect(fragments).toHaveLength(1);
		const folded = foldFragmentsIntoChangelog(await Bun.file(changelog).text(), fragments, changelog);
		const next = releasedChangelogContent(folded, "1.1.0", "2026-03-04", "packages/coding-agent/CHANGELOG.md");
		await Bun.write(changelog, next);
		await consumeFragments(fragments);

		expect(next).toContain("## [1.1.0] - 2026-03-04");
		expect(next.match(/## \[Unreleased\]/g)).toHaveLength(1);
		expect(next.indexOf("## [Unreleased]")).toBeLessThan(next.indexOf("## [1.1.0] - 2026-03-04"));
		const shipped = next.slice(next.indexOf("## [1.1.0] - 2026-03-04"));
		expect(shipped).toContain("- Fixed by the release note (#5491).");
		expect(shipped).toContain("- An older fix.");
		expect(shipped).not.toContain("## [Unreleased]");
		expect(next).toContain("- Something shipped.");
		expect(await listFragmentFilesInDirectory(fragmentDirectoryFor(changelog))).toEqual([]);

		// A later cut with nothing pending still ships a version heading.
		const secondCut = releasedChangelogContent(next, "1.2.0", "2026-04-05", "packages/coding-agent/CHANGELOG.md");
		expect(secondCut).toContain("## [1.2.0] - 2026-04-05");
		expect(secondCut.match(/## \[Unreleased\]/g)).toHaveLength(1);
		expect(secondCut).toContain("## [1.1.0] - 2026-03-04");
		expect(secondCut).toContain("## [1.0.0] - 2026-01-01");
	});
});

describe("changelog-fragments CLI", () => {
	test("validates this repository's fragments", async () => {
		const result = await runCommand(["bun", cliPath, "check"], repoRoot);

		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("changelog-fragments:");
	});

	test("rejects a pull request that edits [Unreleased] directly", async () => {
		const root = await makeTempDir();
		await initRepo(root);
		const base = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();

		await git(root, ["checkout", "-q", "-b", "feature"]);
		await writeFile(root, "packages/coding-agent/CHANGELOG.md", prependUnreleasedBullet(CHANGELOG, "- Fixed by A (#1)."));
		await commitAll(root, "direct edit");

		const result = await runCommand(["bun", cliPath, "guard"], root, { GITHUB_BASE_SHA: base });

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("::error file=packages/coding-agent/CHANGELOG.md::");
		expect(result.stderr).toContain("changelog.d");
	});

	test("accepts a pull request that adds a fragment instead", async () => {
		const root = await makeTempDir();
		await initRepo(root);
		const base = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();

		await git(root, ["checkout", "-q", "-b", "feature"]);
		await writeFile(root, "packages/coding-agent/changelog.d/1-fixed-by-a.md", "### Fixed\n\n- Fixed by A (#1).\n");
		await commitAll(root, "fragment");

		const result = await runCommand(["bun", cliPath, "guard"], root, { GITHUB_BASE_SHA: base });

		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("no direct [Unreleased] edits");
	});

	test("rejects a pull request that consumes a fragment", async () => {
		const root = await makeTempDir();
		await initRepo(root);
		await writeFile(root, "packages/coding-agent/changelog.d/1-fixed-by-a.md", "### Fixed\n\n- Fixed by A (#1).\n");
		await commitAll(root, "fragment");
		const base = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();

		await git(root, ["checkout", "-q", "-b", "feature"]);
		await fs.rm(path.join(root, "packages/coding-agent/changelog.d/1-fixed-by-a.md"));
		await commitAll(root, "consume");

		const result = await runCommand(["bun", cliPath, "guard"], root, { GITHUB_BASE_SHA: base });

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("is deleted by this pull request");
	});

	test("rejects a malformed fragment in check mode", async () => {
		const root = await makeTempDir();
		await initRepo(root);
		await writeFile(root, "packages/coding-agent/changelog.d/1-bad.md", "No section heading here.\n");

		const result = await runCommand(["bun", cliPath, "check"], root);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("must open with '### <Section>'");
	});

	test("rejects a fragment filed against a package with no changelog", async () => {
		const root = await makeTempDir();
		await initRepo(root);
		await writeFile(root, "packages/ghost/changelog.d/1-note.md", "### Fixed\n\n- A note for nobody.\n");

		const result = await runCommand(["bun", cliPath, "check"], root);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("which has no CHANGELOG.md");
	});
});

// Dev CI already invokes changelog-history-guard on every pull request, so the
// fragment contract has to hold through that same entrypoint.
describe("Dev CI changelog guard entrypoint", () => {
	test("rejects a direct [Unreleased] edit", async () => {
		const root = await makeTempDir();
		await initRepo(root);
		const base = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();

		await git(root, ["checkout", "-q", "-b", "feature"]);
		await writeFile(root, "packages/coding-agent/CHANGELOG.md", prependUnreleasedBullet(CHANGELOG, "- Fixed by A (#1)."));
		await commitAll(root, "direct edit");

		const result = await runCommand(["bun", historyGuardPath, "--base", base], root);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("edits the shared '## [Unreleased]' section directly");
	});

	test("still rejects removed released history", async () => {
		const root = await makeTempDir();
		await initRepo(root);
		const base = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();

		await git(root, ["checkout", "-q", "-b", "feature"]);
		await writeFile(root, "packages/coding-agent/CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n- An older fix.\n");
		await commitAll(root, "drop released section");

		const result = await runCommand(["bun", historyGuardPath, "--base", base], root);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("removes 1 released section");
	});

	test("passes a fragment-only pull request", async () => {
		const root = await makeTempDir();
		await initRepo(root);
		const base = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();

		await git(root, ["checkout", "-q", "-b", "feature"]);
		await writeFile(root, "packages/coding-agent/changelog.d/1-fixed-by-a.md", "### Fixed\n\n- Fixed by A (#1).\n");
		await commitAll(root, "fragment");

		const result = await runCommand(["bun", historyGuardPath, "--base", base], root);

		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("no direct [Unreleased] edits");
	});
});
