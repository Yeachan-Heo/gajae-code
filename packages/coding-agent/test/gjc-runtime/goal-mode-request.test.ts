import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	consumePendingGoalModeRequest,
	isUltragoalCreateGoalsInvocation,
	readUltragoalCodexObjective,
	writePendingGoalModeRequest,
} from "@gajae-code/coding-agent/gjc-runtime/goal-mode-request";

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

	it("reads codexObjective from the generated ultragoal plan", async () => {
		const root = await tempDir();
		const goalsPath = path.join(root, ".gjc", "ultragoal", "goals.json");
		await fs.mkdir(path.dirname(goalsPath), { recursive: true });
		await Bun.write(goalsPath, JSON.stringify({ codexObjective: "Complete .gjc/ultragoal/goals.json" }));

		const result = await readUltragoalCodexObjective(root);

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

		await expect(readUltragoalCodexObjective(root)).rejects.toThrow(SyntaxError);
	});
});
