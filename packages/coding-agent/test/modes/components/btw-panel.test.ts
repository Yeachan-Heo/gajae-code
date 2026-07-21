import { beforeAll, describe, expect, it, vi } from "bun:test";
import { BtwPanelComponent } from "@gajae-code/coding-agent/modes/components/btw-panel";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import {
	BTW_MAX_CONTEXT_TURNS,
	BTW_MAX_ERROR_UTF8_BYTES,
	utf8ByteLength,
} from "@gajae-code/coding-agent/session/btw-contract";
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

	it("keeps only the newest bounded turn window", () => {
		const panel = new BtwPanelComponent({ question: "q0", tui: makeTui() });
		panel.setAnswer("a0");
		panel.markComplete();
		for (let index = 1; index <= BTW_MAX_CONTEXT_TURNS + 2; index += 1) {
			panel.beginTurn(`q${index}`);
			panel.setAnswer(`a${index}`);
			panel.markComplete();
		}
		const rendered = renderTree(panel);
		expect(rendered).not.toContain("q0");
		expect(rendered).toContain(`q${BTW_MAX_CONTEXT_TURNS + 2}`);
	});
	it("bounds provider errors and discards failed turns before the next question", () => {
		const panel = new BtwPanelComponent({ question: "FAILED_PRIVATE_QUESTION", tui: makeTui() });
		panel.appendText("PARTIAL_PRIVATE_ANSWER");
		panel.markError(`RAW_PROVIDER_SENTINEL\u0000${"é".repeat(BTW_MAX_ERROR_UTF8_BYTES)}`);

		const failed = renderTree(panel);
		expect(failed).not.toContain("PARTIAL_PRIVATE_ANSWER");
		const visibleError = failed.match(/RAW_PROVIDER_SENTINEL[^\n]*/)?.[0] ?? "";
		expect(utf8ByteLength(visibleError)).toBeLessThanOrEqual(BTW_MAX_ERROR_UTF8_BYTES);

		panel.beginTurn("recovery");
		const recovered = renderTree(panel);
		expect(recovered).not.toContain("FAILED_PRIVATE_QUESTION");
		expect(recovered).not.toContain("RAW_PROVIDER_SENTINEL");
	});
});
