import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scanWorktrees } from "../src/cli/worktree-scanner";

const temporaryDirectories: string[] = [];

type ScannerFixture = {
	worktreeDir: string;
	worktreesRoot: string;
};

type LiveFixture = ScannerFixture & {
	parentRepo: string;
};
type LiveFixtureOptions = {
	adminName?: string;
	head?: string;
	nested?: boolean;
	pointerSuffix?: string;
};

async function createLiveFixture(
	pointerKind: "absolute" | "relative",
	options: LiveFixtureOptions = {},
): Promise<LiveFixture> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-worktree-scan-")));
	temporaryDirectories.push(root);
	const worktreesRoot = path.join(root, "worktrees");
	const worktreeDir = options.nested
		? path.join(worktreesRoot, "legacy-project", "checkout")
		: path.join(worktreesRoot, "checkout");
	const parentRepo = path.join(root, "parent repo");
	const parentGitDir = path.join(parentRepo, ".git", "worktrees", options.adminName ?? "checkout");
	await fs.mkdir(worktreeDir, { recursive: true });
	await fs.mkdir(parentGitDir, { recursive: true });
	await fs.writeFile(
		path.join(parentGitDir, "HEAD"),
		options.head ?? "ref: refs/heads/feature/relative-pointer\n",
		"utf8",
	);
	const pointer = pointerKind === "relative" ? path.relative(worktreeDir, parentGitDir) : parentGitDir;
	await fs.writeFile(path.join(worktreeDir, ".git"), `gitdir: ${pointer}${options.pointerSuffix ?? "\n"}`, "utf8");
	return { parentRepo, worktreeDir, worktreesRoot };
}

async function createPointerFixture(pointer: string): Promise<ScannerFixture> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-worktree-scan-")));
	temporaryDirectories.push(root);
	const worktreesRoot = path.join(root, "worktrees");
	const worktreeDir = path.join(worktreesRoot, "checkout");
	await fs.mkdir(worktreeDir, { recursive: true });
	await fs.writeFile(path.join(worktreeDir, ".git"), pointer, "utf8");
	return { worktreeDir, worktreesRoot };
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("managed worktree scanning", () => {
	it.each(["relative", "absolute"] as const)("keeps a live checkout with a %s gitdir pointer", async pointerKind => {
		const fixture = await createLiveFixture(pointerKind);

		expect(await scanWorktrees(fixture.worktreesRoot)).toEqual([
			{
				path: fixture.worktreeDir,
				kind: "pr-checkout",
				parentRepo: fixture.parentRepo,
				branch: "feature/relative-pointer",
			},
		]);
	});
	it("handles CRLF and detached HEAD metadata without orphaning", async () => {
		const fixture = await createLiveFixture("relative", {
			head: `${"a".repeat(40)}\n`,
			pointerSuffix: "\r\n",
		});

		expect(await scanWorktrees(fixture.worktreesRoot)).toEqual([
			{
				path: fixture.worktreeDir,
				kind: "pr-checkout",
				parentRepo: fixture.parentRepo,
				branch: undefined,
			},
		]);
	});
	it.each([
		"\r",
		"\n\n",
		"\r\n\r\n",
		"\r\r\n",
	])("accepts Git-compatible trailing line-ending runs: %p", async pointerSuffix => {
		const fixture = await createLiveFixture("relative", { pointerSuffix });

		expect(await scanWorktrees(fixture.worktreesRoot)).toEqual([
			{
				path: fixture.worktreeDir,
				kind: "pr-checkout",
				parentRepo: fixture.parentRepo,
				branch: "feature/relative-pointer",
			},
		]);
	});

	it("preserves whitespace that belongs to the gitdir path", async () => {
		const fixture = await createLiveFixture("relative", { adminName: "checkout " });

		expect(await scanWorktrees(fixture.worktreesRoot)).toEqual([
			{
				path: fixture.worktreeDir,
				kind: "pr-checkout",
				parentRepo: fixture.parentRepo,
				branch: "feature/relative-pointer",
			},
		]);
	});

	it("does not discard trailing spaces from a missing gitdir target", async () => {
		const fixture = await createLiveFixture("relative", { pointerSuffix: "   \n" });

		expect(await scanWorktrees(fixture.worktreesRoot)).toEqual([
			{
				path: fixture.worktreeDir,
				kind: "pr-checkout",
				parentRepo: fixture.parentRepo,
				branch: undefined,
				orphanReason: "parent repo no longer tracks this worktree",
			},
		]);
	});

	it("resolves relative gitdir pointers from the nested legacy checkout directory", async () => {
		const fixture = await createLiveFixture("relative", { nested: true });

		expect(await scanWorktrees(fixture.worktreesRoot)).toEqual([
			{
				path: fixture.worktreeDir,
				kind: "pr-checkout",
				parentRepo: fixture.parentRepo,
				branch: "feature/relative-pointer",
			},
		]);
	});
	it("resolves a relative gitdir from the real location of a symlinked checkout", async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-worktree-scan-")));
		temporaryDirectories.push(root);
		const worktreesRoot = path.join(root, "worktrees");
		const actualWorktreeDir = path.join(root, "actual", "deep", "checkout");
		const linkedWorktreeDir = path.join(worktreesRoot, "checkout-link");
		const parentRepo = path.join(root, "parent repo");
		const parentGitDir = path.join(parentRepo, ".git", "worktrees", "checkout");
		await fs.mkdir(actualWorktreeDir, { recursive: true });
		await fs.mkdir(parentGitDir, { recursive: true });
		await fs.writeFile(path.join(parentGitDir, "HEAD"), "ref: refs/heads/feature/symlink\n", "utf8");
		await fs.writeFile(
			path.join(actualWorktreeDir, ".git"),
			`gitdir: ${path.relative(actualWorktreeDir, parentGitDir)}\n`,
			"utf8",
		);
		await fs.mkdir(worktreesRoot, { recursive: true });
		await fs.symlink(actualWorktreeDir, linkedWorktreeDir, process.platform === "win32" ? "junction" : "dir");

		expect(await scanWorktrees(worktreesRoot)).toEqual([
			{
				path: linkedWorktreeDir,
				kind: "pr-checkout",
				parentRepo,
				branch: "feature/symlink",
			},
		]);
	});

	it("resolves a missing relative gitdir before reporting the checkout as orphaned", async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-worktree-scan-")));
		temporaryDirectories.push(root);
		const expectedParentRepo = path.join(root, "missing parent");
		const missingGitDir = path.join(expectedParentRepo, ".git", "worktrees", "checkout");
		const worktreeDir = path.join(root, "worktrees", "checkout");
		await fs.mkdir(worktreeDir, { recursive: true });
		await fs.writeFile(path.join(worktreeDir, ".git"), `gitdir: ${path.relative(worktreeDir, missingGitDir)}\n`);

		const [entry] = await scanWorktrees(path.join(root, "worktrees"));
		expect(entry).toMatchObject({
			path: worktreeDir,
			kind: "pr-checkout",
			parentRepo: expectedParentRepo,
			orphanReason: "parent repo no longer tracks this worktree",
		});
		expect(path.isAbsolute(entry?.parentRepo ?? "")).toBe(true);
	});

	it.each([
		"not a gitdir file\n",
		"gitdir:\n",
		"gitdir: \n",
		"gitdir:\t../../repo/.git/worktrees/checkout\n",
		"gitdir:\n../../repo/.git/worktrees/checkout\n",
		"prefix\ngitdir: ../../repo/.git/worktrees/checkout\n",
		"gitdir: ../../repo/.git/worktrees/checkout\nextra\n",
	])("rejects invalid gitfile syntax: %p", async contents => {
		const fixture = await createPointerFixture(contents);

		expect(await scanWorktrees(fixture.worktreesRoot)).toEqual([
			{
				path: fixture.worktreeDir,
				kind: "pr-checkout",
				orphanReason: "malformed .git file (no gitdir line)",
			},
		]);
	});
});
