import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
	aggregateObjectiveMatches,
	DEFAULT_ULTRAGOAL_OBJECTIVE,
} from "@gajae-code/coding-agent/gjc-runtime/goal-mode-request";
import { readUltragoalAggregateGoalInvariant } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-guard";
import { sessionUltragoalDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";

const TEST_SESSION_ID = "test-reconcile-session";
const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-reconcile-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function writePlan(
	root: string,
	objective: string,
	goals: { id: string; objective: string; status: string }[],
	options: { aliases?: string[]; briefContent?: string } = {},
): Promise<{ goalsPath: string; briefPath: string; briefHash: string }> {
	const dir = sessionUltragoalDir(root, TEST_SESSION_ID);
	const goalsPath = path.join(dir, "goals.json");
	const briefPath = path.join(dir, "brief.md");
	await fs.mkdir(dir, { recursive: true });
	const briefContent = options.briefContent ?? "Default brief content\n";
	await Bun.write(briefPath, briefContent);
	const plan: Record<string, unknown> = {
		version: 1,
		brief: briefContent,
		gjcGoalMode: "aggregate",
		gjcObjective: objective,
		goals,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	if (options.aliases) plan.gjcObjectiveAliases = options.aliases;
	await Bun.write(goalsPath, JSON.stringify(plan));
	const briefHash = createHash("sha256").update(briefContent).digest("hex");
	return { goalsPath, briefPath, briefHash };
}

describe("readUltragoalAggregateGoalInvariant", () => {
	it("returns inactive when no current goal", async () => {
		const root = await tempDir();
		const result = await readUltragoalAggregateGoalInvariant({
			cwd: root,
			currentGoal: null,
			sessionId: TEST_SESSION_ID,
		});
		expect(result.state).toBe("inactive");
	});

	it("returns matching_aggregate when objective matches plan", async () => {
		const root = await tempDir();
		await writePlan(root, "Complete the plan", [
			{ id: "G001", objective: "Do thing", status: "active" },
		]);

		const result = await readUltragoalAggregateGoalInvariant({
			cwd: root,
			currentGoal: { objective: "Complete the plan", status: "active" },
			sessionId: TEST_SESSION_ID,
		});
		expect(result.state).toBe("matching_aggregate");
	});

	it("returns matching_aggregate when objective matches via alias", async () => {
		const root = await tempDir();
		await writePlan(root, "New objective", [
			{ id: "G001", objective: "Do thing", status: "active" },
		], { aliases: ["Legacy objective"] });

		const result = await readUltragoalAggregateGoalInvariant({
			cwd: root,
			currentGoal: { objective: "Legacy objective", status: "active" },
			sessionId: TEST_SESSION_ID,
		});
		expect(result.state).toBe("matching_aggregate");
	});

	it("returns matching_aggregate when objective is DEFAULT_ULTRAGOAL_OBJECTIVE", async () => {
		const root = await tempDir();
		await writePlan(root, "Specific objective", [
			{ id: "G001", objective: "Do thing", status: "active" },
		]);

		const result = await readUltragoalAggregateGoalInvariant({
			cwd: root,
			currentGoal: { objective: DEFAULT_ULTRAGOAL_OBJECTIVE, status: "active" },
			sessionId: TEST_SESSION_ID,
		});
		expect(result.state).toBe("matching_aggregate");
	});

	it("returns mismatched_active_goal when objective differs from plan", async () => {
		const root = await tempDir();
		await writePlan(root, "Complete the plan", [
			{ id: "G001", objective: "Do thing", status: "active" },
		]);

		const result = await readUltragoalAggregateGoalInvariant({
			cwd: root,
			currentGoal: { objective: "Some other goal", status: "active" },
			sessionId: TEST_SESSION_ID,
		});
		expect(result.state).toBe("mismatched_active_goal");
	});

	it("returns stale_completed_plan when plan is complete but goal lacks briefHash", async () => {
		const root = await tempDir();
		await writePlan(root, "Complete the plan", [
			{ id: "G001", objective: "Do thing", status: "complete" },
			{ id: "G002", objective: "Do other", status: "complete" },
		]);

		const result = await readUltragoalAggregateGoalInvariant({
			cwd: root,
			currentGoal: { objective: "Complete the plan", status: "active" },
			sessionId: TEST_SESSION_ID,
		});
		expect(result.state).toBe("stale_completed_plan");
	});

	it("returns matching_aggregate when plan is complete and goal has matching briefHash", async () => {
		const root = await tempDir();
		const { briefHash } = await writePlan(root, "Complete the plan", [
			{ id: "G001", objective: "Do thing", status: "complete" },
			{ id: "G002", objective: "Do other", status: "complete" },
		]);

		const result = await readUltragoalAggregateGoalInvariant({
			cwd: root,
			currentGoal: {
				objective: "Complete the plan",
				status: "active",
				sourceBriefHash: briefHash,
			},
			sessionId: TEST_SESSION_ID,
		});
		expect(result.state).toBe("matching_aggregate");
	});

	it("returns stale_completed_plan when plan complete and goal briefHash differs", async () => {
		const root = await tempDir();
		await writePlan(root, "Complete the plan", [
			{ id: "G001", objective: "Do thing", status: "complete" },
		]);

		const result = await readUltragoalAggregateGoalInvariant({
			cwd: root,
			currentGoal: {
				objective: "Complete the plan",
				status: "active",
				sourceBriefHash: "different-hash-abc",
			},
			sessionId: TEST_SESSION_ID,
		});
		expect(result.state).toBe("stale_completed_plan");
	});

	it("returns missing_plan when objective looks ultragoal but no plan exists", async () => {
		const root = await tempDir();

		const result = await readUltragoalAggregateGoalInvariant({
			cwd: root,
			currentGoal: {
				objective: DEFAULT_ULTRAGOAL_OBJECTIVE,
				status: "active",
			},
			sessionId: TEST_SESSION_ID,
		});
		expect(result.state).toBe("missing_plan");
	});

	it("returns inactive when non-ultragoal objective and no plan exists", async () => {
		const root = await tempDir();

		const result = await readUltragoalAggregateGoalInvariant({
			cwd: root,
			currentGoal: { objective: "Just a regular goal", status: "active" },
			sessionId: TEST_SESSION_ID,
		});
		expect(result.state).toBe("inactive");
	});

	it("returns mismatched_active_goal when plan complete, goal lacks briefHash, and objective doesn't match", async () => {
		const root = await tempDir();
		await writePlan(root, "Complete the plan", [
			{ id: "G001", objective: "Do thing", status: "complete" },
		]);

		const result = await readUltragoalAggregateGoalInvariant({
			cwd: root,
			currentGoal: { objective: "Different goal entirely", status: "active" },
			sessionId: TEST_SESSION_ID,
		});
		expect(result.state).toBe("mismatched_active_goal");
	});
});

describe("aggregateObjectiveMatches (reconcile)", () => {
	it("returns true for exact match", () => {
		expect(aggregateObjectiveMatches("Objective A", "Objective A")).toBe(true);
	});

	it("returns true for default ultragoal objective regardless of plan objective", () => {
		expect(aggregateObjectiveMatches(DEFAULT_ULTRAGOAL_OBJECTIVE, "Anything else")).toBe(true);
	});

	it("returns true for alias match", () => {
		expect(aggregateObjectiveMatches("Alias 1", "Plan objective", ["Alias 1", "Alias 2"])).toBe(true);
	});

	it("returns false for no match", () => {
		expect(aggregateObjectiveMatches("Unrelated", "Plan objective", ["Alias 1"])).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(aggregateObjectiveMatches("", "Plan objective")).toBe(false);
	});

	it("returns false for whitespace-only string", () => {
		expect(aggregateObjectiveMatches("  ", "Plan objective")).toBe(false);
	});

	it("trims whitespace before comparing", () => {
		expect(aggregateObjectiveMatches("  Objective A  ", "Objective A")).toBe(true);
	});
});
