import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { formatKeyHint, formatKeyHints, type KeyDisplayContext } from "@gajae-code/coding-agent/config/keybindings";
import { resetSettingsForTest, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import {
	PET_CAPABILITY_SETTLE_MS,
	setVerifiedItermPetAvailability,
} from "@gajae-code/coding-agent/modes/components/pet-capability";
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
import { AssistantMessageComponent } from "../src/modes/components/assistant-message";
import { CustomEditor } from "../src/modes/components/custom-editor";
import { computeIrcWorkLaneWidths, IrcSplitViewComponent } from "../src/modes/components/irc-sidebar";
import { resolveWelcomeIntroTickMs, WelcomeComponent } from "../src/modes/components/welcome";
import { ExtensionUiController } from "../src/modes/controllers/extension-ui-controller";
import { SelectorController } from "../src/modes/controllers/selector-controller";
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

const injectedKeyDisplayContext: KeyDisplayContext = {
	platform: process.platform === "darwin" ? "win32" : "darwin",
};

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
		authStorage = await AuthStorage.create(":memory:");
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
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			injectedKeyDisplayContext,
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		resetSettingsForTest();
		await tempDir?.remove();
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
			configuredModelChains: {},
			injectedTtsrRules: [],
			selectedMCPToolNames: [],
			hasPersistedMCPToolSelection: false,
			mode: "none",
		});
		expect(reconcile).toHaveBeenCalledTimes(1);
	});

	it("preserves a live assistant through the tree-navigation initial rebuild path", () => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "live before tree navigation" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const component = new AssistantMessageComponent(message);
		const dispose = vi.spyOn(component, "dispose");
		mode.streamingMessage = message;
		mode.streamingComponent = component;
		mode.chatContainer.addChild(component);

		mode.rebuildInitialMessages("reconcile-same-transcript", {
			messages: [],
			thinkingLevel: "off",
			serviceTier: undefined,
			models: {},
			configuredModelChains: {},
			injectedTtsrRules: [],
			selectedMCPToolNames: [],
			hasPersistedMCPToolSelection: false,
			mode: "none",
		});

		expect(dispose).not.toHaveBeenCalled();
		expect(mode.chatContainer.hasLiveChild(component)).toBe(true);
		expect(mode.streamingComponent).toBe(component);
		expect(mode.streamingMessage).toBe(message);
		component.updateContent(
			{ ...message, content: [{ type: "text", text: "live after tree navigation" }] },
			{ streaming: true },
		);
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("live after tree navigation");
	});

	it("rebuilds a committed orphan assistant from the session transcript", () => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "orphan survives later reconcile" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "aborted",
			errorMessage: "Operation aborted",
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		session.sessionManager.appendMessage(message);
		session.agent.appendMessage(message);

		mode.rebuildChatFromMessages("reconcile-same-transcript");

		const rendered = Bun.stripANSI(mode.chatContainer.render(100).join("\n"));
		expect(rendered).toContain("orphan survives later reconcile");
		expect(rendered).toContain("Operation aborted");
	});

	it("does not spend the iTerm pet warning deadline during pre-start initialization", async () => {
		const originalProtocol = TERMINAL.imageProtocol;
		const envKeys = [
			"TERM_PROGRAM",
			"TERM_PROGRAM_VERSION",
			"TERM",
			"TMUX",
			"TMUX_PANE",
			"STY",
			"ZELLIJ",
			"GJC_TMUX_LAUNCHED",
			"GJC_TMUX_ACTIVE_SESSION",
			"GJC_MANAGED_OWNER_RUN_ID",
		] as const;
		const originalEnv = new Map(envKeys.map(key => [key, Bun.env[key]] as const));
		vi.useFakeTimers();
		try {
			mode.stop();
			setVerifiedItermPetAvailability(undefined);
			setTerminalImageProtocol(null);
			for (const key of envKeys) delete Bun.env[key];
			Bun.env.TERM_PROGRAM = "iTerm.app";
			Bun.env.TERM_PROGRAM_VERSION = "3.6.11";
			Bun.env.TERM = "xterm-256color";
			settings.set("pet.mode", "red");
			settings.set("startup.quiet", true);
			mode = new InteractiveMode(session, "test");
			const showStatus = vi.spyOn(mode, "showStatus").mockImplementation(() => {});
			const startupOrder: string[] = [];
			vi.spyOn(session, "getTodoPhases").mockImplementation(() => {
				startupOrder.push("todos");
				vi.advanceTimersByTime(PET_CAPABILITY_SETTLE_MS);
				return [];
			});
			vi.spyOn(mode.ui, "start").mockImplementation(() => {
				startupOrder.push("ui.start");
			});

			await mode.init();

			expect(startupOrder).toEqual(["todos", "ui.start"]);
			expect(showStatus).not.toHaveBeenCalled();
			vi.advanceTimersByTime(PET_CAPABILITY_SETTLE_MS - 1);
			expect(showStatus).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(showStatus).not.toHaveBeenCalled();
		} finally {
			mode.stop();
			setVerifiedItermPetAvailability(undefined);
			setTerminalImageProtocol(originalProtocol);
			for (const key of envKeys) {
				const value = originalEnv.get(key);
				if (value === undefined) delete Bun.env[key];
				else Bun.env[key] = value;
			}
			vi.useRealTimers();
		}
	});

	it("shows the plain pet warning without a reason suffix on non-iTerm terminals", async () => {
		const originalProtocol = TERMINAL.imageProtocol;
		const envKeys = [
			"TERM_PROGRAM",
			"TERM_PROGRAM_VERSION",
			"TMUX",
			"TMUX_PANE",
			"STY",
			"ZELLIJ",
			"GJC_TMUX_LAUNCHED",
			"GJC_TMUX_ACTIVE_SESSION",
			"GJC_MANAGED_OWNER_RUN_ID",
		] as const;
		const originalEnv = new Map(envKeys.map(key => [key, Bun.env[key]] as const));
		vi.useFakeTimers();
		try {
			mode.stop();
			setVerifiedItermPetAvailability(undefined);
			setTerminalImageProtocol(null);
			for (const key of envKeys) delete Bun.env[key];
			Bun.env.TERM_PROGRAM = "vscode";
			Bun.env.TERM = "xterm-256color";
			settings.set("pet.mode", "red");
			settings.set("startup.quiet", true);
			mode = new InteractiveMode(session, "test");
			const showStatus = vi.spyOn(mode, "showStatus").mockImplementation(() => {});
			vi.spyOn(mode.ui, "start").mockImplementation(() => {});

			await mode.init();
			vi.advanceTimersByTime(PET_CAPABILITY_SETTLE_MS * 2);

			expect(showStatus).not.toHaveBeenCalled();

			showStatus.mockClear();
			expect(mode.setPetMode("red")).toBe(true);
			expect(showStatus).not.toHaveBeenCalled();
		} finally {
			mode.stop();
			setVerifiedItermPetAvailability(undefined);
			setTerminalImageProtocol(originalProtocol);
			for (const key of envKeys) {
				const value = originalEnv.get(key);
				if (value === undefined) delete Bun.env[key];
				else Bun.env[key] = value;
			}
			vi.useRealTimers();
		}
	});

	it("appends the concrete iTerm transport reason to the pet warning", async () => {
		const originalProtocol = TERMINAL.imageProtocol;
		const envKeys = [
			"TERM_PROGRAM",
			"TERM_PROGRAM_VERSION",
			"TMUX",
			"TMUX_PANE",
			"STY",
			"ZELLIJ",
			"GJC_TMUX_LAUNCHED",
			"GJC_TMUX_ACTIVE_SESSION",
			"GJC_MANAGED_OWNER_RUN_ID",
		] as const;
		const originalEnv = new Map(envKeys.map(key => [key, Bun.env[key]] as const));
		vi.useFakeTimers();
		try {
			mode.stop();
			setVerifiedItermPetAvailability(undefined);
			setTerminalImageProtocol(null);
			for (const key of envKeys) delete Bun.env[key];
			Bun.env.TERM_PROGRAM = "iTerm.app";
			Bun.env.TERM_PROGRAM_VERSION = "3.6.11";
			Bun.env.TERM = "xterm-256color";
			settings.set("pet.mode", "red");
			settings.set("startup.quiet", true);
			mode = new InteractiveMode(session, "test");
			const showStatus = vi.spyOn(mode, "showStatus").mockImplementation(() => {});
			vi.spyOn(mode.ui, "start").mockImplementation(() => {});

			await mode.init();
			setVerifiedItermPetAvailability({ available: false, mode: "direct", reason: "probe-timeout", epoch: 1 });
			vi.advanceTimersByTime(PET_CAPABILITY_SETTLE_MS * 2);

			expect(showStatus).not.toHaveBeenCalled();

			showStatus.mockClear();
			expect(mode.setPetMode("red")).toBe(true);
			expect(showStatus).not.toHaveBeenCalled();
		} finally {
			mode.stop();
			setVerifiedItermPetAvailability(undefined);
			setTerminalImageProtocol(originalProtocol);
			for (const key of envKeys) {
				const value = originalEnv.get(key);
				if (value === undefined) delete Bun.env[key];
				else Bun.env[key] = value;
			}
			vi.useRealTimers();
		}
	});

	it("reports output revision changes while chrome-only editor reflow reports no output mutation", async () => {
		await mode.init();
		const report = vi.spyOn(mode.ui, "setViewportOutputSource");

		mode.recordVisibleTranscriptMutation();
		expect(report).toHaveBeenCalledTimes(1);
		expect(report.mock.calls[0]?.[0]).toMatchObject({ revision: 1n });

		report.mockClear();
		mode.editor.setText("draft that changes editor chrome only");
		mode.updateEditorChrome();
		expect(report).not.toHaveBeenCalled();
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

	it("preserves requested IRC visibility across the exact width boundary round trip", async () => {
		vi.spyOn(mode.ui, "start").mockImplementation(() => {});
		await mode.init();
		mode.settings.set("irc.enabled", true);
		mode.settings.set("irc.sidebar.enabled", true);
		mode.applyIrcSidebarAvailability(true);
		mode.toggleIrcSidebar();
		mode.addMessageToChat({ role: "user", content: "anchored transcript", timestamp: 1 });

		const split = mode.ui.children.find(component => component instanceof IrcSplitViewComponent);
		if (!(split instanceof IrcSplitViewComponent)) throw new Error("Expected IRC split in the production root");
		for (const columns of [64, 65, 80, 120, 160, 120, 80, 65, 64]) {
			forceTerminalSize(mode, columns, 24);
			const arrival = mode.captureIrcArrivalSnapshot();
			const layout = computeIrcWorkLaneWidths(columns, arrival.panelVisible);
			const rendered = mode.ui.render(columns).map(stripRenderControls);
			const splitLines = split.render(columns).map(stripRenderControls);
			expect(arrival.panelRequestedVisible).toBe(true);
			expect(arrival.panelVisible).toBe(columns >= 65);
			expect(layout.leftWidth + layout.separatorWidth + layout.rightWidth).toBe(columns);
			expect(layout.separatorWidth === 3).toBe(columns >= 65);
			expect(splitLines.some(line => line.includes(theme.boxSharp.vertical))).toBe(columns >= 65);
			expect(rendered.every(line => visibleWidth(line) <= columns)).toBe(true);
		}
	});
	it("keeps todos in the transcript lane without changing the production root order", async () => {
		await mode.init();
		mode.settings.set("irc.enabled", true);
		mode.settings.set("irc.sidebar.enabled", true);
		mode.applyIrcSidebarAvailability(true);
		mode.toggleIrcSidebar();
		mode.setTodos([{ content: "A long todo that must not occupy IRC cells", status: "in_progress" }]);

		const root = mode.ui.children;
		const splitIndex = root.findIndex(component => component instanceof IrcSplitViewComponent);
		expect(root.slice(splitIndex, splitIndex + 10)).toEqual([
			root[splitIndex],
			mode.pendingMessagesContainer,
			mode.statusContainer,
			mode.todoContainer,
			mode.btwContainer,
			mode.statusLine,
			mode.hookWidgetContainerAbove,
			mode.editorContainer,
			mode.petFloorContainer,
			mode.hookWidgetContainerBelow,
		]);
		expect(mode.todoContainer.render(65).every(line => visibleWidth(line) <= 32)).toBe(true);

		forceTerminalSize(mode, 64, 24);
		expect(mode.todoContainer.render(64).some(line => visibleWidth(line) > 32)).toBe(true);
		forceTerminalSize(mode, 80, 24);
		expect(mode.todoContainer.render(80).every(line => visibleWidth(line) <= 47)).toBe(true);
	});
	it("expands the todo HUD from the collapsed five-task view and back", async () => {
		await mode.init();
		const tasks = Array.from({ length: 7 }, (_, index) => ({
			content: `task-${index + 1}`,
			status: index === 0 ? ("in_progress" as const) : ("pending" as const),
		}));
		mode.setTodos(tasks);

		const collapsed = mode.todoContainer.render(80).map(stripRenderControls).join("\n");
		expect(mode.todoExpanded).toBe(false);
		expect(collapsed).toContain("task-5");
		// Tasks past the collapsed cap are hidden behind a summary row.
		expect(collapsed).not.toContain("task-6");
		expect(collapsed).not.toContain("task-7");
		expect(collapsed).toMatch(/\+\s*2\s+more/);

		mode.toggleTodoExpansion();

		const expanded = mode.todoContainer.render(80).map(stripRenderControls).join("\n");
		expect(mode.todoExpanded).toBe(true);
		for (const task of tasks) expect(expanded).toContain(task.content);
		expect(expanded).not.toMatch(/\+\s*\d+\s+more/);

		mode.toggleTodoExpansion();

		const recollapsed = mode.todoContainer.render(80).map(stripRenderControls).join("\n");
		expect(mode.todoExpanded).toBe(false);
		expect(recollapsed).not.toContain("task-7");
		expect(recollapsed).toMatch(/\+\s*2\s+more/);
	});

	it("forwards startup.skipLogoAnimation through the real settings path", async () => {
		// `init()` schedules unrelated timers (pet capability settle, etc.), so a
		// global timer count proves nothing. Record interval delays instead and
		// A/B the two settings values in one test so the intro tick is the only
		// difference between them.
		const introTick = resolveWelcomeIntroTickMs(process.platform, Bun.env.TERM_PROGRAM_VERSION ?? "");
		const originalSetInterval = globalThis.setInterval;
		const delays: number[] = [];
		globalThis.setInterval = ((handler: () => void, delay?: number, ...args: unknown[]) => {
			delays.push(Number(delay));
			return Reflect.apply(originalSetInterval, globalThis, [handler, delay, ...args]);
		}) as typeof globalThis.setInterval;

		const makeMode = () =>
			new InteractiveMode(
				session,
				"test",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				injectedKeyDisplayContext,
			);
		const skipped = makeMode();
		const animated = makeMode();
		try {
			settings.set("startup.quiet", false);
			settings.set("startup.skipLogoAnimation", true);
			vi.spyOn(skipped.ui, "start").mockImplementation(() => {});
			await skipped.init();

			const welcome = skipped.ui.children.find(child => child instanceof WelcomeComponent);
			expect(welcome).toBeInstanceOf(WelcomeComponent);
			// Resting content still renders: this is not startup.quiet.
			expect(welcome?.render(120).length).toBeGreaterThan(0);
			expect(delays).not.toContain(introTick);

			// Mutating the setting after init() is inert: it is read once at startup.
			settings.set("startup.skipLogoAnimation", false);
			expect(delays).not.toContain(introTick);

			// Positive control on the same instrument: the default value animates.
			delays.length = 0;
			vi.spyOn(animated.ui, "start").mockImplementation(() => {});
			await animated.init();

			expect(animated.ui.children.some(child => child instanceof WelcomeComponent)).toBe(true);
			expect(delays).toContain(introTick);
		} finally {
			globalThis.setInterval = originalSetInterval;
			skipped.stop();
			animated.stop();
		}
	});

	it("still renders no welcome surface at all under startup.quiet regardless of the motion flag", async () => {
		settings.set("startup.quiet", true);
		settings.set("startup.skipLogoAnimation", false);
		try {
			vi.spyOn(mode.ui, "start").mockImplementation(() => {});
			await mode.init();

			expect(mode.ui.children.some(child => child instanceof WelcomeComponent)).toBe(false);
		} finally {
			mode.stop();
		}
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
		const newlineKeys =
			injectedKeyDisplayContext.platform === "win32" ? ["alt+enter", "ctrl+j"] : ["shift+enter", "ctrl+j"];
		return `${formatKeyHints(newlineKeys, injectedKeyDisplayContext)}: New line`;
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

	function expectedQueueShortcutHint(action = "Queue"): string {
		const shortcut = mode.keybindings.getKeys("app.message.queue")[0];
		if (!shortcut) throw new Error("Expected a queue message keybinding");
		return `${formatKeyHint(shortcut, injectedKeyDisplayContext)}: ${action}`;
	}
	function expectedSubmitShortcutHint(action = "Steer"): string {
		const shortcut = mode.keybindings.getDisplayString("tui.input.submit", injectedKeyDisplayContext);
		if (!shortcut) throw new Error("Expected a submit keybinding");
		return `${shortcut}: ${action}`;
	}

	it("keeps common shortcut discovery in the composer and shows actionable busy delivery hints", () => {
		let rendered = mode.editor.render(300).map(stripRenderControls).join("\n");
		expect(rendered).toContain("Type your message...");
		expect(rendered).toContain(expectedNewlineShortcutHint());
		expect(rendered).toContain(`${formatKeyHint("ctrl+c", injectedKeyDisplayContext)}: Clear`);
		expect(rendered).toContain(`${formatKeyHint("ctrl+r", injectedKeyDisplayContext)}: History`);
		expect(rendered).toContain(`${formatKeyHint("shift+tab", injectedKeyDisplayContext)}: Thinking`);
		expect(rendered).not.toContain(expectedSubmitShortcutHint());
		expect(rendered).toContain(expectedQueueShortcutHint("Queue (busy)"));
		const narrowRendered = mode.editor.render(80).map(stripRenderControls).join("\n");
		expect(narrowRendered).toContain(expectedQueueShortcutHint("Queue (busy)"));

		(session.agent as unknown as { state: { isStreaming: boolean } }).state.isStreaming = true;
		mode.updateEditorChrome();

		rendered = mode.editor.render(300).map(stripRenderControls).join("\n");
		expect(rendered).toContain("Type your message...");
		expect(rendered).toContain(expectedSubmitShortcutHint());
		expect(rendered).toContain(expectedQueueShortcutHint());

		(session.agent as unknown as { state: { isStreaming: boolean } }).state.isStreaming = false;
		mode.updateEditorChrome();

		rendered = mode.editor.render(300).map(stripRenderControls).join("\n");
		expect(rendered).toContain("Type your message...");
		expect(rendered).not.toContain(expectedSubmitShortcutHint());
		expect(rendered).toContain(expectedQueueShortcutHint("Queue (busy)"));
	});
	it("applies the public shortcut-hint setting through the live composer side-effect path", () => {
		const controller = new SelectorController(mode);
		mode.settings.set("statusLine.showActionHints", false);
		controller.handleSettingChange("statusLine.showActionHints", false);

		let rendered = mode.editor.render(300).map(stripRenderControls).join("\n");
		expect(rendered).toContain("Type your message...");
		expect(rendered).not.toContain(expectedQueueShortcutHint("Queue (busy)"));
		expect(rendered).not.toContain(expectedNewlineShortcutHint());

		mode.settings.set("statusLine.showActionHints", true);
		controller.handleSettingChange("statusLine.showActionHints", true);

		rendered = mode.editor.render(300).map(stripRenderControls).join("\n");
		expect(rendered).toContain(expectedQueueShortcutHint("Queue (busy)"));
		expect(rendered).toContain(expectedNewlineShortcutHint());
	});
	it("keeps adjacent status-line settings on the live status update path", () => {
		const updateSettings = vi.spyOn(mode.statusLine, "updateSettings");
		const updateEditorTopBorder = vi.spyOn(mode, "updateEditorTopBorder");
		const controller = new SelectorController(mode);

		mode.settings.set("statusLine.separator", "pipe");
		controller.handleSettingChange("statusLine.separator", "pipe");

		expect(updateSettings).toHaveBeenCalledTimes(1);
		expect(updateEditorTopBorder).toHaveBeenCalledTimes(1);
	});
	it("uses the effective submit binding in busy hints and omits it when unbound", () => {
		(session.agent as unknown as { state: { isStreaming: boolean } }).state.isStreaming = true;
		mode.keybindings.setUserBindings({ "tui.input.submit": "ctrl+enter" });
		mode.updateEditorChrome();

		let rendered = mode.editor.render(300).map(stripRenderControls).join("\n");
		const remappedSubmit = mode.keybindings.getDisplayString("tui.input.submit", injectedKeyDisplayContext);
		expect(rendered).toContain(`${remappedSubmit}: Steer`);
		expect(rendered).toContain(expectedQueueShortcutHint());

		mode.keybindings.setUserBindings({
			"tui.input.submit": [],
			"app.message.queue": [],
			"app.message.followUp": [],
		});
		mode.updateEditorChrome();

		rendered = mode.editor.render(300).map(stripRenderControls).join("\n");
		expect(rendered).not.toContain(": Steer");
		expect(rendered).toContain(`${formatKeyHint("shift+tab", injectedKeyDisplayContext)}: Thinking`);
		expect(rendered).not.toContain(": Queue");
		expect(rendered).toContain("Type your message...");
	});
	it("propagates the injected non-host key display context to the composed TUI surfaces", async () => {
		vi.spyOn(mode.ui, "start").mockImplementation(() => {});
		forceTerminalSize(mode, 160, 40);
		await mode.init();

		const composer = mode.editor.render(300).map(stripRenderControls).join("\n");
		const welcome = mode.ui.render(160).map(stripRenderControls).join("\n");
		expect(composer).toContain(expectedNewlineShortcutHint());
		expect(composer).toContain(mode.keybindings.getDisplayString("app.model.select", injectedKeyDisplayContext));
		expect(welcome).toContain(`${formatKeyHint("ctrl+c", injectedKeyDisplayContext)} clear`);

		mode.statusLine.setActionRegistry(
			{
				all: () => [{ id: "app.model.select", title: "Select model", domains: ["composer"] }],
				isAvailable: () => true,
			} as never,
			() => mode.keybindings,
		);
		const status = mode.statusLine.render(500).map(stripRenderControls).join("\n");
		expect(status).not.toContain(mode.keybindings.getDisplayString("app.model.select", injectedKeyDisplayContext));
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

	it("keeps the focused composer visible at constrained terminal height", async () => {
		vi.spyOn(mode.ui, "start").mockImplementation(() => {});
		forceTerminalSize(mode, 48, 3);
		await mode.init();
		mode.editor.focused = true;
		mode.editor.setText("keep this focused draft visible");

		const rendered = mode.ui.render(48).map(stripRenderControls);
		expect(rendered.join("\n")).toContain("keep this focused draft visible");
		expect(rendered.some(line => line.trimEnd().startsWith("╭"))).toBe(true);
		expect(rendered.some(line => line.trimEnd().endsWith("╯"))).toBe(true);
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

	it("invalidates the restored composer after cancelling another action", () => {
		const invalidate = vi.spyOn(mode.editor, "invalidate");
		const requestRender = vi.spyOn(mode.ui, "requestRender");

		mode.restoreComposer();

		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalled();
	});

	it("preserves a pending pet mode across editor replacement", () => {
		const originalProtocol = TERMINAL.imageProtocol;
		vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
		try {
			setTerminalImageProtocol(null);
			settings.set("pet.mode", "red");
			mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
			expect(mode.petWidget?.mode).toBe("red");

			mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
			expect(mode.petWidget?.mode).toBe("red");

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
			expect(mode.petWidget?.mode).toBe("red");

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

			// Text cells make the pet reachable even without an image protocol.
			setTerminalImageProtocol(null);
			expect(mode.setPetMode("red")).toBe(true);
			expect(settings.get("pet.mode")).toBe("red");
			expect(mode.petWidget?.mode ?? "off").toBe("off");
			expect(showStatus).not.toHaveBeenCalled();

			expect(mode.commitPetPreviewMode("red")).toBe(true);
			expect(settings.get("pet.mode")).toBe("red");
			expect(showStatus).not.toHaveBeenCalled();

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
