import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertVirtualIntegrationInputs,
	buildVirtualIntegrationEvidence,
	canonicalVirtualIntegrationEvidence,
	canonicalVirtualIntegrationEvidence as canonical,
	createVirtualMergeWorktree,
	materializeVirtualMerge,
	removeVirtualMergeWorktree,
	parseCanonicalVirtualIntegrationEvidence,
	runCanaries,
	selectAuthorityBase,
	type GreenDevRun,
	type VirtualIntegrationInputs,
} from "./ci-virtual-integration";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const MERGE_TREE_SHA = "c".repeat(40);

function validInputs(overrides: Partial<VirtualIntegrationInputs> = {}): VirtualIntegrationInputs {
	return {
		headSha: HEAD_SHA,
		baseSha: BASE_SHA,
		baseRunId: "12345",
		baseConclusion: "success",
		checkedOutHead: HEAD_SHA,
		baseReachable: true,
		...overrides,
	};
}

describe("virtual integration inputs", () => {
	test("rejects a stale head", () => {
		expect(() => assertVirtualIntegrationInputs(validInputs({ checkedOutHead: "d".repeat(40) }))).toThrow(/stale head/);
	});

	test("rejects a stale base", () => {
		expect(() => assertVirtualIntegrationInputs(validInputs({ baseReachable: false }))).toThrow(/stale base/);
	});

	test.each(["failure", "cancelled", ""])("rejects a non-green base run: %s", baseConclusion => {
		expect(() => assertVirtualIntegrationInputs(validInputs({ baseConclusion }))).toThrow(/base run not terminal-green/);
	});

	test("rejects a disagreeing base override and accepts a matching override", () => {
		expect(() => assertVirtualIntegrationInputs(validInputs({ baseShaOverride: HEAD_SHA }))).toThrow(/base override mismatch/);
		expect(() => assertVirtualIntegrationInputs(validInputs({ baseShaOverride: BASE_SHA }))).not.toThrow();
	});

	test("rejects malformed head SHAs", () => {
		for (const headSha of ["a".repeat(39), "g".repeat(40), ""]) {
			expect(() => assertVirtualIntegrationInputs(validInputs({ headSha, checkedOutHead: headSha }))).toThrow(/malformed head SHA/);
		}
	});

	test("rejects malformed base SHAs", () => {
		for (const baseSha of ["b".repeat(39), "g".repeat(40), ""]) {
			expect(() => assertVirtualIntegrationInputs(validInputs({ baseSha }))).toThrow(/malformed base SHA/);
		}
	});

	test("accepts a fully valid input set", () => {
		expect(() => assertVirtualIntegrationInputs(validInputs())).not.toThrow();
	});
});

describe("virtual integration evidence", () => {
	test("keeps virtual merge identity stable in canonical bytes", () => {
		const inputs = validInputs();
		const first = canonicalVirtualIntegrationEvidence(buildVirtualIntegrationEvidence(inputs, MERGE_TREE_SHA, ["test:one"]));
		const second = canonicalVirtualIntegrationEvidence(buildVirtualIntegrationEvidence(inputs, MERGE_TREE_SHA, ["test:one"]));
		const differentMerge = canonicalVirtualIntegrationEvidence(buildVirtualIntegrationEvidence(inputs, "d".repeat(40), ["test:one"]));
		expect(first).toBe(second);
		expect(first).not.toBe(differentMerge);
	});

	test("round-trips canonical evidence and rejects reordered or extra fields", () => {
		const evidence = buildVirtualIntegrationEvidence(validInputs(), MERGE_TREE_SHA, ["test:one", "test:two"]);
		const canonical = canonicalVirtualIntegrationEvidence(evidence);
		expect(canonical.endsWith("\n")).toBe(true);
		expect(parseCanonicalVirtualIntegrationEvidence(canonical)).toEqual(evidence);

		const reordered = `${JSON.stringify({
			subject: evidence.subject,
			schemaVersion: evidence.schemaVersion,
			headSha: evidence.headSha,
			baseSha: evidence.baseSha,
			baseRunId: evidence.baseRunId,
			mergeTreeSha: evidence.mergeTreeSha,
			canaryTasks: evidence.canaryTasks,
		})}\n`;
		expect(() => parseCanonicalVirtualIntegrationEvidence(reordered)).toThrow(/non-canonical evidence bytes/);

		const extra = `${JSON.stringify({ ...evidence, extra: true })}\n`;
		expect(() => parseCanonicalVirtualIntegrationEvidence(extra)).toThrow(/malformed evidence/);
	});
});

describe("authority base selection", () => {
	const GREEN_A = "a".repeat(40);
	const GREEN_B = "b".repeat(40);
	const GREEN_UNREACHABLE = "e".repeat(40);

	function greenRun(headSha: string, databaseId: number): GreenDevRun {
		return { headSha, databaseId, conclusion: "success" };
	}

	test("selects the newest reachable terminal-green dev push", () => {
		// newest-first: GREEN_A is newer and reachable
		const runs = [greenRun(GREEN_A, 100), greenRun(GREEN_B, 99)];
		const ancestors = new Set([GREEN_A, GREEN_B]);
		const selected = selectAuthorityBase(runs, ancestors);
		expect(selected.baseSha).toBe(GREEN_A);
		expect(selected.baseRunId).toBe("100");
		expect(selected.baseConclusion).toBe("success");
	});

	test("skips a newer green run that is not an ancestor of the head", () => {
		// GREEN_A is newer but NOT reachable; GREEN_B is the next reachable one
		const runs = [greenRun(GREEN_UNREACHABLE, 100), greenRun(GREEN_B, 99)];
		const ancestors = new Set([GREEN_B]);
		const selected = selectAuthorityBase(runs, ancestors);
		expect(selected.baseSha).toBe(GREEN_B);
	});

	test("fails closed when no green run is a reachable ancestor", () => {
		const runs = [greenRun(GREEN_UNREACHABLE, 100)];
		const ancestors = new Set([GREEN_A]);
		expect(() => selectAuthorityBase(runs, ancestors)).toThrow(/no reachable terminal-green/);
	});

	test("fails closed when the green run list is empty", () => {
		expect(() => selectAuthorityBase([], new Set([GREEN_A]))).toThrow(/no reachable terminal-green/);
	});

	test("rejects a red current event base in favor of a reachable green one", () => {
		// Simulates the PR #4071 scenario: the event base d62b7a4 had a failed
		// Dev CI run, but an older reachable green push exists. The selector
		// must pick the green push, not fail on the red event base.
		const runs = [greenRun(GREEN_A, 200), greenRun(GREEN_B, 100)];
		const ancestors = new Set([GREEN_A, GREEN_B]);
		const selected = selectAuthorityBase(runs, ancestors);
		expect(selected.baseSha).toBe(GREEN_A);
		expect(selected.baseConclusion).toBe("success");
	});

	test("ignores non-success conclusions even when reachable", () => {
		const failedRun: GreenDevRun = { headSha: GREEN_A, databaseId: 50, conclusion: "failure" };
		const goodRun = greenRun(GREEN_B, 49);
		const ancestors = new Set([GREEN_A, GREEN_B]);
		const selected = selectAuthorityBase([failedRun, goodRun], ancestors);
		expect(selected.baseSha).toBe(GREEN_B);
	});

	test("ignores malformed SHAs and non-integer run ids in the green list", () => {
		const malformed: GreenDevRun = { headSha: "short", databaseId: 200, conclusion: "success" };
		const valid = greenRun(GREEN_B, 49);
		const ancestors = new Set([GREEN_B]);
		const selected = selectAuthorityBase([malformed, valid], ancestors);
		expect(selected.baseSha).toBe(GREEN_B);
	});
});

// Real git-fixture coverage for the orchestration itself. The unit tests above
// only exercise serialization; these prove the merge is actually materialized
// and that tampered evidence cannot smuggle an empty canary set past the gate.
describe("virtual integration orchestration (git fixtures)", () => {
	const roots: string[] = [];

	afterEach(async () => {
		for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
	});

	async function git(cwd: string, args: readonly string[]): Promise<string> {
		const result = await $`git -c user.email=ci@example.com -c user.name=CI ${args}`.cwd(cwd).quiet().nothrow();
		if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
		return result.stdout.toString().trim();
	}

	async function fixture(): Promise<{ dir: string; baseSha: string; headSha: string; mergeTreeSha: string }> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vi-fixture-"));
		roots.push(dir);
		await git(dir, ["init", "-q", "-b", "main"]);
		await fs.writeFile(path.join(dir, "seed.txt"), "seed\n");
		await git(dir, ["add", "-A"]);
		await git(dir, ["commit", "-qm", "base"]);
		const baseSha = await git(dir, ["rev-parse", "HEAD"]);
		// A session/SDK lifecycle path so the manifest selects a real canary.
		const changed = "packages/coding-agent/src/session/session-manager.ts";
		await fs.mkdir(path.dirname(path.join(dir, changed)), { recursive: true });
		await fs.writeFile(path.join(dir, changed), "export const x = 1;\n");
		await git(dir, ["add", "-A"]);
		await git(dir, ["commit", "-qm", "head"]);
		const headSha = await git(dir, ["rev-parse", "HEAD"]);
		const scratch = path.join(dir, ".probe-merge");
		const mergeTreeSha = await createVirtualMergeWorktree(baseSha, headSha, scratch, dir);
		await removeVirtualMergeWorktree(scratch, dir);
		return { dir, baseSha, headSha, mergeTreeSha };
	}

	function evidenceFor(f: { baseSha: string; headSha: string; mergeTreeSha: string }, canaryTasks: readonly string[]) {
		return canonical({
			schemaVersion: 1,
			subject: "ci-virtual-integration",
			headSha: f.headSha,
			baseSha: f.baseSha,
			baseRunId: "424242",
			mergeTreeSha: f.mergeTreeSha,
			canaryTasks: [...canaryTasks],
		});
	}

	test("materializes a worktree whose tree id equals the recorded merge identity", async () => {
		const f = await fixture();
		const target = path.join(f.dir, "merged-ok");
		await materializeVirtualMerge(f.mergeTreeSha, target, { baseSha: f.baseSha, headSha: f.headSha, repoDir: f.dir });
		const tree = await git(target, ["rev-parse", "HEAD^{tree}"]);
		expect(tree).toBe(f.mergeTreeSha);
	});

	test("rejects a merge identity that does not match the materialized tree", async () => {
		const f = await fixture();
		const bogus = "0".repeat(40);
		await expect(
			materializeVirtualMerge(bogus, path.join(f.dir, "merged-bad"), {
				baseSha: f.baseSha,
				headSha: f.headSha,
				repoDir: f.dir,
			}),
		).rejects.toThrow(/merge materialization/);
	});

	test("fails closed when evidence claims an empty canary set", async () => {
		const f = await fixture();
		await fs.writeFile(path.join(f.dir, ".ci-virtual-integration.json"), evidenceFor(f, []));
		await expect(runCanaries({ repoDir: f.dir, runner: async () => 0 })).rejects.toThrow(/canary task set mismatch/);
	});

	test("fails closed when evidence binds a different head", async () => {
		const f = await fixture();
		const wrongHead = { ...f, headSha: f.baseSha };
		await fs.writeFile(path.join(f.dir, ".ci-virtual-integration.json"), evidenceFor(wrongHead, []));
		await expect(runCanaries({ repoDir: f.dir, runner: async () => 0 })).rejects.toThrow(/evidence binding mismatch/);
	});

	test("runs the re-derived canary set inside the merged worktree", async () => {
		const f = await fixture();
		const expected = ["packages/coding-agent/test/notifications-live-stream.test.ts", "packages/coding-agent/test/session-manager-resident-cache.test.ts"];
		await fs.writeFile(path.join(f.dir, ".ci-virtual-integration.json"), evidenceFor(f, expected));
		const seen: Array<{ testPath: string; cwd: string }> = [];
		await runCanaries({
			repoDir: f.dir,
			prepare: async cwd => {
				expect(cwd).not.toBe(f.dir);
			},

			runner: async (testPath, cwd) => {
				seen.push({ testPath, cwd });
				return 0;
			},
		});
		expect(seen.map(entry => entry.testPath)).toEqual(expected);
		// Every canary must run against the materialized merge, not the PR head.
		for (const entry of seen) expect(entry.cwd).not.toBe(f.dir);
	});

	test("propagates a failing canary as a non-zero failure", async () => {
		const f = await fixture();
		const expected = ["packages/coding-agent/test/notifications-live-stream.test.ts", "packages/coding-agent/test/session-manager-resident-cache.test.ts"];
		await fs.writeFile(path.join(f.dir, ".ci-virtual-integration.json"), evidenceFor(f, expected));
		await expect(runCanaries({ repoDir: f.dir, prepare: async () => {}, runner: async () => 1 })).rejects.toThrow(/canary failed/);
	});
});
