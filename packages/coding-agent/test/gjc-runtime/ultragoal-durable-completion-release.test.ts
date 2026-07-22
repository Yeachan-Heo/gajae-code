import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sessionUltragoalDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import {
	type UltragoalGuardState,
	validateCompletionReceipt,
	verifyUltragoalDurableCompletionState,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-guard";
import { computeUltragoalPlanGeneration } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-receipt-freshness";
import {
	addUltragoalSubgoal,
	checkpointUltragoalGoal,
	createUltragoalPlan,
	hashStructuredValue,
	readUltragoalPlan,
	startNextUltragoalGoal,
	type UltragoalCompletionVerification,
	type UltragoalGoal,
	type UltragoalLedgerEvent,
	type UltragoalPlan,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";

const TEST_SESSION_ID = "ultragoal-durable-completion-release-test-session";
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
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-ultragoal-durable-release-"));
	tempRoots.push(dir);
	return dir;
}

function isReleaseAllowed(state: UltragoalGuardState): boolean {
	return state === "inactive" || state === "active_verified_complete";
}

function passingQualityGate(): string {
	return JSON.stringify({
		criticReview: {
			verdict: "OKAY",
			evidence: "critic approved the final aggregate completion",
			blockers: [],
		},
		architectReview: {
			architectureStatus: "CLEAR",
			productStatus: "CLEAR",
			codeStatus: "CLEAR",
			recommendation: "APPROVE",
			evidence: "architect reviewed the implementation and found no blockers",
			commands: ["architect-review"],
			blockers: [],
		},
		executorQa: {
			status: "passed",
			e2eStatus: "passed",
			redTeamStatus: "passed",
			evidence: "executor ran API package checks and adversarial coverage",
			e2eCommands: ["bun test package-consumer"],
			redTeamCommands: ["bun test adversarial"],
			artifactRefs: [
				{
					id: "api-report",
					kind: "api-package-test-report",
					path: "artifacts/api-report.txt",
					description: "API package consumer test report",
				},
				{
					id: "adversarial-report",
					kind: "algorithm-boundary-test-report",
					path: "artifacts/adversarial-report.txt",
					description: "Adversarial boundary test report",
				},
			],
			contractCoverage: [
				{
					id: "contract-api",
					contractRef: "approved-plan:goal",
					obligation: "The completed goal satisfies the approved API/package contract",
					status: "covered",
					surfaceEvidenceRefs: ["surface-api"],
					adversarialCaseRefs: ["case-boundary"],
				},
			],
			surfaceEvidence: [
				{
					id: "surface-api",
					surface: "api/package",
					contractRef: "approved-plan:goal",
					invocation: "Run the package consumer API test",
					verdict: "passed",
					artifactRefs: ["api-report"],
				},
			],
			adversarialCases: [
				{
					id: "case-boundary",
					contractRef: "approved-plan:goal",
					scenario: "Exercise invalid and boundary inputs through the API",
					expectedBehavior: "The API rejects invalid input and preserves invariants",
					verdict: "passed",
					artifactRefs: ["adversarial-report"],
				},
			],
			blockers: [],
		},
		iteration: {
			status: "passed",
			evidence: "verification rerun found no remaining findings",
			fullRerun: true,
			rerunCommands: ["bun test package-consumer", "bun test adversarial"],
			blockers: [],
		},
	});
}

async function passingLiveQualityGate(root: string): Promise<string> {
	await fs.mkdir(path.join(root, "artifacts"), { recursive: true });
	await fs.writeFile(path.join(root, "artifacts", "api-report.txt"), "API package consumer test passed\n");
	await fs.writeFile(
		path.join(root, "artifacts", "adversarial-report.txt"),
		"Boundary and adversarial tests passed\n",
	);
	return passingQualityGate();
}

async function createTwoGoalPlan(root: string, mode: "aggregate" | "per-story" = "aggregate"): Promise<void> {
	await createUltragoalPlan({ cwd: root, brief: "Ship the feature", gjcGoalMode: mode });
	await addUltragoalSubgoal({
		cwd: root,
		title: "Second story",
		objective: "Complete the second story.",
		evidence: "The feature requires a second required story.",
		rationale: "Exercise multi-goal completion release checks.",
	});
}

function reviewedBatchReplacementFixture(options: { multiple?: boolean; staleReplacement?: boolean } = {}): {
	plan: UltragoalPlan;
	ledger: UltragoalLedgerEvent[];
} {
	const batch = {
		schemaVersion: 1 as const,
		batchId: "VB004",
		memberIds: ["G002", "G003", "G004"],
		finalGoalId: "G004",
		mode: "aggregate-only" as const,
		metadataHash: "batch-metadata",
	};
	const ids = ["G001", "G002", "G003", "G004", "G005", "G006", "G007", "G008", ...(options.multiple ? ["G009"] : [])];
	const plan: UltragoalPlan = {
		version: 1,
		brief: "Reviewed validation batch replacement",
		gjcGoalMode: "aggregate",
		gjcObjective: "Complete reviewed batch",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		goals: ids.map(
			(id, index): UltragoalGoal => ({
				id,
				title: id,
				objective: id,
				status: id === "G004" ? "superseded" : "complete",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
				...(batch.memberIds.includes(id) ? { validationBatch: { ...batch } } : {}),
				...(id === "G008" || id === "G009" ? { steering: { kind: "review_blocker", blockedGoalId: "G004" } } : {}),
			}),
		),
	};
	const ledger: UltragoalLedgerEvent[] = [];
	const receiptFor = (goalId: string, receiptKind: "per-goal" | "final-aggregate") => {
		const goal = plan.goals.find(item => item.id === goalId)!;
		const eventId = `checkpoint-${goalId}`;
		const generation = computeUltragoalPlanGeneration({
			plan,
			ledger,
			goal,
			receiptKind,
			beforeStatus: "active",
			excludeEventId: eventId,
			targetGoalUpdatedAt: goal.updatedAt,
		});
		const qualityGateJson =
			receiptKind === "final-aggregate"
				? { criticReview: { verdict: "OKAY", evidence: "critic approved final aggregation", blockers: [] } }
				: {};
		const receipt: UltragoalCompletionVerification = {
			schemaVersion: 1,
			receiptId: `receipt-${goalId}`,
			verifiedAt: goal.updatedAt,
			goalId,
			receiptKind,
			goalStatusBeforeCheckpoint: "active",
			gjcGoalMode: plan.gjcGoalMode,
			gjcObjective: plan.gjcObjective,
			qualityGateHash: hashStructuredValue(qualityGateJson),
			planGeneration: generation.planGeneration,
			basis: generation.basis,
			checkpointLedgerEventId: eventId,
			...(goalId === "G002" || goalId === "G003"
				? { validationBatch: { role: "deferred-member" as const, ...batch, changeSetHash: `changes-${goalId}` } }
				: {}),
		};
		goal.completionVerification = receipt;
		ledger.push({
			eventId,
			event: "goal_checkpointed",
			goalId,
			status: "complete",
			qualityGateJson,
			completionVerification: receipt,
		});
	};
	for (const goalId of ["G001", "G002", "G003", "G005", "G007", "G008", ...(options.multiple ? ["G009"] : [])])
		receiptFor(goalId, "per-goal");
	receiptFor("G006", "final-aggregate");
	if (options.staleReplacement)
		plan.goals.find(goal => goal.id === "G008")!.completionVerification!.qualityGateHash = "stale";
	return { plan, ledger };
}

async function completeGoal(root: string, goalId: string): Promise<void> {
	await startNextUltragoalGoal({ cwd: root });
	await checkpointUltragoalGoal({
		cwd: root,
		goalId,
		status: "complete",
		evidence: `${goalId} verified complete`,
		qualityGateJson: await passingLiveQualityGate(root),
	});
}

describe("ultragoal durable completion release state", () => {
	it("treats missing durable plan as inactive and release-allowed", async () => {
		const root = await tempDir();

		const diagnostic = await verifyUltragoalDurableCompletionState({ cwd: root, sessionId: TEST_SESSION_ID });

		expect(diagnostic.state).toBe("inactive");
		expect(isReleaseAllowed(diagnostic.state)).toBe(true);
	});

	it("blocks aggregate mode while a required goal is incomplete", async () => {
		const root = await tempDir();
		await createTwoGoalPlan(root);
		await completeGoal(root, "G001");

		const diagnostic = await verifyUltragoalDurableCompletionState({ cwd: root, sessionId: TEST_SESSION_ID });

		expect(diagnostic.state).toBe("active_missing_final_receipt");
		expect(diagnostic.message).toContain("incomplete required goals");
		expect(isReleaseAllowed(diagnostic.state)).toBe(false);
	});

	it("blocks aggregate mode when complete-looking goals have no fresh final aggregate receipt", async () => {
		const root = await tempDir();
		await createTwoGoalPlan(root);
		await completeGoal(root, "G001");
		await completeGoal(root, "G002");
		const goalsPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json");
		const plan = await readUltragoalPlan(root, TEST_SESSION_ID);
		if (!plan) throw new Error("missing plan");
		const finalGoal = plan.goals.find(goal => goal.id === "G002");
		if (!finalGoal) throw new Error("missing final goal");
		delete finalGoal.completionVerification;
		await fs.writeFile(goalsPath, `${JSON.stringify(plan, null, 2)}\n`);

		const diagnostic = await verifyUltragoalDurableCompletionState({ cwd: root, sessionId: TEST_SESSION_ID });

		expect(diagnostic.state).toBe("active_missing_final_receipt");
		expect(diagnostic.message).toContain("final aggregate receipt");
		expect(isReleaseAllowed(diagnostic.state)).toBe(false);
	});

	it("allows aggregate mode when final aggregate and prior per-goal receipts are fresh", async () => {
		const root = await tempDir();
		await createTwoGoalPlan(root);
		await completeGoal(root, "G001");
		await completeGoal(root, "G002");

		const diagnostic = await verifyUltragoalDurableCompletionState({ cwd: root, sessionId: TEST_SESSION_ID });

		expect(diagnostic.state).toBe("active_verified_complete");
		expect(isReleaseAllowed(diagnostic.state)).toBe(true);
	});

	it("blocks per-story mode when a required story lacks a valid per-goal receipt", async () => {
		const root = await tempDir();
		await createTwoGoalPlan(root, "per-story");
		await completeGoal(root, "G001");

		const diagnostic = await verifyUltragoalDurableCompletionState({ cwd: root, sessionId: TEST_SESSION_ID });

		expect(diagnostic.state).toBe("active_missing_receipt");
		expect(diagnostic.message).toContain("incomplete: G002");
		expect(isReleaseAllowed(diagnostic.state)).toBe(false);
	});

	it("allows per-story mode when all required stories have fresh per-goal receipts", async () => {
		const root = await tempDir();
		await createTwoGoalPlan(root, "per-story");
		await completeGoal(root, "G001");
		await completeGoal(root, "G002");

		const diagnostic = await verifyUltragoalDurableCompletionState({ cwd: root, sessionId: TEST_SESSION_ID });

		expect(diagnostic.state).toBe("active_verified_complete");
		expect(isReleaseAllowed(diagnostic.state)).toBe(true);
	});

	it("fails closed when durable state is corrupt", async () => {
		const root = await tempDir();
		await createTwoGoalPlan(root);
		const goalsPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json");
		await fs.writeFile(goalsPath, "{ not valid json");

		const diagnostic = await verifyUltragoalDurableCompletionState({ cwd: root, sessionId: TEST_SESSION_ID });

		expect(diagnostic.state).toBe("unreadable_fail_closed");
		expect(isReleaseAllowed(diagnostic.state)).toBe(false);
	});

	it("accepts deferred G002/G003 receipts only for a fresh G008 review-blocker replacement of superseded G004 during G006 final aggregation", () => {
		const { plan, ledger } = reviewedBatchReplacementFixture();

		expect(
			validateCompletionReceipt({
				plan,
				ledger,
				goal: plan.goals.find(goal => goal.id === "G002")!,
				receiptKind: "per-goal",
			}).state,
		).toBe("active_missing_final_receipt");
		expect(
			validateCompletionReceipt({
				plan,
				ledger,
				goal: plan.goals.find(goal => goal.id === "G006")!,
				receiptKind: "final-aggregate",
			}).state,
		).toBe("active_verified_complete");
	});

	it("fails closed when the sole review-blocker replacement receipt is stale", () => {
		const { plan, ledger } = reviewedBatchReplacementFixture({ staleReplacement: true });

		expect(
			validateCompletionReceipt({
				plan,
				ledger,
				goal: plan.goals.find(goal => goal.id === "G006")!,
				receiptKind: "final-aggregate",
			}).state,
		).not.toBe("active_verified_complete");
	});

	it("fails closed when multiple completed review-blocker replacements target the superseded batch final", () => {
		const { plan, ledger } = reviewedBatchReplacementFixture({ multiple: true });

		expect(
			validateCompletionReceipt({
				plan,
				ledger,
				goal: plan.goals.find(goal => goal.id === "G006")!,
				receiptKind: "final-aggregate",
			}).state,
		).not.toBe("active_verified_complete");
	});

	it("documents the complete release predicate matrix", () => {
		const states: UltragoalGuardState[] = [
			"inactive",
			"unrelated_goal",
			"active_verified_complete",
			"active_missing_receipt",
			"active_stale_receipt",
			"active_missing_final_receipt",
			"active_dirty_quality_gate",
			"active_review_blocked_unrecorded",
			"active_review_blocked_recorded",
			"unreadable_fail_closed",
		];

		expect(states.filter(isReleaseAllowed)).toEqual(["inactive", "active_verified_complete"]);
	});
});
