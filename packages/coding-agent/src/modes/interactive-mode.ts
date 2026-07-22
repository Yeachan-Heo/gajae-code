import { type Agent, type AgentMessage, ThinkingLevel } from "@gajae-code/agent-core";
import type { CompactionOutcome } from "@gajae-code/agent-core/compaction";
import type { AssistantMessage, ImageContent, Message, UsageReport } from "@gajae-code/ai";
import type { Component, EditorTheme, SlashCommand } from "@gajae-code/tui";
import {
	Container,
	clearRenderCache,
	getRenderCacheRetainedBytes,
	Loader,
	onImageProtocolChanged,
	ProcessTerminal,
	Spacer,
	Text,
	TUI,
} from "@gajae-code/tui";
import { APP_NAME, adjustHsv, getProjectDir, logger, postmortem } from "@gajae-code/utils";
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
import { getLspStartupWarningMessage, LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "../lsp/startup-events";
import {
	createStarReminderBeforeAgentStartContributor,
	scheduleLaunchStarReminderAfterFirstRender,
	starReminderLaunchGate,
} from "../reminders/star-reminder";
import type { NotificationSessionReconcileResult, NotificationSessionStatus } from "../sdk/bus/session-control";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { HistoryStorage } from "../session/history-storage";
import type { SessionContext, SessionManager } from "../session/session-manager";
import { getRecentSessions, getSessionMessageEntryId } from "../session/session-manager";
import type { LspStartupServerInfo } from "../tools";
import { formatPhaseDisplayName } from "../tools/todo-write";
import type { EventBus } from "../utils/event-bus";
import { getSessionAccentAnsi, getSessionAccentHex } from "../utils/session-color";
import { popTerminalTitle, pushTerminalTitle, setSessionTerminalTitle } from "../utils/title-generator";
import type { AssistantMessageComponent } from "./components/assistant-message";
import type { BashExecutionComponent } from "./components/bash-execution";
import type { CommandPaletteAction } from "./components/command-palette";
import { CustomEditor } from "./components/custom-editor";
import type { EvalExecutionComponent } from "./components/eval-execution";
import { GajaePetWidget, type PetMode } from "./components/gajae-pet-widget";
import type { HookEditorComponent } from "./components/hook-editor";
import type { HookInputComponent } from "./components/hook-input";
import type { HookSelectorComponent } from "./components/hook-selector";
import { IrcSplitViewComponent } from "./components/irc-sidebar";
import {
	getPetUnavailableWarning,
	isPetAvailable,
	isPetCapabilityProbePending,
	warnWhenPetCapabilitySettled,
} from "./components/pet-capability";
import type { ToolExecutionHandle } from "./components/tool-execution";
import { StatusLineComponent } from "./components/tool-status-header";
import { composeToolText } from "./components/tool-transcript-format";
import {
	WelcomeComponent,
	type WelcomeLogoMode,
	type LspServerInfo as WelcomeLspServerInfo,
} from "./components/welcome";
import { BtwController } from "./controllers/btw-controller";
import { CommandController } from "./controllers/command-controller";
import { EventController } from "./controllers/event-controller";
import { ExtensionUiController } from "./controllers/extension-ui-controller";
import { GoalModeController } from "./controllers/goal-mode-controller";
import { InputController } from "./controllers/input-controller";
import { ModeGate } from "./controllers/mode-gate";
import { PlanModeController } from "./controllers/plan-mode-controller";
import { SelectorController } from "./controllers/selector-controller";
import { SSHCommandController } from "./controllers/ssh-command-controller";
import { SttModeController } from "./controllers/stt-controller";
import { TodoCommandController } from "./controllers/todo-command-controller";
import { IrcObservationLedger } from "./irc-observation-ledger";
import { JobsObserver } from "./jobs-observer";
import { OAuthManualInputManager } from "./oauth-manual-input";
import { SessionObserverRegistry } from "./session-observer-registry";
import { interruptHint } from "./shared";
import { shouldShowExtensionCommand } from "./slash-command-visibility";
import { TasksAggregator } from "./tasks-aggregator";
import { type ShimmerPalette, shimmerSegments, shimmerText } from "./theme/shimmer";
import type { Theme } from "./theme/theme";
import { getEditorTheme, getSymbolTheme, onTerminalAppearanceChange, onThemeChange, theme } from "./theme/theme";
import { type RegisterTranscriptItem, TranscriptItemRegistry, transcriptItemId } from "./transcript-item-registry";
import {
	type CompactionQueuedMessage,
	type ComposerSubmissionOptions,
	canApplyComposerSubmission,
	type InteractiveModeContext,
	type IrcArrivalSnapshot,
	type SubmittedUserInput,
	type TodoItem,
	type TodoPhase,
	type TranscriptRebuildPolicy,
} from "./types";
import type { ParsedIrcMessage } from "./utils/irc-message";
import { addChatChild, prepareTranscriptRebuild, UiHelpers } from "./utils/ui-helpers";

const COMPOSER_NEWLINE_HINT = process.platform === "win32" ? "Alt+Enter/Ctrl+J" : "Shift+Enter/Ctrl+J";
export const DEFAULT_COMPOSER_PLACEHOLDER = `Type your message... ${COMPOSER_NEWLINE_HINT}: New line · Ctrl+C: Clear · Ctrl+R: Search history · Shift+Tab: Reasoning`;
const WELCOME_RESERVED_CONTAINER_CHILD_LIMIT = 8;

const IRC_SIDEBAR_TOGGLE_SHADOWING_ACTIONS: readonly AppKeybinding[] = [
	"app.plan.toggle",
	"app.session.new",
	"app.session.tree",
	"app.session.fork",
	"app.session.resume",
	"app.message.followUp",
	"app.stt.toggle",
	"app.clipboard.copyLine",
	"app.session.observe",
	"app.jobs.open",
	"app.tool.backgroundFold",
];

export function getWelcomeTranscriptReservedRows(chatContainer: Container, width: number): number {
	return chatContainer.children.length === 0 || chatContainer.children.length > WELCOME_RESERVED_CONTAINER_CHILD_LIMIT
		? 0
		: chatContainer.render(width).length;
}
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

export function selectShutdownDraft(editorText: string, hasActiveBtw: boolean): string {
	return hasActiveBtw ? "" : editorText;
}

export class InteractiveMode implements InteractiveModeContext {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	keybindings: KeybindingsManager;
	agent: Agent;
	historyStorage?: HistoryStorage;
	readonly ircLedger = new IrcObservationLedger();

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
	petFloorContainer: Container = new Container();
	petWidget: GajaePetWidget | undefined;
	statusLine: StatusLineComponent;

	isInitialized = false;
	isBackgrounded = false;
	isBashMode = false;
	isBashNoContext = false;
	toolOutputExpanded = false;
	todoExpanded = false;
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
	#resolvedSlashCommands: SlashCommand[] = [];
	#baseReservedSlashCommandNames: Set<string> = new Set();
	#cleanupUnsubscribe?: () => void;
	#subprocessTeardownUnsubscribe?: () => void;
	#petProtocolUnsubscribe?: () => void;
	/** Cancels a startup pet-unavailable warning still awaiting probe settlement. */
	#petUnavailableWarningDisposer?: () => void;
	readonly #version: string;
	readonly #changelogMarkdown: string | undefined;

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
	readonly #modeGate = new ModeGate();
	readonly #goalModeController: GoalModeController;
	readonly #planModeController: PlanModeController;
	#sttController: SttModeController | undefined;
	#resizeHandler?: () => void;
	#observerRegistry: SessionObserverRegistry;
	#transcriptRegistry = new TranscriptItemRegistry();

	/** Direct controller capabilities for consumers that coordinate mode transitions. */
	get planModeController(): PlanModeController {
		return this.#planModeController;
	}

	get goalModeController(): GoalModeController {
		return this.#goalModeController;
	}

	#jobsObserver?: JobsObserver;
	#tasksAggregator?: TasksAggregator;
	#eventBus?: EventBus;
	#eventBusUnsubscribers: Array<() => void> = [];
	#welcomeComponent?: WelcomeComponent;
	#ircSplitView: IrcSplitViewComponent;
	#ircSidebarAvailable = false;
	#ircSidebarRequestedVisible = false;

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
		this.session.setSdkPlanModeHandler(async on => {
			if (on && (this.#goalModeController.enabled || this.#goalModeController.paused)) {
				throw Object.assign(new Error("mode.plan.set could not enter plan mode while goal mode is active."), {
					code: "conflict",
				});
			}
			if (on) await this.#planModeController.enter();
			else await this.#planModeController.exit();
			const state = this.session.getPlanModeState();
			const applied = on
				? this.#planModeController.enabled && state?.enabled === true
				: !this.#planModeController.enabled && !this.#planModeController.paused && state === undefined;
			if (!applied) {
				throw Object.assign(
					new Error(`mode.plan.set could not ${on ? "enter" : "exit"} plan mode in the current lifecycle state.`),
					{
						code: "conflict",
					},
				);
			}
			return state;
		});
		this.session.setRetainedMemorySampler(() => ({
			tuiChatChildren: this.chatContainer.children.length,
			tuiCachedRenderBytes: getRenderCacheRetainedBytes(),
		}));
		this.settings = session.settings;
		this.keybindings = KeybindingsManager.inMemory();
		this.agent = session.agent;
		this.#version = version;
		this.#changelogMarkdown = changelogMarkdown;
		this.#toolUiContextSetter = setToolUIContext;
		this.lspServers = lspServers;
		this.mcpManager = mcpManager;
		this.#eventBus = eventBus;
		const thisMode = this;
		this.#goalModeController = new GoalModeController({
			session: this.session,
			sessionManager: this.sessionManager,
			modeGate: this.#modeGate,
			get planModeActive() {
				return thisMode.#planModeController.enabled || thisMode.#planModeController.paused;
			},
			get inputCallback() {
				return thisMode.onInputCallback;
			},
			get hasPendingSubmission() {
				return thisMode.#pendingSubmittedInput !== undefined;
			},
			get hasPendingImages() {
				return thisMode.pendingImages.length > 0;
			},
			get editorText() {
				return thisMode.editor.getText();
			},
			startPendingSubmission: input => thisMode.startPendingSubmission(input),
			showStatus: message => this.showStatus(message),
			showWarning: message => this.showWarning(message),
			showError: message => this.showError(message),
			showHookConfirm: (title, message) => this.showHookConfirm(title, message),
			showHookSelector: (title, options) => this.showHookSelector(title, options),
			showHookEditor: (title, options) => this.showHookEditor(title, undefined, undefined, options),
			updateGoalModeStatus: () => this.#updateGoalModeStatus(),
		});
		this.#planModeController = new PlanModeController({
			session: this.session,
			sessionManager: this.sessionManager,
			modeGate: this.#modeGate,
			get chatContainer() {
				return thisMode.chatContainer;
			},
			get inputCallback() {
				return thisMode.onInputCallback;
			},
			get externalEditorKey() {
				return thisMode.keybindings.getDisplayString("app.editor.external");
			},
			get externalEditorKeys() {
				return thisMode.keybindings.getKeys("app.editor.external");
			},
			startPendingSubmission: input => thisMode.startPendingSubmission(input),
			addChatChild: child => addChatChild(thisMode, child),
			requestRender: full => thisMode.ui.requestRender(full),
			stopUi: () => thisMode.ui.stop(),
			startUi: () => thisMode.ui.start(),
			showStatus: message => thisMode.showStatus(message),
			showWarning: message => thisMode.showWarning(message),
			showError: message => thisMode.showError(message),
			showHookConfirm: (title, message) => thisMode.showHookConfirm(title, message),
			showPlanPreview: (content, options) => thisMode.#selectorController.showPlanPreview(content, options),
			flushCompactionQueue: options => thisMode.flushCompactionQueue(options),
			updatePlanModeStatus: status => thisMode.#updatePlanModeStatus(status),
			handleClearCommand: () => thisMode.handleClearCommand(),
			handleCompactCommand: instructions => thisMode.handleCompactCommand(instructions),
			updateEditorChrome: () => thisMode.updateEditorChrome(),
		});
		if (eventBus) {
			this.#eventBusUnsubscribers.push(
				eventBus.on(LSP_STARTUP_EVENT_CHANNEL, data => {
					this.#handleLspStartupEvent(data as LspStartupEvent);
				}),
			);
		}

		this.ui = new TUI(new ProcessTerminal(), settings.get("showHardwareCursor"), {
			enableMouse: settings.get("mouse.enabled"),
		});
		this.ui.setClearOnShrink(settings.get("clearOnShrink"));
		this.chatContainer = new Container();
		this.#ircSplitView = new IrcSplitViewComponent(this.chatContainer, this.ircLedger, () => theme);
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
			this.#invalidateIrcSidebarRender();
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
		this.statusLine = new StatusLineComponent(session, { version: this.#version, focusDomain: "composer" });
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
		this.#resolvedSlashCommands = [...this.#baseSlashCommands, ...this.#rebuildSkillSlashCommands()];

		this.#uiHelpers = new UiHelpers(this);
		this.#btwController = new BtwController(this);
		this.#extensionUiController = new ExtensionUiController(this);
		this.#eventController = new EventController(this);
		this.#commandController = new CommandController(this);
		this.#todoCommandController = new TodoCommandController(this);
		this.#selectorController = new SelectorController(this);
		this.#inputController = new InputController(this);
		this.statusLine.setActionRegistry(this.#inputController.actionRegistry, () => this.keybindings);
		this.#observerRegistry = new SessionObserverRegistry();
	}

	getCurrentSessionNotificationStatus(): NotificationSessionStatus | undefined {
		return this.session.notificationSessionController?.query({ sessionManager: this.sessionManager });
	}

	async setCurrentSessionNotificationsEnabled(
		enabled: boolean,
	): Promise<NotificationSessionReconcileResult | undefined> {
		return await this.session.notificationSessionController?.setLocalEnabled(
			{ sessionManager: this.sessionManager },
			enabled,
		);
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

		this.ui.addChild(this.#ircSplitView);
		this.ui.setViewportAnchorComponent(this.#ircSplitView);

		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		this.ui.addChild(this.todoContainer);
		this.ui.addChild(this.btwContainer);
		this.ui.addChild(this.statusLine); // Main status rail + hook statuses; composer chrome is rendered by the editor.
		this.ui.addChild(this.hookWidgetContainerAbove);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.petFloorContainer);
		this.ui.addChild(this.hookWidgetContainerBelow);
		this.ui.setBottomPinnedComponent(this.statusLine);
		this.ui.setFocus(this.editor);
		this.petWidget?.dispose();
		this.petWidget = this.#createPetWidget(this.editor);
		const configuredPetMode = settings.get("pet.mode");
		this.petWidget.setMode(configuredPetMode);
		// The async sixel capability probe can enable graphics after the saved
		// pet mode was applied and dropped (no protocol yet at startup).
		// Re-apply the configured mode when capability arrives so the pet
		// appears without the user re-running /pet.
		this.#petProtocolUnsubscribe?.();
		this.#petProtocolUnsubscribe = onImageProtocolChanged(protocol => {
			if (!protocol) return;
			const saved = settings.get("pet.mode");
			if (saved !== "off" && this.petWidget && this.petWidget.mode === "off") {
				this.petWidget.setMode(saved);
			}
		});
		if (configuredPetMode !== "off" && !isPetAvailable()) {
			// The async Sixel capability probe (started by TUI.start()) may still
			// enable graphics; warn only once the capability question is settled
			// so a supported terminal is never told it is incompatible.
			this.#petUnavailableWarningDisposer?.();
			this.#petUnavailableWarningDisposer = warnWhenPetCapabilitySettled({
				probePending: isPetCapabilityProbePending(),
				onUnavailable: () => {
					this.showStatus(theme.fg("warning", getPetUnavailableWarning()), { dim: false });
					this.ui.requestRender();
				},
			});
		}

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
			this.#tasksAggregator = new TasksAggregator(
				jobManager,
				jobsObserver,
				this.#observerRegistry,
				this.session.getAgentId(),
			);
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
		if (this.settings.get("tasksPane.defaultVisible")) this.showTasksPane();
		this.#syncIrcSidebarAvailabilityFromSettings();
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

	getSlashCommands(): readonly SlashCommand[] {
		return this.#resolvedSlashCommands;
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
		this.#resolvedSlashCommands = [...this.#baseSlashCommands, ...skillCommands, ...fileSlashCommands];
		const autocompleteProvider = this.#inputController.createAutocompleteProvider(
			this.#resolvedSlashCommands,
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
			await this.#goalModeController.beforeGetUserInput();
		}
		const { promise, resolve } = Promise.withResolvers<SubmittedUserInput>();
		this.onInputCallback = input => {
			this.onInputCallback = undefined;
			resolve(input);
		};
		this.#goalModeController.scheduleContinuation();
		return promise;
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

	startPendingSubmission(
		input: {
			text: string;
			images?: ImageContent[];
			customType?: string;
			display?: boolean;
		},
		options?: ComposerSubmissionOptions,
	): SubmittedUserInput {
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
			this.#goalModeController.onUserSubmission();
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
		if (canApplyComposerSubmission(options, this.editor)) {
			this.editor.setText("");
		}
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
		this.#goalModeController.onPendingSubmissionFinished(submission.customType);
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
			this.statusContainer.clear();
		}
		if (!submission.customType) {
			this.pendingImages = submission.images ? [...submission.images] : [];
			this.rebuildChatFromMessages("reconcile-same-transcript");
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
		this.#goalModeController.onPendingSubmissionFinished(input.customType);

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
		const transcriptRows = getWelcomeTranscriptReservedRows(this.chatContainer, width);

		const transientRows = [
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

		return transcriptRows + transientRows + pinnedRows;
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

	/**
	 * Single result-returning pet commit policy shared by every entry path
	 * (`/pet`, the pet selector, and the Settings submenu). Capability is
	 * rechecked immediately before mutation, and the preference persists only
	 * after the commit is accepted.
	 */
	#commitPetMode(mode: PetMode, apply: (mode: PetMode) => void): boolean {
		if (mode !== "off" && !isPetAvailable()) {
			this.showStatus(theme.fg("warning", getPetUnavailableWarning()), { dim: false });
			this.ui.requestRender();
			return false;
		}
		apply(mode);
		settings.set("pet.mode", mode);
		this.ui.requestRender();
		return true;
	}

	setPetMode(mode: PetMode): boolean {
		return this.#commitPetMode(mode, next => this.petWidget?.setMode(next));
	}

	previewPetMode(mode: PetMode): void {
		this.petWidget?.previewMode(mode);
		this.ui.requestRender();
	}

	commitPetPreviewMode(mode: PetMode): boolean {
		return this.#commitPetMode(mode, next => this.petWidget?.commitPreviewMode(next));
	}

	restoreComposer(): void {
		if (this.petWidget) {
			this.petWidget.remountComposer();
		} else {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
		}
		this.ui.setFocus(this.editor);
	}

	#createPetWidget(editor: CustomEditor): GajaePetWidget {
		return new GajaePetWidget({
			ui: this.ui,
			editor,
			editorContainer: this.editorContainer,
			floorContainer: this.petFloorContainer,
			isWorking: () => this.loadingAnimation !== undefined,
			getComposerBottomOffset: () =>
				this.petFloorContainer.render(this.ui.terminal.columns).length +
				this.hookWidgetContainerBelow.render(this.ui.terminal.columns).length,
		});
	}

	rebuildChatFromMessages(policy: TranscriptRebuildPolicy): void {
		prepareTranscriptRebuild(this.ui, policy);
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

	#updatePlanModeStatus(status: { enabled: boolean; paused: boolean } | undefined): void {
		this.statusLine.setPlanModeStatus(status);
		this.updateEditorChrome();
		this.ui.requestRender();
	}

	#updateGoalModeStatus(): void {
		const status =
			this.#goalModeController.enabled || this.#goalModeController.paused
				? { enabled: this.#goalModeController.enabled, paused: this.#goalModeController.paused }
				: undefined;
		this.statusLine.setGoalModeStatus(status);
		this.updateEditorChrome();
		this.ui.requestRender();
	}

	async #handleGoalSessionEvent(event: AgentSessionEvent): Promise<void> {
		await this.#goalModeController.handleSessionEvent(event);
	}

	/** Restore mode state from session entries on resume. */
	async #restoreModeFromSession(): Promise<void> {
		const sessionContext = this.sessionManager.buildSessionContext();
		if (await this.#goalModeController.restoreFromSession(sessionContext)) return;
		await this.#planModeController.restoreFromSession(sessionContext);
	}

	stop(): void {
		this.#petProtocolUnsubscribe?.();
		this.#petProtocolUnsubscribe = undefined;
		this.#petUnavailableWarningDisposer?.();
		this.#petUnavailableWarningDisposer = undefined;
		this.petWidget?.dispose();
		this.petWidget = undefined;
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.#welcomeComponent?.dispose();
		this.#welcomeComponent = undefined;
		if (this.#sttController) {
			this.#sttController.dispose(this);
			this.#sttController = undefined;
		}
		this.#goalModeController.cancelContinuation();
		this.#extensionUiController.clearExtensionTerminalInputListeners();
		this.#extensionUiController.clearHookWidgets();
		for (const unsubscribe of this.#eventBusUnsubscribers) {
			unsubscribe();
		}
		this.#eventBusUnsubscribers = [];
		this.#tasksAggregator?.dispose();
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

		// `/btw` owns the shared composer while its panel is open. Never persist a
		// side-chat draft or pending side-chat images into the main-session draft.
		const hadActiveBtw = this.#btwController.hasOpenPanel();
		const draftText = selectShutdownDraft(this.editor.getText(), hadActiveBtw);
		if (hadActiveBtw) this.pendingImages = [];
		this.#btwController.dispose();

		// Flush pending session writes before shutdown.
		await this.sessionManager.flush();
		try {
			await this.sessionManager.saveDraft(draftText);
		} catch (err) {
			logger.warn("Failed to save session draft", { error: String(err) });
		}

		// Emit shutdown event to hooks
		this.session.setSdkPlanModeHandler(null);
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

		const petMode = settings.get("pet.mode");
		this.petWidget?.dispose();

		this.editorContainer.clear();
		this.editor = nextEditor;
		this.editorContainer.addChild(nextEditor);
		this.ui.setFocus(nextEditor);

		this.petWidget = this.#createPetWidget(nextEditor);
		this.petWidget.setMode(petMode);

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

	queueCompactionMessage(text: string, mode: "steer" | "followUp", options?: ComposerSubmissionOptions): void {
		this.#uiHelpers.queueCompactionMessage(text, mode, options);
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

	addLiveIrcObservationToChat(message: ParsedIrcMessage, arrival: IrcArrivalSnapshot): Component[] {
		return this.#uiHelpers.addLiveIrcObservationToChat(message, arrival);
	}
	removeRenderedIrcInlineComponents(observationId: string): readonly Component[] | undefined {
		return this.#uiHelpers.removeRenderedIrcInlineComponents(observationId);
	}
	resetRenderedIrcInlineComponents(): readonly (readonly Component[])[] {
		return this.#uiHelpers.resetRenderedIrcInlineComponents();
	}

	renderSessionContext(
		sessionContext: SessionContext,
		options?: { updateFooter?: boolean; populateHistory?: boolean },
	): void {
		this.#uiHelpers.renderSessionContext(sessionContext, options);
		this.#eventController.reconcileIrcExpiryTimers(this.#uiHelpers.getRenderedIrcInlineComponents());
	}

	rebuildInitialMessages(
		policy: TranscriptRebuildPolicy,
		prebuiltContext?: SessionContext,
		options?: { preserveExistingChat?: boolean },
	): void {
		prepareTranscriptRebuild(this.ui, policy);
		this.#uiHelpers.renderInitialMessages(prebuiltContext, options);
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

	getAssistantViewportAnchorId(message: AssistantMessage): string {
		return this.#uiHelpers.assistantViewportAnchorId(message);
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

	#prepareSessionSwitch(cleanupPreviousSessionUi?: () => void): void {
		this.#btwController.dispose();
		if (cleanupPreviousSessionUi) cleanupPreviousSessionUi();
		else this.#extensionUiController.clearExtensionTerminalInputListeners();
		this.#planModeController.clearReview();
	}

	async handleClearCommand(): Promise<boolean> {
		const cleanupPreviousSessionUi = this.#extensionUiController.captureSessionUiCleanup();
		const switched = await this.#commandController.handleClearCommand();
		if (switched) this.#prepareSessionSwitch(cleanupPreviousSessionUi);
		return switched;
	}

	handleContextClearCommand(): Promise<void> {
		this.#prepareSessionSwitch();
		return this.#commandController.handleContextClearCommand();
	}

	async handleDropCommand(): Promise<boolean> {
		const cleanupPreviousSessionUi = this.#extensionUiController.captureSessionUiCleanup();
		const switched = await this.#commandController.handleDropCommand();
		if (switched) this.#prepareSessionSwitch(cleanupPreviousSessionUi);
		return switched;
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
		this.#sttController ??= new SttModeController();
		await this.#sttController.toggle(this);
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

	showSessionsDashboard(): void {
		void this.#selectorController.showSessionsDashboard();
	}

	isTranscriptViewerOpen(): boolean {
		return this.#selectorController.isTranscriptViewerOpen();
	}
	refreshTranscriptViewer(): void {
		if (!this.isTranscriptViewerOpen()) return;
		const identityMap = this.#rebuildTranscriptRegistry();
		this.#selectorController.refreshTranscriptViewer(identityMap);
	}
	showTranscriptViewer(): void {
		this.#rebuildTranscriptRegistry();
		this.#selectorController.showTranscriptViewer(this.#transcriptRegistry);
	}
	#rebuildTranscriptRegistry(): ReadonlyMap<string, string> {
		const toolResults = new Map<string, Extract<AgentMessage, { role: "toolResult" }>>();
		for (const message of this.session.messages) {
			if (message.role === "toolResult") toolResults.set(message.toolCallId, message);
		}
		const items: RegisterTranscriptItem[] = [];
		const identityMap = new Map<string, string>();
		for (const [messageIndex, message] of this.session.messages.entries()) {
			const provisionalEntryId = transcriptItemId.stream(this.session.transcriptPromptGeneration, messageIndex);
			const durableEntryId = getSessionMessageEntryId(message);
			const entryId = durableEntryId ?? provisionalEntryId;
			if (durableEntryId) {
				if (message.role === "user" || message.role === "developer") {
					identityMap.set(transcriptItemId.entry(provisionalEntryId), transcriptItemId.entry(durableEntryId));
				} else if (message.role === "assistant") {
					for (const [contentIndex] of message.content.entries()) {
						identityMap.set(
							transcriptItemId.assistantContent(provisionalEntryId, contentIndex),
							transcriptItemId.assistantContent(durableEntryId, contentIndex),
						);
					}
				}
			}
			if (message.role === "user" || message.role === "developer") {
				const text =
					typeof message.content === "string"
						? message.content
						: message.content
								.filter(part => part.type === "text")
								.map(part => part.text)
								.join("\n");
				if (text.trim())
					items.push({
						kind: "user",
						source: { entryId, message },
						getPayload: () => ({ text, metadata: { role: message.role }, source: message }),
					});
				continue;
			}
			if (message.role !== "assistant") continue;
			for (const [contentIndex, content] of message.content.entries()) {
				if (content.type === "thinking" && content.thinking.trim())
					items.push({
						kind: "assistant-thinking",
						source: { entryId, contentIndex, content },
						getPayload: () => ({ text: content.thinking, metadata: { entryId, contentIndex }, source: content }),
					});
				if (content.type === "text" && content.text.trim())
					items.push({
						kind: "assistant-text",
						source: { entryId, contentIndex, content },
						getPayload: () => ({ text: content.text, metadata: { entryId, contentIndex }, source: content }),
					});
				if (content.type === "toolCall") {
					const result = toolResults.get(content.id);
					const resultText =
						result?.content
							.filter(part => part.type === "text")
							.map(part => part.text)
							.join("\n")
							.trim() ?? "";
					items.push({
						kind: "tool",
						source: { toolCallId: content.id, content, result },
						getPayload: () => ({
							text: composeToolText({
								name: content.name,
								args: content.arguments,
								intent: content.intent,
								resultText,
								isError: result?.isError ?? false,
								hasResult: toolResults.has(content.id),
							}),
							metadata: {
								name: content.name,
								arguments: content.arguments,
								intent: content.intent,
								isError: result?.isError ?? false,
								resultText,
								hasResult: toolResults.has(content.id),
								detailsData: result?.details,
							},
							source: { content, result },
						}),
					});
				}
			}
		}
		this.#transcriptRegistry.rebuild(items);
		return identityMap;
	}

	showJobsOverlay(): void {
		if (!this.#jobsObserver) {
			this.showStatus("Background jobs are unavailable in this session");
			return;
		}
		this.#selectorController.showJobsOverlay(this.#jobsObserver);
	}

	showTasksPane(): void {
		if (!this.#tasksAggregator) {
			this.showStatus("Tasks are unavailable in this session");
			return;
		}
		this.#selectorController.showTasksPane(this.#tasksAggregator);
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
	showCommandPalette(
		commands: SlashCommand[],
		actions: CommandPaletteAction[],
		executeSlashCommand: (name: string) => Promise<void>,
	): void {
		this.#selectorController.showCommandPalette(commands, actions, executeSlashCommand);
	}

	showSettingsSelector(): void {
		this.#selectorController.showSettingsSelector();
	}

	showThemeSelector(): void {
		this.#selectorController.showThemeSelector();
	}

	showPetSelector(): void {
		this.#selectorController.showPetSelector();
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
		return this.#btwController.hasOpenPanel();
	}

	handleBtwFollowUp(question: string): Promise<"accepted" | "busy" | "closed" | "rejected"> {
		return this.#btwController.submitFollowUp(question);
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

	#resolveEffectiveIrcSidebarToggleKey(): string | null {
		for (const key of this.keybindings.getKeys("app.irc.sidebar.toggle")) {
			if (this.editor.hasActionKey(key)) continue;
			const shadowed = IRC_SIDEBAR_TOGGLE_SHADOWING_ACTIONS.some(action =>
				this.keybindings.getKeys(action).includes(key),
			);
			if (!shadowed) return key;
		}
		return null;
	}

	captureIrcArrivalSnapshot(): IrcArrivalSnapshot {
		return {
			panelVisible: this.#ircSplitView.effectiveSidebarVisible(this.ui.terminal.columns),
			panelRequestedVisible: this.#ircSidebarRequestedVisible,
			sidebarAvailable: this.#ircSidebarAvailable,
			resolvedToggleKey: this.#resolveEffectiveIrcSidebarToggleKey(),
		};
	}
	toggleIrcSidebar(): void {
		if (
			!this.#ircSidebarAvailable ||
			this.settings.get("irc.enabled") !== true ||
			this.settings.get("irc.sidebar.enabled") !== true
		)
			return;
		this.#ircSidebarRequestedVisible = !this.#ircSidebarRequestedVisible;
		this.#ircSplitView.setVisible(this.#ircSidebarRequestedVisible);
		this.#invalidateIrcSidebarRender();
		this.ui.requestRender();
	}

	applyIrcSidebarAvailability(enabled: boolean): void {
		this.#ircSidebarAvailable = enabled;
		this.#ircSplitView.setVisible(enabled && this.#ircSidebarRequestedVisible);
		this.#invalidateIrcSidebarRender();
		this.ui.requestRender();
	}

	#syncIrcSidebarAvailabilityFromSettings(): void {
		this.applyIrcSidebarAvailability(
			this.settings.get("irc.enabled") === true && this.settings.get("irc.sidebar.enabled") === true,
		);
	}

	resetIrcSidebarSession(): void {
		this.ircLedger.reset();
		this.#eventController.resetIrcObservations();
		this.#ircSidebarRequestedVisible = false;
		this.#ircSplitView.setVisible(false);
		this.#uiHelpers.resetIrcSidebarHint();
		this.#syncIrcSidebarAvailabilityFromSettings();
	}

	#invalidateIrcSidebarRender(): void {
		clearRenderCache();
		this.#ircSplitView.invalidate();
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
