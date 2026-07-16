import { describe, expect, it, vi } from "bun:test";
import type { CommandPaletteComponent } from "@gajae-code/coding-agent/modes/components/command-palette";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import type { SlashCommand } from "@gajae-code/tui";

describe("SelectorController command palette", () => {
	it("surfaces rejected handlers without an unhandled rejection", async () => {
		const component = { clear: vi.fn(), addChild: vi.fn() };
		const errorShown = Promise.withResolvers<void>();
		const showError = vi.fn(() => errorShown.resolve());
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
		process.on("unhandledRejection", unhandled);

		try {
			controller.showCommandPalette([{ name: "broken", description: "Rejects" }] as SlashCommand[], [], async () => {
				throw new Error("palette command failed");
			});
			const palette = component.addChild.mock.calls[0]?.[0] as CommandPaletteComponent;
			palette.handleInput("\r");
			await errorShown.promise;
			await new Promise<void>(resolve => setImmediate(resolve));

			expect(showError).toHaveBeenCalledWith("palette command failed");
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", unhandled);
		}
	});
	it("surfaces rejected action handlers", async () => {
		const component = { clear: vi.fn(), addChild: vi.fn() };
		const errorShown = Promise.withResolvers<void>();
		const showError = vi.fn(() => errorShown.resolve());
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
		await errorShown.promise;

		expect(showError).toHaveBeenCalledWith("external editor failed");
	});
});
