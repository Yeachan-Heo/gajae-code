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
	it("preserves a deferred command through running and completed transcript rebuilds", async () => {
		const chatContainer = new Container();
		const pendingMessagesContainer = new Container();
		const pendingBashComponents: BashExecutionComponent[] = [];
		const execution = Promise.withResolvers<{
			exitCode: number;
			cancelled: boolean;
			output: string;
			truncated: boolean;
		}>();
		const ui = { requestRender: () => {} } as unknown as TUI;
		const ctx = {
			session: {
				isStreaming: true,
				executeBash: async () => execution.promise,
				getQueuedMessages: () => ({ steering: [], followUp: [] }),
			},
			ui,
			chatContainer,
			pendingMessagesContainer,
			pendingBashComponents,
			pendingPythonComponents: [],
			compactionQueuedMessages: [],
			keybindings: { getDisplayString: () => "" },
			sessionManager: { buildSessionContext: () => ({}), getEntries: () => [] },
			renderSessionContext: () => {},
			pendingTools: new Map(),
			bashComponent: undefined,
			pythonComponent: undefined,
			streamingComponent: undefined,
			showError: () => {},
		} as unknown as InteractiveModeContext;

		const command = new CommandController(ctx).handleBashCommand("printf clean");
		const component = ctx.bashComponent;
		expect(component).toBeInstanceOf(BashExecutionComponent);
		expect(pendingMessagesContainer.children).toContain(component!);

		const helpers = new UiHelpers(ctx);
		helpers.updatePendingMessagesDisplay();
		helpers.renderInitialMessages();
		expect(pendingMessagesContainer.children).toContain(component!);

		execution.resolve({ exitCode: 0, cancelled: false, output: "clean", truncated: false });
		await command;

		helpers.renderInitialMessages();
		expect(pendingMessagesContainer.children).toEqual([component!]);
		expect(pendingMessagesContainer.render(120).join("\n")).toContain("clean");
		expect(ctx.pendingBashComponents).toEqual([component!]);
		expect(chatContainer.children).toHaveLength(0);

		helpers.flushPendingBashComponents();
		expect(pendingMessagesContainer.children).toHaveLength(0);
		expect(ctx.pendingBashComponents).toHaveLength(0);
		expect(chatContainer.children).toEqual([component!]);
		expect(chatContainer.render(120).join("\n")).toContain("clean");
		expect(ctx.bashComponent).toBeUndefined();
	});
});
