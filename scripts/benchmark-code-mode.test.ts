import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as z from "zod/v4";
import {
	MAX_PLAN_STEPS,
	MIN_PLAN_STEPS,
	assertOutputPathOutsideWorkspace,
	assertRepositoryScopedArguments,
	medianMetric,
	type PairedRequestCount,
	parseBenchmarkTasks,
	parseScriptPlan,
	percentReduction,
	renderExecDescription,
	resolveScriptReferences,
	summarizeDecision,
	taskClusteredBootstrap95CI,
	usesPreviousResult,
	validateFinalAnswer,
	validateScriptPlan,
	validateScriptToolArguments,
	validateTaskCallSequence,
	type BenchmarkTask,
} from "./benchmark-code-mode";
import benchmarkCodeModeTasks from "./benchmark-code-mode-tasks.md" with { type: "text" };

function dependentPlan(): unknown {
	return {
		steps: [
			{ id: "find", tool: "search", input: { pattern: "Anchor", paths: ["src"] } },
			{ id: "open", tool: "read", input: { path: { $ref: "find", select: "details.files.0" } } },
			{
				id: "follow",
				tool: "search",
				input: {
					pattern: { $ref: "open", select: "content.0.text", contains: "DistinctiveName" },
					paths: ["src"],
				},
			},
		],
	};
}

function planForTask(task: BenchmarkTask): unknown {
	return {
		steps: [
			{ id: "find", tool: "search", input: { pattern: task.initialSearchQuery } },
			{ id: "open", tool: "read", input: { path: { $ref: "find", select: "details.files.0" } } },
			{
				id: "follow",
				tool: "search",
				input: {
					pattern: {
						$ref: "open",
						select: "content.0.text",
						contains: task.requiredFollowupSearchTerm,
					},
				},
			},
		],
	};
}

describe("exec callable API description", () => {
	test("renders the current read/search descriptions and parameter schemas", () => {
		const description = renderExecDescription(
			{ description: "READ_API_DESCRIPTION", parameters: z.object({ path: z.string() }) },
			{ description: "SEARCH_API_DESCRIPTION", parameters: z.object({ pattern: z.string() }) },
		);
		expect(description).toContain("READ_API_DESCRIPTION");
		expect(description).toContain("SEARCH_API_DESCRIPTION");
		expect(description).toContain('"path"');
		expect(description).toContain('"pattern"');
		expect(description).not.toContain("{{read_schema}}");
	});
});

describe("benchmark code-mode script plans", () => {
	test("parses an ordered read/search plan and resolves only selected prior result data", () => {
		const plan = parseScriptPlan(JSON.stringify(dependentPlan()));
		expect(plan.steps).toHaveLength(MIN_PLAN_STEPS);
		expect(plan.steps[0]?.tool).toBe("search");
		const results = new Map([
			["find", { details: { files: ["packages/example.ts"] } }],
			["open", { content: [{ type: "text", text: "export class DistinctiveName {}" }] }],
		]);
		expect(resolveScriptReferences(plan.steps[1]!.input.path, results)).toBe("packages/example.ts");
		expect(resolveScriptReferences(plan.steps[2]!.input.pattern, results)).toBe("DistinctiveName");
		expect(() => parseScriptPlan("globalThis.process.exit(1)")).toThrow(/not valid JSON/);
	});

	test("rejects duplicate IDs and plans outside the bounded step count", () => {
		const duplicate = dependentPlan() as { steps: Array<Record<string, unknown>> };
		duplicate.steps[2]!.id = "open";
		expect(() => validateScriptPlan(duplicate)).toThrow(/Duplicate step ID/);
		const tooLong = dependentPlan() as { steps: unknown[] };
		tooLong.steps = Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, index) => ({
			id: `step${index}`,
			tool: "search",
			input: { pattern: "x" },
		}));
		expect(() => validateScriptPlan(tooLong)).toThrow(/ordered steps/);
	});

	test("rejects forward and unknown references before a handler can run", () => {
		const forward = dependentPlan() as { steps: Array<Record<string, unknown>> };
		forward.steps[1]!.input = { path: { $ref: "follow", select: "details.files.0" } };
		expect(() => validateScriptPlan(forward)).toThrow(/unknown or forward/);
		const unknown = dependentPlan() as { steps: Array<Record<string, unknown>> };
		unknown.steps[1]!.input = { path: { $ref: "missing", select: "details.files.0" } };
		expect(() => validateScriptPlan(unknown)).toThrow(/unknown or forward/);
	});

	test("rejects a later step that is not dependent on its immediate predecessor", () => {
		const independent = dependentPlan() as { steps: Array<Record<string, unknown>> };
		independent.steps[2]!.input = { pattern: "fixed-query", paths: ["src"] };
		expect(() => validateScriptPlan(independent)).toThrow(/immediately preceding step/);
	});

	test("rejects non-read/search tools and unresolved references", () => {
		const unsupported = dependentPlan() as { steps: Array<Record<string, unknown>> };
		unsupported.steps[0]!.tool = "bash";
		expect(() => validateScriptPlan(unsupported)).toThrow(/tool must be read or search/);
		expect(() => resolveScriptReferences({ $ref: "missing", select: "content.0.text" }, new Map())).toThrow(
			/unknown or forward/,
		);
	});

	test("rejects unsafe reference selection and missing literal evidence", () => {
		const results = new Map([["read", { content: [{ type: "text", text: "some safe text" }] }]]);
		expect(() => resolveScriptReferences({ $ref: "read", select: "content.0.text.constructor" }, results)).toThrow(
			/safe dot-path/,
		);
		expect(() =>
			resolveScriptReferences({ $ref: "read", select: "content.0.text", contains: "absent" }, results),
		).toThrow(/does not contain/);
	});

	test("validates resolved arguments against the exact tool schema", () => {
		const readTool = {
			parameters: z.object({ path: z.string(), truncation: z.enum(["head", "last"]).optional() }).strict(),
		};
		expect(validateScriptToolArguments("read", readTool, { path: "src/file.ts", truncation: "head" })).toEqual({
			path: "src/file.ts",
			truncation: "head",
		});
		expect(() => validateScriptToolArguments("read", readTool, { path: 12 })).toThrow(/tool schema validation/);
		expect(() => validateScriptToolArguments("read", readTool, { path: "src/file.ts", shell: "forbidden" })).toThrow(
			/tool schema validation/,
		);
	});

	test("requires each later read/search path or query to carry distinctive prior-result data", () => {
		expect(
			usesPreviousResult(
				"read",
				{ path: "packages/example.ts" },
				"Found packages/example.ts in the search results.",
			),
		).toBe(true);
		expect(
			usesPreviousResult(
				"search",
				{ pattern: "DistinctiveIdentifier", paths: ["src"] },
				"The source declares DistinctiveIdentifier.",
			),
		).toBe(true);
		expect(usesPreviousResult("search", { pattern: "fixed", paths: ["src"] }, "An unrelated result.")).toBe(false);
	});
});

describe("repository-scoped file handlers", () => {
	test("allows in-tree reads/searches and rejects absolute, traversal, URL, ignored, and symlink escapes", async () => {
		const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-benchmark-scope-"));
		const workspace = path.join(temporaryRoot, "repo");
		const packages = path.join(workspace, "packages");
		const insideFile = path.join(packages, "main.ts");
		const externalFile = path.join(temporaryRoot, "secret.txt");
		const outputSymlink = path.join(temporaryRoot, "output-symlink.json");
		const outputHardlink = path.join(temporaryRoot, "output-hardlink.json");
		try {
			await fs.mkdir(packages, { recursive: true });
			await fs.writeFile(insideFile, "export const safe = true;\n");
			await fs.writeFile(externalFile, "not in the repo\n");
			await expect(assertOutputPathOutsideWorkspace(workspace, path.join(workspace, "report.json"))).rejects.toThrow(
				/outside the task repository/,
			);
			if (process.platform !== "win32") {
				await fs.symlink(insideFile, outputSymlink);
				await expect(assertOutputPathOutsideWorkspace(workspace, outputSymlink)).rejects.toThrow(/may not be a symlink/);
			}
			await fs.link(insideFile, outputHardlink);
			await expect(assertOutputPathOutsideWorkspace(workspace, outputHardlink)).rejects.toThrow(/single-link regular file/);
			await expect(assertRepositoryScopedArguments(workspace, "read", { path: "packages/main.ts:1-2" })).resolves.toBeUndefined();
			await expect(assertRepositoryScopedArguments(workspace, "search", { pattern: "safe", paths: ["packages/**/*.ts"] })).resolves.toBeUndefined();
			await expect(assertRepositoryScopedArguments(workspace, "search", { pattern: "safe", paths: null })).resolves.toBeUndefined();
			await expect(
				assertRepositoryScopedArguments(workspace, "search", {
					pattern: "secret",
					paths: ["{../secret.txt,packages/**/*.ts}"],
				}),
			).rejects.toThrow(/does not allow brace-expanded path alternatives/);
			await expect(assertRepositoryScopedArguments(workspace, "read", { path: "../secret.txt" })).rejects.toThrow(
				/outside the task repository/,
			);
			await expect(assertRepositoryScopedArguments(workspace, "read", { path: externalFile })).rejects.toThrow(
				/outside the task repository/,
			);
			await expect(assertRepositoryScopedArguments(workspace, "read", { path: "https://example.com/secret" })).rejects.toThrow(
				/local path inside the task repository/,
			);
			await expect(assertRepositoryScopedArguments(workspace, "search", { pattern: "secret", paths: [externalFile] })).rejects.toThrow(
				/outside the task repository/,
			);
			await expect(assertRepositoryScopedArguments(workspace, "search", { pattern: "secret", gitignore: false })).rejects.toThrow(
				/may not disable gitignore/,
			);
			if (process.platform !== "win32") {
				await fs.symlink(externalFile, path.join(workspace, "escape.ts"));
				await expect(assertRepositoryScopedArguments(workspace, "read", { path: "escape.ts" })).rejects.toThrow(
					/resolves through a symlink outside/,
				);
				await expect(assertRepositoryScopedArguments(workspace, "search", { pattern: "secret", paths: ["escape.ts"] })).rejects.toThrow(
					/resolves through a symlink outside/,
				);
			}
		} finally {
			await fs.rm(temporaryRoot, { recursive: true, force: true });
		}
	});
});

describe("pre-registered task contracts", () => {
	test("contains exactly eight tasks with three dependent investigation calls each", () => {
		const tasks = parseBenchmarkTasks(benchmarkCodeModeTasks);
		expect(tasks).toHaveLength(8);
		for (const task of tasks) {
			expect(task.id).toMatch(/^CM\d{2}$/);
			expect(task.dependencyRequirements).toHaveLength(3);
			expect(task.dependencyRequirements[0]).toMatch(/without a `paths` filter/i);
			expect(task.dependencyRequirements[1]).toMatch(/path returned by that search/i);
			expect(task.dependencyRequirements[2]).toMatch(/copied identifier.*immediately preceding read/i);
			expect(task.requiredAnswerTerms.length).toBeGreaterThanOrEqual(2);
			expect(task.initialSearchQuery.length).toBeGreaterThan(2);
			expect(task.requiredFollowupSearchTerm.length).toBeGreaterThan(2);
			expect(task.prompt).not.toMatch(/scoped to `packages\//i);
		}
	});

	test("requires the registered repository-wide first search but allows any fully dependent third call", () => {
		const task = parseBenchmarkTasks(benchmarkCodeModeTasks)[0]!;
		expect(parseScriptPlan(JSON.stringify(planForTask(task)), task).steps).toHaveLength(3);
		const scoped = planForTask(task) as { steps: Array<Record<string, unknown>> };
		scoped.steps[0]!.input = { pattern: task.initialSearchQuery, paths: ["packages"] };
		expect(() => parseScriptPlan(JSON.stringify(scoped), task)).toThrow(/initial search must not constrain paths/);
		const unrelated = planForTask(task) as { steps: Array<Record<string, unknown>> };
		unrelated.steps[0]!.input = { pattern: "unrelated source" };
		expect(() => parseScriptPlan(JSON.stringify(unrelated), task)).toThrow(/initial search must include/);
		const dependentRead = planForTask(task) as { steps: Array<Record<string, unknown>> };
		dependentRead.steps[2]!.tool = "read";
		dependentRead.steps[2]!.input = {
			path: { $ref: "open", select: "content.0.text", contains: "packages/example.ts" },
		};
		expect(parseScriptPlan(JSON.stringify(dependentRead), task).steps[2]?.tool).toBe("read");
	});

	test("requires three dependent calls and the registered repository-wide first query for Arm A", () => {
		const task = parseBenchmarkTasks(benchmarkCodeModeTasks)[0]!;
		const valid = [
			{
				toolName: "search",
				args: { pattern: task.initialSearchQuery, paths: null },
				resultText: "Found packages/example.ts",
			},
			{
				toolName: "read",
				args: { path: "packages/example.ts" },
				resultText: `The source declares ${task.requiredFollowupSearchTerm}.`,
			},
			{
				toolName: "search",
				args: { pattern: task.requiredFollowupSearchTerm, paths: null },
				resultText: "Confirmed.",
			},
		];
		expect(validateTaskCallSequence(task, valid)).toEqual([]);
		const scopedSearch = [
			{ ...valid[0]!, args: { pattern: task.initialSearchQuery, paths: ["."] } },
			...valid.slice(1),
		];
		expect(validateTaskCallSequence(task, scopedSearch)).toContain(`Task ${task.id} initial search constrained paths.`);
		expect(validateTaskCallSequence(task, valid.slice(0, 2))).toContain(
			`Task ${task.id} completed fewer than ${MIN_PLAN_STEPS} dependent calls.`,
		);
		const unrelatedSearch = [{ ...valid[0]!, args: { pattern: "unrelated" } }, ...valid.slice(1)];
		expect(validateTaskCallSequence(task, unrelatedSearch)).toContain(
			`Task ${task.id} initial search did not contain ${task.initialSearchQuery}.`,
		);
	});

	test("rejects a task set whose cardinality or dependencies are changed", () => {
		expect(() => parseBenchmarkTasks("# no benchmark tasks")).toThrow(/exactly 8 tasks/);
		const missingDependency = benchmarkCodeModeTasks.replace(
			"3. Search for the copied identifier `modelPattern` from the immediately preceding read, without a fixed path filter.",
			"3. Search with a fixed query.",
		);
		expect(() => {
			const tasks = parseBenchmarkTasks(missingDependency);
			expect(tasks[0]!.dependencyRequirements[2]).toMatch(/copied from the read result/i);
		}).toThrow();
	});
});

describe("task answer validation", () => {
	test("requires task-specific answer facts as well as grounded evidence", () => {
		const trace = {
			valid: true,
			reasons: [],
			toolResultText:
				"toolNames are selected on the session; authStorage is passed to model setup; SessionManager.inMemory is used.",
		};
		const answer = JSON.stringify({
			answer: "The setup supplies authStorage and selects tools with toolNames.",
			evidence: [
				"authStorage is passed to model setup",
				"toolNames are selected on the session",
				"SessionManager.inMemory is used",
			],
		});
		expect(validateFinalAnswer(answer, trace, ["authStorage", "toolNames"]).valid).toBe(true);
		const incomplete = JSON.stringify({
			answer: "The setup supplies authStorage.",
			evidence: [
				"authStorage is passed to model setup",
				"toolNames are selected on the session",
				"SessionManager.inMemory is used",
			],
		});
		expect(validateFinalAnswer(incomplete, trace, ["authStorage", "toolNames"]).reasons).toContain(
			"Final answer is missing required task-specific term: toolNames.",
		);
	});
});

describe("task answer validation", () => {
	test("requires task-specific answer facts as well as grounded evidence", () => {
		const trace = {
			valid: true,
			reasons: [],
			toolResultText:
				"toolNames are selected on the session; authStorage is passed to model setup; SessionManager.inMemory is used.",
		};
		const answer = JSON.stringify({
			answer: "The setup supplies authStorage and selects tools with toolNames.",
			evidence: [
				"authStorage is passed to model setup",
				"toolNames are selected on the session",
				"SessionManager.inMemory is used",
			],
		});
		expect(validateFinalAnswer(answer, trace, ["authStorage", "toolNames"]).valid).toBe(true);
		const incomplete = JSON.stringify({
			answer: "The setup supplies authStorage.",
			evidence: [
				"authStorage is passed to model setup",
				"toolNames are selected on the session",
				"SessionManager.inMemory is used",
			],
		});
		expect(validateFinalAnswer(incomplete, trace, ["authStorage", "toolNames"]).reasons).toContain(
			"Final answer is missing required task-specific term: toolNames.",
		);
	});
});

describe("paired request metrics and decision", () => {
	const repeatedPairs = (aRequests: number, bRequests: number): PairedRequestCount[] =>
		Array.from({ length: 8 }, (_, taskIndex) =>
			Array.from({ length: 3 }, () => ({
				taskId: `T${taskIndex + 1}`,
				aRequests,
				bRequests,
				aGreen: true,
				bGreen: true,
			})),
		).flat() as PairedRequestCount[];

	test("computes medians and conservative zero-baseline percentage reductions", () => {
		expect(medianMetric([])).toBeNull();
		expect(medianMetric([1, 3, 5])).toBe(3);
		expect(medianMetric([1, 2, 5, 6])).toBe(3.5);
		expect(percentReduction(0, 0)).toBe(0);
		expect(percentReduction(0, 1)).toBe(-1);
		expect(percentReduction(4, 3)).toBe(0.25);
		expect(() => percentReduction(-1, 0)).toThrow(/finite non-negative/);
	});

	test("bootstraps complete task clusters deterministically and requires multiple clusters", () => {
		const pairs = repeatedPairs(4, 2);
		expect(
			taskClusteredBootstrap95CI(
				[{ taskId: "only", aRequests: 4, bRequests: 2, aGreen: true, bGreen: true }],
				9,
				20,
			),
		).toBeNull();
		expect(taskClusteredBootstrap95CI(pairs, 9, 100)).toEqual(taskClusteredBootstrap95CI(pairs, 9, 100));
		expect(taskClusteredBootstrap95CI(pairs, 9, 100)).toEqual({ lower: 2, upper: 2 });
	});

	test("applies inclusive request and percent thresholds but a strict positive CI lower bound", () => {
		const empty = summarizeDecision([], { seed: 3, iterations: 200 });
		expect(empty.medianPairedRequestReduction).toBeNull();
		expect(empty.bootstrap95CI).toBeNull();
		expect(empty.pass).toBe(false);
		const threshold = summarizeDecision(repeatedPairs(4, 3), { seed: 3, iterations: 200 });
		expect(threshold.medianPairedRequestReduction).toBe(1);
		expect(threshold.medianPairedPercentReduction).toBe(0.25);
		expect(threshold.armAGreenRate).toBe(1);
		expect(threshold.armBGreenRate).toBe(1);
		expect(threshold.completionRateDrop).toBe(0);
		expect(threshold.bootstrap95CI?.lower).toBe(1);
		expect(threshold.pass).toBe(true);
		const reducedCompletion = summarizeDecision(
			repeatedPairs(4, 3).map((pair, index) => (index < 3 ? { ...pair, bGreen: false } : pair)),
			{ seed: 3, iterations: 200 },
		);
		expect(reducedCompletion.completionRateDrop).toBeGreaterThan(0.1);
		expect(reducedCompletion.pass).toBe(false);
		const lowCompletion = summarizeDecision(
			repeatedPairs(4, 3).map((pair, index) => (index < 5 ? { ...pair, aGreen: false, bGreen: false } : pair)),
			{ seed: 3, iterations: 200 },
		);
		expect(lowCompletion.completionRateDrop).toBe(0);
		expect(lowCompletion.armBGreenRate).toBeLessThan(0.8);
		expect(lowCompletion.pass).toBe(false);
		const noReduction = summarizeDecision(repeatedPairs(0, 0), { seed: 3, iterations: 200 });
		expect(noReduction.bootstrap95CI?.lower).toBe(0);
		expect(noReduction.pass).toBe(false);
	});
});
