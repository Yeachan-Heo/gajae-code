import { describe, expect, it } from "bun:test";
import { validateToolArguments } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import * as themeModule from "@gajae-code/coding-agent/modes/theme/theme";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { applyOpsToPhases, type TodoPhase, TodoWriteTool } from "@gajae-code/coding-agent/tools/implementations";
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

	const REJECTED = 'Validation failed for tool "todo_write": raw arguments rejected before coercion';

	it("names the unknown root key alongside the root-shape correction", () => {
		const message = captureValidationError(() =>
			validateToolArguments(tool, call({ ops: [{ op: "done", task: "x" }], extraRootKey: true })),
		);
		expect(message).toBe(
			`${REJECTED}; todo_write root accepts only an ops array of operation entries; rejected key: "extraRootKey"`,
		);
	});

	it("names a note key without emitting an incomplete replacement", () => {
		const message = captureValidationError(() =>
			validateToolArguments(tool, call({ ops: [{ op: "note", note: "why this plan" }] })),
		);
		expect(message).toBe(
			`${REJECTED}; todo_write operation entries accept only op, list, task, phase, items, and text keys; rejected key: "note" (ops[0]; note is an op, not a key; note operations require both "task" and "text")`,
		);
		expect(message).not.toContain('use { op: "note", text: "..." }');
	});

	it("rejects the incomplete note shape for missing task content", async () => {
		const result = await tool.execute("call-note", { ops: [{ op: "note", text: "why this plan" }] });
		const first = result.content?.[0];
		const text = first?.type === "text" ? first.text : "";
		expect(text).toContain("Missing task content");
		expect(text).toContain("Todo update was not applied");
	});

	it("names an unknown operation-entry key without inventing a replacement for it", () => {
		const message = captureValidationError(() =>
			validateToolArguments(tool, call({ ops: [{ op: "done", task: "x", bogusOpKey: "y" }] })),
		);
		expect(message).toBe(
			`${REJECTED}; todo_write operation entries accept only op, list, task, phase, items, and text keys; rejected key: "bogusOpKey" (ops[0])`,
		);
	});

	it("names every unknown key when an operation entry carries several", () => {
		const message = captureValidationError(() =>
			validateToolArguments(tool, call({ ops: [{ op: "done", task: "x", alpha: 1, beta: 2 }] })),
		);
		expect(message).toBe(
			`${REJECTED}; todo_write operation entries accept only op, list, task, phase, items, and text keys; rejected keys: "alpha", "beta" (ops[0])`,
		);
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

	it("names the unknown init list-entry key alongside the init-shape correction", () => {
		const message = captureValidationError(() =>
			validateToolArguments(
				tool,
				call({ ops: [{ op: "init", list: [{ phase: "Execution", items: ["status"], bogusInitKey: 1 }] }] }),
			),
		);
		expect(message).toBe(
			`${REJECTED}; todo_write init list entries accept only phase and items keys; rejected key: "bogusInitKey" (ops[0].list[0])`,
		);
	});

	it("still accepts content as the task alias instead of naming it as rejected", () => {
		const parsed = validateToolArguments(tool, call({ ops: [{ op: "done", content: "ship it" }] })) as {
			ops: Array<{ op: string; task?: string }>;
		};
		expect(parsed.ops[0]).toEqual({ op: "done", task: "ship it" });
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

	it("accepts the injected intent field alongside ops", () => {
		const parsed = validateToolArguments(
			tool,
			call({ _i: "Tracking progress", ops: [{ op: "done", task: "status" }] }),
		) as { ops: Array<{ op: string; task?: string }> };
		expect(parsed.ops[0]).toEqual({ op: "done", task: "status" });
	});

	it("still rejects an unknown root key when the intent field is present", () => {
		expect(() =>
			validateToolArguments(tool, call({ _i: "Tracking progress", ops: [{ op: "done", task: "x" }], stray: 1 })),
		).toThrow("todo_write root accepts only an ops array of operation entries");
	});

	it("names the legal operation vocabulary when an entry invents an op", () => {
		const message = captureValidationError(() =>
			validateToolArguments(tool, call({ ops: [{ op: "retitle", task: "x" }] })),
		);
		expect(message).toBe(
			`${REJECTED}; todo_write operation entries require a known op value; rejected key: "retitle" (ops[0]; op must be one of: init, start, done, rm, drop, append, note)`,
		);
	});

	it("reports the invented op ahead of the unknown key the same entry carries", () => {
		const message = captureValidationError(() =>
			validateToolArguments(tool, call({ ops: [{ op: "retitle", task: "x", newTask: "y" }] })),
		);
		expect(message).toContain("todo_write operation entries require a known op value");
		expect(message).toContain("op must be one of: init, start, done, rm, drop, append, note");
		expect(message).not.toContain("accept only op, list, task, phase, items, and text keys");
	});

	it("names the failing entry index so the surviving entries can be resubmitted", () => {
		const message = captureValidationError(() =>
			validateToolArguments(
				tool,
				call({
					ops: [
						{ op: "append", phase: "Work", items: ["ship it"] },
						{ op: "done", task: "first" },
						{ op: "done", task: "second" },
						{ op: "done", task: "third" },
						{ op: "retitle", task: "third", newTask: "fourth" },
					],
				}),
			),
		);
		expect(message).toContain("ops[4]");
		expect(message).not.toContain("ops[0]");
		expect(message).not.toContain("ops[3]");
	});

	it("points the newTask correction at re-init instead of a rename op", () => {
		const message = captureValidationError(() =>
			validateToolArguments(tool, call({ ops: [{ op: "start", task: "x", newTask: "y" }] })),
		);
		expect(message).toBe(
			`${REJECTED}; todo_write operation entries accept only op, list, task, phase, items, and text keys; rejected key: "newTask" (ops[0]; there is no rename op; re-run init with the corrected list to rename a task)`,
		);
		expect(message).not.toContain("retitle");
	});

	it("routes the tasks key to the items key append actually takes", () => {
		const message = captureValidationError(() =>
			validateToolArguments(tool, call({ ops: [{ op: "append", phase: "Work", tasks: ["ship it"] }] })),
		);
		expect(message).toContain('rejected key: "tasks" (ops[0]; tasks is not a key; append operations take "items")');
	});

	it("keeps complete and completed aliased to done instead of rejecting them as unknown ops", () => {
		for (const op of ["complete", "completed"]) {
			const parsed = validateToolArguments(tool, call({ ops: [{ op, task: "ship it" }] })) as {
				ops: Array<{ op: string; task?: string }>;
			};
			expect(parsed.ops[0]).toEqual({ op: "done", task: "ship it" });
		}
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

describe("TodoWriteTool operation aliases", () => {
	const parse = (ops: unknown) => new TodoWriteTool(createSession()).parameters.safeParse({ ops });

	it('accepts "complete" and "completed" as aliases for the "done" operation', () => {
		// The status this operation sets is spelled `completed`, so models reach for
		// `complete`/`completed` and used to hit a hard tool failure mid-turn.
		for (const alias of ["complete", "completed"]) {
			const result = parse([{ op: alias, task: "ship it" }]);
			expect(result.success).toBe(true);
			if (result.success) expect(result.data.ops[0]?.op).toBe("done");
		}
	});

	it('still accepts the canonical "done" operation', () => {
		const result = parse([{ op: "done", task: "ship it" }]);
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.ops[0]?.op).toBe("done");
	});

	it("still rejects operations outside the accepted vocabulary", () => {
		expect(parse([{ op: "finish", task: "ship it" }]).success).toBe(false);
	});

	it("still requires a target when an aliased completion names no task or phase", () => {
		const tool = new TodoWriteTool(createSession());
		expect(tool.rawArgumentValidation({ ops: [{ op: "complete" }] })).toMatchObject({ outcome: "reject" });
	});

	it('accepts "content" as a synonym for "task"', () => {
		// TodoItem stores and renders the task as `content`, so models emit `content`
		// and used to be rejected as an unknown key before coercion could repair it.
		const tool = new TodoWriteTool(createSession());
		expect(tool.rawArgumentValidation({ ops: [{ op: "done", content: "ship it" }] })).toMatchObject({
			outcome: "passthrough",
		});
		const result = parse([{ op: "done", content: "ship it" }]);
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.ops[0]).toMatchObject({ op: "done", task: "ship it" });
	});

	it("still rejects genuinely unknown operation-entry keys", () => {
		const tool = new TodoWriteTool(createSession());
		expect(tool.rawArgumentValidation({ ops: [{ op: "done", title: "ship it" }] })).toMatchObject({
			outcome: "reject",
		});
	});

	it("still requires a target when a content-only completion names nothing", () => {
		const tool = new TodoWriteTool(createSession());
		expect(tool.rawArgumentValidation({ ops: [{ op: "done", content: "" }] })).toMatchObject({ outcome: "reject" });
	});

	it("tells the model how to address a task when a completion arrives with no target", async () => {
		// Models send a positional handle (`id: "1"`); it is stripped as an unknown key,
		// leaving a targetless op. The message has to name what actually works.
		const tool = new TodoWriteTool(
			createSession([{ name: "Implementation", tasks: [{ content: "Apply fix", status: "pending" }] }]),
		);
		const result = await tool.execute("call-target", { ops: [{ op: "done" }] });
		expect(result.isError).toBe(true);
		const text = result.content.map(block => ("text" in block ? block.text : "")).join("\n");
		expect(text).toContain('Pass "task" with the task\'s exact content');
		expect(text).toContain("never by number or id");
	});
});
