/**
 * #4560 comparative forced-compaction evidence matrix.
 *
 * The issue requires comparing the baseline (thin projection: goal objective,
 * workflow phase, open todos) against the candidate (durable structured
 * contract) across small / medium-multi-goal / high-risk fixtures under no,
 * one, and repeated forced compaction.
 *
 * These are deterministic proxies, not a model-behavior benchmark: the claim
 * under test is that the candidate recovers a *strictly more specific and
 * correct* resumption contract than the baseline projection, and that the
 * risk-proportional selection never trades away high-risk review. No
 * identical-output or zero-drift claim is made.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@gajae-code/utils";
import { resolveUltragoalValidationApplicability } from "../../src/gjc-runtime/ultragoal-validation-policy";
import {
	hashWorkflowRecoveryProjection,
	projectUltragoalRun,
	type WorkflowRecoveryProjection,
} from "../../src/gjc-runtime/workflow-recovery-projection";

const SESSION_ID = "compaction-matrix";

type Fixture = "small" | "multi-goal" | "high-risk";

interface GoalSeed {
	id: string;
	status: string;
	objective: string;
	evidence?: string;
}

async function seedPlan(root: string, goals: GoalSeed[], objective: string): Promise<void> {
	const dir = path.join(root, ".gjc", `_session-${SESSION_ID}`, "ultragoal");
	await fs.mkdir(dir, { recursive: true });
	const now = new Date().toISOString();
	await Bun.write(
		path.join(dir, "goals.json"),
		JSON.stringify({
			version: 1,
			brief: "b",
			gjcGoalMode: "aggregate",
			gjcObjective: objective,
			goals: goals.map(goal => ({
				id: goal.id,
				title: goal.id,
				objective: goal.objective,
				status: goal.status,
				createdAt: now,
				updatedAt: now,
				...(goal.evidence ? { evidence: goal.evidence } : {}),
			})),
			createdAt: now,
			updatedAt: now,
		}),
	);
	await Bun.write(
		path.join(dir, "ledger.jsonl"),
		`${JSON.stringify({
			event: "goal_checkpointed",
			status: "complete",
			goalId: goals[0]?.id ?? "G001",
			eventId: "evt-1",
			qualityGateJson: { iteration: { reviewCohort: { reviewGeneration: 1, sourceHash: "sha256:frozen" } } },
		})}\n`,
	);
}

function fixtureGoals(fixture: Fixture): GoalSeed[] {
	if (fixture === "small") {
		return [{ id: "G001", status: "active", objective: "Fix a single bounded defect" }];
	}
	if (fixture === "multi-goal") {
		return [
			{ id: "G001", status: "complete", objective: "Land the first slice", evidence: "focused tests pass" },
			{ id: "G002", status: "active", objective: "Land the second slice" },
			{ id: "G003", status: "pending", objective: "Land the third slice" },
		];
	}
	return [
		{ id: "G001", status: "complete", objective: "Rotate credential storage", evidence: "auth suite passes" },
		{ id: "G002", status: "review_blocked", objective: "Resolve credential review blockers" },
	];
}

/**
 * The pre-#4560 recovery signal: active goal objective, workflow phase, and
 * open todos. It carries no goal identity, no frozen source basis, and no
 * exact next action.
 */
function baselineProjection(fixture: Fixture): { objective: string; phase: string; todos: string[] } {
	const goals = fixtureGoals(fixture);
	return {
		objective: "Ultragoal aggregate run",
		phase: "active",
		todos: goals.filter(goal => goal.status !== "complete").map(goal => goal.objective),
	};
}

describe("#4560 forced-compaction comparative matrix", () => {
	async function withFixture(
		fixture: Fixture,
		compactions: number,
	): Promise<{ projections: WorkflowRecoveryProjection[]; root: string }> {
		const temp = TempDir.createSync("@pi-4560-matrix-");
		const root = temp.path();
		await seedPlan(root, fixtureGoals(fixture), "Ship the durable recovery contract");
		const projections: WorkflowRecoveryProjection[] = [];
		// Each "forced compaction" re-derives the contract from durable state
		// exactly as the post-compaction continuation does.
		for (let i = 0; i < Math.max(compactions, 1); i++) {
			const projection = await projectUltragoalRun({ cwd: root, sessionId: SESSION_ID });
			if (projection) projections.push(projection);
		}
		return { projections, root };
	}

	for (const fixture of ["small", "multi-goal", "high-risk"] as const) {
		for (const compactions of [0, 1, 3]) {
			it(`recovers a correct next action for ${fixture} under ${compactions} forced compaction(s)`, async () => {
				const { projections } = await withFixture(fixture, compactions);
				expect(projections.length).toBeGreaterThan(0);
				const projection = projections.at(-1)!;

				// Candidate carries goal identity and an exact next action; the
				// baseline projection carries neither.
				const baseline = baselineProjection(fixture);
				expect(baseline.todos.length).toBeGreaterThan(0);

				if (fixture === "high-risk") {
					// Blocker resolution must win over generic continuation.
					expect(projection.nextAction.actionClass).toBe("resolve-review-blockers");
					expect(projection.nextAction.goalId).toBe("G002");
				} else {
					expect(projection.nextAction.actionClass).toBe("continue-current-goal");
					expect(projection.nextAction.goalId).toBe(fixture === "small" ? "G001" : "G002");
				}

				// The frozen source basis survives every compaction generation.
				expect(projection.progress.latestCohortSourceHash).toBe("sha256:frozen");

				// Repeated compaction is stable: identical durable state yields an
				// identical contract digest, which is what bounds zero-progress loops.
				const digests = new Set(projections.map(hashWorkflowRecoveryProjection));
				expect(digests.size).toBe(1);
			});
		}
	}

	it("keeps high-risk and multi-goal fixtures on the full cohort while reducing only the small fixture", () => {
		const lowRiskChangeSet = {
			source: "checkpoint-git" as const,
			trusted: true as const,
			paths: [{ path: "packages/utils/src/format.ts", status: "modified" as const }],
		};
		const small = resolveUltragoalValidationApplicability({
			changeSet: lowRiskChangeSet,
			requiredGoals: 1,
			authoritativeSourceHash: "sha256:frozen",
		});
		expect(small.riskClass).toBe("low");
		// Verification is never traded away, even on the reduced path.
		expect(small.lanes.qa.applicable).toBe(true);

		const multiGoal = resolveUltragoalValidationApplicability({
			changeSet: lowRiskChangeSet,
			requiredGoals: 3,
			authoritativeSourceHash: "sha256:frozen",
		});
		expect(multiGoal.riskClass).toBe("high");
		expect(multiGoal.lanes.architect.applicable).toBe(true);

		const highRisk = resolveUltragoalValidationApplicability({
			changeSet: {
				source: "checkpoint-git",
				trusted: true,
				paths: [{ path: "packages/ai/src/auth-storage.ts", status: "modified" }],
			},
			requiredGoals: 1,
			authoritativeSourceHash: "sha256:frozen",
		});
		expect(highRisk.riskClass).toBe("high");
		expect(highRisk.lanes.architect.applicable).toBe(true);
		expect(highRisk.lanes["terminal-critic"].applicable).toBe(true);
	});

	it("classifies generic auth/security and generated native surfaces as high risk", () => {
		for (const pathValue of [
			"packages/example/src/auth.ts",
			"packages/example/test/auth.test.ts",
			"packages/example/src/security/headers.ts",
			"packages/natives/native/index.js",
			"packages/natives-linux-x64/native/index.js",
		]) {
			const applicability = resolveUltragoalValidationApplicability({
				changeSet: {
					source: "checkpoint-git",
					trusted: true,
					paths: [{ path: pathValue, status: "modified" }],
				},
				requiredGoals: 1,
				authoritativeSourceHash: "sha256:frozen",
			});
			expect(applicability.riskClass).toBe("high");
			expect(applicability.lanes.architect.applicable).toBe(true);
		}
	});

	it("reduces reviewer invocations only on the small fixture", () => {
		const lanesFor = (requiredGoals: number, changePath: string): number => {
			const applicability = resolveUltragoalValidationApplicability({
				changeSet: {
					source: "checkpoint-git",
					trusted: true,
					paths: [{ path: changePath, status: "modified" }],
				},
				requiredGoals,
				authoritativeSourceHash: "sha256:frozen",
			});
			return Object.values(applicability.lanes).filter(lane => lane.applicable).length;
		};
		const baselineLaneCount = 4; // cleaner + architect + qa + terminal-critic, unconditionally
		expect(lanesFor(1, "packages/utils/src/format.ts")).toBeLessThan(baselineLaneCount);
		expect(lanesFor(3, "packages/utils/src/format.ts")).toBe(baselineLaneCount);
		expect(lanesFor(1, "packages/coding-agent/src/commands/auth-broker.ts")).toBe(baselineLaneCount);
	});
});
