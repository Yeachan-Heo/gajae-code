/**
 * Regression coverage for issue #3639: a `!cmd` submitted while the agent is
 * streaming must render its header/output/exit status continuously and land in
 * the chat transcript on completion, exactly like the idle path.
 */
import { beforeAll, describe, expect, it, vi } from "bun:test";
import { BashExecutionComponent } from "@gajae-code/coding-agent/modes/components/bash-execution";
import type { EvalExecutionComponent } from "@gajae-code/coding-agent/modes/components/eval-execution";
import { CommandController } from "@gajae-code/coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@gajae-code/coding-agent/session/session-manager";
import { Container, type TUI } from "@gajae-code/tui";

beforeAll(async () => {
	const theme = await getThemeByName("red-claw");
	expect(theme).toBeDefined();
	setThemeInstance(theme!);
});

interface ExecutionResult {
	exitCode: number | undefined;
	cancelled: boolean;
	output: string;
	truncated: boolean;
}

function emptySessionContext(): SessionContext {
	return {
		messages: [],
		thinkingLevel: "off",
		serviceTier: undefined,
		models: {},
		configuredModelChains: {},
		injectedTtsrRules: [],
		selectedMCPToolNames: [],
		hasPersistedMCPToolSelection: false,
		mode: "none",
	};
}

interface Harness {
	ctx: InteractiveModeContext;
	chatContainer: Container;
	pendingMessagesContainer: Container;
	bashGate: PromiseWithResolvers<ExecutionResult>;
	evalGate: PromiseWithResolvers<ExecutionResult>;
	emitBashChunk(chunk: string): void;
	emitEvalChunk(chunk: string): void;
	queuedFollowUps: string[];
	rebuiltTranscriptRows: string[];
}

/**
 * Interactive-mode context stub wired with the containers/arrays the deferred
 * execution paths actually touch. Both executions are gated so the test can
 * observe the in-flight window.
 */
function createHarness(options: { isStreaming: boolean }): Harness {
	const chatContainer = new Container();
	const pendingMessagesContainer = new Container();
	const ui = {
		requestRender: () => {},
		resetViewportAnchorIntent: () => {},
		prepareViewportAnchorForTranscriptRebuild: () => {},
	} as unknown as TUI;
	const bashGate = Promise.withResolvers<ExecutionResult>();
	const evalGate = Promise.withResolvers<ExecutionResult>();
	const queuedFollowUps: string[] = [];
	const rebuiltTranscriptRows: string[] = [];
	let bashChunkSink: ((chunk: string) => void) | undefined;
	let evalChunkSink: ((chunk: string) => void) | undefined;

	const ctx = {
		session: {
			isStreaming: options.isStreaming,
			executeBash: (_command: string, onChunk: (chunk: string) => void) => {
				bashChunkSink = onChunk;
				return bashGate.promise;
			},
			executePython: (_code: string, onChunk: (chunk: string) => void) => {
				evalChunkSink = onChunk;
				return evalGate.promise;
			},
			getQueuedMessages: () => ({ steering: [], followUp: queuedFollowUps }),
			isCompacting: false,
			newSession: async () => true,
			clearContext: async () => true,
		},
		sessionManager: {
			buildSessionContext: () => emptySessionContext(),
			getEntries: () => [],
			getCwd: () => "/tmp",
			getSessionName: () => "harness session",
		},
		renderSessionContext: () => {
			for (const row of rebuiltTranscriptRows) {
				chatContainer.addChild(new BashExecutionComponent(row, ui));
			}
		},
		ui,
		chatContainer,
		pendingMessagesContainer,
		pendingBashComponents: [] as BashExecutionComponent[],
		pendingPythonComponents: [] as EvalExecutionComponent[],
		pendingTools: new Map(),
		compactionQueuedMessages: [],
		keybindings: { getDisplayString: () => "Alt+Up" },
		bashComponent: undefined,
		pythonComponent: undefined,
		streamingComponent: undefined,
		showError: () => {},
		showStatus: () => {},
		statusLine: { invalidate: () => {}, setSessionStartTime: () => {} },
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		resetAssistantTextPresentation: vi.fn(),
		resetIrcSidebarSession: () => {},
		resetObserverRegistry: () => {},
		reloadTodos: async () => {},
		isStopped: () => false,
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		chatContainer,
		pendingMessagesContainer,
		bashGate,
		evalGate,
		emitBashChunk: chunk => bashChunkSink?.(chunk),
		emitEvalChunk: chunk => evalChunkSink?.(chunk),
		queuedFollowUps,
		rebuiltTranscriptRows,
	};
}

/** Let the controller reach its awaited execution call. */
async function settle(): Promise<void> {
	await Bun.sleep(0);
}

describe("deferred shell command display", () => {
	it("keeps a mid-turn bash command parented and rendered while it streams", async () => {
		const harness = createHarness({ isStreaming: true });
		const run = new CommandController(harness.ctx).handleBashCommand("printf hello");
		await settle();

		expect(harness.pendingMessagesContainer.children).toHaveLength(1);
		expect(harness.ctx.pendingBashComponents).toHaveLength(1);

		harness.emitBashChunk("hello");
		const streaming = harness.pendingMessagesContainer.render(80).join("\n");
		expect(streaming).toContain("$ printf hello");
		expect(streaming).toContain("hello");

		harness.bashGate.resolve({ exitCode: 0, cancelled: false, output: "hello", truncated: false });
		await run;
	});

	it("moves a completed mid-turn bash command into the chat transcript with its exit status", async () => {
		const harness = createHarness({ isStreaming: true });
		const run = new CommandController(harness.ctx).handleBashCommand("exit 3");
		await settle();
		harness.bashGate.resolve({ exitCode: 3, cancelled: false, output: "boom", truncated: false });
		await run;

		expect(harness.pendingMessagesContainer.children).toHaveLength(0);
		expect(harness.ctx.pendingBashComponents).toHaveLength(0);
		expect(harness.chatContainer.children).toHaveLength(1);
		expect(harness.chatContainer.children[0]).toBeInstanceOf(BashExecutionComponent);
		expect(harness.ctx.bashComponent).toBeUndefined();

		const transcript = harness.chatContainer.render(80).join("\n");
		expect(transcript).toContain("$ exit 3");
		expect(transcript).toContain("boom");
		expect(transcript).toContain("(exit 3)");
	});

	it("lands an idle bash command in the same place as a deferred one", async () => {
		const harness = createHarness({ isStreaming: false });
		const run = new CommandController(harness.ctx).handleBashCommand("printf idle");
		await settle();
		harness.bashGate.resolve({ exitCode: 0, cancelled: false, output: "idle", truncated: false });
		await run;

		expect(harness.pendingMessagesContainer.children).toHaveLength(0);
		expect(harness.chatContainer.children).toHaveLength(1);
		expect(harness.chatContainer.render(80).join("\n")).toContain("$ printf idle");
	});

	it("does not re-add a bash component that a normal submit already flushed to chat", async () => {
		const harness = createHarness({ isStreaming: true });
		const run = new CommandController(harness.ctx).handleBashCommand("sleep 1");
		await settle();

		// Turn ended while the command was still running and the user submitted a
		// new prompt: the live component is flushed into the transcript early.
		new UiHelpers(harness.ctx).flushPendingBashComponents();
		expect(harness.chatContainer.children).toHaveLength(1);

		harness.bashGate.resolve({ exitCode: 0, cancelled: false, output: "done", truncated: false });
		await run;

		expect(harness.chatContainer.children).toHaveLength(1);
		expect(harness.pendingMessagesContainer.children).toHaveLength(0);
	});

	it("survives a queued-message rebuild while the bash command is still running", async () => {
		const harness = createHarness({ isStreaming: true });
		const run = new CommandController(harness.ctx).handleBashCommand("printf mid");
		await settle();
		harness.emitBashChunk("mid");

		const liveComponent = harness.ctx.pendingBashComponents[0];
		harness.queuedFollowUps.push("queued prompt");
		new UiHelpers(harness.ctx).updatePendingMessagesDisplay();

		expect(harness.pendingMessagesContainer.children).toContain(liveComponent);
		expect(harness.ctx.pendingBashComponents).toHaveLength(1);

		const rendered = harness.pendingMessagesContainer.render(80).join("\n");
		expect(rendered).toContain("$ printf mid");
		expect(rendered).toContain("mid");
		expect(rendered).toContain("Queued: queued prompt");

		harness.bashGate.resolve({ exitCode: 0, cancelled: false, output: "mid", truncated: false });
		await run;

		expect(harness.chatContainer.children).toEqual([liveComponent]);
		expect(harness.chatContainer.render(80).join("\n")).toContain("$ printf mid");
	});

	it("drops only the queued chips when the pending display is rebuilt twice", async () => {
		const harness = createHarness({ isStreaming: true });
		const run = new CommandController(harness.ctx).handleBashCommand("printf twice");
		await settle();

		harness.queuedFollowUps.push("queued prompt");
		const helpers = new UiHelpers(harness.ctx);
		helpers.updatePendingMessagesDisplay();
		helpers.updatePendingMessagesDisplay();

		// One live component + spacer + queued chip + dequeue hint, never duplicated.
		expect(harness.pendingMessagesContainer.children).toHaveLength(4);
		expect(harness.pendingMessagesContainer.children[0]).toBe(harness.ctx.pendingBashComponents[0]);

		harness.bashGate.resolve({ exitCode: 0, cancelled: false, output: "twice", truncated: false });
		await run;
	});

	it("keeps a parked bash command through a transcript rebuild", async () => {
		const harness = createHarness({ isStreaming: true });
		const run = new CommandController(harness.ctx).handleBashCommand("printf parked");
		await settle();
		harness.emitBashChunk("parked");

		const liveComponent = harness.ctx.pendingBashComponents[0];
		harness.rebuiltTranscriptRows.push("earlier command");
		new UiHelpers(harness.ctx).renderInitialMessages();

		expect(harness.ctx.resetAssistantTextPresentation).toHaveBeenCalledTimes(1);
		expect(harness.ctx.pendingBashComponents).toEqual([liveComponent]);
		expect(harness.pendingMessagesContainer.children).toEqual([liveComponent]);
		expect(harness.pendingMessagesContainer.render(80).join("\n")).toContain("$ printf parked");
		expect(harness.chatContainer.render(80).join("\n")).toContain("$ earlier command");

		harness.bashGate.resolve({ exitCode: 0, cancelled: false, output: "parked", truncated: false });
		await run;

		expect(harness.chatContainer.children).toContain(liveComponent);
	});

	it("drops a finished parked python block on a transcript rebuild so it is not rendered twice", async () => {
		const harness = createHarness({ isStreaming: true });
		const run = new CommandController(harness.ctx).handlePythonCommand("print('done')");
		await settle();
		harness.evalGate.resolve({ exitCode: 0, cancelled: false, output: "done", truncated: false });
		await run;

		// Finished but still parked: the rebuilt transcript is the session's job now.
		expect(harness.ctx.pendingPythonComponents).toHaveLength(1);

		harness.rebuiltTranscriptRows.push("print('done')");
		new UiHelpers(harness.ctx).renderInitialMessages();

		expect(harness.ctx.pendingPythonComponents).toHaveLength(0);
		expect(harness.pendingMessagesContainer.children).toHaveLength(0);
		expect(harness.chatContainer.children).toHaveLength(1);
	});

	it("keeps a mid-turn python command visible across a queued-message rebuild and a transcript rebuild", async () => {
		const harness = createHarness({ isStreaming: true });
		const run = new CommandController(harness.ctx).handlePythonCommand("print('py')");
		await settle();
		harness.emitEvalChunk("py");

		const liveComponent = harness.ctx.pendingPythonComponents[0];
		expect(harness.pendingMessagesContainer.children).toContain(liveComponent);

		const helpers = new UiHelpers(harness.ctx);
		harness.queuedFollowUps.push("queued prompt");
		helpers.updatePendingMessagesDisplay();
		expect(harness.pendingMessagesContainer.children).toContain(liveComponent);
		expect(harness.pendingMessagesContainer.render(80).join("\n")).toContain("py");

		helpers.renderInitialMessages();
		expect(harness.ctx.pendingPythonComponents).toEqual([liveComponent]);
		expect(harness.pendingMessagesContainer.children).toEqual([liveComponent]);

		harness.evalGate.resolve({ exitCode: 0, cancelled: false, output: "py", truncated: false });
		await run;

		// `$` still parks until the next non-streaming submit flushes it.
		expect(harness.pendingMessagesContainer.children).toEqual([liveComponent]);
		expect(harness.ctx.pendingPythonComponents).toEqual([liveComponent]);

		helpers.flushPendingBashComponents();
		expect(harness.chatContainer.children).toEqual([liveComponent]);
		expect(harness.ctx.pendingPythonComponents).toHaveLength(0);
	});
});

/**
 * Regression coverage for the parentage guard: array membership in
 * `pendingBashComponents` proves nothing about who owns the component. Every
 * transcript-clearing path calls `pendingMessagesContainer.clear()`, which
 * disposes and evicts the parked block without touching the array.
 */
describe("deferred shell command parentage after the transcript is cleared", () => {
	it("re-parents nothing when /clear disposes an in-flight bash block", async () => {
		const harness = createHarness({ isStreaming: true });
		const controller = new CommandController(harness.ctx);
		const run = controller.handleBashCommand("sleep 5");
		await settle();

		const parked = harness.ctx.pendingBashComponents[0];
		expect(harness.pendingMessagesContainer.children).toContain(parked);

		expect(await controller.handleClearCommand()).toBe(true);
		expect(harness.ctx.resetAssistantTextPresentation).toHaveBeenCalledTimes(1);
		expect(harness.pendingMessagesContainer.hasLiveChild(parked)).toBe(false);
		const chatChildrenAfterClear = harness.chatContainer.children.length;

		harness.bashGate.resolve({ exitCode: 0, cancelled: false, output: "late", truncated: false });
		await run;

		expect(harness.chatContainer.children).not.toContain(parked);
		expect(harness.chatContainer.children).toHaveLength(chatChildrenAfterClear);
		expect(harness.ctx.pendingBashComponents).toHaveLength(0);
		expect(harness.pendingMessagesContainer.children).toHaveLength(0);
	});

	it("re-parents nothing when /context-clear disposes an in-flight bash block", async () => {
		const harness = createHarness({ isStreaming: true });
		const controller = new CommandController(harness.ctx);
		const run = controller.handleBashCommand("sleep 5");
		await settle();

		const parked = harness.ctx.pendingBashComponents[0];
		await controller.handleContextClearCommand();
		expect(harness.ctx.resetAssistantTextPresentation).toHaveBeenCalledTimes(1);
		expect(harness.pendingMessagesContainer.hasLiveChild(parked)).toBe(false);
		const chatChildrenAfterClear = harness.chatContainer.children.length;

		harness.bashGate.resolve({ exitCode: 0, cancelled: false, output: "late", truncated: false });
		await run;

		expect(harness.chatContainer.children).not.toContain(parked);
		expect(harness.chatContainer.children).toHaveLength(chatChildrenAfterClear);
		expect(harness.ctx.pendingBashComponents).toHaveLength(0);
	});

	it("re-parents nothing after a bare pending-area clear, and a later flush cannot resurrect it", async () => {
		// Shape shared by extension-ui-controller.ts:679/993 and selector-controller.ts:2681.
		const harness = createHarness({ isStreaming: true });
		const run = new CommandController(harness.ctx).handleBashCommand("sleep 5");
		await settle();

		const parked = harness.ctx.pendingBashComponents[0];
		harness.chatContainer.clear();
		harness.pendingMessagesContainer.clear();

		harness.bashGate.resolve({ exitCode: 0, cancelled: false, output: "late", truncated: false });
		await run;

		expect(harness.chatContainer.children).toHaveLength(0);
		expect(harness.ctx.pendingBashComponents).toHaveLength(0);

		new UiHelpers(harness.ctx).flushPendingBashComponents();
		expect(harness.chatContainer.children).toHaveLength(0);
		expect(harness.chatContainer.children).not.toContain(parked);
	});

	it("keeps a cleared python block out of the transcript on the next flush", async () => {
		const harness = createHarness({ isStreaming: true });
		const run = new CommandController(harness.ctx).handlePythonCommand("print('py')");
		await settle();

		const parked = harness.ctx.pendingPythonComponents[0];
		harness.chatContainer.clear();
		harness.pendingMessagesContainer.clear();

		harness.evalGate.resolve({ exitCode: 0, cancelled: false, output: "py", truncated: false });
		await run;

		new UiHelpers(harness.ctx).flushPendingBashComponents();
		expect(harness.chatContainer.children).toHaveLength(0);
		expect(harness.chatContainer.children).not.toContain(parked);
		expect(harness.ctx.pendingPythonComponents).toHaveLength(0);
	});

	it("drops stale entries on a pending-queue refresh without disposing a live block", async () => {
		const harness = createHarness({ isStreaming: true });
		const run = new CommandController(harness.ctx).handleBashCommand("printf mid");
		await settle();
		harness.emitBashChunk("mid");
		const live = harness.ctx.pendingBashComponents[0];

		// What a transcript clear leaves behind: an entry the container no longer holds.
		harness.ctx.pendingBashComponents.push(new BashExecutionComponent("stale", harness.ctx.ui));

		harness.queuedFollowUps.push("queued prompt");
		new UiHelpers(harness.ctx).updatePendingMessagesDisplay();

		expect(harness.ctx.pendingBashComponents).toEqual([live]);
		expect(harness.pendingMessagesContainer.children).toContain(live);
		expect(harness.pendingMessagesContainer.render(80).join("\n")).toContain("$ printf mid");

		harness.bashGate.resolve({ exitCode: 0, cancelled: false, output: "mid", truncated: false });
		await run;
		expect(harness.chatContainer.children).toEqual([live]);
	});

	it("lands a normally completing deferred bash block in the transcript exactly once", async () => {
		const harness = createHarness({ isStreaming: true });
		const run = new CommandController(harness.ctx).handleBashCommand("printf once");
		await settle();
		const parked = harness.ctx.pendingBashComponents[0];

		harness.bashGate.resolve({ exitCode: 0, cancelled: false, output: "once", truncated: false });
		await run;

		expect(harness.chatContainer.children.filter(child => child === parked)).toHaveLength(1);
		expect(harness.pendingMessagesContainer.children).toHaveLength(0);
		expect(harness.ctx.pendingBashComponents).toHaveLength(0);

		// A later flush must not append a second copy.
		new UiHelpers(harness.ctx).flushPendingBashComponents();
		expect(harness.chatContainer.children.filter(child => child === parked)).toHaveLength(1);
	});

	it("flushes parked blocks into the transcript in pending render order", async () => {
		const harness = createHarness({ isStreaming: true });
		const pythonRun = new CommandController(harness.ctx).handlePythonCommand("print('first')");
		await settle();
		harness.evalGate.resolve({ exitCode: 0, cancelled: false, output: "first", truncated: false });
		await pythonRun;

		const bashRun = new CommandController(harness.ctx).handleBashCommand("printf second");
		await settle();

		const parkedPython = harness.ctx.pendingPythonComponents[0];
		const parkedBash = harness.ctx.pendingBashComponents[0];
		expect(harness.pendingMessagesContainer.children).toEqual([parkedPython, parkedBash]);

		new UiHelpers(harness.ctx).flushPendingBashComponents();
		expect(harness.chatContainer.children).toEqual([parkedPython, parkedBash]);

		harness.bashGate.resolve({ exitCode: 0, cancelled: false, output: "second", truncated: false });
		await bashRun;
		expect(harness.chatContainer.children).toEqual([parkedPython, parkedBash]);
	});
});

describe("deferred shell persistence rebuild race", () => {
	it("does not duplicate a deferred bash block when persistence wins the controller race", async () => {
		const harness = createHarness({ isStreaming: true });
		const persisted = Promise.withResolvers<void>();
		const releaseReturn = Promise.withResolvers<void>();

		harness.ctx.session.executeBash = async (_command, _onChunk, options) => {
			// AgentSession appends the message and reports it as persisted before
			// executeBash returns, so the controller is still suspended when the
			// rebuilt transcript already owns the row.
			harness.rebuiltTranscriptRows.push("printf race");
			options?.onPersisted?.();
			persisted.resolve();
			await releaseReturn.promise;
			return {
				exitCode: 0,
				cancelled: false,
				output: "race",
				truncated: false,
				totalLines: 1,
				totalBytes: 4,
				outputLines: 1,
				outputBytes: 4,
			};
		};

		const run = new CommandController(harness.ctx).handleBashCommand("printf race");
		await persisted.promise;

		new UiHelpers(harness.ctx).renderInitialMessages();
		expect(harness.chatContainer.children).toHaveLength(1);

		releaseReturn.resolve();
		await run;

		// The persisted transcript row is authoritative; completion must discard
		// the superseded live component instead of appending a second copy.
		expect(harness.chatContainer.children).toHaveLength(1);
	});

	it("keeps an unpersisted live block when the rebuild restores an older identical command", async () => {
		const harness = createHarness({ isStreaming: true });
		// An older run of the same command is already in the session transcript.
		harness.rebuiltTranscriptRows.push("printf same");

		const run = new CommandController(harness.ctx).handleBashCommand("printf same");
		await settle();
		const liveComponent = harness.ctx.pendingBashComponents[0];

		new UiHelpers(harness.ctx).renderInitialMessages();

		// The live result is not persisted, so the identical restored row must not
		// supersede it.
		expect(harness.pendingMessagesContainer.children).toEqual([liveComponent]);

		harness.bashGate.resolve({ exitCode: 0, cancelled: false, output: "same", truncated: false });
		await run;

		expect(harness.chatContainer.children).toHaveLength(2);
		expect(harness.chatContainer.children).toContain(liveComponent);
	});
});
