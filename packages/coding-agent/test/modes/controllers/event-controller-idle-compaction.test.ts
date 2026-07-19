import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 200,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 210,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("EventController idle compaction teardown", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": true,
				"compaction.idleThresholdTokens": 100,
				"compaction.idleTimeoutSeconds": 60,
			},
		});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("cancels scheduled idle compaction when disposed", async () => {
		const runIdleCompaction = vi.fn();
		const context = {
			isInitialized: true,
			isBackgrounded: false,
			loadingAnimation: undefined,
			streamingComponent: undefined,
			streamingMessage: undefined,
			pendingTools: new Map<string, unknown>(),
			planModeController: { flushPendingModelSwitch: async () => {} },
			ui: { requestRender: vi.fn() },
			chatContainer: { removeChild: vi.fn() },
			statusContainer: { clear: vi.fn() },
			statusLine: { invalidate: vi.fn() },
			updateEditorTopBorder: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			editor: { getText: () => "" },
			sessionManager: { getSessionName: () => undefined },
			session: {
				isCompacting: false,
				isStreaming: false,
				runIdleCompaction,
				agent: { state: { messages: [createAssistantMessage()] } },
			},
		} as unknown as InteractiveModeContext;

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		controller.dispose();
		vi.advanceTimersByTime(60_000);

		expect(runIdleCompaction).not.toHaveBeenCalled();
	});
});
