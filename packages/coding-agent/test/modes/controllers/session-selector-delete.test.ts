import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { SessionSelectorComponent } from "../../../src/modes/components/session-selector";
import { initTheme } from "../../../src/modes/theme/theme";
import type { SessionInfo } from "../../../src/session/session-manager";

beforeAll(() => {
	initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function createSession(id: string, title: string): SessionInfo {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "/tmp",
		title,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 0,
		firstMessage: `${title} first message`,
		allMessagesText: `${title} first message`,
	};
}

function createSelector(
	onDelete: (session: SessionInfo) => Promise<boolean>,
	onSelect: (sessionPath: string) => void = () => {},
): SessionSelectorComponent {
	return new SessionSelectorComponent(
		[createSession("session-a", "Alpha"), createSession("session-b", "Beta")],
		onSelect,
		() => {},
		() => {},
		onDelete,
	);
}

function renderText(selector: SessionSelectorComponent): string {
	return Bun.stripANSI(selector.render(120).join("\n"));
}

describe("SessionSelectorComponent delete confirmation", () => {
	it("keeps the session visible and shows the error when delete fails after confirmation", async () => {
		const onDelete = vi.fn(async () => {
			throw new Error("disk failed");
		});
		const selector = createSelector(onDelete);

		selector.handleInput("\x1b[3~");
		expect(renderText(selector)).toContain("Delete selected session transcript and artifacts?");
		expect(renderText(selector)).toContain("Alpha");
		expect(renderText(selector)).toContain(
			"This cannot be undone. Other sessions and topic/history metadata are not deleted.",
		);

		selector.handleInput("\n");
		await Bun.sleep(0);

		const rendered = renderText(selector);
		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(rendered).toContain("Error: disk failed");
		expect(rendered).toContain("Alpha");
		expect(rendered).toContain("Beta");
		expect(rendered).not.toContain("Delete selected session transcript and artifacts?");
	});

	it("keeps the session visible when delete is canceled upstream", async () => {
		const onDelete = vi.fn(async () => false);
		const selector = createSelector(onDelete);

		selector.handleInput("\x1b[3~");
		selector.handleInput("\n");
		await Bun.sleep(0);

		const rendered = renderText(selector);
		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(rendered).toContain("Alpha");
		expect(rendered).toContain("Beta");
		expect(rendered).not.toContain("Error:");
	});

	it("removes the session row after a successful delete", async () => {
		const onDelete = vi.fn(async () => true);
		const selector = createSelector(onDelete);

		selector.handleInput("\x1b[3~");
		selector.handleInput("\n");
		await Bun.sleep(0);

		const rendered = renderText(selector);
		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(rendered).not.toContain("Alpha");
		expect(rendered).toContain("Beta");
	});
	it("keeps selection valid after navigating empty search results", () => {
		const onSelect = vi.fn();
		const selector = createSelector(async () => false, onSelect);

		for (const char of "zzz") selector.handleInput(char);
		expect(renderText(selector)).toContain("No sessions in current folder");

		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[6~");
		for (let i = 0; i < 3; i++) selector.handleInput("\x7f");

		const rendered = renderText(selector);
		expect(rendered).toContain("Alpha");
		expect(rendered).toContain("❯ Alpha");

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith("/tmp/session-a.jsonl");
	});
});
