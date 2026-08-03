import { beforeAll, describe, expect, it } from "bun:test";
import { BashExecutionComponent } from "@gajae-code/coding-agent/modes/components/bash-execution";
import { CommandController } from "@gajae-code/coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import { associateSessionMessageEntryId } from "@gajae-code/coding-agent/session/session-manager";
import { Container, type TUI } from "@gajae-code/tui";

beforeAll(async () => {
	const theme = await getThemeByName("red-claw");
	expect(theme).toBeDefined();
	setThemeInstance(theme!);
});

describe("shell command display", () => {
	it("uses the persisted deferred result instead of duplicating its live component during rebuild", async () => {
		const chatContainer = new Container();
		const pendingMessagesContainer = new Container();
		const pendingBashComponents: BashExecutionComponent[] = [];
		const ui = { requestRender: () => {} } as unknown as TUI;
		const completion = Promise.withResolvers<{
			exitCode: number;
			cancelled: boolean;
			output: string;
			truncated: boolean;
		}>();
		const entryIds = new WeakMap<object, string>();
		let displayIdentity: object | undefined;
		const persistedMessage = {
			role: "bashExecution" as const,
			command: "printf clean",
			output: "clean",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 1,
		};
		associateSessionMessageEntryId(persistedMessage, "bash-entry");

		const ctx = {
			session: {
				isStreaming: true,
				executeBash: async (
					_command: string,
					_onChunk: ((chunk: string) => void) | undefined,
					options: { displayIdentity?: object },
				) => {
					displayIdentity = options.displayIdentity;
					return completion.promise;
				},
				getBashExecutionEntryId: (identity: object) => entryIds.get(identity),
				getQueuedMessages: () => ({ steering: [], followUp: [] }),
			},
			ui,
			chatContainer,
			pendingMessagesContainer,
			pendingBashComponents,
			pendingPythonComponents: [],
			compactionQueuedMessages: [],
			keybindings: { getDisplayString: () => "" },
			sessionManager: {
				buildSessionContext: () => ({ messages: [persistedMessage] }),
				getEntries: () => [],
			},
			renderSessionContext: () => {
				const component = new BashExecutionComponent("printf clean", ui, false);
				component.setComplete(0, false, { output: "clean" });
				chatContainer.addChild(component);
			},
			pendingTools: new Map(),
			bashComponent: undefined,
			pythonComponent: undefined,
			streamingComponent: undefined,
			showError: () => {},
		} as unknown as InteractiveModeContext;

		const command = new CommandController(ctx).handleBashCommand("printf clean");
		const liveComponent = ctx.bashComponent;
		expect(liveComponent).toBeInstanceOf(BashExecutionComponent);
		if (!liveComponent) throw new Error("Expected live bash component");
		expect(pendingMessagesContainer.children).toEqual([liveComponent]);

		while (!displayIdentity) await Promise.resolve();
		entryIds.set(displayIdentity, "bash-entry");
		new UiHelpers(ctx).renderInitialMessages();

		expect(pendingMessagesContainer.children).toHaveLength(0);
		expect(ctx.pendingBashComponents).toHaveLength(0);
		expect(chatContainer.children).toHaveLength(1);

		completion.resolve({ exitCode: 0, cancelled: false, output: "clean", truncated: false });
		await command;

		expect(chatContainer.children).toHaveLength(1);
		expect(ctx.bashComponent).toBeUndefined();
	});
	it("preserves an unrelated running shell component across flush and transcript rebuild", () => {
		const chatContainer = new Container();
		const pendingMessagesContainer = new Container();
		const ui = { requestRender: () => {} } as unknown as TUI;
		const completed = new BashExecutionComponent("printf done", ui, false);
		completed.setComplete(0, false, { output: "done" });
		const running = new BashExecutionComponent("sleep 10", ui, false);
		pendingMessagesContainer.addChild(completed);
		pendingMessagesContainer.addChild(running);
		const persistedMessage = {
			role: "bashExecution" as const,
			command: "printf done",
			output: "done",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 1,
		};
		associateSessionMessageEntryId(persistedMessage, "completed-entry");
		const ctx = {
			session: {
				getBashExecutionEntryId: () => undefined,
				getQueuedMessages: () => ({ steering: [], followUp: [] }),
			},
			ui,
			chatContainer,
			pendingMessagesContainer,
			pendingBashComponents: [completed, running],
			pendingPythonComponents: [],
			compactionQueuedMessages: [],
			keybindings: { getDisplayString: () => "" },
			sessionManager: {
				buildSessionContext: () => ({ messages: [persistedMessage] }),
				getEntries: () => [],
			},
			renderSessionContext: () => {
				const component = new BashExecutionComponent("printf done", ui, false);
				component.setComplete(0, false, { output: "done" });
				chatContainer.addChild(component);
			},
			pendingTools: new Map(),
			bashComponent: running,
			pythonComponent: undefined,
			streamingComponent: undefined,
		} as unknown as InteractiveModeContext;
		const helpers = new UiHelpers(ctx);

		helpers.flushPendingBashComponents();
		expect(chatContainer.children).toEqual([completed]);
		expect(pendingMessagesContainer.children).toEqual([running]);
		expect(ctx.pendingBashComponents).toEqual([running]);

		helpers.renderInitialMessages();
		expect(chatContainer.children).toHaveLength(1);
		expect(pendingMessagesContainer.children).toEqual([running]);
		expect(ctx.pendingBashComponents).toEqual([running]);
		expect(ctx.bashComponent).toBe(running);
	});
});
