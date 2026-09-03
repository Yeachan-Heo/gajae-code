import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SdkSessionRowV1 } from "../src/sdk/cli/rows";
import {
	filterSessionRowsByScope,
	parseSessionListScope,
	resolveSessionListSelection,
	runSdkSessionCli,
	type SdkSessionCliArgs,
} from "../src/sdk/cli/session-cli";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-session-scope-"));

async function git(cwd: string, ...args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
	const code = await proc.exited;
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
}

async function makeRepo(name: string): Promise<string> {
	const repoPath = path.join(tempRoot, name);
	await mkdir(repoPath, { recursive: true });
	await git(repoPath, "init", "-q");
	await git(repoPath, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");
	return repoPath;
}

function row(sessionId: string, repoLocator: string): SdkSessionRowV1 {
	return {
		sessionId,
		locator: { cwd: repoLocator, worktreeRoot: repoLocator, stateRoot: `${repoLocator}/.gjc/state` },
		endpointGeneration: 1,
		pid: 100,
		live: false,
		deleted: false,
		indexSeq: 0,
	};
}

afterAll(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

describe("sdk session list scope parsing", () => {
	test("missing scope defaults to repo", () => {
		expect(parseSessionListScope(undefined)).toBe("repo");
	});

	test("accepts every documented scope", () => {
		for (const scope of ["repo", "cwd", "worktree", "all"] as const) {
			expect(parseSessionListScope(scope)).toBe(scope);
		}
	});

	test("invalid scope fails usage with exit 2", () => {
		try {
			parseSessionListScope("bogus");
			throw new Error("expected usage failure");
		} catch (error) {
			expect((error as { code: string; exitCode: number }).code).toBe("usage");
			expect((error as { exitCode: number }).exitCode).toBe(2);
		}
	});

	test("runSdkSessionCli exits 2 on an invalid scope before broker contact", async () => {
		const outputs: unknown[] = [];
		let exitCode: number | undefined;
		const args: SdkSessionCliArgs = { action: "list", scope: "bogus", agentDir: path.join(tempRoot, "unused") };
		await runSdkSessionCli(
			args,
			value => outputs.push(value),
			code => {
				exitCode = code;
			},
		);
		expect(exitCode).toBe(2);
		const record = outputs[0] as { ok: boolean; error: { code: string } };
		expect(record.ok).toBe(false);
		expect(record.error.code).toBe("usage");
	});
});

describe("sdk session list scope filtering", () => {
	test("repo scope spans the main checkout and linked worktrees and excludes another repo", async () => {
		const main = await makeRepo("main");
		const worktree = path.join(tempRoot, "wt");
		await git(main, "worktree", "add", "-b", "feature", worktree);
		const other = await makeRepo("other");
		const scope = "repo";
		const { selection } = await resolveSessionListSelection(scope, main);
		const filtered = await filterSessionRowsByScope(
			[row("s-main", main), row("s-wt", worktree), row("s-other", other)],
			scope,
			{ scope, selection, descriptor: { scope, path: main } },
		);
		expect(filtered.sessions.map(candidate => candidate.sessionId).sort()).toEqual(["s-main", "s-wt"]);
	});

	test("worktree scope distinguishes checkouts of the same repository", async () => {
		const main = await makeRepo("main2");
		const worktree = path.join(tempRoot, "wt2");
		await git(main, "worktree", "add", "-b", "feature2", worktree);
		const worktreeSelection = await resolveSessionListSelection("worktree", worktree);
		const filtered = await filterSessionRowsByScope(
			[row("s-main", main), row("s-wt", worktree)],
			"worktree",
			worktreeSelection,
		);
		expect(filtered.sessions.map(candidate => candidate.sessionId)).toEqual(["s-wt"]);
		expect(worktreeSelection.descriptor.worktreeRoot).toBe(worktree);
		const mainSelection = await resolveSessionListSelection("worktree", main);
		expect(mainSelection.descriptor.worktreeRoot).toBe(main);
	});

	test("cwd scope is an exact canonical match and excludes nested workspaces", async () => {
		const repo = await makeRepo("cwdrepo");
		const nested = path.join(repo, "packages", "app");
		await mkdir(nested, { recursive: true });
		const { selection } = await resolveSessionListSelection("cwd", repo);
		const filtered = await filterSessionRowsByScope(
			[row("s-exact", repo), row("s-nested", nested), row("s-elsewhere", tempRoot)],
			"cwd",
			{ scope: "cwd", selection, descriptor: { scope: "cwd", path: repo } },
		);
		expect(filtered.sessions.map(candidate => candidate.sessionId)).toEqual(["s-exact"]);
	});

	test("all scope returns the full unfiltered listing", async () => {
		const main = await makeRepo("allrepo");
		const other = await makeRepo("allother");
		const rows = [row("s-a", main), row("s-b", other), row("s-c", tempRoot)];
		const { selection } = await resolveSessionListSelection("all", main);
		const filtered = await filterSessionRowsByScope(rows, "all", {
			scope: "all",
			selection,
			descriptor: { scope: "all", path: main },
		});
		expect(filtered.sessions).toHaveLength(3);
		expect(filtered.warnings).toEqual([]);
	});

	test("symlinked selection and row workspaces canonicalize to the same identity", async () => {
		const repo = await makeRepo("symrepo");
		const link = path.join(tempRoot, "symrepo-link");
		await symlink(repo, link, "dir");
		const selection = await resolveSessionListSelection("cwd", link);
		expect(selection.selection.canonicalPath).toBe(repo);
		const filtered = await filterSessionRowsByScope(
			[row("s-via-link", link), row("s-direct", repo)],
			"cwd",
			selection,
		);
		expect(filtered.sessions.map(candidate => candidate.sessionId).sort()).toEqual(["s-direct", "s-via-link"]);
	});

	test("non-Git selection: repo/worktree fail typed without broadening, cwd still matches", async () => {
		const plain = path.join(tempRoot, "plain");
		await mkdir(plain, { recursive: true });
		for (const scope of ["repo", "worktree"] as const) {
			try {
				await resolveSessionListSelection(scope, plain);
				throw new Error("expected not_a_repository");
			} catch (error) {
				expect((error as { code: string; exitCode: number }).code).toBe("not_a_repository");
				expect((error as { exitCode: number }).exitCode).toBe(1);
			}
		}
		const cwdSelection = await resolveSessionListSelection("cwd", plain);
		const filtered = await filterSessionRowsByScope(
			[row("s-plain", plain), row("s-git", tempRoot)],
			"cwd",
			cwdSelection,
		);
		expect(filtered.sessions.map(candidate => candidate.sessionId)).toEqual(["s-plain"]);
		const allSelection = await resolveSessionListSelection("all", plain);
		expect(allSelection.descriptor.worktreeRoot).toBeUndefined();
		const everything = await filterSessionRowsByScope(
			[row("s-plain", plain), row("s-git", tempRoot)],
			"all",
			allSelection,
		);
		expect(everything.sessions.map(candidate => candidate.sessionId).sort()).toEqual(["s-git", "s-plain"]);
	});

	test("removed row workspaces are excluded deterministically with a warning", async () => {
		const repo = await makeRepo("gonerepo");
		const gone = path.join(repo, "removed-workspace");
		await mkdir(gone, { recursive: true });
		const { selection } = await resolveSessionListSelection("repo", repo);
		await rm(gone, { recursive: true, force: true });
		const filtered = await filterSessionRowsByScope([row("s-gone", gone), row("s-here", repo)], "repo", {
			scope: "repo",
			selection,
			descriptor: { scope: "repo", path: repo },
		});
		expect(filtered.sessions.map(candidate => candidate.sessionId)).toEqual(["s-here"]);
		expect(filtered.warnings.join("\n")).toContain("s-gone");
	});

	test("unknown projected locators never resolve relative to the process cwd", async () => {
		const repo = await makeRepo("unknown-locator");
		const selection = await resolveSessionListSelection("repo", repo);
		const filtered = await filterSessionRowsByScope(
			[row("s-unknown", "unknown"), row("s-repo", repo)],
			"repo",
			selection,
		);
		expect(filtered.sessions.map(candidate => candidate.sessionId)).toEqual(["s-repo"]);
	});

	test("matching rows are retained regardless of their position in the fully traversed listing", async () => {
		const main = await makeRepo("pager");
		const other = await makeRepo("pagerother");
		const rows = [row("p1", other), row("p2", other), row("p-late", main), row("p3", other)];
		const selection = await resolveSessionListSelection("repo", main);
		const filtered = await filterSessionRowsByScope(rows, "repo", selection);
		expect(filtered.sessions.map(candidate => candidate.sessionId)).toEqual(["p-late"]);
	});
});
