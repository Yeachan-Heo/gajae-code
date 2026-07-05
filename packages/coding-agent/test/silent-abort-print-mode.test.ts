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
function createMockSession(
	messages: Message[],
	opts?: { contextWindow?: number; autoCompactionEnabled?: boolean },
): AgentSession {
	return {
		state: { messages },
		model: opts?.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : undefined,
		autoCompactionEnabled: opts?.autoCompactionEnabled ?? false,
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

/**
 * Contract: in TEXT mode only, a terminal context-overflow assistant message is
 * surfaced with an actionable diagnostic and a distinct exit code
 * (CONTEXT_OVERFLOW_EXIT_CODE) so `gjc -p` callers can detect context exhaustion.
 * JSON mode is intentionally out of scope (it streams events and never runs this
 * terminal branch) — the last test documents that boundary.
 */
describe("Print-mode context-overflow terminal handling (text mode)", () => {
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
			const last = args[args.length - 1];
			if (typeof last === "function") last();
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("emits an actionable diagnostic and a distinct exit code on context overflow", async () => {
		const { runPrintMode, CONTEXT_OVERFLOW_EXIT_CODE } = await import("../src/modes/print-mode");

		// The exact string a Codex/OpenAI-code backend surfaces on context_length_exceeded.
		const overflowMsg = makeAssistantMessage({
			stopReason: "error",
			errorMessage:
				"Codex error event: Your input exceeds the context window of this model. Please adjust your input and try again. (code=context_length_exceeded)",
			content: [],
		});

		const session = createMockSession([overflowMsg], { contextWindow: 272000, autoCompactionEnabled: true });
		await runPrintMode(session, { mode: "text" });

		const stderrText = stderrOutput.join("");
		// Actionable guidance replaces the opaque provider crash line.
		expect(stderrText).toContain("Context window exhausted");
		expect(stderrText).toContain("larger-context model");
		// Raw provider detail is preserved for debugging.
		expect(stderrText).toContain("context_length_exceeded");
		// Distinct exit code so text-mode automation can detect context exhaustion.
		expect(exitSpy).toHaveBeenCalledWith(CONTEXT_OVERFLOW_EXIT_CODE);
		expect(exitSpy).not.toHaveBeenCalledWith(1);
	});

	it("tells the operator to enable auto-compaction when it is disabled", async () => {
		const { runPrintMode } = await import("../src/modes/print-mode");

		const overflowMsg = makeAssistantMessage({
			stopReason: "error",
			errorMessage: "prompt is too long: 300000 tokens > 272000 maximum",
			content: [],
		});

		const session = createMockSession([overflowMsg], { contextWindow: 272000, autoCompactionEnabled: false });
		await runPrintMode(session, { mode: "text" });

		const stderrText = stderrOutput.join("");
		expect(stderrText).toContain("automatic compaction is disabled");
	});

	it("still exits 1 with the raw message for non-overflow errors", async () => {
		const { runPrintMode, CONTEXT_OVERFLOW_EXIT_CODE } = await import("../src/modes/print-mode");

		const errorMsg = makeAssistantMessage({
			stopReason: "error",
			errorMessage: "Internal server error (status=500)",
			content: [],
		});

		const session = createMockSession([errorMsg], { contextWindow: 272000, autoCompactionEnabled: true });
		await runPrintMode(session, { mode: "text" });

		const stderrText = stderrOutput.join("");
		expect(stderrText).toContain("Internal server error");
		expect(stderrText).not.toContain("Context window exhausted");
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(exitSpy).not.toHaveBeenCalledWith(CONTEXT_OVERFLOW_EXIT_CODE);
	});

	it("scope boundary: JSON mode does not apply the context-overflow exit code", async () => {
		const { runPrintMode, CONTEXT_OVERFLOW_EXIT_CODE } = await import("../src/modes/print-mode");

		// Same terminal overflow message, but JSON mode streams events and never runs
		// the text-mode terminal-error branch, so the exit code is intentionally not applied.
		const overflowMsg = makeAssistantMessage({
			stopReason: "error",
			errorMessage:
				"Codex error event: Your input exceeds the context window of this model. (code=context_length_exceeded)",
			content: [],
		});

		const session = createMockSession([overflowMsg], { contextWindow: 272000, autoCompactionEnabled: true });
		await runPrintMode(session, { mode: "json" });

		const stderrText = stderrOutput.join("");
		expect(stderrText).not.toContain("Context window exhausted");
		expect(exitSpy).not.toHaveBeenCalledWith(CONTEXT_OVERFLOW_EXIT_CODE);
	});
});
