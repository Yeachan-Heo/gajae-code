import { describe, expect, test } from "bun:test";
import type { DesktopSession, DesktopTodoPhase } from "@gajae-code/desktop-host/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionWorkProgress, sessionWorkLabel } from "../src/SessionWorkProgress";
import { TODO_TASK_LIMIT, TodoPanel, TodoPhaseList, todoProgress } from "../src/TodoPanel";

const phases: DesktopTodoPhase[] = [
	{
		name: "Foundation",
		tasks: [
			{ content: "Read the host", status: "completed" },
			{ content: "Project notes", status: "in_progress", notes: ["Checked the SDK shape.", "Second line\nkept apart."] },
			{ content: "Drop a dead end", status: "abandoned", notes: ["Not needed."] },
		],
	},
	{ name: "", tasks: [{ content: "Render the panel", status: "pending" }] },
];

function texts(html: string, className: string): string[] {
	return [...html.matchAll(new RegExp(`class="${className}"[^>]*>([^<]*)<`, "gu"))].map(match => match[1] ?? "");
}

describe("TodoPanel", () => {
	test("counts completed and abandoned tasks as finished and names the task in flight", () => {
		expect(todoProgress(phases)).toEqual({ done: 2, total: 4, active: phases[0]!.tasks[1] });
		expect(todoProgress(undefined)).toEqual({ done: 0, total: 0, active: undefined });
	});

	test("collapsed it states progress, the task in flight and a decorative progress bar", () => {
		const html = renderToStaticMarkup(<TodoPanel phases={phases} />);
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain("2/4 tasks done");
		expect(html).toContain("<small>Project notes</small>");
		expect(html).toMatch(/<span class="todo-progress" aria-hidden="true"><span style="width:50%"><\/span><\/span>/u);
		expect(html).not.toContain("todo-task");
		expect(html).not.toContain("Checked the SDK shape.");
	});

	test("a finished list fills the bar and marks it complete", () => {
		const done: DesktopTodoPhase[] = [{ name: "Only", tasks: [{ content: "Ship", status: "completed" }] }];
		const html = renderToStaticMarkup(<TodoPanel phases={done} />);
		expect(html).toContain('class="todo-progress complete"');
		expect(html).toContain("width:100%");
	});

	test("renders nothing for a list without tasks", () => {
		expect(renderToStaticMarkup(<TodoPanel phases={[]} />)).toBe("");
		expect(renderToStaticMarkup(<TodoPanel phases={[{ name: "Empty", tasks: [] }]} />)).toBe("");
	});

	test("expanded it lists every phase with its own progress and every task with a spoken status", () => {
		const html = renderToStaticMarkup(<TodoPanel phases={phases} defaultOpen />);
		expect(html).toContain('aria-expanded="true"');
		// The phase number comes from a CSS counter, so the heading text stays the phase name.
		expect([...html.matchAll(/<h3>([^<]*)<\/h3>/gu)].map(match => match[1])).toEqual([
			"Foundation",
			"Untitled phase",
		]);
		expect(html).toContain('<span aria-hidden="true">2/3</span><span class="sr-only">2 of 3 done</span>');
		expect(html).toContain('<span aria-hidden="true">0/1</span><span class="sr-only">0 of 1 done</span>');
		expect(texts(html, "todo-task-text")).toEqual(["Read the host", "Project notes", "Drop a dead end", "Render the panel"]);
		for (const label of ["Done", "In progress", "Abandoned", "Pending"])
			expect(html).toContain(`role="img" aria-label="${label}"`);
		// The summary no longer repeats the task in flight once the list itself is visible.
		expect(html).not.toContain("<small>");
	});

	test("shows the note count on every task and the notes of the task in flight only", () => {
		const html = renderToStaticMarkup(<TodoPanel phases={phases} defaultOpen />);
		expect(html).toContain('title="Notes: 2"');
		expect(html).toContain('<span class="sr-only">Notes: 2</span>');
		expect(html).toContain('title="Notes: 1"');
		expect(html.match(/class="todo-notes"/gu)).toHaveLength(1);
		expect(html).toContain('<ul class="todo-notes" aria-label="Notes"><li>Checked the SDK shape.</li><li>Second line\nkept apart.</li></ul>');
		expect(html).not.toContain("<li>Not needed.</li>");
	});

	test("a full set of notes is shown as a lower bound, since the Host keeps only the newest five", () => {
		const full: DesktopTodoPhase[] = [
			{ name: "Busy", tasks: [{ content: "Many notes", status: "pending", notes: ["1", "2", "3", "4", "5"] }] },
		];
		const html = renderToStaticMarkup(<TodoPhaseList phases={full} />);
		expect(html).toContain('title="Notes: 5 or more"');
		expect(html).toContain('<span aria-hidden="true">5+</span>');
		expect(html).not.toContain('title="Notes: 5"');
	});

	test("states the task cap once the list reaches the Host's bound, and not below it", () => {
		const list = (count: number): DesktopTodoPhase[] => [
			{ name: "Big", tasks: Array.from({ length: count }, (_, index) => ({ content: `Task ${index}`, status: "pending" })) },
		];
		const notice = "Only the first 120 tasks are shown.";
		expect(renderToStaticMarkup(<TodoPhaseList phases={list(TODO_TASK_LIMIT)} />)).toContain(notice);
		expect(renderToStaticMarkup(<TodoPhaseList phases={list(TODO_TASK_LIMIT - 1)} />)).not.toContain(notice);
		expect(renderToStaticMarkup(<TodoPanel phases={list(TODO_TASK_LIMIT)} />)).not.toContain(notice);
	});

	test("keeps long and CJK task text whole for the wrapping rules to break", () => {
		const long = `${"path/segment/".repeat(30)}end`;
		const cjk = "작업 목록을 세션 작업 카드에 표시하고 진행률을 툴바에 보여 줍니다 任务列表和进度条";
		const html = renderToStaticMarkup(
			<TodoPhaseList phases={[{ name: "긴 단계 이름", tasks: [{ content: long, status: "in_progress", notes: [cjk] }, { content: cjk, status: "pending" }] }]} />,
		);
		expect(html).toContain("<h3>긴 단계 이름</h3>");
		expect(texts(html, "todo-task-text")).toEqual([long, cjk]);
		expect(html).toContain(`<li>${cjk}</li>`);
	});
});

describe("Session work toolbar progress", () => {
	const session: DesktopSession = {
		id: "fixture", projectId: "fixture", title: "Fixture", status: "running", starred: false,
		imageInput: null, operatorRunning: false, controlGeneration: null, messages: [],
	};
	const withTasks = (statuses: DesktopTodoPhase["tasks"][number]["status"][]): DesktopSession => ({
		...session,
		todos: [{ name: "Work", tasks: statuses.map((status, index) => ({ content: `Task ${index}`, status })) }],
	});

	test("shows no chip and the plain name when the session has no tasks", () => {
		for (const value of [session, { ...session, todos: [] }, { ...session, todos: [{ name: "Empty", tasks: [] }] }]) {
			expect(renderToStaticMarkup(<SessionWorkProgress session={value} />)).toBe("");
			expect(sessionWorkLabel(value)).toBe("Session work");
		}
	});

	test("states done/total from the first task on, and names the button with the same progress", () => {
		expect(renderToStaticMarkup(<SessionWorkProgress session={withTasks(["pending", "pending"])} />)).toBe(
			'<span class="session-work-progress" aria-hidden="true">0/2</span>',
		);
		expect(sessionWorkLabel(withTasks(["pending", "pending"]))).toBe("Session work, 0 of 2 tasks done");
		const partial = withTasks(["completed", "abandoned", "in_progress", "pending", "pending"]);
		expect(renderToStaticMarkup(<SessionWorkProgress session={partial} />)).toContain(">2/5<");
		expect(sessionWorkLabel(partial)).toBe("Session work, 2 of 5 tasks done");
	});

	test("marks a finished list complete", () => {
		const finished = withTasks(["completed", "abandoned"]);
		expect(renderToStaticMarkup(<SessionWorkProgress session={finished} />)).toBe(
			'<span class="session-work-progress complete" aria-hidden="true">2/2</span>',
		);
		expect(sessionWorkLabel(finished)).toBe("Session work, 2 of 2 tasks done");
	});
});
