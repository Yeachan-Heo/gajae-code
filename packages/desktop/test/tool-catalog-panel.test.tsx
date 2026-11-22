import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopMessage } from "@gajae-code/desktop-host/protocol";
import type { DesktopToolInfo } from "@gajae-code/desktop-host/tool-protocol";
import {
	editedToolNames,
	filterToolCatalog,
	isToolCatalogUnsupported,
	parseToolList,
	type ToolCatalog,
	ToolCatalogPanel,
	type ToolCatalogPanelProps,
	toolSearchResultIds,
} from "../src/ToolCatalogDialog";

const tools: DesktopToolInfo[] = [
	{
		name: "read",
		label: "Read",
		description: "Read files and URLs",
		active: true,
		origin: "essential",
		discovered: false,
	},
	{
		name: "todo_write",
		label: "Todo Write",
		description: "작업 목록을 단계별로 기록합니다.",
		active: false,
		origin: "discoverable",
		discovered: false,
		hidden: true,
	},
	{
		name: "ast_grep",
		label: "AST Grep",
		description: "Search code with AST patterns",
		active: true,
		origin: "discoverable",
		discovered: true,
	},
	{
		name: "mcp_github_search",
		label: "github/search",
		active: false,
		origin: "discoverable",
		discovered: false,
		hidden: true,
		mcpServer: "github",
	},
];
const catalog: ToolCatalog = { tools, active: ["read", "ast_grep"], discovery: { enabled: true } };

function render(props: Partial<ToolCatalogPanelProps> = {}): string {
	return renderToStaticMarkup(
		<ToolCatalogPanel
			catalog={catalog}
			reading={false}
			saving={false}
			query=""
			onQueryChange={() => {}}
			edits={new Map()}
			onToggle={() => {}}
			onSave={() => {}}
			{...props}
		/>,
	);
}

/** Text of the element whose opening tag contains `marker`, with tags stripped. */
function textOf(html: string, marker: string): string[] {
	const parts = html.split(marker).slice(1);
	return parts.map(part =>
		part
			.slice(part.indexOf(">") + 1)
			.split("</")[0]!
			.replace(/<[^>]+>/g, ""),
	);
}

function saveButton(html: string): string {
	return /<button[^>]*>Save tools<\/button>/.exec(html)?.[0] ?? "";
}

describe("tools.list answers", () => {
	test("an older names-only answer still lists every tool, in SDK order", () => {
		expect(parseToolList({ available: ["read", "bash"], active: ["bash"] })).toEqual({
			tools: [
				{ name: "read", label: "read", origin: "other", discovered: false, active: false },
				{ name: "bash", label: "bash", origin: "other", discovered: false, active: true },
			],
			active: ["bash"],
		});
	});

	test("every available name gets a row even when the catalog was cut, and activity comes from active", () => {
		const parsed = parseToolList({
			available: ["read", "bash"],
			active: ["read"],
			tools: [{ name: "read", label: "Read", active: false, origin: "essential", discovered: false }],
			discovery: { enabled: false },
		});
		expect(parsed?.tools.map(tool => [tool.name, tool.label, tool.active])).toEqual([
			["read", "Read", true],
			["bash", "bash", false],
		]);
		expect(parsed?.discovery).toEqual({ enabled: false });
	});

	test("rejects malformed answers", () => {
		for (const value of [
			null,
			{ available: ["read", 7], active: [] },
			{ available: ["read"] },
			{ available: ["read"], active: [], tools: [{ name: "read" }] },
			{ available: ["read"], active: [], tools: [{ ...tools[0], origin: "builtin" }] },
			{ available: ["read"], active: [], discovery: { enabled: "yes" } },
		])
			expect(parseToolList(value)).toBeNull();
	});

	test("recognises only the Host's unsupported-owner refusal as unavailable", () => {
		expect(
			isToolCatalogUnsupported(
				"The SDK owner does not support desktop tools.list. Use its original control surface.",
			),
		).toBe(true);
		expect(isToolCatalogUnsupported("Tool registry unavailable")).toBe(false);
	});
});

describe("tool search filter", () => {
	test("matches name, label and description case-insensitively for every term", () => {
		expect(filterToolCatalog(tools, "READ").map(tool => tool.name)).toEqual(["read"]);
		expect(filterToolCatalog(tools, "github/search").map(tool => tool.name)).toEqual(["mcp_github_search"]);
		expect(filterToolCatalog(tools, "search ast").map(tool => tool.name)).toEqual(["ast_grep"]);
		expect(filterToolCatalog(tools, "   ").map(tool => tool.name)).toHaveLength(tools.length);
		expect(filterToolCatalog(tools, "nothing-like-this")).toEqual([]);
	});

	test("normalises full-width Latin and decomposed Hangul before matching", () => {
		expect(filterToolCatalog(tools, "ＴＯＤＯ").map(tool => tool.name)).toEqual(["todo_write"]);
		const decomposed = "작업".normalize("NFD");
		expect(decomposed).not.toBe("작업");
		expect(filterToolCatalog(tools, decomposed).map(tool => tool.name)).toEqual(["todo_write"]);
		expect(filterToolCatalog(tools, "단계별").map(tool => tool.name)).toEqual(["todo_write"]);
	});
});

describe("saved names and tool-search results", () => {
	test("a save sends the saved active set with the edits applied, never only the listed rows", () => {
		const cut: ToolCatalog = { ...catalog, active: ["read", "ast_grep", "beyond_the_catalog_bound"] };
		expect(
			editedToolNames(
				cut,
				new Map([
					["ast_grep", false],
					["todo_write", true],
				]),
			),
		).toEqual(["read", "beyond_the_catalog_bound", "todo_write"]);
	});

	test("only settled tool-search rows count as results", () => {
		const row = (id: string, extra: Partial<DesktopMessage>): DesktopMessage => ({
			id,
			role: "tool",
			text: "",
			...extra,
		});
		expect(
			toolSearchResultIds([
				row("legacy", { toolName: "search_tool_bm25" }),
				row("done", {
					toolName: "search_tool_bm25",
					tool: { callId: "a", status: "done", family: "tool-search", detail: true },
				}),
				row("call:b", {
					toolName: "search_tool_bm25",
					tool: { callId: "b", status: "running", family: "tool-search", detail: false },
				}),
				row("failed", {
					toolName: "x",
					tool: { callId: "c", status: "failed", family: "tool-search", detail: false },
				}),
				row("read", { toolName: "read" }),
				{ id: "assistant", role: "assistant", text: "search_tool_bm25" },
			]),
		).toEqual(["legacy", "done", "failed"]);
	});
});

describe("Tools dialog panel", () => {
	test("lists Active and Available sections by saved state, sorted by name, with tags and counts", () => {
		const html = render();
		expect(textOf(html, '<h3 id="')).toEqual(["Active 2", "Available 2"]);
		expect([...html.matchAll(/data-tool-name="([^"]+)"/g)].map(match => match[1])).toEqual([
			"ast_grep",
			"read",
			"mcp_github_search",
			"todo_write",
		]);
		expect(html).toContain("2 active · 2 available");
		expect(html).toContain("the agent turns on hidden tools when a tool search finds them");
		expect(textOf(html, 'class="tool-catalog-tag ')).toEqual([
			"Found by tool search",
			"Essential",
			"Hidden until searched",
			"MCP · github",
			"Hidden until searched",
		]);
		// The monospace name and a label that differs from it; a label equal to the name is not repeated.
		expect(html).toContain(
			'<code class="tool-catalog-name">todo_write</code><span class="tool-catalog-label">Todo Write</span>',
		);
		expect(html).toContain('<code class="tool-catalog-name">read</code></span>');
		expect(html).not.toContain('<span class="tool-catalog-label">Read</span>');
		expect(html).toContain("작업 목록을 단계별로 기록합니다.");
	});

	test("names each checkbox by its title and describes it by its description and tags", () => {
		const html = render();
		const box = /<input[^>]*data-tool-name="todo_write"[^>]*>/.exec(html)?.[0] ?? "";
		const labelledBy = /aria-labelledby="([^"]+)"/.exec(box)?.[1];
		const describedBy = /aria-describedby="([^"]+)"/.exec(box)?.[1]?.split(" ");
		expect(html).toContain(`id="${labelledBy}"`);
		expect(describedBy).toHaveLength(2);
		for (const id of describedBy ?? []) expect(html).toContain(`id="${id}"`);
		expect(box).not.toContain("checked");
	});

	test("Save needs an edit, and an edited row keeps its section but shows the new state", () => {
		expect(saveButton(render())).toContain("disabled");
		const html = render({ edits: new Map([["todo_write", true]]) });
		expect(saveButton(html)).not.toContain("disabled");
		expect(html).toContain("1 unsaved change");
		expect(/<li[^>]*data-edited="true"[^>]*>(?:(?!<\/li>).)*data-tool-name="todo_write"/.test(html)).toBe(true);
		expect(/<input[^>]*data-tool-name="todo_write"[^>]*checked/.test(html)).toBe(true);
		expect(textOf(html, '<h3 id="')).toEqual(["Active 2", "Available 2"]);
	});

	test("Save waits while a turn owns the conversation or the connection is down, and says why", () => {
		const edits = new Map([["todo_write", true]]);
		const running = render({ edits, saveBlocked: "running" });
		expect(saveButton(running)).toContain("disabled");
		expect(running).toContain("You can save when this turn ends.");
		expect(running).toContain("would cancel a tool search that is still turning tools on");
		const offline = render({ edits, saveBlocked: "disconnected" });
		expect(saveButton(offline)).toContain("disabled");
		expect(offline).toContain("Waiting for the connection before saving.");
		const saving = render({ edits, saving: true });
		expect(saveButton(saving)).toContain("disabled");
		expect(saving).toContain("Saving tools…");
		expect(/<input[^>]*data-tool-name="read"[^>]*disabled/.test(saving)).toBe(true);
	});

	test("loading, failed, unavailable and empty-search states", () => {
		const loading = render({ catalog: null, reading: true });
		expect(loading).toContain("Loading tools…");
		expect(loading).not.toContain("Save tools");
		const failed = render({ catalog: null, error: "Tool registry unavailable", onRetry: () => {} });
		expect(textOf(failed, 'class="error-content"')).toEqual(["Tool registry unavailable"]);
		expect(failed).toContain(">Try again</button>");
		expect(failed).not.toContain("No tools are available.");
		const stale = render({
			error: "Tool registry unavailable",
			onRetry: () => {},
			edits: new Map([["read", false]]),
		});
		expect(saveButton(stale)).toContain("disabled");
		// A failed save keeps the list and lets the user try the save again.
		const refused = render({ error: "Another operation is running.", edits: new Map([["read", false]]) });
		expect(saveButton(refused)).not.toContain("disabled");
		expect(refused).not.toContain("Try again");
		const unavailable = render({ catalog: null, unavailable: true });
		expect(unavailable).toContain("Another gjc process owns this conversation");
		expect(unavailable).not.toContain("Save tools");
		expect(unavailable).not.toContain("error-banner");
		const empty = render({ query: "  없는도구 " });
		expect(empty).toContain("No tools match “없는도구”.");
		expect(empty).not.toContain("data-tool-name");
		expect(render({ catalog: { tools: [], active: [] } })).toContain("No tools are available.");
	});

	test("a tool search over unsaved edits holds Save until the list is reloaded", () => {
		const html = render({ edits: new Map([["read", false]]), searchChanged: true, onReload: () => {} });
		expect(html).toContain("A tool search changed this conversation&#x27;s tools.");
		expect(html).toContain("your changes are kept");
		expect(html).toContain(">Reload</button>");
		// Saving now would send a set built on the stale list and switch the found tools back off.
		expect(saveButton(html)).toContain("disabled");
	});
});
