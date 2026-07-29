import { beforeAll, describe, expect, it } from "bun:test";
import { BashExecutionComponent } from "@gajae-code/coding-agent/modes/components/bash-execution";
import { CommandController } from "@gajae-code/coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import { Container, type TUI } from "@gajae-code/tui";

beforeAll(async () => {
	const theme = await getThemeByName("red-claw");
	expect(theme).toBeDefined();
	setThemeInstance(theme!);
});

describe("shell command display", () => {
	it("removes a completed deferred command from the pending surface", async () => {
		const chatContainer = new Container();
		const pendingMessagesContainer = new Container();
		const pendingBashComponents: BashExecutionComponent[] = [];
		const ui = { requestRender: () => {} } as unknown as TUI;
		const ctx = {
			session: {
				isStreaming: true,
				executeBash: async () => ({
					exitCode: 0,
					cancelled: false,
					output: "clean",
					truncated: false,
				}),
			},
			ui,
			chatContainer,
			pendingMessagesContainer,
			pendingBashComponents,
			pendingPythonComponents: [],
			pendingTools: new Map(),
			bashComponent: undefined,
			pythonComponent: undefined,
			streamingComponent: undefined,
			showError: () => {},
		} as unknown as InteractiveModeContext;

		await new CommandController(ctx).handleBashCommand("printf clean");

		expect(pendingMessagesContainer.children).toHaveLength(0);
		expect(ctx.pendingBashComponents).toHaveLength(1);
		expect(chatContainer.children).toHaveLength(0);
		expect(ctx.bashComponent).toBeUndefined();

		new UiHelpers(ctx).flushPendingBashComponents();

		expect(ctx.pendingBashComponents).toHaveLength(0);
		expect(chatContainer.children).toHaveLength(1);
		expect(chatContainer.children[0]).toBeInstanceOf(BashExecutionComponent);
	});
});
