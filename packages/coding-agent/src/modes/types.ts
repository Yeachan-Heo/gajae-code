import type { AgentMessage } from "@gajae-code/agent-core";
import type { CompactionOutcome } from "@gajae-code/agent-core/compaction";
import type { AssistantMessage, ImageContent, Message, UsageReport } from "@gajae-code/ai";
import type { Component, Container, EditorTheme, Loader, SlashCommand, Spacer, Text, TUI } from "@gajae-code/tui";
import type { KeybindingsManager } from "../config/keybindings";
import type { Settings } from "../config/settings";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
} from "../extensibility/extensions";
import type { CompactOptions } from "../extensibility/extensions/types";
import type { Skill } from "../extensibility/skills";
import type { PlanApprovalDetails } from "../plan-mode/approved-plan";
import type { MCPManager } from "../runtime-mcp";
import type { NotificationSessionReconcileResult, NotificationSessionStatus } from "../sdk/bus/session-control";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { HistoryStorage } from "../session/history-storage";
import type { SessionContext, SessionManager } from "../session/session-manager";
import type { CredentialAutoImportOptions } from "../setup/credential-auto-import";
import type { LspStartupServerInfo } from "../tools";
import type { AssistantMessageComponent } from "./components/assistant-message";
import type { BashExecutionComponent } from "./components/bash-execution";
import type { CommandPaletteAction } from "./components/command-palette";
import type { CustomEditor } from "./components/custom-editor";
import type { EvalExecutionComponent } from "./components/eval-execution";
import type { PetMode } from "./components/gajae-pet-widget";
import type { HookEditorComponent } from "./components/hook-editor";
import type { HookInputComponent } from "./components/hook-input";
import type { HookSelectorComponent } from "./components/hook-selector";
import type { StatusLineComponent } from "./components/status-line";
import type { ToolExecutionHandle } from "./components/tool-execution";
import type { IrcObservationLedger } from "./irc-observation-ledger";
import type { OAuthManualInputManager } from "./oauth-manual-input";
import type { Theme } from "./theme/theme";
import type { ParsedIrcMessage } from "./utils/irc-message";

export type TranscriptRebuildPolicy = "replace-identity" | "reconcile-same-transcript";
export type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
	followUpQueuePolicy?: "sequential";
};

export type SubmittedUserInput = {
	text: string;
	images?: ImageContent[];
	customType?: string;
	display?: boolean;
	cancelled: boolean;
	started: boolean;
};

export type ComposerSubmissionOptions = Readonly<{
	ownsComposer: boolean;
	editor: CustomEditor;
}>;

export function canApplyComposerSubmission(
	options: ComposerSubmissionOptions | undefined,
	editor: CustomEditor,
): boolean {
	return options === undefined || (options.ownsComposer && editor === options.editor);
}
export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

export type TodoItem = {
	content: string;
	status: TodoStatus;
	details?: string;
	notes?: string[];
};

export type TodoPhase = {
	name: string;
	tasks: TodoItem[];
};

export type IrcArrivalSnapshot = Readonly<{
	panelVisible: boolean;
	/** User-requested open state; may be true while the panel yields at narrow widths. */
	panelRequestedVisible: boolean;
	sidebarAvailable: boolean;
	resolvedToggleKey: string | null;
}>;

export interface InteractiveModeContext {
	// UI access
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

	// Session access
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	keybindings: KeybindingsManager;
	agent: AgentSession["agent"];
	historyStorage?: HistoryStorage;
	mcpManager?: MCPManager;
	lspServers?: LspStartupServerInfo[];

	/** Shared controller query; absent in ACP/lightweight test contexts. */
	getCurrentSessionNotificationStatus?(): NotificationSessionStatus | undefined;
	/** Toggle only the current session; absent in ACP/lightweight test contexts. */
	setCurrentSessionNotificationsEnabled?(enabled: boolean): Promise<NotificationSessionReconcileResult | undefined>;
	readonly ircLedger: IrcObservationLedger;
	// State
	isInitialized: boolean;
	isBackgrounded: boolean;
	isBashMode: boolean;
	isBashNoContext: boolean;
	toolOutputExpanded: boolean;
	todoExpanded: boolean;
	planModeEnabled: boolean;
	goalModeEnabled: boolean;
	goalModePaused: boolean;
	planModePlanFilePath?: string;
	hideThinkingBlock: boolean;
	pendingImages: ImageContent[];
	compactionQueuedMessages: CompactionQueuedMessage[];
	pendingTools: Map<string, ToolExecutionHandle>;
	pendingBashComponents: BashExecutionComponent[];
	bashComponent: BashExecutionComponent | undefined;
	pendingPythonComponents: EvalExecutionComponent[];
	pythonComponent: EvalExecutionComponent | undefined;
	isPythonMode: boolean;
	streamingComponent: AssistantMessageComponent | undefined;
	streamingMessage: AssistantMessage | undefined;
	loadingAnimation: Loader | undefined;
	autoCompactionLoader: Loader | undefined;
	retryLoader: Loader | undefined;
	autoCompactionEscapeHandler?: () => void;
	retryEscapeHandler?: () => void;
	retryEscapePrimed: boolean;
	retryCountdownTimer?: NodeJS.Timeout;
	unsubscribe?: () => void;
	onInputCallback?: (input: SubmittedUserInput) => void;
	optimisticUserMessageSignature: string | undefined;
	locallySubmittedUserSignatures: Set<string>;
	optimisticInjectedSignatures: Map<string, number>;
	lastSigintTime: number;
	lastEscapeTime: number;
	lastComposerClearEscapeTime: number;
	shutdownRequested: boolean;
	hookSelector: HookSelectorComponent | undefined;
	hookInput: HookInputComponent | undefined;
	hookEditor: HookEditorComponent | undefined;
	lastStatusSpacer: Spacer | undefined;
	lastStatusText: Text | undefined;
	fileSlashCommands: Set<string>;
	skillCommands: Map<string, Skill>;
	oauthManualInput: OAuthManualInputManager;
	todoPhases: TodoPhase[];

	// Lifecycle
	init(): Promise<void>;
	shutdown(): Promise<void>;
	checkShutdownRequested(): Promise<void>;

	// Extension UI integration
	setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void;
	initializeHookRunner(uiContext: ExtensionUIContext, hasUI: boolean): void;
	createBackgroundUiContext(): ExtensionUIContext;
	setEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) | undefined,
	): void;

	// Event handling
	handleBackgroundEvent(event: AgentSessionEvent): Promise<void>;

	// UI helpers
	showStatus(message: string, options?: { dim?: boolean }): void;
	showError(message: string): void;
	showWarning(message: string): void;
	notifyConfigChanged?: () => Promise<void> | void;
	showNewVersionNotification(newVersion: string): void;
	clearEditor(): void;
	updatePendingMessagesDisplay(): void;
	queueCompactionMessage(text: string, mode: "steer" | "followUp", options?: ComposerSubmissionOptions): void;
	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void>;
	flushPendingBashComponents(): void;
	flushPendingModelSwitch(): Promise<void>;
	setWorkingMessage(message?: string): void;
	applyPendingWorkingMessage(): void;
	ensureLoadingAnimation(): void;
	/**
	 * Commit a pet mode through the shared result-returning policy: capability
	 * is rechecked immediately before mutation and the preference persists only
	 * on acceptance. Returns whether the commit was accepted.
	 */
	setPetMode(mode: PetMode): boolean;
	/** Live-preview a pet skin during a selector without persisting. */
	previewPetMode(mode: PetMode): void;
	/**
	 * Commit a settings-overlay pet change without re-mounting the composer.
	 * Same shared commit policy and result semantics as `setPetMode`.
	 */
	commitPetPreviewMode(mode: PetMode): boolean;
	/** Re-mount the composer (pet-aware) after an overlay/selector closes. */
	restoreComposer(): void;
	startPendingSubmission(
		input: {
			text: string;
			images?: ImageContent[];
			customType?: string;
			display?: boolean;
		},
		options?: ComposerSubmissionOptions,
	): SubmittedUserInput;
	cancelPendingSubmission(): boolean;
	markPendingSubmissionStarted(input: SubmittedUserInput): boolean;
	finishPendingSubmission(input: SubmittedUserInput): void;
	/**
	 * Marks a locally-initiated user submission so the eventual `message_start`
	 * event for that user message does not clobber the editor draft (see #783).
	 * Returns a dispose function that removes the signature; call it on
	 * delivery failure so a retry can be re-marked cleanly.
	 */
	recordLocalSubmission(text: string, imageCount?: number): () => void;
	/**
	 * Wraps `fn` in a `recordLocalSubmission` marker that is automatically
	 * removed if `fn` rejects. Use this for the common case where a thrown
	 * delivery error should leave the signature set untouched.
	 */
	withLocalSubmission<T>(text: string, fn: () => Promise<T>, options?: { imageCount?: number }): Promise<T>;
	isKnownSlashCommand(text: string): boolean;
	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): Component[];
	addLiveIrcObservationToChat(message: ParsedIrcMessage, arrival: IrcArrivalSnapshot): Component[];
	removeRenderedIrcInlineComponents(observationId: string): readonly Component[] | undefined;
	resetRenderedIrcInlineComponents(): readonly (readonly Component[])[];
	renderSessionContext(
		sessionContext: SessionContext,
		options?: { updateFooter?: boolean; populateHistory?: boolean },
	): void;
	rebuildInitialMessages(
		policy: TranscriptRebuildPolicy,
		prebuiltContext?: SessionContext,
		options?: { preserveExistingChat?: boolean },
	): void;
	getUserMessageText(message: Message): string;
	getAssistantViewportAnchorId?(message: AssistantMessage): string;
	findLastAssistantMessage(): AssistantMessage | undefined;
	extractAssistantText(message: AssistantMessage): string;
	updateEditorTopBorder(): void;
	updateEditorBorderColor(): void;
	rebuildChatFromMessages(policy: TranscriptRebuildPolicy): void;
	setTodos(todos: TodoItem[] | TodoPhase[]): void;
	reloadTodos(): Promise<void>;
	toggleTodoExpansion(): void;

	// IRC sidebar
	toggleIrcSidebar(): void;
	captureIrcArrivalSnapshot(): IrcArrivalSnapshot;
	applyIrcSidebarAvailability(enabled: boolean): void;
	resetIrcSidebarSession(): void;
	// Command handling
	handleExportCommand(text: string): Promise<void>;
	handleShareCommand(): Promise<void>;
	handleCopyCommand(sub?: string): void;
	handleTodoCommand(args: string): Promise<void>;
	handleSessionCommand(): Promise<void>;
	handleJobsCommand(): Promise<void>;
	handleUsageCommand(reports?: UsageReport[] | null): Promise<void>;
	handleChangelogCommand(showFull?: boolean): Promise<void>;
	handleHotkeysCommand(): void;
	handleHelpCommand(): void;
	handleToolsCommand(): void;
	handleContextCommand(): void;
	handleDumpCommand(): void;
	handleDebugTranscriptCommand(): Promise<void>;
	handleClearCommand(): Promise<boolean>;
	handleContextClearCommand(): Promise<void>;
	handleDropCommand(): Promise<boolean>;
	handleForkCommand(): Promise<void>;
	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void>;
	handlePythonCommand(code: string, excludeFromContext?: boolean): Promise<void>;
	handleMCPCommand(text: string): Promise<void>;
	handleSSHCommand(text: string): Promise<void>;
	handleCompactCommand(customInstructions?: string): Promise<CompactionOutcome>;
	handleHandoffCommand(customInstructions?: string): Promise<void>;
	handleContributionPrepCommand(customInstructions?: string): Promise<void>;
	handleMoveCommand(targetPath: string): Promise<void>;
	handleRenameCommand(title: string): Promise<void>;
	handleMemoryCommand(text: string): Promise<void>;
	handleSTTToggle(): Promise<void>;
	executeCompaction(
		customInstructionsOrOptions?: string | CompactOptions,
		isAuto?: boolean,
	): Promise<CompactionOutcome>;
	openInBrowser(urlOrPath: string): void;
	refreshSlashCommandState(cwd?: string): Promise<void>;

	// Selector handling
	showCommandPalette(
		commands: SlashCommand[],
		actions: CommandPaletteAction[],
		executeSlashCommand: (name: string) => Promise<void>,
	): void;
	showSettingsSelector(): void;
	showThemeSelector(): void;
	showPetSelector(): void;
	showHistorySearch(): void;
	showExtensionsDashboard(): void;
	showAgentsDashboard(): void;
	showModelSelector(options?: { temporaryOnly?: boolean }): void;
	showEffortSelector(): void;
	showProviderOnboarding(): void;
	showPluginSelector(mode?: "install" | "uninstall"): void;
	showUserMessageSelector(): void;
	showTreeSelector(): void;
	showSessionSelector(): void;
	handleResumeSession(sessionPath: string): Promise<void>;
	handleSessionDeleteCommand(): Promise<void>;
	showOAuthSelector(mode: "login" | "logout", providerId?: string, options?: OAuthSelectorOptions): Promise<void>;
	showHookConfirm(title: string, message: string): Promise<boolean>;
	showDebugSelector(): void;
	showSessionObserver(): void;
	showJobsOverlay(): void;
	resetObserverRegistry(): void;

	// Input handling
	handleCtrlC(): void;
	handleCtrlD(): void;
	handleCtrlZ(): void;
	handleDequeue(): void;
	handleBackgroundCommand(): void;
	handleImagePaste(): Promise<boolean>;
	handleBtwCommand(question: string): Promise<void>;
	hasActiveBtw(): boolean;
	handleBtwEscape(): boolean;
	cycleThinkingLevel(): void;
	cycleRoleModel(options?: { temporary?: boolean }): Promise<void>;
	toggleToolOutputExpansion(): void;
	setToolsExpanded(expanded: boolean): void;
	toggleThinkingBlockVisibility(): void;
	openExternalEditor(): void;
	registerExtensionShortcuts(): void;
	handlePlanModeCommand(initialPrompt?: string): Promise<void>;
	handleGoalModeCommand(rest?: string): Promise<void>;
	handlePlanApproval(details: PlanApprovalDetails): Promise<void>;

	// Hook UI methods
	initHooksAndCustomTools(): Promise<void>;
	emitCustomToolSessionEvent(
		reason: "start" | "switch" | "branch" | "tree" | "shutdown",
		previousSessionFile?: string,
	): Promise<void>;
	setHookWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
	setHookStatus(key: string, text: string | undefined): void;
	showHookSelector(
		title: string,
		options: string[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined>;
	hideHookSelector(): void;
	showHookInput(
		title: string,
		placeholder?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		inputOptions?: { readonly initialValue?: string },
	): Promise<string | undefined>;
	hideHookInput(): void;
	showHookEditor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined>;
	hideHookEditor(): void;
	showHookNotify(message: string, type?: "info" | "warning" | "error"): void;
	showHookCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: { overlay?: boolean },
	): Promise<T>;
	showExtensionError(extensionPath: string, error: string): void;
	showToolError(toolName: string, error: string): void;
}
export interface OAuthSelectorOptions {
	allowExternalCredentialDiscovery?: boolean;
	trigger?: "bare-login";
	externalCredentialDiscover?: CredentialAutoImportOptions["discover"];
}
