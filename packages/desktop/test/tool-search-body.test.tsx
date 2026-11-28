import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopMessage } from "@gajae-code/desktop-host/protocol";
import type { DesktopToolDetail, DesktopToolSearchDetail } from "@gajae-code/desktop-host/tool-protocol";
import { ToolSearchBody } from "../src/ToolSearchBody";

const message: DesktopMessage = {
	id: "result",
	role: "tool",
	toolName: "search_tool_bm25",
	text: '{"query":"todo","activated_tools":["todo_write"],"match_count":1,"total_tools":30}',
	tool: { callId: "call-1", status: "done", family: "tool-search", subject: "todo", detail: true },
};
const output = <pre className="bounded-output">{message.text}</pre>;

function render(detail?: DesktopToolDetail): string {
	return renderToStaticMarkup(<ToolSearchBody message={message} detail={detail} output={output} />);
}

function search(overrides: Partial<DesktopToolSearchDetail> = {}): DesktopToolDetail {
	return {
		callId: "call-1",
		toolSearch: {
			query: "todo list",
			activated: ["todo_write", "mcp_linear_create_issue"],
			matches: [
				{ name: "todo_write", label: "Todo Write", description: "Write a structured todo list" },
				{
					name: "mcp_linear_create_issue",
					label: "linear/create_issue",
					description: "Create an issue in a Linear team",
					mcpServer: "linear",
				},
				{ name: "checkpoint", label: "Checkpoint" },
			],
			total: 3,
			...overrides,
		},
	};
}

function texts(html: string, marker: string): string[] {
	return html
		.split(marker)
		.slice(1)
		.map(part =>
			part
				.slice(part.indexOf(">") + 1)
				.split("</")[0]!
				.replace(/<[^>]+>/g, ""),
		);
}

describe("tool-search card body", () => {
	test("keeps the plain output until a toolSearch detail is loaded", () => {
		const plain = renderToStaticMarkup(output);
		expect(render()).toBe(plain);
		expect(render({ callId: "call-1", args: "{}" })).toBe(plain);
	});

	test("shows the query, the tools it turned on and the ranked matches", () => {
		const html = render(search());
		expect(html).not.toContain("bounded-output");
		expect(html).toContain("Searched for <code>todo list</code>");
		expect(texts(html, 'class="tool-search-chip"')).toEqual(["todo_write", "mcp_linear_create_issue"]);
		const labelId = /<span id="([^"]+)">Turned on<\/span>/.exec(html)?.[1];
		expect(html).toContain(`<ul aria-labelledby="${labelId}">`);
		expect(texts(html, "<strong")).toEqual(["Todo Write", "linear/create_issue", "Checkpoint"]);
		// Each match shows its monospace name unless the label is that name in another case.
		expect(texts(html, "<code")).toEqual(["todo list", "todo_write", "mcp_linear_create_issue"]);
		expect(texts(html, 'class="tool-catalog-tag"')).toEqual(["MCP · linear"]);
		expect(html).toContain('title="Create an issue in a Linear team"');
		expect(html).toMatch(/<ol class="tool-search-matches" aria-label="Matching tools">/);
		expect(html).not.toContain("Showing");
	});

	test("says when nothing matched and when more matches exist than were sent", () => {
		const empty = render(search({ activated: [], matches: [], total: 0 }));
		expect(empty).toContain("No matching tools found.");
		expect(empty).not.toContain("Turned on");
		expect(empty).not.toContain("tool-search-matches");
		const capped = render(search({ activated: [], total: 27 }));
		expect(capped).toContain("Showing 3 of 27 matches.");
		expect(capped).not.toContain("Turned on");
	});
});
