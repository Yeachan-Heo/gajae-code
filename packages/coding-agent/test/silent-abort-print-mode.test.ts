/**
 * Regression: print-mode must not write SILENT_ABORT_MARKER to stderr.
 *
 * OpenAI code backend review flagged that `print-mode.ts` renders `errorMessage` verbatim
 * when stopReason is "aborted", which would surface the sentinel to stderr
 * (and exit with code 1). This test verifies the guard skips silent-abort.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, Message, ToolResultMessage } from "@gajae-code/ai";
import type { AgentSession } from "../src/session/agent-session";
import { SILENT_ABORT_MARKER } from "../src/session/messages";

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "draft" }],
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

/** Minimal mock of AgentSession for print-mode text output path */
function createMockSession(messages: Message[]): AgentSession {
	return {
		state: { messages },
		sessionManager: {
			getHeader: () => undefined,
		},
		extensionRunner: undefined,
		subscribe: () => () => {},
		prompt: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

describe("Print-mode silent-abort regression", () => {
	let exitSpy: ReturnType<typeof vi.spyOn>;
	let stderrOutput: string[];

	beforeEach(() => {
		stderrOutput = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			stderrOutput.push(String(chunk));
			return true;
		});
		exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			// Invoke callback if present (runPrintMode flushes stdout before returning)
			const last = args[args.length - 1];
			if (typeof last === "function") last();
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not write silent-abort marker to stderr or exit non-zero", async () => {
		const { runPrintMode } = await import("../src/modes/print-mode");

		const silentAbortMsg = makeAssistantMessage({
			stopReason: "aborted",
			errorMessage: SILENT_ABORT_MARKER,
			content: [],
		});

		const session = createMockSession([silentAbortMsg]);
		await runPrintMode(session, { mode: "text" });

		// The silent-abort marker MUST NOT appear in stderr
		const stderrText = stderrOutput.join("");
		expect(stderrText).not.toContain(SILENT_ABORT_MARKER);
		// process.exit MUST NOT have been called (clean termination)
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("writes real error messages to stderr and exits non-zero", async () => {
		const { runPrintMode } = await import("../src/modes/print-mode");

		const errorMsg = makeAssistantMessage({
			stopReason: "error",
			errorMessage: "Rate limit exceeded",
			content: [],
		});

		const session = createMockSession([errorMsg]);
		await runPrintMode(session, { mode: "text" });

		// A real error SHOULD be written to stderr
		const stderrText = stderrOutput.join("");
		expect(stderrText).toContain("Rate limit exceeded");
		// process.exit(1) SHOULD have been called
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});

function makeToolResultMessage(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "read",
		content: [{ type: "text", text: "file contents" }],
		isError: false,
		timestamp: Date.now(),
	} as ToolResultMessage;
}

describe("Print-mode last-assistant output regression (#484)", () => {
	let stdoutOutput: string[];

	beforeEach(() => {
		stdoutOutput = [];
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const chunk = args[0];
			if (typeof chunk === "string" && chunk.length > 0) stdoutOutput.push(chunk);
			const last = args[args.length - 1];
			if (typeof last === "function") last();
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("prints last assistant text even when a toolResult trails it", async () => {
		const { runPrintMode } = await import("../src/modes/print-mode");

		const assistantMsg = makeAssistantMessage({
			content: [{ type: "text", text: "@gajae-code/coding-agent" }],
		});
		// Cursor native tool execution can append a toolResult after the assistant reply.
		const session = createMockSession([assistantMsg, makeToolResultMessage()]);
		await runPrintMode(session, { mode: "text" });

		const stdoutText = stdoutOutput.join("");
		expect(stdoutText).toContain("@gajae-code/coding-agent");
	});
});
