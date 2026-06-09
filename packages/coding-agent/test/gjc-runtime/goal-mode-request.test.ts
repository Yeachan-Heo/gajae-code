import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	consumePendingGoalModeRequest,
	GJC_SESSION_FILE_ENV,
	GJC_SESSION_ID_ENV,
	isUltragoalCreateGoalsInvocation,
	readUltragoalGjcObjective,
	writeCurrentSessionGoalModeState,
	writePendingGoalModeRequest,
} from "@gajae-code/coding-agent/gjc-runtime/goal-mode-request";
import {
	buildSessionContext,
	loadEntriesFromFile,
	type SessionEntry,
} from "@gajae-code/coding-agent/session/session-manager";

const tempRoots: string[] = [];

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
		const goalsPath = path.join(root, ".gjc", "ultragoal", "goals.json");
		await fs.mkdir(path.dirname(goalsPath), { recursive: true });
		await Bun.write(goalsPath, JSON.stringify({ gjcObjective: "Complete .gjc/ultragoal/goals.json" }));

		const result = await readUltragoalGjcObjective(root);

		expect(result.objective).toBe("Complete .gjc/ultragoal/goals.json");
		expect(result.goalsPath).toBe(goalsPath);
	});

	it("writes and consumes a pending runtime goal mode request", async () => {
		const root = await tempDir();
		await writePendingGoalModeRequest({ cwd: root, objective: "Complete ultragoal", goalsPath: "goals.json" });

		const request = await consumePendingGoalModeRequest(root);
		const consumedAgain = await consumePendingGoalModeRequest(root);

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

	it("keeps consuming legacy unscoped requests from any session", async () => {
		const root = await tempDir();
		await writePendingGoalModeRequest({ cwd: root, objective: "Complete ultragoal" });

		// No sessionId stamped (legacy/CLI-only producer) → consumable by any session.
		const request = await consumePendingGoalModeRequest(root, "session-X");
		expect(request?.objective).toBe("Complete ultragoal");
		expect(request?.sessionId).toBeUndefined();
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

		expect(result).toEqual({ status: "existing_goal", goal: existingGoal });
		expect(after).toBe(before);
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
			objective: "New ultragoal objective",
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
		const requestPath = path.join(root, ".gjc", "state", "goal-mode-request.json");
		await fs.mkdir(path.dirname(requestPath), { recursive: true });
		await Bun.write(requestPath, "{");

		await expect(consumePendingGoalModeRequest(root)).rejects.toThrow(SyntaxError);
	});

	it("surfaces corrupt ultragoal goals json", async () => {
		const root = await tempDir();
		const goalsPath = path.join(root, ".gjc", "ultragoal", "goals.json");
		await fs.mkdir(path.dirname(goalsPath), { recursive: true });
		await Bun.write(goalsPath, "{");

		await expect(readUltragoalGjcObjective(root)).rejects.toThrow(SyntaxError);
	});
});
