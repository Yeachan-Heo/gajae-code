import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { isUltragoalAskBlocked } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-guard";
import {
	computeUltragoalPlanGeneration,
	createUltragoalPlan,
	getUltragoalPaths,
	hashStructuredValue,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { AskTool } from "@gajae-code/coding-agent/tools/ask";
import { ToolError } from "@gajae-code/coding-agent/tools/tool-errors";
import { guardToolForUltragoalAsk } from "@gajae-code/coding-agent/tools/ultragoal-ask-guard";

const TEST_SESSION_ID = "ultragoal-ask-guard-test-session";
const ORIGINAL_GJC_SESSION_ID = process.env.GJC_SESSION_ID;
const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-ultragoal-ask-guard-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	if (ORIGINAL_GJC_SESSION_ID === undefined) delete process.env.GJC_SESSION_ID;
	else process.env.GJC_SESSION_ID = ORIGINAL_GJC_SESSION_ID;
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

function createContext(select: () => Promise<string | undefined>): AgentToolContext {
	return {
		hasUI: true,
		ui: {
			select: async () => select(),
			editor: async () => undefined,
		},
		abort: () => {},
	} as unknown as AgentToolContext;
}

function stubAskTool(execute: () => Promise<void>): AgentTool {
	return {
		name: "ask",
		label: "Ask",
		summary: "Ask",
		description: "Ask",
		parameters: {} as never,
		strict: true,
		execute: async () => {
			await execute();
			return { content: [{ type: "text", text: "asked" }], details: {} };
		},
	};
}

// Mirrors ExtensionToolWrapper: a prototype `execute` that reads instance state via
// `this`. A detached call (`const exec = tool.execute; exec()`) loses `this` and throws
// "undefined is not an object (evaluating 'this.runner')".
class StubExtensionWrappedAskTool {
	name = "ask";
	label = "Ask";
	summary = "Ask";
	description = "Ask";
	parameters = {} as never;
	strict = true;
	runner = { hasHandlers: () => false };
	executeArgs: unknown[] | null = null;
	async execute(...args: unknown[]): Promise<{ content: { type: "text"; text: string }[]; details: object }> {
		this.runner.hasHandlers();
		this.executeArgs = args;
		return { content: [{ type: "text", text: "asked" }], details: {} };
	}
}

describe("ultragoal ask guard", () => {
	it("allows ask when durable ultragoal state is absent without requiring ambient GJC_SESSION_ID", async () => {
		const cwd = await tempDir();
		const previousSessionId = process.env.GJC_SESSION_ID;
		delete process.env.GJC_SESSION_ID;
		try {
			const diagnostic = await isUltragoalAskBlocked(cwd);
			expect(diagnostic.active).toBe(false);
			expect(diagnostic.source).toBe("absent");
			expect(diagnostic.goalsPath).toBe(path.join(cwd, ".gjc", "ultragoal", "goals.json"));
		} finally {
			if (previousSessionId === undefined) delete process.env.GJC_SESSION_ID;
			else process.env.GJC_SESSION_ID = previousSessionId;
		}
	});

	it("blocks latest session-scoped ultragoal ask when GJC_SESSION_ID is absent", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		delete process.env.GJC_SESSION_ID;

		const diagnostic = await isUltragoalAskBlocked(cwd);

		expect(diagnostic.active).toBe(true);
		expect(diagnostic.source).toBe("goals_json");
		expect(diagnostic.goalsPath).toBe(getUltragoalPaths(cwd, TEST_SESSION_ID).goalsPath);
		expect(diagnostic.message).toContain("record-review-blockers");
	});

	it("blocks SDK-initial-path style wrapped ask while ultragoal is active", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		const execute = vi.fn(async () => {});
		const guarded = guardToolForUltragoalAsk(stubAskTool(execute), () => cwd);

		await expect(guarded.execute("call", {}, undefined, undefined, undefined as never)).rejects.toThrow(ToolError);
		await expect(guarded.execute("call", {}, undefined, undefined, undefined as never)).rejects.toThrow(
			/try-harder nudge/,
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("preserves `this` for a prototype-method ask tool when ultragoal is inactive (regression)", async () => {
		const cwd = await tempDir();
		const tool = new StubExtensionWrappedAskTool();
		const guarded = guardToolForUltragoalAsk(tool as unknown as AgentTool, () => cwd);

		// Must not throw "undefined is not an object (evaluating 'this.runner')".
		const result = await guarded.execute("call", { foo: 1 }, undefined, undefined, undefined as never);

		expect(result.content[0]).toMatchObject({ type: "text", text: "asked" });
		expect(tool.executeArgs).toEqual(["call", { foo: 1 }, undefined, undefined, undefined]);
	});

	it("blocks an unwrapped AskTool before prompting while ultragoal is active", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		const select = vi.fn(async () => "Yes");
		const tool = new AskTool(createSession(cwd));

		await expect(
			tool.execute(
				"call",
				{ questions: [{ id: "q", question: "Ask?", options: [{ label: "Yes" }] }] },
				undefined,
				undefined,
				createContext(select),
			),
		).rejects.toThrow(/try-harder nudge/);
		expect(select).not.toHaveBeenCalled();
	});

	it("allows ask when the ultragoal run is verified complete", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		const paths = getUltragoalPaths(cwd);
		const now = new Date().toISOString();
		const plan = JSON.parse(await fs.readFile(paths.goalsPath, "utf8"));
		plan.goals[0].status = "complete";
		plan.goals[0].updatedAt = now;
		plan.goals[0].completedAt = now;
		const eventId = "event-final";
		const qualityGateJson = {};
		const gjcGoalJson = {};
		const generation = computeUltragoalPlanGeneration({
			plan,
			ledger: [],
			goal: plan.goals[0],
			receiptKind: "final-aggregate",
			beforeStatus: "active",
			excludeEventId: eventId,
		});
		plan.goals[0].completionVerification = {
			schemaVersion: 1,
			receiptId: "receipt-final",
			verifiedAt: now,
			goalId: plan.goals[0].id,
			receiptKind: "final-aggregate",
			goalStatusBeforeCheckpoint: "active",
			gjcGoalMode: plan.gjcGoalMode,
			gjcObjective: plan.gjcObjective,
			qualityGateHash: hashStructuredValue(qualityGateJson),
			gjcGoalSnapshotHash: hashStructuredValue(gjcGoalJson),
			planGeneration: generation.planGeneration,
			basis: generation.basis,
			checkpointLedgerEventId: eventId,
		};
		await fs.writeFile(paths.goalsPath, JSON.stringify(plan, null, 2));
		await fs.writeFile(
			paths.ledgerPath,
			`${JSON.stringify({ eventId, event: "goal_checkpointed", goalId: plan.goals[0].id, status: "complete", completionVerification: plan.goals[0].completionVerification, qualityGateJson, gjcGoalJson })}\n`,
		);
		const diagnostic = await isUltragoalAskBlocked(cwd);
		expect(diagnostic.active).toBe(false);
		expect(diagnostic.source).toBe("durable_state");
	});

	it("allows ask when no GJC session resolves even if a stale global ultragoal plan exists", async () => {
		const cwd = await tempDir();
		const previousSessionId = process.env.GJC_SESSION_ID;
		delete process.env.GJC_SESSION_ID;
		try {
			// Legacy/global .gjc/ultragoal with an incomplete plan, but no resolvable
			// session (no env, no _session-* activity marker). Must not block ask.
			const globalDir = path.join(cwd, ".gjc", "ultragoal");
			await fs.mkdir(globalDir, { recursive: true });
			await fs.writeFile(
				path.join(globalDir, "goals.json"),
				JSON.stringify({
					version: 1,
					brief: "Stale run",
					gjcGoalMode: "aggregate",
					goals: [{ id: "G001", title: "Leftover", objective: "Leftover", status: "pending" }],
				}),
			);

			const diagnostic = await isUltragoalAskBlocked(cwd);

			expect(diagnostic.active).toBe(false);
			expect(diagnostic.source).toBe("absent");
		} finally {
			if (previousSessionId === undefined) delete process.env.GJC_SESSION_ID;
			else process.env.GJC_SESSION_ID = previousSessionId;
		}
	});
});
