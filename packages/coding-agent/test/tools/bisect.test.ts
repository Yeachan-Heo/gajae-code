import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type BisectMarkResult,
	BisectTool,
	type BisectVerdict,
	BUILTIN_TOOLS,
	classifyExit,
	parseFirstBadCommit,
	runBisectController,
	type ToolSession,
} from "@gajae-code/coding-agent/tools";

const FORTY_HEX = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

function session(cwd: string): ToolSession {
	return { cwd, hasUI: false, getSessionFile: () => null } as unknown as ToolSession;
}

// ── temp-repo helpers ────────────────────────────────────────────────────────

const tempRoots: string[] = [];

async function gitRun(cwd: string, args: string[]): Promise<string> {
	const child = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
	return stdout.trim();
}

async function makeRepo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-bisect-"));
	tempRoots.push(dir);
	await gitRun(dir, ["init", "-q"]);
	await gitRun(dir, ["config", "user.email", "test@example.com"]);
	await gitRun(dir, ["config", "user.name", "Bisect Test"]);
	await gitRun(dir, ["config", "commit.gpgsign", "false"]);
	return dir;
}

async function commitFlag(cwd: string, content: string, message: string): Promise<string> {
	await fs.writeFile(path.join(cwd, "flag.txt"), content);
	// A per-commit marker so consecutive commits with the same flag content still
	// differ; the bisect predicate only ever inspects flag.txt.
	await fs.writeFile(path.join(cwd, "seq.txt"), `${message}\n`);
	await gitRun(cwd, ["add", "-A"]);
	await gitRun(cwd, ["commit", "-q", "-m", message]);
	return gitRun(cwd, ["rev-parse", "HEAD"]);
}

afterEach(async () => {
	while (tempRoots.length > 0) {
		const dir = tempRoots.pop()!;
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
});

// ── pure helpers ─────────────────────────────────────────────────────────────

describe("parseFirstBadCommit", () => {
	it("extracts the culprit SHA from real git bisect output", () => {
		const output = `${FORTY_HEX} is the first bad commit\ncommit ${FORTY_HEX}\nAuthor: X\n`;
		expect(parseFirstBadCommit(output)).toBe(FORTY_HEX);
	});

	it("accepts abbreviated SHAs", () => {
		expect(parseFirstBadCommit("abc1234 is the first bad commit")).toBe("abc1234");
	});

	it("returns null before the search has converged", () => {
		expect(parseFirstBadCommit("Bisecting: 3 revisions left to test after this (roughly 2 steps)")).toBeNull();
	});

	it("does not match the phrase mid-line", () => {
		expect(parseFirstBadCommit("note: xyz is the first bad commit reported earlier by hand")).toBeNull();
	});
});

describe("classifyExit", () => {
	it("maps exit codes to verdicts", () => {
		expect(classifyExit(0, false)).toBe("good");
		expect(classifyExit(1, false)).toBe("bad");
		expect(classifyExit(2, false)).toBe("bad");
		expect(classifyExit(125, false)).toBe("skip");
	});

	it("swaps good/bad when inverted but leaves skip untouched", () => {
		expect(classifyExit(0, true)).toBe("bad");
		expect(classifyExit(1, true)).toBe("good");
		expect(classifyExit(125, true)).toBe("skip");
	});
});

describe("runBisectController", () => {
	function scriptedController(verdicts: BisectVerdict[], marks: BisectMarkResult[], maxSteps = 40) {
		let index = 0;
		return {
			maxSteps,
			currentRev: async () => `rev-${index}`,
			evaluate: async () => verdicts[Math.min(index, verdicts.length - 1)]!,
			mark: async () => marks[index++]!,
		};
	}

	it("converges on the culprit and records every step", async () => {
		const outcome = await runBisectController(
			scriptedController(
				["good", "bad"],
				[
					{ exitCode: 0, output: "Bisecting: 1 revision left to test after this" },
					{ exitCode: 0, output: `${FORTY_HEX} is the first bad commit\ncommit ${FORTY_HEX}` },
				],
			),
		);
		expect(outcome.concluded).toBe(true);
		expect(outcome.culprit).toBe(FORTY_HEX);
		expect(outcome.steps.map(step => step.verdict)).toEqual(["good", "bad"]);
	});

	it("reports a git mark failure without a culprit", async () => {
		const outcome = await runBisectController(
			scriptedController(["good"], [{ exitCode: 128, output: "fatal: bad revision" }]),
		);
		expect(outcome.concluded).toBe(false);
		expect(outcome.culprit).toBeNull();
		expect(outcome.reason).toContain("fatal: bad revision");
	});

	it("stops when only skipped commits remain", async () => {
		const outcome = await runBisectController(
			scriptedController(["skip"], [{ exitCode: 0, output: "There are only 'skip'ped commits left to test." }]),
		);
		expect(outcome.concluded).toBe(false);
		expect(outcome.reason).toMatch(/skip/i);
	});

	it("gives up at the step limit", async () => {
		const outcome = await runBisectController(
			scriptedController(
				["good", "good", "good"],
				[
					{ exitCode: 0, output: "Bisecting: keep going" },
					{ exitCode: 0, output: "Bisecting: keep going" },
					{ exitCode: 0, output: "Bisecting: keep going" },
				],
				3,
			),
		);
		expect(outcome.concluded).toBe(false);
		expect(outcome.steps).toHaveLength(3);
		expect(outcome.reason).toContain("3-step limit");
	});
});

// ── integration against a real repository ────────────────────────────────────

describe("BisectTool.execute", () => {
	it("finds the first bad commit and restores the worktree", async () => {
		const repo = await makeRepo();
		const good = await commitFlag(repo, "PASS\n", "c0 baseline");
		await commitFlag(repo, "PASS\n", "c1 still ok");
		const bug = await commitFlag(repo, "FAIL\n", "c2 introduce bug");
		await commitFlag(repo, "FAIL\n", "c3");
		await commitFlag(repo, "FAIL\n", "c4 head");
		const originalBranch = await gitRun(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);

		const result = await new BisectTool(session(repo)).execute("call", {
			good,
			bad: "HEAD",
			run: "grep -q PASS flag.txt",
			invert: false,
			maxSteps: 40,
			stepTimeoutMs: 60_000,
		});

		expect(result.details?.concluded).toBe(true);
		expect(result.details?.culprit).toBe(bug);
		expect(result.details?.subject).toBe("c2 introduce bug");
		// worktree fully restored
		expect(await gitRun(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(originalBranch);
		expect(await gitRun(repo, ["status", "--porcelain"])).toBe("");
		expect(await Bun.file(path.join(repo, ".git", "BISECT_LOG")).exists()).toBe(false);
	});

	it("finds the fixing commit in invert mode", async () => {
		const repo = await makeRepo();
		const broken = await commitFlag(repo, "FAIL\n", "c0 broken");
		await commitFlag(repo, "FAIL\n", "c1 broken");
		const fix = await commitFlag(repo, "PASS\n", "c2 fix");
		await commitFlag(repo, "PASS\n", "c3 ok");

		const result = await new BisectTool(session(repo)).execute("call", {
			good: broken, // older endpoint (ancestor)
			bad: "HEAD", // newer endpoint
			run: "grep -q PASS flag.txt",
			invert: true,
			maxSteps: 40,
			stepTimeoutMs: 60_000,
		});

		expect(result.details?.concluded).toBe(true);
		expect(result.details?.culprit).toBe(fix);
	});

	it("restores tracked files that the predicate modified", async () => {
		const repo = await makeRepo();
		// sentinel.txt is committed once and never changes across commits, so a
		// local edit to it is carried across every candidate checkout instead of
		// blocking bisect — leaving it dirty at teardown unless the tool cleans up.
		await fs.writeFile(path.join(repo, "sentinel.txt"), "base\n");
		const good = await commitFlag(repo, "PASS\n", "c0 baseline");
		await commitFlag(repo, "PASS\n", "c1 still ok");
		const bug = await commitFlag(repo, "FAIL\n", "c2 introduce bug");
		await commitFlag(repo, "FAIL\n", "c3");
		await commitFlag(repo, "FAIL\n", "c4 head");

		const result = await new BisectTool(session(repo)).execute("call", {
			good,
			bad: "HEAD",
			// Dirties a tracked file, then decides the verdict from flag.txt.
			run: "printf mutated > sentinel.txt; grep -q PASS flag.txt",
			invert: false,
			maxSteps: 40,
			stepTimeoutMs: 60_000,
		});

		expect(result.details?.concluded).toBe(true);
		expect(result.details?.culprit).toBe(bug);
		// `git bisect reset` alone would leave `M sentinel.txt`; teardown must
		// discard the predicate's tracked-file edit and fully restore the worktree.
		expect(await gitRun(repo, ["status", "--porcelain"])).toBe("");
		expect(await Bun.file(path.join(repo, "sentinel.txt")).text()).toBe("base\n");
	});

	it("restores the repo when invoked from a subdirectory a candidate deletes", async () => {
		const repo = await makeRepo();
		// good + HEAD contain sub/, but the intermediate first-bad commit deletes
		// it — so a naive tool running from repo/sub would lose its cwd mid-bisect.
		await fs.mkdir(path.join(repo, "sub"), { recursive: true });
		await fs.writeFile(path.join(repo, "sub", "keep.txt"), "keep\n");
		const good = await commitFlag(repo, "PASS\n", "c0 baseline (sub present)");
		await commitFlag(repo, "PASS\n", "c1 still ok (sub present)");
		await fs.rm(path.join(repo, "sub"), { recursive: true, force: true });
		const bug = await commitFlag(repo, "FAIL\n", "c2 bug (sub deleted)");
		await commitFlag(repo, "FAIL\n", "c3 (sub absent)");
		await fs.mkdir(path.join(repo, "sub"), { recursive: true });
		await fs.writeFile(path.join(repo, "sub", "keep.txt"), "keep\n");
		await commitFlag(repo, "FAIL\n", "c4 head (sub present)");

		const originalHead = await gitRun(repo, ["rev-parse", "HEAD"]);
		const originalBranch = await gitRun(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);

		const result = await new BisectTool(session(path.join(repo, "sub"))).execute("call", {
			good,
			bad: "HEAD",
			run: "grep -q PASS flag.txt",
			invert: false,
			maxSteps: 40,
			stepTimeoutMs: 60_000,
		});

		expect(result.details?.concluded).toBe(true);
		expect(result.details?.culprit).toBe(bug);
		// Everything is restored despite the working cwd vanishing at a candidate.
		expect(await gitRun(repo, ["rev-parse", "HEAD"])).toBe(originalHead);
		expect(await gitRun(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(originalBranch);
		expect(await gitRun(repo, ["status", "--porcelain"])).toBe("");
		expect(await Bun.file(path.join(repo, "sub", "keep.txt")).exists()).toBe(true);
	});

	it("restores from a subdirectory even when the run does not converge (failure path)", async () => {
		const repo = await makeRepo();
		await fs.mkdir(path.join(repo, "sub"), { recursive: true });
		await fs.writeFile(path.join(repo, "sub", "keep.txt"), "keep\n");
		const good = await commitFlag(repo, "PASS\n", "c0 baseline (sub present)");
		await commitFlag(repo, "PASS\n", "c1 (sub present)");
		await fs.rm(path.join(repo, "sub"), { recursive: true, force: true });
		await commitFlag(repo, "FAIL\n", "c2 (sub deleted)");
		await commitFlag(repo, "FAIL\n", "c3 (sub absent)");
		await fs.mkdir(path.join(repo, "sub"), { recursive: true });
		await fs.writeFile(path.join(repo, "sub", "keep.txt"), "keep\n");
		await commitFlag(repo, "FAIL\n", "c4 head (sub present)");

		const originalHead = await gitRun(repo, ["rev-parse", "HEAD"]);
		const originalBranch = await gitRun(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);

		// A predicate that always skips can never converge; the candidate checkouts
		// still delete sub/, so teardown must restore the repo on the failure path.
		const result = await new BisectTool(session(path.join(repo, "sub"))).execute("call", {
			good,
			bad: "HEAD",
			run: "exit 125",
			invert: false,
			maxSteps: 40,
			stepTimeoutMs: 60_000,
		});

		expect(result.details?.concluded).toBe(false);
		expect(await gitRun(repo, ["rev-parse", "HEAD"])).toBe(originalHead);
		expect(await gitRun(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(originalBranch);
		expect(await gitRun(repo, ["status", "--porcelain"])).toBe("");
		expect(await Bun.file(path.join(repo, "sub", "keep.txt")).exists()).toBe(true);
	});

	it("rejects a dirty working tree", async () => {
		const repo = await makeRepo();
		const good = await commitFlag(repo, "ok\n", "c0");
		await commitFlag(repo, "broken\n", "c1");
		await fs.writeFile(path.join(repo, "flag.txt"), "uncommitted\n");

		await expect(
			new BisectTool(session(repo)).execute("call", {
				good,
				bad: "HEAD",
				run: "true",
				invert: false,
				maxSteps: 40,
				stepTimeoutMs: 60_000,
			}),
		).rejects.toThrow(/uncommitted/i);
	});

	it("rejects when good is not an ancestor of bad", async () => {
		const repo = await makeRepo();
		const older = await commitFlag(repo, "ok\n", "c0");
		const newer = await commitFlag(repo, "ok\n", "c1");

		await expect(
			new BisectTool(session(repo)).execute("call", {
				good: newer, // descendant passed as good
				bad: older, // ancestor passed as bad
				run: "true",
				invert: false,
				maxSteps: 40,
				stepTimeoutMs: 60_000,
			}),
		).rejects.toThrow(/ancestor/i);
	});

	it("rejects outside a git repository", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-bisect-nogit-"));
		tempRoots.push(dir);

		await expect(
			new BisectTool(session(dir)).execute("call", {
				good: "HEAD",
				bad: "HEAD",
				run: "true",
				invert: false,
				maxSteps: 40,
				stepTimeoutMs: 60_000,
			}),
		).rejects.toThrow(/git repository/i);
	});
});

describe("BUILTIN_TOOLS registry", () => {
	it("registers bisect as a discoverable tool with a summary", async () => {
		expect(BUILTIN_TOOLS.bisect).toBeDefined();
		const tool = await BUILTIN_TOOLS.bisect(session(process.cwd()));
		expect(tool?.name).toBe("bisect");
		expect(tool?.loadMode).toBe("discoverable");
		expect(tool?.summary).toBeTruthy();
	});
});
