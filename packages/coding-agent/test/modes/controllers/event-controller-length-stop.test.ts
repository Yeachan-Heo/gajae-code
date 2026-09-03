import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai";
import { resetSettingsForTest, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import type { AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { TERMINAL } from "@gajae-code/tui";

const TEXTLESS_LENGTH_WARNING =
	'Response ended with stopReason "length" before producing visible text or a tool call. Check the model\'s output and context token limits (maxTokens in models.yml) or lower the reasoning level (/reasoning), then retry.';

type Fixture = {
	controller: EventController;
	showWarning: ReturnType<typeof vi.fn>;
	continueSession: ReturnType<typeof vi.fn>;
	runIdleCompaction: ReturnType<typeof vi.fn>;
};

type OuterStopReason = "completed" | "cancelled" | "maintenance";
type AgentEndEvent = Extract<AgentSessionEvent, { type: "agent_end" }>;

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "length",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function createFixture(lastAssistant: AssistantMessage): Fixture {
	const showWarning = vi.fn();
	const continueSession = vi.fn();
	const runIdleCompaction = vi.fn();
	const ctx = {
		isInitialized: true,
		isBackgrounded: true,
		init: vi.fn(async () => {}),
		isStopped: () => false,
		setWorkingMessage: vi.fn(),
		loadingAnimation: undefined,
		statusContainer: { clear: vi.fn() },
		streamingComponent: undefined,
		pendingTools: new Map(),
		planModeController: { flushPendingModelSwitch: async () => {} },
		updateEditorBorderColor: vi.fn(),
		ui: { requestRender: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		editor: { getText: () => "" },
		showWarning,
		sessionManager: {
			getSessionName: () => "length-stop-test",
			getCwd: () => process.cwd(),
			getSessionId: () => "length-stop-test-session",
		},
		session: {
			getLastAssistantMessage: () => lastAssistant,
			isCompacting: false,
			isStreaming: false,
			queuedMessageCount: 0,
			continue: continueSession,
			runIdleCompaction,
			agent: { state: { messages: [lastAssistant] } },
		},
	} as unknown as InteractiveModeContext;
	return { controller: new EventController(ctx), showWarning, continueSession, runIdleCompaction };
}

function agentEndEvent(message: AssistantMessage, stopReason: OuterStopReason): AgentEndEvent {
	if (stopReason === "maintenance") {
		return {
			type: "agent_end",
			messages: [message],
			stopReason,
			maintenanceOutcome: "compacted",
		};
	}
	return { type: "agent_end", messages: [message], stopReason };
}

async function runAgentEnd(message: AssistantMessage, stopReason: OuterStopReason = "completed"): Promise<Fixture> {
	const fixture = createFixture(message);
	await fixture.controller.handleEvent(agentEndEvent(message, stopReason));
	return fixture;
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	settings.override("completion.notify", "off");
	settings.override("compaction.idleEnabled", false);
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("EventController textless length stop", () => {
	it("shows exactly one user-visible warning and does not continue the turn", async () => {
		const message = assistantMessage([{ type: "thinking", thinking: "reasoning consumed the budget" }]);
		const fixture = await runAgentEnd(message);

		expect(fixture.showWarning).toHaveBeenCalledTimes(1);
		expect(fixture.showWarning).toHaveBeenCalledWith(TEXTLESS_LENGTH_WARNING);
		expect(fixture.continueSession).not.toHaveBeenCalled();
		expect(fixture.runIdleCompaction).not.toHaveBeenCalled();
	});

	it("does not warn when a length stop contains visible text", async () => {
		const fixture = await runAgentEnd(assistantMessage([{ type: "text", text: "partial answer" }]));

		expect(fixture.showWarning).not.toHaveBeenCalled();
	});

	it("does not warn when a length stop contains a tool call", async () => {
		const fixture = await runAgentEnd(
			assistantMessage([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }]),
		);

		expect(fixture.showWarning).not.toHaveBeenCalled();
	});

	it("does not warn or change completion wording for a cancelled turn", async () => {
		const terminalNotification = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "on");
		const message = assistantMessage([{ type: "text", text: "partial answer before cancel" }]);
		const fixture = await runAgentEnd(message, "cancelled");

		expect(fixture.showWarning).not.toHaveBeenCalled();
		expect(fixture.continueSession).not.toHaveBeenCalled();
		expect(terminalNotification).toHaveBeenCalledWith("length-stop-test: Complete");
	});

	it("does not warn when the last assistant message was aborted", async () => {
		const message = assistantMessage(
			[{ type: "thinking", thinking: "an assistant abort is not a length stop" }],
			"aborted",
		);
		const fixture = await runAgentEnd(message);

		expect(fixture.showWarning).not.toHaveBeenCalled();
		expect(fixture.continueSession).not.toHaveBeenCalled();
	});

	it("does not warn for a maintenance turn", async () => {
		const message = assistantMessage([{ type: "thinking", thinking: "maintenance is not a user turn" }]);
		const fixture = await runAgentEnd(message, "maintenance");

		expect(fixture.showWarning).not.toHaveBeenCalled();
		expect(fixture.continueSession).not.toHaveBeenCalled();
	});

	it("uses output-limit wording instead of a successful completion notification", async () => {
		const terminalNotification = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "on");
		settings.set("completion.notifyCommand", "notify-test");
		const spawn = vi
			.spyOn(Bun, "spawn")
			.mockImplementation(
				() =>
					({ exited: Promise.resolve(0), kill: () => {}, unref: () => {} }) as unknown as Bun.Subprocess<
						"ignore",
						"ignore",
						"ignore"
					>,
			);
		const message = assistantMessage([{ type: "thinking", thinking: "reasoning consumed the budget" }]);

		const fixture = await runAgentEnd(message);

		expect(fixture.showWarning).toHaveBeenCalledTimes(1);
		expect(terminalNotification).toHaveBeenCalledWith("length-stop-test: Output limit reached");
		expect(spawn).toHaveBeenCalledTimes(1);
		const [, options] = spawn.mock.calls[0] as unknown as [string[], { env?: Record<string, string> }];
		expect(options.env?.GJC_NOTIFICATION_TITLE).toBe("length-stop-test: Output limit reached");
		expect(options.env?.GJC_NOTIFICATION_BODY).toBe(TEXTLESS_LENGTH_WARNING);
	});
});
