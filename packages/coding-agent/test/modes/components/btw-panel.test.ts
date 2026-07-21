import { beforeAll, describe, expect, it, vi } from "bun:test";
import { BtwPanelComponent } from "@gajae-code/coding-agent/modes/components/btw-panel";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { Component, TUI } from "@gajae-code/tui";

beforeAll(async () => {
	await initTheme();
});

function makeTui(): TUI {
	return { requestRender: vi.fn() } as unknown as TUI;
}

function renderTree(component: Component, width = 80): string {
	const lines: string[] = [];
	const walk = (node: Component) => {
		if (typeof (node as { render?: (width: number) => string[] }).render === "function") {
			lines.push(...(node as { render: (width: number) => string[] }).render(width));
		}
		const children = (node as { children?: Component[] }).children;
		if (Array.isArray(children)) {
			for (const child of children) walk(child);
		}
	};
	walk(component);
	return lines.join("\n");
}

describe("BtwPanelComponent retained rendering", () => {
	it("keeps completed turns ordered and updates only the streaming region across deltas", () => {
		const tui = makeTui();
		const panel = new BtwPanelComponent({ question: "First question?", tui });
		const initialChildren = [...panel.children];
		panel.appendText("First ");
		panel.appendText("answer");
		// Streaming deltas must not rebuild the outer retained shell.
		expect(panel.children).toEqual(initialChildren);
		panel.markComplete();

		panel.beginTurn("Second question?");
		const afterSecondTurn = [...panel.children];
		panel.appendText("Second answer");
		expect(panel.children).toEqual(afterSecondTurn);

		const joined = renderTree(panel);
		expect(joined).toContain("First question?");
		expect(joined).toContain("First answer");
		expect(joined).toContain("Second question?");
		expect(joined).toContain("Second answer");
		expect(joined).toContain("Esc cancel /btw");
	});

	it("shows follow-up dismiss guidance after completion and clears state on close", () => {
		const tui = makeTui();
		const panel = new BtwPanelComponent({ question: "Only?", tui });
		panel.setAnswer("Done");
		panel.markComplete();
		expect(renderTree(panel)).toContain("Type a follow-up · Esc return to main chat");

		panel.close();
		panel.appendText("should be ignored");
		expect(renderTree(panel)).not.toContain("should be ignored");
	});
});
