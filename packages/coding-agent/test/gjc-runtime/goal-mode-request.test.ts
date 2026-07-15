import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	aggregateObjectiveMatches,
	ackPendingGoalModeRequest,
	consumePendingGoalModeRequest,
	peekPendingGoalModeRequest,
	GJC_SESSION_FILE_ENV,
	GJC_SESSION_ID_ENV,
	isUltragoalCreateGoalsInvocation,
	readUltragoalGjcObjective,
	shouldReconcileGoal,
	writeCurrentSessionGoalModeState,
	writePendingGoalModeRequest,
} from "@gajae-code/coding-agent/gjc-runtime/goal-mode-request";
import { sessionStateDir, sessionUltragoalDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import {
	buildSessionContext,
	loadEntriesFromFile,
	type SessionEntry,
} from "@gajae-code/coding-agent/session/session-manager";

const TEST_SESSION_ID = "test-session";
const tempRoots: string[] = [];
let priorSessionId: string | undefined;

beforeAll(() => {
	priorSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
});

afterAll(() => {
	if (priorSessionId !== undefined) process.env.GJC_SESSION_ID = priorSessionId;
	else delete process.env.GJC_SESSION_ID;
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-goal-mode-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("GJC ultragoal goal mode request", () => {
	it("detects create-goals invocations without matching flags", () => {
		expect(isUltragoalCreateGoalsInvocation(["create-goals", "--brief", "ship it"])).toBe(true);
		expect(isUltragoalCreateGoalsInvocation(["create", "--brief", "ship it"])).toBe(true);
		expect(isUltragoalCreateGoalsInvocation(["--json", "status"])).toBe(false);
		expect(isUltragoalCreateGoalsInvocation(["--create-goals"])).toBe(false);
		expect(isUltragoalCreateGoalsInvocation(["status", "--filter", "create-goals"])).toBe(false);
	});

	it("reads gjcObjective from the generated ultragoal plan", async () => {
		const root = await tempDir();
		const goalsPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json");
		await fs.mkdir(path.dirname(goalsPath), { recursive: true });
		await Bun.write(goalsPath, JSON.stringify({ gjcObjective: "Complete .gjc/ultragoal/goals.json" }));

		const result = await readUltragoalGjcObjective(root);

		expect(result.objective).toBe("Complete .gjc/ultragoal/goals.json");
		expect(result.goalsPath).toBe(goalsPath);
	});

	it("writes and consumes a pending runtime goal mode request", async () => {
		const root = await tempDir();
		await writePendingGoalModeRequest({ cwd: root, objective: "Complete ultragoal", goalsPath: "goals.json" });

		const request = await consumePendingGoalModeRequest(root, TEST_SESSION_ID);
		const consumedAgain = await consumePendingGoalModeRequest(root, TEST_SESSION_ID);

		expect(request?.objective).toBe("Complete ultragoal");
		expect(request?.source).toBe("ultragoal");
		expect(consumedAgain).toBeNull();
	});

	it("does not let a concurrent session consume another session's pending request", async () => {
		const root = await tempDir();
		await writePendingGoalModeRequest({
			cwd: root,
			objective: "Complete ultragoal",
			goalsPath: "goals.json",
			sessionId: "session-A",
		});

		// A different, independent session must not pick up session-A's request.
		const leaked = await consumePendingGoalModeRequest(root, "session-B");
		expect(leaked).toBeNull();

		// The request is left intact for its rightful owner to consume.
		const owned = await consumePendingGoalModeRequest(root, "session-A");
		expect(owned?.objective).toBe("Complete ultragoal");
		expect(owned?.sessionId).toBe("session-A");

		// Once consumed by the owner it is gone for everyone.
		expect(await consumePendingGoalModeRequest(root, "session-A")).toBeNull();
	});

	it("lets the owning session consume its own session-scoped request", async () => {
		const root = await tempDir();
		await writePendingGoalModeRequest({
			cwd: root,
			objective: "Complete ultragoal",
			sessionId: "session-A",
		});

		const owned = await consumePendingGoalModeRequest(root, "session-A");
		expect(owned?.sessionId).toBe("session-A");
	});

	it("consumes pending requests from the owning session", async () => {
		const root = await tempDir();
		await writePendingGoalModeRequest({ cwd: root, objective: "Complete ultragoal", sessionId: "session-X" });

		const request = await consumePendingGoalModeRequest(root, "session-X");
		expect(request?.objective).toBe("Complete ultragoal");
		expect(request?.sessionId).toBe("session-X");
	});

	it("writes goal mode state into the current session file", async () => {
		const root = await tempDir();
		const sessionFile = path.join(root, "session.jsonl");
		const timestamp = new Date().toISOString();
		await Bun.write(
			sessionFile,
			[
				JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp, cwd: root }),
				JSON.stringify({
					type: "message",
					id: "user-1",
					parentId: null,
					timestamp,
					message: { role: "user", content: [{ type: "text", text: "start ultragoal" }] },
				}),
				"",
			].join("\n"),
		);

		const result = await writeCurrentSessionGoalModeState({
			sessionFile,
			objective: "Complete generated ultragoal plan",
		});
		const entries = (await loadEntriesFromFile(sessionFile)).filter(
			(entry): entry is SessionEntry => entry.type !== "session",
		);
		const context = buildSessionContext(entries);

		expect(result.status).toBe("updated");
		expect(context.mode).toBe("goal");
		expect(context.modeData?.goal).toMatchObject({
			objective: "Complete generated ultragoal plan",
			status: "active",
			tokensUsed: 0,
		});
	});

	it("does not overwrite an existing active session goal", async () => {
		const root = await tempDir();
		const sessionFile = path.join(root, "session.jsonl");
		const timestamp = new Date().toISOString();
		const existingGoal = {
			id: "goal-1",
			objective: "Existing goal",
			status: "active" as const,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 1,
		};
		await Bun.write(
			sessionFile,
			[
				JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp, cwd: root }),
				JSON.stringify({
					type: "mode_change",
					id: "mode-1",
					parentId: null,
					timestamp,
					mode: "goal",
					data: { goal: existingGoal },
				}),
				"",
			].join("\n"),
		);

		const before = await Bun.file(sessionFile).text();
		const result = await writeCurrentSessionGoalModeState({
			sessionFile,
			objective: "New ultragoal objective",
		});
		const after = await Bun.file(sessionFile).text();

		// Mismatched objective: the session-file writer returns needs_reconcile
		// WITHOUT mutating the file. The live pending-request path handles replacement.
		expect(result.status).toBe("needs_reconcile");
		if (result.status !== "needs_reconcile") throw new Error("expected needs_reconcile");
		expect(result.goal).toMatchObject(existingGoal);
		expect(after).toBe(before);
	});

	it("returns existing_goal when the objective matches the aggregate plan", async () => {
		const root = await tempDir();
		const sessionFile = path.join(root, "session.jsonl");
		const timestamp = new Date().toISOString();
		const existingGoal = {
			id: "goal-1",
			objective: "Complete .gjc/ultragoal/goals.json",
			status: "active" as const,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 1,
		};
		await Bun.write(
			sessionFile,
			[
				JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp, cwd: root }),
				JSON.stringify({
					type: "mode_change",
					id: "mode-1",
					parentId: null,
					timestamp,
					mode: "goal",
					data: { goal: existingGoal },
				}),
				"",
			].join("\n"),
		);

		const before = await Bun.file(sessionFile).text();
		const result = await writeCurrentSessionGoalModeState({
			sessionFile,
			objective: "Complete .gjc/ultragoal/goals.json",
			aggregateObjective: "Complete .gjc/ultragoal/goals.json",
		});
		const after = await Bun.file(sessionFile).text();

		expect(result).toEqual({ status: "existing_goal", goal: existingGoal });
		expect(after).toBe(before);
	});

	it("returns existing_goal when the objective matches via aliases", async () => {
		const root = await tempDir();
		const sessionFile = path.join(root, "session.jsonl");
		const timestamp = new Date().toISOString();
		const existingGoal = {
			id: "goal-1",
			objective: "Legacy objective text",
			status: "active" as const,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 1,
		};
		await Bun.write(
			sessionFile,
			[
				JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp, cwd: root }),
				JSON.stringify({
					type: "mode_change",
					id: "mode-1",
					parentId: null,
					timestamp,
					mode: "goal",
					data: { goal: existingGoal },
				}),
				"",
			].join("\n"),
		);

		const result = await writeCurrentSessionGoalModeState({
			sessionFile,
			objective: "New aggregate objective",
			aggregateObjective: "New aggregate objective",
			aliases: ["Legacy objective text"],
		});

		expect(result.status).toBe("existing_goal");
	});

	it("normalizes legacy budget-limited session goals", async () => {
		const root = await tempDir();
		const sessionFile = path.join(root, "session.jsonl");
		const timestamp = new Date().toISOString();
		const existingGoal = {
			id: "goal-1",
			objective: "Existing goal",
			status: "budget-limited",
			tokenBudget: 10,
			tokensUsed: 12,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 1,
		};
		await Bun.write(
			sessionFile,
			[
				JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp, cwd: root }),
				JSON.stringify({
					type: "mode_change",
					id: "mode-1",
					parentId: null,
					timestamp,
					mode: "goal",
					data: { goal: existingGoal },
				}),
				"",
			].join("\n"),
		);

		const result = await writeCurrentSessionGoalModeState({
			sessionFile,
			objective: "Existing goal",
		});

		expect(result.status).toBe("existing_goal");
		if (result.status !== "existing_goal") throw new Error("expected existing goal");
		expect(result.goal).toMatchObject({ status: "active", tokensUsed: 12 });
		expect("tokenBudget" in result.goal).toBe(false);
	});

	it("queues a pending activation request even when the session file already has an active goal", async () => {
		const root = await tempDir();
		const sessionFile = path.join(root, "session.jsonl");
		const timestamp = new Date().toISOString();
		const existingGoal = {
			id: "goal-1",
			objective: "Existing goal",
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 1,
		};
		await Bun.write(
			sessionFile,
			[
				JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp, cwd: root }),
				JSON.stringify({
					type: "mode_change",
					id: "mode-1",
					parentId: null,
					timestamp,
					mode: "goal",
					data: { goal: existingGoal },
				}),
				"",
			].join("\n"),
		);

		const cliPath = path.resolve(import.meta.dir, "..", "..", "src", "cli.ts");

		const result = Bun.spawnSync(["bun", cliPath, "ultragoal", "create-goals", "--brief", "Ship native goal"], {
			cwd: root,
			env: { ...process.env, [GJC_SESSION_FILE_ENV]: sessionFile, [GJC_SESSION_ID_ENV]: "session-owner" },
			stdout: "pipe",
			stderr: "pipe",
		});

		expect(result.exitCode, result.stderr.toString()).toBe(0);
		// The pending request is stamped with the producing session and must not
		// leak into a concurrent independent session sharing the same cwd.
		expect(await consumePendingGoalModeRequest(root, "other-session")).toBeNull();
		const pending = await consumePendingGoalModeRequest(root, "session-owner");
		expect(pending?.objective).toContain(".gjc/ultragoal/goals.json");
		expect(pending?.sessionId).toBe("session-owner");
		const entries = (await loadEntriesFromFile(sessionFile)).filter(
			(entry): entry is SessionEntry => entry.type !== "session",
		);
		const context = buildSessionContext(entries);
		expect(context.modeData?.goal).toMatchObject(existingGoal);
	});

	it("surfaces corrupt pending request json", async () => {
		const root = await tempDir();
		const requestPath = path.join(sessionStateDir(root, TEST_SESSION_ID), "goal-mode-request.json");
		await fs.mkdir(path.dirname(requestPath), { recursive: true });
		await Bun.write(requestPath, "{");

		await expect(consumePendingGoalModeRequest(root)).rejects.toThrow(SyntaxError);
	});

	it("surfaces corrupt ultragoal goals json", async () => {
		const root = await tempDir();
		const goalsPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json");
		await fs.mkdir(path.dirname(goalsPath), { recursive: true });
		await Bun.write(goalsPath, "{");

		await expect(readUltragoalGjcObjective(root)).rejects.toThrow(SyntaxError);
	});

	it("pending request stores provenance fields", async () => {
		const root = await tempDir();
		await writePendingGoalModeRequest({
			cwd: root,
			objective: "Complete ultragoal",
			goalsPath: "/path/to/goals.json",
			sourcePlanPath: "/path/to/goals.json",
			sourceBriefHash: "abc123",
			planStatus: "active",
			sessionId: "session-prov",
		});

		const request = await consumePendingGoalModeRequest(root, "session-prov");
		expect(request?.objective).toBe("Complete ultragoal");
		expect(request?.sourcePlanPath).toBe("/path/to/goals.json");
		expect(request?.sourceBriefHash).toBe("abc123");
		expect(request?.planStatus).toBe("active");
		expect(request?.goalsPath).toBe("/path/to/goals.json");
	});

	it("readUltragoalGjcObjective returns briefHash and planStatus", async () => {
		const root = await tempDir();
		const dir = sessionUltragoalDir(root, TEST_SESSION_ID);
		const goalsPath = path.join(dir, "goals.json");
		const briefPath = path.join(dir, "brief.md");
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(briefPath, "Ship the feature\n");
		await Bun.write(
			goalsPath,
			JSON.stringify({
				gjcObjective: "Complete the plan",
				gjcObjectiveAliases: ["Legacy objective"],
				goals: [{ id: "G001", objective: "Do thing", status: "active" }],
			}),
		);

		const result = await readUltragoalGjcObjective(root);
		expect(result.objective).toBe("Complete the plan");
		expect(typeof result.briefHash).toBe("string");
		expect(result.briefHash?.length).toBe(64);
		expect(result.planStatus).toBe("active");
		expect(result.aliases).toEqual(["Legacy objective"]);
	});

	it("readUltragoalGjcObjective computes planStatus as complete when all goals terminal", async () => {
		const root = await tempDir();
		const dir = sessionUltragoalDir(root, TEST_SESSION_ID);
		const goalsPath = path.join(dir, "goals.json");
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(
			goalsPath,
			JSON.stringify({
				gjcObjective: "Complete the plan",
				goals: [
					{ id: "G001", objective: "Do thing", status: "complete" },
					{ id: "G002", objective: "Do other", status: "superseded" },
				],
			}),
		);

		const result = await readUltragoalGjcObjective(root);
		expect(result.planStatus).toBe("complete");
	});

	describe("shouldReconcileGoal", () => {
		it("returns create when current is null", () => {
			expect(shouldReconcileGoal(null, { objective: "New goal" })).toBe("create");
		});

		it("returns create when current goal is complete", () => {
			expect(
				shouldReconcileGoal(
					{ objective: "Old goal", status: "complete" },
					{ objective: "New goal" },
				),
			).toBe("create");
		});

		it("returns create when current goal is dropped", () => {
			expect(
				shouldReconcileGoal(
					{ objective: "Old goal", status: "dropped" },
					{ objective: "New goal" },
				),
			).toBe("create");
		});

		it("returns keep when objectives match and no provenance conflict", () => {
			expect(
				shouldReconcileGoal(
					{ objective: "Same goal", status: "active" },
					{ objective: "Same goal" },
				),
			).toBe("keep");
		});

		it("returns keep when objectives match and provenance is only on one side", () => {
			expect(
				shouldReconcileGoal(
					{ objective: "Same goal", status: "active", sourcePlanPath: "/path/a" },
					{ objective: "Same goal" },
				),
			).toBe("keep");
		});

		it("returns replace when objectives differ", () => {
			expect(
				shouldReconcileGoal(
					{ objective: "Old goal", status: "active" },
					{ objective: "New goal" },
				),
			).toBe("replace");
		});

		it("returns block when objectives match but sourcePlanPath conflicts", () => {
			expect(
				shouldReconcileGoal(
					{ objective: "Same goal", status: "active", sourcePlanPath: "/path/a" },
					{ objective: "Same goal", sourcePlanPath: "/path/b" },
				),
			).toBe("block");
		});

		it("returns block when objectives match but sourceBriefHash conflicts", () => {
			expect(
				shouldReconcileGoal(
					{ objective: "Same goal", status: "active", sourceBriefHash: "hash-a" },
					{ objective: "Same goal", sourceBriefHash: "hash-b" },
				),
			).toBe("block");
		});
	});

	describe("aggregateObjectiveMatches", () => {
		it("returns true when current equals planObjective", () => {
			expect(aggregateObjectiveMatches("Complete the plan", "Complete the plan")).toBe(true);
		});

		it("returns true when current equals DEFAULT_ULTRAGOAL_OBJECTIVE", () => {
			expect(
				aggregateObjectiveMatches(
					"Complete the durable ultragoal plan in .gjc/ultragoal/goals.json, including later accepted/appended stories, under the original brief constraints; use .gjc/ultragoal/ledger.jsonl as the audit trail.",
					"Some other objective",
				),
			).toBe(true);
		});

		it("returns true when current matches an alias", () => {
			expect(aggregateObjectiveMatches("Legacy text", "New objective", ["Legacy text", "Other alias"])).toBe(true);
		});

		it("returns false when no match", () => {
			expect(aggregateObjectiveMatches("Unrelated", "New objective", ["Alias"])).toBe(false);
		});

		it("returns false for empty current", () => {
			expect(aggregateObjectiveMatches("", "New objective")).toBe(false);
		});
	});

	it("shouldReconcileGoal keeps alias/default aggregate matches", () => {
		expect(
			shouldReconcileGoal(
				{ objective: "legacy aggregate alias", status: "active" },
				{
					objective:
						"Complete the durable ultragoal plan in .gjc/ultragoal/goals.json, including later accepted/appended stories, under the original brief constraints; use .gjc/ultragoal/ledger.jsonl as the audit trail.",
					gjcObjectiveAliases: ["legacy aggregate alias"],
				},
			),
		).toBe("keep");
	});

	it("peek leaves pending request durable until ack", async () => {
		const root = await tempDir();
		await writePendingGoalModeRequest({
			cwd: root,
			objective: "Complete ultragoal",
			goalsPath: "goals.json",
			sessionId: TEST_SESSION_ID,
		});
		const peeked = await peekPendingGoalModeRequest(root, TEST_SESSION_ID);
		expect(peeked?.objective).toBe("Complete ultragoal");
		const peekedAgain = await peekPendingGoalModeRequest(root, TEST_SESSION_ID);
		expect(peekedAgain?.objective).toBe("Complete ultragoal");
		await ackPendingGoalModeRequest(root, TEST_SESSION_ID);
		expect(await peekPendingGoalModeRequest(root, TEST_SESSION_ID)).toBeNull();
	});

});
