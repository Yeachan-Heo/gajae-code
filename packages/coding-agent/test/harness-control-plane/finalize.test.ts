import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	defaultFinalizeChecks,
	type FinalizeChecks,
	runFinalize,
	type ValidationCommandSpec,
	ValidationObservationUncertainError,
} from "../../src/harness-control-plane/finalize";
import type { ReviewFailureEvidence, ReviewVerdictEvidence } from "../../src/harness-control-plane/receipts";
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
	it("blocks uncertain validation observation without receipts even when tests are optional", async () => {
		let commitChecked = false;
		let prChecked = false;
		const res = await runFinalize({
			...base(),
			requireTests: false,
			checks: checks({
				runValidation: async spec => {
					throw new ValidationObservationUncertainError(spec.command, "/ws");
				},
				commitOnBranch: async () => {
					commitChecked = true;
					return true;
				},
				prOrIssue: async () => {
					prChecked = true;
					return { prUrl: "https://x/pr/1", issueArtifact: null };
				},
			}),
		});
		expect(res.completed).toBe(false);
		expect(res.blockers).toEqual(["validation-unknown:typecheck"]);
		expect(res.receiptPath).toBeNull();
		expect(res.validation).toEqual([]);
		expect(commitChecked).toBe(false);
		expect(prChecked).toBe(false);
		expect(await readReceiptIndex(root, SID, "validation")).toHaveLength(0);
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

describe("runFinalize (review-only verdict from assistant text)", () => {
	const reviewBase = () => ({
		root,
		sessionId: SID,
		workspace: "/ws",
		branch: "gajae-code-pr-414-review",
		reviewOnly: true as const,
		prTarget: "PR-414",
	});

	async function readEvidence<E>(family: "review-verdict" | "review-failure"): Promise<E> {
		const idx = await readReceiptIndex(root, SID, family);
		expect(idx).toHaveLength(1);
		const env = JSON.parse(await readFile(idx[0].path, "utf8")) as { evidence: E };
		return env.evidence;
	}

	it("extracts a verdict from final assistant text when no explicit verdict is supplied", async () => {
		const res = await runFinalize({
			...reviewBase(),
			verdict: null,
			assistantText: "Reviewed the diff. Found blocking issues.\nVerdict: REQUEST_CHANGES",
			checks: checks(),
		});
		expect(res.completed).toBe(true);
		expect(res.verdict).toBe("REQUEST_CHANGES");
		expect(res.blockers).toEqual([]);
		const evidence = await readEvidence<ReviewVerdictEvidence>("review-verdict");
		expect(evidence.verdict).toBe("REQUEST_CHANGES");
		expect(evidence.verdictSource).toBe("assistant");
		expect(typeof evidence.assistantDigest).toBe("string");
		expect((evidence.assistantDigest as string).length).toBe(64);
	});

	it("aliases MERGE_READY to APPROVE_MERGE_READY", async () => {
		const res = await runFinalize({
			...reviewBase(),
			verdict: null,
			assistantText: "Looks good to me. MERGE_READY",
			checks: checks(),
		});
		expect(res.verdict).toBe("APPROVE_MERGE_READY");
		expect(res.completed).toBe(true);
	});

	it("uses the final (last) verdict when the assistant text mentions several", async () => {
		const res = await runFinalize({
			...reviewBase(),
			verdict: null,
			assistantText: "Initially I leaned APPROVE_MERGE_READY but on reflection: REQUEST_CHANGES",
			checks: checks(),
		});
		expect(res.verdict).toBe("REQUEST_CHANGES");
	});

	it("fails deterministically with bounded/digest evidence when assistant text lacks a verdict", async () => {
		const res = await runFinalize({
			...reviewBase(),
			verdict: null,
			assistantText: "I looked at the change but I am not sure what to recommend yet.",
			checks: checks(),
		});
		expect(res.completed).toBe(false);
		expect(res.verdict).toBeNull();
		expect(res.blockers).toEqual(["review-verdict-missing"]);
		const evidence = await readEvidence<ReviewFailureEvidence>("review-failure");
		expect(evidence.reason).toBe("review-verdict-missing");
		expect(typeof evidence.assistantDigest).toBe("string");
		expect((evidence.assistantDigest as string).length).toBe(64);
		expect(evidence.assistantSummary).toContain("not sure what to recommend");
	});

	it("bounds an oversized assistant summary in the failure receipt", async () => {
		const res = await runFinalize({
			...reviewBase(),
			verdict: null,
			assistantText: "x".repeat(5000),
			checks: checks(),
		});
		expect(res.completed).toBe(false);
		const evidence = await readEvidence<ReviewFailureEvidence>("review-failure");
		expect((evidence.assistantSummary as string).length).toBeLessThanOrEqual(281);
	});

	it("explicit input.verdict wins over assistant extraction", async () => {
		const res = await runFinalize({
			...reviewBase(),
			verdict: "APPROVE_MERGE_READY",
			assistantText: "Verdict: REQUEST_CHANGES",
			checks: checks(),
		});
		expect(res.completed).toBe(true);
		expect(res.verdict).toBe("APPROVE_MERGE_READY");
		const evidence = await readEvidence<ReviewVerdictEvidence>("review-verdict");
		expect(evidence.verdictSource).toBe("input");
		expect(evidence.assistantDigest ?? null).toBeNull();
	});

	it("treats a non-null invalid explicit verdict as invalid (no extraction fallback)", async () => {
		const res = await runFinalize({
			...reviewBase(),
			verdict: "LGTM",
			assistantText: "Verdict: REQUEST_CHANGES",
			checks: checks(),
		});
		expect(res.completed).toBe(false);
		expect(res.blockers).toEqual(["review-verdict-invalid"]);
		expect(res.verdict).toBeNull();
	});
});
describe("defaultFinalizeChecks.runValidation (async runner)", () => {
	it("passes an approved command that exits 0 and fails a nonzero exit", async () => {
		const checks = defaultFinalizeChecks(root);
		const pass = await checks.runValidation({ name: "ok", command: "true" });
		expect(pass).toEqual({ exactCommand: "true", cwd: root, exitStatus: 0, pass: true });
		expect(pass).not.toHaveProperty("pid");
		expect(pass).not.toHaveProperty("receiptId");
		const fail = await checks.runValidation({ name: "fail", command: "exit 7" });
		expect(fail).toEqual({ exactCommand: "exit 7", cwd: root, exitStatus: 7, pass: false });
	});

	it("treats spawn errors as failed observations without inventing process authority", async () => {
		const checks = defaultFinalizeChecks(path.join(root, "missing-workspace"));
		const run = await checks.runValidation({ name: "missing", command: "true" });
		expect(run.exactCommand).toBe("true");
		expect(run.cwd).toBe(path.join(root, "missing-workspace"));
		expect(run.pass).toBe(false);
		expect(run.exitStatus).not.toBe(0);
		expect(Object.keys(run).sort()).toEqual(["cwd", "exactCommand", "exitStatus", "pass"]);
	});
	it("throws when a post-spawn stream fails while exit is still pending", async () => {
		let killed = false;
		let exitSettled = false;
		let releaseExit: ((code: number) => void) | undefined;
		const exited = new Promise<number>(resolve => {
			releaseExit = (code: number) => {
				exitSettled = true;
				resolve(code);
			};
		});
		const failingStdout = new ReadableStream<Uint8Array>({
			start(controller) {
				queueMicrotask(() => controller.error(new Error("stdout closed after spawn")));
			},
		});
		const emptyStderr = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});
		const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
			stdout: failingStdout,
			stderr: emptyStderr,
			exited,
			kill() {
				killed = true;
				releaseExit?.(143);
			},
			get exitCode() {
				return exitSettled ? 143 : null;
			},
		} as Bun.Subprocess<"ignore", "pipe", "pipe">);
		try {
			const checks = defaultFinalizeChecks(root);
			await expect(checks.runValidation({ name: "stream-fail", command: "sleep 30" })).rejects.toMatchObject({
				name: "ValidationObservationUncertainError",
				exactCommand: "sleep 30",
				cwd: root,
			});
			expect(killed).toBe(true);
			expect(exitSettled).toBe(true);
			await expect(exited).resolves.toBe(143);
		} finally {
			spawnSpy.mockRestore();
		}
	});

	it("drains large stdout/stderr without blocking a concurrent timer", async () => {
		const checks = defaultFinalizeChecks(root);
		let ticks = 0;
		const timer = setInterval(() => {
			ticks += 1;
		}, 20);
		try {
			const run = await checks.runValidation({
				name: "drain",
				command: "python3 -c \"import sys; sys.stdout.write('o'*200000); sys.stderr.write('e'*200000)\"; sleep 0.1",
			});
			expect(run.exactCommand).toContain("python3");
			expect(run.cwd).toBe(root);
			expect(run.pass).toBe(true);
			expect(run.exitStatus).toBe(0);
			expect(ticks).toBeGreaterThan(0);
		} finally {
			clearInterval(timer);
		}
	});

	it("terminates a validator's child process group when its owner cancels it", async () => {
		const checks = defaultFinalizeChecks(root);
		const pidFile = path.join(root, "validation-child.pid");
		const controller = new AbortController();
		const run = checks.runValidation(
			{ name: "cancel-tree", command: `sleep 30 & echo $! > '${pidFile}'; wait` },
			controller.signal,
		);
		let childPid: number | undefined;
		for (let attempt = 0; attempt < 100 && childPid === undefined; attempt++) {
			try {
				const parsed = Number((await readFile(pidFile, "utf8")).trim());
				if (Number.isSafeInteger(parsed) && parsed > 0) childPid = parsed;
			} catch {}
			if (childPid === undefined) await Bun.sleep(10);
		}
		expect(childPid).toBeDefined();
		controller.abort(new Error("owner stopped"));
		await expect(run).rejects.toBeInstanceOf(ValidationObservationUncertainError);

		const childAlive = (): boolean => {
			if (process.platform === "linux") {
				try {
					const stat = readFileSync(`/proc/${childPid}/stat`, "utf8");
					const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
					return state !== "Z" && state !== "X";
				} catch (error) {
					return (error as NodeJS.ErrnoException).code !== "ENOENT";
				}
			}
			try {
				process.kill(childPid as number, 0);
				return true;
			} catch (error) {
				return (error as NodeJS.ErrnoException).code !== "ESRCH";
			}
		};
		for (let attempt = 0; attempt < 100 && childAlive(); attempt++) await Bun.sleep(10);
		expect(childAlive()).toBe(false);
	});

	it("does not report validator group cleanup while Linux process identity is unverified", async () => {
		if (process.platform !== "linux") return;
		const checks = defaultFinalizeChecks(root, () => ({ kind: "unverifiable", reason: "permission_denied" }));
		const pidFile = path.join(root, "unverified-validation-child.pid");
		const controller = new AbortController();
		let childPid: number | undefined;
		const run = checks.runValidation(
			{ name: "unverified-cancel", command: `sleep 0.5 & echo $! > '${pidFile}'; wait` },
			controller.signal,
		);
		let settled = false;
		void run.catch(() => {
			settled = true;
		});
		try {
			for (let attempt = 0; attempt < 100 && childPid === undefined; attempt++) {
				try {
					const parsed = Number((await readFile(pidFile, "utf8")).trim());
					if (Number.isSafeInteger(parsed) && parsed > 0) childPid = parsed;
				} catch {}
				if (childPid === undefined) await Bun.sleep(10);
			}
			expect(childPid).toBeDefined();
			controller.abort(new Error("owner stopped"));
			await Bun.sleep(100);
			expect(settled).toBe(false);
			if (childPid === undefined) throw new Error("validator child did not start");
			const childStat = await readFile(`/proc/${childPid}/stat`, "utf8");
			const state = childStat.slice(childStat.lastIndexOf(")") + 2).split(" ")[0];
			expect(state).not.toBe("Z");
			expect(state).not.toBe("X");
			await expect(run).rejects.toBeInstanceOf(ValidationObservationUncertainError);
			expect(settled).toBe(true);
			await expect(readFile(`/proc/${childPid}/stat`, "utf8")).rejects.toThrow();
		} finally {
			controller.abort(new Error("test cleanup"));
			if (childPid !== undefined) {
				try {
					process.kill(childPid, "SIGKILL");
				} catch {}
			}
			await run.catch(() => undefined);
		}
	});
});
