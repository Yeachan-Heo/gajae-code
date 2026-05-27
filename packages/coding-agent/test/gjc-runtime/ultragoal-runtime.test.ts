import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { validateCompletionReceipt } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-guard";
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
			gjcGoalJson: JSON.stringify({ goal: { status: "complete" } }),
			qualityGateJson: JSON.stringify({
				verification: { status: "passed" },
				codeReview: { recommendation: "APPROVE", architectStatus: "CLEAR" },
			}),
		});
		const status = await getUltragoalStatus(root);

		expect(plan.goals[0]?.status).toBe("complete");
		expect(status.status).toBe("complete");
		expect(status.counts.complete).toBe(1);
		expect(plan.goals[0]?.completionVerification).toMatchObject({
			schemaVersion: 1,
			goalId: "G001",
			receiptKind: "final-aggregate",
		});
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
			gjcGoalJson: JSON.stringify({ goal: { objective: created.gjcObjective, status: "active" } }),
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
			],
			root,
		);
		await startNextUltragoalGoal({ cwd: root });
		const completedBlocker = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G002",
			status: "complete",
			evidence: "fixed regression and reran full verification",
			gjcGoalJson: JSON.stringify({ goal: { objective: created.gjcObjective, status: "active" } }),
			qualityGateJson: passingQualityGate(),
		});
		const status = await getUltragoalStatus(root);

		expect(blockers.status).toBe(0);
		expect(completedBlocker.goals[0]).toMatchObject({ id: "G001", status: "superseded" });
		expect(completedBlocker.goals[1]).toMatchObject({ id: "G002", status: "complete" });
		expect(status.status).toBe("complete");
		expect(completedBlocker.goals[1]?.completionVerification?.receiptKind).toBe("final-aggregate");
	});
	it("blocks complete checkpoints without a clean architect review gate", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "tests passed",
				gjcGoalJson: JSON.stringify({ goal: { status: "complete" } }),
			}),
		).rejects.toThrow("requires --quality-gate-json");

		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "tests passed",
				gjcGoalJson: JSON.stringify({ goal: { status: "complete" } }),
				qualityGateJson: JSON.stringify({
					verification: { status: "passed" },
					codeReview: { recommendation: "APPROVE", architectStatus: "WATCH" },
				}),
			}),
		).rejects.toThrow("requires architect review approval");

		const status = await getUltragoalStatus(root);
		expect(status.goals[0]?.status).toBe("active");
	});

	it("blocks complete checkpoint commands without a clean architect review gate", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
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
				JSON.stringify({ goal: { status: "complete" } }),
			],
			root,
		);
		const status = await getUltragoalStatus(root);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("requires --quality-gate-json");
		expect(status.goals[0]?.status).toBe("active");
	});
	it("blocks complete checkpoints without a clean architect review gate", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "tests passed",
				gjcGoalJson: JSON.stringify({ goal: { status: "complete" } }),
			}),
		).rejects.toThrow("requires --quality-gate-json");

		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "tests passed",
				gjcGoalJson: JSON.stringify({ goal: { status: "complete" } }),
				qualityGateJson: JSON.stringify({
					verification: { status: "passed" },
					codeReview: { recommendation: "APPROVE", architectStatus: "WATCH" },
				}),
			}),
		).rejects.toThrow("requires architect review approval");

		const status = await getUltragoalStatus(root);
		expect(status.goals[0]?.status).toBe("active");
	});

	it("blocks complete checkpoint commands without a clean architect review gate", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
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
				JSON.stringify({ goal: { status: "complete" } }),
			],
			root,
		);
		const status = await getUltragoalStatus(root);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("requires --quality-gate-json");
		expect(status.goals[0]?.status).toBe("active");
	});
	it("blocks complete checkpoints without a clean architect review gate", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "tests passed",
				gjcGoalJson: JSON.stringify({ goal: { status: "complete" } }),
			}),
		).rejects.toThrow("requires --quality-gate-json");

		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "tests passed",
				gjcGoalJson: JSON.stringify({ goal: { status: "complete" } }),
				qualityGateJson: JSON.stringify({
					verification: { status: "passed" },
					codeReview: { recommendation: "APPROVE", architectStatus: "WATCH" },
				}),
			}),
		).rejects.toThrow("requires architect review approval");

		const status = await getUltragoalStatus(root);
		expect(status.goals[0]?.status).toBe("active");
	});

	it("blocks complete checkpoint commands without a clean architect review gate", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
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
				JSON.stringify({ goal: { status: "complete" } }),
			],
			root,
		);
		const status = await getUltragoalStatus(root);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("requires --quality-gate-json");
		expect(status.goals[0]?.status).toBe("active");
	});
	it("blocks complete checkpoints without a clean architect review gate", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "tests passed",
				gjcGoalJson: JSON.stringify({ goal: { status: "complete" } }),
			}),
		).rejects.toThrow("requires --quality-gate-json");

		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "tests passed",
				gjcGoalJson: JSON.stringify({ goal: { status: "complete" } }),
				qualityGateJson: JSON.stringify({
					verification: { status: "passed" },
					codeReview: { recommendation: "APPROVE", architectStatus: "WATCH" },
				}),
			}),
		).rejects.toThrow("requires architect review approval");

		const status = await getUltragoalStatus(root);
		expect(status.goals[0]?.status).toBe("active");
	});

	it("blocks complete checkpoint commands without a clean architect review gate", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
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
				JSON.stringify({ goal: { status: "complete" } }),
			],
			root,
		);
		const status = await getUltragoalStatus(root);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("requires --quality-gate-json");
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
