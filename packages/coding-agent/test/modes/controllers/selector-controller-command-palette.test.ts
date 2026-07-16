import { describe, expect, it, vi } from "bun:test";
import type { CommandPaletteComponent } from "@gajae-code/coding-agent/modes/components/command-palette";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import type { SlashCommand } from "@gajae-code/tui";

describe("SelectorController command palette", () => {
	it("surfaces rejected handlers without an unhandled rejection", async () => {
		const component = { clear: vi.fn(), addChild: vi.fn() };
		const showError = vi.fn();
		const ctx = {
			editorContainer: component,
			editor: {},
			restoreComposer: vi.fn(),
			keybindings: { getKeys: () => [] },
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			showError,
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);
		const unhandled = vi.fn();
		process.once("unhandledRejection", unhandled);

		controller.showCommandPalette([{ name: "broken", description: "Rejects" }] as SlashCommand[], [], async () => {
			throw new Error("palette command failed");
		});
		const palette = component.addChild.mock.calls[0]?.[0] as CommandPaletteComponent;
		palette.handleInput("\r");
		await Bun.sleep(0);

		expect(showError).toHaveBeenCalledWith("palette command failed");
		expect(unhandled).not.toHaveBeenCalled();
	});
	it("surfaces rejected action handlers", async () => {
		const component = { clear: vi.fn(), addChild: vi.fn() };
		const showError = vi.fn();
		const ctx = {
			editorContainer: component,
			editor: {},
			restoreComposer: vi.fn(),
			keybindings: { getKeys: () => [] },
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			showError,
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.showCommandPalette(
			[],
			[
				{
					id: "app.editor.external",
					label: "External editor",
					handler: async () => {
						throw new Error("external editor failed");
					},
				},
			],
			async () => {},
		);
		const palette = component.addChild.mock.calls[0]?.[0] as CommandPaletteComponent;
		palette.handleInput("\r");
		await Bun.sleep(0);

		expect(showError).toHaveBeenCalledWith("external editor failed");
	});
});
