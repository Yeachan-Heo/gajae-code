import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PublicCommandFailure, renderPublicCommandFailure } from "../src/cli/public-command-errors";
import type { SdkSessionRowV1 } from "../src/sdk/cli/rows";
import {
	boundWarningSources,
	filterSessionRowsByScope,
	parseSessionListScope,
	resolveSessionListSelection,
	runSdkSessionCli,
	type SdkSessionCliArgs,
	SESSION_LIST_WARNING_LIMIT,
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
		let failure: unknown;
		const args: SdkSessionCliArgs = { action: "list", scope: "bogus", agentDir: path.join(tempRoot, "unused") };
		try {
			await runSdkSessionCli(args, value => outputs.push(value));
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(PublicCommandFailure);
		expect(outputs).toEqual([]);
		const rendered = await renderPublicCommandFailure(failure, { command: ["sdk", "session", "list"], json: true });
		expect(rendered.exitCode).toBe(2);
		expect(rendered.envelope).toMatchObject({ ok: false, error: { code: "usage", outcomeCertainty: "not-applied" } });
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

describe("scope exclusion warnings are bounded", () => {
	/** Builds excluded non-Git rows for scope-warning cases. */
	async function nonGitRows(count: number, prefix: string): Promise<SdkSessionRowV1[]> {
		const rows: SdkSessionRowV1[] = [];
		for (let index = 0; index < count; index++) {
			const workspace = path.join(tempRoot, `${prefix}-${index}`);
			await mkdir(workspace, { recursive: true });
			rows.push(row(`s-${prefix}-${index}`, workspace));
		}
		return rows;
	}

	test("emits every warning while at or below the limit", async () => {
		const repo = await makeRepo("warn-at-limit");
		const selection = await resolveSessionListSelection("repo", repo);
		const rows = await nonGitRows(SESSION_LIST_WARNING_LIMIT, "atlimit");

		const filtered = await filterSessionRowsByScope(rows, "repo", selection);

		expect(filtered.sessions).toEqual([]);
		expect(filtered.warnings).toHaveLength(SESSION_LIST_WARNING_LIMIT);
		expect(filtered.warningEntries).toHaveLength(SESSION_LIST_WARNING_LIMIT);
		expect(filtered.warningCount).toBe(SESSION_LIST_WARNING_LIMIT);
		// No summary line is added when nothing was omitted.
		expect(filtered.warnings.every(warning => warning.startsWith("Session "))).toBe(true);
	});

	test("collapses the tail into one summary carrying the exact total", async () => {
		const repo = await makeRepo("warn-over-limit");
		const selection = await resolveSessionListSelection("repo", repo);
		const excluded = SESSION_LIST_WARNING_LIMIT + 7;
		const rows = await nonGitRows(excluded, "overlimit");

		const filtered = await filterSessionRowsByScope(rows, "repo", selection);

		// Bounded regardless of how many sessions exist on the machine.
		expect(filtered.warnings).toHaveLength(SESSION_LIST_WARNING_LIMIT);
		expect(filtered.warningEntries).toHaveLength(SESSION_LIST_WARNING_LIMIT - 1);
		expect(filtered.warningCount).toBe(excluded);
		const summary = filtered.warnings.at(-1) ?? "";
		expect(summary).toBe(`8 further session workspaces were excluded by scope repo; ${excluded} excluded in total.`);
		// The retained sample is still individual, credential-free exclusion text.
		for (const warning of filtered.warnings.slice(0, SESSION_LIST_WARNING_LIMIT - 1)) {
			expect(warning).toContain("is outside Git; excluded by scope repo.");
		}
	});

	test("uses reason-neutral wording for summaries across unavailable and non-Git rows", async () => {
		const repo = await makeRepo("warn-mixed-reasons");
		const selection = await resolveSessionListSelection("repo", repo);
		const unknownRows = Array.from({ length: 6 }, (_, index) => row(`s-unknown-${index}`, "unknown"));
		const outsideGitRows = await nonGitRows(6, "mixed-reasons");
		const rows = [...unknownRows, ...outsideGitRows];

		const filtered = await filterSessionRowsByScope(rows, "repo", selection);

		expect(filtered.warnings).toHaveLength(SESSION_LIST_WARNING_LIMIT);
		expect(filtered.warningEntries).toHaveLength(SESSION_LIST_WARNING_LIMIT - 1);
		expect(filtered.warningCount).toBe(rows.length);
		expect(filtered.warningEntries.some(warning => warning.includes("workspace is unavailable"))).toBe(true);
		expect(filtered.warningEntries.some(warning => warning.includes("is outside Git"))).toBe(true);
		const summary = filtered.warnings.at(-1) ?? "";
		expect(summary).toBe(
			`3 further session workspaces were excluded by scope repo; ${rows.length} excluded in total.`,
		);
		expect(summary).not.toContain("outside Git");
	});

	test("scope all filters nothing and therefore warns about nothing", async () => {
		const repo = await makeRepo("warn-scope-all");
		const selection = await resolveSessionListSelection("all", repo);
		const rows = await nonGitRows(SESSION_LIST_WARNING_LIMIT + 5, "scopeall");

		const filtered = await filterSessionRowsByScope(rows, "all", selection);

		expect(filtered.sessions).toHaveLength(rows.length);
		expect(filtered.warnings).toEqual([]);
	});

	// A bounded sample is smaller than the actual number of excluded workspaces; keep that exact
	// count available independently so downstream aggregation cannot mistake the sample length for it.
	test("keeps the scope summary and its exact total when many warnings are excluded", async () => {
		const repo = await makeRepo("warn-exact-total");
		const selection = await resolveSessionListSelection("repo", repo);
		const excluded = SESSION_LIST_WARNING_LIMIT * 20;
		const rows = await nonGitRows(excluded, "exacttotal");

		const filtered = await filterSessionRowsByScope(rows, "repo", selection);

		expect(filtered.warnings).toHaveLength(SESSION_LIST_WARNING_LIMIT);
		expect(filtered.warningEntries).toHaveLength(SESSION_LIST_WARNING_LIMIT - 1);
		const summary = filtered.warnings.at(-1) ?? "";
		// The stated total must be the real number excluded, never the collapsed length.
		expect(summary).toContain(`${excluded} excluded in total.`);
		expect(summary).not.toContain(`${SESSION_LIST_WARNING_LIMIT} excluded in total.`);
	});

	test("counts source summaries inside the global warning cap", () => {
		const warnings = boundWarningSources([
			{
				entries: Array.from({ length: 20 }, (_, index) => `broker-${index}`),
				describeOmitted: count => `${count} broker warnings omitted`,
			},
			{
				entries: Array.from({ length: 20 }, (_, index) => `scope-${index}`),
				describeOmitted: count => `${count} scope warnings omitted`,
			},
		]);

		expect(warnings).toHaveLength(SESSION_LIST_WARNING_LIMIT);
		expect(warnings.at(-2)).toBe("12 broker warnings omitted");
		expect(warnings.at(-1)).toBe("20 scope warnings omitted");
	});

	test("fills the global cap when one source needs a summary", () => {
		const warnings = boundWarningSources([
			{ entries: ["broker"], describeOmitted: count => `${count} broker omitted` },
			{
				entries: Array.from({ length: SESSION_LIST_WARNING_LIMIT }, (_, index) => `scope-${index}`),
				describeOmitted: count => `${count} scope omitted`,
			},
		]);

		expect(warnings).toHaveLength(SESSION_LIST_WARNING_LIMIT);
		expect(warnings.at(-1)).toBe("2 scope omitted");
	});

	test("reserves summaries when a later source crosses the global cap", () => {
		const warnings = boundWarningSources([
			{
				entries: Array.from({ length: SESSION_LIST_WARNING_LIMIT }, (_, index) => `broker-${index}`),
				describeOmitted: count => `${count} broker omitted`,
			},
			{ entries: ["scope"], describeOmitted: count => `${count} scope omitted` },
		]);

		expect(warnings).toHaveLength(SESSION_LIST_WARNING_LIMIT);
		expect(warnings.at(-2)).toBe("2 broker omitted");
		expect(warnings.at(-1)).toBe("1 scope omitted");
	});

	test("does not emit a summary when a source fits within its allocation", () => {
		const warnings = boundWarningSources([{ entries: ["one"], describeOmitted: count => `${count} omitted` }]);

		expect(warnings).toEqual(["one"]);
	});

	test("does not report omissions when all ten warnings fit globally", () => {
		const warnings = boundWarningSources([
			{
				entries: Array.from({ length: SESSION_LIST_WARNING_LIMIT }, (_, index) => `warning-${index}`),
				describeOmitted: count => `${count} omitted`,
			},
		]);

		expect(warnings).toHaveLength(SESSION_LIST_WARNING_LIMIT);
		expect(warnings).not.toContain("0 omitted");
	});

	test("preserves exact counts when globally bounding sampled scope warnings", () => {
		const warnings = boundWarningSources([
			{ entries: ["broker warning"], describeOmitted: count => `${count} broker warnings omitted` },
			{
				entries: Array.from({ length: SESSION_LIST_WARNING_LIMIT - 1 }, (_, index) => `scope-${index}`),
				totalCount: 20,
				describeOmitted: count =>
					`${count} further session workspaces were excluded by scope repo; 20 excluded in total.`,
			},
		]);

		expect(warnings).toHaveLength(SESSION_LIST_WARNING_LIMIT);
		expect(warnings.at(-1)).toBe("12 further session workspaces were excluded by scope repo; 20 excluded in total.");
	});

	test("keeps helper results bounded when many sources each need a summary", () => {
		const warnings = boundWarningSources(
			Array.from({ length: SESSION_LIST_WARNING_LIMIT + 1 }, (_, index) => ({
				entries: [],
				totalCount: 1,
				describeOmitted: count => `source-${index}: ${count} omitted`,
			})),
		);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("source-10: 1 omitted");
	});

	test("allows an unfiltered all-scope listing outside Git", async () => {
		const result = await resolveSessionListSelection("all", path.join(tempRoot, "not-a-repository"));
		expect(result.descriptor).toEqual({ scope: "all", path: path.join(tempRoot, "not-a-repository") });
	});

	test("resolves a real relative workspace named unknown instead of treating it as a sentinel", async () => {
		const repo = await makeRepo("unknown");
		const originalCwd = process.cwd();
		process.chdir(tempRoot);
		try {
			const result = await resolveSessionListSelection("cwd", "unknown");
			expect(result.descriptor.path).toBe(repo);
			expect(result.selection.repoRoot).toBe(repo);
		} finally {
			process.chdir(originalCwd);
		}
	});

	test("never matches the unknown locator to cwd", async () => {
		const repo = await makeRepo("unknown-cwd");
		const unknownPath = path.join(repo, "unknown");
		await mkdir(unknownPath);
		const selection = await resolveSessionListSelection("cwd", unknownPath);
		const row = {
			sessionId: "unknown-row",
			locator: { cwd: "unknown", worktreeRoot: null, stateRoot: path.join(repo, ".gjc") },
		} as unknown as SdkSessionRowV1;
		const filtered = await filterSessionRowsByScope([row], "cwd", {
			scope: "cwd",
			selection: selection.selection,
			descriptor: selection.descriptor,
		});
		expect(filtered.sessions).toEqual([]);
		expect(filtered.warnings).toEqual(["Session unknown-row workspace is unavailable; excluded by scope cwd."]);
		expect(filtered.warningEntries).toEqual(["Session unknown-row workspace is unavailable; excluded by scope cwd."]);
		expect(filtered.warningCount).toBe(1);
	});
});
