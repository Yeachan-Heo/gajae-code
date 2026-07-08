/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Agent, type AgentMessage, type AgentToolResult, ThinkingLevel } from "@gajae-code/agent-core";
import type { CompactionOutcome } from "@gajae-code/agent-core/compaction";
import {
	type AssistantMessage,
	type ImageContent,
	type Message,
	type Model,
	modelsAreEqual,
	type UsageReport,
} from "@gajae-code/ai";
import type { Component, EditorTheme, SlashCommand } from "@gajae-code/tui";
import {
	Container,
	clearRenderCache,
	Loader,
	Markdown,
	ProcessTerminal,
	Spacer,
	Text,
	TUI,
	visibleWidth,
} from "@gajae-code/tui";
import { APP_NAME, adjustHsv, getProjectDir, hsvToRgb, isEnoent, logger, postmortem, prompt } from "@gajae-code/utils";
import chalk from "chalk";
import { AsyncJobManager } from "../async";
import { type AppKeybinding, KeybindingsManager } from "../config/keybindings";
import { isSettingsInitialized, type Settings, settings } from "../config/settings";
import { DEFAULT_GJC_DEFINITION_NAMES } from "../defaults/gjc-defaults";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
} from "../extensibility/extensions";
import type { CompactOptions } from "../extensibility/extensions/types";
import { resolveSkillSlashCommands, type Skill } from "../extensibility/skills";
import { BUILTIN_SLASH_COMMANDS, loadSlashCommands } from "../extensibility/slash-commands";
import { consumePendingGoalModeRequest } from "../gjc-runtime/goal-mode-request";
import { type Goal, type GoalModeState, normalizeGoal } from "../goals/state";
import { resolveLocalUrlToPath } from "../internal-urls";
import { getLspStartupWarningMessage, LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "../lsp/startup-events";
import {
	humanizePlanTitle,
	type PlanApprovalDetails,
	renameApprovedPlanFile,
	resolvePlanTitle,
} from "../plan-mode/approved-plan";
import planModeApprovedPrompt from "../prompts/system/plan-mode-approved.md" with { type: "text" };
import planModeCompactInstructionsPrompt from "../prompts/system/plan-mode-compact-instructions.md" with {
	type: "text",
};
import {
	createStarReminderBeforeAgentStartContributor,
	scheduleLaunchStarReminderAfterFirstRender,
	starReminderLaunchGate,
} from "../reminders/star-reminder";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { HistoryStorage } from "../session/history-storage";
import type { SessionContext, SessionManager } from "../session/session-manager";
import { getRecentSessions } from "../session/session-manager";
import { formatDuration } from "../slash-commands/helpers/format";
import { STTController, type SttState } from "../stt";
import type { LspStartupServerInfo } from "../tools";
import { normalizeLocalScheme } from "../tools/path-utils";
import { type ResolveToolDetails, runResolveInvocation } from "../tools/resolve";
import { formatPhaseDisplayName } from "../tools/todo-write";
import { ToolError } from "../tools/tool-errors";
import type { EventBus } from "../utils/event-bus";
import { getEditorCommand, openInEditor } from "../utils/external-editor";
import { getSessionAccentAnsi, getSessionAccentHex } from "../utils/session-color";
import { popTerminalTitle, pushTerminalTitle, setSessionTerminalTitle } from "../utils/title-generator";
import type { AssistantMessageComponent } from "./components/assistant-message";
import type { BashExecutionComponent } from "./components/bash-execution";
import { CustomEditor } from "./components/custom-editor";
import { DynamicBorder } from "./components/dynamic-border";
import type { EvalExecutionComponent } from "./components/eval-execution";
import type { HookEditorComponent } from "./components/hook-editor";
import type { HookInputComponent } from "./components/hook-input";
import type { HookSelectorComponent } from "./components/hook-selector";
import { StatusLineComponent } from "./components/status-line";
import type { ToolExecutionHandle } from "./components/tool-execution";
import {
	WelcomeComponent,
	type WelcomeLogoMode,
	type LspServerInfo as WelcomeLspServerInfo,
} from "./components/welcome";
import { BtwController } from "./controllers/btw-controller";
import { CommandController } from "./controllers/command-controller";
import { EventController } from "./controllers/event-controller";
import { ExtensionUiController } from "./controllers/extension-ui-controller";
import { InputController } from "./controllers/input-controller";
import { SelectorController } from "./controllers/selector-controller";
import { SSHCommandController } from "./controllers/ssh-command-controller";
import { TodoCommandController } from "./controllers/todo-command-controller";
import { JobsObserver } from "./jobs-observer";
import { OAuthManualInputManager } from "./oauth-manual-input";
import { SessionObserverRegistry } from "./session-observer-registry";
import { interruptHint } from "./shared";
import { shouldShowExtensionCommand } from "./slash-command-visibility";
import { type ShimmerPalette, shimmerSegments, shimmerText } from "./theme/shimmer";
import type { Theme } from "./theme/theme";
import {
	getEditorTheme,
	getMarkdownTheme,
	getSymbolTheme,
	onTerminalAppearanceChange,
	onThemeChange,
	theme,
} from "./theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext, SubmittedUserInput, TodoItem, TodoPhase } from "./types";
import { UiHelpers } from "./utils/ui-helpers";

const INTERACTIVE_ABORT_CLEANUP_TIMEOUT_MS = 5_000;
const COMPOSER_NEWLINE_HINT = process.platform === "win32" ? "Alt+Enter/Ctrl+J" : "Shift+Enter/Ctrl+J";
export const DEFAULT_COMPOSER_PLACEHOLDER = `Type your message... ${COMPOSER_NEWLINE_HINT}: New line · Ctrl+C: Clear · Ctrl+R: Search history · Shift+Tab: Reasoning`;
const WELCOME_RESERVED_CONTAINER_CHILD_LIMIT = 8;
const FRIENDLY_KEY_PARTS: Record<string, string> = {
	alt: "Alt",
	cmd: "Cmd",
	command: "Cmd",
	ctrl: "Ctrl",
	enter: "Enter",
	meta: process.platform === "darwin" ? "Command" : "Meta",
	option: "Option",
	shift: "Shift",
};

function formatShortcutForPlaceholder(key: string): string {
	return key
		.split("+")
		.map(part => FRIENDLY_KEY_PARTS[part.toLowerCase()] ?? (part.length === 1 ? part.toUpperCase() : part))
		.join("+");
}

const HINT_SHIMMER_PALETTE: ShimmerPalette = {
	low: "dim",
	mid: "muted",
	high: "borderAccent",
};

function getDefaultInputPrefix(): string {
	return `${theme.fg("accent", ">")} `;
}

function getShellInputPrefix(isNoContext: boolean): string {
	const shellLabel = isNoContext
		? theme.fg("warning", theme.bold("shell no-context"))
		: theme.fg("bashMode", theme.bold("shell"));
	return `${shellLabel} ${getDefaultInputPrefix()}`;
}

function configureDefaultComposerChrome(editor: CustomEditor): void {
	editor.setBorderVisible(true);
	editor.setBorderStyle("round");
	editor.setClosedBorderBox(true);
	editor.setPromptGutter(undefined);
	editor.setInputPrefix(getDefaultInputPrefix());
	editor.setPlaceholder(DEFAULT_COMPOSER_PLACEHOLDER);
	editor.setPaddingX(1);
	editor.setRightGutterWidth(1);
	editor.setTopBorder(undefined);
}

interface WorkingMessageAccent {
	main: string;
	dim: string;
}

function renderWorkingMessage(message: string, accent?: WorkingMessageAccent): string {
	const palette = accent
		? ({
				low: "dim",
				mid: { ansi: accent.main },
				high: { ansi: accent.main },
				bold: true,
			} satisfies ShimmerPalette)
		: undefined;
	const hint = interruptHint();
	if (!message.endsWith(hint)) return shimmerText(message, theme, palette);
	const header = message.slice(0, -hint.length);
	const hintPalette = accent
		? ({
				low: "dim",
				mid: { ansi: accent.dim },
				high: { ansi: accent.dim },
			} satisfies ShimmerPalette)
		: HINT_SHIMMER_PALETTE;
	return shimmerSegments(
		[
			{ text: header, palette },
			{ text: hint, palette: hintPalette },
		],
		theme,
	);
}

const EDITOR_MAX_HEIGHT_MIN = 6;
const EDITOR_MAX_HEIGHT_MAX = 18;
const EDITOR_RESERVED_ROWS = 12;
const EDITOR_FALLBACK_ROWS = 24;

const HUD_NOTE_SUP_DIGITS: Record<string, string> = {
	"0": "\u2070",
	"1": "\u00b9",
	"2": "\u00b2",
	"3": "\u00b3",
	"4": "\u2074",
	"5": "\u2075",
	"6": "\u2076",
	"7": "\u2077",
	"8": "\u2078",
	"9": "\u2079",
};

function formatHudNoteMarker(count: number): string {
	if (count <= 0) return "";
	const sub = String(count)
		.split("")
		.map(d => HUD_NOTE_SUP_DIGITS[d] ?? d)
		.join("");
	return theme.fg("dim", chalk.italic(` \u207a${sub}`));
}

type GoalSubcommand = "set" | "show" | "pause" | "resume" | "drop";

const GOAL_SUBCOMMANDS = new Set<GoalSubcommand>(["set", "show", "pause", "resume", "drop"]);

function parseGoalSubcommand(args: string): { sub: GoalSubcommand | undefined; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { sub: undefined, rest: "" };
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return { sub: undefined, rest: trimmed };
	const first = match[1].toLowerCase();
	if (GOAL_SUBCOMMANDS.has(first as GoalSubcommand)) {
		return { sub: first as GoalSubcommand, rest: match[2]?.trim() ?? "" };
	}
	return { sub: undefined, rest: trimmed };
}

export type WelcomeBannerSettingMode = "auto" | "unicode" | "square" | "ascii";

export function resolveWelcomeLogoMode(
	mode: WelcomeBannerSettingMode,
	env: Record<string, string | undefined> = Bun.env,
	platform: NodeJS.Platform = process.platform,
): WelcomeLogoMode {
	void env;
	void platform;
	if (mode === "unicode") return "unicode";
	if (mode === "square") return "square";
	if (mode === "ascii") return "ascii";
	return "unicode";
}

/** Options for creating an InteractiveMode instance (for future API use) */
export interface InteractiveModeOptions {
	/** Providers that were migrated during startup */
	migratedProviders?: string[];
	/** Warning message if model fallback occurred */
	modelFallbackMessage?: string;
	/** Initial message to send */
	initialMessage?: string;
	/** Initial images to include with the message */
	initialImages?: ImageContent[];
	/** Additional initial messages to queue */
	initialMessages?: string[];
}

export class InteractiveMode implements InteractiveModeContext {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	keybindings: KeybindingsManager;
	agent: Agent;
	historyStorage?: HistoryStorage;

	ui: TUI;
	chatContainer: Container;
	pendingMessagesContainer: Container;
	statusContainer: Container;
	todoContainer: Container;
	btwContainer: Container;
	editor: CustomEditor;
	editorContainer: Container;
	hookWidgetContainerAbove: Container;
	hookWidgetContainerBelow: Container;
	statusLine: StatusLineComponent;

	isInitialized = false;
	isBackgrounded = false;
	isBashMode = false;
	isBashNoContext = false;
	toolOutputExpanded = false;
	todoExpanded = false;
	planModeEnabled = false;
	planModePaused = false;
	goalModeEnabled = false;
	goalModePaused = false;
	planModePlanFilePath: string | undefined = undefined;
	todoPhases: TodoPhase[] = [];
	hideThinkingBlock = false;
	pendingImages: ImageContent[] = [];
	compactionQueuedMessages: CompactionQueuedMessage[] = [];
	pendingTools = new Map<string, ToolExecutionHandle>();
	pendingBashComponents: BashExecutionComponent[] = [];
	bashComponent: BashExecutionComponent | undefined = undefined;
	pendingPythonComponents: EvalExecutionComponent[] = [];
	pythonComponent: EvalExecutionComponent | undefined = undefined;
	isPythonMode = false;
	streamingComponent: AssistantMessageComponent | undefined = undefined;
	streamingMessage: AssistantMessage | undefined = undefined;
	loadingAnimation: Loader | undefined = undefined;
	autoCompactionLoader: Loader | undefined = undefined;
	retryLoader: Loader | undefined = undefined;
	#pendingWorkingMessage: string | undefined;
	get #defaultWorkingMessage(): string {
		return `Working…${interruptHint()}`;
	}
	autoCompactionEscapeHandler?: () => void;
	retryEscapeHandler?: () => void;
	retryEscapePrimed = false;
	retryCountdownTimer?: NodeJS.Timeout;
	unsubscribe?: () => void;
	onInputCallback?: (input: SubmittedUserInput) => void;
	optimisticUserMessageSignature: string | undefined = undefined;
	locallySubmittedUserSignatures: Set<string> = new Set();
	optimisticInjectedSignatures: Map<string, number> = new Map();
	#pendingSubmittedInput: SubmittedUserInput | undefined;
	#pendingSubmissionDispose: (() => void) | undefined;
	lastSigintTime = 0;
	lastEscapeTime = 0;
	lastComposerClearEscapeTime = 0;
	shutdownRequested = false;
	#isShuttingDown = false;
	hookSelector: HookSelectorComponent | undefined = undefined;
	hookInput: HookInputComponent | undefined = undefined;
	hookEditor: HookEditorComponent | undefined = undefined;
	lastStatusSpacer: Spacer | undefined = undefined;
	lastStatusText: Text | undefined = undefined;
	fileSlashCommands: Set<string> = new Set();
	skillCommands: Map<string, Skill> = new Map();
	oauthManualInput: OAuthManualInputManager = new OAuthManualInputManager();

	#baseSlashCommands: SlashCommand[] = [];
	#baseReservedSlashCommandNames: Set<string> = new Set();
	#cleanupUnsubscribe?: () => void;
	#subprocessTeardownUnsubscribe?: () => void;
	readonly #version: string;
	readonly #changelogMarkdown: string | undefined;
	#planModePreviousTools: string[] | undefined;
	#goalModePreviousTools: string[] | undefined;
	#goalContinuationTimer: NodeJS.Timeout | undefined;
	#goalTurnHadToolCalls = false;
	#goalContinuationTurnInFlight = false;
	#goalSuppressNextContinuation = false;
	#planModePreviousModelState: { model: Model; thinkingLevel?: ThinkingLevel } | undefined;
	#pendingModelSwitch: { model: Model; thinkingLevel?: ThinkingLevel } | undefined;
	#planModeHasEntered = false;
	#planReviewContainer: Container | undefined;
	readonly lspServers: LspStartupServerInfo[] | undefined = undefined;
	mcpManager?: import("../runtime-mcp").MCPManager;
	readonly #toolUiContextSetter: (uiContext: ExtensionUIContext, hasUI: boolean) => void;

	readonly #btwController: BtwController;
	readonly #commandController: CommandController;
	readonly #todoCommandController: TodoCommandController;
	readonly #eventController: EventController;
	readonly #extensionUiController: ExtensionUiController;
	readonly #inputController: InputController;
	readonly #selectorController: SelectorController;
	readonly #uiHelpers: UiHelpers;
	#sttController: STTController | undefined;
	#voiceAnimationInterval: NodeJS.Timeout | undefined;
	#voiceHue = 0;
	#voicePreviousShowHardwareCursor: boolean | null = null;
	#voicePreviousUseTerminalCursor: boolean | null = null;
	#resizeHandler?: () => void;
	#observerRegistry: SessionObserverRegistry;
	#jobsObserver?: JobsObserver;
	#eventBus?: EventBus;
	#eventBusUnsubscribers: Array<() => void> = [];
	#welcomeComponent?: WelcomeComponent;

	constructor(
		session: AgentSession,
		version: string,
		changelogMarkdown: string | undefined = undefined,
		setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void = () => {},
		lspServers: LspStartupServerInfo[] | undefined = undefined,
		mcpManager?: import("../runtime-mcp").MCPManager,
		eventBus?: EventBus,
	) {
		this.session = session;
		this.sessionManager = session.sessionManager;
		this.settings = session.settings;
		this.keybindings = KeybindingsManager.inMemory();
		this.agent = session.agent;
		this.#version = version;
		this.#changelogMarkdown = changelogMarkdown;
		this.#toolUiContextSetter = setToolUIContext;
		this.lspServers = lspServers;
		this.mcpManager = mcpManager;
		this.#eventBus = eventBus;
		if (eventBus) {
			this.#eventBusUnsubscribers.push(
				eventBus.on(LSP_STARTUP_EVENT_CHANNEL, data => {
					this.#handleLspStartupEvent(data as LspStartupEvent);
				}),
			);
		}

		this.ui = new TUI(new ProcessTerminal(), settings.get("showHardwareCursor"));
		this.ui.setClearOnShrink(settings.get("clearOnShrink"));
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.todoContainer = new Container();
		this.btwContainer = new Container();
		this.editor = new CustomEditor(getEditorTheme());
		configureDefaultComposerChrome(this.editor);
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.editor.setAutocompleteMaxVisible(settings.get("autocompleteMaxVisible"));
		this.editor.onAutocompleteCancel = () => {
			this.ui.requestRender();
		};
		this.editor.onAutocompleteUpdate = () => {
			this.ui.requestRender();
		};
		this.#syncEditorMaxHeight();
		this.#resizeHandler = () => {
			this.#syncEditorMaxHeight();
			this.updateEditorChrome();
			this.editor.invalidate();
			this.ui.requestResizeRender();
		};
		process.stdout.on("resize", this.#resizeHandler);
		try {
			this.historyStorage = HistoryStorage.open();
			this.editor.setHistoryStorage(this.historyStorage);
		} catch (error) {
			logger.warn("History storage unavailable", { error: String(error) });
		}
		this.hookWidgetContainerAbove = new Container();
		this.hookWidgetContainerBelow = new Container();
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor);
		this.statusLine = new StatusLineComponent(session, { version: this.#version });
		this.statusLine.setAutoCompactEnabled(session.autoCompactionEnabled);

		this.hideThinkingBlock = settings.get("hideThinkingBlock");

		const builtinCommandNames = new Set(BUILTIN_SLASH_COMMANDS.map(c => c.name));
		const activeProvider = this.session.model?.provider;
		const hookCommands: SlashCommand[] = (
			this.session.extensionRunner?.getRegisteredCommands(builtinCommandNames) ?? []
		)
			.filter(cmd => shouldShowExtensionCommand(cmd.name, activeProvider))
			.map(cmd => ({
				name: cmd.name,
				description: cmd.description ?? "(hook command)",
				getArgumentCompletions: cmd.getArgumentCompletions,
			}));

		// Convert custom commands (TypeScript) to SlashCommand format
		const customCommands: SlashCommand[] = this.session.customCommands.map(loaded => ({
			name: loaded.command.name,
			description: `${loaded.command.description} (${loaded.source})`,
		}));

		this.#baseSlashCommands = [...BUILTIN_SLASH_COMMANDS, ...hookCommands, ...customCommands];
		this.#baseReservedSlashCommandNames = new Set(this.#baseSlashCommands.map(command => command.name));
		this.#rebuildSkillSlashCommands();

		this.#uiHelpers = new UiHelpers(this);
		this.#btwController = new BtwController(this);
		this.#extensionUiController = new ExtensionUiController(this);
		this.#eventController = new EventController(this);
		this.#commandController = new CommandController(this);
		this.#todoCommandController = new TodoCommandController(this);
		this.#selectorController = new SelectorController(this);
		this.#inputController = new InputController(this);
		this.#observerRegistry = new SessionObserverRegistry();
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.keybindings = logger.time("InteractiveMode.init:keybindings", () => KeybindingsManager.create());

		// Register session manager flush for signal handlers (SIGINT, SIGTERM, SIGHUP)
		this.#cleanupUnsubscribe = postmortem.register("session-manager-flush", () => this.sessionManager.flush());

		// Tear down subprocess-spawning tools (browser Chrome, Python eval kernel) on a
		// signal kill (SIGINT/SIGTERM/SIGHUP) so they aren't reparented to PID 1 (#698).
		// The graceful /quit path already releases these via session.dispose(); this hook
		// is the bounded, idempotent fallback for an external kill that bypasses it.
		this.#subprocessTeardownUnsubscribe = postmortem.register("session-subprocess-teardown", () =>
			this.session.disposeChildSubprocesses(),
		);

		await logger.time(
			"InteractiveMode.init:slashCommands",
			this.refreshSlashCommandState.bind(this),
			getProjectDir(),
		);

		// Get current model info for welcome screen
		const modelName = this.session.model?.name ?? "Unknown";
		const providerName = this.session.model?.provider ?? "Unknown";

		// Get recent sessions
		const recentSessions = await logger.time("InteractiveMode.init:recentSessions", () =>
			getRecentSessions(this.sessionManager.getSessionDir()).then(sessions =>
				sessions.map(s => ({
					name: s.name,
					timeAgo: s.timeAgo,
				})),
			),
		);

		const startupQuiet = settings.get("startup.quiet");
		const welcomeLogoMode = resolveWelcomeLogoMode(settings.get("startup.welcomeBannerMode"));
		this.#welcomeComponent = undefined;

		for (const warning of this.session.configWarnings) {
			this.ui.addChild(new Text(theme.fg("warning", `Warning: ${warning}`), 1, 0));
			this.ui.addChild(new Spacer(1));
		}

		if (!startupQuiet) {
			const getWelcomeReservedBottomRows = (width: number): number => this.#getWelcomeReservedRows(width);

			// Add welcome header
			this.#welcomeComponent = new WelcomeComponent(
				this.#version,
				modelName,
				providerName,
				recentSessions,
				this.#getWelcomeLspServers(),
				welcomeLogoMode,
				{
					getViewportRows: () => this.ui.terminal.rows,
					getReservedBottomRows: getWelcomeReservedBottomRows,
					changelogMarkdown: this.#changelogMarkdown,
					collapseChangelog: settings.get("collapseChangelog"),
				},
			);

			this.ui.addChild(this.#welcomeComponent);
			this.#welcomeComponent.playIntro(() => this.ui.requestRender());
		}

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		this.ui.addChild(this.todoContainer);
		this.ui.addChild(this.btwContainer);
		this.ui.addChild(this.statusLine); // Main status rail + hook statuses; composer chrome is rendered by the editor.
		this.ui.addChild(this.hookWidgetContainerAbove);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.hookWidgetContainerBelow);
		this.ui.setBottomPinnedComponent(this.statusLine);
		this.ui.setFocus(this.editor);

		this.#inputController.setupKeyHandlers();
		this.#inputController.setupEditorSubmitHandler();

		// Wire observer registry to EventBus
		if (this.#eventBus) {
			this.#observerRegistry.subscribeToEventBus(this.#eventBus);
		}
		this.#observerRegistry.setMainSession(this.sessionManager.getSessionFile() ?? undefined);
		this.#observerRegistry.onChange(() => {
			this.statusLine.setSubagentCount(this.#observerRegistry.getActiveSubagentCount());
			this.ui.requestRender();
		});

		// Event-driven monitor/cron jobs widget. Scoped to this session's owner so
		// overlay actions cannot mutate another agent's background work.
		const jobManager = AsyncJobManager.instance();
		if (jobManager) {
			const jobsObserver = new JobsObserver(jobManager, this.session.getAgentId());
			this.#jobsObserver = jobsObserver;
			this.statusLine.setJobs(jobsObserver.getSnapshot());
			jobsObserver.onChange(() => {
				this.statusLine.setJobs(jobsObserver.getSnapshot());
				this.ui.requestRender();
			});
		}

		// Load initial todos
		await this.#loadTodoList();

		// Start the UI
		this.ui.start();
		pushTerminalTitle();
		setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
		this.updateEditorChrome();
		this.#syncEditorMaxHeight();
		this.isInitialized = true;
		this.ui.requestRender(true);

		// GitHub star reminder (interactive-only). Register the decline-driven
		// injection contributor and schedule the launch nudge after the first
		// render so the networked gh check never blocks startup.
		const starReminderGate = starReminderLaunchGate({
			enabled: settings.get("starReminder.enabled"),
			quiet: startupQuiet,
		});
		if (starReminderGate.register) {
			this.session.registerBeforeAgentStartContributor(
				createStarReminderBeforeAgentStartContributor({
					getSessionId: () => this.sessionManager.getSessionId(),
				}),
			);
		}
		if (starReminderGate.schedule) {
			scheduleLaunchStarReminderAfterFirstRender({
				confirm: (title, message) => this.showHookConfirm(title, message),
				isIdle: () => !this.session.isStreaming && !this.isBackgrounded && !this.hookSelector,
			});
		}

		// Initialize hooks with TUI-based UI context
		await this.initHooksAndCustomTools();

		// Restore mode from session (e.g. plan mode on resume)
		await this.#restoreModeFromSession();

		// Restore unsent editor draft from previous session shutdown (Ctrl+D).
		// One-shot: consumeDraft removes the sidecar after read so the next
		// resume does not re-restore the same text.
		try {
			const draft = await this.sessionManager.consumeDraft();
			if (draft && !this.editor.getText()) {
				this.editor.setText(draft);
				this.updateEditorChrome();
				this.ui.requestRender();
			}
		} catch (err) {
			logger.warn("Failed to restore session draft", { error: String(err) });
		}

		// Subscribe to agent events
		this.#subscribeToAgent();

		this.#eventBusUnsubscribers.push(
			this.session.subscribe(event => {
				void this.#handleGoalSessionEvent(event);
			}),
		);
		// Set up theme file watcher
		onThemeChange(() => {
			clearRenderCache();
			configureDefaultComposerChrome(this.editor);
			this.ui.invalidate();
			this.updateEditorChrome();
			this.ui.requestRender();
		});

		// Subscribe to terminal dark/light appearance changes.
		// The terminal queries background color via OSC 11 at startup and on
		// Mode 2031 notifications, computing luminance to detect dark/light.
		this.ui.terminal.onAppearanceChange(mode => {
			onTerminalAppearanceChange(mode);
		});

		// Set up git branch watcher
		this.statusLine.watchBranch(() => {
			this.updateEditorChrome();
			this.ui.requestRender();
		});

		// Initial top border update
		this.updateEditorChrome();
	}

	/** Reload slash commands and autocomplete for the provided working directory. */
	async refreshSlashCommandState(cwd?: string): Promise<void> {
		const basePath = cwd ?? this.sessionManager.getCwd();
		const fileCommands = await loadSlashCommands({ cwd: basePath });
		const fileCommandNames = new Set(fileCommands.map(cmd => cmd.name));
		this.fileSlashCommands = fileCommandNames;
		const fileSlashCommands: SlashCommand[] = fileCommands.map(cmd => ({
			name: cmd.name,
			description: cmd.description,
		}));
		const skillCommands = this.#rebuildSkillSlashCommands(fileCommandNames);
		const slashCommands = [...this.#baseSlashCommands, ...skillCommands];
		const autocompleteProvider = this.#inputController.createAutocompleteProvider(
			[...slashCommands, ...fileSlashCommands],
			basePath,
		);
		this.editor.setAutocompleteProvider(autocompleteProvider);
		this.session.setSlashCommands(fileCommands);
	}

	#rebuildSkillSlashCommands(fileCommandNames: ReadonlySet<string> = new Set()): SlashCommand[] {
		this.skillCommands.clear();
		if (!settings.get("skills.enableSkillCommands")) {
			return [];
		}
		const reservedDirectCommandNames = new Set([
			...this.#baseReservedSlashCommandNames,
			...Array.from(fileCommandNames),
		]);
		const resolvedCommands = resolveSkillSlashCommands(this.session.skills, reservedDirectCommandNames);
		for (const command of resolvedCommands) {
			this.skillCommands.set(command.name, command.skill);
		}
		const defaultGjcNames = new Set<string>(DEFAULT_GJC_DEFINITION_NAMES);
		return resolvedCommands.map(command => ({
			name: command.name,
			description: command.description,
			// Pin the bundled GJC workflow skills above generic commands in autocomplete.
			...(defaultGjcNames.has(command.skill.name) ? { priority: 100 } : {}),
		}));
	}

	async getUserInput(): Promise<SubmittedUserInput> {
		if (this.session.getGoalModeState()?.mode === "exiting") {
			await this.#exitGoalMode({ reason: "completed", silent: true });
		}
		const { promise, resolve } = Promise.withResolvers<SubmittedUserInput>();
		this.onInputCallback = input => {
			this.onInputCallback = undefined;
			resolve(input);
		};
		this.#scheduleGoalContinuation();
		return promise;
	}

	#scheduleGoalContinuation(): void {
		this.#cancelGoalContinuation();
		if (!this.onInputCallback) return;
		if (!this.session.settings.get("goal.continuationModes").includes("interactive")) return;
		if (this.planModeEnabled || this.planModePaused) return;
		if (!this.goalModeEnabled || this.goalModePaused) return;
		if (this.#goalSuppressNextContinuation) return;
		if (this.#pendingSubmittedInput) return;
		if (this.editor.getText().trim().length > 0) return;
		if ((this.pendingImages?.length ?? 0) > 0) return;
		const state = this.session.getGoalModeState();
		if (!state?.enabled || state.goal.status !== "active") return;
		const prompt = this.session.goalRuntime.buildContinuationPrompt();
		if (!prompt) return;
		this.#goalContinuationTimer = setTimeout(() => {
			this.#goalContinuationTimer = undefined;
			if (!this.onInputCallback) return;
			if (!this.goalModeEnabled || this.goalModePaused) return;
			if (this.#pendingSubmittedInput) return;
			if (this.editor.getText().trim().length > 0) return;
			if ((this.pendingImages?.length ?? 0) > 0) return;
			// Never fire an autonomous continuation prompt() while the session is
			// busy. A wedged/orphaned subagent turn can leave isStreaming stuck true;
			// firing prompt() here throws AgentBusyError, which submitInteractiveInput
			// surfaces as a red "Error: Agent is already processing…" and then loops
			// back to getUserInput(), re-arming this timer — an infinite error spam.
			// Re-arm and only fire once the session returns to idle.
			if (this.session.isStreaming || this.session.isCompacting) {
				this.#scheduleGoalContinuation();
				return;
			}
			const latestState = this.session.getGoalModeState();
			if (!latestState?.enabled || latestState.goal.status !== "active") return;
			this.#goalContinuationTurnInFlight = true;
			this.onInputCallback(
				this.startPendingSubmission({
					text: prompt,
					customType: "goal-continuation",
					display: false,
				}),
			);
		}, 800);
	}

	#cancelGoalContinuation(): void {
		if (this.#goalContinuationTimer) {
			clearTimeout(this.#goalContinuationTimer);
			this.#goalContinuationTimer = undefined;
		}
	}

	recordLocalSubmission(text: string, imageCount = 0): () => void {
		if (this.isKnownSlashCommand(text)) {
			return () => {};
		}
		const signature = `${text}\u0000${imageCount}`;
		this.locallySubmittedUserSignatures.add(signature);
		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			this.locallySubmittedUserSignatures.delete(signature);
		};
	}

	async withLocalSubmission<T>(text: string, fn: () => Promise<T>, options?: { imageCount?: number }): Promise<T> {
		const dispose = this.recordLocalSubmission(text, options?.imageCount ?? 0);
		try {
			return await fn();
		} catch (err) {
			dispose();
			throw err;
		}
	}

	startPendingSubmission(input: {
		text: string;
		images?: ImageContent[];
		customType?: string;
		display?: boolean;
	}): SubmittedUserInput {
		const submission: SubmittedUserInput = {
			text: input.text,
			images: input.images,
			customType: input.customType,
			display: input.display,
			cancelled: false,
			started: false,
		};
		this.#pendingSubmittedInput = submission;
		if (!submission.customType) {
			this.#resetGoalContinuationSuppression();
			const imageCount = submission.images?.length ?? 0;
			this.optimisticUserMessageSignature = `${submission.text}\u0000${imageCount}`;
			this.#pendingSubmissionDispose = this.recordLocalSubmission(submission.text, imageCount);
			this.addMessageToChat({
				role: "user",
				content: [{ type: "text", text: submission.text }, ...(submission.images ?? [])],
				attribution: "user",
				timestamp: Date.now(),
			});
		} else {
			this.optimisticUserMessageSignature = undefined;
			this.#pendingSubmissionDispose = undefined;
		}
		this.editor.setText("");
		this.ensureLoadingAnimation();
		this.ui.requestRender();
		return submission;
	}

	cancelPendingSubmission(): boolean {
		const submission = this.#pendingSubmittedInput;
		if (!submission || submission.started) {
			return false;
		}

		submission.cancelled = true;
		this.#pendingSubmittedInput = undefined;
		this.optimisticUserMessageSignature = undefined;
		this.#pendingSubmissionDispose?.();
		this.#pendingSubmissionDispose = undefined;
		this.#pendingWorkingMessage = undefined;
		if (submission.customType === "goal-continuation") {
			this.#goalContinuationTurnInFlight = false;
		}
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
			this.statusContainer.clear();
		}
		if (!submission.customType) {
			this.pendingImages = submission.images ? [...submission.images] : [];
			this.rebuildChatFromMessages();
			this.editor.setText(submission.text);
		}
		this.updateEditorChrome();
		this.ui.requestRender();
		return true;
	}

	markPendingSubmissionStarted(input: SubmittedUserInput): boolean {
		if (this.#pendingSubmittedInput !== input || input.cancelled) {
			return false;
		}
		input.started = true;
		return true;
	}

	finishPendingSubmission(input: SubmittedUserInput): void {
		const wasPendingSubmission = this.#pendingSubmittedInput === input;
		const pendingSubmissionDispose = this.#pendingSubmissionDispose;
		if (wasPendingSubmission) {
			this.#pendingSubmittedInput = undefined;
			this.#pendingSubmissionDispose = undefined;
		}
		if (input.customType === "goal-continuation") {
			this.#goalContinuationTurnInFlight = false;
		}

		if (wasPendingSubmission && !this.session.isStreaming && !this.streamingComponent) {
			this.optimisticUserMessageSignature = undefined;
			pendingSubmissionDispose?.();
			this.#pendingWorkingMessage = undefined;
			if (this.loadingAnimation) {
				this.loadingAnimation.stop();
				this.loadingAnimation = undefined;
				this.statusContainer.clear();
			}
		}
	}

	#computeEditorMaxHeight(): number {
		const rows = this.ui.terminal.rows;
		const terminalRows = Number.isFinite(rows) && rows > 0 ? rows : EDITOR_FALLBACK_ROWS;
		const maxHeight = terminalRows - EDITOR_RESERVED_ROWS;
		return Math.max(EDITOR_MAX_HEIGHT_MIN, Math.min(EDITOR_MAX_HEIGHT_MAX, maxHeight));
	}

	#syncEditorMaxHeight(): void {
		this.editor.setMaxHeight(this.#computeEditorMaxHeight());
	}

	#isPromptDeliveryBusy(): boolean {
		return this.session.isStreaming || this.session.isCompacting;
	}

	#getFirstKeyForAction(action: AppKeybinding): string | undefined {
		return this.keybindings.getKeys(action)[0];
	}

	#getMessageQueueShortcut(): string | undefined {
		const preferredAction: AppKeybinding =
			process.platform === "darwin" ? "app.message.followUp" : "app.message.queue";
		const fallbackAction: AppKeybinding =
			process.platform === "darwin" ? "app.message.queue" : "app.message.followUp";
		return this.#getFirstKeyForAction(preferredAction) ?? this.#getFirstKeyForAction(fallbackAction);
	}

	#getComposerPlaceholder(): string {
		if (!this.#isPromptDeliveryBusy()) return DEFAULT_COMPOSER_PLACEHOLDER;
		const enterAction = this.settings.get("busyPromptMode") === "steer" ? "Steer" : "Queue";
		const parts = [`Enter: ${enterAction}`];
		const queueKey = this.#getMessageQueueShortcut();
		if (queueKey) parts.push(`${formatShortcutForPlaceholder(queueKey)}: Queue`);
		return `${DEFAULT_COMPOSER_PLACEHOLDER} · ${parts.join(" · ")}`;
	}

	#getWelcomeReservedRows(width: number): number {
		const transientRows = [
			this.chatContainer,
			this.pendingMessagesContainer,
			this.statusContainer,
			this.todoContainer,
			this.btwContainer,
		].reduce((rows, container) => rows + this.#renderShortContainerRowsForWelcomeReservation(width, container), 0);

		const pinnedRows = [
			this.statusLine,
			this.hookWidgetContainerAbove,
			this.editorContainer,
			this.hookWidgetContainerBelow,
		].reduce((rows, component) => rows + component.render(width).length, 0);

		return transientRows + pinnedRows;
	}

	#renderShortContainerRowsForWelcomeReservation(width: number, container: Container): number {
		if (container.children.length === 0 || container.children.length > WELCOME_RESERVED_CONTAINER_CHILD_LIMIT) {
			return 0;
		}
		return container.render(width).length;
	}

	updateEditorChrome(): void {
		if (this.isBashMode) {
			this.editor.borderColor = this.isBashNoContext
				? (str: string) => theme.fg("warning", str)
				: theme.getBashModeBorderColor();
			this.editor.setInputPrefix(getShellInputPrefix(this.isBashNoContext));
		} else if (this.isPythonMode) {
			this.editor.borderColor = theme.getPythonModeBorderColor();
		} else {
			const accentEnabled = !isSettingsInitialized() || settings.get("statusLine.sessionAccent") !== false;
			const sessionName = accentEnabled ? this.sessionManager.getSessionName() : undefined;
			const hex = sessionName ? getSessionAccentHex(sessionName) : undefined;
			const ansi = getSessionAccentAnsi(hex);
			if (ansi) {
				this.editor.borderColor = (str: string) => `${ansi}${str}\x1b[39m`;
			} else {
				const level = this.session.thinkingLevel ?? ThinkingLevel.Off;
				this.editor.borderColor = theme.getThinkingBorderColor(level);
			}
		}
		if (!this.isBashMode) {
			this.editor.setInputPrefix(getDefaultInputPrefix());
		}
		this.editor.setPlaceholder(this.#getComposerPlaceholder());
		this.#setComposerTopBorder();
		this.ui.requestRender();
	}

	updateEditorBorderColor(): void {
		this.updateEditorChrome();
	}

	updateEditorTopBorder(): void {
		this.#setComposerTopBorder();
	}

	#setComposerTopBorder(): void {
		// Keep the composer as a plain closed input rectangle; status-line
		// rendering stays outside the input area.
		this.editor.setTopBorder(undefined);
	}

	rebuildChatFromMessages(): void {
		this.chatContainer.clear();
		const context = this.session.buildDisplaySessionContext();
		this.renderSessionContext(context);
	}

	#formatTodoLine(todo: TodoItem, prefix: string): string {
		const checkbox = theme.checkbox;
		const marker = formatHudNoteMarker(todo.notes?.length ?? 0);
		switch (todo.status) {
			case "completed":
				return theme.fg("success", `${prefix}${checkbox.checked} ${chalk.strikethrough(todo.content)}`) + marker;
			case "in_progress":
				return theme.fg("accent", `${prefix}${checkbox.unchecked} ${todo.content}`) + marker;
			case "abandoned":
				return theme.fg("error", `${prefix}${checkbox.unchecked} ${chalk.strikethrough(todo.content)}`) + marker;
			default:
				return theme.fg("dim", `${prefix}${checkbox.unchecked} ${todo.content}`) + marker;
		}
	}

	#getActivePhase(phases: TodoPhase[]): TodoPhase | undefined {
		const nonEmpty = phases.filter(phase => phase.tasks.length > 0);
		const active = nonEmpty.find(phase =>
			phase.tasks.some(task => task.status === "pending" || task.status === "in_progress"),
		);
		return active ?? nonEmpty[nonEmpty.length - 1];
	}

	#renderTodoList(): void {
		this.todoContainer.clear();
		const phases = this.todoPhases.filter(phase => phase.tasks.length > 0);
		if (phases.length === 0) {
			return;
		}

		const indent = "  ";
		const hook = theme.tree.hook;
		const lines = ["", indent + theme.bold(theme.fg("accent", "Todos"))];

		if (!this.todoExpanded) {
			const activeIdx = phases.indexOf(this.#getActivePhase(phases) ?? phases[0]);
			const activePhase = phases[activeIdx];
			if (!activePhase) return;
			lines.push(
				`${indent}${theme.fg("accent", `${hook} ${formatPhaseDisplayName(activePhase.name, activeIdx + 1)}`)}`,
			);
			const visibleTasks = activePhase.tasks.slice(0, 5);
			visibleTasks.forEach((todo, index) => {
				const prefix = `${indent}${index === 0 ? hook : " "} `;
				lines.push(this.#formatTodoLine(todo, prefix));
			});
			if (visibleTasks.length < activePhase.tasks.length) {
				const remaining = activePhase.tasks.length - visibleTasks.length;
				lines.push(theme.fg("muted", `${indent}  ${hook} +${remaining} more`));
			}
			this.todoContainer.addChild(new Text(lines.join("\n"), 1, 0));
			return;
		}

		phases.forEach((phase, phaseIndex) => {
			lines.push(`${indent}${theme.fg("accent", `${hook} ${formatPhaseDisplayName(phase.name, phaseIndex + 1)}`)}`);
			phase.tasks.forEach((todo, index) => {
				const prefix = `${indent}${index === 0 ? hook : " "} `;
				lines.push(this.#formatTodoLine(todo, prefix));
			});
		});

		this.todoContainer.addChild(new Text(lines.join("\n"), 1, 0));
	}

	async #loadTodoList(): Promise<void> {
		this.todoPhases = this.session.getTodoPhases();
		this.#renderTodoList();
	}

	async #getPlanFilePath(): Promise<string> {
		return "local://PLAN.md";
	}

	#resolvePlanFilePath(planFilePath: string): string {
		if (planFilePath.startsWith("local:")) {
			const normalized = normalizeLocalScheme(planFilePath);
			return resolveLocalUrlToPath(normalized, {
				getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
				getSessionId: () => this.sessionManager.getSessionId(),
			});
		}
		return path.resolve(this.sessionManager.getCwd(), planFilePath);
	}

	#updatePlanModeStatus(): void {
		const status =
			this.planModeEnabled || this.planModePaused
				? {
						enabled: this.planModeEnabled,
						paused: this.planModePaused,
					}
				: undefined;
		this.statusLine.setPlanModeStatus(status);
		this.updateEditorChrome();
		this.ui.requestRender();
	}

	#updateGoalModeStatus(): void {
		const status =
			this.goalModeEnabled || this.goalModePaused
				? { enabled: this.goalModeEnabled, paused: this.goalModePaused }
				: undefined;
		this.statusLine.setGoalModeStatus(status);
		this.updateEditorChrome();
		this.ui.requestRender();
	}

	#resetGoalContinuationSuppression(): void {
		this.#goalSuppressNextContinuation = false;
	}

	#getPausedGoalState(): GoalModeState | undefined {
		const state = this.session.getGoalModeState();
		if (!state?.goal || state.enabled || state.goal.status !== "paused") {
			return undefined;
		}
		return state;
	}

	#goalFromModeData(modeData: SessionContext["modeData"]): Goal | undefined {
		return normalizeGoal(modeData?.goal) ?? undefined;
	}

	async #handleGoalSessionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "agent_start") {
			this.#goalTurnHadToolCalls = false;
			this.#cancelGoalContinuation();
			return;
		}
		if (event.type === "tool_execution_start") {
			this.#goalTurnHadToolCalls = true;
			if (!this.#goalContinuationTurnInFlight) {
				this.#resetGoalContinuationSuppression();
			}
			return;
		}
		if (event.type === "message_start" && event.message.role === "user" && !event.message.synthetic) {
			this.#resetGoalContinuationSuppression();
			return;
		}
		if (event.type === "goal_updated") {
			// Handle drop before clearing goalModeEnabled so #exitGoalMode can
			// still restore the previous tool set while the flag is true.
			if (event.state?.goal?.status === "dropped") {
				await this.#exitGoalMode({ reason: "dropped", silent: true });
				return;
			}
			if (event.state?.enabled === true && !this.#goalModePreviousTools) {
				this.#goalModePreviousTools = this.session.getActiveToolNames();
			}
			this.goalModeEnabled = event.state?.enabled === true;
			this.goalModePaused = event.state?.enabled !== true && event.state?.goal?.status === "paused";
			if (!event.state?.enabled) {
				this.#cancelGoalContinuation();
			}
			this.#updateGoalModeStatus();
			return;
		}
		if (event.type !== "agent_end") {
			return;
		}
		if (this.#goalContinuationTurnInFlight) {
			this.#goalSuppressNextContinuation = !this.#goalTurnHadToolCalls;
			this.#goalContinuationTurnInFlight = false;
		}
		if (this.session.getGoalModeState()?.mode === "exiting") {
			await this.#exitGoalMode({ reason: "completed", silent: true });
			return;
		}
		this.#scheduleGoalContinuation();
	}

	async #applyPlanModeModel(): Promise<void> {
		const resolved = this.session.resolveRoleModelWithThinking("plan");
		if (!resolved.model) return;

		const currentModel = this.session.model;
		const sameModel = modelsAreEqual(currentModel, resolved.model);
		const planThinkingLevel = resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined;

		this.#planModePreviousModelState = currentModel
			? { model: currentModel, thinkingLevel: this.session.thinkingLevel }
			: undefined;

		if (!sameModel) {
			if (this.session.isStreaming) {
				this.#pendingModelSwitch = { model: resolved.model, thinkingLevel: planThinkingLevel };
				return;
			}
			try {
				await this.session.setModelTemporary(resolved.model, planThinkingLevel);
			} catch (error) {
				this.showWarning(
					`Failed to switch to plan model for plan mode: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} else if (planThinkingLevel) {
			this.session.setThinkingLevel(planThinkingLevel);
		}
	}

	/** Apply any deferred model switch after the current stream ends. */
	async flushPendingModelSwitch(): Promise<void> {
		const pending = this.#pendingModelSwitch;
		if (!pending) return;
		this.#pendingModelSwitch = undefined;
		try {
			await this.session.setModelTemporary(pending.model, pending.thinkingLevel);
		} catch (error) {
			this.showWarning(
				`Failed to switch model after streaming: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** Restore mode state from session entries on resume (e.g. plan mode). */
	async #restoreModeFromSession(): Promise<void> {
		const sessionContext = this.sessionManager.buildSessionContext();
		const goalEnabled = this.session.settings.get("goal.enabled");
		if (!goalEnabled && (sessionContext.mode === "goal" || sessionContext.mode === "goal_paused")) {
			this.sessionManager.appendModeChange("none");
			return;
		}
		if (sessionContext.mode === "goal" || sessionContext.mode === "goal_paused") {
			const goal = this.#goalFromModeData(sessionContext.modeData);
			if (!goal) {
				this.sessionManager.appendModeChange("none");
				return;
			}
			this.session.setGoalModeState({
				enabled: sessionContext.mode === "goal",
				mode: "active",
				goal,
			});
			const restored = await this.session.goalRuntime.onThreadResumed();
			this.goalModeEnabled = restored?.enabled === true;
			this.goalModePaused = restored?.enabled !== true && restored?.goal.status === "paused";
			// Keep `goal` armed on resumed threads; it is part of the default active tool set.
			if (restored?.goal) {
				const previousTools = this.session.getActiveToolNames();
				this.#goalModePreviousTools = previousTools;
				await this.session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
			}
			this.#updateGoalModeStatus();
			return;
		}
		const pendingGoal = goalEnabled
			? await consumePendingGoalModeRequest(this.sessionManager.getCwd(), this.sessionManager.getSessionId())
			: null;
		if (pendingGoal) {
			await this.#enterGoalMode({ objective: pendingGoal.objective, silent: true });
			this.#scheduleGoalContinuation();
			return;
		}
		if (!this.session.settings.get("plan.enabled")) {
			// Clear stale plan/plan_paused mode so re-enabling the setting
			// later doesn't unexpectedly restore an old plan session.
			if (sessionContext.mode === "plan" || sessionContext.mode === "plan_paused") {
				this.sessionManager.appendModeChange("none");
			}
			return;
		}
		if (sessionContext.mode === "plan") {
			const planFilePath = sessionContext.modeData?.planFilePath as string | undefined;
			await this.#enterPlanMode({ planFilePath });
		} else if (sessionContext.mode === "plan_paused") {
			this.planModePaused = true;
			this.#planModeHasEntered = true;
			this.#updatePlanModeStatus();
		}
	}

	async #enterPlanMode(options?: { planFilePath?: string; workflow?: "parallel" | "iterative" }): Promise<void> {
		if (this.planModeEnabled) {
			return;
		}
		if (this.goalModeEnabled || this.goalModePaused) {
			this.showWarning("Exit goal mode first.");
			return;
		}

		this.planModePaused = false;

		const planFilePath = options?.planFilePath ?? (await this.#getPlanFilePath());
		const previousTools = this.session.getActiveToolNames();
		const hasResolveTool = this.session.getToolByName("resolve") !== undefined;
		const planTools = hasResolveTool ? [...previousTools, "resolve"] : previousTools;
		const uniquePlanTools = [...new Set(planTools)];

		this.#planModePreviousTools = previousTools;
		this.planModePlanFilePath = planFilePath;
		this.planModeEnabled = true;

		await this.session.setActiveToolsByName(uniquePlanTools);
		this.session.setPlanModeState({
			enabled: true,
			planFilePath,
			workflow: options?.workflow ?? "parallel",
			reentry: this.#planModeHasEntered,
		});
		this.session.setStandingResolveHandler?.(input => this.#runPlanApprovalResolve(input));
		if (this.session.isStreaming) {
			await this.session.sendPlanModeContext({ deliverAs: "steer" });
		}
		this.#planModeHasEntered = true;
		await this.#applyPlanModeModel();
		this.#updatePlanModeStatus();
		this.sessionManager.appendModeChange("plan", { planFilePath });
		this.showStatus(`Plan mode enabled. Plan file: ${planFilePath}`);
	}

	/** Standing resolve dispatcher registered while plan mode is active. The agent
	 *  submits the finalized plan by calling `resolve { action: "apply", extra: { title } }`;
	 *  this handler validates the plan file exists, normalizes the title, and shapes the
	 *  payload that `event-controller` forwards to `handlePlanApproval`. */
	#runPlanApprovalResolve(input: unknown): Promise<AgentToolResult<ResolveToolDetails>> {
		return runResolveInvocation(input as Parameters<typeof runResolveInvocation>[0], {
			sourceToolName: "plan_approval",
			label: "Plan ready for approval",
			apply: async (_reason, extra) => {
				const state = this.session.getPlanModeState?.();
				if (!state?.enabled) {
					throw new ToolError("Plan mode is not active.");
				}
				const planFilePath = state.planFilePath;
				const planContent = await this.#readPlanFile(planFilePath);
				if (planContent === null) {
					throw new ToolError(
						`Plan file not found at ${planFilePath}. Write the finalized plan to ${planFilePath} before requesting approval.`,
					);
				}
				const normalized = resolvePlanTitle({
					suppliedTitle: extra?.title,
					planContent,
					planFilePath,
				});
				const details: PlanApprovalDetails = {
					planFilePath,
					finalPlanFilePath: `local://${normalized.fileName}`,
					title: normalized.title,
					planExists: true,
				};
				return {
					content: [{ type: "text" as const, text: "Plan ready for approval." }],
					details,
				};
			},
		});
	}

	async #exitPlanMode(options?: { silent?: boolean; paused?: boolean }): Promise<void> {
		if (!this.planModeEnabled) {
			return;
		}

		// Leaving plan mode invalidates the plan-mode steering and standing
		// resolve handler that the in-flight turn may still be acting on. Abort
		// before clearing that state so the model cannot continue from stale
		// plan-mode context and retry `resolve` against a retired handler.
		await this.session.abort({ timeoutMs: INTERACTIVE_ABORT_CLEANUP_TIMEOUT_MS });

		const previousTools = this.#planModePreviousTools;
		if (previousTools && previousTools.length > 0) {
			await this.session.setActiveToolsByName(previousTools);
		}
		if (this.#planModePreviousModelState) {
			const prev = this.#planModePreviousModelState;
			if (modelsAreEqual(this.session.model, prev.model)) {
				// Same model — only thinking level may differ. Avoid setModelTemporary()
				// which would reset provider-side sessions (openai-responses/OpenAI code backend) and
				// break conversation continuity.
				this.session.setThinkingLevel(prev.thinkingLevel);
			} else if (this.session.isStreaming) {
				this.#pendingModelSwitch = { model: prev.model, thinkingLevel: prev.thinkingLevel };
			} else {
				await this.session.setModelTemporary(prev.model, prev.thinkingLevel);
			}
			// If #applyPlanModeModel queued a deferred switch to the plan-role model
			// (because the session was streaming on entry), drop it now: we are
			// leaving plan mode, so flushing it on the next agent_end would land the
			// session on the plan-role model after the user has exited plan mode
			// (issue #816). Only clear when the pending target matches the plan-role
			// model — leave any unrelated user-queued switch intact.
			const pending = this.#pendingModelSwitch;
			if (pending) {
				const planResolution = this.session.resolveRoleModelWithThinking("plan");
				if (planResolution.model && modelsAreEqual(pending.model, planResolution.model)) {
					this.#pendingModelSwitch = undefined;
				}
			}
		}
		this.session.setStandingResolveHandler?.(null);
		this.session.setPlanModeState(undefined);
		this.planModeEnabled = false;
		this.planModePaused = options?.paused ?? false;
		this.planModePlanFilePath = undefined;
		this.#planModePreviousTools = undefined;
		this.#planModePreviousModelState = undefined;
		this.#updatePlanModeStatus();
		const paused = options?.paused ?? false;
		this.sessionManager.appendModeChange(paused ? "plan_paused" : "none");
		if (!options?.silent) {
			this.showStatus(paused ? "Plan mode paused." : "Plan mode disabled.");
		}
	}

	async #enterGoalMode(options: { objective?: string; resume?: boolean; silent?: boolean }): Promise<void> {
		if (this.goalModeEnabled) {
			return;
		}
		if (this.planModeEnabled || this.planModePaused) {
			this.showWarning("Exit plan mode first.");
			return;
		}
		const previousTools = this.session.getActiveToolNames();
		const goalTools = [...new Set([...previousTools, "goal"])];
		this.#goalModePreviousTools = previousTools;
		this.goalModePaused = false;
		const state = options.resume
			? await this.session.goalRuntime.resumeGoal()
			: await this.session.goalRuntime.createGoal({ objective: options.objective ?? "" });
		await this.session.setActiveToolsByName(goalTools);
		this.session.setGoalModeState(state);
		this.goalModeEnabled = true;
		this.#resetGoalContinuationSuppression();
		this.#updateGoalModeStatus();
		if (this.session.isStreaming) {
			await this.session.sendGoalModeContext({ deliverAs: "steer" });
		}
		if (!options.silent) {
			this.showStatus(options.resume ? "Goal mode resumed." : "Goal mode enabled.");
		}
	}

	async #exitGoalMode(options?: {
		silent?: boolean;
		paused?: boolean;
		reason?: "completed" | "paused" | "dropped";
	}): Promise<void> {
		const previousTools = this.#goalModePreviousTools;
		// Drop keeps the `goal` tool callable so the agent can immediately create a new
		// goal in the same session without a leader-side cleanup. Complete (and pause)
		// exit goal mode and restore the pre-goal tool set even when the goal_updated
		// event has already cleared goalModeEnabled (see #completeGoalFromTool emitting
		// state.enabled = false before #exitGoalMode runs). Spec: deep-interview-ultragoal-goal-tool-wiring AC1+AC2.
		const shouldRestoreTools =
			previousTools &&
			options?.reason !== "dropped" &&
			(this.goalModeEnabled || options?.reason === "completed" || options?.paused === true);
		if (shouldRestoreTools) {
			await this.session.setActiveToolsByName(previousTools);
		}
		const currentState = this.session.getGoalModeState();
		if (options?.reason === "completed") {
			this.session.setGoalModeState(undefined);
			this.sessionManager.appendModeChange("none");
			this.sessionManager.appendCustomEntry("goal-completed", {
				objective: currentState?.goal?.objective,
				tokensUsed: currentState?.goal?.tokensUsed,
				timeUsedSeconds: currentState?.goal?.timeUsedSeconds,
			});
		}
		this.goalModeEnabled = false;
		this.goalModePaused = options?.paused ?? false;
		this.#goalModePreviousTools = undefined;
		this.#goalContinuationTurnInFlight = false;
		this.#cancelGoalContinuation();
		this.#updateGoalModeStatus();
		if (!options?.silent) {
			if (options?.reason === "completed") {
				this.showStatus("Goal mode completed.");
			} else if (options?.reason === "dropped") {
				this.showStatus("Goal dropped.");
			} else if (options?.paused) {
				this.showStatus("Goal mode paused.");
			} else {
				this.showStatus("Goal mode disabled.");
			}
		}
	}

	async #readPlanFile(planFilePath: string): Promise<string | null> {
		const resolvedPath = this.#resolvePlanFilePath(planFilePath);
		try {
			return await Bun.file(resolvedPath).text();
		} catch (error) {
			if (isEnoent(error)) {
				return null;
			}
			throw error;
		}
	}

	#renderPlanPreview(planContent: string, options?: { append?: boolean }): void {
		const existingContainer = this.#planReviewContainer;
		const replaceExisting = options?.append !== true && existingContainer !== undefined;
		const planReviewContainer = replaceExisting ? existingContainer : new Container();
		planReviewContainer.clear();
		planReviewContainer.addChild(new Spacer(1));
		planReviewContainer.addChild(new DynamicBorder());
		planReviewContainer.addChild(new Text(theme.bold(theme.fg("accent", "Plan Review")), 1, 1));
		planReviewContainer.addChild(new Spacer(1));
		planReviewContainer.addChild(new Markdown(planContent, 1, 1, getMarkdownTheme()));
		planReviewContainer.addChild(new DynamicBorder());
		if (!replaceExisting) {
			this.chatContainer.addChild(planReviewContainer);
		}
		this.#planReviewContainer = planReviewContainer;
		this.ui.requestRender();
	}

	#getEditorTerminalPath(): string | null {
		if (process.platform === "win32") {
			return null;
		}
		return "/dev/tty";
	}

	async #openEditorTerminalHandle(): Promise<fs.FileHandle | null> {
		const terminalPath = this.#getEditorTerminalPath();
		if (!terminalPath) {
			return null;
		}
		try {
			return await fs.open(terminalPath, "r+");
		} catch {
			return null;
		}
	}

	#getPlanReviewHelpText(): string {
		const externalEditorKey = this.keybindings.getDisplayString("app.editor.external");
		if (!externalEditorKey) {
			return "up/down navigate  enter select  esc cancel";
		}
		return `up/down navigate  enter select  ${externalEditorKey.toLowerCase()} open in editor  esc cancel`;
	}

	async #openPlanInExternalEditor(planFilePath: string): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const resolvedPath = this.#resolvePlanFilePath(planFilePath);
		let currentText: string;
		try {
			currentText = await Bun.file(resolvedPath).text();
		} catch (error) {
			if (isEnoent(error)) {
				this.showError(`Plan file not found at ${planFilePath}`);
				return;
			}
			this.showWarning(`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		let ttyHandle: fs.FileHandle | null = null;
		try {
			ttyHandle = await this.#openEditorTerminalHandle();
			this.ui.stop();

			const stdio: [number | "inherit", number | "inherit", number | "inherit"] = ttyHandle
				? [ttyHandle.fd, ttyHandle.fd, ttyHandle.fd]
				: ["inherit", "inherit", "inherit"];

			const result = await openInEditor(editorCmd, currentText, {
				extension: path.extname(resolvedPath) || ".md",
				stdio,
				trimTrailingNewline: false,
			});
			if (result !== null) {
				await Bun.write(resolvedPath, result);
				this.#renderPlanPreview(result);
				this.showStatus("Plan updated in external editor.");
			}
		} catch (error) {
			this.showWarning(`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (ttyHandle) {
				await ttyHandle.close();
			}
			this.ui.start();
			this.ui.requestRender(true);
		}
	}

	async #approvePlan(
		planContent: string,
		options: {
			planFilePath: string;
			finalPlanFilePath: string;
			title: string;
			preserveContext?: boolean;
			compactBeforeExecute?: boolean;
		},
	): Promise<void> {
		await renameApprovedPlanFile({
			planFilePath: options.planFilePath,
			finalPlanFilePath: options.finalPlanFilePath,
			getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
			getSessionId: () => this.sessionManager.getSessionId(),
		});
		const previousTools = this.#planModePreviousTools ?? this.session.getActiveToolNames();

		// Mark the pending abort caused by the plan-mode → compaction transition as
		// silent BEFORE #exitPlanMode raises it. The `finally` below clears the
		// flag on every terminal compaction outcome (ok / cancelled / failed /
		// throw) so a leaked flag cannot silence a later unrelated abort.
		// Branchless mark+clear when !compactBeforeExecute: mark is gated; clear
		// is unconditional and idempotent.
		if (options.compactBeforeExecute) {
			this.session.markPlanCompactAbortPending();
		}
		let compactOutcome: CompactionOutcome | undefined;
		try {
			await this.#exitPlanMode({ silent: true, paused: false });

			if (!options.preserveContext) {
				await this.handleClearCommand();
				// The new session has a fresh local:// root — persist the approved plan there
				// so `local://<title>.md` resolves correctly in the execution session.
				const newLocalPath = resolveLocalUrlToPath(options.finalPlanFilePath, {
					getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
					getSessionId: () => this.sessionManager.getSessionId(),
				});
				await Bun.write(newLocalPath, planContent);
			} else if (options.compactBeforeExecute) {
				// Distill the plan-mode transcript before the execution turn is queued so
				// the plan-approved synthetic prompt lands as a fresh cache anchor.
				// Outcome is consumed after tool-restoration and plan-reference-path
				// bookkeeping below; `markPlanReferenceSent` is intentionally deferred
				// past the cancel guard — see the comment at the cancel branch.
				// Cancellation skips the synthetic-prompt dispatch (operator's explicit
				// abort is honored); failure proceeds best-effort — approval intent stands.
				const compactionPrompt = prompt.render(planModeCompactInstructionsPrompt, {
					planFilePath: options.finalPlanFilePath,
				});
				// Pin the plan reference path BEFORE compaction so any user messages
				// queued during the compaction await (which `handleCompactCommand`
				// flushes via `flushCompactionQueue` before returning) see the
				// approved plan in `#buildPlanReferenceMessage`. Reassignment after
				// the try/finally is idempotent and kept for the !compactBeforeExecute
				// branch.
				this.session.setPlanReferencePath(options.finalPlanFilePath);
				compactOutcome = await this.handleCompactCommand(compactionPrompt);
			}
		} finally {
			// Unconditional clear. Idempotent: a no-op when the flag was never set
			// (i.e., the !compactBeforeExecute branch), and a no-op when the flag
			// was already consumed by AgentSession.#handleAgentEvent's aborted
			// message_end stamping. Guarantees the flag is dead at every exit.
			this.session.clearPlanCompactAbortPending();
		}

		// Tool restoration runs on every path — the plan mode tools must be
		// retired regardless of whether the synthetic prompt fires.
		if (previousTools.length > 0) {
			await this.session.setActiveToolsByName(previousTools);
		}
		this.session.setPlanReferencePath(options.finalPlanFilePath);

		if (compactOutcome === "cancelled") {
			// Explicit abort: honor it. `executeCompaction` already surfaced
			// `showError("Compaction cancelled")` to the operator; we add the
			// deferred-dispatch warning and exit. `markPlanReferenceSent` is
			// intentionally skipped here: `#planReferenceSent` stays false, so
			// `AgentSession.#buildPlanReferenceMessage` will inject the plan
			// reference on the operator's next `prompt()` call. If we marked it
			// sent here, the executor's first turn would have no plan context.
			this.showWarning(
				"Plan approved, but compaction was cancelled — execution not dispatched. Submit a turn to continue.",
			);
			return;
		}

		// Approved plans land in a fresh (or compacted) session whose first user-visible
		// turn is the synthetic plan-approved prompt — that path bypasses the
		// input-controller's title generation. Seed an auto-name from the plan title
		// so the session is not left unnamed. `setSessionName("auto")` is a no-op
		// when the user has already chosen a name (preserveContext paths).
		const seededName = humanizePlanTitle(options.title);
		if (seededName && !this.sessionManager.getSessionName()) {
			const applied = await this.sessionManager.setSessionName(seededName, "auto");
			if (applied) {
				setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
				this.updateEditorChrome();
			}
		}

		// markPlanReferenceSent fires only on the dispatch path so the synthetic
		// plan-approved prompt is the source of the reference injection.
		this.session.markPlanReferenceSent();
		const planModePrompt = prompt.render(planModeApprovedPrompt, {
			planContent,
			finalPlanFilePath: options.finalPlanFilePath,
			contextPreserved: options.preserveContext === true,
			tools: this.session.getActiveToolNames(),
		});
		await this.session.prompt(planModePrompt, { synthetic: true });
	}

	async handlePlanModeCommand(initialPrompt?: string): Promise<void> {
		if (this.goalModeEnabled || this.goalModePaused) {
			this.showWarning("Exit goal mode first.");
			return;
		}
		if (this.planModeEnabled) {
			const confirmed = await this.showHookConfirm(
				"Exit plan mode?",
				"This exits plan mode without approving a plan.",
			);
			if (!confirmed) return;
			await this.#exitPlanMode({ paused: true });
			return;
		}
		if (!this.session.settings.get("plan.enabled")) {
			this.showWarning("Plan mode is disabled. Enable it in settings (plan.enabled).");
			return;
		}
		await this.#enterPlanMode();
		if (initialPrompt && this.onInputCallback) {
			this.onInputCallback(this.startPendingSubmission({ text: initialPrompt }));
		}
	}

	async handleGoalModeCommand(rest?: string): Promise<void> {
		try {
			if (this.planModeEnabled || this.planModePaused) {
				this.showWarning("Exit plan mode first.");
				return;
			}
			if (!this.session.settings.get("goal.enabled")) {
				this.showWarning("Goal mode is disabled. Enable it in settings (goal.enabled).");
				return;
			}
			const { sub, rest: subRest } = parseGoalSubcommand(rest ?? "");
			if (sub) {
				await this.#dispatchGoalSubcommand(sub, subRest);
				return;
			}
			if (this.goalModeEnabled) {
				if (subRest) {
					this.showStatus("Goal mode is already active. Use /goal to manage it, or /goal drop to start over.");
					return;
				}
				await this.#openGoalMenu("active");
				return;
			}
			const pausedState = this.#getPausedGoalState();
			if (pausedState) {
				if (subRest) {
					this.showWarning("Resume the current goal first, or drop it before setting a new objective.");
					return;
				}
				await this.#openGoalMenu("paused");
				return;
			}
			if (subRest) {
				await this.#startGoalFromObjective(subRest);
				return;
			}
			const objective = (
				await this.showHookEditor("Goal objective", undefined, undefined, { promptStyle: true })
			)?.trim();
			if (!objective) return;
			await this.#startGoalFromObjective(objective);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	async #dispatchGoalSubcommand(sub: GoalSubcommand, rest: string): Promise<void> {
		switch (sub) {
			case "set":
				await this.#handleGoalSetSubcommand(rest);
				return;
			case "show":
				this.#showGoalDetails();
				return;
			case "pause":
				await this.#pauseGoalAction();
				return;
			case "resume":
				await this.#resumeGoalAction();
				return;
			case "drop":
				await this.#confirmAndDropGoal();
				return;
		}
	}

	async #openGoalMenu(state: "active" | "paused"): Promise<void> {
		const goal = this.session.getGoalModeState()?.goal;
		if (!goal) return;
		const summary = goal.objective.length > 48 ? `${goal.objective.slice(0, 47)}…` : goal.objective;
		const title = state === "active" ? `Goal: ${summary} (${goal.status})` : `Goal paused: ${summary}`;
		const items = state === "active" ? ["Show details", "Pause", "Drop"] : ["Resume", "Show details", "Drop"];
		const choice = await this.showHookSelector(title, items);
		if (!choice) return;
		switch (choice) {
			case "Show details":
				this.#showGoalDetails();
				return;
			case "Pause":
				await this.#pauseGoalAction();
				return;
			case "Resume":
				await this.#resumeGoalAction();
				return;
			case "Drop":
				await this.#confirmAndDropGoal();
				return;
		}
	}

	#showGoalDetails(): void {
		const state = this.session.getGoalModeState();
		const goal = state?.goal;
		if (!goal) {
			this.showStatus("No goal set.");
			return;
		}
		const used = goal.tokensUsed.toLocaleString();
		const lines = [
			`Objective: ${goal.objective}`,
			`Status: ${goal.status}${state?.enabled ? "" : " (paused)"}`,
			`Tokens used: ${used}`,
			`Time spent: ${formatDuration(goal.timeUsedSeconds * 1000)}`,
		];
		this.showStatus(lines.join("\n"));
	}

	async #pauseGoalAction(): Promise<void> {
		if (!this.goalModeEnabled) {
			this.showWarning("No active goal to pause.");
			return;
		}
		await this.session.goalRuntime.pauseGoal();
		await this.#exitGoalMode({ paused: true, reason: "paused" });
	}

	async #resumeGoalAction(): Promise<void> {
		if (!this.#getPausedGoalState()) {
			this.showWarning("No paused goal to resume.");
			return;
		}
		await this.#enterGoalMode({ resume: true, silent: true });
		this.showStatus("Goal mode resumed.");
		this.#scheduleGoalContinuation();
	}

	async #confirmAndDropGoal(): Promise<void> {
		if (!this.goalModeEnabled && !this.#getPausedGoalState()) {
			this.showWarning("No goal to drop.");
			return;
		}
		const confirmed = await this.showHookConfirm(
			"Drop goal?",
			"This removes the goal record. Accumulated usage stays in the session log.",
		);
		if (!confirmed) return;
		await this.session.goalRuntime.dropGoal();
		await this.#exitGoalMode({ reason: "dropped" });
	}

	async #startGoalFromObjective(objective: string): Promise<void> {
		await this.#enterGoalMode({ objective, silent: true });
		this.#resetGoalContinuationSuppression();
		if (this.onInputCallback) {
			this.onInputCallback(this.startPendingSubmission({ text: objective }));
		}
	}

	async #replaceGoalFromObjective(objective: string): Promise<void> {
		const state = await this.session.goalRuntime.replaceGoal({ objective });
		this.session.setGoalModeState(state);
		this.goalModeEnabled = true;
		this.goalModePaused = false;
		this.#resetGoalContinuationSuppression();
		this.#updateGoalModeStatus();
		if (this.session.isStreaming) {
			await this.session.sendGoalModeContext({ deliverAs: "steer" });
		}
		if (this.onInputCallback) {
			this.onInputCallback(this.startPendingSubmission({ text: objective }));
		}
	}

	async #handleGoalSetSubcommand(rest: string): Promise<void> {
		if (!this.goalModeEnabled && this.#getPausedGoalState()) {
			this.showWarning("Resume the current goal first, or drop it before setting a new objective.");
			return;
		}
		const objective = rest.trim()
			? rest.trim()
			: (await this.showHookEditor("Goal objective", undefined, undefined, { promptStyle: true }))?.trim();
		if (!objective) return;
		if (this.goalModeEnabled) {
			await this.#replaceGoalFromObjective(objective);
			return;
		}
		await this.#startGoalFromObjective(objective);
	}

	async handlePlanApproval(details: PlanApprovalDetails): Promise<void> {
		if (!this.planModeEnabled) {
			this.showWarning("Plan mode is not active.");
			return;
		}

		// Abort the agent to prevent it from continuing (e.g., re-submitting the
		// plan) while the popup is showing. The event listener fires asynchronously
		// (agent's #emit is fire-and-forget), so without this the model sees
		// "Plan ready for approval." and immediately re-invokes `resolve` in a loop.
		await this.session.abort({ timeoutMs: INTERACTIVE_ABORT_CLEANUP_TIMEOUT_MS });

		const planFilePath = details.planFilePath || this.planModePlanFilePath || (await this.#getPlanFilePath());
		this.planModePlanFilePath = planFilePath;
		const planContent = await this.#readPlanFile(planFilePath);
		if (!planContent) {
			this.showError(`Plan file not found at ${planFilePath}`);
			return;
		}

		this.#renderPlanPreview(planContent, { append: true });
		const choice = await this.showHookSelector(
			"Plan mode - next step",
			["Approve and execute", "Approve and compact context", "Approve and keep context", "Refine plan"],
			{
				helpText: this.#getPlanReviewHelpText(),
				onExternalEditor: () => void this.#openPlanInExternalEditor(planFilePath),
			},
		);

		if (
			choice === "Approve and execute" ||
			choice === "Approve and compact context" ||
			choice === "Approve and keep context"
		) {
			const finalPlanFilePath = details.finalPlanFilePath || planFilePath;
			try {
				const latestPlanContent = await this.#readPlanFile(planFilePath);
				if (!latestPlanContent) {
					this.showError(`Plan file not found at ${planFilePath}`);
					return;
				}
				await this.#approvePlan(latestPlanContent, {
					planFilePath,
					finalPlanFilePath,
					title: details.title,
					preserveContext: choice !== "Approve and execute",
					compactBeforeExecute: choice === "Approve and compact context",
				});
			} catch (error) {
				this.showError(
					`Failed to finalize approved plan: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return;
		}
	}

	stop(): void {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.#welcomeComponent?.dispose();
		this.#welcomeComponent = undefined;
		this.#cleanupMicAnimation();
		this.#cancelGoalContinuation();
		if (this.#sttController) {
			this.#sttController.dispose();
			this.#sttController = undefined;
		}
		this.#extensionUiController.clearExtensionTerminalInputListeners();
		this.#extensionUiController.clearHookWidgets();
		for (const unsubscribe of this.#eventBusUnsubscribers) {
			unsubscribe();
		}
		this.#eventBusUnsubscribers = [];
		this.#observerRegistry.dispose();
		this.#eventController.dispose();
		this.statusLine.dispose();
		this.#jobsObserver?.dispose();
		this.editor.dispose();
		if (this.#resizeHandler) {
			process.stdout.removeListener("resize", this.#resizeHandler);
			this.#resizeHandler = undefined;
		}
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.#cleanupUnsubscribe) {
			this.#cleanupUnsubscribe();
		}
		if (this.#subprocessTeardownUnsubscribe) {
			this.#subprocessTeardownUnsubscribe();
		}
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}

	async shutdown(): Promise<void> {
		if (this.#isShuttingDown) return;
		this.#isShuttingDown = true;

		// Snapshot the editor before any teardown empties it. Persisting the draft
		// here covers Ctrl+D shutdown with non-empty text; for /exit the editor is
		// already cleared so saveDraft("") just removes any stale sidecar.
		const draftText = this.editor.getText();

		// Flush pending session writes before shutdown
		await this.sessionManager.flush();
		try {
			await this.sessionManager.saveDraft(draftText);
		} catch (err) {
			logger.warn("Failed to save session draft", { error: String(err) });
		}
		this.#btwController.dispose();

		// Emit shutdown event to hooks
		await this.session.dispose();

		if (this.isInitialized) {
			this.ui.requestRender(true);
		}

		// Wait for any pending renders to complete
		// requestRender() uses process.nextTick(), so we wait one tick
		await new Promise(resolve => process.nextTick(resolve));

		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);
		popTerminalTitle();
		this.stop();

		// Print resumption hint if this is a persisted session
		const sessionId = this.sessionManager.getSessionId();
		const sessionFile = this.sessionManager.getSessionFile();
		if (sessionId && sessionFile) {
			process.stderr.write(
				`\n${chalk.dim("Resume this session with:")}\n${chalk.dim(`${APP_NAME} --resume ${sessionId}`)}\n`,
			);
		}

		await postmortem.quit(0);
	}

	async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	// Extension UI integration
	setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#toolUiContextSetter(uiContext, hasUI);
	}

	initializeHookRunner(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#extensionUiController.initializeHookRunner(uiContext, hasUI);
	}
	createBackgroundUiContext(): ExtensionUIContext {
		return this.#extensionUiController.createBackgroundUiContext();
	}

	setEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) | undefined,
	): void {
		const previousEditor = this.editor;
		const previousText = previousEditor.getText();
		const nextEditor = factory
			? factory(this.ui, getEditorTheme(), this.keybindings)
			: new CustomEditor(getEditorTheme());

		configureDefaultComposerChrome(nextEditor);
		nextEditor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		nextEditor.setAutocompleteMaxVisible(this.settings.get("autocompleteMaxVisible"));
		nextEditor.onAutocompleteCancel = () => {
			this.ui.requestRender();
		};
		nextEditor.onAutocompleteUpdate = () => {
			this.ui.requestRender();
		};
		nextEditor.setMaxHeight(this.#computeEditorMaxHeight());
		if (this.historyStorage) {
			nextEditor.setHistoryStorage(this.historyStorage);
		}
		nextEditor.setText(previousText);
		previousEditor.dispose();

		this.editorContainer.clear();
		this.editor = nextEditor;
		this.editorContainer.addChild(nextEditor);
		this.ui.setFocus(nextEditor);

		this.#inputController.setupKeyHandlers();
		this.#inputController.setupEditorSubmitHandler();

		void this.refreshSlashCommandState().catch(error => {
			logger.warn("Failed to refresh slash command state for custom editor", { error: String(error) });
		});

		this.updateEditorChrome();
		this.ui.requestRender();
	}

	// Event handling
	async handleBackgroundEvent(event: AgentSessionEvent): Promise<void> {
		await this.#eventController.handleBackgroundEvent(event);
	}

	// UI helpers
	showStatus(message: string, options?: { dim?: boolean }): void {
		this.#uiHelpers.showStatus(message, options);
	}

	showError(message: string): void {
		this.#pendingSubmittedInput = undefined;
		this.optimisticUserMessageSignature = undefined;
		this.#pendingSubmissionDispose?.();
		this.#pendingSubmissionDispose = undefined;
		this.#pendingWorkingMessage = undefined;
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
			this.statusContainer.clear();
		}
		this.#uiHelpers.showError(message);
	}

	showWarning(message: string): void {
		this.#uiHelpers.showWarning(message);
	}

	#handleLspStartupEvent(event: LspStartupEvent): void {
		this.#updateWelcomeLspServers();

		const warningMessage = getLspStartupWarningMessage(event);
		if (warningMessage) {
			this.showWarning(warningMessage);
		}
	}

	#getWelcomeLspServers(): WelcomeLspServerInfo[] {
		return (
			this.lspServers?.map(server => ({
				name: server.name,
				status: server.status,
				fileTypes: server.fileTypes,
			})) ?? []
		);
	}

	#updateWelcomeLspServers(): void {
		if (!this.#welcomeComponent) {
			return;
		}

		this.#welcomeComponent.setLspServers(this.#getWelcomeLspServers());
		this.ui.requestRender();
	}

	#getWorkingMessageAccent(): WorkingMessageAccent | undefined {
		const accentEnabled = !isSettingsInitialized() || settings.get("statusLine.sessionAccent") !== false;
		const sessionName = accentEnabled ? this.sessionManager.getSessionName() : undefined;
		if (!sessionName) return undefined;
		const hex = getSessionAccentHex(sessionName);
		const main = getSessionAccentAnsi(hex);
		const dim = getSessionAccentAnsi(adjustHsv(hex, { s: 0.55, v: 0.65 }));
		return main && dim ? { main, dim } : undefined;
	}

	ensureLoadingAnimation(): void {
		if (!this.loadingAnimation) {
			this.statusContainer.clear();
			this.loadingAnimation = new Loader(
				this.ui,
				spinner => {
					const accent = this.#getWorkingMessageAccent();
					return accent ? `${accent.main}${spinner}\x1b[39m` : theme.fg("accent", spinner);
				},
				message => renderWorkingMessage(message, this.#getWorkingMessageAccent()),
				this.#defaultWorkingMessage,
				getSymbolTheme().spinnerFrames,
				{ timeDependentColor: true },
			);
			this.statusContainer.addChild(this.loadingAnimation);
		}

		this.applyPendingWorkingMessage();
	}

	setWorkingMessage(message?: string): void {
		if (message === undefined) {
			this.#pendingWorkingMessage = undefined;
			if (this.loadingAnimation) {
				this.loadingAnimation.setMessage(this.#defaultWorkingMessage);
			}
			return;
		}

		if (this.loadingAnimation) {
			this.loadingAnimation.setMessage(message);
			return;
		}

		this.#pendingWorkingMessage = message;
	}

	applyPendingWorkingMessage(): void {
		if (this.#pendingWorkingMessage === undefined) {
			return;
		}

		const message = this.#pendingWorkingMessage;
		this.#pendingWorkingMessage = undefined;
		this.setWorkingMessage(message);
	}

	showNewVersionNotification(newVersion: string): void {
		this.#uiHelpers.showNewVersionNotification(newVersion);
	}

	clearEditor(): void {
		this.#uiHelpers.clearEditor();
	}

	updatePendingMessagesDisplay(): void {
		this.#uiHelpers.updatePendingMessagesDisplay();
	}

	queueCompactionMessage(text: string, mode: "steer" | "followUp"): void {
		this.#uiHelpers.queueCompactionMessage(text, mode);
	}

	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		return this.#uiHelpers.flushCompactionQueue(options);
	}

	flushPendingBashComponents(): void {
		this.#uiHelpers.flushPendingBashComponents();
	}

	isKnownSlashCommand(text: string): boolean {
		return this.#uiHelpers.isKnownSlashCommand(text);
	}

	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): Component[] {
		return this.#uiHelpers.addMessageToChat(message, options);
	}

	renderSessionContext(
		sessionContext: SessionContext,
		options?: { updateFooter?: boolean; populateHistory?: boolean },
	): void {
		this.#uiHelpers.renderSessionContext(sessionContext, options);
	}

	renderInitialMessages(prebuiltContext?: SessionContext, options?: { preserveExistingChat?: boolean }): void {
		this.#uiHelpers.renderInitialMessages(prebuiltContext, options);
	}

	getUserMessageText(message: Message): string {
		return this.#uiHelpers.getUserMessageText(message);
	}

	findLastAssistantMessage(): AssistantMessage | undefined {
		return this.#uiHelpers.findLastAssistantMessage();
	}

	extractAssistantText(message: AssistantMessage): string {
		return this.#uiHelpers.extractAssistantText(message);
	}

	// Command handling
	handleExportCommand(text: string): Promise<void> {
		return this.#commandController.handleExportCommand(text);
	}

	handleDumpCommand() {
		return this.#commandController.handleDumpCommand();
	}

	handleDebugTranscriptCommand(): Promise<void> {
		return this.#commandController.handleDebugTranscriptCommand();
	}

	handleShareCommand(): Promise<void> {
		return this.#commandController.handleShareCommand();
	}

	handleCopyCommand(sub?: string) {
		return this.#commandController.handleCopyCommand(sub);
	}

	handleTodoCommand(args: string): Promise<void> {
		return this.#todoCommandController.handleTodoCommand(args);
	}

	handleSessionCommand(): Promise<void> {
		return this.#commandController.handleSessionCommand();
	}

	handleJobsCommand(): Promise<void> {
		return this.#commandController.handleJobsCommand();
	}

	handleUsageCommand(reports?: UsageReport[] | null): Promise<void> {
		return this.#commandController.handleUsageCommand(reports);
	}

	async handleChangelogCommand(showFull = false): Promise<void> {
		await this.#commandController.handleChangelogCommand(showFull);
	}

	handleHotkeysCommand(): void {
		this.#commandController.handleHotkeysCommand();
	}

	handleHelpCommand(): void {
		this.#commandController.handleHelpCommand();
	}

	handleToolsCommand(): void {
		this.#commandController.handleToolsCommand();
	}

	handleContextCommand(): void {
		this.#commandController.handleContextCommand();
	}

	#prepareSessionSwitch(): void {
		this.#btwController.dispose();
		this.#extensionUiController.clearExtensionTerminalInputListeners();
		this.#planReviewContainer = undefined;
	}

	handleClearCommand(): Promise<void> {
		this.#prepareSessionSwitch();
		return this.#commandController.handleClearCommand();
	}

	handleContextClearCommand(): Promise<void> {
		this.#prepareSessionSwitch();
		return this.#commandController.handleContextClearCommand();
	}

	handleDropCommand(): Promise<void> {
		this.#prepareSessionSwitch();
		return this.#commandController.handleDropCommand();
	}

	handleForkCommand(): Promise<void> {
		this.#btwController.dispose();
		return this.#commandController.handleForkCommand();
	}

	handleMoveCommand(targetPath: string): Promise<void> {
		return this.#commandController.handleMoveCommand(targetPath);
	}

	handleRenameCommand(title: string): Promise<void> {
		return this.#commandController.handleRenameCommand(title);
	}

	handleMemoryCommand(text: string): Promise<void> {
		return this.#commandController.handleMemoryCommand(text);
	}

	async handleSTTToggle(): Promise<void> {
		if (!settings.get("stt.enabled")) {
			this.showWarning("Speech-to-text is disabled. Enable it in settings: stt.enabled");
			return;
		}
		if (!this.#sttController) {
			this.#sttController = new STTController();
		}
		await this.#sttController.toggle(this.editor, {
			showWarning: (msg: string) => this.showWarning(msg),
			showStatus: (msg: string) => this.showStatus(msg),
			onStateChange: (state: SttState) => {
				if (state === "recording") {
					this.#voicePreviousShowHardwareCursor = this.ui.getShowHardwareCursor();
					this.#voicePreviousUseTerminalCursor = this.editor.getUseTerminalCursor();
					this.ui.setShowHardwareCursor(false);
					this.editor.setUseTerminalCursor(false);
					this.#startMicAnimation();
				} else if (state === "transcribing") {
					this.#stopMicAnimation();
					this.#setMicCursor({ r: 200, g: 200, b: 200 });
				} else {
					this.#cleanupMicAnimation();
				}
				this.updateEditorChrome();
				this.ui.requestRender();
			},
		});
	}

	#setMicCursor(color: { r: number; g: number; b: number }): void {
		this.editor.cursorOverride = `\x1b[38;2;${color.r};${color.g};${color.b}m${theme.icon.mic}\x1b[0m`;
		// Theme symbols can be wide (for example, 🎤), so measure the rendered override.
		this.editor.cursorOverrideWidth = visibleWidth(this.editor.cursorOverride);
	}

	#updateMicIcon(): void {
		const { r, g, b } = hsvToRgb({ h: this.#voiceHue, s: 0.9, v: 1.0 });
		this.#setMicCursor({ r, g, b });
	}

	#startMicAnimation(): void {
		if (this.#voiceAnimationInterval) return;
		this.#voiceHue = 0;
		this.#updateMicIcon();
		this.#voiceAnimationInterval = setInterval(() => {
			this.#voiceHue = (this.#voiceHue + 8) % 360;
			this.#updateMicIcon();
			this.ui.requestRender();
		}, 60);
	}

	#stopMicAnimation(): void {
		if (this.#voiceAnimationInterval) {
			clearInterval(this.#voiceAnimationInterval);
			this.#voiceAnimationInterval = undefined;
		}
	}

	#cleanupMicAnimation(): void {
		if (this.#voiceAnimationInterval) {
			clearInterval(this.#voiceAnimationInterval);
			this.#voiceAnimationInterval = undefined;
		}
		this.editor.cursorOverride = undefined;
		this.editor.cursorOverrideWidth = undefined;
		if (this.#voicePreviousShowHardwareCursor !== null) {
			this.ui.setShowHardwareCursor(this.#voicePreviousShowHardwareCursor);
			this.#voicePreviousShowHardwareCursor = null;
		}
		if (this.#voicePreviousUseTerminalCursor !== null) {
			this.editor.setUseTerminalCursor(this.#voicePreviousUseTerminalCursor);
			this.#voicePreviousUseTerminalCursor = null;
		}
	}

	showDebugSelector(): void {
		this.#selectorController.showDebugSelector();
	}

	showSessionObserver(): void {
		const sessions = this.#observerRegistry.getSessions();
		if (sessions.length <= 1) {
			this.showStatus("No active subagent sessions");
			return;
		}
		this.#selectorController.showSessionObserver(this.#observerRegistry);
	}

	showJobsOverlay(): void {
		if (!this.#jobsObserver) {
			this.showStatus("Background jobs are unavailable in this session");
			return;
		}
		this.#selectorController.showJobsOverlay(this.#jobsObserver);
	}

	resetObserverRegistry(): void {
		this.#observerRegistry.resetSessions();
		this.#observerRegistry.setMainSession(this.sessionManager.getSessionFile() ?? undefined);
	}

	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void> {
		return this.#commandController.handleBashCommand(command, excludeFromContext);
	}

	handlePythonCommand(code: string, excludeFromContext?: boolean): Promise<void> {
		return this.#commandController.handlePythonCommand(code, excludeFromContext);
	}

	async handleMCPCommand(_text: string): Promise<void> {
		this.showWarning(`MCP commands are not available in ${APP_NAME}.`);
	}

	async handleSSHCommand(text: string): Promise<void> {
		const controller = new SSHCommandController(this);
		await controller.handle(text);
	}

	handleCompactCommand(customInstructions?: string): Promise<CompactionOutcome> {
		return this.#commandController.handleCompactCommand(customInstructions);
	}

	handleHandoffCommand(customInstructions?: string): Promise<void> {
		return this.#commandController.handleHandoffCommand(customInstructions);
	}

	handleContributionPrepCommand(customInstructions?: string): Promise<void> {
		return this.#commandController.handleContributionPrepCommand(customInstructions);
	}

	executeCompaction(
		customInstructionsOrOptions?: string | CompactOptions,
		isAuto?: boolean,
	): Promise<CompactionOutcome> {
		return this.#commandController.executeCompaction(customInstructionsOrOptions, isAuto);
	}

	openInBrowser(urlOrPath: string): void {
		this.#commandController.openInBrowser(urlOrPath);
	}

	// Selector handling
	showSettingsSelector(): void {
		this.#selectorController.showSettingsSelector();
	}

	showThemeSelector(): void {
		this.#selectorController.showThemeSelector();
	}

	showHistorySearch(): void {
		this.#selectorController.showHistorySearch();
	}

	showExtensionsDashboard(): void {
		void this.#selectorController.showExtensionsDashboard();
	}

	showAgentsDashboard(): void {
		void this.#selectorController.showAgentsDashboard();
	}

	showModelSelector(options?: { temporaryOnly?: boolean }): void {
		this.#selectorController.showModelSelector(options);
	}

	showEffortSelector(): void {
		this.#selectorController.showEffortSelector();
	}

	showProviderOnboarding(): void {
		this.#selectorController.showProviderOnboarding();
	}

	showPluginSelector(mode?: "install" | "uninstall"): void {
		void this.#selectorController.showPluginSelector(mode);
	}

	showUserMessageSelector(): void {
		this.#selectorController.showUserMessageSelector();
	}

	showTreeSelector(): void {
		this.#selectorController.showTreeSelector();
	}

	showSessionSelector(): void {
		this.#selectorController.showSessionSelector();
	}

	handleResumeSession(sessionPath: string): Promise<void> {
		this.#btwController.dispose();
		this.resetObserverRegistry();
		return this.#selectorController.handleResumeSession(sessionPath);
	}

	handleSessionDeleteCommand(): Promise<void> {
		return this.#selectorController.handleSessionDeleteCommand();
	}

	showOAuthSelector(
		mode: "login" | "logout",
		providerId?: string,
		options?: import("./types").OAuthSelectorOptions,
	): Promise<void> {
		return this.#selectorController.showOAuthSelector(mode, providerId, options);
	}

	showHookConfirm(title: string, message: string): Promise<boolean> {
		return this.#extensionUiController.showHookConfirm(title, message);
	}

	// Input handling
	handleCtrlC(): void {
		this.#inputController.handleCtrlC();
	}

	handleCtrlD(): void {
		this.#inputController.handleCtrlD();
	}

	handleCtrlZ(): void {
		this.#inputController.handleCtrlZ();
	}

	handleDequeue(): void {
		this.#inputController.handleDequeue();
	}

	handleBackgroundCommand(): void {
		this.#inputController.handleBackgroundCommand();
	}

	handleImagePaste(): Promise<boolean> {
		return this.#inputController.handleImagePaste();
	}

	handleBtwCommand(question: string): Promise<void> {
		return this.#btwController.start(question);
	}

	hasActiveBtw(): boolean {
		return this.#btwController.hasActiveRequest();
	}

	handleBtwEscape(): boolean {
		return this.#btwController.handleEscape();
	}

	cycleThinkingLevel(): void {
		this.#inputController.cycleThinkingLevel();
	}

	cycleRoleModel(options?: { temporary?: boolean }): Promise<void> {
		return this.#inputController.cycleRoleModel(options);
	}

	toggleToolOutputExpansion(): void {
		this.#inputController.toggleToolOutputExpansion();
	}

	setToolsExpanded(expanded: boolean): void {
		this.#inputController.setToolsExpanded(expanded);
	}

	toggleThinkingBlockVisibility(): void {
		this.#inputController.toggleThinkingBlockVisibility();
	}

	toggleTodoExpansion(): void {
		this.todoExpanded = !this.todoExpanded;
		this.#renderTodoList();
		this.ui.requestRender();
	}

	setTodos(todos: TodoItem[] | TodoPhase[]): void {
		if (todos.length > 0 && "tasks" in todos[0]) {
			this.todoPhases = todos as TodoPhase[];
		} else {
			this.todoPhases = [
				{
					name: "Todos",
					tasks: todos as TodoItem[],
				},
			];
		}
		this.#renderTodoList();
		this.ui.requestRender();
	}

	async reloadTodos(): Promise<void> {
		await this.#loadTodoList();
		this.ui.requestRender();
	}

	openExternalEditor(): void {
		this.#inputController.openExternalEditor();
	}

	registerExtensionShortcuts(): void {
		this.#inputController.registerExtensionShortcuts();
	}

	// Hook UI methods
	initHooksAndCustomTools(): Promise<void> {
		return this.#extensionUiController.initHooksAndCustomTools();
	}

	emitCustomToolSessionEvent(
		reason: "start" | "switch" | "branch" | "tree" | "shutdown",
		previousSessionFile?: string,
	): Promise<void> {
		return this.#extensionUiController.emitCustomToolSessionEvent(reason, previousSessionFile);
	}

	setHookWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void {
		this.#extensionUiController.setHookWidget(key, content, options);
	}

	setHookStatus(key: string, text: string | undefined): void {
		this.#extensionUiController.setHookStatus(key, text);
	}

	showHookSelector(
		title: string,
		options: string[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return this.#extensionUiController.showHookSelector(title, options, dialogOptions);
	}

	hideHookSelector(): void {
		this.#extensionUiController.hideHookSelector();
	}

	showHookInput(
		title: string,
		placeholder?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		inputOptions?: { readonly initialValue?: string },
	): Promise<string | undefined> {
		return this.#extensionUiController.showHookInput(title, placeholder, dialogOptions, inputOptions);
	}

	hideHookInput(): void {
		this.#extensionUiController.hideHookInput();
	}

	showHookEditor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		return this.#extensionUiController.showHookEditor(title, prefill, dialogOptions, editorOptions);
	}

	hideHookEditor(): void {
		this.#extensionUiController.hideHookEditor();
	}

	showHookNotify(message: string, type?: "info" | "warning" | "error"): void {
		this.#extensionUiController.showHookNotify(message, type);
	}

	showHookCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: { overlay?: boolean },
	): Promise<T> {
		return this.#extensionUiController.showHookCustom(factory, options);
	}

	showExtensionError(extensionPath: string, error: string): void {
		this.#extensionUiController.showExtensionError(extensionPath, error);
	}

	showToolError(toolName: string, error: string): void {
		this.#extensionUiController.showToolError(toolName, error);
	}

	#subscribeToAgent(): void {
		this.#eventController.subscribeToAgent();
	}
}
