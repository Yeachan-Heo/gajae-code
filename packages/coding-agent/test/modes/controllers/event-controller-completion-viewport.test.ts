import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { AssistantMessageComponent } from "@gajae-code/coding-agent/modes/components/assistant-message";
import { IrcSplitViewComponent } from "@gajae-code/coding-agent/modes/components/irc-sidebar";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import { IrcObservationLedger } from "@gajae-code/coding-agent/modes/irc-observation-ledger";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import {
	associateSessionMessageViewportAnchorId,
	getSessionMessageViewportAnchorId,
} from "@gajae-code/coding-agent/session/session-manager";
import { Container, shouldUseViewportRepaintForHost, Text, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

beforeAll(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme();
});

afterAll(() => resetSettingsForTest());

describe("EventController completion viewport", () => {
	const envKeys = [
		"GJC_NOTIFY",
		"SSH_CONNECTION",
		"TERM",
		"COLORTERM",
		"WT_SESSION",
		"TERM_PROGRAM",
		"TMUX",
		"TMUX_PANE",
		"STY",
		"ZELLIJ",
		"GJC_TMUX_LAUNCHED",
		"TERMUX_VERSION",
		"PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER",
		"PI_CLEAR_ON_SHRINK",
		"PI_TUI_VIRTUAL_VIEWPORT",
	] as const;
	let previousEnv = new Map<string, string | undefined>();

	function restoreEnv(snapshot: Map<string, string | undefined>): void {
		for (const key of envKeys) {
			const value = snapshot.get(key);
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	}

	afterEach(() => restoreEnv(previousEnv));

	it("preserves manual transcript rows through real completion lifecycle on supported terminal hosts", async () => {
		previousEnv = new Map(envKeys.map(key => [key, Bun.env[key]]));
		const cases: Array<{
			label: string;
			env: Partial<Record<(typeof envKeys)[number], string>>;
			resizeHeight?: number;
			nativeWindows?: boolean;
		}> = [
			{ label: "plain-ssh", env: { SSH_CONNECTION: "client server", TERM: "xterm-256color" } },
			{ label: "tmux-default", env: { TMUX: "/tmp/tmux,1,0", TERM: "tmux-256color" } },
			{
				label: "tmux-legacy",
				env: { TMUX: "/tmp/tmux,1,0", TERM: "tmux-256color", PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER: "1" },
			},
			{ label: "termux-height", env: { TERMUX_VERSION: "0.118", TERM: "xterm-256color" }, resizeHeight: 14 },
			{
				label: "windows-markers",
				env: { WT_SESSION: "forwarded", TERM_PROGRAM: "Windows_Terminal", TERM: "xterm-256color" },
			},
			{ label: "native-windows-selector", env: { TERM: "xterm-256color" }, nativeWindows: true },
		];

		for (const testCase of cases) {
			for (const clearOnShrink of [false, true]) {
				const scenarioEnv = new Map(envKeys.map(key => [key, Bun.env[key]]));
				for (const key of envKeys) delete Bun.env[key];
				Object.assign(Bun.env, testCase.env);
				Bun.env.GJC_NOTIFY = "off";
				try {
					if (testCase.nativeWindows) {
						expect(shouldUseViewportRepaintForHost({}, "win32", { includeNativeWindows: true })).toBe(true);
					}

					const term = new VirtualTerminal(40, 18, { isProcessTerminal: true });
					const ui = new TUI(term);
					ui.setClearOnShrink(clearOnShrink);
					const chatContainer = new Container();
					const startMessage = assistantMessage("streaming assistant response");
					const message = assistantMessage("final assistant response");
					const anchorId = `assistant:test:${testCase.label}:${clearOnShrink}`;
					associateSessionMessageViewportAnchorId(startMessage, anchorId);
					const streamingComponent = new AssistantMessageComponent(startMessage, false, undefined, anchorId);
					const split = new IrcSplitViewComponent(chatContainer, new IrcObservationLedger(), {
						fg: (_color: "dim" | "accent", text: string) => text,
						bold: (text: string) => text,
						boxSharp: { vertical: "│" },
					});
					const pendingMessagesContainer = new Container();
					const statusContainer = new Container();
					statusContainer.addChild(new Text("working", 0, 0));
					const todoContainer = new Container();
					const btwContainer = new Container();
					const statusLine = new Text("status", 0, 0);
					const editor = new Text("editor", 0, 0);
					ui.addChild(split);
					ui.setViewportAnchorComponent(split);
					ui.addChild(pendingMessagesContainer);
					ui.addChild(statusContainer);
					ui.addChild(todoContainer);
					ui.addChild(btwContainer);
					ui.addChild(statusLine);
					ui.addChild(editor);
					ui.setBottomPinnedComponent(statusLine);
					const stopLoading = vi.fn();
					const ctx = {
						isInitialized: true,
						ui,
						chatContainer,
						pendingMessagesContainer,
						statusContainer,
						todoContainer,
						btwContainer,
						statusLine,
						editor: { getText: () => "" },
						getUserMessageText: (userMessage: { content: string }) => userMessage.content,
						streamingComponent,
						streamingMessage: startMessage,
						loadingAnimation: { stop: stopLoading },
						pendingTools: new Map(),
						planModeController: { flushPendingModelSwitch: async () => {} },
						updateEditorTopBorder: () => {},
						updateEditorBorderColor: () => {},
						session: {
							isTtsrAbortPending: false,
							retryAttempt: 0,
							isCompacting: true,
							getLastAssistantMessage: () => message,
						},
						sessionManager: { getSessionName: () => "", getCwd: () => process.cwd() },
						isBackgrounded: false,
					} as unknown as InteractiveModeContext;
					const uiHelpers = new UiHelpers(ctx);
					for (let index = 0; index < 30; index++) {
						uiHelpers.addMessageToChat({ role: "user", content: `history-${index}`, timestamp: index + 1 });
					}
					chatContainer.addChild(streamingComponent);
					const controller = new EventController(ctx);
					try {
						ui.start();
						await term.waitForRender();
						expect(ui.scrollViewportPages(-1), `${testCase.label} clear=${clearOnShrink}`).toBe(true);
						await term.flush();
						if (testCase.resizeHeight !== undefined) {
							term.resize(40, testCase.resizeHeight);
							await term.waitForRender();
						}
						const before = term.getViewport().map(line => line.trimEnd());
						const beforeHistory = before.flatMap((line, index) =>
							line.includes("history-") ? [{ index, line }] : [],
						);
						expect(beforeHistory.length, JSON.stringify(before)).toBeGreaterThanOrEqual(3);
						term.clearWriteLog();
						await controller.handleEvent({ type: "message_end", message });
						expect(getSessionMessageViewportAnchorId(message)).toBe(anchorId);
						await term.waitForRender();
						await controller.handleEvent({ type: "agent_end", messages: [message] });
						await term.waitForRender();
						expect(stopLoading, `${testCase.label} clear=${clearOnShrink}`).toHaveBeenCalledTimes(1);
						expect(ctx.loadingAnimation, `${testCase.label} clear=${clearOnShrink}`).toBeUndefined();
						expect(statusContainer.children, `${testCase.label} clear=${clearOnShrink}`).toHaveLength(0);
						const after = term.getViewport().map(line => line.trimEnd());
						for (const entry of beforeHistory) expect(after[entry.index]).toBe(entry.line);
						const writes = term.getWriteLog().join("");
						expect(writes).not.toContain("\x1b[2J\x1b[H");
						expect(writes).not.toContain("\x1b[3J");
						const visibleHistoryNumbers = beforeHistory.flatMap(entry => {
							const match = /history-(\d+)/.exec(entry.line);
							return match ? [Number(match[1])] : [];
						});
						const firstVisibleHistory = Math.min(...visibleHistoryNumbers);
						for (let index = 0; index < firstVisibleHistory; index++) {
							expect(writes).not.toMatch(new RegExp(`history-${index}(?!\\d)`));
						}
						term.clearWriteLog();
						ui.requestRender();
						await term.waitForRender();
						expect(term.getWriteLog(), `${testCase.label} clear=${clearOnShrink} immediate no-op`).toEqual([]);
					} finally {
						ui.stop();
					}
				} finally {
					restoreEnv(scenarioEnv);
				}
			}
		}
	});
});
