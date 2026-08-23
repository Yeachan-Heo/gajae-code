/** Print-mode output, terminal-status, and stdout-ownership regressions. */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, Message, ToolResultMessage } from "@gajae-code/ai";
import { CONTEXT_OVERFLOW_EXIT_CODE, runPrintMode } from "../src/modes/print-mode";
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

function invokeWriteCallback(args: unknown[], error?: Error): void {
	const callback = args[args.length - 1];
	if (typeof callback === "function") callback(error);
}

function installImmediateStderrMock(output: string[]): void {
	vi.spyOn(process.stderr, "write").mockImplementation((...args: unknown[]) => {
		output.push(String(args[0]));
		invokeWriteCallback(args);
		return true;
	});
}

function installImmediateStdoutMock(output: string[] = []): void {
	vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
		const chunk = args[0];
		if (typeof chunk === "string" && chunk.length > 0) output.push(chunk);
		invokeWriteCallback(args);
		return true;
	});
}

/** Minimal mock of the AgentSession text-output path. */
function createMockSession(
	messages: Message[],
	opts?: {
		contextWindow?: number;
		autoCompactionEnabled?: boolean;
		configWarnings?: string[];
		promptResult?: Message;
	},
): AgentSession {
	return {
		configWarnings: opts?.configWarnings ?? [],
		state: { messages },
		model: opts?.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : undefined,
		autoCompactionEnabled: opts?.autoCompactionEnabled ?? false,
		sessionManager: {
			getHeader: () => undefined,
			getCwd: () => import.meta.dir,
		},
		getSessionAgentDir: () => "",
		setSlashCommands: () => {},
		extensionRunner: undefined,
		subscribe: () => () => {},
		prompt: async () => {
			messages.push({ role: "user", content: [{ type: "text", text: "prompt" }], timestamp: Date.now() });
			if (opts?.promptResult) messages.push(opts.promptResult);
		},
		dispose: async () => {},
	} as unknown as AgentSession;
}

function eventName(event: unknown): string {
	if (typeof event === "object" && event !== null && "type" in event) return String(event.type);
	return String(event);
}

function createPrintModeTrackingSession(
	options: {
		messages?: Message[];
		header?: unknown;
		events?: unknown[];
		disposeEvents?: unknown[];
		disposeError?: unknown;
		onDispose?: () => void;
	} = {},
) {
	const {
		messages = [makeAssistantMessage()],
		header,
		events = [],
		disposeEvents = [],
		disposeError,
		onDispose,
	} = options;
	const lifecycle: string[] = [];
	let onEvent: ((event: unknown) => void) | undefined;
	let unsubscribeCount = 0;
	const emit = (event: unknown): void => {
		lifecycle.push(`emit:${eventName(event)}`);
		onEvent?.(event);
	};
	const dispose = vi.fn(async () => {
		lifecycle.push("dispose:start");
		for (const event of disposeEvents) emit(event);
		onDispose?.();
		lifecycle.push("dispose:end");
		if (disposeError !== undefined) throw disposeError;
	});
	const prompt = vi.fn(async () => {
		lifecycle.push("prompt:start");
		for (const event of events) emit(event);
		messages.push(makeAssistantMessage());
		lifecycle.push("prompt:end");
	});
	// Print mode hands the loaded slash commands to the session before it prompts, so the
	// fake models both seams. Ordering is pinned in its own test rather than in `lifecycle`,
	// which the disposal/EPIPE cases assert byte-for-byte.
	const setSlashCommands = vi.fn();
	const session = {
		configWarnings: [],
		state: { messages },
		sessionManager: { getHeader: () => header, getCwd: () => import.meta.dir },
		getSessionAgentDir: () => "",
		extensionRunner: undefined,
		setSlashCommands,
		subscribe: (listener: (event: unknown) => void) => {
			lifecycle.push("subscribe");
			onEvent = listener;
			return () => {
				lifecycle.push("unsubscribe");
				onEvent = undefined;
				unsubscribeCount += 1;
			};
		},
		prompt,
		dispose,
	} as unknown as AgentSession;

	return {
		session,
		dispose,
		prompt,
		setSlashCommands,
		lifecycle,
		unsubscribeCount: () => unsubscribeCount,
	};
}

function stdoutError(code: string): Error & { code: string } {
	return Object.assign(new Error(`stdout ${code}`), { code });
}

afterEach(() => {
	process.exitCode = 0;
});

describe("Print mode", () => {
	beforeEach(() => {
		process.exitCode = 0;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = 0;
	});

	it("prints each session configuration warning to stderr once", async () => {
		const stderrOutput: string[] = [];
		installImmediateStderrMock(stderrOutput);
		installImmediateStdoutMock();
		const warning = "[AGENTS.md] Skipped one or more oversized files.";

		await runPrintMode(createMockSession([], { configWarnings: [warning, warning] }), { mode: "text" });

		expect(stderrOutput).toEqual([`Warning: ${warning}\n`]);
	});
	it("dispatches trusted local headless commands without prompting and keeps JSON output valid", async () => {
		const stdoutOutput: string[] = [];
		installImmediateStdoutMock(stdoutOutput);
		const tracking = createPrintModeTrackingSession();

		await runPrintMode(tracking.session, {
			mode: "json",
			initialMessage: "/import-session unsupported",
		});

		expect(tracking.prompt).not.toHaveBeenCalled();
		const rows = stdoutOutput
			.join("")
			.trim()
			.split("\n")
			.map(row => JSON.parse(row));
		expect(rows).toContainEqual({
			type: "local_command_output",
			command: "/import-session",
			output: "Import failed: source_not_found [read] — Transcript file does not exist: unsupported",
		});
	});
	it("does not render a silent-abort marker or overwrite a caller status", async () => {
		const stderrOutput: string[] = [];
		installImmediateStderrMock(stderrOutput);
		installImmediateStdoutMock();
		process.exitCode = 19;

		const silentAbortMsg = makeAssistantMessage({
			stopReason: "aborted",
			errorMessage: SILENT_ABORT_MARKER,
			content: [],
		});

		await runPrintMode(createMockSession([silentAbortMsg]), { mode: "text" });

		expect(stderrOutput.join("")).not.toContain(SILENT_ABORT_MARKER);
		expect(process.exitCode).toBe(19);
	});

	it("sets ordinary terminal errors to status 1 without calling process.exit", async () => {
		const stderrOutput: string[] = [];
		installImmediateStderrMock(stderrOutput);
		installImmediateStdoutMock();
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

		await runPrintMode(
			createMockSession([
				makeAssistantMessage({ stopReason: "error", errorMessage: "Rate limit exceeded", content: [] }),
			]),
			{ mode: "text" },
		);

		expect(stderrOutput.join("")).toContain("Rate limit exceeded");
		expect(process.exitCode).toBe(1);
		expect(exitSpy).not.toHaveBeenCalled();
	});
	it("fails text mode when a submitted turn has no assistant text", async () => {
		const stderrOutput: string[] = [];
		installImmediateStderrMock(stderrOutput);
		installImmediateStdoutMock();

		await runPrintMode(createMockSession([makeToolResultMessage()]), {
			mode: "text",
			initialMessage: "run the tool",
		});

		expect(stderrOutput.join("\n")).toContain("Turn completed without assistant text.");
		expect(process.exitCode).toBe(1);
	});
	it("emits a structured empty-response failure and exits nonzero in JSON mode", async () => {
		const stdoutOutput: string[] = [];
		installImmediateStderrMock([]);
		installImmediateStdoutMock(stdoutOutput);

		await runPrintMode(createMockSession([makeToolResultMessage()]), {
			mode: "json",
			initialMessage: "run the tool",
		});

		const rows = stdoutOutput
			.join("")
			.trim()
			.split("\n")
			.map(row => JSON.parse(row));
		expect(rows).toContainEqual({
			type: "agent_failed",
			error: { code: "empty_response", message: "Turn completed without assistant text." },
		});
		expect(process.exitCode).toBe(1);
	});
	it("preserves provider failure as a nonzero JSON terminal status", async () => {
		const stdoutOutput: string[] = [];
		installImmediateStderrMock([]);
		installImmediateStdoutMock(stdoutOutput);
		const failure = makeAssistantMessage({ stopReason: "error", errorMessage: "provider unavailable", content: [] });

		await runPrintMode(createMockSession([], { promptResult: failure }), { mode: "json", initialMessage: "answer" });

		expect(stdoutOutput.join("")).toContain("provider unavailable");
		expect(process.exitCode).toBe(1);
	});
	it("fails trailing tool-only output instead of treating tool activity as success", async () => {
		installImmediateStderrMock([]);
		installImmediateStdoutMock();

		await runPrintMode(createMockSession([makeToolResultMessage()]), {
			mode: "text",
			initialMessage: "finish this request",
		});

		expect(process.exitCode).toBe(1);
	});
	it("prints the safety-stop hint after the raw refusal for provider safety stops (#4650)", async () => {
		const stderrOutput: string[] = [];
		installImmediateStderrMock(stderrOutput);
		installImmediateStdoutMock();

		await runPrintMode(
			createMockSession([
				makeAssistantMessage({
					stopReason: "error",
					errorKind: "provider_safety_stop",
					errorMessage: "Refusal (no details provided)",
					content: [],
				}),
			]),
			{ mode: "text" },
		);

		const stderr = stderrOutput.join("");
		expect(stderr).toContain("Refusal (no details provided)");
		expect(stderr.indexOf("Refusal (no details provided)")).toBeLessThan(stderr.indexOf("Provider safety stop"));
		expect(stderr).toContain("manual model switch");
		expect(process.exitCode).toBe(1);
	});

	it("prints no safety-stop hint for unrelated terminal errors", async () => {
		const stderrOutput: string[] = [];
		installImmediateStderrMock(stderrOutput);
		installImmediateStdoutMock();

		await runPrintMode(
			createMockSession([
				makeAssistantMessage({
					stopReason: "error",
					errorKind: undefined,
					errorMessage: "429 rate limit exceeded",
					content: [],
				}),
			]),
			{ mode: "text" },
		);

		const stderr = stderrOutput.join("");
		expect(stderr).toContain("429 rate limit exceeded");
		expect(stderr).not.toContain("Provider safety stop");
	});

	it("leaves terminal status unchanged when the caller suppresses print-mode status handling", async () => {
		const stderrOutput: string[] = [];
		installImmediateStderrMock(stderrOutput);
		installImmediateStdoutMock();
		process.exitCode = 23;

		await runPrintMode(
			createMockSession([
				makeAssistantMessage({ stopReason: "error", errorMessage: "delegated failure", content: [] }),
			]),
			{ mode: "text", suppressProcessExit: true },
		);

		expect(stderrOutput.join("")).toContain("delegated failure");
		expect(process.exitCode).toBe(23);
	});

	it("prints the last assistant text after a trailing tool result without changing an existing success-path status", async () => {
		const stdoutOutput: string[] = [];
		installImmediateStderrMock([]);
		installImmediateStdoutMock(stdoutOutput);
		process.exitCode = 0;

		const assistantMsg = makeAssistantMessage({ content: [{ type: "text", text: "@gajae-code/coding-agent" }] });
		await runPrintMode(createMockSession([assistantMsg, makeToolResultMessage()]), { mode: "text" });

		expect(stdoutOutput.join("")).toContain("@gajae-code/coding-agent");
		expect(process.exitCode).toBe(0);
	});

	it("sets context overflow to status 78 after an immediate stderr write without calling process.exit", async () => {
		const stderrOutput: string[] = [];
		installImmediateStderrMock(stderrOutput);
		installImmediateStdoutMock();
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		const overflow = makeAssistantMessage({
			stopReason: "error",
			errorMessage:
				"Codex error event: Your input exceeds the context window of this model. Please adjust your input and try again. (code=context_length_exceeded)",
			content: [],
		});

		await runPrintMode(createMockSession([overflow], { contextWindow: 272000, autoCompactionEnabled: true }), {
			mode: "text",
		});

		expect(CONTEXT_OVERFLOW_EXIT_CODE).toBe(78);
		expect(stderrOutput.join("")).toContain("Context window exhausted");
		expect(stderrOutput.join("")).toContain("context_length_exceeded");
		expect(process.exitCode).toBe(78);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("waits for a backpressured stderr write before disposal while retaining status 1", async () => {
		const stderrOutput: string[] = [];
		let stderrQuiesced = false;
		let stderrQuiescedWhenDisposed: boolean | undefined;
		vi.spyOn(process.stderr, "write").mockImplementation((...args: unknown[]) => {
			stderrOutput.push(String(args[0]));
			queueMicrotask(() => {
				stderrQuiesced = true;
				invokeWriteCallback(args);
			});
			return false;
		});
		installImmediateStdoutMock();
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		const tracking = createPrintModeTrackingSession({
			messages: [makeAssistantMessage({ stopReason: "error", errorMessage: "temporary failure", content: [] })],
			onDispose: () => {
				stderrQuiescedWhenDisposed = stderrQuiesced;
			},
		});

		await runPrintMode(tracking.session, { mode: "text" });

		expect(stderrOutput.join("")).toContain("temporary failure");
		expect(stderrQuiescedWhenDisposed).toBe(true);
		expect(process.exitCode).toBe(1);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("keeps context-overflow terminal handling out of JSON mode", async () => {
		const stderrOutput: string[] = [];
		installImmediateStderrMock(stderrOutput);
		installImmediateStdoutMock();
		const overflow = makeAssistantMessage({
			stopReason: "error",
			errorMessage:
				"Codex error event: Your input exceeds the context window of this model. (code=context_length_exceeded)",
			content: [],
		});

		await runPrintMode(createMockSession([overflow], { contextWindow: 272000, autoCompactionEnabled: true }), {
			mode: "json",
		});

		expect(stderrOutput.join("")).not.toContain("Context window exhausted");
		expect(process.exitCode).not.toBe(CONTEXT_OVERFLOW_EXIT_CODE);
	});

	it("does not install a text-mode session listener", async () => {
		installImmediateStderrMock([]);
		installImmediateStdoutMock();
		const tracking = createPrintModeTrackingSession({
			messages: [makeAssistantMessage({ content: [{ type: "text", text: "text only" }] })],
		});

		await runPrintMode(tracking.session, { mode: "text" });

		expect(tracking.lifecycle).toEqual(["dispose:start", "dispose:end"]);
		expect(tracking.unsubscribeCount()).toBe(0);
	});

	it("continues JSON event processing after a callback EPIPE and disposes before unsubscribing", async () => {
		installImmediateStderrMock([]);
		const tracking = createPrintModeTrackingSession({
			header: { type: "session", id: "header" },
			events: [
				{ type: "message_update", id: "first" },
				{ type: "message_update", id: "second" },
			],
		});
		const output: string[] = [];
		let writeCount = 0;
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			writeCount += 1;
			output.push(String(args[0]));
			invokeWriteCallback(args, writeCount === 2 ? stdoutError("EPIPE") : undefined);
			return true;
		});

		await runPrintMode(tracking.session, { mode: "json", initialMessage: "continue" });

		expect(tracking.prompt).toHaveBeenCalledTimes(1);
		expect(tracking.lifecycle).toEqual([
			"subscribe",
			"prompt:start",
			"emit:message_update",
			"emit:message_update",
			"prompt:end",
			"dispose:start",
			"dispose:end",
			"unsubscribe",
		]);
		expect(writeSpy).toHaveBeenCalledTimes(2);
		expect(output).toEqual(['{"type":"session","id":"header"}\n', '{"type":"message_update","id":"first"}\n']);
		expect(tracking.dispose).toHaveBeenCalledTimes(1);
	});

	it("continues JSON event processing after an owned stdout EPIPE event", async () => {
		installImmediateStderrMock([]);
		const tracking = createPrintModeTrackingSession({
			header: { type: "session", id: "header" },
			events: [
				{ type: "message_update", id: "first" },
				{ type: "message_update", id: "second" },
			],
		});
		let writeCount = 0;
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			writeCount += 1;
			if (writeCount === 2) process.stdout.emit("error", stdoutError("EPIPE"));
			else invokeWriteCallback(args);
			return true;
		});

		await runPrintMode(tracking.session, { mode: "json", initialMessage: "continue" });

		expect(tracking.prompt).toHaveBeenCalledTimes(1);
		expect(tracking.lifecycle.filter(entry => entry === "emit:message_update")).toHaveLength(2);
		expect(writeSpy).toHaveBeenCalledTimes(2);
		expect(tracking.dispose).toHaveBeenCalledTimes(1);
	});

	it("propagates a non-pipe stdout callback failure after session disposal", async () => {
		installImmediateStderrMock([]);
		const failure = new Error("stdout callback failed");
		const tracking = createPrintModeTrackingSession({
			messages: [makeAssistantMessage({ content: [{ type: "text", text: "draft" }] })],
		});
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			invokeWriteCallback(args, failure);
			return true;
		});

		await expect(runPrintMode(tracking.session, { mode: "text" })).rejects.toBe(failure);

		expect(tracking.dispose).toHaveBeenCalledTimes(1);
	});

	it("propagates a non-pipe stdout EventEmitter failure after session disposal", async () => {
		installImmediateStderrMock([]);
		const failure = new Error("stdout event failed");
		const tracking = createPrintModeTrackingSession({
			messages: [makeAssistantMessage({ content: [{ type: "text", text: "draft" }] })],
		});
		vi.spyOn(process.stdout, "write").mockImplementation(() => {
			process.stdout.emit("error", failure);
			return true;
		});

		await expect(runPrintMode(tracking.session, { mode: "text" })).rejects.toBe(failure);

		expect(tracking.dispose).toHaveBeenCalledTimes(1);
	});

	it("keeps the JSON subscriber through disposal-time output and late stdout errors", async () => {
		installImmediateStderrMock([]);
		const tracking = createPrintModeTrackingSession({
			disposeEvents: [{ type: "session_disposed", id: "final" }],
		});
		const output: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const chunk = String(args[0]);
			output.push(chunk);
			if (chunk.includes("session_disposed")) process.stdout.emit("error", stdoutError("EPIPE"));
			else invokeWriteCallback(args);
			return true;
		});

		await runPrintMode(tracking.session, { mode: "json" });

		expect(output).toContain('{"type":"session_disposed","id":"final"}\n');
		expect(tracking.lifecycle).toEqual([
			"subscribe",
			"dispose:start",
			"emit:session_disposed",
			"dispose:end",
			"unsubscribe",
		]);
		expect(tracking.dispose).toHaveBeenCalledTimes(1);
	});

	it("does not suppress ERR_STREAM_DESTROYED before an EPIPE has latched", async () => {
		installImmediateStderrMock([]);
		const destroyed = stdoutError("ERR_STREAM_DESTROYED");
		const tracking = createPrintModeTrackingSession({
			messages: [makeAssistantMessage({ content: [{ type: "text", text: "draft" }] })],
		});
		vi.spyOn(process.stdout, "write").mockImplementation(() => {
			throw destroyed;
		});

		await expect(runPrintMode(tracking.session, { mode: "text" })).rejects.toBe(destroyed);

		expect(tracking.dispose).toHaveBeenCalledTimes(1);
	});

	it("suppresses a destroyed-stream error only after an owned EPIPE latches", async () => {
		installImmediateStderrMock([]);
		const tracking = createPrintModeTrackingSession({
			messages: [makeAssistantMessage({ content: [{ type: "text", text: "draft" }] })],
			onDispose: () => {
				process.stdout.emit("error", stdoutError("ERR_STREAM_DESTROYED"));
			},
		});
		vi.spyOn(process.stdout, "write").mockImplementation(() => {
			throw stdoutError("EPIPE");
		});

		await runPrintMode(tracking.session, { mode: "text" });

		expect(tracking.dispose).toHaveBeenCalledTimes(1);
	});

	it("preserves both a stdout failure and a disposal failure", async () => {
		installImmediateStderrMock([]);
		const writeFailure = new Error("stdout write failed");
		const disposeFailure = new Error("dispose failed");
		const tracking = createPrintModeTrackingSession({
			messages: [makeAssistantMessage({ content: [{ type: "text", text: "draft" }] })],
			disposeError: disposeFailure,
		});
		vi.spyOn(process.stdout, "write").mockImplementation(() => {
			throw writeFailure;
		});

		let caught: unknown;
		try {
			await runPrintMode(tracking.session, { mode: "text" });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(AggregateError);
		expect((caught as AggregateError).errors).toEqual([writeFailure, disposeFailure]);
		expect(tracking.dispose).toHaveBeenCalledTimes(1);
	});

	it("removes only the stdout listener it owns", async () => {
		installImmediateStderrMock([]);
		const externalListener = () => {};
		process.stdout.on("error", externalListener);
		const listenerCount = process.stdout.listenerCount("error");
		installImmediateStdoutMock();

		try {
			await runPrintMode(createPrintModeTrackingSession().session, { mode: "text" });
			expect(process.stdout.listenerCount("error")).toBe(listenerCount);
			expect(process.stdout.listeners("error")).toContain(externalListener);
		} finally {
			process.stdout.removeListener("error", externalListener);
		}
	});
});

describe("Print mode slash-command expansion", () => {
	it("hands bundled slash commands to the session before the first prompt", async () => {
		const tracking = createPrintModeTrackingSession({ messages: [makeAssistantMessage()] });
		installImmediateStdoutMock();

		const order: string[] = [];
		tracking.setSlashCommands.mockImplementation((commands: unknown) => {
			order.push("setSlashCommands");
			const names = (commands as Array<{ name: string }>).map(cmd => cmd.name);
			// `/init` is embedded in the binary, so it is present regardless of cwd. Without the
			// handover the session keeps an empty list and `/init` reaches the model as prose.
			expect(names).toContain("init");
		});
		tracking.prompt.mockImplementation(async () => {
			order.push("prompt");
		});

		await runPrintMode(tracking.session, { mode: "text", initialMessage: "/init" });

		expect(tracking.setSlashCommands).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["setSlashCommands", "prompt"]);
	});
});
