import { describe, expect, test } from "bun:test";
import type { DesktopMessage, DesktopTodoPhase } from "@gajae-code/desktop-host/protocol";
import type { DesktopToolDetail } from "@gajae-code/desktop-host/tool-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { Message } from "../src/components";
import { TodoToolBody } from "../src/TodoToolBody";

const message: DesktopMessage = {
	id: "todo",
	role: "tool",
	toolName: "todo_write",
	text: "Phase 1/1 Build — 1/2 tasks complete",
	tool: { callId: "call-1", status: "done", family: "todo", detail: true },
};
const todo: DesktopTodoPhase[] = [
	{
		name: "Build",
		tasks: [
			{ content: "Wire the body", status: "completed" },
			{ content: "Check the tree", status: "in_progress", notes: ["Tree comes from tool.detail."] },
		],
	},
	{ name: "Empty", tasks: [] },
];
const detail: DesktopToolDetail = { callId: "call-1", todo };
const output = <pre className="bounded-output">generic output</pre>;

describe("todo_write tool body", () => {
	test("renders the task tree the call left, with its progress, instead of the raw output", () => {
		const html = renderToStaticMarkup(<TodoToolBody message={message} detail={detail} output={output} />);
		expect(html).toContain('class="todo-tool-body"');
		expect(html).toContain("1/2 tasks done");
		expect(html).toContain("<h3>Build</h3>");
		expect(html).not.toContain("<h3>Empty</h3>");
		expect(html).toContain("Check the tree");
		expect(html).toContain("<li>Tree comes from tool.detail.</li>");
		expect(html).not.toContain("generic output");
	});

	test("falls back to the generic output without task detail", () => {
		for (const value of [undefined, { callId: "call-1" }, { callId: "call-1", todo: [] }, { callId: "call-1", todo: [{ name: "Empty", tasks: [] }] }]) {
			expect(renderToStaticMarkup(<TodoToolBody message={message} detail={value} output={output} />)).toBe(
				'<pre class="bounded-output">generic output</pre>',
			);
		}
	});

	test("keeps the error output of a failed or cancelled call even when detail carries a list", () => {
		for (const fields of [{ isError: true }, { cancelled: true }]) {
			const html = renderToStaticMarkup(<TodoToolBody message={{ ...message, ...fields }} detail={detail} output={output} />);
			expect(html).toContain("generic output");
			expect(html).not.toContain("todo-tool-body");
		}
	});

	test("a todo row without detail still shows its output in the transcript", () => {
		const plain: DesktopMessage = { ...message, tool: { callId: "call-1", status: "done", family: "todo", detail: false } };
		const html = renderToStaticMarkup(<Message message={plain} />);
		expect(html).toContain("Phase 1/1");
		expect(html).not.toContain("todo-tool-body");
	});
});
