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
			artifactRefs: [
				{
					id: "browser-run",
					kind: "browser-automation",
					path: "artifacts/browser-run.json",
					description: "Playwright/Pandawright browser run that invokes the approved user-facing flow",
					inlineEvidence:
						"Browser automation executed the approved flow, asserted the expected visible result, and captured the final DOM state.",
				},
				{
					id: "gui-screenshot",
					kind: "screenshot",
					path: "artifacts/gui-screenshot.png",
					description: "Screenshot evidence for the GUI/web surface verdict",
					inlineEvidence:
						"Screenshot review confirmed the approved screen state, including the success message and absence of regression indicators.",
				},
				{
					id: "adversarial-report",
					kind: "failure-mode-test",
					path: "artifacts/adversarial-report.txt",
					description: "Adversarial boundary and failure-mode test output",
					inlineEvidence:
						"Adversarial boundary cases exercised invalid input, missing state, and repeated submission without violating the contract.",
				},
			],
			contractCoverage: [
				{
					id: "contract-goal",
					contractRef: "approved-plan:goal",
					obligation: "The completed story satisfies the approved user-facing contract",
					status: "covered",
					surfaceEvidenceRefs: ["surface-gui"],
					adversarialCaseRefs: ["case-invalid-input"],
				},
			],
			surfaceEvidence: [
				{
					id: "surface-gui",
					surface: "gui/web",
					contractRef: "approved-plan:goal",
					invocation: "Open the user-facing flow in a browser and verify the visible result",
					verdict: "passed",
					artifactRefs: ["browser-run", "gui-screenshot"],
				},
			],
			adversarialCases: [
				{
					id: "case-invalid-input",
					contractRef: "approved-plan:goal",
					scenario: "Submit invalid or boundary input through the user-facing surface",
					expectedBehavior: "The implementation rejects or handles the case according to the approved contract",
					verdict: "passed",
					artifactRefs: ["adversarial-report"],
				},
			],
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
function mutateQualityGate(mutator: (gate: Record<string, Record<string, unknown>>) => void): string {
	const gate = JSON.parse(passingQualityGate()) as Record<string, Record<string, unknown>>;
	mutator(gate);
	return JSON.stringify(gate);
}

async function expectRejectedCompleteGate(
	root: string,
	created: { gjcObjective: string },
	qualityGateJson: string,
): Promise<string> {
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
			"--gjc-goal-json",
			goalSnapshot(created.gjcObjective),
			"--quality-gate-json",
			qualityGateJson,
		],
		root,
	);
	expect(result.status).toBe(1);
	expect(await Bun.file(path.join(root, ".gjc", "ultragoal", "goals.json")).text()).toBe(beforeGoals);
	expect(await Bun.file(path.join(root, ".gjc", "ultragoal", "ledger.jsonl")).text()).toBe(beforeLedger);
	return result.stderr ?? "";
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
	it("reports missing status from a fresh repo", async () => {
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

	it("accepts full goal get tool result snapshots with millisecond timestamps", async () => {
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

	it("accepts per-story goal get snapshots for per-story plans", async () => {
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

	it("treats receipts as stale after goal get snapshot ledger mutation", async () => {
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

	it("requires runtime-validated executor QA red-team matrix sections", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const missingMatrix = mutateQualityGate(gate => {
			delete gate.executorQa!.contractCoverage;
		});
		const emptyMatrix = mutateQualityGate(gate => {
			gate.executorQa!.surfaceEvidence = [];
		});

		const missingMatrixError = await expectRejectedCompleteGate(root, created, missingMatrix);
		const emptyMatrixError = await expectRejectedCompleteGate(root, created, emptyMatrix);

		expect(missingMatrixError).toContain("executorQa.contractCoverage");
		expect(emptyMatrixError).toContain("executorQa.surfaceEvidence");
	});

	it("rejects all-not-applicable contract coverage before mutation", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const allNotApplicableCoverage = mutateQualityGate(gate => {
			gate.executorQa!.contractCoverage = [
				{
					id: "contract-goal",
					contractRef: "approved-plan:goal",
					status: "not_applicable",
					reason: "Incorrectly claimed the approved goal contract is not applicable",
				},
			];
		});

		const coverageError = await expectRejectedCompleteGate(root, created, allNotApplicableCoverage);

		expect(coverageError).toContain(
			"executorQa.contractCoverage must include at least one row with status covered, passed, or verified",
		);
	});

	it("rejects missing red-team artifact references before mutation", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const missingArtifact = mutateQualityGate(gate => {
			const refs = gate.executorQa!.artifactRefs as Array<Record<string, unknown>>;
			delete refs[0]!.inlineEvidence;
			refs[0]!.path = "artifacts/missing-browser-run.json";
		});

		const artifactError = await expectRejectedCompleteGate(root, created, missingArtifact);

		expect(artifactError).toContain("executorQa.artifactRefs[0]");
		expect(artifactError).toContain("existing non-empty artifact path");
	});

	it("rejects empty red-team evidence artifacts before mutation", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		await fs.mkdir(path.join(root, "artifacts"), { recursive: true });
		await Bun.write(path.join(root, "artifacts", "empty-browser-run.json"), "");
		const emptyArtifact = mutateQualityGate(gate => {
			const refs = gate.executorQa!.artifactRefs as Array<Record<string, unknown>>;
			delete refs[0]!.inlineEvidence;
			refs[0]!.path = "artifacts/empty-browser-run.json";
		});

		const artifactError = await expectRejectedCompleteGate(root, created, emptyArtifact);

		expect(artifactError).toContain("executorQa.artifactRefs[0]");
		expect(artifactError).toContain("existing non-empty artifact path");
	});

	it("accepts substantive inline evidence, non-empty artifacts, and typed verified receipt references", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		await fs.mkdir(path.join(root, "artifacts"), { recursive: true });
		await Bun.write(
			path.join(root, "artifacts", "gui-screenshot.txt"),
			"approved screenshot artifact contains visible success-state verification",
		);
		const mixedProof = mutateQualityGate(gate => {
			const refs = gate.executorQa!.artifactRefs as Array<Record<string, unknown>>;
			refs[0] = {
				id: "browser-run",
				kind: "browser-automation",
				description: "Browser automation inline proof",
				inlineEvidence:
					"Browser automation completed the approved flow, asserted the result, and recorded the runtime state transitions.",
			};
			refs[1] = {
				id: "gui-screenshot",
				kind: "screenshot",
				path: "artifacts/gui-screenshot.txt",
				description: "Existing non-empty screenshot artifact",
			};
			refs[2] = {
				id: "adversarial-report",
				kind: "failure-mode-test",
				description: "Typed verified receipt from adversarial runner",
				verifiedReceipt: {
					type: "red-team-adversarial-run",
					id: "receipt-adversarial-001",
					status: "verified",
				},
			};
		});

		const plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "tests passed",
			gjcGoalJson: goalSnapshot(created.gjcObjective),
			qualityGateJson: mixedProof,
		});

		expect(plan.goals[0]?.status).toBe("complete");
	});

	it("rejects empty or degenerate red-team receipts before mutation", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const degenerateReceipt = mutateQualityGate(gate => {
			const refs = gate.executorQa!.artifactRefs as Array<Record<string, unknown>>;
			delete refs[0]!.inlineEvidence;
			delete refs[0]!.path;
			refs[0]!.verifiedReceipt = { status: "verified" };
		});

		const receiptError = await expectRejectedCompleteGate(root, created, degenerateReceipt);

		expect(receiptError).toContain("executorQa.artifactRefs[0]");
		expect(receiptError).toContain("typed verifiedReceipt");
	});

	it("rejects fake or unlinked executor QA red-team evidence before mutation", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const missingArtifactMetadata = mutateQualityGate(gate => {
			const refs = gate.executorQa!.artifactRefs as Array<Record<string, unknown>>;
			delete refs[0]!.kind;
		});
		const missingSurfaceArtifact = mutateQualityGate(gate => {
			const surfaceEvidence = gate.executorQa!.surfaceEvidence as Array<Record<string, unknown>>;
			surfaceEvidence[0]!.artifactRefs = ["missing-artifact"];
		});
		const missingCoverageLink = mutateQualityGate(gate => {
			const coverage = gate.executorQa!.contractCoverage as Array<Record<string, unknown>>;
			coverage[0]!.surfaceEvidenceRefs = ["missing-surface"];
		});

		const artifactError = await expectRejectedCompleteGate(root, created, missingArtifactMetadata);
		const surfaceError = await expectRejectedCompleteGate(root, created, missingSurfaceArtifact);
		const coverageError = await expectRejectedCompleteGate(root, created, missingCoverageLink);

		expect(artifactError).toContain("executorQa.artifactRefs[0].kind");
		expect(surfaceError).toContain("executorQa.surfaceEvidence[0].artifactRefs");
		expect(coverageError).toContain("executorQa.contractCoverage[0].surfaceEvidenceRefs");
	});

	it("enforces not-applicable and GUI/web artifact compatibility rules", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const notApplicableWithoutReason = mutateQualityGate(gate => {
			const surfaceEvidence = gate.executorQa!.surfaceEvidence as Array<Record<string, unknown>>;
			surfaceEvidence[0] = {
				id: "surface-gui",
				surface: "gui/web",
				contractRef: "approved-plan:goal",
				status: "not_applicable",
			};
		});
		const adversarialNotApplicable = mutateQualityGate(gate => {
			const cases = gate.executorQa!.adversarialCases as Array<Record<string, unknown>>;
			cases[0]!.status = "not_applicable";
		});
		const guiWithCliOnlyArtifact = mutateQualityGate(gate => {
			const refs = gate.executorQa!.artifactRefs as Array<Record<string, unknown>>;
			refs[0]!.kind = "cli-log";
			refs[1]!.kind = "terminal-transcript";
		});

		const notApplicableError = await expectRejectedCompleteGate(root, created, notApplicableWithoutReason);
		const adversarialError = await expectRejectedCompleteGate(root, created, adversarialNotApplicable);
		const guiError = await expectRejectedCompleteGate(root, created, guiWithCliOnlyArtifact);

		expect(notApplicableError).toContain("executorQa.surfaceEvidence[0].reason");
		expect(adversarialError).toContain("executorQa.adversarialCases[0].status");
		expect(guiError).toContain("GUI/web surfaces");
	});

	it("rejects failed executor QA matrix row outcomes before mutation", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const failedSurfaceVerdict = mutateQualityGate(gate => {
			const surfaceEvidence = gate.executorQa!.surfaceEvidence as Array<Record<string, unknown>>;
			surfaceEvidence[0]!.verdict = "failed";
		});
		const failedAdversarialResult = mutateQualityGate(gate => {
			const cases = gate.executorQa!.adversarialCases as Array<Record<string, unknown>>;
			delete cases[0]!.verdict;
			cases[0]!.result = "failed";
		});

		const surfaceError = await expectRejectedCompleteGate(root, created, failedSurfaceVerdict);
		const adversarialError = await expectRejectedCompleteGate(root, created, failedAdversarialResult);

		expect(surfaceError).toContain("executorQa.surfaceEvidence[0].status");
		expect(adversarialError).toContain("executorQa.adversarialCases[0].status");
	});

	it("rejects contradictory passed status with failed executor QA outcomes", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const passedStatusFailedSurface = mutateQualityGate(gate => {
			const surfaceEvidence = gate.executorQa!.surfaceEvidence as Array<Record<string, unknown>>;
			surfaceEvidence[0]!.status = "passed";
			surfaceEvidence[0]!.verdict = "failed";
		});
		const passedStatusFailedAdversarial = mutateQualityGate(gate => {
			const cases = gate.executorQa!.adversarialCases as Array<Record<string, unknown>>;
			cases[0]!.status = "passed";
			cases[0]!.result = "failed";
		});

		const surfaceError = await expectRejectedCompleteGate(root, created, passedStatusFailedSurface);
		const adversarialError = await expectRejectedCompleteGate(root, created, passedStatusFailedAdversarial);

		expect(surfaceError).toContain("executorQa.surfaceEvidence[0].status");
		expect(adversarialError).toContain("executorQa.adversarialCases[0].status");
	});

	it("rejects covered contracts linked only to not-applicable surface evidence", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const notApplicableOnlyProof = mutateQualityGate(gate => {
			const surfaceEvidence = gate.executorQa!.surfaceEvidence as Array<Record<string, unknown>>;
			surfaceEvidence[0] = {
				id: "surface-gui",
				contractRef: "approved-plan:goal",
				status: "not_applicable",
				reason: "GUI is not part of this story",
			};
			const coverage = gate.executorQa!.contractCoverage as Array<Record<string, unknown>>;
			delete coverage[0]!.adversarialCaseRefs;
		});

		const coverageError = await expectRejectedCompleteGate(root, created, notApplicableOnlyProof);

		expect(coverageError).toContain("executorQa.contractCoverage[0].surfaceEvidenceRefs.surface-gui.status");
	});

	it("requires a fresh goal get snapshot for complete checkpoints", async () => {
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

	it("rejects unrelated or stale goal get snapshots before mutation", async () => {
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
				"legacy completed GJC goal blocks goal create in this thread",
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

	it("requires review blockers to include a fresh active goal get snapshot", async () => {
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
