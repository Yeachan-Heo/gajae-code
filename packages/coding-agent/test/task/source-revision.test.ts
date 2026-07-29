import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildTaskReceipt } from "../../src/task/receipt";
import {
	captureTaskSourceRevision,
	classifyTaskSourceFreshness,
	EMPTY_WORKTREE_DIFF_SHA256,
	isReviewCapableAgent,
	resolveSourceFreshnessFields,
	STALE_SOURCE_GUIDANCE,
	sourceRevisionsEqual,
	type TaskSourceRevision,
} from "../../src/task/source-revision";
import type { SingleResult } from "../../src/task/types";

const tempDirs: string[] = [];

async function runGit(repo: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: repo,
		stderr: "pipe",
		stdout: "pipe",
		windowsHide: true,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed with exit code ${exitCode ?? 0}`);
	}
	return stdout.trim();
}

async function createGitRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-source-revision-"));
	tempDirs.push(repo);
	await runGit(repo, ["init"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await fs.writeFile(path.join(repo, "tracked.txt"), "base content\n");
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["commit", "-m", "initial"]);
	return repo;
}

function makeRaw(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "0-Review",
		agent: "architect",
		agentSource: "bundled",
		task: "review",
		assignment: "review the tree",
		description: "review",
		exitCode: 0,
		output: "findings",
		stderr: "",
		truncated: false,
		durationMs: 10,
		tokens: 20,
		...overrides,
	};
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("isReviewCapableAgent", () => {
	it("includes bundled review roles and review/qa names", () => {
		expect(isReviewCapableAgent("architect")).toBe(true);
		expect(isReviewCapableAgent("critic")).toBe(true);
		expect(isReviewCapableAgent("planner")).toBe(true);
		expect(isReviewCapableAgent("code-reviewer")).toBe(true);
		expect(isReviewCapableAgent("QA")).toBe(true);
		expect(isReviewCapableAgent("ultragoal-qa")).toBe(true);
	});

	it("excludes ordinary executor implementation agents", () => {
		expect(isReviewCapableAgent("executor")).toBe(false);
		expect(isReviewCapableAgent("implementer")).toBe(false);
	});
});

describe("captureTaskSourceRevision / classifyTaskSourceFreshness", () => {
	it("capture → equal after no changes → current", async () => {
		const repo = await createGitRepo();
		const first = await captureTaskSourceRevision(repo);
		expect(first.head).toMatch(/^[0-9a-f]{40}$/);
		expect(first.worktreeDiffSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(first.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

		const second = await captureTaskSourceRevision(repo);
		expect(sourceRevisionsEqual(first, second)).toBe(true);
		expect(await classifyTaskSourceFreshness(repo, first)).toBe("current");
	});

	it("capture → edit a tracked file → classify stale", async () => {
		const repo = await createGitRepo();
		const reviewed = await captureTaskSourceRevision(repo);
		await fs.writeFile(path.join(repo, "tracked.txt"), "edited content\n");
		expect(await classifyTaskSourceFreshness(repo, reviewed)).toBe("stale");

		const after = await captureTaskSourceRevision(repo);
		expect(sourceRevisionsEqual(reviewed, after)).toBe(false);
		expect(after.worktreeDiffSha256).not.toBe(reviewed.worktreeDiffSha256);
	});

	it("detects HEAD advancement without dirty worktree as stale", async () => {
		const repo = await createGitRepo();
		const reviewed = await captureTaskSourceRevision(repo);
		await fs.writeFile(path.join(repo, "tracked.txt"), "committed edit\n");
		await runGit(repo, ["add", "."]);
		await runGit(repo, ["commit", "-m", "advance head"]);
		expect(await classifyTaskSourceFreshness(repo, reviewed)).toBe("stale");
		const after = await captureTaskSourceRevision(repo);
		expect(after.head).not.toBe(reviewed.head);
	});

	it("non-git cwd uses null head and fixed empty hash", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-source-revision-nongit-"));
		tempDirs.push(dir);
		const revision = await captureTaskSourceRevision(dir);
		expect(revision.head).toBeNull();
		expect(revision.worktreeDiffSha256).toBe(EMPTY_WORKTREE_DIFF_SHA256);
		expect(await classifyTaskSourceFreshness(dir, revision)).toBe("current");
	});
});

describe("review receipt source fencing", () => {
	it("non-review agent receipts omit sourceRevision", () => {
		const receipt = buildTaskReceipt(makeRaw({ agent: "executor" }));
		expect(receipt.sourceRevision).toBeUndefined();
		expect(receipt.sourceStatus).toBeUndefined();
		expect(receipt.sourceGuidance).toBeUndefined();
		expect(receipt.preview).not.toContain("STALE");
	});

	it("review agent receipt includes sourceRevision; late classify is stale after edit", async () => {
		const repo = await createGitRepo();
		const reviewed = await captureTaskSourceRevision(repo);
		await fs.writeFile(path.join(repo, "tracked.txt"), "parent advanced\n");

		const fields = await resolveSourceFreshnessFields(repo, reviewed);
		expect(fields.sourceStatus).toBe("stale");
		expect(fields.sourceGuidance).toBe(STALE_SOURCE_GUIDANCE);
		expect(fields.sourceRevision).toEqual(reviewed);

		const receipt = buildTaskReceipt(
			makeRaw({
				agent: "architect",
				sourceRevision: fields.sourceRevision,
				sourceStatus: fields.sourceStatus,
				sourceGuidance: fields.sourceGuidance,
			}),
		);
		expect(receipt.sourceRevision).toEqual(reviewed);
		expect(receipt.sourceStatus).toBe("stale");
		expect(receipt.sourceGuidance).toBe(STALE_SOURCE_GUIDANCE);
		expect(receipt.preview.startsWith("STALE source;")).toBe(true);
	});

	it("resolveSourceFreshnessFields returns empty when no reviewed snapshot", async () => {
		const repo = await createGitRepo();
		expect(await resolveSourceFreshnessFields(repo, undefined)).toEqual({});
	});

	it("current review receipt keeps sourceRevision without STALE prefix", async () => {
		const repo = await createGitRepo();
		const reviewed: TaskSourceRevision = await captureTaskSourceRevision(repo);
		const fields = await resolveSourceFreshnessFields(repo, reviewed);
		expect(fields.sourceStatus).toBe("current");
		expect(fields.sourceGuidance).toBeUndefined();

		const receipt = buildTaskReceipt(
			makeRaw({
				sourceRevision: fields.sourceRevision,
				sourceStatus: fields.sourceStatus,
			}),
		);
		expect(receipt.sourceStatus).toBe("current");
		expect(receipt.preview).not.toContain("STALE");
	});
});
