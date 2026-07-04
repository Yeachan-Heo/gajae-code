import { beforeAll, describe, expect, it, vi } from "bun:test";
import { TreeSelectorComponent } from "../../../src/modes/components/tree-selector";
import { initTheme } from "../../../src/modes/theme/theme";
import type { SessionTreeNode } from "../../../src/session/session-manager";

beforeAll(() => {
	initTheme();
});

function createNode(id: string, content: string): SessionTreeNode {
	return {
		entry: {
			type: "message",
			id,
			parentId: null,
			timestamp: "2024-01-01T00:00:00Z",
			message: { role: "user", content } as never,
		},
		children: [],
	};
}

function renderText(selector: TreeSelectorComponent): string {
	return Bun.stripANSI(selector.render(100).join("\n"));
}

describe("TreeSelectorComponent empty-filter navigation", () => {
	it("keeps selection valid when an empty initial filter is navigated then cleared", () => {
		const onSelect = vi.fn();
		const selector = new TreeSelectorComponent(
			[createNode("entry-a", "Alpha"), createNode("entry-b", "Beta")],
			"entry-a",
			40,
			onSelect,
			() => {},
			undefined,
			"labeled-only",
		);

		expect(renderText(selector)).toContain("No entries found");

		selector.handleInput("\x1b[A");
		selector.handleInput("\x1b[5~");
		selector.handleInput("\x1bd");

		const rendered = renderText(selector);
		expect(rendered).toContain("› ▸ user: Alpha");
		expect(rendered).toContain("(1/2)");

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith("entry-a");
	});
});
