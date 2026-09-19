import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { UserMessageSelectorComponent } from "@gajae-code/coding-agent/modes/components/user-message-selector";
import { CommandController } from "@gajae-code/coding-agent/modes/controllers/command-controller";
import { ExtensionUiController } from "@gajae-code/coding-agent/modes/controllers/extension-ui-controller";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { executeBuiltinSlashCommand } from "@gajae-code/coding-agent/slash-commands/builtin-registry";
import * as titleGenerator from "@gajae-code/coding-agent/utils/title-generator";
import { type Component, Container, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

class TestEditor extends Container {
	#text = "";

	setText(text: string): void {
		this.#text = text;
	}

	getText(): string {
		return this.#text;
	}
}

interface Harness {
	tempDir: string;
	session: AgentSession;
	sessionManager: SessionManager;
	authStorage: AuthStorage;
	ctx: InteractiveModeContext;
	editor: TestEditor;
	editorContainer: Container;
	statuses: string[];
	errors: string[];
	warnings: string[];
	focused: Component[];
	resetIrcSidebarSession: () => void;
	rebuildInitialMessages: (mode: "replace-identity") => void;
	cancelGoalContinuation: () => void;
	scheduleGoalContinuation: () => void;
	committedUiCleanup: () => void;
}

const harnesses: Harness[] = [];

beforeAll(async () => {
	const selectedTheme = await getThemeByName("red-claw");
	if (!selectedTheme) throw new Error("Expected red-claw theme");
	setThemeInstance(selectedTheme);
});

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.dispose();
		harness.authStorage.close();
		fs.rmSync(harness.tempDir, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

function assistantMessage(text: string, timestamp: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "test-model",
		stopReason: "stop" as const,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	};
}

async function createHarness(
	options: { persisted?: boolean; messages?: number; mcpDiscoveryEnabled?: boolean } = {},
): Promise<Harness> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-interactive-fork-"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["test"], tools: [] },
	});
	const sessionManager =
		options.persisted === false ? SessionManager.inMemory() : SessionManager.create(tempDir, tempDir);
	const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
		mcpDiscoveryEnabled: options.mcpDiscoveryEnabled,
	});
	session.subscribe(() => {});
	for (let index = 0; index < (options.messages ?? 3); index++) {
		const timestamp = 1_000 + index * 2;
		sessionManager.appendMessage({ role: "user", content: `prompt-${index + 1}`, timestamp });
		sessionManager.appendMessage(assistantMessage(`answer-${index + 1}`, timestamp + 1));
	}
	await sessionManager.flush();

	const editor = new TestEditor();
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const statuses: string[] = [];
	const errors: string[] = [];
	const warnings: string[] = [];
	const focused: Component[] = [];
	const resetIrcSidebarSession = vi.fn();
	const rebuildInitialMessages = vi.fn();
	const cancelGoalContinuation = vi.fn();
	const scheduleGoalContinuation = vi.fn();
	const committedUiCleanup = vi.fn();
	vi.spyOn(titleGenerator, "setSessionTerminalTitle").mockImplementation(() => {});
	const ctx = {
		session,
		sessionManager,
		editor,
		editorContainer,
		chatContainer: new Container(),
		isInitialized: true,
		loadingAnimation: undefined,
		pendingTools: new Map(),
		pendingBashComponents: [],
		pendingPythonComponents: [],
		bashComponent: undefined,
		pythonComponent: undefined,
		streamingComponent: undefined,
		hasPendingSubmission: () => false,
		hasActiveBtw: () => false,
		handleBtwEscape: vi.fn(),
		statusContainer: { clear: vi.fn() },
		statusLine: { invalidate: vi.fn(), setSessionStartTime: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		resetObserverRegistry: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		ui: {
			terminal: { rows: 40 },
			setFocus: (component: Component) => focused.push(component),
			requestRender: vi.fn(),
		},
		showStatus: (message: string) => statuses.push(message),
		showError: (message: string) => errors.push(message),
		showWarning: (message: string) => warnings.push(message),
		resetIrcSidebarSession,
		rebuildInitialMessages,
		goalModeController: {
			enabled: false,
			paused: false,
			handleCommand: vi.fn(),
			cancelContinuation: cancelGoalContinuation,
			scheduleContinuation: scheduleGoalContinuation,
		},
	} as unknown as InteractiveModeContext;
	const selectorController = new SelectorController(ctx);
	ctx.showUserMessageSelector = () => selectorController.showUserMessageSelector(committedUiCleanup);
	ctx.handleForkCommand = () => new CommandController(ctx).handleForkCommand();
	const harness = {
		tempDir,
		session,
		sessionManager,
		authStorage,
		ctx,
		editor,
		editorContainer,
		statuses,
		errors,
		warnings,
		focused,
		resetIrcSidebarSession,
		rebuildInitialMessages,
		cancelGoalContinuation,
		scheduleGoalContinuation,
		committedUiCleanup,
	};
	harnesses.push(harness);
	return harness;
}

async function dispatchFork(harness: Harness, input = "/fork"): Promise<string | boolean> {
	return executeBuiltinSlashCommand(input, {
		ctx: harness.ctx,
		handleBackgroundCommand: () => {},
	});
}

function visibleSelector(harness: Harness): UserMessageSelectorComponent {
	const selector = harness.editorContainer.children.find(child => child instanceof UserMessageSelectorComponent);
	if (!(selector instanceof UserMessageSelectorComponent)) throw new Error("Expected prompt selector to be visible");
	return selector;
}

async function waitForSelectorClosed(harness: Harness): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (harness.editorContainer.children.length === 1 && harness.editorContainer.children[0] === harness.editor)
			return;
		await Bun.sleep(5);
	}
	throw new Error("Timed out waiting for fork selector to close");
}

describe("user message selector viewport", () => {
	it.each([
		[80, 24],
		[40, 24],
		[120, 36],
	])("keeps latest, oldest, and middle selections visible at %ix%i", async (columns, rows) => {
		const terminal = new VirtualTerminal(columns, rows, { isProcessTerminal: true });
		const tui = new TUI(terminal);
		const selector = new UserMessageSelectorComponent(
			Array.from({ length: 12 }, (_, index) => ({ id: String(index + 1), text: `prompt-${index + 1}` })),
			() => {},
			() => {},
			() => terminal.rows,
		);
		tui.addChild(selector);
		tui.setFocus(selector.getMessageList());
		tui.start();
		try {
			const expectSelectionVisible = async (prompt: string): Promise<void> => {
				tui.requestRender();
				await terminal.waitForRender();
				const viewport = terminal.getViewport().join("\n");
				expect(viewport).toContain(`› prompt-${prompt}`);
				expect(viewport).toContain("↑/↓ move · Enter select · Esc cancel");
			};

			await expectSelectionVisible("12");
			for (let index = 0; index < 11; index++) terminal.sendInput("\x1b[A");
			await expectSelectionVisible("1");
			for (let index = 0; index < 5; index++) terminal.sendInput("\x1b[B");
			await expectSelectionVisible("6");

			terminal.resize(columns, rows);
			await expectSelectionVisible("6");
		} finally {
			tui.stop();
		}
	});
});
describe("interactive /fork prompt selector", () => {
	it("dispatches the real builtin to the existing selector without forking before selection", async () => {
		const harness = await createHarness();
		const originalFile = harness.session.sessionFile;
		const originalBytes = originalFile ? fs.readFileSync(originalFile) : undefined;

		expect(await dispatchFork(harness)).toBe(true);

		expect(visibleSelector(harness).render(100).join("\n")).toContain("Fork from Prompt");
		expect(harness.session.sessionFile).toBe(originalFile);
		expect(originalFile && fs.readFileSync(originalFile)).toEqual(originalBytes);
		expect(harness.editor.getText()).toBe("");
	});

	it.each([
		["first", 2, "prompt-1", 0],
		["middle", 1, "prompt-2", 2],
		["latest", 0, "prompt-3", 4],
	] as const)("selecting the %s prompt persists an independent resumable predecessor and restores a draft", async (_label, up, selected, keptMessages) => {
		const harness = await createHarness();
		const parentFile = harness.session.sessionFile;
		if (!parentFile) throw new Error("Expected persisted parent");
		const parentBytes = fs.readFileSync(parentFile);
		const promptSpy = vi.spyOn(harness.session, "prompt");
		await dispatchFork(harness);
		const list = visibleSelector(harness).getMessageList();
		for (let index = 0; index < up; index++) list.handleInput("\x1b[A");
		list.handleInput("\r");
		await waitForSelectorClosed(harness);

		const childFile = harness.session.sessionFile;
		if (!childFile) throw new Error("Expected persisted child");
		expect(childFile).not.toBe(parentFile);
		expect(fs.readFileSync(parentFile)).toEqual(parentBytes);
		expect(harness.session.messages).toHaveLength(keptMessages);
		expect(harness.editorContainer.children).toEqual([harness.editor]);
		expect(harness.editor.getText()).toBe(selected);
		expect(promptSpy).not.toHaveBeenCalled();
		expect(harness.resetIrcSidebarSession).toHaveBeenCalledTimes(1);
		expect(harness.rebuildInitialMessages).toHaveBeenCalledWith("replace-identity");
		expect(harness.ctx.resetObserverRegistry).toHaveBeenCalledTimes(1);
		expect(harness.ctx.reloadTodos).toHaveBeenCalledTimes(1);
		expect(harness.ctx.statusLine.setSessionStartTime).toHaveBeenCalledWith(expect.any(Number));
		expect(titleGenerator.setSessionTerminalTitle).toHaveBeenLastCalledWith(
			harness.sessionManager.getSessionName(),
			harness.sessionManager.getCwd(),
		);
		expect(harness.committedUiCleanup).toHaveBeenCalledTimes(1);
		expect(harness.scheduleGoalContinuation).not.toHaveBeenCalled();

		const resumed = await SessionManager.open(childFile, harness.tempDir);
		try {
			expect(resumed.getEntries().filter(entry => entry.type === "message")).toHaveLength(keptMessages);
		} finally {
			await resumed.close();
		}
	});

	it("refreshes the todo panel from the child rather than retaining parent-only tasks", async () => {
		const harness = await createHarness();
		harness.session.setTodoPhases([{ name: "Parent", tasks: [{ content: "parent-only task", status: "pending" }] }]);
		let visibleTasks = harness.session.getTodoPhases().flatMap(phase => phase.tasks.map(task => task.content));
		harness.ctx.reloadTodos = async () => {
			visibleTasks = harness.session.getTodoPhases().flatMap(phase => phase.tasks.map(task => task.content));
		};
		expect(visibleTasks).toEqual(["parent-only task"]);
		await dispatchFork(harness);
		visibleSelector(harness).getMessageList().handleInput("\r");
		await waitForSelectorClosed(harness);
		expect(visibleTasks).toEqual([]);
		expect(harness.editor.getText()).toBe("prompt-3");
	});

	it("Esc closes the selector without changing the parent transcript or draft", async () => {
		const harness = await createHarness();
		harness.editor.setText("draft-before-fork");
		const parentFile = harness.session.sessionFile;
		if (!parentFile) throw new Error("Expected persisted parent");
		const parentBytes = fs.readFileSync(parentFile);
		await dispatchFork(harness);
		visibleSelector(harness).getMessageList().handleInput("\x1b");

		expect(harness.session.sessionFile).toBe(parentFile);
		expect(fs.readFileSync(parentFile)).toEqual(parentBytes);
		expect(harness.editorContainer.children).toEqual([harness.editor]);
		expect(harness.editor.getText()).toBe("");
		expect(harness.resetIrcSidebarSession).not.toHaveBeenCalled();
		expect(harness.cancelGoalContinuation).toHaveBeenCalledTimes(1);
		expect(harness.scheduleGoalContinuation).toHaveBeenCalledTimes(1);
	});

	it.each([
		["streaming", { persisted: true, messages: 3 }, "isStreaming"],
		["in-memory", { persisted: false, messages: 3 }, "none"],
		["empty", { persisted: true, messages: 0 }, "none"],
	] as const)("does not open or fork a %s session", async (_label, options, state) => {
		const harness = await createHarness(options);
		if (state === "isStreaming") {
			Object.defineProperty(harness.session, "isStreaming", { configurable: true, value: true });
		}
		const originalFile = harness.session.sessionFile;
		await dispatchFork(harness);

		expect(harness.editorContainer.children).toEqual([harness.editor]);
		expect(harness.session.sessionFile).toBe(originalFile);
		expect(harness.resetIrcSidebarSession).not.toHaveBeenCalled();
		expect(harness.warnings.length + harness.errors.length + harness.statuses.length).toBeGreaterThan(0);
	});
	it.each([
		["builtin", "compacting"],
		["builtin", "pending submission"],
		["builtin", "foreground command"],
		["direct picker", "compacting"],
		["direct picker", "pending submission"],
		["direct picker", "foreground command"],
	] as const)("does not open or fork through the %s while %s is active", async (entrypoint, busy) => {
		const harness = await createHarness();
		if (busy === "compacting") {
			Object.defineProperty(harness.session, "isCompacting", { configurable: true, value: true });
		}
		if (busy === "pending submission") harness.ctx.hasPendingSubmission = () => true;
		if (busy === "foreground command") {
			harness.ctx.bashComponent = new Container() as InteractiveModeContext["bashComponent"];
		}
		const parentFile = harness.session.sessionFile;
		harness.ctx.hasActiveBtw = () => true;
		if (entrypoint === "builtin") await dispatchFork(harness);
		else harness.ctx.showUserMessageSelector();

		expect(harness.editorContainer.children).toEqual([harness.editor]);
		expect(harness.session.sessionFile).toBe(parentFile);
		expect(harness.warnings).toHaveLength(1);
		expect(harness.cancelGoalContinuation).not.toHaveBeenCalled();
		expect(harness.ctx.handleBtwEscape).not.toHaveBeenCalled();
	});
	it("rechecks busy state after the picker opens and before branching", async () => {
		const harness = await createHarness();
		const branch = vi.spyOn(harness.session, "branch");
		let pending = false;
		harness.ctx.hasPendingSubmission = () => pending;
		harness.ctx.showUserMessageSelector();
		const list = visibleSelector(harness).getMessageList();
		pending = true;
		list.handleInput("\r");
		await waitForSelectorClosed(harness);

		expect(branch).not.toHaveBeenCalled();
		expect(harness.editorContainer.children).toEqual([harness.editor]);
		expect(harness.statuses).toContain("Wait for the pending message to be submitted or cancel it before forking.");
		expect(harness.cancelGoalContinuation).toHaveBeenCalledTimes(1);
		expect(harness.scheduleGoalContinuation).toHaveBeenCalledTimes(1);
		expect(harness.resetIrcSidebarSession).not.toHaveBeenCalled();
	});

	it("preserves the parent and composer when a branch hook cancels selection", async () => {
		const harness = await createHarness();
		const parentFile = harness.session.sessionFile;
		if (!parentFile) throw new Error("Expected persisted parent");
		const parentBytes = fs.readFileSync(parentFile);
		vi.spyOn(harness.session, "branch").mockResolvedValueOnce({ selectedText: "prompt-3", cancelled: true });
		await dispatchFork(harness);
		visibleSelector(harness).getMessageList().handleInput("\r");
		await waitForSelectorClosed(harness);

		expect(harness.session.sessionFile).toBe(parentFile);
		expect(fs.readFileSync(parentFile)).toEqual(parentBytes);
		expect(harness.editorContainer.children).toEqual([harness.editor]);
		expect(harness.editor.getText()).toBe("");
		expect(harness.statuses).toContain("Fork cancelled");
		expect(harness.resetIrcSidebarSession).not.toHaveBeenCalled();
		expect(harness.cancelGoalContinuation).toHaveBeenCalledTimes(1);
		expect(harness.scheduleGoalContinuation).toHaveBeenCalledTimes(1);
	});

	it("cleans active BTW state before restoring the selected prompt", async () => {
		const harness = await createHarness();
		const draftsAtCleanup: string[] = [];
		harness.ctx.hasActiveBtw = () => true;
		harness.ctx.handleBtwEscape = () => {
			draftsAtCleanup.push(harness.editor.getText());
			return true;
		};
		await dispatchFork(harness);
		visibleSelector(harness).getMessageList().handleInput("\r");
		await waitForSelectorClosed(harness);

		expect(draftsAtCleanup).toEqual([""]);
		expect(harness.editor.getText()).toBe("prompt-3");
	});

	it("surfaces async branch failure, restores the editor, and retains parent state", async () => {
		const harness = await createHarness();
		const parentFile = harness.session.sessionFile;
		if (!parentFile) throw new Error("Expected persisted parent");
		const parentBytes = fs.readFileSync(parentFile);
		vi.spyOn(harness.sessionManager, "prepareBranchedSession").mockRejectedValueOnce(new Error("disk failure"));
		await dispatchFork(harness);
		visibleSelector(harness).getMessageList().handleInput("\r");
		await waitForSelectorClosed(harness);

		expect(harness.session.sessionFile).toBe(parentFile);
		expect(fs.readFileSync(parentFile)).toEqual(parentBytes);
		expect(harness.editorContainer.children).toEqual([harness.editor]);
		expect(harness.editor.getText()).toBe("");
		expect(harness.errors.join("\n")).toContain("disk failure");
		expect(harness.resetIrcSidebarSession).not.toHaveBeenCalled();
		expect(harness.ctx.reloadTodos).not.toHaveBeenCalled();
		expect(harness.ctx.resetObserverRegistry).not.toHaveBeenCalled();
		expect(harness.committedUiCleanup).not.toHaveBeenCalled();
		expect(titleGenerator.setSessionTerminalTitle).not.toHaveBeenCalled();
	});

	it.each([
		"MCP restoration",
		"tool cleanup",
	] as const)("reconciles the durable child when real branch lifecycle fails during %s", async failurePoint => {
		const harness = await createHarness({ mcpDiscoveryEnabled: failurePoint === "MCP restoration" });
		const parentFile = harness.session.sessionFile!;
		const parentId = harness.sessionManager.getSessionId();
		const parentBytes = fs.readFileSync(parentFile);
		harness.session.agent.replaceMessages(harness.sessionManager.buildSessionContext().messages);
		const branch = vi.spyOn(harness.session, "branch");
		const prompt = vi.spyOn(harness.session, "prompt");
		let unregister = () => {};
		if (failurePoint === "MCP restoration") {
			// This public query is called by the real MCP selection restoration
			// path before it applies the restored tool selection.
			vi.spyOn(harness.session, "getActiveToolNames").mockImplementationOnce(() => {
				throw new Error("MCP selection restore failed");
			});
		} else {
			unregister = harness.session.registerToolSessionTransitionCleanup(() => {
				throw new Error("tool cleanup failed");
			});
		}
		let renderedMessages = -1;
		let observedFile: string | undefined;
		let todoFile: string | undefined;
		harness.ctx.rebuildInitialMessages = vi.fn(() => {
			renderedMessages = harness.sessionManager.buildSessionContext().messages.length;
		});
		harness.ctx.resetObserverRegistry = () => {
			observedFile = harness.sessionManager.getSessionFile();
		};
		harness.ctx.reloadTodos = async () => {
			todoFile = harness.sessionManager.getSessionFile();
		};
		try {
			await dispatchFork(harness);
			visibleSelector(harness).getMessageList().handleInput("\r");
			await waitForSelectorClosed(harness);

			const childFile = harness.session.sessionFile!;
			expect(branch).toHaveBeenCalledTimes(1);
			expect(childFile).not.toBe(parentFile);
			expect(harness.sessionManager.getSessionId()).not.toBe(parentId);
			expect(fs.readFileSync(parentFile)).toEqual(parentBytes);
			expect(harness.session.agent.sessionId).toBe(harness.sessionManager.getSessionId());
			expect(harness.session.messages).toEqual(harness.sessionManager.buildSessionContext().messages);
			expect(harness.session.messages).toHaveLength(4);
			expect(renderedMessages).toBe(4);
			expect(observedFile).toBe(childFile);
			expect(todoFile).toBe(childFile);
			expect(harness.resetIrcSidebarSession).toHaveBeenCalledTimes(1);
			expect(harness.committedUiCleanup).toHaveBeenCalledTimes(1);
			expect(harness.ctx.statusLine.setSessionStartTime).toHaveBeenCalledTimes(1);
			expect(titleGenerator.setSessionTerminalTitle).toHaveBeenLastCalledWith(
				harness.sessionManager.getSessionName(),
				harness.sessionManager.getCwd(),
			);
			expect(harness.editor.getText()).toBe("prompt-3");
			expect(prompt).not.toHaveBeenCalled();
			expect(harness.scheduleGoalContinuation).not.toHaveBeenCalled();
			expect(harness.errors.join("\n")).toContain("Fork created, but session setup failed");
			expect(harness.errors.join("\n")).toContain(
				failurePoint === "MCP restoration"
					? "MCP selection restore failed"
					: "Tool session transition cleanup failed",
			);
			const resumed = await SessionManager.open(childFile, harness.tempDir);
			try {
				expect(resumed.buildSessionContext().messages).toHaveLength(4);
			} finally {
				await resumed.close();
			}
		} finally {
			unregister();
		}
	});

	it.each([
		"escape",
		"hook cancellation",
		"failure",
		"stopped",
	] as const)("closes BTW before the picker owns the composer on %s", async outcome => {
		const harness = await createHarness();
		const parentFile = harness.session.sessionFile;
		let active = true;
		harness.editor.setText("private side-chat draft");
		harness.ctx.hasActiveBtw = () => active;
		const closeBtw = vi.fn(() => {
			active = false;
			harness.editor.setText("");
			return true;
		});
		harness.ctx.handleBtwEscape = closeBtw;
		const gate = Promise.withResolvers<{ selectedText: string; cancelled: boolean }>();
		const branch = vi.spyOn(harness.session, "branch").mockReturnValue(gate.promise);
		await dispatchFork(harness);
		expect(closeBtw).toHaveBeenCalledTimes(1);
		expect(active).toBe(false);
		expect(harness.editor.getText()).toBe("");
		const list = visibleSelector(harness).getMessageList();
		if (outcome === "escape") {
			list.handleInput("\x1b");
			expect(branch).not.toHaveBeenCalled();
		} else {
			list.handleInput("\r");
			if (outcome === "stopped") harness.ctx.isStopped = () => true;
			if (outcome === "failure") gate.reject(new Error("branch failed"));
			else gate.resolve({ selectedText: "prompt-3", cancelled: true });
			if (outcome !== "stopped") await waitForSelectorClosed(harness);
			else await Promise.resolve();
		}
		expect(closeBtw).toHaveBeenCalledTimes(1);
		expect(harness.session.sessionFile).toBe(parentFile);
		expect(harness.resetIrcSidebarSession).not.toHaveBeenCalled();
		expect(harness.committedUiCleanup).not.toHaveBeenCalled();
	});

	it.each([
		"builtin",
		"shared picker",
	] as const)("rejects ephemeral sessions through %s without closing BTW", async entrypoint => {
		const harness = await createHarness({ persisted: false });
		harness.ctx.hasActiveBtw = () => true;
		harness.editor.setText("side-chat draft");
		if (entrypoint === "builtin") await dispatchFork(harness);
		else harness.ctx.showUserMessageSelector();
		expect(harness.errors).toEqual(["Fork requires a persisted session"]);
		expect(harness.ctx.handleBtwEscape).not.toHaveBeenCalled();
		expect(harness.editor.getText()).toBe(entrypoint === "builtin" ? "" : "side-chat draft");
		expect(harness.editorContainer.children).toEqual([harness.editor]);
		expect(harness.cancelGoalContinuation).not.toHaveBeenCalled();
	});

	it("detaches all captured parent UI despite throwing disposers and preserves child replacements", async () => {
		const harness = await createHarness();
		const parentFile = harness.session.sessionFile!;
		const parentBytes = fs.readFileSync(parentFile);
		harness.ctx.hookWidgetContainerAbove = new Container();
		harness.ctx.hookWidgetContainerBelow = new Container();
		const extensions = new ExtensionUiController(harness.ctx);
		const failingWidget = new Container();
		const otherWidget = new Container();
		const replacedWidget = new Container();
		const childWidget = new Container();
		const overlayComponent = new Container();
		const widgetFailure = new Error("widget disposal failed");
		const overlayFailure = new Error("overlay disposal failed");
		const inputFailure = new Error("input unsubscribe failed");
		const disposeFailing = vi.spyOn(failingWidget, "dispose").mockImplementation(() => {
			throw widgetFailure;
		});
		const disposeOther = vi.spyOn(otherWidget, "dispose");
		const disposeChild = vi.spyOn(childWidget, "dispose");
		const disposeOverlay = vi.spyOn(overlayComponent, "dispose").mockImplementation(() => {
			throw overlayFailure;
		});
		extensions.setHookWidget("failing", () => failingWidget);
		extensions.setHookWidget("other", () => otherWidget, { placement: "belowEditor" });
		extensions.setHookWidget("replacement", () => replacedWidget);
		const failingUnsubscribe = vi.fn(() => {
			throw inputFailure;
		});
		const otherUnsubscribe = vi.fn();
		harness.ctx.ui.addInputListener = vi
			.fn()
			.mockReturnValueOnce(failingUnsubscribe)
			.mockReturnValueOnce(otherUnsubscribe);
		extensions.addExtensionTerminalInputListener(() => undefined);
		extensions.addExtensionTerminalInputListener(() => undefined);
		let overlayVisible = false;
		const hideOverlay = vi.fn(() => {
			overlayVisible = false;
		});
		harness.ctx.ui.showOverlay = vi.fn(() => {
			overlayVisible = true;
			return { hide: hideOverlay, setHidden: () => {}, isHidden: () => !overlayVisible };
		});
		const overlayResult = extensions.showHookCustom(() => overlayComponent, { overlay: true });
		for (let attempt = 0; attempt < 20 && !overlayVisible; attempt++) await Promise.resolve();
		expect(overlayVisible).toBe(true);
		const cleanup = extensions.captureSessionUiCleanup();
		let cleanupFailure: unknown;
		const selectorController = new SelectorController(harness.ctx);
		harness.ctx.showUserMessageSelector = () =>
			selectorController.showUserMessageSelector(() => {
				extensions.setHookWidget("replacement", () => childWidget);
				try {
					cleanup();
				} catch (error) {
					cleanupFailure = error;
					throw error;
				}
			});
		await dispatchFork(harness);
		visibleSelector(harness).getMessageList().handleInput("\r");
		await waitForSelectorClosed(harness);
		expect(cleanupFailure).toBeInstanceOf(AggregateError);
		expect((cleanupFailure as AggregateError).errors).toEqual([inputFailure, widgetFailure, overlayFailure]);
		expect(failingUnsubscribe).toHaveBeenCalledTimes(1);
		expect(otherUnsubscribe).toHaveBeenCalledTimes(1);
		expect(disposeFailing).toHaveBeenCalledTimes(1);
		expect(disposeOther).toHaveBeenCalledTimes(1);
		expect(disposeOverlay).toHaveBeenCalledTimes(1);
		expect(disposeChild).not.toHaveBeenCalled();
		expect(harness.ctx.hookWidgetContainerAbove.children).toContain(childWidget);
		expect(harness.ctx.hookWidgetContainerAbove.children).not.toContain(failingWidget);
		expect(harness.ctx.hookWidgetContainerAbove.children).not.toContain(replacedWidget);
		expect(harness.ctx.hookWidgetContainerBelow.children).toEqual([]);
		expect(overlayVisible).toBe(false);
		expect(hideOverlay).toHaveBeenCalledTimes(1);
		expect(await overlayResult).toBeUndefined();
		cleanup();
		expect(failingUnsubscribe).toHaveBeenCalledTimes(1);
		expect(disposeFailing).toHaveBeenCalledTimes(1);
		expect(disposeChild).not.toHaveBeenCalled();
		expect(harness.session.sessionFile).not.toBe(parentFile);
		expect(fs.readFileSync(parentFile)).toEqual(parentBytes);
		expect(harness.session.agent.sessionId).toBe(harness.sessionManager.getSessionId());
		expect(harness.session.messages).toHaveLength(4);
		expect(harness.resetIrcSidebarSession).toHaveBeenCalledTimes(1);
		expect(harness.rebuildInitialMessages).toHaveBeenCalledWith("replace-identity");
		expect(harness.ctx.reloadTodos).toHaveBeenCalledTimes(1);
		expect(harness.editor.getText()).toBe("prompt-3");
		expect(harness.errors).toContain(
			"Fork created, but session setup failed: Previous session extension UI cleanup failed",
		);
		expect(harness.scheduleGoalContinuation).not.toHaveBeenCalled();
	});
	it("ignores rapid repeated Enter while one branch selection is pending", async () => {
		const harness = await createHarness();
		const parentFile = harness.session.sessionFile;
		if (!parentFile) throw new Error("Expected persisted parent");
		const parentBytes = fs.readFileSync(parentFile);
		const gate = Promise.withResolvers<{ selectedText: string; cancelled: boolean }>();
		const branch = vi.spyOn(harness.session, "branch").mockReturnValue(gate.promise);
		await dispatchFork(harness);
		const list = visibleSelector(harness).getMessageList();
		list.handleInput("\r");
		list.handleInput("\r");
		expect(branch).toHaveBeenCalledTimes(1);
		gate.resolve({ selectedText: "prompt-3", cancelled: true });
		await waitForSelectorClosed(harness);
		expect(harness.resetIrcSidebarSession).not.toHaveBeenCalled();
		expect(harness.session.sessionFile).toBe(parentFile);
		expect(fs.readFileSync(parentFile)).toEqual(parentBytes);
		expect(harness.editorContainer.children).toEqual([harness.editor]);
		expect(harness.editor.getText()).toBe("");
	});

	it("consumes unsupported arguments as usage instead of submitting or opening the selector", async () => {
		const harness = await createHarness();
		const prompt = vi.spyOn(harness.session, "prompt");
		expect(await dispatchFork(harness, "/fork unexpected")).toBe(true);
		expect(prompt).not.toHaveBeenCalled();
		expect(harness.editorContainer.children).toEqual([harness.editor]);
		expect([...harness.errors, ...harness.statuses].join("\n")).toContain("Usage: /fork");
	});
});
