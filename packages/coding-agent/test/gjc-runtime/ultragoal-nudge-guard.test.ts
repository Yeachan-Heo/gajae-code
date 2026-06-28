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
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-guard";
import {
	countUltragoalNudges,
	createUltragoalPlan,
	getUltragoalStatus,
	readUltragoalLedger,
	readUltragoalPlan,
	recordUltragoalBlockerClassification,
	recordUltragoalNudgeIfBudgetRemaining,
	resolveUltragoalNudgeBudget,
	selectUltragoalNudgeTarget,
	type UltragoalNudgeSurface,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";
import { assertUltragoalAskAllowed } from "@gajae-code/coding-agent/tools/ultragoal-ask-guard";

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
	await fs.writeFile(path.join(gjcDir, "settings.json"), JSON.stringify({ "gjc.ultragoal.nudgeBudget": budget }));
}

const SINGLE_BRIEF = "Implement the story";
const MULTI_BRIEF =
	"Shared context.\n\n@goal: First story\nDo the first thing.\n\n@goal: Second story\nDo the second thing.";
const DEFAULT_OBJECTIVE_GOAL = {
	objective: DEFAULT_ULTRAGOAL_OBJECTIVE,
	status: "active",
};

afterEach(async () => {
	if (ORIGINAL_GJC_SESSION_ID === undefined) delete process.env.GJC_SESSION_ID;
	else process.env.GJC_SESSION_ID = ORIGINAL_GJC_SESSION_ID;
	if (ORIGINAL_GJC_CONFIG_DIR === undefined) delete process.env.GJC_CONFIG_DIR;
	else process.env.GJC_CONFIG_DIR = ORIGINAL_GJC_CONFIG_DIR;
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("ultragoal nudge guard", () => {
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
		await recordUltragoalBlockerClassification({
			cwd,
			classification: "human_blocked",
			evidence: "User must provide production API credentials",
		});
		// Budget 1: first pause attempt is nudged even though the blocker is human_blocked.
		await expect(assertUltragoalPauseAllowed(cwd)).rejects.toThrow(/try-harder nudge \(1\/1\)/);
		// Re-record human_blocked as the latest event, then exhausted budget falls back to today's allowance.
		await recordUltragoalBlockerClassification({
			cwd,
			classification: "human_blocked",
			evidence: "User must provide production API credentials",
		});
		await expect(assertUltragoalPauseAllowed(cwd)).resolves.toBeUndefined();
	});

	// AC2: after the budget is spent, pause falls back to today's gate (blocked, no infinite loop).
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
		).rejects.toThrow(
			/strict `gjc ultragoal checkpoint --status complete --quality-gate-json <file> --gjc-goal-json <file>`/,
		);
		const ledger = await readUltragoalLedger(cwd, TEST_SESSION_ID);
		expect(ledger.filter(event => event.event === "nudge" && event.surface === "premature_complete").length).toBe(1);
	});

	// AC1 (ask): the ask assert is refused with a nudge while budget remains.
	it("AC1: ask is nudged while budget remains, then falls back to the ask block", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await setProjectBudget(cwd, 1);
		await createUltragoalPlan({ cwd, brief: SINGLE_BRIEF });
		await expect(assertUltragoalAskAllowed(cwd)).rejects.toThrow(/try-harder nudge/);
		await expect(assertUltragoalAskAllowed(cwd)).rejects.toThrow(/record-review-blockers/);
		const ledger = await readUltragoalLedger(cwd, TEST_SESSION_ID);
		const askNudges = ledger.filter(event => event.event === "nudge" && event.surface === "ask");
		expect(askNudges.length).toBe(1);
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
	it("AC4: nudge budget default is 10 and project overrides user", async () => {
		const cwd = await tempDir();
		const defaultResolved = await resolveUltragoalNudgeBudget(cwd);
		expect(defaultResolved.budget).toBe(10);
		const userDir = await tempDir();
		await fs.mkdir(path.join(userDir, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(userDir, ".gjc", "settings.json"),
			JSON.stringify({ "gjc.ultragoal.nudgeBudget": 3 }),
		);
		process.env.GJC_CONFIG_DIR = path.join(userDir, ".gjc");
		expect((await resolveUltragoalNudgeBudget(cwd)).budget).toBe(3);
		await setProjectBudget(cwd, 7);
		expect((await resolveUltragoalNudgeBudget(cwd)).budget).toBe(7);
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
