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
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@gajae-code/utils";
import { projectStateRoot } from "../../src/gjc-runtime/session-layout";
import { resolveUltragoalValidationApplicability } from "../../src/gjc-runtime/ultragoal-validation-policy";
import {
	hashWorkflowRecoveryProjection,
	projectRalplanFinalRun,
	projectRalplanRun,
	projectUltragoalRun,
	type WorkflowRecoveryProjection,
} from "../../src/gjc-runtime/workflow-recovery-projection";

const SESSION_ID = "compaction-matrix";

function ralplanRunDir(cwd: string, runId: string): string {
	return path.join(projectStateRoot(cwd), `_session-${SESSION_ID}`, "plans", "ralplan", runId);
}

function ultragoalDir(cwd: string): string {
	return path.join(projectStateRoot(cwd), `_session-${SESSION_ID}`, "ultragoal");
}

const FINAL_PLAN = `Fix widget parser performance regression.

## Decision
Use bounded lookahead instead of full-buffer regex.

## Accepted Scope
- parser/lookahead.ts
- parser/bench fixture

## Non-Goals
- Rewriting the tokenizer
- CLI flag changes

## Acceptance Criteria
- bun test parser suite passes
- P95 parse latency improves
`;

type Fixture = "small" | "multi-goal" | "high-risk";

interface GoalSeed {
	id: string;
	status: string;
	objective: string;
	evidence?: string;
}

async function seedPlan(root: string, goals: GoalSeed[], objective: string): Promise<void> {
	const dir = path.join(projectStateRoot(root), `_session-${SESSION_ID}`, "ultragoal");
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

/**
 * Window-specific forced-compaction coverage: each test replays one review or
 * execution window in which compaction can strike and asserts the recovered
 * contract is exactly what durable state justifies — never partial, in-flight
 * evidence.
 */
describe("#4560 forced-compaction window coverage", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-4560-matrix-");
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	async function projectUltragoalNTimes(count: number): Promise<WorkflowRecoveryProjection[]> {
		const projections: WorkflowRecoveryProjection[] = [];
		// Each "forced compaction" re-derives the contract from durable state
		// exactly as the post-compaction continuation does.
		for (let i = 0; i < count; i++) {
			const projection = await projectUltragoalRun({ cwd: tempDir.path(), sessionId: SESSION_ID });
			if (projection) projections.push(projection);
		}
		return projections;
	}

	it("recovers only the joined review generation after forced compaction during parallel boundary cohort review", async () => {
		await seedPlan(
			tempDir.path(),
			[
				{ id: "G001", status: "complete", objective: "Join the boundary cohort", evidence: "cohort joined" },
				{ id: "G002", status: "active", objective: "Land the next slice" },
			],
			"Ship the durable recovery contract",
		);
		// Replay the boundary window on top of seedPlan's joined generation: an
		// in-flight generation that claims newer cohort evidence, then a complete
		// checkpoint that carries no cohort record at all.
		await Bun.write(
			path.join(ultragoalDir(tempDir.path()), "ledger.jsonl"),
			[
				JSON.stringify({
					event: "goal_checkpointed",
					status: "complete",
					goalId: "G001",
					eventId: "evt-join",
					qualityGateJson: { iteration: { reviewCohort: { reviewGeneration: 1, sourceHash: "sha256:frozen" } } },
				}),
				JSON.stringify({
					event: "goal_checkpointed",
					status: "reviewing",
					goalId: "G002",
					eventId: "evt-inflight",
					qualityGateJson: { iteration: { reviewCohort: { reviewGeneration: 9, sourceHash: "sha256:partial" } } },
				}),
				JSON.stringify({ event: "goal_checkpointed", status: "complete", goalId: "G001", eventId: "evt-nocohort" }),
			]
				.map(line => `${line}\n`)
				.join(""),
		);

		const projections = await projectUltragoalNTimes(3);
		expect(projections.length).toBe(3);
		for (const projection of projections) {
			// Only the older JOINED generation survives re-projection: in-flight
			// and cohort-less checkpoints never fabricate review evidence.
			expect(projection.progress.latestReviewGeneration).toBe(1);
			expect(projection.progress.latestCohortSourceHash).toBe("sha256:frozen");
			expect(projection.progress.latestLedgerEventId).not.toBe("evt-inflight");
			// The next action stays safe: rerun the boundary generation instead of
			// trusting the partial review.
			expect(projection.nextAction).toMatchObject({ actionClass: "continue-current-goal", goalId: "G002" });
			expect(projection.currentGoal).toMatchObject({ goalId: "G002", status: "active" });
		}
		expect(new Set(projections.map(hashWorkflowRecoveryProjection)).size).toBe(1);
	});

	it("recovers identical executor state under repeated forced compaction during parallel executor work", async () => {
		await seedPlan(tempDir.path(), fixtureGoals("multi-goal"), "Ship the durable recovery contract");
		const projections = await projectUltragoalNTimes(3);
		expect(projections.length).toBe(3);
		for (const projection of projections) {
			// The single active goal stays the executor's current goal and the
			// pending goal stays queued behind it across every re-derivation.
			expect(projection.currentGoal).toEqual({
				goalId: "G002",
				status: "active",
				objective: "Land the second slice",
			});
			expect(projection.progress).toMatchObject({ totalGoals: 3, completedGoals: 1, outstandingGoals: 2 });
			expect(projection.nextAction).toEqual({
				actionClass: "continue-current-goal",
				goalId: "G002",
				detail: "Land the second slice",
			});
		}
		expect(new Set(projections.map(hashWorkflowRecoveryProjection)).size).toBe(1);
		expect(new Set(projections.map(projection => projection.zeroProgress.fingerprint)).size).toBe(1);
	});

	it("recovers the blocker-fix to re-review handoff after forced compaction", async () => {
		const root = tempDir.path();
		const blockedObjective = "Resolve credential review blockers";
		await seedPlan(root, [{ id: "G001", status: "review_blocked", objective: blockedObjective }], "Ship recovery");
		const blocked = await projectUltragoalRun({ cwd: root, sessionId: SESSION_ID });
		expect(blocked).toBeDefined();
		expect(blocked?.nextAction).toMatchObject({ actionClass: "resolve-review-blockers", goalId: "G001" });
		expect(blocked?.unresolved).toContain("review blockers open on G001");
		const blockedDigest = hashWorkflowRecoveryProjection(blocked!);

		// Blocker fixed: only durable state is rewritten (via seedPlan), so the
		// next compaction must move the contract off resolve-review-blockers.
		await seedPlan(root, [{ id: "G001", status: "active", objective: blockedObjective }], "Ship recovery");
		const cleared = await projectUltragoalRun({ cwd: root, sessionId: SESSION_ID });
		expect(cleared).toBeDefined();
		expect(cleared?.nextAction).toMatchObject({ actionClass: "continue-current-goal", goalId: "G001" });
		expect(cleared?.unresolved).not.toContain("review blockers open on G001");
		expect(hashWorkflowRecoveryProjection(cleared!)).not.toBe(blockedDigest);
		expect(cleared?.zeroProgress.fingerprint).not.toBe(blocked?.zeroProgress.fingerprint);

		// Fix lands durably: the next pending goal becomes the exact resumption
		// target, stably across further forced compactions.
		await seedPlan(
			root,
			[
				{ id: "G001", status: "complete", objective: blockedObjective, evidence: "blocker fix verified" },
				{ id: "G002", status: "pending", objective: "Land the follow-up slice" },
			],
			"Ship recovery",
		);
		const landed = await projectUltragoalNTimes(3);
		expect(landed.length).toBe(3);
		for (const projection of landed) {
			expect(projection.nextAction).toMatchObject({ actionClass: "start-next-goal", goalId: "G002" });
		}
		expect(new Set(landed.map(hashWorkflowRecoveryProjection)).size).toBe(1);
		expect(hashWorkflowRecoveryProjection(landed[0]!)).not.toBe(blockedDigest);
	});

	it("recovers a stable ralplan contract across forced compaction during ralplan review", async () => {
		const digest = crypto.createHash("sha256").update(FINAL_PLAN).digest("hex");

		// Final-stage window: objective, scope, and acceptance criteria re-project
		// identically no matter how many times compaction strikes.
		await Bun.write(path.join(ralplanRunDir(tempDir.path(), "final-run"), "stage-02-final.md"), FINAL_PLAN);
		await Bun.write(
			path.join(ralplanRunDir(tempDir.path(), "final-run"), "index.jsonl"),
			`${JSON.stringify({ stage: "planner", stage_n: 1, path: "stage-01-planner.md", sha256: "aa" })}\n${JSON.stringify({ stage: "final", stage_n: 2, path: "stage-02-final.md", sha256: digest })}\n`,
		);
		const finals: WorkflowRecoveryProjection[] = [];
		for (let i = 0; i < 3; i++) {
			const projection = await projectRalplanFinalRun({
				cwd: tempDir.path(),
				sessionId: SESSION_ID,
				runId: "final-run",
			});
			if (projection) finals.push(projection);
		}
		expect(finals.length).toBe(3);
		for (const projection of finals) {
			expect(projection.skill).toBe("ralplan");
			expect(projection.source).toBe("ralplan-final");
			expect(projection.objective).toContain("widget parser");
			expect(projection.scope.some(item => item.kind === "accepted" && item.text.includes("lookahead"))).toBe(true);
			expect(projection.scope.some(item => item.kind === "non_goal" && item.text.includes("tokenizer"))).toBe(true);
			expect(projection.acceptanceCriteria.some(text => text.includes("parser suite"))).toBe(true);
			expect(projection.nextAction.actionClass).toBe("awaiting-approval");
		}
		expect(new Set(finals.map(hashWorkflowRecoveryProjection)).size).toBe(1);
		expect(new Set(finals.map(projection => projection.zeroProgress.fingerprint)).size).toBe(1);

		// Mid-review window: a planner-only run reruns intent reconciliation on
		// every re-projection instead of trusting the un-reviewed draft.
		await Bun.write(path.join(ralplanRunDir(tempDir.path(), "planner-run"), "stage-01-planner.md"), FINAL_PLAN);
		await Bun.write(
			path.join(ralplanRunDir(tempDir.path(), "planner-run"), "index.jsonl"),
			`${JSON.stringify({ stage: "planner", stage_n: 1, path: "stage-01-planner.md", sha256: digest })}\n`,
		);
		const mids: WorkflowRecoveryProjection[] = [];
		for (let i = 0; i < 3; i++) {
			const projection = await projectRalplanRun({
				cwd: tempDir.path(),
				sessionId: SESSION_ID,
				runId: "planner-run",
			});
			if (projection) mids.push(projection);
		}
		expect(mids.length).toBe(3);
		for (const projection of mids) {
			expect(projection.source).toBe("ralplan-run");
			expect(projection.objective).toContain("widget parser");
			expect(projection.scope.some(item => item.kind === "accepted" && item.text.includes("lookahead"))).toBe(true);
			expect(projection.acceptanceCriteria.some(text => text.includes("parser suite"))).toBe(true);
			expect(projection.nextAction).toEqual({
				actionClass: "reconcile-intent",
				detail: "planner-without-intent-receipt",
			});
		}
		expect(new Set(mids.map(hashWorkflowRecoveryProjection)).size).toBe(1);
		// The two windows stay distinct contracts under the shared digest.
		expect(hashWorkflowRecoveryProjection(finals[0]!)).not.toBe(hashWorkflowRecoveryProjection(mids[0]!));
	});
});
