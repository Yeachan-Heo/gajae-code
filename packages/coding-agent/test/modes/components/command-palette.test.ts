import { beforeAll, describe, expect, it } from "bun:test";
import {
	CommandPaletteComponent,
	type CommandPaletteEntry,
} from "@gajae-code/coding-agent/modes/components/command-palette";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";

const entries: CommandPaletteEntry[] = [
	{
		id: "action:app.session.new",
		label: "Start a new session",
		description: "app.session.new",
		keybinding: "Ctrl+N",
	},
	{
		id: "command:help",
		label: "/help",
		description: "Show command help",
	},
	{
		id: "command:skill:review",
		label: "/skill:review",
		description: "Review the current change",
		searchText: "review skill",
	},
];

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

describe("CommandPaletteComponent", () => {
	it("fuzzy filters merged action, slash command, and skill entries and renders bindings", () => {
		const component = new CommandPaletteComponent(
			entries,
			() => {},
			() => {},
		);

		expect(component.render(80).join("\n")).toContain("Ctrl+N");
		component.handleInput("r");
		component.handleInput("v");

		const rendered = component.render(80).join("\n");
		expect(rendered).toContain("/skill:review");
		expect(rendered).not.toContain("Start a new session");
	});

	it("executes the selected entry on Enter", () => {
		const selected: string[] = [];
		const component = new CommandPaletteComponent(
			entries,
			entry => selected.push(entry.id),
			() => {},
		);

		component.handleInput("\n");

		expect(selected).toEqual(["action:app.session.new"]);
	});

	it("closes on Escape", () => {
		let cancelled = false;
		const component = new CommandPaletteComponent(
			entries,
			() => {},
			() => {
				cancelled = true;
			},
		);

		component.handleInput("\x1b");

		expect(cancelled).toBe(true);
	});
});
