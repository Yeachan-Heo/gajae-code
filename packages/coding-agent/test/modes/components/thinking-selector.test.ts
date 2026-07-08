import { beforeAll, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ThinkingSelectorComponent } from "@gajae-code/coding-agent/modes/components/thinking-selector";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

describe("ThinkingSelectorComponent", () => {
	it("selects inherit, off, and effort values", () => {
		const selections: ThinkingLevel[] = [];
		const component = new ThinkingSelectorComponent(
			ThinkingLevel.Inherit,
			[ThinkingLevel.Inherit, ThinkingLevel.Off, ThinkingLevel.Low],
			level => selections.push(level),
			() => {},
		);

		component.getSelectList().handleInput("\n");
		component.getSelectList().handleInput("\x1b[B");
		component.getSelectList().handleInput("\n");
		component.getSelectList().handleInput("\x1b[B");
		component.getSelectList().handleInput("\n");

		expect(selections).toEqual([ThinkingLevel.Inherit, ThinkingLevel.Off, ThinkingLevel.Low]);
	});

	it("preselects off when the session has no effective level", () => {
		const selections: ThinkingLevel[] = [];
		const component = new ThinkingSelectorComponent(
			undefined,
			[ThinkingLevel.Inherit, ThinkingLevel.Off, ThinkingLevel.Low],
			level => selections.push(level),
			() => {},
		);

		component.getSelectList().handleInput("\n");

		expect(selections).toEqual([ThinkingLevel.Off]);
	});
});

describe("SelectorController effort selector", () => {
	it("applies inherit through the configured default and refreshes chrome", () => {
		const editorContainer = {
			children: [] as unknown[],
			clear() {
				this.children = [];
			},
			addChild(child: unknown) {
				this.children.push(child);
			},
		};
		const settings = Settings.isolated({ defaultThinkingLevel: ThinkingLevel.High });
		const statuses: string[] = [];
		const thinkingLevelCalls: Array<{ level: ThinkingLevel | undefined; persist: boolean | undefined }> = [];
		const session = {
			thinkingLevel: ThinkingLevel.Inherit as ThinkingLevel | undefined,
			getAvailableThinkingLevels: () => [ThinkingLevel.Low, ThinkingLevel.High],
			setThinkingLevel(level: ThinkingLevel | undefined, persist?: boolean) {
				thinkingLevelCalls.push({ level, persist });
				this.thinkingLevel = level;
			},
		};
		const ctx = {
			editorContainer,
			editor: {},
			session,
			settings,
			ui: {
				setFocus: vi.fn(),
				requestRender: vi.fn(),
			},
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			updateEditorTopBorder: vi.fn(),
			showStatus: (text: string) => statuses.push(text),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.showEffortSelector();

		const selector = editorContainer.children[0];
		if (!(selector instanceof ThinkingSelectorComponent)) {
			throw new Error("Expected /effort to mount ThinkingSelectorComponent");
		}
		expect(ctx.ui.setFocus).toHaveBeenLastCalledWith(selector.getSelectList());

		selector.getSelectList().handleInput("\n");

		expect(thinkingLevelCalls).toEqual([{ level: ThinkingLevel.High, persist: false }]);
		expect(statuses[0]).toContain("configured default: high");
		expect(statuses[0]).toContain("Effective effort: high");
		expect(ctx.statusLine.invalidate).toHaveBeenCalled();
		expect(ctx.updateEditorBorderColor).toHaveBeenCalled();
		expect(ctx.updateEditorTopBorder).toHaveBeenCalled();
		expect(ctx.ui.requestRender).toHaveBeenCalled();
		expect(ctx.ui.setFocus).toHaveBeenLastCalledWith(ctx.editor);
	});

	it("cancels without mutating thinking level", () => {
		const editorContainer = {
			children: [] as unknown[],
			clear() {
				this.children = [];
			},
			addChild(child: unknown) {
				this.children.push(child);
			},
		};
		const session = {
			thinkingLevel: ThinkingLevel.Off as ThinkingLevel | undefined,
			getAvailableThinkingLevels: () => [ThinkingLevel.Low],
			setThinkingLevel: vi.fn(),
		};
		const ctx = {
			editorContainer,
			editor: {},
			session,
			settings: Settings.isolated(),
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			updateEditorTopBorder: vi.fn(),
			showStatus: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.showEffortSelector();
		const selector = editorContainer.children[0];
		if (!(selector instanceof ThinkingSelectorComponent)) {
			throw new Error("Expected /effort to mount ThinkingSelectorComponent");
		}
		selector.getSelectList().handleInput("\x1b");

		expect(session.setThinkingLevel).not.toHaveBeenCalled();
		expect(ctx.ui.requestRender).toHaveBeenCalled();
		expect(ctx.ui.setFocus).toHaveBeenLastCalledWith(ctx.editor);
	});
});
