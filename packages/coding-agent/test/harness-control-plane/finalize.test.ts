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

describe("runFinalize (review-only verdict gate)", () => {
	const reviewBase = () => ({
		root,
		sessionId: SID,
		workspace: "/ws",
		branch: "gajae-code-pr-414-review",
		reviewOnly: true as const,
		prTarget: "PR-414",
	});

	it("completes with a terminal verdict and no PR/commit/validation metadata", async () => {
		const res = await runFinalize({
			...reviewBase(),
			verdict: "REQUEST_CHANGES",
			// Stale checks would resolve an unrelated PR/commit; review-only must ignore them.
			checks: checks({
				resolveCommit: async () => "stale999",
				prOrIssue: async () => ({ prUrl: "https://x/pr/59", issueArtifact: null }),
			}),
		});
		expect(res.completed).toBe(true);
		expect(res.verdict).toBe("REQUEST_CHANGES");
		expect(res.blockers).toEqual([]);
		expect(res.prUrl).toBeNull();
		expect(res.issueArtifact).toBeNull();
		expect(res.commitHash).toBeNull();
		expect(res.validation).toEqual([]);
		const verdicts = await readReceiptIndex(root, SID, "review-verdict");
		expect(verdicts).toHaveLength(1);
		expect(verdicts[0].valid).toBe(true);
		expect(await readReceiptIndex(root, SID, "completion")).toHaveLength(0);
	});

	it("writes a durable bounded failure receipt when no verdict is supplied", async () => {
		const res = await runFinalize({ ...reviewBase(), verdict: null, checks: checks() });
		expect(res.completed).toBe(false);
		expect(res.verdict).toBeNull();
		expect(res.blockers).toEqual(["review-verdict-missing"]);
		expect(res.prUrl).toBeNull();
		const failures = await readReceiptIndex(root, SID, "review-failure");
		expect(failures).toHaveLength(1);
		expect(failures[0].valid).toBe(true);
	});

	it("blocks on a verdict outside the closed vocabulary", async () => {
		const res = await runFinalize({ ...reviewBase(), verdict: "LGTM", checks: checks() });
		expect(res.completed).toBe(false);
		expect(res.blockers).toEqual(["review-verdict-invalid"]);
		expect(await readReceiptIndex(root, SID, "review-failure")).toHaveLength(1);
	});

	it("records OWNER_CONFIRMATION_REQUIRED as a non-success human-action-required state", async () => {
		const res = await runFinalize({ ...reviewBase(), verdict: "OWNER_CONFIRMATION_REQUIRED", checks: checks() });
		expect(res.completed).toBe(false);
		expect(res.verdict).toBe("OWNER_CONFIRMATION_REQUIRED");
		expect(res.blockers).toEqual(["owner-confirmation-required"]);
		// The verdict is still durably recorded even though it is not an autonomous success.
		const verdicts = await readReceiptIndex(root, SID, "review-verdict");
		expect(verdicts).toHaveLength(1);
		expect(verdicts[0].valid).toBe(true);
	});

	it("never blocks review on validation-required-but-none-run", async () => {
		const res = await runFinalize({
			...reviewBase(),
			verdict: "APPROVE_MERGE_READY",
			validationCommands: [],
			checks: checks(),
		});
		expect(res.completed).toBe(true);
		expect(res.blockers).not.toContain("validation-required-but-none-run");
	});
});
