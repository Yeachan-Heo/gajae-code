import { describe, expect, it } from "bun:test";
import * as path from "node:path";

interface ScenarioResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

const fixturePath = path.join(import.meta.dir, "postmortem-fixture.ts");

async function runScenario(scenario: string): Promise<ScenarioResult> {
	const proc = Bun.spawn([process.execPath, fixturePath, scenario], {
		cwd: path.join(import.meta.dir, ".."),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

function parseResult(stdout: string): { count: number } {
	const line = stdout.trim().split("\n").at(-1);
	if (!line) {
		throw new Error("postmortem fixture produced no JSON result");
	}
	return JSON.parse(line) as { count: number };
}

function combinedOutput(result: ScenarioResult): string {
	return `${result.stdout}\n${result.stderr}`;
}

function hasRecursiveCleanupError(stderr: string): boolean {
	return stderr.includes('"level":"error"') && stderr.includes('"message":"Cleanup invoked recursively"');
}

describe("postmortem cleanup re-entry", () => {
	it("does not log an error when the exit handler re-enters while cleanup is running", async () => {
		const result = await runScenario("exit-reentry-while-running");

		expect(result.exitCode).toBe(0);
		expect(parseResult(result.stdout).count).toBe(1);
		expect(hasRecursiveCleanupError(combinedOutput(result))).toBe(false);
	});

	it("keeps the recursive cleanup error for non-exit re-entry", async () => {
		const result = await runScenario("non-exit-recursive-cleanup");

		expect(result.exitCode).toBe(0);
		expect(parseResult(result.stdout).count).toBe(1);
		expect(hasRecursiveCleanupError(combinedOutput(result))).toBe(true);
		expect(combinedOutput(result)).toContain('"stack"');
	});

	it("keeps completed cleanup a no-op when the exit handler fires", async () => {
		const result = await runScenario("completed-cleanup-exit-noop");

		expect(result.exitCode).toBe(0);
		expect(parseResult(result.stdout).count).toBe(1);
		expect(hasRecursiveCleanupError(combinedOutput(result))).toBe(false);
	});
});
