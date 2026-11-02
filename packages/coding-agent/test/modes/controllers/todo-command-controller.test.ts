import { afterEach, describe, expect, it, vi } from "bun:test";
import { TodoCommandController } from "@gajae-code/coding-agent/modes/controllers/todo-command-controller";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import {
	phasesToMarkdown,
	type TodoPhase,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@gajae-code/coding-agent/tools/todo-write";
import fc from "fast-check";

const OSC_52 = "\u001b]52;c;c2VjcmV0\u0007";
const OSC_0 = "\u001b]0;evil title\u0007";
const OSC_8 = "\u001b]8;;http://evil.example\u0007link\u001b]8;;\u0007";

function controllerFor(phases: TodoPhase[]) {
	const showStatus = vi.fn();
	const showError = vi.fn();
	const entries =
		phases.length === 0
			? []
			: [
					{
						type: "custom" as const,
						customType: USER_TODO_EDIT_CUSTOM_TYPE,
						data: { phases },
					},
				];
	const ctx = {
		sessionManager: {
			getBranch: () => entries,
			appendCustomEntry: vi.fn(),
			appendMessage: vi.fn(),
		},
		session: {
			getTodoPhases: () => [],
			setTodoPhases: vi.fn(),
		},
		setTodos: vi.fn(),
		agent: { appendMessage: vi.fn() },
		showStatus,
		showError,
	} as unknown as InteractiveModeContext;
	return { controller: new TodoCommandController(ctx), showStatus, showError, entries };
}

const DISPLAY_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

function isDisplaySafe(text: string): boolean {
	return text.toWellFormed() === text && !DISPLAY_CONTROL.test(text);
}

function shownText(showStatus: ReturnType<typeof vi.fn>): string {
	expect(showStatus).toHaveBeenCalledTimes(1);
	const text = showStatus.mock.calls[0]?.[0];
	expect(typeof text).toBe("string");
	return text as string;
}

describe("/todo status display", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("strips an OSC sequence from a session todo task before showing the list", async () => {
		const phases: TodoPhase[] = [
			{
				name: `Ph${OSC_0}ase`,
				tasks: [
					{
						content: `Ship${OSC_52}\u001b[2Jit`,
						status: "pending",
						notes: [`see ${OSC_8} end`],
					},
				],
			},
		];
		const { controller, showStatus, showError, entries } = controllerFor(phases);

		await controller.handleTodoCommand("");

		const shown = shownText(showStatus);
		expect(shown).not.toContain("\u001b");
		expect(shown).not.toContain("c2VjcmV0");
		expect(shown).not.toContain("evil.example");
		expect(shown).not.toContain("evil title");
		expect(shown).toContain("# Phase");
		expect(shown).toContain("- [ ] Shipit");
		expect(shown).toContain("see link end");
		expect(showError).not.toHaveBeenCalled();
		expect(entries[0]?.data.phases[0]?.tasks[0]?.content).toContain(OSC_52);
	});

	it("shows an ordinary phase, task, and multiline note unchanged", async () => {
		const phases: TodoPhase[] = [
			{
				name: "Docs",
				tasks: [
					{
						content: "Write  the report\tand more",
						status: "pending",
						notes: ["line one\nline two", "second note"],
					},
				],
			},
		];
		const { controller, showStatus, showError } = controllerFor(phases);

		await controller.handleTodoCommand("");

		expect(shownText(showStatus)).toBe(phasesToMarkdown(phases).trimEnd());
		expect(showError).not.toHaveBeenCalled();
	});

	it("shows the empty-list status when the session has no todos", async () => {
		const { controller, showStatus } = controllerFor([]);

		await controller.handleTodoCommand("");

		expect(shownText(showStatus)).toBe("No todos. Use /todo append <task> to start one.");
	});

	it("strips an OSC sequence when /todo start echoes a stored task", async () => {
		const phases: TodoPhase[] = [
			{
				name: "Docs",
				tasks: [{ content: `Ship${OSC_52}it`, status: "pending" }],
			},
		];
		const { controller, showStatus, showError } = controllerFor(phases);

		await controller.handleTodoCommand("start Ship");

		const shown = shownText(showStatus);
		expect(shown).not.toContain("\u001b");
		expect(shown).not.toContain("c2VjcmV0");
		expect(shown).toBe("Started: Shipit");
		expect(showError).not.toHaveBeenCalled();
	});

	it("echoes an ordinary /todo start and /todo append unchanged", async () => {
		const phases: TodoPhase[] = [
			{
				name: "Docs",
				tasks: [{ content: "Write the report", status: "pending" }],
			},
		];
		const { controller, showStatus, showError } = controllerFor(phases);

		await controller.handleTodoCommand("start Write");
		expect(shownText(showStatus)).toBe("Started: Write the report");

		showStatus.mockClear();
		await controller.handleTodoCommand('append "extra task"');
		expect(shownText(showStatus)).toBe("Appended to Docs: Extra task");
		expect(showError).not.toHaveBeenCalled();
	});

	it("property: todo status strips controls and keeps safe text, fc.property seed 693, numRuns 128", () => {
		const safeText = fc
			.array(
				fc.oneof(
					fc.integer({ min: 32, max: 126 }).map(code => String.fromCharCode(code)),
					fc.constant("\t"),
					fc.constant("\n"),
				),
				{ maxLength: 24 },
			)
			.map(chars => chars.join(""));
		const attack = fc.constantFrom(
			"",
			"\u001b]52;c;c2VjcmV0\u0007",
			"\u001b]0;title\u0007",
			"\u001b]8;;http://example.test\u0007x\u001b]8;;\u0007",
			"\u001b[31m",
			"\u001b[2J",
			"\u001b",
			"\u001b[",
			"\u001b]52;c;QQ",
			"\u0000",
			"\r",
			"\u009b2J",
			"\u009d0;title\u009c",
		);
		const field = fc
			.tuple(safeText, attack, safeText)
			.map(([prefix, injected, suffix]) => prefix + injected + suffix);
		fc.assert(
			fc.property(field, field, field, (name, content, note) => {
				const phases: TodoPhase[] = [{ name, tasks: [{ content, status: "pending", notes: [note] }] }];
				const { controller, showStatus, entries } = controllerFor(phases);
				void controller.handleTodoCommand("");
				const shown = showStatus.mock.calls[0]?.[0];
				if (typeof shown !== "string" || DISPLAY_CONTROL.test(shown)) return false;
				const stored = entries[0]?.data.phases[0];
				if (stored?.name !== name || stored.tasks[0]?.content !== content || stored.tasks[0]?.notes?.[0] !== note) {
					return false;
				}
				if (isDisplaySafe(name) && isDisplaySafe(content) && isDisplaySafe(note)) {
					return shown === phasesToMarkdown(phases).trimEnd();
				}
				return true;
			}),
			{ seed: 693, numRuns: 128 },
		);
	});
});
