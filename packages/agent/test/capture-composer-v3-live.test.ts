import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { seedScenarioWorkdir } from "../bench/composer-live-fixtures";
import {
	buildTraceRecord,
	sessionLinesToTraceEvents,
	traceExpectationForScenario,
} from "../bench/composer-print-trace";
import { COMPOSER_SCENARIOS, type ScenarioId } from "../bench/composer-scenarios";
import { classifyTraceRecord } from "../bench/composer-stability-v3";
import "../bench/capture-composer-v3-live";

const PROMPT_PATH_RE =
	/\b(?:fixtures\/[A-Za-z0-9._{},*?/-]+|docs\/[A-Za-z0-9._{},*?/-]+|packages\/agent\/test\/fixtures\/[A-Za-z0-9._{},*?/-]+)/g;

function extractPromptFixturePaths(prompt: string): string[] {
	return Array.from(prompt.matchAll(PROMPT_PATH_RE), match => match[0].replace(/[,).]+$/, ""));
}

const MUTATION_TARGET_SCENARIOS = [
	{ id: "read-edit-hashline", targetPath: "fixtures/workspace/src/foo.ts" },
	{ id: "three-turn-tools", targetPath: "fixtures/workspace/src/a.ts" },
	{ id: "shell-write-discipline", targetPath: "fixtures/workspace/src/write-target.ts" },
	{ id: "multi-file-search-edit", targetPath: "fixtures/workspace/src/pkg/alpha.ts" },
	{ id: "multi-file-search-edit-bad-anchor", targetPath: "fixtures/workspace/src/target.ts" },
	{ id: "bad-anchor-recovery", targetPath: "fixtures/workspace/src/recover.ts" },
	{ id: "multi-turn-yield-discipline", targetPath: "fixtures/workspace/src/multi.ts" },
	{ id: "wrong-target-disambiguation", targetPath: "fixtures/workspace/src/disambiguation/target.ts" },
	{ id: "malformed-edit-recovery", targetPath: "fixtures/workspace/src/malformed-edit.ts" },
] as const satisfies readonly { id: ScenarioId; targetPath: string }[];
const MUTATION_TARGET_SCENARIO_CASES = MUTATION_TARGET_SCENARIOS.map(({ id, targetPath }) => [id, targetPath] as const);

function successfulMutationEvents(scenarioId: ScenarioId, targetPath: string): Record<string, unknown>[] {
	const expected = traceExpectationForScenario(scenarioId);
	const events: Record<string, unknown>[] = (expected.requiredTools ?? [])
		.filter(toolName => toolName !== "edit" && toolName !== "write" && toolName !== "apply_patch")
		.map(toolName => ({
			type: "tool_execution_end",
			toolName,
			status: "success",
			arguments:
				toolName === "read" ? { path: targetPath } : { query: expected.expectedEditText ?? "mutation-target" },
		}));
	events.push({
		type: "tool_execution_end",
		toolName: "edit",
		status: "success",
		arguments: { path: targetPath, input: expected.expectedEditText ?? "mutation-target" },
	});
	events.push({ type: "scenario_result", status: "passed" });
	return events;
}

async function promptPathExists(workdir: string, promptPath: string): Promise<boolean> {
	if (promptPath.includes("*") || promptPath.includes("{")) {
		const wildcardIndex = promptPath.search(/[*{]/);
		const prefix = promptPath.slice(0, wildcardIndex);
		const dir = prefix.endsWith("/") ? prefix.slice(0, -1) : path.dirname(prefix);
		const entries = await fs.readdir(path.join(workdir, dir)).catch(() => []);
		return entries.length > 0;
	}
	return fs.stat(path.join(workdir, promptPath)).then(
		stat => stat.isFile() || stat.isDirectory(),
		() => false,
	);
}

describe("composer-live-fixtures", () => {
	it("seeds bash-discipline workdir", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "composer-live-"));
		await seedScenarioWorkdir(dir, "bash-discipline");
		const text = await fs.readFile(path.join(dir, "fixtures", "workspace", "src", "secret.ts"), "utf8");
		expect(text).toContain("LIVE_SECRET");
	});

	it("seeds composer-scenarios-v2 workdirs", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "composer-live-v2-"));
		await seedScenarioWorkdir(dir, "wrong-target-disambiguation");
		await seedScenarioWorkdir(dir, "cost-safe-timeout");
		const target = await fs.readFile(
			path.join(dir, "fixtures", "workspace", "src", "disambiguation", "target.ts"),
			"utf8",
		);
		const timeoutFixture = await fs.readFile(
			path.join(dir, "fixtures", "transcripts", "cost-safe-timeout", "sample.json"),
			"utf8",
		);
		expect(target).toContain("EXACT_TARGET");
		expect(timeoutFixture.trim()).toBe("{}");
	});
	it("seeds every literal fixture path referenced by scenario prompts", async () => {
		const missing: string[] = [];
		for (const scenario of COMPOSER_SCENARIOS) {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), `composer-live-${scenario.id}-`));
			await seedScenarioWorkdir(dir, scenario.id);
			for (const promptPath of extractPromptFixturePaths(scenario.userPrompt)) {
				if (!(await promptPathExists(dir, promptPath))) {
					missing.push(`${scenario.id}: ${promptPath}`);
				}
			}
		}

		expect(missing).toEqual([]);
	});
});

describe("capture-composer-v3-live dry-run", () => {
	it("prints L3 planning metadata without running live sessions", async () => {
		const proc = Bun.spawn(
			[
				process.execPath,
				"packages/agent/bench/capture-composer-v3-live.ts",
				"--dry-run",
				"--k",
				"3",
				"--scenarios",
				"bash-discipline",
				"--model",
				"grok-build/grok-composer-2.5-fast",
				"--baseline-model",
				"openai-codex/gpt-5.5:low",
			],
			{ cwd: path.resolve(import.meta.dir, "../../..") },
		);
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		expect(await proc.exited).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).not.toContain(path.resolve(import.meta.dir, "../../.."));

		const payload = JSON.parse(stdout) as {
			composer_scenarios_version: string;
			capture_mode: string;
			k: number;
			planned_records: number;
			candidate_model: string;
			baseline_model: string;
		};
		expect(payload.composer_scenarios_version).toBe("v2");
		expect(payload.capture_mode).toBe("print");
		expect(payload.k).toBe(3);
		expect(payload.planned_records).toBe(6);
		expect(payload.candidate_model).toBe("grok-build/grok-composer-2.5-fast");
		expect(payload.baseline_model).toBe("openai-codex/gpt-5.5:low");
	});
});

describe("composer-print-trace", () => {
	it("converts session toolResult to tool_execution_end", () => {
		const lines = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "read", arguments: { path: "src/secret.ts" } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: "ok\n" }],
				},
			},
		];
		const events = sessionLinesToTraceEvents(lines as never, 0);
		expect(events.some(e => e.type === "tool_execution_end" && e.toolName === "read")).toBe(true);
		expect(events.at(-1)).toEqual({ type: "scenario_result", status: "passed" });
	});
	it("uses prompted target paths for every mutation-obligation trace expectation", () => {
		for (const { id, targetPath } of MUTATION_TARGET_SCENARIOS) {
			const expected = traceExpectationForScenario(id);
			expect(expected.targetPath).toBe(targetPath);
			expect(expected).not.toEqual({ requireSuccess: true });
		}
	});

	it.each(MUTATION_TARGET_SCENARIO_CASES)("classifies prompted target-path edit as pass for %s", (id, targetPath) => {
		const record = buildTraceRecord({
			scenarioId: id,
			modelRole: "candidate",
			model: "grok-build/grok-composer-2.5-fast",
			trial: 0,
			events: successfulMutationEvents(id, targetPath),
			tracePath: "/tmp/trace.json",
			expected: traceExpectationForScenario(id),
		});
		const classified = classifyTraceRecord(record);
		expect(classified.status).toBe("passed");
		expect(classified.failureClasses).toEqual([]);
	});

	it.each(MUTATION_TARGET_SCENARIO_CASES)("classifies terminal-only mutation trace as failure for %s", id => {
		const record = buildTraceRecord({
			scenarioId: id,
			modelRole: "candidate",
			model: "grok-build/grok-composer-2.5-fast",
			trial: 0,
			events: [{ type: "scenario_result", status: "passed" }],
			tracePath: "/tmp/trace.json",
			expected: traceExpectationForScenario(id),
		});
		const classified = classifyTraceRecord(record);
		expect(classified.status).toBe("failed");
		expect(classified.failureClasses).toContain("missing-tool-turn");
	});

	it.each(
		MUTATION_TARGET_SCENARIO_CASES,
	)("classifies missing target-path edit as failure for %s", (id, targetPath) => {
		const record = buildTraceRecord({
			scenarioId: id,
			modelRole: "candidate",
			model: "grok-build/grok-composer-2.5-fast",
			trial: 0,
			events: [
				{ type: "tool_execution_end", toolName: "read", status: "success", arguments: { path: targetPath } },
				{ type: "scenario_result", status: "passed" },
			],
			tracePath: "/tmp/trace.json",
			expected: traceExpectationForScenario(id),
		});
		const classified = classifyTraceRecord(record);
		expect(classified.status).toBe("failed");
		expect(classified.failureClasses).toContain("missing-tool-turn");
	});

	it.each(MUTATION_TARGET_SCENARIO_CASES)("classifies wrong target-path edit as failure for %s", (id, targetPath) => {
		const record = buildTraceRecord({
			scenarioId: id,
			modelRole: "candidate",
			model: "grok-build/grok-composer-2.5-fast",
			trial: 0,
			events: [
				...successfulMutationEvents(id, targetPath).filter(
					event => event.type !== "scenario_result" && event.toolName !== "edit",
				),
				{
					type: "tool_execution_end",
					toolName: "edit",
					status: "success",
					arguments: { path: `${targetPath}.wrong` },
				},
				{ type: "scenario_result", status: "passed" },
			],
			tracePath: "/tmp/trace.json",
			expected: traceExpectationForScenario(id),
		});
		const classified = classifyTraceRecord(record);
		expect(classified.status).toBe("failed");
		expect(classified.failureClasses).toEqual(["missing-tool-turn", "wrong-file-edit"]);
	});

	it.each(
		MUTATION_TARGET_SCENARIO_CASES,
	)("classifies wrong-content target edit as failure for %s", (id, targetPath) => {
		const record = buildTraceRecord({
			scenarioId: id,
			modelRole: "candidate",
			model: "grok-build/grok-composer-2.5-fast",
			trial: 0,
			events: [
				...successfulMutationEvents(id, targetPath).filter(
					event => event.type !== "scenario_result" && event.toolName !== "edit",
				),
				{
					type: "tool_execution_end",
					toolName: "edit",
					status: "success",
					arguments: { path: targetPath, input: "NO_OP_MUTATION" },
				},
				{ type: "scenario_result", status: "passed" },
			],
			tracePath: "/tmp/trace.json",
			expected: traceExpectationForScenario(id),
		});
		const classified = classifyTraceRecord(record);
		expect(classified.status).toBe("failed");
		expect(classified.failureClasses).toEqual(["missing-tool-turn"]);
	});

	it.each(
		MUTATION_TARGET_SCENARIO_CASES,
	)("classifies target-only expectation wrong-content edit as failure for %s", (id, targetPath) => {
		const record = buildTraceRecord({
			scenarioId: id,
			modelRole: "candidate",
			model: "grok-build/grok-composer-2.5-fast",
			trial: 0,
			events: [
				...successfulMutationEvents(id, targetPath).filter(
					event => event.type !== "scenario_result" && event.toolName !== "edit",
				),
				{
					type: "tool_execution_end",
					toolName: "edit",
					status: "success",
					arguments: { path: targetPath, input: "NO_OP_MUTATION" },
				},
				{ type: "scenario_result", status: "passed" },
			],
			tracePath: "/tmp/trace.json",
			expected: { targetPath, requireSuccess: true },
		});
		const classified = classifyTraceRecord(record);
		expect(classified.status).toBe("failed");
		expect(classified.failureClasses).toEqual(["missing-tool-turn"]);
	});

	it.each(MUTATION_TARGET_SCENARIO_CASES)("classifies failed target-path edit as failure for %s", (id, targetPath) => {
		const record = buildTraceRecord({
			scenarioId: id,
			modelRole: "candidate",
			model: "grok-build/grok-composer-2.5-fast",
			trial: 0,
			events: [
				...successfulMutationEvents(id, targetPath).filter(
					event => event.type !== "scenario_result" && event.toolName !== "edit",
				),
				{ type: "tool_execution_end", toolName: "edit", status: "error", arguments: { path: targetPath } },
				{ type: "scenario_result", status: "passed" },
			],
			tracePath: "/tmp/trace.json",
			expected: traceExpectationForScenario(id),
		});
		const classified = classifyTraceRecord(record);
		expect(classified.status).toBe("failed");
		expect(classified.failureClasses).toEqual(["missing-tool-turn"]);
	});

	it("classifies converted bash-discipline trace as pass", () => {
		const record = buildTraceRecord({
			scenarioId: "bash-discipline",
			modelRole: "candidate",
			model: "grok-build/grok-composer-2.5-fast",
			trial: 0,
			events: [
				{ type: "tool_execution_end", toolName: "read", status: "success" },
				{ type: "scenario_result", status: "passed" },
			],
			tracePath: "/tmp/trace.json",
			expected: traceExpectationForScenario("bash-discipline"),
		});
		const classified = classifyTraceRecord(record);
		expect(classified.status).toBe("passed");
	});
});
