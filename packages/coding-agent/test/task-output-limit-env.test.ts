import { describe, expect, it } from "bun:test";
import * as path from "node:path";

interface TaskOutputLimits {
	bytes: number;
	lines: number;
}

const taskTypesPath = path.resolve(import.meta.dir, "../src/task/types.ts");
const defaults: TaskOutputLimits = { bytes: 500_000, lines: 5000 };

async function readTaskOutputLimits(overrides: Record<string, string> = {}): Promise<TaskOutputLimits> {
	const env = { ...process.env };
	delete env.GJC_TASK_MAX_OUTPUT_BYTES;
	delete env.PI_TASK_MAX_OUTPUT_BYTES;
	delete env.GJC_TASK_MAX_OUTPUT_LINES;
	delete env.PI_TASK_MAX_OUTPUT_LINES;
	Object.assign(env, overrides);

	const script = `
		const taskTypes = await import(${JSON.stringify(taskTypesPath)});
		process.stdout.write(JSON.stringify({
			bytes: taskTypes.MAX_OUTPUT_BYTES,
			lines: taskTypes.MAX_OUTPUT_LINES,
		}));
	`;
	const child = Bun.spawn([process.execPath, "--eval", script], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`task limit probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout) as TaskOutputLimits;
}

describe("task output limit environment parsing", () => {
	it("uses documented defaults when overrides are absent", async () => {
		expect(await readTaskOutputLimits()).toEqual(defaults);
	});

	it("accepts complete positive decimal integers from canonical variables", async () => {
		expect(
			await readTaskOutputLimits({
				GJC_TASK_MAX_OUTPUT_BYTES: "00064000",
				GJC_TASK_MAX_OUTPUT_LINES: "250",
			}),
		).toEqual({ bytes: 64_000, lines: 250 });
	});

	it("keeps compatibility aliases when canonical variables are absent", async () => {
		expect(
			await readTaskOutputLimits({
				PI_TASK_MAX_OUTPUT_BYTES: "32000",
				PI_TASK_MAX_OUTPUT_LINES: "125",
			}),
		).toEqual({ bytes: 32_000, lines: 125 });
	});

	it.each([
		"500000oops",
		"1.5",
		"1e3",
		" 12 ",
		"0",
		"-1",
		"9007199254740992",
	])("falls back for invalid or inexact override %j", async value => {
		expect(
			await readTaskOutputLimits({
				GJC_TASK_MAX_OUTPUT_BYTES: value,
				GJC_TASK_MAX_OUTPUT_LINES: value,
			}),
		).toEqual(defaults);
	});
});
