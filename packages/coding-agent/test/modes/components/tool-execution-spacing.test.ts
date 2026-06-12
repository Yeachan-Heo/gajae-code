import { beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { ToolExecutionComponent } from "@gajae-code/coding-agent/modes/components/tool-execution";
import * as themeModule from "@gajae-code/coding-agent/modes/theme/theme";
import type { TUI } from "@gajae-code/tui";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await themeModule.initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

const uiStub = { requestRender() {} } as unknown as TUI;

function renderTool(command: string): string[] {
	const component = new ToolExecutionComponent("bash", { command }, {}, undefined, uiStub);
	component.updateResult({ content: [{ type: "text", text: `output of ${command}` }], isError: false }, false);
	return component.render(80).map(line => Bun.stripANSI(line));
}

function countEdgeBlanks(lines: string[]): { leading: number; trailing: number } {
	let leading = 0;
	for (let i = 0; i < lines.length && lines[i].trim() === ""; i++) leading++;
	let trailing = 0;
	for (let i = lines.length - 1; i >= 0 && lines[i].trim() === ""; i--) trailing++;
	return { leading, trailing };
}

// 083.2: block separation is exactly the leading Spacer (1 blank line above each
// block); the content box itself has no vertical padding. Two consecutive tools
// must be separated by exactly 1 blank line.
describe("ToolExecutionComponent spacing", () => {
	it("renders exactly one blank line above and none below a tool block", () => {
		const lines = renderTool("ls -la");
		const { leading, trailing } = countEdgeBlanks(lines);
		expect(leading).toBe(1);
		expect(trailing).toBe(0);
	});

	it("separates consecutive tool blocks by exactly one blank line", () => {
		const a = renderTool("ls -la");
		const b = renderTool("git status");
		const { trailing } = countEdgeBlanks(a);
		const { leading } = countEdgeBlanks(b);
		expect(trailing + leading).toBe(1);
	});
});
