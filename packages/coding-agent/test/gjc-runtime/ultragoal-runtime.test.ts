import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	assertCanCompleteCurrentGoal,
	validateCompletionReceipt,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-guard";
import {
	checkpointUltragoalGoal,
	createUltragoalPlan,
	getUltragoalStatus,
	readUltragoalLedger,
	runNativeUltragoalCommand,
	startNextUltragoalGoal,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-ultragoal-runtime-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function passingQualityGate(): string {
	return JSON.stringify({
		architectReview: {
			architectureStatus: "CLEAR",
			productStatus: "CLEAR",
			codeStatus: "CLEAR",
			recommendation: "APPROVE",
			evidence: "architect reviewed architecture, product behavior, and code changes",
			commands: ["architect-review"],
			blockers: [],
		},
		executorQa: {
			status: "passed",
			e2eStatus: "passed",
			redTeamStatus: "passed",
			evidence: "executor built and ran e2e plus red-team QA suite",
			e2eCommands: ["bun test:e2e"],
			redTeamCommands: ["bun test:red-team"],
			blockers: [],
		},
		iteration: {
			status: "passed",
			evidence: "no verification findings remain after steering iterations",
			fullRerun: true,
			rerunCommands: ["bun test:e2e", "bun test:red-team"],
			blockers: [],
		},
	});
}

function goalSnapshot(objective: string, status = "active", updatedAt = Date.now()): string {
	return JSON.stringify({
		goal: {
			threadId: "test-thread",
			objective,
			status,
			createdAt: updatedAt,
			updatedAt,
		},
	});
}

function goalToolSnapshot(objective: string, status = "active", updatedAt = Date.now()): string {
	return JSON.stringify({
		content: [{ type: "text", text: `Goal: ${objective}` }],
		details: {
			op: "get",
			goal: {
				threadId: "test-thread",
				objective,
				status,
				createdAt: updatedAt,
				updatedAt,
			},
		},
	});
}

describe("native GJC ultragoal runtime", () => {
	it("reports missing status without requiring a private runtime binary", async () => {
		const root = await tempDir();

		const result = await runNativeUltragoalCommand(["status"], root);
		const status = await getUltragoalStatus(root);

		expect(result.status).toBe(0);
		expect(result.stderr).toBeUndefined();
		expect(result.stdout).toContain("No ultragoal plan found");
		expect(status.exists).toBe(false);
		expect(status.status).toBe("missing");
	});

	it("creates a durable aggregate plan and ledger", async () => {
		const root = await tempDir();

		const plan = await createUltragoalPlan({ cwd: root, brief: "Fix native ultragoal status" });
		const goalsRaw = await Bun.file(path.join(root, ".gjc", "ultragoal", "goals.json")).text();
		const ledgerRaw = await Bun.file(path.join(root, ".gjc", "ultragoal", "ledger.jsonl")).text();

		expect(plan.gjcGoalMode).toBe("aggregate");
		expect(plan.gjcObjective).toContain(".gjc/ultragoal/goals.json");
		expect(plan.goals).toHaveLength(1);
		expect(plan.goals[0]).toMatchObject({ id: "G001", status: "pending" });
		expect(goalsRaw).toContain("Fix native ultragoal status");
		expect(ledgerRaw).toContain("plan_created");
	});

	it("starts and checkpoints the current goal", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });

		const started = await startNextUltragoalGoal({ cwd: root });
		expect(started.goal?.status).toBe("active");
		const plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "tests passed",
			gjcGoalJson: goalSnapshot(created.gjcObjective),
			qualityGateJson: passingQualityGate(),
		});
		const status = await getUltragoalStatus(root);
		const diagnostic = validateCompletionReceipt({
			plan,
			ledger: await readUltragoalLedger(root),
			goal: plan.goals[0]!,
			receiptKind: "final-aggregate",
		});

		expect(plan.goals[0]?.status).toBe("complete");
		expect(status.status).toBe("complete");
		expect(status.counts.complete).toBe(1);
		expect(diagnostic.state).toBe("active_verified_complete");
		expect(plan.goals[0]?.completionVerification).toMatchObject({
			schemaVersion: 1,
			goalId: "G001",
			receiptKind: "final-aggregate",
		});
	});

	it("accepts full get_goal tool result snapshots with millisecond timestamps", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		const plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "tests passed",
			gjcGoalJson: goalToolSnapshot(created.gjcObjective),
			qualityGateJson: passingQualityGate(),
		});

		expect(plan.goals[0]?.status).toBe("complete");
		expect(plan.goals[0]?.completionVerification?.gjcGoalSnapshotHash).toBeTruthy();
	});

	it("accepts per-story get_goal snapshots for per-story plans", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix", gjcGoalMode: "per-story" });
		await startNextUltragoalGoal({ cwd: root });
		const storyObjective = created.goals[0]?.objective;
		if (!storyObjective) throw new Error("missing story objective");

		const plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "tests passed",
			gjcGoalJson: goalSnapshot(storyObjective),
			qualityGateJson: passingQualityGate(),
		});

		expect(plan.goals[0]?.status).toBe("complete");
		expect(plan.goals[0]?.completionVerification?.receiptKind).toBe("per-goal");
	});

	it("treats receipts as stale after target goal mutation", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "tests passed",
			gjcGoalJson: goalSnapshot(created.gjcObjective),
			qualityGateJson: passingQualityGate(),
		});
		const goal = plan.goals[0];
		if (!goal) throw new Error("missing goal");
		goal.updatedAt = "later-manual-edit";

		const diagnostic = validateCompletionReceipt({
			plan,
			ledger: await readUltragoalLedger(root),
			goal,
			receiptKind: "final-aggregate",
		});

		expect(diagnostic.state).toBe("active_stale_receipt");
	});

	it("treats receipts as stale after get_goal snapshot ledger mutation", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "tests passed",
			gjcGoalJson: goalSnapshot(created.gjcObjective),
			qualityGateJson: passingQualityGate(),
		});
		const ledger = await readUltragoalLedger(root);
		const checkpointEvent = ledger.find(event => event.event === "goal_checkpointed");
		if (!checkpointEvent) throw new Error("missing checkpoint event");
		checkpointEvent.gjcGoalJson = { goal: { objective: created.gjcObjective, status: "active", updatedAt: 1 } };

		const diagnostic = validateCompletionReceipt({
			plan,
			ledger,
			goal: plan.goals[0]!,
			receiptKind: "final-aggregate",
		});

		expect(diagnostic.state).toBe("active_stale_receipt");
		expect(diagnostic.message).toContain("snapshot hash");
	});

	it("blocks complete checkpoints without full architect and executor verification", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		const missingGate = await runNativeUltragoalCommand(
			["checkpoint", "--goal-id", "G001", "--status", "complete", "--evidence", "self verified"],
			root,
		);
		const shallowGate = await runNativeUltragoalCommand(
			[
				"checkpoint",
				"--goal-id",
				"G001",
				"--status",
				"complete",
				"--evidence",
				"tests passed",
				"--quality-gate-json",
				JSON.stringify({ verification: { status: "passed" } }),
			],
			root,
		);
		const status = await getUltragoalStatus(root);

		expect(missingGate.status).toBe(1);
		expect(missingGate.stderr).toContain("complete checkpoints require --quality-gate-json");
		expect(shallowGate.status).toBe(1);
		expect(shallowGate.stderr).toContain("qualityGate contains unsupported keys");
		expect(status.goals[0]?.status).toBe("active");
		expect(status.counts.complete).toBe(0);
	});

	it("rejects shallow gates with missing command arrays before mutation", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const beforeGoals = await Bun.file(path.join(root, ".gjc", "ultragoal", "goals.json")).text();
		const beforeLedger = await Bun.file(path.join(root, ".gjc", "ultragoal", "ledger.jsonl")).text();

		const result = await runNativeUltragoalCommand(
			[
				"checkpoint",
				"--goal-id",
				"G001",
				"--status",
				"complete",
				"--evidence",
				"tests passed",
				"--quality-gate-json",
				JSON.stringify({
					architectReview: {
						architectureStatus: "CLEAR",
						productStatus: "CLEAR",
						codeStatus: "CLEAR",
						recommendation: "APPROVE",
						evidence: "reviewed",
						commands: [],
						blockers: [],
					},
					executorQa: {
						status: "passed",
						e2eStatus: "passed",
						redTeamStatus: "passed",
						evidence: "tested",
						e2eCommands: ["bun test:e2e"],
						redTeamCommands: ["bun test:red-team"],
						blockers: [],
					},
					iteration: {
						status: "passed",
						evidence: "reran",
						fullRerun: true,
						rerunCommands: ["bun test:e2e"],
						blockers: [],
					},
				}),
			],
			root,
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("architectReview.commands");
		expect(await Bun.file(path.join(root, ".gjc", "ultragoal", "goals.json")).text()).toBe(beforeGoals);
		expect(await Bun.file(path.join(root, ".gjc", "ultragoal", "ledger.jsonl")).text()).toBe(beforeLedger);
	});

	it("rejects complete gates with missing evidence or dirty blockers before mutation", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const beforeGoals = await Bun.file(path.join(root, ".gjc", "ultragoal", "goals.json")).text();
		const beforeLedger = await Bun.file(path.join(root, ".gjc", "ultragoal", "ledger.jsonl")).text();
		const missingEvidenceGate = JSON.parse(passingQualityGate()) as Record<string, Record<string, unknown>>;
		missingEvidenceGate.architectReview!.evidence = "";
		const dirtyBlockersGate = JSON.parse(passingQualityGate()) as Record<string, Record<string, unknown>>;
		dirtyBlockersGate.executorQa!.blockers = ["regression remains"];
		const snapshot = goalSnapshot(created.gjcObjective);

		const missingEvidence = await runNativeUltragoalCommand(
			[
				"checkpoint",
				"--goal-id",
				"G001",
				"--status",
				"complete",
				"--evidence",
				"tests passed",
				"--gjc-goal-json",
				snapshot,
				"--quality-gate-json",
				JSON.stringify(missingEvidenceGate),
			],
			root,
		);
		const dirtyBlockers = await runNativeUltragoalCommand(
			[
				"checkpoint",
				"--goal-id",
				"G001",
				"--status",
				"complete",
				"--evidence",
				"tests passed",
				"--gjc-goal-json",
				snapshot,
				"--quality-gate-json",
				JSON.stringify(dirtyBlockersGate),
			],
			root,
		);

		expect(missingEvidence.status).toBe(1);
		expect(missingEvidence.stderr).toContain("architectReview.evidence");
		expect(dirtyBlockers.status).toBe(1);
		expect(dirtyBlockers.stderr).toContain("executorQa.blockers");
		expect(await Bun.file(path.join(root, ".gjc", "ultragoal", "goals.json")).text()).toBe(beforeGoals);
		expect(await Bun.file(path.join(root, ".gjc", "ultragoal", "ledger.jsonl")).text()).toBe(beforeLedger);
	});

	it("requires a fresh get_goal snapshot for complete checkpoints", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const beforeGoals = await Bun.file(path.join(root, ".gjc", "ultragoal", "goals.json")).text();

		const result = await runNativeUltragoalCommand(
			[
				"checkpoint",
				"--goal-id",
				"G001",
				"--status",
				"complete",
				"--evidence",
				"tests passed",
				"--quality-gate-json",
				passingQualityGate(),
			],
			root,
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("complete checkpoints require --gjc-goal-json");
		expect(await Bun.file(path.join(root, ".gjc", "ultragoal", "goals.json")).text()).toBe(beforeGoals);
	});

	it("fails closed when an active Ultragoal objective has no durable plan", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await fs.rm(path.join(root, ".gjc", "ultragoal", "goals.json"));

		await expect(
			assertCanCompleteCurrentGoal({
				cwd: root,
				currentGoal: { objective: created.gjcObjective, status: "active" },
			}),
		).rejects.toThrow("missing durable .gjc/ultragoal/goals.json");
	});

	it("fails closed for per-story Ultragoal objectives when the durable plan is missing", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix", gjcGoalMode: "per-story" });
		const storyObjective = created.goals[0]?.objective;
		if (!storyObjective) throw new Error("missing story objective");
		await fs.rm(path.join(root, ".gjc", "ultragoal", "goals.json"));

		await expect(
			assertCanCompleteCurrentGoal({
				cwd: root,
				currentGoal: { objective: storyObjective, status: "active" },
			}),
		).rejects.toThrow("missing durable .gjc/ultragoal/goals.json");
	});

	it("rejects unrelated or stale get_goal snapshots before mutation", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const beforeGoals = await Bun.file(path.join(root, ".gjc", "ultragoal", "goals.json")).text();
		const beforeLedger = await Bun.file(path.join(root, ".gjc", "ultragoal", "ledger.jsonl")).text();
		const baseArgs = [
			"checkpoint",
			"--goal-id",
			"G001",
			"--status",
			"complete",
			"--evidence",
			"tests passed",
			"--quality-gate-json",
			passingQualityGate(),
			"--gjc-goal-json",
		];

		const bogus = await runNativeUltragoalCommand([...baseArgs, JSON.stringify({ nope: true })], root);
		const wrongObjective = await runNativeUltragoalCommand([...baseArgs, goalSnapshot("other goal")], root);
		const staleStatus = await runNativeUltragoalCommand(
			[...baseArgs, goalSnapshot(created.gjcObjective, "complete")],
			root,
		);
		const staleSnapshot = await runNativeUltragoalCommand(
			[...baseArgs, goalSnapshot(created.gjcObjective, "active", 1)],
			root,
		);

		expect(bogus.status).toBe(1);
		expect(bogus.stderr).toContain("goal object");
		expect(wrongObjective.status).toBe(1);
		expect(wrongObjective.stderr).toContain("objective");
		expect(staleStatus.status).toBe(1);
		expect(staleStatus.stderr).toContain("goal.status to be active");
		expect(staleSnapshot.status).toBe(1);
		expect(staleSnapshot.stderr).toContain("fresh");
		expect(await Bun.file(path.join(root, ".gjc", "ultragoal", "goals.json")).text()).toBe(beforeGoals);
		expect(await Bun.file(path.join(root, ".gjc", "ultragoal", "ledger.jsonl")).text()).toBe(beforeLedger);
	});

	it("allows completed legacy goal snapshots for blocked checkpoints", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		const result = await runNativeUltragoalCommand(
			[
				"checkpoint",
				"--goal-id",
				"G001",
				"--status",
				"blocked",
				"--evidence",
				"legacy completed GJC goal blocks create_goal in this thread",
				"--gjc-goal-json",
				goalSnapshot("legacy completed unrelated goal", "complete"),
			],
			root,
		);
		const status = await getUltragoalStatus(root);
		const ledgerRaw = await Bun.file(path.join(root, ".gjc", "ultragoal", "ledger.jsonl")).text();

		expect(result.status).toBe(0);
		expect(status.goals[0]?.status).toBe("blocked");
		expect(ledgerRaw).toContain("legacy completed GJC goal blocks");
	});

	it("rejects unrelated review-blocker snapshots before mutation", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const beforeGoals = await Bun.file(path.join(root, ".gjc", "ultragoal", "goals.json")).text();
		const beforeLedger = await Bun.file(path.join(root, ".gjc", "ultragoal", "ledger.jsonl")).text();

		const result = await runNativeUltragoalCommand(
			[
				"record-review-blockers",
				"--goal-id",
				"G001",
				"--title",
				"Resolve verification blockers",
				"--objective",
				"Fix architect and executor QA findings.",
				"--evidence",
				"architect found product regression",
				"--gjc-goal-json",
				goalSnapshot("unrelated", "complete"),
			],
			root,
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("objective");
		expect(await Bun.file(path.join(root, ".gjc", "ultragoal", "goals.json")).text()).toBe(beforeGoals);
		expect(await Bun.file(path.join(root, ".gjc", "ultragoal", "ledger.jsonl")).text()).toBe(beforeLedger);
	});

	it("unblocks plans after verification blocker stories complete cleanly", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		const blockers = await runNativeUltragoalCommand(
			[
				"record-review-blockers",
				"--goal-id",
				"G001",
				"--title",
				"Resolve verification blockers",
				"--objective",
				"Fix architect and executor QA findings.",
				"--evidence",
				"architect found product regression",
				"--gjc-goal-json",
				goalSnapshot(created.gjcObjective),
			],
			root,
		);
		await startNextUltragoalGoal({ cwd: root });
		const completedBlocker = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G002",
			status: "complete",
			evidence: "fixed regression and reran full verification",
			gjcGoalJson: goalSnapshot(created.gjcObjective),
			qualityGateJson: passingQualityGate(),
		});
		const status = await getUltragoalStatus(root);

		expect(blockers.status).toBe(0);
		expect(completedBlocker.goals[0]).toMatchObject({ id: "G001", status: "superseded" });
		expect(completedBlocker.goals[1]).toMatchObject({ id: "G002", status: "complete" });
		expect(status.status).toBe("complete");
		expect(completedBlocker.goals[1]?.completionVerification?.receiptKind).toBe("final-aggregate");
	});

	it("requires review blockers to include a fresh active get_goal snapshot", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const beforeGoals = await Bun.file(path.join(root, ".gjc", "ultragoal", "goals.json")).text();

		const result = await runNativeUltragoalCommand(
			[
				"record-review-blockers",
				"--goal-id",
				"G001",
				"--title",
				"Resolve verification blockers",
				"--objective",
				"Fix architect and executor QA findings.",
				"--evidence",
				"architect found product regression",
			],
			root,
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("record-review-blockers require --gjc-goal-json");
		expect(await Bun.file(path.join(root, ".gjc", "ultragoal", "goals.json")).text()).toBe(beforeGoals);
	});
	it("blocks complete checkpoints without the strict architect/executor/iteration quality gate", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "tests passed",
				gjcGoalJson: goalSnapshot(created.gjcObjective),
			}),
		).rejects.toThrow("require --quality-gate-json");

		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "tests passed",
				gjcGoalJson: goalSnapshot(created.gjcObjective),
				qualityGateJson: JSON.stringify({
					verification: { status: "passed" },
					codeReview: { recommendation: "APPROVE", architectStatus: "WATCH" },
				}),
			}),
		).rejects.toThrow("legacy codeReview-only gates are not sufficient");

		const status = await getUltragoalStatus(root);
		expect(status.goals[0]?.status).toBe("active");
	});

	it("blocks complete checkpoint commands without the strict quality gate", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		const result = await runNativeUltragoalCommand(
			[
				"checkpoint",
				"--goal-id",
				"G001",
				"--status",
				"complete",
				"--evidence",
				"tests passed",
				"--gjc-goal-json",
				goalSnapshot(created.gjcObjective),
			],
			root,
		);
		const status = await getUltragoalStatus(root);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("require --quality-gate-json");
		expect(status.goals[0]?.status).toBe("active");
	});

	it("rejects mistyped checkpoint statuses instead of silently changing state", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });

		const result = await runNativeUltragoalCommand(
			["checkpoint", "--goal-id", "G001", "--status", "complet", "--evidence", "typo"],
			root,
		);
		const status = await getUltragoalStatus(root);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("checkpoint --status must be");
		expect(status.goals[0]?.status).toBe("pending");
	});
});
