import { beforeAll, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ThinkingSelectorComponent } from "@gajae-code/coding-agent/modes/components/thinking-selector";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderText(component: ThinkingSelectorComponent): string {
	return component.render(80).join("\n");
}

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

describe("ThinkingSelectorComponent", () => {
	it("shows scope actions before applying a selected effort", () => {
		const selections: Array<{ level: ThinkingLevel; persistDefault: boolean }> = [];
		const component = new ThinkingSelectorComponent(
			ThinkingLevel.Inherit,
			[ThinkingLevel.Inherit, ThinkingLevel.Off, ThinkingLevel.Low],
			selection => selections.push(selection),
			() => {},
		);

		const rendered = renderText(component);
		expect(stripAnsi(rendered)).toContain("inherit (current)");
		expect(rendered).toMatch(/\x1b\[[0-9;]*m \(current\)\x1b\[39m/);

		component.handleInput("\n");

		expect(selections).toEqual([]);
		expect(stripAnsi(renderText(component))).toContain("Apply for this session");

		component.handleInput("\n");

		expect(selections).toEqual([{ level: ThinkingLevel.Inherit, persistDefault: false }]);
	});

	it("supports setting an effort as the default", () => {
		const selections: Array<{ level: ThinkingLevel; persistDefault: boolean }> = [];
		const component = new ThinkingSelectorComponent(
			ThinkingLevel.Inherit,
			[ThinkingLevel.Inherit, ThinkingLevel.Off, ThinkingLevel.Low],
			selection => selections.push(selection),
			() => {},
		);

		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		component.handleInput("\x1b[B");
		component.handleInput("\n");

		expect(selections).toEqual([{ level: ThinkingLevel.Low, persistDefault: true }]);
	});

	it("preselects off when the session has no effective level", () => {
		const selections: Array<{ level: ThinkingLevel; persistDefault: boolean }> = [];
		const component = new ThinkingSelectorComponent(
			undefined,
			[ThinkingLevel.Inherit, ThinkingLevel.Off, ThinkingLevel.Low],
			selection => selections.push(selection),
			() => {},
		);

		const rendered = renderText(component);
		expect(stripAnsi(rendered)).toContain("off (current)");
		expect(rendered).toMatch(/\x1b\[[0-9;]*m \(current\)\x1b\[39m/);

		component.handleInput("\n");
		component.handleInput("\n");

		expect(selections).toEqual([{ level: ThinkingLevel.Off, persistDefault: false }]);
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
		expect(ctx.ui.setFocus).toHaveBeenLastCalledWith(selector);

		selector.handleInput("\n");
		expect(thinkingLevelCalls).toEqual([]);

		selector.handleInput("\n");

		expect(thinkingLevelCalls).toEqual([{ level: ThinkingLevel.High, persist: false }]);
		expect(statuses[0]).toContain("configured default: high");
		expect(statuses[0]).toContain("Effective effort: high");
		expect(ctx.statusLine.invalidate).toHaveBeenCalled();
		expect(ctx.updateEditorBorderColor).toHaveBeenCalled();
		expect(ctx.updateEditorTopBorder).toHaveBeenCalled();
		expect(ctx.ui.requestRender).toHaveBeenCalled();
		expect(ctx.ui.setFocus).toHaveBeenLastCalledWith(ctx.editor);
	});

	it("can persist the selected effort as the default", () => {
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
			thinkingLevel: ThinkingLevel.Off as ThinkingLevel | undefined,
			getAvailableThinkingLevels: () => [ThinkingLevel.Low, ThinkingLevel.High],
			setThinkingLevel(level: ThinkingLevel | undefined, persist?: boolean) {
				thinkingLevelCalls.push({ level, persist });
				this.thinkingLevel = level;
			},
		};
		const notifyConfigChanged = vi.fn();
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
			notifyConfigChanged,
			showStatus: (text: string) => statuses.push(text),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.showEffortSelector();
		const selector = editorContainer.children[0];
		if (!(selector instanceof ThinkingSelectorComponent)) {
			throw new Error("Expected /effort to mount ThinkingSelectorComponent");
		}

		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");

		expect(thinkingLevelCalls).toEqual([{ level: ThinkingLevel.Low, persist: true }]);
		expect(notifyConfigChanged).toHaveBeenCalled();
		expect(statuses[0]).toContain("Default reasoning effort");
		expect(statuses[0]).toContain("Effective effort: low");
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
		selector.handleInput("\x1b");

		expect(session.setThinkingLevel).not.toHaveBeenCalled();
		expect(ctx.ui.requestRender).toHaveBeenCalled();
		expect(ctx.ui.setFocus).toHaveBeenLastCalledWith(ctx.editor);
	});

	it("rejects persisted effort changes before mutating live session state during recovery", () => {
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
		const canWrite = vi.spyOn(settings, "canWriteDurableConfig").mockReturnValue(false);
		const session = {
			thinkingLevel: ThinkingLevel.Off as ThinkingLevel | undefined,
			getAvailableThinkingLevels: () => [ThinkingLevel.Low],
			setThinkingLevel: vi.fn(),
		};
		const showError = vi.fn();
		const ctx = {
			editorContainer,
			editor: {},
			session,
			settings,
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			updateEditorTopBorder: vi.fn(),
			showStatus: vi.fn(),
			showError,
		} as unknown as InteractiveModeContext;
		try {
			const controller = new SelectorController(ctx);
			controller.showEffortSelector();
			const selector = editorContainer.children[0];
			if (!(selector instanceof ThinkingSelectorComponent)) {
				throw new Error("Expected /effort to mount ThinkingSelectorComponent");
			}

			selector.handleInput("\x1b[B");
			selector.handleInput("\n");
			selector.handleInput("\x1b[B");
			selector.handleInput("\n");

			expect(session.setThinkingLevel).not.toHaveBeenCalled();
			expect(showError).toHaveBeenCalledWith(
				"Cannot change settings while config.yml has invalid YAML syntax. Repair config.yml and reload settings.",
			);
			expect(editorContainer.children[0]).toBe(selector);
		} finally {
			canWrite.mockRestore();
		}
	});
});
