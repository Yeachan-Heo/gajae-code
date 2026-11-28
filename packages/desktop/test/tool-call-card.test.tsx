import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopMessage } from "@gajae-code/desktop-host/protocol";
import type { DesktopToolCall } from "@gajae-code/desktop-host/tool-protocol";
import { Message } from "../src/components";
import { ToolCallCard, ToolCallDetails, ToolDetailContext, type ToolDetailSource } from "../src/ToolCallCard";

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

	test("a cancelled call is a neutral outcome: no error styling, unlike a failed one", () => {
		// The Host marks an aborted call's result as an error and derives `cancelled` from it.
		const article = (html: string) => /<article[^>]*>/.exec(html)?.[0] ?? "";
		const cancelled = render(row({ family: "shell", status: "cancelled", subject: "$ sleep 9" }, { isError: true }));
		const failed = render(row({ family: "shell", status: "failed", subject: "$ false" }, { isError: true }));
		expect(article(cancelled)).not.toContain("message-error");
		expect(article(failed)).toContain("message-error");
		expect(cancelled).toContain("tool-call-status tool-call-cancelled");
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

describe("tool call card details", () => {
	const loads: string[] = [];
	const source: ToolDetailSource = { load: async callId => { loads.push(callId); return { callId }; } };
	const withSource = (message: DesktopMessage, value: ToolDetailSource | null, open = true) => renderToStaticMarkup(
		<ToolDetailContext.Provider value={value}><ToolCallCard message={message} defaultOpen={open} /></ToolDetailContext.Provider>,
	);
	const expandable = row({ family: "read", status: "done", subject: "a.ts", detail: true });

	test("an open expandable card shows loading until its details arrive; a closed one requests nothing", () => {
		const open = withSource(expandable, source);
		expect(open).toContain('role="status"');
		expect(open).toContain("Loading details…");
		expect(open.indexOf("Loading details…")).toBeLessThan(open.indexOf("bounded-output"));
		expect(withSource(expandable, source, false)).not.toContain("tool-call-details");
		// Static rendering runs no effects, so nothing was requested.
		expect(loads).toEqual([]);
	});

	test("details are unavailable without a loader, and absent for rows that have none", () => {
		expect(withSource(expandable, null)).toContain("Details are unavailable for this connection.");
		const none = withSource(row({ family: "read", status: "done", detail: false }), source);
		expect(none).not.toContain("tool-call-details");
		expect(none).toContain("output");
	});

	test("a failed load keeps the output and explains the failure", () => {
		const html = renderToStaticMarkup(<ToolCallDetails family="read" state={{ kind: "error", message: "This tool call is no longer available." }} />);
		expect(html).toContain('role="alert"');
		expect(text(html)).toBe("Details could not be loaded. This tool call is no longer available.");
	});

	test("loaded details show the command, arguments, per-file diffs and the truncation notice", () => {
		const html = renderToStaticMarkup(<ToolCallDetails family="edit" state={{ kind: "ready", detail: {
			callId: "c", truncated: true, command: "npm test <x>", args: '{\n  "cwd": "app"\n}',
			diff: [
				{ path: "src/a.ts", diff: "@@ -1 +1 @@\n-1|old\n+1|new\n 2|same", added: 1, removed: 1, op: "update" },
				{ path: "src/new.ts", diff: "+1|x", added: 1, removed: 0, op: "create" },
				{ path: "src/gone.ts", diff: "", added: 0, removed: 0, error: "No match" },
			],
		} }} />);
		expect(html).toContain("Some details were shortened to fit.");
		expect(html).toContain("npm test &lt;x&gt;");
		expect(html.indexOf("Command")).toBeLessThan(html.indexOf("Changes"));
		expect(html.indexOf("Changes")).toBeLessThan(html.indexOf("Arguments"));
		expect(html.match(/class="tool-diff-line tool-diff-add"/g)).toHaveLength(2);
		expect(html.match(/class="tool-diff-line tool-diff-remove"/g)).toHaveLength(1);
		expect(html).toContain('class="tool-diff-line tool-diff-hunk">@@ -1 +1 @@</span>');
		expect(html).toContain('<span class="tool-diff-number" aria-hidden="true">1</span><span class="tool-diff-sign">-</span>old');
		expect(html).toContain("Created");
		expect(html).toContain("No match");
		const written = renderToStaticMarkup(<ToolCallDetails family="write" state={{ kind: "ready", detail: {
			callId: "c", diff: [{ path: "n.md", diff: "+1|# Notes", added: 1, removed: 0 }],
		} }} />);
		expect(written).toContain("Content written");
		expect(written).not.toContain("tool-fact-removed");
	});

	test("a diff header shows only the line counts a file has, and none for a file whose edit failed", () => {
		const html = renderToStaticMarkup(<ToolCallDetails family="edit" state={{ kind: "ready", detail: {
			callId: "c",
			diff: [
				{ path: "both.ts", diff: "-1|a\n+1|b", added: 1, removed: 1 },
				{ path: "new.ts", diff: "+1|x\n+2|y", added: 2, removed: 0, op: "create" },
				{ path: "gone.ts", diff: "-1|x", added: 0, removed: 1, op: "delete" },
				{ path: "failed.ts", diff: "", added: 0, removed: 0, error: "No match" },
			],
		} }} />);
		const headers = [...html.matchAll(/<div class="tool-diff-header">([\s\S]*?)<\/div>/g)].map(match => text(match[1]!));
		expect(headers).toEqual(["both.ts+1 −1", "new.tsCreated+2", "gone.tsDeleted−1", "failed.ts"]);
	});

	test("a diff header names a file inside the project relative to it, with the full path on hover", () => {
		// The conversation's detail loader carries its project directory.
		const headers = (directory: string | undefined, paths: string[]) => {
			const html = renderToStaticMarkup(
				<ToolDetailContext.Provider value={directory === undefined ? null : { ...source, directory }}>
					<ToolCallDetails family="edit" state={{ kind: "ready", detail: {
						callId: "c", diff: paths.map(path => ({ path, diff: "+1|x", added: 1, removed: 0 })),
					} }} />
				</ToolDetailContext.Provider>,
			);
			return [...html.matchAll(/<code class="tool-diff-path"( title="([^"]*)")?>([^<]*)<\/code>/g)].map((match): [string, string | null] => [match[3] ?? "", match[2] ?? null]);
		};
		expect(headers("/work/app", ["/work/app/src/a.ts", "/work/app2/b.ts", "/elsewhere/c.ts", "/work/app", "rel/d.ts"])).toEqual([
			["src/a.ts", "/work/app/src/a.ts"],
			// A sibling that shares the prefix is outside the project.
			["/work/app2/b.ts", null],
			["/elsewhere/c.ts", null],
			["/work/app", null],
			["rel/d.ts", null],
		]);
		expect(headers("/work/app/", ["/work/app/src/a.ts"])).toEqual([["src/a.ts", "/work/app/src/a.ts"]]);
		expect(headers("C:\\work\\app", ["C:\\work\\app\\src\\e.ts"])).toEqual([["src\\e.ts", "C:\\work\\app\\src\\e.ts"]]);
		expect(headers(undefined, ["/work/app/src/a.ts"])).toEqual([["/work/app/src/a.ts", null]]);
	});
});
