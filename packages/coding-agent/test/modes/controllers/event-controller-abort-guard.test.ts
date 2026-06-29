/**
 * Regression test for the abort-guard on `EventController.sendCompletionNotification`.
 *
 * Bug: a user Ctrl+C on the `ask` tool selector throws `ToolAbortError`,
 * the turn ends with `stopReason === "aborted"`, and `handleBackgroundEvent`
 * fires `sendCompletionNotification()` unconditionally. The pre-fix code
 * then produced a misleading "Task complete" desktop toast for a turn that
 * never actually completed. The fix mirrors the `stopReason !== "aborted"`
 * pattern already used by `#currentContextTokens`, `#handleMessageEnd`, and
 * the retry / TTSR / compaction skip paths in `agent-session.ts`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@gajae-code/ai";
import { resetSettingsForTest, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { TERMINAL } from "@gajae-code/tui";

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-abortguard-"));
	await Settings.init({ inMemory: true, cwd: tempDir });
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

type StopReason = "stop" | "aborted" | "error";
type NotifyProc = Bun.Subprocess<"ignore", "ignore", "ignore">;

function makeAssistantMessage(stopReason: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		stopReason,
		usage: { inputTokens: 0, outputTokens: 0 },
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

function makeContext(lastMessage: AssistantMessage | undefined): InteractiveModeContext {
	return {
		// sendCompletionNotification only fires when backgrounded.
		isBackgrounded: true,
		sessionManager: {
			getSessionName: () => "test-session",
			getCwd: () => process.cwd(),
			getSessionId: () => "session-test",
		},
		session: {
			getLastAssistantMessage: () => lastMessage,
		},
	} as unknown as InteractiveModeContext;
}

describe("EventController.sendCompletionNotification — abort guard", () => {
	it("skips notification when the last assistant message stopReason === 'aborted'", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "on");
		const controller = new EventController(makeContext(makeAssistantMessage("aborted")));
		controller.sendCompletionNotification();
		expect(spy).toHaveBeenCalledTimes(0);
	});

	it("skips notification when the last assistant message stopReason === 'error'", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "on");
		const controller = new EventController(makeContext(makeAssistantMessage("error")));
		controller.sendCompletionNotification();
		expect(spy).toHaveBeenCalledTimes(0);
	});

	it("fires notification when stopReason === 'stop' (normal completion)", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "on");
		const controller = new EventController(makeContext(makeAssistantMessage("stop")));
		controller.sendCompletionNotification();
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("Complete"));
	});

	it("rings terminal bell on completion only when enabled", () => {
		vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		settings.override("completion.notify", "on");
		settings.set("notifications.terminalBell", true);
		settings.set("notifications.bellOnComplete", true);
		const controller = new EventController(makeContext(makeAssistantMessage("stop")));
		controller.sendCompletionNotification();
		expect(writeSpy).toHaveBeenCalledWith("\x07");
	});

	it("does not ring terminal bell when completion bell is disabled", () => {
		vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		settings.override("completion.notify", "on");
		settings.set("notifications.terminalBell", true);
		settings.set("notifications.bellOnComplete", false);
		const controller = new EventController(makeContext(makeAssistantMessage("stop")));
		controller.sendCompletionNotification();
		expect(writeSpy).not.toHaveBeenCalledWith("\x07");
	});

	it("fires notification when getLastAssistantMessage is absent (e.g. brand-new session)", () => {
		// Defensive: optional-chain `?.()` returns undefined; treat as 'no abort flag', proceed.
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "on");
		const controller = new EventController(makeContext(undefined));
		controller.sendCompletionNotification();
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("honors the existing isBackgrounded gate for terminal notifications", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "on");
		const ctx = makeContext(makeAssistantMessage("stop"));
		(ctx as unknown as { isBackgrounded: boolean }).isBackgrounded = false;
		const controller = new EventController(ctx);
		controller.sendCompletionNotification();
		expect(spy).toHaveBeenCalledTimes(0);
	});

	it("honors the existing completion.notify=off gate", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "off");
		const controller = new EventController(makeContext(makeAssistantMessage("stop")));
		controller.sendCompletionNotification();
		expect(spy).toHaveBeenCalledTimes(0);
	});

	it("runs the user-level completion notify command with payload environment", () => {
		const terminalSpy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		const spawnSpy = vi.spyOn(Bun, "spawn").mockImplementation(
			() =>
				({
					exited: Promise.resolve(0),
					kill: () => {},
					unref: () => {},
				}) as unknown as NotifyProc,
		);
		settings.override("completion.notify", "on");
		settings.set("completion.notifyCommand", "notify-test");
		const controller = new EventController(makeContext(makeAssistantMessage("stop")));
		controller.sendCompletionNotification();

		expect(terminalSpy).toHaveBeenCalledTimes(1);
		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const [cmd, options] = spawnSpy.mock.calls[0] as unknown as [
			string[],
			{ cwd?: string; env?: Record<string, string> },
		];
		expect(cmd).toContain("notify-test");
		expect(options.cwd).toBe(process.cwd());
		expect(options.env?.GJC_NOTIFICATION_TYPE).toBe("agent-turn-complete");
		expect(options.env?.GJC_NOTIFICATION_TITLE).toBe("test-session: Complete");
		expect(options.env?.GJC_NOTIFICATION_BODY).toBe("hello");
		expect(options.env?.GJC_NOTIFICATION_SESSION_ID).toBe("session-test");
	});

	it("runs the user-level completion notify command even when foreground", () => {
		const terminalSpy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		const spawnSpy = vi.spyOn(Bun, "spawn").mockImplementation(
			() =>
				({
					exited: Promise.resolve(0),
					kill: () => {},
					unref: () => {},
				}) as unknown as NotifyProc,
		);
		settings.override("completion.notify", "on");
		settings.set("completion.notifyCommand", "notify-test");
		const ctx = makeContext(makeAssistantMessage("stop"));
		(ctx as unknown as { isBackgrounded: boolean }).isBackgrounded = false;
		const controller = new EventController(ctx);
		controller.sendCompletionNotification();

		expect(terminalSpy).toHaveBeenCalledTimes(0);
		expect(spawnSpy).toHaveBeenCalledTimes(1);
	});

	it("does not run completion notify commands from runtime or project overrides", () => {
		const terminalSpy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		const spawnSpy = vi.spyOn(Bun, "spawn").mockImplementation(
			() =>
				({
					exited: Promise.resolve(0),
					kill: () => {},
					unref: () => {},
				}) as unknown as NotifyProc,
		);
		settings.override("completion.notify", "on");
		settings.override("completion.notifyCommand", "notify-test");
		const controller = new EventController(makeContext(makeAssistantMessage("stop")));
		controller.sendCompletionNotification();

		expect(terminalSpy).toHaveBeenCalledTimes(1);
		expect(spawnSpy).toHaveBeenCalledTimes(0);
	});
});
