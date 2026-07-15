import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { validateUltragoalCompletionSourceSnapshotFresh } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-guard";
import {
	classifyUltragoalTimeoutCause,
	createUltragoalPlan,
	readUltragoalLedger,
	readUltragoalPlan,
	recordUltragoalTimeout,
	startNextUltragoalGoal,
	type UltragoalCompletionVerification,
	type UltragoalGoal,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";

const TEST_SESSION_ID = "timeout-guard-test-session";
const tempRoots: string[] = [];
let savedSessionId: string | undefined;
let savedSessionFile: string | undefined;

beforeEach(() => {
	savedSessionId = process.env.GJC_SESSION_ID;
	savedSessionFile = process.env.GJC_SESSION_FILE;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
	delete process.env.GJC_SESSION_FILE;
});

afterEach(async () => {
	if (savedSessionId === undefined) delete process.env.GJC_SESSION_ID;
	else process.env.GJC_SESSION_ID = savedSessionId;
	if (savedSessionFile === undefined) delete process.env.GJC_SESSION_FILE;
	else process.env.GJC_SESSION_FILE = savedSessionFile;
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-ultragoal-timeout-"));
	tempRoots.push(dir);
	return dir;
}

async function createStartedPlan(cwd: string): Promise<void> {
	await createUltragoalPlan({ cwd, brief: "@goal G010 timeout guard\nRun the oversized integration work unit." });
	const started = await startNextUltragoalGoal({ cwd });
	expect(started.goal?.id).toBe("G001");
	expect(started.goal?.status).toBe("active");
}

describe("ultragoal timeout retry guard", () => {
	it("classifies timeout causes into stable escalation categories", () => {
		expect(
			classifyUltragoalTimeoutCause({
				evidence: "oversized work unit should be split",
				timeoutMs: 10_000,
				expectedRuntimeMs: 30_000,
			}),
		).toBe("WORK_UNIT_TOO_LARGE");
		expect(
			classifyUltragoalTimeoutCause({
				evidence: "runner rpc transport timeout",
				timeoutMs: 60_000,
				elapsedMs: 60_001,
			}),
		).toBe("RUNNER_RPC_TIMEOUT");
		expect(
			classifyUltragoalTimeoutCause({
				evidence: "no-output stall with no heartbeat",
				timeoutMs: 20_000,
				noOutputMs: 19_000,
			}),
		).toBe("NO_OUTPUT_STALL");
		expect(classifyUltragoalTimeoutCause({ stderr: "provider model upstream timeout" })).toBe("PROVIDER_TIMEOUT");
		expect(classifyUltragoalTimeoutCause({ stderr: "tool call timeout" })).toBe("TOOL_TIMEOUT");
		expect(classifyUltragoalTimeoutCause({ evidence: "process exceeded time" })).toBe("UNKNOWN_TIMEOUT");
	});

	it("escalates repeated same-strategy timeouts and blocks retrying the same failed story", async () => {
		const cwd = await tempDir();
		await createStartedPlan(cwd);

		const first = await recordUltragoalTimeout({
			cwd,
			goalId: "G001",
			command: ["bun", "test", "packages/coding-agent/test/g010-large.test.ts"],
			sourceSnapshot: { tree: "same-source" },
			timeoutMs: 60_000,
			elapsedMs: 61_000,
			evidence: "runner RPC 60s timeout while the test body needs around 90s",
		});
		expect(first.cause).toBe("RUNNER_RPC_TIMEOUT");
		expect(first.escalated).toBe(false);
		expect(first.retryAllowed).toBe(true);
		expect(first.goal.status).toBe("failed");

		const retried = await startNextUltragoalGoal({ cwd, retryFailed: true });
		expect(retried.goal?.id).toBe("G001");
		expect(retried.goal?.status).toBe("active");

		const second = await recordUltragoalTimeout({
			cwd,
			goalId: "G001",
			command: ["bun", "test", "packages/coding-agent/test/g010-large.test.ts"],
			sourceSnapshot: { tree: "same-source" },
			timeoutMs: 60_000,
			elapsedMs: 62_000,
			evidence: "same runner RPC timeout repeated without sharding",
		});
		expect(second.escalated).toBe(true);
		expect(second.escalationReason).toBe("repeated_timeout");
		expect(second.retryAllowed).toBe(false);
		expect(second.timeoutCountForSignature).toBe(2);
		expect(second.goal.status).toBe("blocked");
		expect(second.message).toContain("same strategy/source snapshot timed out 2 times");

		const blockedRetry = await startNextUltragoalGoal({ cwd, retryFailed: true });
		expect(blockedRetry.goal).toBeUndefined();
		expect(blockedRetry.allComplete).toBe(false);

		const ledger = await readUltragoalLedger(cwd);
		expect(ledger.filter(event => event.event === "timeout_observed")).toHaveLength(2);
		const plan = await readUltragoalPlan(cwd);
		expect(plan?.goals[0]?.evidence).toContain("same strategy/source snapshot timed out 2 times");
	});

	it("turns timeout retry budget exhaustion into a blocked terminal state", async () => {
		const cwd = await tempDir();
		await createStartedPlan(cwd);

		await recordUltragoalTimeout({
			cwd,
			goalId: "G001",
			command: ["bun", "test", "suite-a.test.ts"],
			sourceSnapshot: { tree: "budget-source" },
			retryBudget: 2,
			evidence: "first tool timeout on a smaller shard",
			cause: "TOOL_TIMEOUT",
		});
		await startNextUltragoalGoal({ cwd, retryFailed: true });

		const exhausted = await recordUltragoalTimeout({
			cwd,
			goalId: "G001",
			command: ["bun", "test", "suite-b.test.ts"],
			sourceSnapshot: { tree: "budget-source" },
			retryBudget: 2,
			evidence: "second different shard timed out, exhausting the story budget",
			cause: "TOOL_TIMEOUT",
		});
		expect(exhausted.escalated).toBe(true);
		expect(exhausted.escalationReason).toBe("retry_budget_exceeded");
		expect(exhausted.timeoutCountForSignature).toBe(1);
		expect(exhausted.timeoutCountForGoal).toBe(2);
		expect(exhausted.goal.status).toBe("blocked");
		expect(exhausted.retryAllowed).toBe(false);
	});

	it("marks prior CLEAR/pass completion evidence stale when the source snapshot changes", () => {
		const receipt: UltragoalCompletionVerification = {
			schemaVersion: 1,
			receiptId: "receipt-1",
			verifiedAt: "2026-07-15T00:00:00.000Z",
			goalId: "G001",
			receiptKind: "per-goal",
			goalStatusBeforeCheckpoint: "active",
			gjcGoalMode: "aggregate",
			gjcObjective: "GJC Ultragoal aggregate objective",
			qualityGateHash: "quality-gate-hash",
			planGeneration: "plan-generation",
			basis: {
				planHashBeforeCheckpoint: "plan-hash",
				latestRelevantLedgerEventIdBeforeCheckpoint: null,
				goalUpdatedAtBeforeCheckpoint: "2026-07-15T00:00:00.000Z",
				relevantGoalIdsBeforeCheckpoint: ["G001"],
				requiredGoalSetHashBeforeCheckpoint: "required-goal-set-hash",
			},
			checkpointLedgerEventId: "checkpoint-event-1",
			sourceSnapshotHashBeforeCheckpoint: "source-snapshot-before",
		};
		const goal: UltragoalGoal = {
			id: "G001",
			title: "Verified story",
			objective: "Verified story objective",
			status: "complete",
			createdAt: "2026-07-15T00:00:00.000Z",
			updatedAt: "2026-07-15T00:00:00.000Z",
			completionVerification: receipt,
		};

		expect(
			validateUltragoalCompletionSourceSnapshotFresh({
				goal,
				currentSourceSnapshotHash: "source-snapshot-before",
			}),
		).toBeNull();
		const stale = validateUltragoalCompletionSourceSnapshotFresh({
			goal,
			currentSourceSnapshotHash: "source-snapshot-after",
		});
		expect(stale?.state).toBe("active_stale_receipt");
		expect(stale?.message).toContain("CLEAR/pass evidence");
	});
});
