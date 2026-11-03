import { beforeAll, describe, expect, it, vi } from "bun:test";
import { visibleWidth } from "@gajae-code/tui";
import { SessionSelectorComponent } from "../../../src/modes/components/session-selector";
import { initTheme } from "../../../src/modes/theme/theme";
import type { SessionRecapRecord } from "../../../src/sdk/session-recap";
import type { SessionInfo } from "../../../src/session/session-manager";

beforeAll(() => initTheme());

function recap(text: string): SessionRecapRecord {
	return {
		schemaVersion: 1,
		text,
		sourceEntryId: "source-entry",
		requestEntryId: "request-entry",
		model: { provider: "test-provider", id: "test-model" },
		generatedAt: "2026-11-02T07:12:00.000Z",
		entryId: "recap-entry",
		source: "model",
	};
}

function session(id: string, options: { title?: string; firstMessage?: string; recap?: SessionRecapRecord } = {}) {
	const info: SessionInfo = {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "/tmp",
		title: options.title,
		starred: false,
		created: new Date(),
		modified: new Date(),
		messageCount: 2,
		size: 2048,
		firstMessage: options.firstMessage ?? `first message of ${id}`,
		allMessagesText: options.firstMessage ?? `first message of ${id}`,
	};
	if (options.recap) info.recap = options.recap;
	return info;
}

function picker(sessions: SessionInfo[]) {
	const selected = vi.fn();
	const component = new SessionSelectorComponent(
		sessions,
		selected,
		() => {},
		() => {},
	);
	const lines = (width = 100): string[] => component.render(width);
	const text = (width = 100): string => Bun.stripANSI(lines(width).join("\n"));
	return { component, selected, lines, text };
}

describe("session picker recap row", () => {
	it("shows the generated recap, labelled, in place of the first-message description", () => {
		const { text } = picker([
			session("titled", {
				title: "Login work",
				firstMessage: "fix the redirect bug",
				recap: recap("로그인 리다이렉트를 고쳤다"),
			}),
		]);

		const rendered = text();

		expect(rendered).toContain("Login work");
		expect(rendered).toContain("[AI recap] 로그인 리다이렉트를 고쳤다");
		expect(rendered).not.toContain("fix the redirect bug");
	});

	it("keeps the first message as the row title and adds the recap beneath it when there is no title", () => {
		const { text } = picker([
			session("untitled", { firstMessage: "fix the redirect bug", recap: recap("The redirect bug was fixed") }),
		]);

		const rows = text().split("\n");
		const titleRow = rows.findIndex(row => row.includes("fix the redirect bug"));

		expect(titleRow).toBeGreaterThanOrEqual(0);
		expect(rows[titleRow + 1]).toContain("[AI recap] The redirect bug was fixed");
	});

	it("keeps the existing first-message description when a session has no recap", () => {
		const { text } = picker([
			session("titled", { title: "Login work", firstMessage: "fix the redirect bug" }),
			session("untitled", { firstMessage: "plain first message" }),
		]);

		const rendered = text();

		expect(rendered).toContain("fix the redirect bug");
		expect(rendered).toContain("plain first message");
		expect(rendered).not.toContain("[AI recap]");
	});

	it("renders hostile recap text as one safe line", () => {
		const hostile = "line one\nline two\ttabbed \x1b]0;evil-title\x07 \x1b[31mred\x1b[0m end";
		const { lines } = picker([session("hostile", { title: "Hostile", recap: recap(hostile) })]);

		const raw = lines().join("\n");
		const recapLines = lines().filter(line => Bun.stripANSI(line).includes("[AI recap]"));

		expect(recapLines).toHaveLength(1);
		expect(recapLines[0]).not.toContain("\n");
		expect(raw).not.toContain("\x07");
		expect(raw).not.toContain("evil-title\x07");
		expect(Bun.stripANSI(recapLines[0] ?? "")).toContain("line one line two");
	});

	it("truncates long recaps by display width, including wide and four-byte characters", () => {
		const wide = recap("가".repeat(120));
		const fourByte = recap("𐐀".repeat(120));
		for (const width of [20, 37, 60]) {
			const { lines } = picker([
				session("wide", { title: "Wide", recap: wide }),
				session("four-byte", { title: "Four byte", recap: fourByte }),
			]);

			const recapLines = lines(width).filter(line => Bun.stripANSI(line).includes("[AI recap]"));
			expect(recapLines).toHaveLength(2);
			for (const line of recapLines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("matches searches against the recap text", () => {
		const { component, text } = picker([
			session("alpha", { title: "Alpha", recap: recap("deployed the zebra migration") }),
			session("beta", { title: "Beta", recap: recap("refactored the parser") }),
		]);

		for (const key of "zebra") component.handleInput(key);

		const rendered = text();
		expect(rendered).toContain("Alpha");
		expect(rendered).not.toContain("Beta");
	});

	it("does not match a search that appears nowhere in the row", () => {
		const { component, text } = picker([session("alpha", { title: "Alpha", recap: recap("deployed a migration") })]);

		for (const key of "quokka") component.handleInput(key);

		expect(text()).toContain("No sessions");
	});

	it("still selects the session whose recap row is shown", () => {
		const { component, selected } = picker([
			session("alpha", { title: "Alpha", recap: recap("deployed a migration") }),
		]);

		component.handleInput("\n");

		expect(selected).toHaveBeenCalledWith("/tmp/alpha.jsonl");
	});
});
