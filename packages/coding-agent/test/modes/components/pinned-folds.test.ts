import { beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai";
import { Container, type TUI } from "@gajae-code/tui";
import { resetSettingsForTest, Settings } from "../../../src/config/settings.js";
import { AssistantMessageComponent } from "../../../src/modes/components/assistant-message.js";
import { ReadToolGroupComponent } from "../../../src/modes/components/read-tool-group.js";
import { ToolExecutionComponent } from "../../../src/modes/components/tool-execution.js";
import { InputController } from "../../../src/modes/controllers/input-controller.js";
import { initTheme } from "../../../src/modes/theme/theme.js";
import type { InteractiveModeContext } from "../../../src/modes/types.js";

const uiStub = { requestRender() {} } as unknown as TUI;

function render(component: ToolExecutionComponent | ReadToolGroupComponent | AssistantMessageComponent): string {
	return Bun.stripANSI(component.render(100).join("\n"));
}

function assistantMessage(thinking: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function toolResult(lines: number): { content: Array<{ type: string; text: string }> } {
	return {
		content: [
			{
				type: "text",
				text: Array.from({ length: lines }, (_, index) =>
					index === 0 ? "fold-start-marker" : `line ${index + 1}`,
				).join("\n"),
			},
		],
	};
}

describe("manual output folds", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme(false);
	});

	it("retains a manually expanded tool result when its automatic completion state changes", () => {
		const component = new ToolExecutionComponent(
			"bash",
			{ command: "echo output" },
			{},
			undefined,
			uiStub,
			undefined,
			() => false,
		);
		component.setManuallyExpanded(true);
		component.updateResult(toolResult(30), false);
		component.setExpanded(false);

		expect(render(component)).toContain("fold-start-marker");
	});

	it("keeps automatic folding behavior for untouched tool results", () => {
		const component = new ToolExecutionComponent(
			"bash",
			{ command: "echo output" },
			{},
			undefined,
			uiStub,
			undefined,
			() => false,
		);
		component.updateResult(toolResult(30), false);
		component.setExpanded(false);

		expect(render(component)).not.toContain("fold-start-marker");
	});

	it("lets the global fold toggle override an earlier pin", () => {
		const component = new ToolExecutionComponent(
			"bash",
			{ command: "echo output" },
			{},
			undefined,
			uiStub,
			undefined,
			() => false,
		);
		const chatContainer = new Container();
		chatContainer.addChild(component);
		const ctx = { chatContainer, toolOutputExpanded: false, ui: uiStub } as unknown as InteractiveModeContext;
		const controller = new InputController(ctx);

		component.setManuallyExpanded(true);
		controller.setToolsExpanded(false);
		component.updateResult(toolResult(30), false);

		expect(render(component)).not.toContain("fold-start-marker");
	});
	it("lets the global fold toggle override an earlier read-group pin", () => {
		const component = new ReadToolGroupComponent({ showContentPreview: true, expandHintCapability: () => false });
		const chatContainer = new Container();
		chatContainer.addChild(component);
		const ctx = { chatContainer, toolOutputExpanded: false, ui: uiStub } as unknown as InteractiveModeContext;
		const controller = new InputController(ctx);

		component.updateArgs({ path: "/tmp/example.ts" }, "read");
		component.setManuallyExpanded(true);
		controller.setToolsExpanded(false);
		component.updateResult(toolResult(4), false, "read");

		expect(render(component)).not.toContain("line 4");
	});

	it("keeps hidden thinking hidden through streaming updates", () => {
		const thinking = { type: "thinking" as const, thinking: "private thought" };
		const component = new AssistantMessageComponent(assistantMessage(thinking.thinking));
		component.setHideThinkingBlock(true);
		thinking.thinking += " still private";
		component.updateContent(assistantMessage(thinking.thinking), { streaming: true });

		const output = render(component);
		expect(output).toContain("Thinking...");
		expect(output).not.toContain("private thought");
	});
});
