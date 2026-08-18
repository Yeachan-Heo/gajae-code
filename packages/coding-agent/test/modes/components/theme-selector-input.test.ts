import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import { ThemeSelectorComponent } from "@gajae-code/coding-agent/modes/components/theme-selector";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import * as themeModule from "@gajae-code/coding-agent/modes/theme/theme";
import { initTheme, previewTheme, restoreThemePreview, theme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";

const THEMES = ["red-claw", "blue-crab"];
const ORIGINAL_COLORTERM = Bun.env.COLORTERM;

type ThemeSelectorHarness = {
	component: ThemeSelectorComponent;
	selectedThemes: string[];
	previewedThemes: string[];
	cancellations: string[];
};

beforeAll(async () => {
	Bun.env.COLORTERM = "truecolor";
	await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

afterAll(() => {
	if (ORIGINAL_COLORTERM === undefined) {
		delete Bun.env.COLORTERM;
	} else {
		Bun.env.COLORTERM = ORIGINAL_COLORTERM;
	}
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	settings.set("theme.dark", "red-claw");
	settings.set("theme.light", "blue-crab");
});

afterEach(() => {
	resetSettingsForTest();
	vi.restoreAllMocks();
});

function createSelector(): ThemeSelectorHarness {
	const selectedThemes: string[] = [];
	const previewedThemes: string[] = [];
	const cancellations: string[] = [];
	const component = new ThemeSelectorComponent(
		"red-claw",
		THEMES,
		themeName => {
			selectedThemes.push(themeName);
		},
		() => {
			cancellations.push("cancelled");
		},
		themeName => {
			previewedThemes.push(themeName);
		},
	);

	return { component, selectedThemes, previewedThemes, cancellations };
}

describe("ThemeSelectorComponent input handling", () => {
	it("confirms Enter on the focused theme list", () => {
		const { component, selectedThemes } = createSelector();

		component.getSelectList().handleInput("\n");

		expect(selectedThemes).toEqual(["red-claw"]);
	});

	it("renders the framed selector title", () => {
		const { component } = createSelector();

		expect(Bun.stripANSI(component.render(160).join("\n"))).toContain("Select theme");
	});

	it("previews the newly selected theme from focused list navigation", () => {
		const { component, previewedThemes } = createSelector();

		component.getSelectList().handleInput("\x1b[B");

		expect(previewedThemes).toEqual(["blue-crab"]);
	});

	it("recolors the open /theme selector when previewing", async () => {
		const component = new ThemeSelectorComponent(
			"red-claw",
			THEMES,
			() => {},
			() => {},
			themeName => {
				void previewTheme(themeName);
			},
		);

		component.getSelectList().handleInput("\x1b[B");
		await Bun.sleep(1);

		const title = component.render(160).find(line => Bun.stripANSI(line).includes("Select theme"));
		expect(title).toContain(theme.getFgAnsi("accent"));
		expect(theme.getFgAnsi("accent")).toBe("\u001b[38;2;94;200;255m");
		await restoreThemePreview("red-claw");
	});

	it("cancels on Escape from the focused theme list", () => {
		const { component, cancellations } = createSelector();

		component.getSelectList().handleInput("\x1b");

		expect(cancellations).toEqual(["cancelled"]);
	});

	it("keeps /theme input live by focusing the internal list", async () => {
		const focusedComponents: unknown[] = [];
		const editorContainer = {
			children: [] as unknown[],
			clear() {
				this.children = [];
			},
			detachChild(child: unknown) {
				const index = this.children.indexOf(child);
				if (index !== -1) this.children.splice(index, 1);
			},
			addChild(child: unknown) {
				this.children.push(child);
			},
		};
		const ctx = {
			editorContainer,
			editor: {},
			ui: {
				setFocus: vi.fn((component: unknown) => {
					focusedComponents.push(component);
				}),
				requestRender: vi.fn(),
				terminal: { columns: 120 },
			},
			statusLine: {
				invalidate: vi.fn(),
			},
			updateEditorTopBorder: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.showThemeSelector();
		for (let i = 0; i < 10 && focusedComponents.length === 0; i++) {
			await Bun.sleep(1);
		}

		const focused = focusedComponents.at(-1);
		const selector = editorContainer.children[0];
		if (!(selector instanceof ThemeSelectorComponent)) {
			throw new Error("Expected /theme to mount ThemeSelectorComponent");
		}
		expect(focused).toBe(selector.getSelectList());

		selector.getSelectList().handleInput("\x1b[B");
		selector.getSelectList().handleInput("\n");
		await Bun.sleep(1);

		expect(settings.get("theme.dark")).toBe("blue-crab");
		expect(ctx.ui.setFocus).toHaveBeenLastCalledWith(ctx.editor);
		expect(ctx.statusLine.invalidate).toHaveBeenCalled();
		expect(ctx.updateEditorTopBorder).toHaveBeenCalled();
	});

	it("keeps /theme open and restores its persisted mapping when confirmation fails", async () => {
		const editorContainer = {
			children: [] as unknown[],
			clear() {
				this.children = [];
			},
			detachChild(child: unknown) {
				const index = this.children.indexOf(child);
				if (index !== -1) this.children.splice(index, 1);
			},
			addChild(child: unknown) {
				this.children.push(child);
			},
		};
		const ctx = {
			editorContainer,
			editor: {},
			ui: { setFocus: vi.fn(), requestRender: vi.fn(), terminal: { columns: 120 } },
			statusLine: { invalidate: vi.fn() },
			updateEditorTopBorder: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const restore = vi.spyOn(themeModule, "restoreThemePreview");
		restore.mockResolvedValueOnce({ success: false, error: "missing selected theme" });
		restore.mockResolvedValueOnce({ success: true });

		const controller = new SelectorController(ctx);
		controller.showThemeSelector();
		for (let i = 0; i < 10 && editorContainer.children.length === 0; i++) {
			await Bun.sleep(1);
		}
		const selector = editorContainer.children[0];
		if (!(selector instanceof ThemeSelectorComponent)) {
			throw new Error("Expected /theme to mount ThemeSelectorComponent");
		}

		selector.getSelectList().handleInput("\x1b[B");
		selector.getSelectList().handleInput("\n");
		await Bun.sleep(1);

		expect(settings.get("theme.dark")).toBe("red-claw");
		expect(editorContainer.children[0]).toBe(selector);
		expect(ctx.showError).toHaveBeenCalledWith("Failed to apply theme: missing selected theme");
	});
});
