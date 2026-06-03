import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type FinalizeChecks, runFinalize, type ValidationCommandSpec } from "../../src/harness-control-plane/finalize";
import { readReceiptIndex } from "../../src/harness-control-plane/storage";

let root: string;
const SID = "f";

function checks(over: Partial<FinalizeChecks> = {}): FinalizeChecks {
	return {
		runValidation:
			over.runValidation ??
			(async (spec: ValidationCommandSpec) => ({
				exactCommand: spec.command,
				cwd: "/ws",
				exitStatus: 0,
				pass: true,
			})),
		resolveCommit: over.resolveCommit ?? (async () => "abc123"),
		commitOnBranch: over.commitOnBranch ?? (async () => true),
		prOrIssue: over.prOrIssue ?? (async () => ({ prUrl: "https://x/pr/1", issueArtifact: null })),
	};
}

const base = () => ({
	root,
	sessionId: SID,
	workspace: "/ws",
	branch: "feat/x",
	requireTests: true,
	requireCommit: true,
	requirePr: true,
	validationCommands: [
		{ name: "typecheck", command: "bun run check:types" },
		{ name: "test", command: "bun test" },
	],
});

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "h"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("runFinalize (evidence gate)", () => {
	it("completes only with passing validation + commit-on-branch + PR + valid completion receipt", async () => {
		const res = await runFinalize({ ...base(), checks: checks() });
		expect(res.completed).toBe(true);
		expect(res.blockers).toEqual([]);
		expect(res.receiptPath).toBeTruthy();
		expect(res.commitHash).toBe("abc123");
		expect(res.validation.every(v => v.valid)).toBe(true);
		const completions = await readReceiptIndex(root, SID, "completion");
		expect(completions).toHaveLength(1);
		expect(completions[0].valid).toBe(true);
	});

	it("blocks on a failing required validation (no completion receipt)", async () => {
		const res = await runFinalize({
			...base(),
			checks: checks({
				runValidation: async spec => ({ exactCommand: spec.command, cwd: "/ws", exitStatus: 1, pass: false }),
			}),
		});
		expect(res.completed).toBe(false);
		expect(res.blockers.some(b => b.startsWith("validation-failed:"))).toBe(true);
		expect(res.receiptPath).toBeNull();
		expect(await readReceiptIndex(root, SID, "completion")).toHaveLength(0);
	});

	it("blocks when no PR/issue artifact exists", async () => {
		const res = await runFinalize({
			...base(),
			checks: checks({ prOrIssue: async () => ({ prUrl: null, issueArtifact: null }) }),
		});
		expect(res.completed).toBe(false);
		expect(res.blockers).toContain("missing-pr-or-issue");
	});

	it("blocks when the commit is not on the branch", async () => {
		const res = await runFinalize({ ...base(), checks: checks({ commitOnBranch: async () => false }) });
		expect(res.completed).toBe(false);
		expect(res.blockers).toContain("commit-not-on-branch");
	});

	it("blocks when tests are required but none were run", async () => {
		const res = await runFinalize({ ...base(), validationCommands: [], checks: checks() });
		expect(res.completed).toBe(false);
		expect(res.blockers).toContain("validation-required-but-none-run");
	});

	it("an issue artifact satisfies the PR/issue gate", async () => {
		const res = await runFinalize({
			...base(),
			checks: checks({ prOrIssue: async () => ({ prUrl: null, issueArtifact: "issue#42-resolved" }) }),
		});
		expect(res.completed).toBe(true);
		expect(res.issueArtifact).toBe("issue#42-resolved");
	});
});
