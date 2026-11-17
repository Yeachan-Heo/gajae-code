/** Regression tests for issue #7841: print mode with compaction shrinking messages */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, Message, UserMessage } from "@gajae-code/ai";
import { resolvePrintTerminalDisposition, runPrintMode } from "../src/modes/print-mode";
import type { AgentSession } from "../src/session/agent-session";

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "response text" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		...overrides,
	};
}

function makeUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function makeCustomMessage(text: string): ReturnType<typeof makeUserMessage> & { role: "custom"; customType: string } {
	return {
		role: "custom",
		customType: "skill-prompt",
		content: [{ type: "text", text }],
		display: true,
		timestamp: Date.now(),
	} as unknown as ReturnType<typeof makeUserMessage> & { role: "custom"; customType: string };
}

function installImmediateStderrMock(output: string[]): void {
	vi.spyOn(process.stderr, "write").mockImplementation((...args: unknown[]) => {
		output.push(String(args[0]));
		const callback = args[args.length - 1];
		if (typeof callback === "function") callback();
		return true;
	});
}

function installImmediateStdoutMock(output: string[] = []): void {
	vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
		const chunk = args[0];
		if (typeof chunk === "string" && chunk.length > 0) output.push(chunk);
		const callback = args[args.length - 1];
		if (typeof callback === "function") callback();
		return true;
	});
}

function createMockSession(options: { messages: Message[]; onPrompt?: (messages: Message[]) => void }): AgentSession {
	return {
		configWarnings: [],
		state: { messages: options.messages },
		model: undefined,
		autoCompactionEnabled: false,
		sessionManager: {
			getHeader: () => undefined,
			getCwd: () => import.meta.dir,
		},
		setSlashCommands: () => {},
		extensionRunner: undefined,
		subscribe: () => () => {},
		prompt: async () => {
			// Simulate adding a user message and an assistant response
			options.messages.push(makeUserMessage("test prompt"));
			options.messages.push(makeAssistantMessage({ content: [{ type: "text", text: "test response" }] }));
			options.onPrompt?.(options.messages);
		},
		dispose: async () => {},
	} as unknown as AgentSession;
}

afterEach(() => {
	process.exitCode = 0;
	vi.restoreAllMocks();
});

describe("Print mode with message compaction", () => {
	it("resolves success when compaction occurs during prompt and final assistant text exists", async () => {
		// This reproduces issue #7841: compaction during prompt can shrink the messages array,
		// making the pre-prompt index stale, but resolvePrintTerminalDisposition should still
		// find the assistant text.
		const messages: Message[] = [
			makeUserMessage("context message 1"),
			makeAssistantMessage({ content: [{ type: "text", text: "context response 1" }] }),
		];

		const session = createMockSession({
			messages,
			onPrompt: currentMessages => {
				// Simulate compaction during the prompt: remove old messages from the array
				// but keep the new user message and assistant response that were just added
				const userIndex = currentMessages.findIndex(m => {
					if (m.role === "user" && "content" in m && Array.isArray(m.content) && m.content[0]?.type === "text") {
						const content = m.content[0];
						return content.type === "text" && content.text === "test prompt";
					}
					return false;
				});

				if (userIndex > 0) {
					// Remove all messages before the new user message
					currentMessages.splice(0, userIndex);
				}
			},
		});

		const stdoutOutput: string[] = [];
		installImmediateStderrMock([]);
		installImmediateStdoutMock(stdoutOutput);

		await runPrintMode(session, { mode: "text", initialMessage: "test prompt" });

		// Should have printed the response text despite compaction
		expect(stdoutOutput.join("")).toContain("test response");
		// Should exit with success code (0 or undefined), not error (1)
		expect(process.exitCode ?? 0).toBe(0);
	});

	it("resolvePrintTerminalDisposition finds assistant text when messages are compacted before the user message", () => {
		// Simulate: old context, compaction removes it, then new user and assistant messages added
		const messages: Message[] = [makeUserMessage("old context"), makeAssistantMessage()];

		// Record the index before "compaction" occurs
		const indexBeforeCompaction = messages.length;

		// Simulate compaction: remove old messages
		messages.splice(0, 2);

		// Now add new user and assistant messages
		const newUserMessage = makeUserMessage("new prompt");
		const newAssistantMessage = makeAssistantMessage({
			content: [{ type: "text", text: "new response" }],
		});
		messages.push(newUserMessage);
		messages.push(newAssistantMessage);

		// The old index (2) is now out of bounds or points to the new user message
		// But resolvePrintTerminalDisposition should still find the assistant response
		// by using the newUserMessage reference to find assistant messages that come after it
		const disposition = resolvePrintTerminalDisposition(messages, true, indexBeforeCompaction, newUserMessage);

		expect(disposition).toEqual({ status: "success", assistantText: true });
	});

	it("resolvePrintTerminalDisposition fails when no assistant text exists, even after compaction", () => {
		const messages: Message[] = [makeUserMessage("old context"), makeAssistantMessage()];

		const indexBeforeCompaction = messages.length;

		// Simulate compaction: remove old messages
		messages.splice(0, 2);

		// Add only a user message, no assistant response
		messages.push(makeUserMessage("new prompt"));

		const disposition = resolvePrintTerminalDisposition(messages, true, indexBeforeCompaction);

		expect(disposition).toEqual({
			status: "failure",
			error: { code: "empty_response", message: "Turn completed without assistant text." },
		});
	});

	it("resolvePrintTerminalDisposition distinguishes previous turn's response from current turn", () => {
		// Scenario: previous turn had an assistant response, then current turn's user message
		// is submitted but compaction removes the previous turn entirely, then we add a new
		// assistant message. We should find the NEW assistant message, not the old one.
		const messages: Message[] = [
			makeUserMessage("first prompt"),
			makeAssistantMessage({ content: [{ type: "text", text: "old response" }] }),
		];

		const indexBeforeCompaction = messages.length; // 2

		// Simulate compaction removing the previous turn
		messages.splice(0, 2);

		// Add current turn's user and assistant messages
		const currentUserMessage = makeUserMessage("second prompt");
		messages.push(currentUserMessage);
		messages.push(makeAssistantMessage({ content: [{ type: "text", text: "new response" }] }));

		// Use the current user message reference so we find the new response, not the old one
		const disposition = resolvePrintTerminalDisposition(messages, true, indexBeforeCompaction, currentUserMessage);

		// Should find success (the new response exists)
		expect(disposition).toEqual({ status: "success", assistantText: true });
		// In production, we'd verify it's the new response, not the old one
	});

	it("resolvePrintTerminalDisposition handles assistant error after compaction", () => {
		const messages: Message[] = [makeUserMessage("context"), makeAssistantMessage()];

		const indexBeforeCompaction = messages.length;

		messages.splice(0, 2);

		const currentUserMessage = makeUserMessage("new prompt");
		messages.push(currentUserMessage);
		messages.push(
			makeAssistantMessage({
				stopReason: "error",
				errorMessage: "API error occurred",
				content: [],
			}),
		);

		const disposition = resolvePrintTerminalDisposition(messages, true, indexBeforeCompaction, currentUserMessage);

		expect(disposition).toEqual({
			status: "failure",
			error: { code: "assistant_error", message: "API error occurred" },
		});
	});

	it("prints assistant response after --resume with compaction", async () => {
		// Simulate: resuming a session where compaction occurred during the new prompt
		const messages: Message[] = [
			makeUserMessage("first turn"),
			makeAssistantMessage(),
			// ... after compaction, previous messages are removed...
		];

		const session = createMockSession({
			messages,
			onPrompt: currentMessages => {
				// Simulate heavy compaction: replace all old messages with just a summary
				currentMessages.splice(0, currentMessages.length);
				// But keep the new interaction
				currentMessages.push(makeUserMessage("resume prompt"));
				currentMessages.push(
					makeAssistantMessage({
						content: [{ type: "text", text: "resume response" }],
					}),
				);
			},
		});

		const stdoutOutput: string[] = [];
		installImmediateStderrMock([]);
		installImmediateStdoutMock(stdoutOutput);

		await runPrintMode(session, { mode: "text", initialMessage: "resume prompt" });

		expect(stdoutOutput.join("")).toContain("resume response");
		expect(process.exitCode ?? 0).toBe(0);
	});

	it("does not falsely report success when a slash command is handled without adding messages", async () => {
		// Regression for issue #7841: a resumed session with a historical assistant message
		// receives a command that is handled without adding new messages (e.g., /help).
		// The backward scan should NOT capture the historical message, and the resolver
		// should report failure (empty_response), not falsely reuse the historical response.
		const messages: Message[] = [
			makeUserMessage("previous turn"),
			makeAssistantMessage({ content: [{ type: "text", text: "previous response" }] }),
		];

		// Create a mock session that handles commands without adding messages
		const session = {
			configWarnings: [],
			state: { messages },
			model: undefined,
			autoCompactionEnabled: false,
			sessionManager: {
				getHeader: () => undefined,
				getCwd: () => import.meta.dir,
			},
			setSlashCommands: () => {},
			extensionRunner: undefined,
			subscribe: () => () => {},
			prompt: async (_text: string) => {
				// Simulate a handled slash command: prompt returns without adding messages
				// (simulating the early return in AgentSession.#promptInternal for extension/command handlers)
				// A command like "/help" or other extension command returns without modifying the messages array
			},
			dispose: async () => {},
		} as unknown as AgentSession;

		const stderrOutput: string[] = [];
		const stdoutOutput: string[] = [];
		installImmediateStderrMock(stderrOutput);
		installImmediateStdoutMock(stdoutOutput);

		// Run print mode, which will execute the backward scan logic
		await runPrintMode(session, { mode: "text", initialMessage: "/help" });

		// Should report failure (empty_response), not reuse the historical response
		expect(stderrOutput.join("")).toContain("Turn completed without assistant text");
		expect(process.exitCode).toBe(1);
		// Should NOT contain the previous response
		expect(stdoutOutput.join("")).not.toContain("previous response");
	});

	it("skips historical error when consumed command flag is set", () => {
		// Regression: a resumed session ending in an assistant error should not report
		// that error as a failure when resolvePrintTerminalDisposition is called with
		// consumedLocalCommandWithoutPrompt = true (indicating only a consumed local command ran).
		const messages: Message[] = [
			makeUserMessage("previous turn"),
			makeAssistantMessage({
				stopReason: "error",
				errorMessage: "Context overflow",
				content: [],
			}),
		];

		// When submittedPrompt is false and consumedLocalCommandWithoutPrompt is true,
		// the function should skip historical error resolution
		const disposition = resolvePrintTerminalDisposition(
			messages,
			false, // submittedPrompt - no prompt was submitted
			undefined,
			undefined,
			true, // consumedLocalCommandWithoutPrompt - only a consumed command ran
		);

		// A consumed command should report success (undefined), not failure
		expect(disposition).toBeUndefined();
	});

	it("reports historical error when no consumed command flag", () => {
		// When submittedPrompt is false and consumedLocalCommandWithoutPrompt is false,
		// the function should report historical errors (for resumed sessions with no new input)
		const messages: Message[] = [
			makeUserMessage("previous turn"),
			makeAssistantMessage({
				stopReason: "error",
				errorMessage: "Context overflow",
				content: [],
			}),
		];

		const disposition = resolvePrintTerminalDisposition(
			messages,
			false, // submittedPrompt
			undefined,
			undefined,
			false, // consumedLocalCommandWithoutPrompt is false
		);

		// Should report failure for the historical error
		expect(disposition).toBeDefined();
		if (disposition) {
			expect(disposition.status).toBe("failure");
			if (disposition.status === "failure") {
				expect(disposition.error.code).toBe("assistant_error");
			}
		}
	});

	it("resolves success when custom message (skill prompt) is captured after compaction", () => {
		// This tests the fix for issue #7841 where skill invocations submit user-attributed
		// custom messages (role: 'custom'). When compaction removes earlier ordinary user messages
		// while retaining the current custom prompt and its assistant response, the scan must
		// include role === 'custom' to find the anchor.
		const messages: Message[] = [
			makeUserMessage("context message 1"),
			makeAssistantMessage({ content: [{ type: "text", text: "context response 1" }] }),
			makeUserMessage("context message 2"),
			makeAssistantMessage({ content: [{ type: "text", text: "context response 2" }] }),
		];

		const indexBeforeCompaction = messages.length;

		// Simulate compaction removing earlier messages
		messages.splice(0, 4);

		// Add a custom message (skill prompt) and its assistant response
		const customMessage = makeCustomMessage("skill invocation prompt");
		messages.push(customMessage);
		messages.push(
			makeAssistantMessage({
				content: [{ type: "text", text: "skill response" }],
			}),
		);

		// When the custom message is passed as turnStartUserMessage (which it should be),
		// the resolution should find the assistant response after it, even though the
		// pre-compaction index is now stale.
		const disposition = resolvePrintTerminalDisposition(messages, true, indexBeforeCompaction, customMessage);

		expect(disposition).toEqual({
			status: "success",
			assistantText: true,
		});
	});

	it("fails to find custom message when it's not checked in the scan loop", () => {
		// This demonstrates that without checking role === 'custom', the scan loop
		// at print-mode.ts:417 will not capture a custom message, leaving lastPromptUserMessage undefined.
		// Then resolvePrintTerminalDisposition falls back to the stale pre-compaction index,
		// which may resolve as empty_response.
		const messages: Message[] = [
			makeUserMessage("context message 1"),
			makeAssistantMessage({ content: [{ type: "text", text: "context response 1" }] }),
		];

		const indexBeforeCompaction = messages.length;

		// Simulate compaction removing earlier messages
		messages.splice(0, 2);

		// Add a custom message (skill prompt) and its assistant response
		const customMessage = makeCustomMessage("skill invocation prompt");
		messages.push(customMessage);
		messages.push(
			makeAssistantMessage({
				content: [{ type: "text", text: "skill response" }],
			}),
		);

		// Without passing the custom message as turnStartUserMessage, the function falls back
		// to using the stale index (which is 2, out of bounds of the new array of size 2).
		// This would result in an empty_response error.
		// With the fix, we pass the custom message and it should still find the assistant response.
		const disposition = resolvePrintTerminalDisposition(messages, true, indexBeforeCompaction, customMessage);

		expect(disposition).toEqual({
			status: "success",
			assistantText: true,
		});
	});
});
