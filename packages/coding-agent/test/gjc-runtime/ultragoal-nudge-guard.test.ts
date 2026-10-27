import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_ULTRAGOAL_OBJECTIVE } from "@gajae-code/coding-agent/gjc-runtime/goal-mode-request";
import {
	assertCanCompleteCurrentGoal,
	assertUltragoalDropAllowed,
	assertUltragoalPauseAllowed,
	formatUltragoalNudgeMessage,
	isUltragoalAskBlocked,
	isUltragoalBypassPrompt,
	isUltragoalPauseBlocked,
	readUltragoalVerificationState,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-guard";
import {
	countUltragoalNudges,
	createUltragoalPlan,
	getUltragoalRunCompletionState,
	getUltragoalStatus,
	readUltragoalLedger,
	readUltragoalPlan,
	recordUltragoalBlockerClassification,
	recordUltragoalCriticVerdict,
	recordUltragoalNudgeIfBudgetRemaining,
	resolveUltragoalNudgeBudget,
	selectUltragoalNudgeTarget,
	type UltragoalNudgeSurface,
	type UltragoalNudgeTarget,
	type UltragoalPlan,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";
import {
	ULTRAGOAL_SUCCESSION_FENCE_SCHEMA,
	ultragoalSuccessionFencePath,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-succession";
import { assertUltragoalAskAllowed } from "@gajae-code/coding-agent/tools/ultragoal-ask-guard";
import { YAML } from "bun";

const TEST_SESSION_ID = "ultragoal-nudge-guard-test-session";
const ORIGINAL_GJC_SESSION_ID = process.env.GJC_SESSION_ID;
const ORIGINAL_GJC_CONFIG_DIR = process.env.GJC_CONFIG_DIR;
const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-ultragoal-nudge-guard-"));
	tempRoots.push(dir);
	return dir;
}

async function setProjectBudget(cwd: string, budget: number): Promise<void> {
	const gjcDir = path.join(cwd, ".gjc");
	await fs.mkdir(gjcDir, { recursive: true });
	await fs.writeFile(
		path.join(gjcDir, "config.yml"),
		YAML.stringify({ gjc: { ultragoal: { nudgeBudget: budget } } }, null, 2),
	);
}

const SINGLE_BRIEF = "Implement the story";
const MULTI_BRIEF =
	"Shared context.\n\n@goal: First story\nDo the first thing.\n\n@goal: Second story\nDo the second thing.";
const DEFAULT_OBJECTIVE_GOAL = {
	objective: DEFAULT_ULTRAGOAL_OBJECTIVE,
	status: "active",
};
const NUDGE_TARGET_STATUSES = ["active", "pending", "failed"] as const;
const NUDGE_TARGET_STATUS_SET = new Set<string>(NUDGE_TARGET_STATUSES);
const GENERATED_GOAL_STATUSES = [
	"pending",
	"active",
	"complete",
	"failed",
	"blocked",
	"review_blocked",
	"superseded",
] as const;

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

/** Hand off `goalIds` to a successor run by planting the source's ownership fence on disk. */
async function plantFence(cwd: string, goalIds: string[]): Promise<void> {
	const fencePath = ultragoalSuccessionFencePath(cwd, TEST_SESSION_ID);
	await fs.mkdir(path.dirname(fencePath), { recursive: true });
	await Bun.write(
		fencePath,
		`${JSON.stringify({
			schema: ULTRAGOAL_SUCCESSION_FENCE_SCHEMA,
			operationId: "f".repeat(64),
			createdAt: new Date().toISOString(),
			sourceSessionId: TEST_SESSION_ID,
			sourceRepository: { schema: "gjc.repository_binding.v1", worktreeRoot: cwd, commonDir: null },
			targetRepository: {
				schema: "gjc.repository_binding.v1",
				worktreeRoot: path.join(cwd, "..", "elsewhere"),
				commonDir: null,
			},
			selectedGoalIds: goalIds,
			sourceArtifacts: { briefSha256: "", goalsSha256: "", ledgerSha256: "" },
			offerPath: path.join(cwd, "offer.json"),
			offerSha256: "0".repeat(64),
		})}\n`,
	);
}

afterEach(async () => {
	if (ORIGINAL_GJC_SESSION_ID === undefined) delete process.env.GJC_SESSION_ID;
	else process.env.GJC_SESSION_ID = ORIGINAL_GJC_SESSION_ID;
	if (ORIGINAL_GJC_CONFIG_DIR === undefined) delete process.env.GJC_CONFIG_DIR;
	else process.env.GJC_CONFIG_DIR = ORIGINAL_GJC_CONFIG_DIR;
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("selectUltragoalNudgeTarget seeded properties", () => {
	it("excludes fenced targets and preserves objective, status, and final-receipt priority", () => {
		const seed = 0x6807_2026;
		const random = mulberry32(seed);
		let sawStoryTarget = false;
		let sawFinalAggregateTarget = false;
		let sawObjectivePriority = false;
		let sawStatusPriority = false;

		for (let caseIndex = 0; caseIndex < 128; caseIndex += 1) {
			const forcedPriorityCase = caseIndex === 1 || caseIndex === 2 || caseIndex === 4;
			const goalCount = forcedPriorityCase ? 3 : 1 + Math.floor(random() * 5);
			const forcedStatuses =
				caseIndex === 0 || caseIndex === 3
					? Array.from({ length: goalCount }, () => "complete" as const)
					: caseIndex === 1 || caseIndex === 2
						? (["active", "pending", "failed"] as const)
						: caseIndex === 4
							? (["pending", "active", "failed"] as const)
							: undefined;
			const goals = Array.from({ length: goalCount }, (_, index) => ({
				id: `G${String(index + 1).padStart(3, "0")}`,
				title: `Generated goal ${index + 1}`,
				objective: `Generated objective ${index + 1}`,
				status:
					forcedStatuses?.[index] ??
					GENERATED_GOAL_STATUSES[Math.floor(random() * GENERATED_GOAL_STATUSES.length)] ??
					"pending",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			}));
			const plan: UltragoalPlan = {
				version: 1,
				brief: `Seeded generated plan ${caseIndex}`,
				gjcGoalMode: "aggregate",
				gjcObjective: DEFAULT_ULTRAGOAL_OBJECTIVE,
				goals,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			};
			const lastGoal = goals[goals.length - 1];
			const excludedGoalIds =
				caseIndex === 0 || caseIndex === 2 || caseIndex === 4
					? []
					: caseIndex === 1
						? [goals[0]?.id ?? ""]
						: caseIndex === 3
							? lastGoal
								? [lastGoal.id]
								: []
							: goals.filter(() => random() < 0.35).map(goal => goal.id);
			const excluded = new Set(excludedGoalIds);
			const currentGoalObjective =
				caseIndex === 2
					? `${goals[1]?.objective ?? ""} `
					: caseIndex === 1 || caseIndex === 4 || caseIndex === 0 || caseIndex === 3
						? undefined
						: random() < 0.5
							? goals[Math.floor(random() * goals.length)]?.objective
							: undefined;
			const retryFailed = caseIndex === 1 || caseIndex === 2 || caseIndex === 4 ? false : random() < 0.5;
			const target = selectUltragoalNudgeTarget(plan, {
				currentGoalObjective,
				retryFailed,
				excludedGoalIds,
			});

			expect(target === null || !excluded.has(target.goalId)).toBe(true);
			expect(selectUltragoalNudgeTarget(plan, { currentGoalObjective, retryFailed, excludedGoalIds: [] })).toEqual(
				selectUltragoalNudgeTarget(plan, { currentGoalObjective, retryFailed }),
			);

			const matchingObjectiveGoal = goals.find(
				goal =>
					goal.objective.trim() === currentGoalObjective?.trim() &&
					NUDGE_TARGET_STATUS_SET.has(goal.status) &&
					!excluded.has(goal.id),
			);
			const eligibleStatuses = retryFailed ? NUDGE_TARGET_STATUSES : NUDGE_TARGET_STATUSES.slice(0, 2);
			const firstEligibleStatus = eligibleStatuses.find(status =>
				goals.some(goal => goal.status === status && !excluded.has(goal.id)),
			);
			const firstEligibleGoal = firstEligibleStatus
				? goals.find(goal => goal.status === firstEligibleStatus && !excluded.has(goal.id))
				: undefined;
			let expected: UltragoalNudgeTarget | null = null;
			if (matchingObjectiveGoal) {
				expected = { goalId: matchingObjectiveGoal.id, targetKind: "story" };
				if (
					goals.some(
						goal => goal.status === "active" && goal.id !== matchingObjectiveGoal.id && !excluded.has(goal.id),
					)
				) {
					sawObjectivePriority = true;
				}
			} else if (firstEligibleGoal) {
				expected = { goalId: firstEligibleGoal.id, targetKind: "story" };
				if (
					firstEligibleStatus === "active" &&
					goals.some(goal => goal.status === "pending" && !excluded.has(goal.id))
				) {
					sawStatusPriority = true;
				}
			} else {
				const completion = getUltragoalRunCompletionState(plan, { retryFailed });
				const finalGoal = completion.needsFinalAggregateReceipt ? completion.requiredGoals.at(-1) : undefined;
				if (finalGoal && !excluded.has(finalGoal.id)) {
					expected = { goalId: finalGoal.id, targetKind: "final_aggregate_receipt" };
				}
			}
			expect(target).toEqual(expected);
			if (target?.targetKind === "story") sawStoryTarget = true;
			if (target?.targetKind === "final_aggregate_receipt") sawFinalAggregateTarget = true;
		}

		expect(sawStoryTarget).toBe(true);
		expect(sawFinalAggregateTarget).toBe(true);
		expect(sawObjectivePriority).toBe(true);
		expect(sawStatusPriority).toBe(true);
	});
});

describe("ultragoal nudge guard", () => {
	it("links a reworded goal to its ultragoal run through provenance", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: SINGLE_BRIEF });

		const diagnostic = await readUltragoalVerificationState({
			cwd,
			sessionId: TEST_SESSION_ID,
			currentGoal: {
				objective: "Reworded after plan creation",
				provenance: { source: "ultragoal", runId: TEST_SESSION_ID, goalId: "G001" },
			},
		});

		expect(diagnostic.state).toBe("active_missing_final_receipt");
	});

	it("preserves legacy objective matching when goal provenance is absent", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: SINGLE_BRIEF });

		const diagnostic = await readUltragoalVerificationState({
			cwd,
			sessionId: TEST_SESSION_ID,
			currentGoal: { objective: "Unrelated reworded objective" },
		});

		expect(diagnostic.state).toBe("unrelated_goal");
	});
	// AC5: the escalating refusal text must never trip the bypass detector.
	it("AC5: formatted nudge text never trips isUltragoalBypassPrompt for any surface", () => {
		const surfaces: UltragoalNudgeSurface[] = ["pause", "drop", "ask", "premature_complete"];
		for (const surface of surfaces) {
			const message = formatUltragoalNudgeMessage({ surface, attempt: 3, budget: 10, goalId: "G001" });
			expect(isUltragoalBypassPrompt(message)).toBe(false);
		}
	});

	// AC1 (pause) + one-row-per-attempt + correct surface despite the ask diagnostic dependency.
	it("AC1: pause is refused with an escalating nudge and appends exactly one surface=pause row", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: SINGLE_BRIEF });
		await expect(assertUltragoalPauseAllowed(cwd)).rejects.toThrow(/try-harder nudge \(1\/10\)/);
		const ledger = await readUltragoalLedger(cwd, TEST_SESSION_ID);
		const nudges = ledger.filter(event => event.event === "nudge");
		expect(nudges.length).toBe(1);
		expect(nudges[0]?.surface).toBe("pause");
		expect(nudges[0]?.goalId).toBe("G001");
		expect(nudges[0]?.attempt).toBe(1);
		// No ask row leaked through the pause assert's dependency on the ask diagnostic.
		expect(ledger.some(event => event.event === "nudge" && event.surface === "ask")).toBe(false);
	});

	// F6: a human_blocked classification is still nudged while budget remains; only
	// after exhaustion does the old human_blocked allowance let the pause through.
	it("AC1/F6: human_blocked pause is nudged while budget remains, then allowed after exhaustion", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await setProjectBudget(cwd, 1);
		await createUltragoalPlan({ cwd, brief: SINGLE_BRIEF });
		// Budget 1: the first pause attempt is nudged before the human-only blocker is classified.
		await expect(assertUltragoalPauseAllowed(cwd)).rejects.toThrow(/try-harder nudge \(1\/1\)/);
		const classification = await recordUltragoalBlockerClassification({
			cwd,
			classification: "human_blocked",
			evidence: "User must provide production API credentials",
		});
		await recordUltragoalCriticVerdict({
			cwd,
			terminus: "pause",
			verdict: "OKAY",
			evidence: "critic confirms the remaining blocker requires human action",
			classificationEventId: classification.eventId,
		});
		// The exhausted budget now falls back to the bound clean human-blocked allowance.
		await expect(assertUltragoalPauseAllowed(cwd)).resolves.toBeUndefined();
	});

	// AC2: after the budget is spent, pause falls back to today's gate (blocked, no infinite loop).
	// #6807: the nudge target was handed off, so the source has no resolvable work to be
	// nudged toward; the attempt goes straight to the normal gate and spends no budget.
	it("does not nudge a pause toward a goal handed off to a successor run", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: SINGLE_BRIEF });
		await plantFence(cwd, ["G001"]);

		await expect(assertUltragoalPauseAllowed(cwd)).rejects.toThrow(/human_blocked/);
		const ledger = await readUltragoalLedger(cwd, TEST_SESSION_ID);
		expect(ledger.filter(event => event.event === "nudge")).toEqual([]);

		const classification = await recordUltragoalBlockerClassification({
			cwd,
			classification: "human_blocked",
			evidence: "Committing the successor's initial tree needs owner authorization",
		});
		await recordUltragoalCriticVerdict({
			cwd,
			terminus: "pause",
			verdict: "OKAY",
			evidence: "critic confirms only the human-only authorization remains",
			classificationEventId: classification.eventId,
		});
		await expect(assertUltragoalPauseAllowed(cwd)).resolves.toBeUndefined();
	});

	it("still nudges toward a goal the source kept when another goal was handed off", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: MULTI_BRIEF });
		await plantFence(cwd, ["G002"]);

		await expect(assertUltragoalPauseAllowed(cwd)).rejects.toThrow(/try-harder nudge \(1\/10\) for G001/);
	});

	it("AC2: exhausted pause falls back to today's gate and appends no further nudges", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await setProjectBudget(cwd, 1);
		await createUltragoalPlan({ cwd, brief: SINGLE_BRIEF });
		await expect(assertUltragoalPauseAllowed(cwd)).rejects.toThrow(/try-harder nudge/);
		await expect(assertUltragoalPauseAllowed(cwd)).rejects.toThrow(/human_blocked/);
		const ledger = await readUltragoalLedger(cwd, TEST_SESSION_ID);
		expect(ledger.filter(event => event.event === "nudge").length).toBe(1);
	});

	// AC1 (premature complete): incomplete story is nudged before the strict completion gate.
	it("AC1: premature complete is nudged while budget remains", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: SINGLE_BRIEF });
		await expect(
			assertCanCompleteCurrentGoal({ cwd, currentGoal: DEFAULT_OBJECTIVE_GOAL, sessionId: TEST_SESSION_ID }),
		).rejects.toThrow(/try-harder nudge/);
		const ledger = await readUltragoalLedger(cwd, TEST_SESSION_ID);
		const nudges = ledger.filter(event => event.event === "nudge");
		expect(nudges.length).toBe(1);
		expect(nudges[0]?.surface).toBe("premature_complete");
	});

	// Adversarial: once the nudge budget is exhausted, premature completion must still hit the strict receipt gate.
	it("AC2: exhausted premature complete still requires a valid completion receipt", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await setProjectBudget(cwd, 1);
		await createUltragoalPlan({ cwd, brief: SINGLE_BRIEF });
		await expect(
			assertCanCompleteCurrentGoal({ cwd, currentGoal: DEFAULT_OBJECTIVE_GOAL, sessionId: TEST_SESSION_ID }),
		).rejects.toThrow(/try-harder nudge/);
		await expect(
			assertCanCompleteCurrentGoal({ cwd, currentGoal: DEFAULT_OBJECTIVE_GOAL, sessionId: TEST_SESSION_ID }),
		).rejects.toThrow(/`gjc ultragoal checkpoint --status complete --quality-gate-json <file>`/);
		const ledger = await readUltragoalLedger(cwd, TEST_SESSION_ID);
		expect(ledger.filter(event => event.event === "nudge" && event.surface === "premature_complete").length).toBe(1);
	});

	// AC1 (ask): the ask assert is refused with a nudge while budget remains.
	it("AC1: ask is nudged while budget remains, then falls back to the ask block", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await setProjectBudget(cwd, 1);
		await createUltragoalPlan({ cwd, brief: SINGLE_BRIEF });
		await expect(assertUltragoalAskAllowed(cwd, { sessionId: TEST_SESSION_ID })).rejects.toThrow(/try-harder nudge/);
		await expect(assertUltragoalAskAllowed(cwd, { sessionId: TEST_SESSION_ID })).rejects.toThrow(
			/record-review-blockers/,
		);
		const ledger = await readUltragoalLedger(cwd, TEST_SESSION_ID);
		const askNudges = ledger.filter(event => event.event === "nudge" && event.surface === "ask");
		expect(askNudges.length).toBe(1);
	});

	it("charges only the caller's ask budget when an unrelated environment session is active", async () => {
		const cwd = await tempDir();
		await setProjectBudget(cwd, 1);
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: SINGLE_BRIEF });
		const unrelatedSessionId = "unrelated-ultragoal-session";
		process.env.GJC_SESSION_ID = unrelatedSessionId;
		await createUltragoalPlan({ cwd, brief: "Implement the unrelated story" });
		const unrelatedLedger = await readUltragoalLedger(cwd, unrelatedSessionId);
		const context = { sessionId: ` ${TEST_SESSION_ID} ` };
		await expect(assertUltragoalAskAllowed(cwd, context)).rejects.toThrow(/try-harder nudge \(1\/1\)/);
		expect(await readUltragoalLedger(cwd, unrelatedSessionId)).toEqual(unrelatedLedger);
		await expect(assertUltragoalAskAllowed(cwd, context)).rejects.toThrow(/record-review-blockers/);
		const ledger = await readUltragoalLedger(cwd, TEST_SESSION_ID);
		const askNudges = ledger.filter(event => event.event === "nudge" && event.surface === "ask");
		expect(askNudges).toHaveLength(1);
		expect(askNudges[0]?.attempt).toBe(1);
		expect(await readUltragoalLedger(cwd, unrelatedSessionId)).toEqual(unrelatedLedger);
	});

	// An anonymous caller has no attributable run: the ask assert permits the ask
	// instead of charging a foreign session's nudge budget (issue #5465).
	it("permits an anonymous ask without charging an ambient session's nudge budget", async () => {
		const cwd = await tempDir();
		await setProjectBudget(cwd, 1);
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: SINGLE_BRIEF });
		const ledgerBefore = await readUltragoalLedger(cwd, TEST_SESSION_ID);
		for (const context of [undefined, {}, { sessionId: null }, { sessionId: "   " }]) {
			await expect(assertUltragoalAskAllowed(cwd, context ?? undefined)).resolves.toBeUndefined();
		}
		expect(await readUltragoalLedger(cwd, TEST_SESSION_ID)).toEqual(ledgerBefore);
	});

	// Session profile: the ask guard resolves the nudge budget from the
	// session agent directory (a tenant profile with nudgeBudget 0 is never
	// nudged) instead of the process-default profile.
	it("AC1: the session agent directory selects the nudge budget profile", async () => {
		const cwd = await tempDir();
		const tenantAgentDir = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: SINGLE_BRIEF });
		await fs.writeFile(
			path.join(tenantAgentDir, "config.yml"),
			YAML.stringify({ gjc: { ultragoal: { nudgeBudget: 0 } } }, null, 2),
		);
		// The tenant forbids nudges: the ask assert falls straight to the
		// block message and appends no nudge row.
		await expect(assertUltragoalAskAllowed(cwd, { sessionId: TEST_SESSION_ID }, tenantAgentDir)).rejects.toThrow();
		const ledger = await readUltragoalLedger(cwd, TEST_SESSION_ID);
		expect(ledger.filter(event => event.event === "nudge" && event.surface === "ask").length).toBe(0);
	});

	// AC1 (drop): a real give-up drop is nudged while budget remains.
	it("AC1/AC7: a real give-up drop is nudged but a legitimate reset drop is not", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: SINGLE_BRIEF });
		// Mid-run aggregate with an incomplete required story is a real give-up.
		await expect(
			assertUltragoalDropAllowed({ cwd, currentGoal: DEFAULT_OBJECTIVE_GOAL, sessionId: TEST_SESSION_ID }),
		).rejects.toThrow(/try-harder nudge/);
		// An unrelated active goal is a legitimate reset and is never nudged.
		await expect(
			assertUltragoalDropAllowed({
				cwd,
				currentGoal: { objective: "totally unrelated goal", status: "active" },
				sessionId: TEST_SESSION_ID,
			}),
		).resolves.toBeUndefined();
		// An already-dropped aggregate is a legitimate reset.
		await expect(
			assertUltragoalDropAllowed({
				cwd,
				currentGoal: { ...DEFAULT_OBJECTIVE_GOAL, status: "dropped" },
				sessionId: TEST_SESSION_ID,
			}),
		).resolves.toBeUndefined();
		// No current goal-mode goal (a no-op/reset before a fresh create) is never nudged,
		// even on an incomplete aggregate.
		await expect(
			assertUltragoalDropAllowed({ cwd, currentGoal: null, sessionId: TEST_SESSION_ID }),
		).resolves.toBeUndefined();
		// A non-active (e.g. paused) current goal is a reset, not a give-up.
		await expect(
			assertUltragoalDropAllowed({
				cwd,
				currentGoal: { ...DEFAULT_OBJECTIVE_GOAL, status: "paused" },
				sessionId: TEST_SESSION_ID,
			}),
		).resolves.toBeUndefined();
	});

	it("keeps aggregate drop guarded by nudging a retained goal when the first target was handed off", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await setProjectBudget(cwd, 1);
		await createUltragoalPlan({ cwd, brief: MULTI_BRIEF });
		await plantFence(cwd, ["G001"]);

		await expect(
			assertUltragoalDropAllowed({ cwd, currentGoal: DEFAULT_OBJECTIVE_GOAL, sessionId: TEST_SESSION_ID }),
		).rejects.toThrow(/try-harder nudge \(1\/1\) for G002/);
		const ledger = await readUltragoalLedger(cwd, TEST_SESSION_ID);
		const nudges = ledger.filter(event => event.event === "nudge");
		expect(nudges).toHaveLength(1);
		expect(nudges[0]).toMatchObject({ goalId: "G002", surface: "drop", attempt: 1 });

		const status = await getUltragoalStatus(cwd, TEST_SESSION_ID);
		expect(status).toMatchObject({ nudgeGoalId: "G002", nudgeCount: 1, nudgeRemaining: 0 });

		// The existing drop path remains available after the retained goal's budget is exhausted.
		await expect(
			assertUltragoalDropAllowed({ cwd, currentGoal: DEFAULT_OBJECTIVE_GOAL, sessionId: TEST_SESSION_ID }),
		).resolves.toBeUndefined();
		expect((await readUltragoalLedger(cwd, TEST_SESSION_ID)).filter(event => event.event === "nudge")).toHaveLength(
			1,
		);
	});

	it("allows aggregate drop when all unfinished stories were handed off", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: SINGLE_BRIEF });
		await plantFence(cwd, ["G001"]);

		await expect(
			assertUltragoalDropAllowed({ cwd, currentGoal: DEFAULT_OBJECTIVE_GOAL, sessionId: TEST_SESSION_ID }),
		).resolves.toBeUndefined();
		expect((await readUltragoalLedger(cwd, TEST_SESSION_ID)).filter(event => event.event === "nudge")).toEqual([]);
	});

	// AC7: an unreadable durable state cannot be classified, so the drop fails closed.
	it("AC7: drop classification fails closed when goals.json is corrupt", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: SINGLE_BRIEF });
		const { paths } = await getUltragoalStatus(cwd, TEST_SESSION_ID);
		await fs.writeFile(paths.goalsPath, "{ not valid json");
		await expect(
			assertUltragoalDropAllowed({ cwd, currentGoal: DEFAULT_OBJECTIVE_GOAL, sessionId: TEST_SESSION_ID }),
		).rejects.toThrow(/Unable to classify Ultragoal drop/);
	});

	// AC2: the atomic writer cannot overshoot the budget under concurrency.
	it("AC2: concurrent nudge attempts cannot overshoot a budget of 1", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: SINGLE_BRIEF });
		const target = { goalId: "G001", targetKind: "story" as const };
		const outcomes = await Promise.all(
			Array.from({ length: 6 }, () =>
				recordUltragoalNudgeIfBudgetRemaining({
					cwd,
					sessionId: TEST_SESSION_ID,
					target,
					surface: "pause",
					budget: 1,
					reason: "race",
				}),
			),
		);
		expect(outcomes.filter(outcome => outcome.nudged).length).toBe(1);
		const ledger = await readUltragoalLedger(cwd, TEST_SESSION_ID);
		expect(countUltragoalNudges(ledger, "G001")).toBe(1);
	});

	// AC3: counts are per-story and ledger-derived; a ledger reset zeroes them with no goals.json counter.
	it("AC3: per-story isolation and ledger-reset zeroing", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: MULTI_BRIEF, gjcGoalMode: "per-story" });
		await recordUltragoalNudgeIfBudgetRemaining({
			cwd,
			sessionId: TEST_SESSION_ID,
			target: { goalId: "G001", targetKind: "story" },
			surface: "pause",
			budget: 10,
			reason: "first",
		});
		await recordUltragoalNudgeIfBudgetRemaining({
			cwd,
			sessionId: TEST_SESSION_ID,
			target: { goalId: "G001", targetKind: "story" },
			surface: "pause",
			budget: 10,
			reason: "first-again",
		});
		await recordUltragoalNudgeIfBudgetRemaining({
			cwd,
			sessionId: TEST_SESSION_ID,
			target: { goalId: "G002", targetKind: "story" },
			surface: "drop",
			budget: 10,
			reason: "second",
		});
		const ledger = await readUltragoalLedger(cwd, TEST_SESSION_ID);
		expect(countUltragoalNudges(ledger, "G001")).toBe(2);
		expect(countUltragoalNudges(ledger, "G002")).toBe(1);
		// Reset the ledger: counts return to zero with no goals.json counter involved.
		const { paths } = await getUltragoalStatus(cwd, TEST_SESSION_ID);
		await fs.writeFile(paths.ledgerPath, "");
		const reset = await readUltragoalLedger(cwd, TEST_SESSION_ID);
		expect(countUltragoalNudges(reset, "G001")).toBe(0);
		expect(countUltragoalNudges(reset, "G002")).toBe(0);
		const goalsRaw = await fs.readFile(paths.goalsPath, "utf-8");
		expect(goalsRaw).not.toContain("nudgeCount");
	});

	// AC4: default budget is 10 and a project setting takes precedence over the user setting.
	//
	// The user-settings half runs in a child process. `GJC_CONFIG_DIR` is a config
	// root *dirname under home* (PR #3327), not a full path, and `getConfigRootDir()`
	// joins it onto `os.homedir()` — which an in-process test cannot redirect. Setting
	// it to an absolute path here silently resolved nothing and the assertion only
	// passed while the reader still treated the value as a full path.
	it("AC4: nudge budget default is 10 and project overrides user", async () => {
		const cwd = await tempDir();
		const defaultResolved = await resolveUltragoalNudgeBudget(cwd);
		expect(defaultResolved.budget).toBe(10);

		const home = await tempDir();
		await fs.mkdir(path.join(home, ".gjc", "agent"), { recursive: true });
		await fs.writeFile(
			path.join(home, ".gjc", "agent", "config.yml"),
			YAML.stringify({ gjc: { ultragoal: { nudgeBudget: 3 } } }, null, 2),
		);
		const probe = path.join(import.meta.dir, "..", "fixtures", "config-root-settings-probe.ts");
		const userOnly = Bun.spawn([process.execPath, probe], {
			cwd,
			env: {
				...process.env,
				HOME: home,
				GJC_CONFIG_DIR: ".gjc",
				GJC_CODING_AGENT_DIR: path.join(home, ".gjc", "agent"),
				PI_CODING_AGENT_DIR: path.join(home, ".gjc", "agent"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const userOut = await new Response(userOnly.stdout).text();
		expect(await userOnly.exited).toBe(0);
		expect(JSON.parse(userOut.trim()).ultragoal.budget).toBe(3);

		// A project setting still wins over that user setting.
		await setProjectBudget(cwd, 7);
		const projectWins = Bun.spawn([process.execPath, probe], {
			cwd,
			env: {
				...process.env,
				HOME: home,
				GJC_CONFIG_DIR: ".gjc",
				GJC_CODING_AGENT_DIR: path.join(home, ".gjc", "agent"),
				PI_CODING_AGENT_DIR: path.join(home, ".gjc", "agent"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const projectOut = await new Response(projectWins.stdout).text();
		expect(await projectWins.exited).toBe(0);
		expect(JSON.parse(projectOut.trim()).ultragoal.budget).toBe(7);
	});

	// AC4: budget 0 is an opt-out — the writer never appends and reports exhausted.
	it("AC4: budget 0 disables the pre-gate nudge", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: SINGLE_BRIEF });
		const outcome = await recordUltragoalNudgeIfBudgetRemaining({
			cwd,
			sessionId: TEST_SESSION_ID,
			target: { goalId: "G001", targetKind: "story" },
			surface: "pause",
			budget: 0,
			reason: "opt-out",
		});
		expect(outcome.nudged).toBe(false);
		const ledger = await readUltragoalLedger(cwd, TEST_SESSION_ID);
		expect(countUltragoalNudges(ledger, "G001")).toBe(0);
	});

	// AC6: status surfaces the same target/count the guard consumes.
	it("AC6: gjc ultragoal status reports the consumed nudge target and count", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: SINGLE_BRIEF });
		const plan = await readUltragoalPlan(cwd, TEST_SESSION_ID);
		expect(plan).not.toBeNull();
		const target = selectUltragoalNudgeTarget(plan!);
		expect(target?.goalId).toBe("G001");
		await assertUltragoalPauseAllowed(cwd).catch(() => undefined);
		const summary = await getUltragoalStatus(cwd, TEST_SESSION_ID);
		expect(summary.nudgeGoalId).toBe("G001");
		expect(summary.nudgeBudget).toBe(10);
		expect(summary.nudgeCount).toBe(1);
		expect(summary.nudgeRemaining).toBe(9);
		const ledger = await readUltragoalLedger(cwd, TEST_SESSION_ID);
		expect(summary.nudgeCount).toBe(countUltragoalNudges(ledger, "G001"));
	});

	// Pure diagnostics must never append a nudge row.
	it("read-style diagnostics do not append nudges", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: SINGLE_BRIEF });
		await isUltragoalPauseBlocked(cwd);
		await isUltragoalAskBlocked(cwd);
		await getUltragoalStatus(cwd, TEST_SESSION_ID);
		const ledger = await readUltragoalLedger(cwd, TEST_SESSION_ID);
		expect(ledger.some(event => event.event === "nudge")).toBe(false);
	});
});
