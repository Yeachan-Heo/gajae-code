import { describe, expect, it } from "bun:test";
import { validateToolArguments } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import * as themeModule from "@gajae-code/coding-agent/modes/theme/theme";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import {
	applyOpsToPhases,
	type TodoPhase,
	TodoWriteTool,
} from "@gajae-code/coding-agent/tools/implementations";
import { todoWriteToolRenderer } from "../../src/tools/todo-write";

function captureValidationError(run: () => void): string {
	try {
		run();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("Expected validation to throw");
}

function createSession(initialPhases: TodoPhase[] = []): ToolSession {
	let phases = initialPhases;
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
	};
}

async function getUiTheme() {
	await themeModule.initTheme(false, undefined, undefined, "red-claw", "blue-crab");
	const theme = await themeModule.getThemeByName("red-claw");
	if (!theme) throw new Error("Expected red-claw theme");
	return theme;
}

describe("TodoWriteTool auto-start behavior", () => {
	it("auto-starts the first task after init", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [{ phase: "Execution", items: ["status", "diagnostics"] }],
				},
			],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary from todo_write");
		expect(summary.text).toContain("Remaining items (2):");
		expect(summary.text).toContain("status [in_progress] (Execution)");
		expect(summary.text).toContain("diagnostics [pending] (Execution)");
	});

	it("auto-promotes the next pending task when current task is completed", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [{ phase: "Execution", items: ["status", "diagnostics"] }],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "done", task: "status" }] });

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary from todo_write");
		expect(summary.text).toContain("Remaining items (1):");
		expect(summary.text).toContain("diagnostics [in_progress] (Execution)");

		const completedResult = await tool.execute("call-3", { ops: [{ op: "done", task: "diagnostics" }] });
		const completedSummary = completedResult.content.find(part => part.type === "text");
		if (completedSummary?.type !== "text") {
			throw new Error("Expected text summary from todo_write");
		}
		expect(completedSummary.text).toContain("Remaining items: none.");
	});
});

describe("TodoWriteTool ops operations", () => {
	it("jumps to a specific task out of order", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [{ phase: "Phase A", items: ["first", "second", "third"] }],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "start", task: "third" }] });

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["pending", "pending", "in_progress"]);
	});

	it("demotes the current in_progress task when starting another", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [
						{ phase: "A", items: ["a1", "a2"] },
						{ phase: "B", items: ["b1"] },
					],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "start", task: "b1" }] });

		const allTasks = result.details?.phases.flatMap(phase => phase.tasks) ?? [];
		expect(allTasks.map(task => task.status)).toEqual(["pending", "pending", "in_progress"]);
	});

	it("appends items to an existing phase", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [{ op: "init", list: [{ phase: "Work", items: ["First"] }] }],
		});

		const result = await tool.execute("call-2", {
			ops: [
				{
					op: "append",
					phase: "Work",
					items: ["Second"],
				},
			],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => ({ content: task.content, status: task.status }))).toEqual([
			{ content: "First", status: "in_progress" },
			{ content: "Second", status: "pending" },
		]);
	});

	it("creates a phase when append targets a missing phase", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [{ op: "init", list: [{ phase: "Work", items: ["First"] }] }],
		});

		const result = await tool.execute("call-2", {
			ops: [
				{
					op: "append",
					phase: "Cleanup",
					items: ["Remove dead code"],
				},
			],
		});

		expect(result.details?.phases.map(phase => phase.name)).toEqual(["Work", "Cleanup"]);
		expect(result.details?.phases[1]?.tasks.map(task => task.content)).toEqual(["Remove dead code"]);
	});

	it("marks all tasks in a phase done", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [
						{ phase: "Work", items: ["First", "Second"] },
						{ phase: "Later", items: ["Third"] },
					],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "done", phase: "Work" }] });
		const allTasks = result.details?.phases.flatMap(phase => phase.tasks) ?? [];
		expect(allTasks.map(task => task.status)).toEqual(["completed", "completed", "in_progress"]);
	});

	it("rejects unsupported keys and does not treat a bare done as complete-all", async () => {
		const tool = new TodoWriteTool(createSession());
		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call-invalid",
				name: tool.name,
				arguments: { ops: [{ op: "done", id: "Second" }] },
			}),
		).toThrow('Validation failed for tool "todo_write"');
		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call-bare",
				name: tool.name,
				arguments: { ops: [{ op: "done" }] },
			}),
		).toThrow('Validation failed for tool "todo_write"');

		await tool.execute("call-1", {
			ops: [{ op: "init", list: [{ phase: "Work", items: ["First", "Second"] }] }],
		});
		const result = await tool.execute("call-2", { ops: [{ op: "done" }] });

		expect(result.isError).toBe(true);
		expect(result.details?.phases[0]?.tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Missing task or phase for done operation");

		const slashResult = applyOpsToPhases(result.details?.phases ?? [], [{ op: "done" }]);
		expect(slashResult.phases[0]?.tasks.map(task => task.status)).toEqual(["completed", "completed"]);
	});

	it("removes all tasks when rm omits task and phase", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [{ phase: "Work", items: ["First", "Second"] }],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "rm" }] });
		expect(result.details?.phases[0]?.tasks).toEqual([]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Todo list cleared.");
	});

	it("drops all tasks in a phase", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [{ phase: "Work", items: ["First", "Second"] }],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "drop", phase: "Work" }] });
		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["abandoned", "abandoned"]);
	});
});

describe("TodoWriteTool raw argument rejection codes", () => {
	const tool = new TodoWriteTool(createSession());
	const call = (arguments_: Record<string, unknown>) => ({
		type: "toolCall" as const,
		id: "call-raw",
		name: tool.name,
		arguments: arguments_,
	});

	it("rejects an unknown root key with the root-shape correction", () => {
		expect(() => validateToolArguments(tool, call({ ops: [{ op: "done", task: "x" }], extraRootKey: true }))).toThrow(
			"todo_write root accepts only an ops array of operation entries",
		);
	});

	it("rejects an unknown operation-entry key with the entry-shape correction", () => {
		const message = captureValidationError(() =>
			validateToolArguments(tool, call({ ops: [{ op: "done", task: "x", bogusOpKey: "y" }] })),
		);
		expect(message).toContain("todo_write operation entries accept only op, list, task, phase, items, and text keys");
		expect(message).not.toContain("bogusOpKey");
	});

	it("rejects a done entry without a task or phase target", () => {
		expect(() => validateToolArguments(tool, call({ ops: [{ op: "done" }] }))).toThrow(
			"todo_write done and drop entries require a task or phase target",
		);
	});

	it("rejects a drop entry without a task or phase target", () => {
		expect(() => validateToolArguments(tool, call({ ops: [{ op: "drop" }] }))).toThrow(
			"todo_write done and drop entries require a task or phase target",
		);
	});

	it("rejects an unknown init list-entry key with the init-shape correction", () => {
		const message = captureValidationError(() =>
			validateToolArguments(
				tool,
				call({ ops: [{ op: "init", list: [{ phase: "Execution", items: ["status"], bogusInitKey: 1 }] }] }),
			),
		);
		expect(message).toContain("todo_write init list entries accept only phase and items keys");
		expect(message).not.toContain("bogusInitKey");
	});

	it("keeps valid payloads accepted at the validation boundary", () => {
		const parsed = validateToolArguments(
			tool,
			call({ ops: [{ op: "init", list: [{ phase: "Execution", items: ["status"] }] }] }),
		) as { ops: Array<{ op: string; list?: Array<{ phase: string; items: string[] }> }> };
		expect(parsed.ops[0]?.op).toBe("init");
		expect(parsed.ops[0]?.list?.[0]).toEqual({ phase: "Execution", items: ["status"] });

		expect(() => validateToolArguments(tool, call({ ops: [{ op: "done", task: "status" }] }))).not.toThrow();
		expect(() => validateToolArguments(tool, call({ ops: [{ op: "drop", phase: "Execution" }] }))).not.toThrow();
	});

	it("keeps passthrough behavior for non-array ops instead of a raw rejection", () => {
		const message = captureValidationError(() => validateToolArguments(tool, call({ ops: "not-an-array" })));
		expect(message).toContain('Validation failed for tool "todo_write"');
		expect(message).not.toContain("raw arguments rejected before coercion");
	});
});

describe("TodoWriteTool renderer", () => {
	it("renders persistence failures as errors without showing rejected phases", async () => {
		const uiTheme = await getUiTheme();
		const component = todoWriteToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Todo state persistence failed: disk failed" }],
				details: {
					phases: [{ name: "Work", tasks: [{ content: "Rejected task", status: "in_progress" }] }],
					storage: "session",
					failureKind: "persistence",
				},
				isError: true,
			},
			{ expanded: true, isPartial: false },
			uiTheme,
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("Todo state persistence failed: disk failed");
		expect(rendered).not.toContain("Rejected task");
	});
});
