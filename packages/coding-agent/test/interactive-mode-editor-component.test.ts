import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { resetSettingsForTest, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import { initTheme, theme } from "@gajae-code/coding-agent/modes/theme/theme";
import { CURSOR_MARKER, ImageProtocol, setTerminalImageProtocol, TERMINAL, Text, visibleWidth } from "@gajae-code/tui";
import { TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionUIContext,
} from "../src/extensibility/extensions";
import { CustomEditor } from "../src/modes/components/custom-editor";
import { ExtensionUiController } from "../src/modes/controllers/extension-ui-controller";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { associateSessionMessageEntryId, type SessionContext, SessionManager } from "../src/session/session-manager";

class TestModalEditor extends CustomEditor {}
function stripRenderControls(line: string): string {
	return stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, ""));
}

function forceTerminalSize(mode: InteractiveMode, columns: number, rows: number): void {
	Object.defineProperty(mode.ui.terminal, "columns", { configurable: true, get: () => columns });
	Object.defineProperty(mode.ui.terminal, "rows", { configurable: true, get: () => rows });
}

describe("InteractiveMode.setEditorComponent", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-editor-component-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("applies viewport policy inside the real destructive rebuild methods", () => {
		const reset = vi.spyOn(mode.ui, "resetViewportAnchorIntent");
		const reconcile = vi.spyOn(mode.ui, "prepareViewportAnchorForTranscriptRebuild");
		vi.spyOn(mode, "renderSessionContext").mockImplementation(() => undefined);

		mode.rebuildChatFromMessages("replace-identity");
		expect(reset).toHaveBeenCalledTimes(1);
		expect(reconcile).not.toHaveBeenCalled();

		mode.rebuildInitialMessages("reconcile-same-transcript", {
			messages: [],
			thinkingLevel: "off",
			serviceTier: undefined,
			models: {},
			injectedTtsrRules: [],
			selectedMCPToolNames: [],
			hasPersistedMCPToolSelection: false,
			mode: "none",
		});
		expect(reconcile).toHaveBeenCalledTimes(1);
	});

	it("renders an idle extension custom message through the real rebuild boundary", async () => {
		let actions: ExtensionActions | undefined;
		const extensionRunner = {
			initialize(
				capturedActions: ExtensionActions,
				_contextActions: ExtensionContextActions,
				_commandContextActions?: ExtensionCommandContextActions,
				_uiContext?: ExtensionUIContext,
			): void {
				actions = capturedActions;
			},
			getMessageRenderer: () => undefined,
		};
		Object.defineProperty(session, "extensionRunner", {
			configurable: true,
			value: extensionRunner as unknown as AgentSession["extensionRunner"],
		});
		const reconcile = vi.spyOn(mode.ui, "prepareViewportAnchorForTranscriptRebuild");
		new ExtensionUiController(mode).initializeHookRunner({} as ExtensionUIContext, false);
		if (!actions) throw new Error("Extension actions were not initialized");

		actions.sendMessage({ customType: "test", content: "visible extension message", display: true });
		await Bun.sleep(0);

		expect(reconcile).toHaveBeenCalledTimes(1);
		expect(mode.chatContainer.render(80).join("\n")).toContain("visible extension message");
	});

	it("renders the default composer as a closed rounded input box", () => {
		const lines = mode.editor.render(48).map(stripRenderControls);

		expect(lines.every(line => visibleWidth(line) === 48)).toBe(true);
		expect(lines.every(line => line.endsWith(" "))).toBe(true);
		expect(lines[0].trimEnd()).toStartWith("╭");
		expect(lines[0].trimEnd()).toEndWith("╮");
		expect(lines.at(-1)!.trimEnd()).toStartWith("╰");
		expect(lines.at(-1)!.trimEnd()).toEndWith("╯");
		expect(lines.some(line => line.startsWith("│") && line.includes(">") && line.trimEnd().endsWith("│"))).toBe(true);
		expect(lines.join("\n")).toContain("Type your message...");
		expect(lines.join("\n")).not.toContain("›");
	});

	it("keeps transcript anchoring registered across live IRC sidebar settings", () => {
		const setViewportAnchor = vi.spyOn(mode.ui, "setViewportAnchorComponent");
		mode.settings.set("irc.enabled", true);
		mode.settings.set("irc.sidebar.enabled", true);
		mode.applyIrcSidebarAvailability(true);
		mode.toggleIrcSidebar();
		mode.settings.set("irc.sidebar.enabled", false);
		mode.applyIrcSidebarAvailability(false);
		expect(setViewportAnchor).not.toHaveBeenCalled();
	});

	it("captures a null resolved toggle key from an explicitly empty binding and suppresses the live hint", () => {
		mode.settings.set("irc.enabled", true);
		mode.settings.set("irc.sidebar.enabled", true);
		mode.applyIrcSidebarAvailability(true);
		vi.spyOn(mode.keybindings, "getKeys").mockImplementation(action =>
			action === "app.irc.sidebar.toggle" ? [] : [],
		);

		const arrival = mode.captureIrcArrivalSnapshot();
		expect(arrival.resolvedToggleKey).toBeNull();

		const components = mode.addLiveIrcObservationToChat(
			{
				observationId: "unbound-key-arrival",
				kind: "incoming",
				from: "worker",
				to: "you",
				text: "hint must be suppressed",
				timestamp: 1,
			},
			arrival,
		);
		const rendered = components.flatMap(component => component.render(120)).map(line => Bun.stripANSI(line));
		expect(rendered.join("\n")).not.toContain("opens sidebar");
	});

	it("suppresses a toggle hint when a built-in editor action owns the configured key", () => {
		mode.settings.set("irc.enabled", true);
		mode.settings.set("irc.sidebar.enabled", true);
		mode.applyIrcSidebarAvailability(true);
		vi.spyOn(mode.keybindings, "getKeys").mockImplementation(action =>
			action === "app.irc.sidebar.toggle" ? ["ctrl+c", "alt+i"] : [],
		);
		vi.spyOn(mode.editor, "hasActionKey").mockImplementation(key => key === "ctrl+c");

		expect(mode.captureIrcArrivalSnapshot().resolvedToggleKey).toBe("alt+i");
	});

	it("converts requested-visible state to a closed arrival snapshot below the sidebar width floor", () => {
		mode.settings.set("irc.enabled", true);
		mode.settings.set("irc.sidebar.enabled", true);
		mode.applyIrcSidebarAvailability(true);
		mode.toggleIrcSidebar();

		forceTerminalSize(mode, 64, 24);
		const narrow = mode.captureIrcArrivalSnapshot();
		expect(narrow.panelVisible).toBe(false);

		forceTerminalSize(mode, 65, 24);
		const wideEnough = mode.captureIrcArrivalSnapshot();
		expect(wideEnough.panelVisible).toBe(true);
	});

	it("suppresses the toggle hint when the panel is requested-open but yielded at narrow width", () => {
		mode.settings.set("irc.enabled", true);
		mode.settings.set("irc.sidebar.enabled", true);
		mode.applyIrcSidebarAvailability(true);
		mode.toggleIrcSidebar();
		forceTerminalSize(mode, 64, 24);

		const arrival = mode.captureIrcArrivalSnapshot();
		expect(arrival.panelVisible).toBe(false);
		expect(arrival.panelRequestedVisible).toBe(true);

		const record = mode.ircLedger.observe(
			{
				observationId: "yielded-panel-arrival",
				kind: "incoming",
				from: "worker",
				to: "you",
				text: "no misleading hint",
				timestamp: 1,
			},
			arrival.panelVisible,
		);
		if (!record) throw new Error("Expected yielded-panel observation to be retained");
		expect(record.mode).toBe("persistent");

		const components = mode.addLiveIrcObservationToChat(
			{
				observationId: "yielded-panel-arrival",
				kind: "incoming",
				from: "worker",
				to: "you",
				text: "no misleading hint",
				timestamp: 1,
			},
			arrival,
		);
		const rendered = components.flatMap(component => component.render(120)).map(line => Bun.stripANSI(line));
		expect(rendered.join("\n")).not.toContain("opens sidebar");
	});

	it("marks only durable transcript messages as viewport-anchor eligible", async () => {
		await mode.init();
		mode.addMessageToChat({ role: "user", content: "durable semantic user", timestamp: 1 });
		mode.addMessageToChat({ role: "user", content: "synthetic replay row", synthetic: true, timestamp: 2 });
		mode.showStatus("ephemeral status row");

		const rendered = mode.chatContainer.renderWithViewportAnchors(48);
		const plainLines = rendered.lines.map(line => Bun.stripANSI(line));
		const durableRow = plainLines.findIndex(line => line.includes("durable semantic user"));
		const syntheticRow = plainLines.findIndex(line => line.includes("synthetic replay row"));
		const statusRow = plainLines.findIndex(line => line.includes("ephemeral status row"));
		expect(durableRow).toBeGreaterThanOrEqual(0);
		expect(rendered.anchors[durableRow]).not.toBeNull();
		const durableId = rendered.anchors[durableRow]?.id;
		expect(durableId).toBeDefined();
		const userLabelRow = plainLines.findIndex(line => line.trim() === "user");
		expect(userLabelRow).toBeGreaterThanOrEqual(0);
		expect(rendered.anchors[userLabelRow]).toBeNull();
		expect(rendered.lines.join("")).toContain("\x1b]133;A\x07");
		expect(rendered.lines.join("")).toContain("\x1b]133;B\x07\x1b]133;C\x07");
		expect(syntheticRow).toBeGreaterThanOrEqual(0);
		expect(rendered.anchors[syntheticRow]).toBeNull();
		expect(statusRow).toBeGreaterThanOrEqual(0);
		expect(rendered.anchors[statusRow]).toBeNull();

		mode.settings.set("irc.enabled", true);
		mode.settings.set("irc.sidebar.enabled", true);
		mode.applyIrcSidebarAvailability(true);
		mode.toggleIrcSidebar();
		const visibleSplit = mode.ui.renderWithViewportAnchors(80);
		const visibleDurable = visibleSplit.anchors.findIndex(anchor => anchor?.id === durableId);
		expect(visibleDurable).toBeGreaterThanOrEqual(0);
		expect(visibleSplit.anchors[visibleDurable]).not.toBeNull();

		mode.applyIrcSidebarAvailability(false);
		const temporarilyUnavailable = mode.ui.renderWithViewportAnchors(80);
		const temporaryRow = temporarilyUnavailable.anchors.findIndex(anchor => anchor?.id === durableId);
		expect(temporaryRow).toBeGreaterThanOrEqual(0);
		expect(temporarilyUnavailable.anchors[temporaryRow]).not.toBeNull();
		mode.applyIrcSidebarAvailability(true);
		const restoredVisible = mode.ui.renderWithViewportAnchors(80);
		const restoredRow = restoredVisible.anchors.findIndex(anchor => anchor?.id === durableId);
		expect(restoredRow).toBeGreaterThanOrEqual(0);
		expect(restoredVisible.anchors[restoredRow]).not.toBeNull();

		mode.settings.set("irc.sidebar.enabled", false);
		mode.applyIrcSidebarAvailability(false);
		const hiddenSplit = mode.ui.renderWithViewportAnchors(80);
		const hiddenDurable = hiddenSplit.anchors.findIndex(anchor => anchor?.id === durableId);
		expect(hiddenDurable).toBeGreaterThanOrEqual(0);
		expect(hiddenSplit.anchors[hiddenDurable]).not.toBeNull();

		mode.settings.set("irc.enabled", false);
		mode.settings.set("irc.sidebar.enabled", true);
		mode.applyIrcSidebarAvailability(false);
		const unavailable = mode.ui.renderWithViewportAnchors(80);
		const unavailableRow = unavailable.anchors.findIndex(anchor => anchor?.id === durableId);
		expect(unavailableRow).toBeGreaterThanOrEqual(0);
		expect(unavailable.anchors[unavailableRow]).not.toBeNull();
	});

	it("keeps duplicate transcript occurrences distinct and stable across rebuild", () => {
		const userMessages = [
			{ role: "user" as const, content: "identical user", timestamp: 42 },
			{ role: "user" as const, content: "identical user", timestamp: 42 },
		];
		const assistantMessage = (): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text: "identical assistant" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "same-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 42,
		});
		const assistantMessages = [assistantMessage(), assistantMessage()];
		associateSessionMessageEntryId(userMessages[0], "user-a");
		associateSessionMessageEntryId(userMessages[1], "user-b");
		associateSessionMessageEntryId(assistantMessages[0], "assistant-a");
		associateSessionMessageEntryId(assistantMessages[1], "assistant-b");
		for (const message of [...userMessages, ...assistantMessages]) mode.addMessageToChat(message);
		const orderedOccurrenceIds = (anchors: ReadonlyArray<{ id: string } | null>, prefix: string): string[] => {
			const ids: string[] = [];
			const seen = new Set<string>();
			for (const anchor of anchors) {
				if (anchor === null || !anchor.id.startsWith(prefix) || seen.has(anchor.id)) continue;
				seen.add(anchor.id);
				ids.push(anchor.id);
			}
			return ids;
		};
		const initial = mode.chatContainer.renderWithViewportAnchors(80).anchors;
		const initialUserIds = orderedOccurrenceIds(initial, "user:");
		const initialAssistantIds = orderedOccurrenceIds(initial, "assistant:");
		expect(initialUserIds).toHaveLength(2);
		expect(initialAssistantIds).toHaveLength(2);

		mode.chatContainer.clear();
		const insertedUser = { ...userMessages[0] };
		const rebuiltUserA = { ...userMessages[0] };
		const rebuiltUserB = { ...userMessages[1] };
		const rebuiltAssistantA = assistantMessage();
		const rebuiltAssistantB = assistantMessage();
		associateSessionMessageEntryId(insertedUser, "user-inserted");
		associateSessionMessageEntryId(rebuiltUserA, "user-a");
		associateSessionMessageEntryId(rebuiltUserB, "user-b");
		associateSessionMessageEntryId(rebuiltAssistantA, "assistant-a");
		associateSessionMessageEntryId(rebuiltAssistantB, "assistant-b");
		mode.renderSessionContext({
			messages: [insertedUser, rebuiltUserA, rebuiltUserB, rebuiltAssistantA, rebuiltAssistantB],
		} as unknown as SessionContext);
		const inserted = mode.chatContainer.renderWithViewportAnchors(80).anchors;
		expect(orderedOccurrenceIds(inserted, "user:")).toEqual(["user:entry:user-inserted", ...initialUserIds]);
		expect(orderedOccurrenceIds(inserted, "assistant:")).toEqual(initialAssistantIds);

		mode.chatContainer.clear();
		mode.renderSessionContext({
			messages: [rebuiltUserA, rebuiltUserB, rebuiltAssistantA, rebuiltAssistantB],
		} as unknown as SessionContext);
		const afterDeletion = mode.chatContainer.renderWithViewportAnchors(80).anchors;
		expect(orderedOccurrenceIds(afterDeletion, "user:")).toEqual(initialUserIds);
		expect(orderedOccurrenceIds(afterDeletion, "assistant:")).toEqual(initialAssistantIds);
	});

	it("preserves a live assistant anchor ID after persistence and transcript rebuild", () => {
		const liveMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "live then persisted" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "same-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 77,
		};
		const liveId = mode.getAssistantViewportAnchorId(liveMessage);
		expect(liveId).toContain(":occurrence:");
		mode.addMessageToChat(liveMessage);
		expect(
			mode.chatContainer
				.renderWithViewportAnchors(80)
				.anchors.some(anchor => anchor?.id === `${liveId}:content:0:text`),
		).toBe(true);

		session.sessionManager.appendMessage(liveMessage);
		const rebuiltContext = session.sessionManager.buildSessionContext();
		const rebuiltMessage = rebuiltContext.messages.find(message => message.role === "assistant");
		if (rebuiltMessage?.role !== "assistant") throw new Error("Expected rebuilt assistant message");
		expect(rebuiltMessage).not.toBe(liveMessage);
		expect(mode.getAssistantViewportAnchorId(rebuiltMessage)).toBe(liveId);

		mode.chatContainer.clear();
		mode.renderSessionContext(rebuiltContext);
		expect(
			mode.chatContainer
				.renderWithViewportAnchors(80)
				.anchors.some(anchor => anchor?.id === `${liveId}:content:0:text`),
		).toBe(true);
	});
	function expectedNewlineShortcutHint(): string {
		const shortcut = process.platform === "win32" ? "Alt+Enter/Ctrl+J" : "Shift+Enter/Ctrl+J";
		return `${shortcut}: New line`;
	}

	it("keeps the composer right border inside a trailing gutter for CJK input", () => {
		mode.editor.focused = true;
		mode.editor.setText("이전 커밋들");

		const lines = mode.editor.render(48).map(stripRenderControls);
		const promptLine = lines.find(line => line.includes("이전 커밋들"));

		expect(promptLine).toBeDefined();
		expect(lines.every(line => visibleWidth(line) === 48)).toBe(true);
		expect(lines.every(line => line.endsWith(" "))).toBe(true);
		expect(promptLine!.trimEnd()).toEndWith("│");
		expect(promptLine!).toContain("이전 커밋들");
	});

	function expectedQueueShortcutHint(): string {
		const shortcut = process.platform === "win32" || process.platform === "darwin" ? "Alt+Q" : "Alt+Enter";
		return `${shortcut}: Queue`;
	}

	it("shows busy steering and queueing hints only while work is active", () => {
		let rendered = mode.editor.render(160).map(stripRenderControls).join("\n");
		expect(rendered).toContain("Type your message...");
		expect(rendered).toContain(expectedNewlineShortcutHint());
		expect(rendered).toContain("Ctrl+C: Clear");
		expect(rendered).toContain("Ctrl+R: Search history");
		expect(rendered).toContain("Shift+Tab: Reasoning");
		expect(rendered).not.toContain("Enter: Steer");
		expect(rendered).not.toContain(expectedQueueShortcutHint());

		(session.agent as unknown as { state: { isStreaming: boolean } }).state.isStreaming = true;
		mode.updateEditorChrome();

		rendered = mode.editor.render(160).map(stripRenderControls).join("\n");
		expect(rendered).toContain("Type your message...");
		expect(rendered).toContain("Enter: Steer");
		expect(rendered).toContain(expectedQueueShortcutHint());

		(session.agent as unknown as { state: { isStreaming: boolean } }).state.isStreaming = false;
		mode.updateEditorChrome();

		rendered = mode.editor.render(160).map(stripRenderControls).join("\n");
		expect(rendered).toContain("Type your message...");
		expect(rendered).not.toContain("Enter: Steer");
		expect(rendered).not.toContain(expectedQueueShortcutHint());
	});

	it("renders the composer directly below the status line without hook widgets", async () => {
		vi.spyOn(mode.ui, "start").mockImplementation(() => {});

		await mode.init();

		const assertComposerFollowsStatusLine = () => {
			const rendered = mode.ui.render(48).map(stripRenderControls);
			const composerContentIndex = rendered.findIndex(line => line.includes("Type your message..."));
			const composerIndex = composerContentIndex - 1;
			const statusRows = mode.statusLine.render(48).map(stripRenderControls);

			expect(composerIndex).toBeGreaterThan(0);
			expect(rendered.slice(composerIndex - statusRows.length, composerIndex)).toEqual(statusRows);
		};

		assertComposerFollowsStatusLine();

		mode.setHookWidget("test", ["temporary widget"]);
		mode.setHookWidget("test", undefined);

		assertComposerFollowsStatusLine();
	});

	it("keeps the welcome splash viewport-bound when /new shows a notification", async () => {
		const width = 100;
		const rows = 28;
		vi.spyOn(mode.ui, "start").mockImplementation(() => {});
		forceTerminalSize(mode, width, rows);

		await mode.init();

		mode.chatContainer.clear();
		mode.chatContainer.addChild(
			new Text(`${theme.fg("accent", `${theme.status.success} New session started`)}`, 1, 0),
		);

		const rendered = mode.ui.render(width).map(stripRenderControls);
		const renderedText = rendered.join("\n");
		const noticeIndex = rendered.findIndex(line => line.includes("New session started"));
		expect(rendered.length).toBeLessThanOrEqual(rows);
		expect(renderedText).toContain("GJC Forge");
		expect(noticeIndex).toBeGreaterThan(0);
		expect(rendered[noticeIndex - 1]?.trim()).not.toBe("");
		expect(renderedText).toContain("New session started");
	});

	it("keeps closed rounded composer chrome for one-line, multiline, and narrow prompts", () => {
		for (const [width, text] of [
			[48, "Ask gjc to improve the composer"],
			[48, "first line\nsecond line"],
			[28, "narrow terminal composer"],
		] as const) {
			mode.editor.setText(text);
			const lines = mode.editor.render(width).map(stripRenderControls);

			expect(lines.every(line => visibleWidth(line) === width)).toBe(true);
			expect(lines.every(line => line.endsWith(" "))).toBe(true);
			expect(lines[0].trimEnd()).toStartWith("╭");
			expect(lines[0].trimEnd()).toEndWith("╮");
			expect(lines.at(-1)!.trimEnd()).toStartWith("╰");
			expect(lines.at(-1)!.trimEnd()).toEndWith("╯");
			expect(lines.some(line => line.startsWith("│") && line.includes(">") && line.trimEnd().endsWith("│"))).toBe(
				true,
			);
			expect(lines.join("\n")).not.toContain("Type your message...");
		}
	});

	it("keeps the default prompt prefix while reflecting shell modes in border color", () => {
		mode.editor.setText("!!pwd");
		mode.isBashMode = true;
		mode.isBashNoContext = true;

		mode.updateEditorChrome();

		expect(mode.editor.borderColor("x")).toBe(theme.fg("warning", "x"));
		let lines = mode.editor.render(48).map(stripRenderControls);
		expect(
			lines.some(
				line =>
					line.startsWith("│") &&
					line.includes("shell no-context") &&
					line.includes(">") &&
					line.includes("!!pwd"),
			),
		).toBe(true);

		mode.isBashNoContext = false;
		mode.updateEditorChrome();

		expect(mode.editor.borderColor("x")).toBe(theme.getBashModeBorderColor()("x"));
		lines = mode.editor.render(48).map(stripRenderControls);
		expect(lines.some(line => line.startsWith("│") && line.includes("shell") && line.includes("!!pwd"))).toBe(true);

		mode.isBashMode = false;
		mode.updateEditorChrome();

		lines = mode.editor.render(48).map(stripRenderControls);
		expect(lines.some(line => line.startsWith("│") && line.includes(">") && line.includes("!!pwd"))).toBe(true);
		expect(lines.join("\n")).not.toContain("shell");
	});

	it("replaces the editor and rebinds interactive handlers", () => {
		mode.editor.setText("draft prompt");
		const previousEditor = mode.editor;
		const refreshSpy = vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();

		mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));

		expect(mode.editor).toBeInstanceOf(TestModalEditor);
		expect(mode.editor).not.toBe(previousEditor);
		expect(mode.editor.getText()).toBe("draft prompt");
		expect(mode.editor.onSubmit).toBeDefined();
		expect(mode.editor.onEscape).toBeDefined();
		expect(refreshSpy).toHaveBeenCalled();
	});

	it("preserves a pending pet mode across editor replacement", () => {
		const originalProtocol = TERMINAL.imageProtocol;
		vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
		try {
			setTerminalImageProtocol(null);
			settings.set("pet.mode", "red");
			mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
			expect(mode.petWidget?.mode).toBe("off");

			mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
			expect(mode.petWidget?.mode).toBe("off");

			expect(settings.get("pet.mode")).toBe("red");
			setTerminalImageProtocol(ImageProtocol.Sixel);
			mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
			expect(mode.petWidget?.mode).toBe("red");
		} finally {
			setTerminalImageProtocol(originalProtocol);
		}
	});

	it("disposes a pre-init pet widget before init replaces it", async () => {
		const originalProtocol = TERMINAL.imageProtocol;
		vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
		try {
			setTerminalImageProtocol(null);
			settings.set("pet.mode", "red");
			mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
			const preInitWidget = mode.petWidget;
			if (!preInitWidget) throw new Error("Expected pre-init pet widget");
			const dispose = vi.spyOn(preInitWidget, "dispose");

			await mode.init();

			expect(dispose).toHaveBeenCalledTimes(1);
			expect(mode.petWidget).not.toBe(preInitWidget);
			expect(mode.petWidget?.mode).toBe("off");

			setTerminalImageProtocol(ImageProtocol.Sixel);
			expect(mode.petWidget?.mode).toBe("red");
		} finally {
			setTerminalImageProtocol(originalProtocol);
		}
	});

	it("commits pet modes through the shared result-returning policy", () => {
		const originalProtocol = TERMINAL.imageProtocol;
		vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
		try {
			settings.set("pet.mode", "off");
			const showStatus = vi.spyOn(mode, "showStatus").mockImplementation(() => {});

			// Capability is rechecked immediately before mutation: a rejected
			// commit surfaces the warning and never persists.
			setTerminalImageProtocol(null);
			expect(mode.setPetMode("red")).toBe(false);
			expect(settings.get("pet.mode")).toBe("off");
			expect(mode.petWidget?.mode ?? "off").toBe("off");
			expect(showStatus).toHaveBeenCalledTimes(1);

			expect(mode.commitPetPreviewMode("red")).toBe(false);
			expect(settings.get("pet.mode")).toBe("off");
			expect(showStatus).toHaveBeenCalledTimes(2);

			// An accepted commit persists only after the widget mutation applies.
			setTerminalImageProtocol(ImageProtocol.Sixel);
			mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
			expect(mode.setPetMode("red")).toBe(true);
			expect(settings.get("pet.mode")).toBe("red");
			expect(mode.commitPetPreviewMode("off")).toBe(true);
			expect(settings.get("pet.mode")).toBe("off");
		} finally {
			setTerminalImageProtocol(originalProtocol);
		}
	});
});
