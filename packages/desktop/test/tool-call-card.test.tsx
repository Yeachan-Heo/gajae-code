import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopMessage } from "@gajae-code/desktop-host/protocol";
import type { DesktopToolCall } from "@gajae-code/desktop-host/tool-protocol";
import { Message } from "../src/components";
import { ToolCallCard } from "../src/ToolCallCard";

const row = (tool: Partial<DesktopToolCall> & Pick<DesktopToolCall, "family" | "status">, extra: Partial<DesktopMessage> = {}): DesktopMessage => ({
	id: "1:1", role: "tool", toolName: "read", text: "output", ...extra,
	tool: { callId: "toolu_1", detail: false, ...tool },
});
const render = (message: DesktopMessage) => renderToStaticMarkup(<ToolCallCard message={message} />);
/** The summary markup only, so output text cannot satisfy a summary assertion. */
const summary = (message: DesktopMessage) => /<summary>([\s\S]*?)<\/summary>/.exec(render(message))?.[1] ?? "";
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

describe("tool call card summary", () => {
	test("reads icon, verb, monospace subject with its full text as title, facts, then the intent line", () => {
		const html = summary(row(
			{ family: "edit", status: "done", subject: "src/<b>app</b>.ts", intent: "Rename the helper", stats: { added: 12, removed: 3 } },
			{ toolName: "edit" },
		));
		const order = ["tool-call-icon", "Edited", 'class="tool-call-subject" title="src/&lt;b&gt;app&lt;/b&gt;.ts"', "+12", "−3", "tool-call-intent"];
		const positions = order.map(part => html.indexOf(part));
		expect(positions.every(position => position >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		expect(html).toContain("<code");
		expect(html).not.toContain("<b>");
		expect(text(html)).toBe("Edited src/&lt;b&gt;app&lt;/b&gt;.ts +12 −3 Rename the helper");
	});

	test("a finished call shows no status text and never an invented success label", () => {
		const html = summary(row({ family: "read", status: "done", subject: "a.ts" }));
		expect(html).not.toContain("tool-call-status");
		expect(text(html)).toBe("Read a.ts");
		expect(render(row({ family: "read", status: "done" }))).not.toMatch(/Success|Succeeded|Done|Completed/);
	});

	test("live calls use present-tense verbs, and only a raw tool name adds Running", () => {
		expect(text(summary(row({ family: "read", status: "running", subject: "a.ts" })))).toBe("Reading a.ts");
		expect(text(summary(row({ family: "shell", status: "running", subject: "$ make" }), ))).toBe("Running $ make");
		expect(text(summary(row({ family: "edit", status: "waiting", subject: "a.ts" })))).toBe("Editing a.ts Waiting");
		expect(text(summary(row({ family: "write", status: "preparing" })))).toBe("Writing Preparing");
		expect(text(summary(row({ family: "other", status: "running" }, { toolName: "mcp__docs__lookup" })))).toBe(
			"mcp__docs__lookup Running",
		);
		expect(render(row({ family: "shell", status: "running" }))).toMatch(/data-tool-status="running"/);
	});

	test("settled states and facts come from the row's call metadata", () => {
		expect(text(summary(row({ family: "shell", status: "failed", subject: "$ false", stats: { exitCode: 1 } }, { isError: true }))))
			.toBe("Ran $ false exit 1 Failed");
		expect(text(summary(row({ family: "shell", status: "cancelled", subject: "$ sleep 9" })))).toBe("Ran $ sleep 9 Cancelled");
		expect(text(summary(row({ family: "shell", status: "background", subject: "$ serve" })))).toBe("Ran $ serve In background");
		expect(text(summary(row({ family: "write", status: "done", stats: { added: 1 } })))).toBe("Wrote 1 line");
		expect(text(summary(row({ family: "search", status: "done", stats: { matches: 1, files: 2 } })))).toBe(
			"Searched 1 match · 2 files",
		);
		expect(text(summary(row({ family: "task", status: "done", subject: "executor", stats: { tasks: 3 } })))).toBe(
			"Delegated executor 3 tasks",
		);
		const search = summary(row({ family: "tool-search", status: "done", subject: "todo", stats: { activated: ["todo_write", "job"] } }));
		expect(text(search)).toBe("Searched tools todo activated 2");
		expect(search).toContain('title="Activated: todo_write, job"');
	});

	test("a row without call metadata keeps the plain tool-name row", () => {
		const legacy: DesktopMessage = { id: "1:1", role: "tool", toolName: "read", text: "output", isError: true };
		const html = renderToStaticMarkup(<Message message={legacy} />);
		expect(html).not.toContain("tool-call");
		expect(html).toContain('<span class="tool-name">read</span>');
		expect(html).toContain("Failed");
		expect(renderToStaticMarkup(<Message message={row({ family: "read", status: "done" })} />)).toContain("tool-call-line");
	});
});
