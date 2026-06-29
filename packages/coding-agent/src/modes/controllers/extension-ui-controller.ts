import type { Component, OverlayHandle, TUI } from "@gajae-code/tui";
import { Container, Spacer, Text } from "@gajae-code/tui";
import { logger } from "@gajae-code/utils";
import { KeybindingsManager } from "../../config/keybindings";
import type {
	CompactOptions,
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionError,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUiComponent,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	SendUserMessageHandler,
	TerminalInputHandler,
} from "../../extensibility/extensions";
import { getSessionSlashCommands } from "../../extensibility/extensions/get-commands-handler";
import { HookEditorComponent } from "../../modes/components/hook-editor";
import { HookInputComponent } from "../../modes/components/hook-input";
import { HookSelectorComponent } from "../../modes/components/hook-selector";
import { getAvailableThemesWithPaths, getThemeByName, setTheme, type Theme, theme } from "../../modes/theme/theme";
import type { InteractiveModeContext } from "../../modes/types";
import { setSessionTerminalTitle, setTerminalTitle } from "../../utils/title-generator";
import { classifyHookSelectorBellEvent, ringTerminalBell } from "../utils/terminal-bell";

const MAX_WIDGET_LINES = 10;
const HOOK_SELECTOR_CHROME_ROWS = 7;
const HOOK_SELECTOR_OUTLINE_ROWS = 2;
const HOOK_SELECTOR_INLINE_INPUT_ROWS = 2;

export class ExtensionUiController {
	#extensionTerminalInputUnsubscribers = new Set<() => void>();
	#hookWidgetsAbove = new Map<string, ExtensionUiComponent>();
	#hookWidgetsBelow = new Map<string, ExtensionUiComponent>();
	#activeHookCustomComponent?: Component & { dispose?(): void };
	#activeHookCustomOverlay?: OverlayHandle;

	constructor(private ctx: InteractiveModeContext) {}

	#clearActiveHookCustom(): void {
		const component = this.#activeHookCustomComponent;
		const overlay = this.#activeHookCustomOverlay;
		this.#activeHookCustomComponent = undefined;
		this.#activeHookCustomOverlay = undefined;
		component?.dispose?.();
		overlay?.hide();
	}

	/**
	 * Initialize the hook system with TUI-based UI context.
	 */
	async initHooksAndCustomTools(): Promise<void> {
		// Create and set hook & tool UI context
		const uiContext: ExtensionUIContext = {
			select: (title, options, dialogOptions) => this.showHookSelector(title, options, dialogOptions),
			confirm: (title, message, _dialogOptions) => this.showHookConfirm(title, message),
			input: (title, placeholder, dialogOptions) => this.showHookInput(title, placeholder, dialogOptions),
			notify: (message, type) => this.showHookNotify(message, type),
			onTerminalInput: handler => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setHookStatus(key, text),
			setWorkingMessage: message => this.ctx.setWorkingMessage(message),
			setWidget: (key, content, options) => this.setHookWidget(key, content, options),
			setTitle: title => setTerminalTitle(title),
			custom: (factory, options) => this.showHookCustom(factory, options),
			setEditorText: text => this.ctx.editor.setText(text),
			pasteToEditor: text => {
				this.ctx.editor.handleInput(`\x1b[200~${text}\x1b[201~`);
			},
			getEditorText: () => this.ctx.editor.getText(),
			editor: (title, prefill, dialogOptions, editorOptions) =>
				this.showHookEditor(title, prefill, dialogOptions, editorOptions),
			get theme() {
				return theme;
			},
			getAllThemes: async () => (await getAvailableThemesWithPaths()).map(t => ({ name: t.name, path: t.path })),
			getTheme: name => getThemeByName(name),
			setTheme: async themeArg => {
				if (typeof themeArg === "string") {
					return await setTheme(themeArg, true);
				}
				// Theme object passed directly - not supported in current implementation
				return Promise.resolve({ success: false, error: "Direct theme object not supported" });
			},
			setFooter: () => {},
			setHeader: () => {},
			setEditorComponent: factory => this.ctx.setEditorComponent(factory),
			getToolsExpanded: () => this.ctx.toolOutputExpanded,
			setToolsExpanded: expanded => this.ctx.setToolsExpanded(expanded),
		};
		this.ctx.setToolUIContext(uiContext, true);

		const extensionRunner = this.ctx.session.extensionRunner;
		if (!extensionRunner) {
			return; // No hooks loaded
		}

		const actions: ExtensionActions = {
			sendMessage: (message, options) => {
				const wasStreaming = this.ctx.session.isStreaming;
				this.ctx.session
					.sendCustomMessage(message, options)
					.then(() => this.#applyCustomMessageDisplay(wasStreaming, message.display))
					.catch((err: unknown) => {
						this.ctx.showError(
							`Extension sendMessage failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					});
			},
			sendUserMessage: this.#sendExtensionUserMessage,
			appendEntry: (customType, data) => {
				this.ctx.sessionManager.appendCustomEntry(customType, data);
			},
			setLabel: (targetId, label) => {
				this.ctx.sessionManager.appendLabelChange(targetId, label);
			},
			getActiveTools: () => this.ctx.session.getActiveToolNames(),
			getAllTools: () => this.ctx.session.getAllToolNames(),
			setActiveTools: toolNames => this.ctx.session.setActiveToolsByName(toolNames),
			setModel: async model => {
				const key = await this.ctx.session.modelRegistry.getApiKey(model);
				if (!key) return false;
				await this.ctx.session.setModel(model);
				return true;
			},
			getThinkingLevel: () => this.ctx.session.thinkingLevel,
			setThinkingLevel: level => this.ctx.session.setThinkingLevel(level),
			getCommands: () => getSessionSlashCommands(this.ctx.session),
			getSessionName: () => this.ctx.sessionManager.getSessionName(),
			setSessionName: name => this.#updateSessionName(name),
		};
		const contextActions: ExtensionContextActions = {
			getModel: () => this.ctx.session.model,
			isIdle: () => !this.ctx.session.isStreaming,
			abort: () => this.ctx.session.abort(),
			hasPendingMessages: () => this.ctx.session.queuedMessageCount > 0,
			shutdown: () => {
				// Defer the actual teardown to the main loop, which calls
				// `checkShutdownRequested()` at idle boundaries so any queued
				// steering / follow-up messages drain first (see issue #1020).
				this.ctx.shutdownRequested = true;
			},
			getContextUsage: () => this.ctx.session.getContextUsage(),
			compact: instructionsOrOptions => this.#compactSession(instructionsOrOptions),
			getSystemPrompt: () => this.ctx.session.systemPrompt,
		};
		const commandActions: ExtensionCommandContextActions = {
			getContextUsage: () => this.ctx.session.getContextUsage(),
			waitForIdle: () => this.ctx.session.agent.waitForIdle(),
			reload: async () => {
				await this.ctx.session.reload();
				this.ctx.chatContainer.clear();
				this.ctx.renderInitialMessages();
				await this.ctx.reloadTodos();
				this.ctx.showStatus("Reloaded session");
			},
			newSession: async options => {
				// Stop any loading animation
				if (this.ctx.loadingAnimation) {
					this.ctx.loadingAnimation.stop();
					this.ctx.loadingAnimation = undefined;
				}
				this.ctx.statusContainer.clear();

				// Create new session
				this.clearExtensionTerminalInputListeners();
				this.clearHookWidgets();
				const success = await this.ctx.session.newSession({ parentSession: options?.parentSession });
				if (!success) {
					return { cancelled: true };
				}
				setSessionTerminalTitle(this.ctx.sessionManager.getSessionName(), this.ctx.sessionManager.getCwd());

				// Call setup callback if provided
				if (options?.setup) {
					await options.setup(this.ctx.sessionManager);
				}

				// Reset and update status line
				this.ctx.statusLine.invalidate();
				this.ctx.statusLine.setSessionStartTime(Date.now());
				this.ctx.updateEditorTopBorder();
				this.ctx.ui.requestRender();

				// Clear UI state
				this.ctx.chatContainer.clear();
				this.ctx.pendingMessagesContainer.clear();
				this.ctx.compactionQueuedMessages = [];
				this.ctx.streamingComponent = undefined;
				this.ctx.streamingMessage = undefined;
				this.ctx.pendingTools.clear();

				this.ctx.chatContainer.addChild(new Spacer(1));
				this.ctx.chatContainer.addChild(
					new Text(`${theme.fg("accent", `${theme.status.success} New session started`)}`, 1, 1),
				);
				await this.ctx.reloadTodos();
				this.ctx.ui.requestRender();

				return { cancelled: false };
			},
			branch: async entryId => {
				const result = await this.ctx.session.branch(entryId);
				if (result.cancelled) {
					return { cancelled: true };
				}

				// Update UI
				this.ctx.chatContainer.clear();
				this.ctx.renderInitialMessages();
				await this.ctx.reloadTodos();
				this.ctx.editor.setText(result.selectedText);
				this.ctx.showStatus("Branched to new session");

				return { cancelled: false };
			},
			navigateTree: async (targetId, options) => {
				const result = await this.ctx.session.navigateTree(targetId, { summarize: options?.summarize });
				if (result.cancelled) {
					return { cancelled: true };
				}

				// Update UI
				this.ctx.chatContainer.clear();
				this.ctx.renderInitialMessages();
				await this.ctx.reloadTodos();
				if (result.editorText && !this.ctx.editor.getText().trim()) {
					this.ctx.editor.setText(result.editorText);
				}
				this.ctx.showStatus("Navigated to selected point");

				return { cancelled: false };
			},
			compact: async instructionsOrOptions => this.#handleInteractiveCompact(instructionsOrOptions),
			switchSession: async sessionPath => {
				this.clearHookWidgets();
				const result = await this.ctx.session.switchSession(sessionPath);
				if (!result) {
					return { cancelled: true };
				}
				setSessionTerminalTitle(this.ctx.sessionManager.getSessionName(), this.ctx.sessionManager.getCwd());
				this.ctx.chatContainer.clear();
				this.ctx.renderInitialMessages();
				await this.ctx.reloadTodos();
				return { cancelled: false };
			},
		};

		extensionRunner.initialize(actions, contextActions, commandActions, uiContext);

		// Subscribe to extension errors
		extensionRunner.onError((error: ExtensionError) => {
			this.showExtensionError(error.extensionPath, error.error);
		});

		// Emit session_start event
		await extensionRunner.emit({
			type: "session_start",
		});
	}

	setHookWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void {
		const placement = options?.placement ?? "aboveEditor";
		this.#removeHookWidget(this.#hookWidgetsAbove, key);
		this.#removeHookWidget(this.#hookWidgetsBelow, key);

		if (content === undefined) {
			this.#rebuildHookWidgets();
			return;
		}

		const target = placement === "belowEditor" ? this.#hookWidgetsBelow : this.#hookWidgetsAbove;
		target.set(key, this.#createHookWidget(content));
		this.#rebuildHookWidgets();
	}

	#removeHookWidget(widgets: Map<string, ExtensionUiComponent>, key: string): void {
		const existing = widgets.get(key);
		existing?.dispose?.();
		widgets.delete(key);
	}

	#createHookWidget(content: ExtensionWidgetContent): ExtensionUiComponent {
		if (Array.isArray(content)) {
			const container = new Container();
			for (const line of content.slice(0, MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			return container;
		}
		if (content === undefined) {
			throw new Error("Widget content missing");
		}
		return content(this.ctx.ui, theme);
	}

	#rebuildHookWidgets(): void {
		this.#renderHookWidgetContainer(this.ctx.hookWidgetContainerAbove, this.#hookWidgetsAbove, true, true);
		this.#renderHookWidgetContainer(this.ctx.hookWidgetContainerBelow, this.#hookWidgetsBelow, false, false);
		this.ctx.ui.requestRender();
	}

	#renderHookWidgetContainer(
		container: Container,
		widgets: Map<string, ExtensionUiComponent>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		// Detach (not dispose): hook widgets are persistent instances owned by the
		// #hookWidgets* maps and re-added on every rebuild. Disposal happens only on
		// explicit removal (#removeHookWidget) or clearHookWidgets(), so a rebuild must
		// not tear down a still-live widget (e.g. an extension CancellableLoader timer).
		container.detachAll();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const widget of widgets.values()) {
			container.addChild(widget);
		}
	}

	initializeHookRunner(uiContext: ExtensionUIContext, _hasUI: boolean): void {
		const extensionRunner = this.ctx.session.extensionRunner;
		if (!extensionRunner) {
			return;
		}

		const actions: ExtensionActions = {
			sendMessage: (message, options) => {
				const wasStreaming = this.ctx.session.isStreaming;
				this.ctx.session
					.sendCustomMessage(message, options)
					.then(() => this.#applyCustomMessageDisplay(wasStreaming, message.display))
					.catch((err: unknown) => {
						const errorText = `Extension sendMessage failed: ${err instanceof Error ? err.message : String(err)}`;
						if (this.ctx.isBackgrounded) {
							logger.error(errorText);
							return;
						}
						this.ctx.showError(errorText);
					});
			},
			sendUserMessage: this.#sendExtensionUserMessage,
			appendEntry: (customType, data) => {
				this.ctx.sessionManager.appendCustomEntry(customType, data);
			},
			setLabel: (targetId, label) => {
				this.ctx.sessionManager.appendLabelChange(targetId, label);
			},
			getActiveTools: () => this.ctx.session.getActiveToolNames(),
			getAllTools: () => this.ctx.session.getAllToolNames(),
			setActiveTools: toolNames => this.ctx.session.setActiveToolsByName(toolNames),
			setModel: async model => {
				const key = await this.ctx.session.modelRegistry.getApiKey(model);
				if (!key) return false;
				await this.ctx.session.setModel(model);
				return true;
			},
			getThinkingLevel: () => this.ctx.session.thinkingLevel,
			setThinkingLevel: (level, persist) => this.ctx.session.setThinkingLevel(level, persist),
			getCommands: () => getSessionSlashCommands(this.ctx.session),
			getSessionName: () => this.ctx.sessionManager.getSessionName(),
			setSessionName: name => this.#updateSessionName(name),
		};
		const contextActions: ExtensionContextActions = {
			getModel: () => this.ctx.session.model,
			isIdle: () => !this.ctx.session.isStreaming,
			abort: () => this.ctx.session.abort(),
			hasPendingMessages: () => this.ctx.session.queuedMessageCount > 0,
			shutdown: () => {
				// Defer the actual teardown to the main loop, which calls
				// `checkShutdownRequested()` at idle boundaries so any queued
				// steering / follow-up messages drain first (see issue #1020).
				this.ctx.shutdownRequested = true;
			},
			getContextUsage: () => this.ctx.session.getContextUsage(),
			compact: instructionsOrOptions => this.#compactSession(instructionsOrOptions),
			getSystemPrompt: () => this.ctx.session.systemPrompt,
		};
		const commandActions: ExtensionCommandContextActions = {
			getContextUsage: () => this.ctx.session.getContextUsage(),
			waitForIdle: () => this.ctx.session.agent.waitForIdle(),
			reload: async () => {
				if (this.ctx.isBackgrounded) {
					return;
				}
				await this.ctx.session.reload();
				this.ctx.chatContainer.clear();
				this.ctx.renderInitialMessages();
				await this.ctx.reloadTodos();
				this.ctx.showStatus("Reloaded session");
			},
			newSession: async options => {
				if (this.ctx.isBackgrounded) {
					return { cancelled: true };
				}
				// Stop any loading animation
				if (this.ctx.loadingAnimation) {
					this.ctx.loadingAnimation.stop();
					this.ctx.loadingAnimation = undefined;
				}
				this.ctx.statusContainer.clear();

				// Create new session
				this.clearExtensionTerminalInputListeners();
				this.clearHookWidgets();
				const success = await this.ctx.session.newSession({ parentSession: options?.parentSession });
				if (!success) {
					return { cancelled: true };
				}

				// Call setup callback if provided
				if (options?.setup) {
					await options.setup(this.ctx.sessionManager);
				}

				// Clear UI state
				this.ctx.chatContainer.clear();
				this.ctx.pendingMessagesContainer.clear();
				this.ctx.compactionQueuedMessages = [];
				this.ctx.streamingComponent = undefined;
				this.ctx.streamingMessage = undefined;
				this.ctx.pendingTools.clear();

				this.ctx.chatContainer.addChild(new Spacer(1));
				this.ctx.chatContainer.addChild(
					new Text(`${theme.fg("accent", `${theme.status.success} New session started`)}`, 1, 1),
				);
				await this.ctx.reloadTodos();
				this.ctx.ui.requestRender();

				return { cancelled: false };
			},
			branch: async entryId => {
				if (this.ctx.isBackgrounded) {
					return { cancelled: true };
				}
				const result = await this.ctx.session.branch(entryId);
				if (result.cancelled) {
					return { cancelled: true };
				}

				// Update UI
				this.ctx.chatContainer.clear();
				this.ctx.renderInitialMessages();
				await this.ctx.reloadTodos();
				this.ctx.editor.setText(result.selectedText);
				this.ctx.showStatus("Branched to new session");

				return { cancelled: false };
			},
			navigateTree: async (targetId, options) => {
				if (this.ctx.isBackgrounded) {
					return { cancelled: true };
				}
				const result = await this.ctx.session.navigateTree(targetId, { summarize: options?.summarize });
				if (result.cancelled) {
					return { cancelled: true };
				}

				// Update UI
				this.ctx.chatContainer.clear();
				this.ctx.renderInitialMessages();
				await this.ctx.reloadTodos();
				if (result.editorText && !this.ctx.editor.getText().trim()) {
					this.ctx.editor.setText(result.editorText);
				}
				this.ctx.showStatus("Navigated to selected point");

				return { cancelled: false };
			},
			compact: async instructionsOrOptions => this.#handleInteractiveCompact(instructionsOrOptions),
			switchSession: async sessionPath => {
				if (this.ctx.isBackgrounded) {
					return { cancelled: true };
				}
				this.clearHookWidgets();
				const result = await this.ctx.session.switchSession(sessionPath);
				if (!result) {
					return { cancelled: true };
				}
				this.ctx.chatContainer.clear();
				this.ctx.renderInitialMessages();
				await this.ctx.reloadTodos();
				return { cancelled: false };
			},
		};

		extensionRunner.initialize(actions, contextActions, commandActions, uiContext);
	}

	createBackgroundUiContext(): ExtensionUIContext {
		return {
			select: async (_title: string, _options: string[], _dialogOptions) => undefined,
			confirm: async (_title: string, _message: string, _dialogOptions) => false,
			input: async (_title: string, _placeholder?: string, _dialogOptions?: unknown) => undefined,
			notify: () => {},
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWidget: () => {},
			setTitle: () => {},
			custom: async () => undefined as never,
			setEditorText: () => {},
			pasteToEditor: () => {},
			getEditorText: () => "",
			editor: async () => undefined,
			get theme() {
				return theme;
			},
			getAllThemes: () => Promise.resolve([]),
			getTheme: () => Promise.resolve(undefined),
			setTheme: () => Promise.resolve({ success: false, error: "Background mode" }),
			setFooter: () => {},
			setHeader: () => {},
			setEditorComponent: () => {},
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}

	/**
	 * Emit session event to all extension tools.
	 */
	async emitCustomToolSessionEvent(
		reason: "start" | "switch" | "branch" | "tree" | "shutdown",
		previousSessionFile?: string,
	): Promise<void> {
		const event = { reason, previousSessionFile };
		const uiContext = this.ctx.session.extensionRunner?.getUIContext();
		if (!uiContext) {
			return;
		}
		for (const registeredTool of this.ctx.session.extensionRunner?.getAllRegisteredTools() ?? []) {
			if (registeredTool.definition.onSession) {
				try {
					await registeredTool.definition.onSession(event, {
						ui: uiContext,
						getContextUsage: () => this.ctx.session.getContextUsage(),
						compact: instructionsOrOptions => this.#compactSession(instructionsOrOptions),
						hasUI: !this.ctx.isBackgrounded,
						cwd: this.ctx.sessionManager.getCwd(),
						sessionManager: this.ctx.session.sessionManager,
						modelRegistry: this.ctx.session.modelRegistry,
						model: this.ctx.session.model,
						isIdle: () => !this.ctx.session.isStreaming,
						hasPendingMessages: () => this.ctx.session.queuedMessageCount > 0,
						hasQueuedMessages: () => this.ctx.session.queuedMessageCount > 0,
						abort: () => {
							this.ctx.session.abort();
						},
						shutdown: () => {
							// Signal shutdown request
						},
						getSystemPrompt: () => this.ctx.session.systemPrompt,
					});
				} catch (err) {
					this.showToolError(registeredTool.definition.name, err instanceof Error ? err.message : String(err));
				}
			}
		}
	}

	/**
	 * Show a tool error in the chat.
	 */
	showToolError(toolName: string, error: string): void {
		if (this.ctx.isBackgrounded) {
			logger.error(`Tool "${toolName}" error: ${error}`);
			return;
		}
		const errorText = new Text(theme.fg("error", `Tool "${toolName}" error: ${error}`), 1, 0);
		this.ctx.chatContainer.addChild(errorText);
		this.ctx.ui.requestRender();
	}

	/**
	 * Set hook status text in the footer.
	 */
	setHookStatus(key: string, text: string | undefined): void {
		if (this.ctx.isBackgrounded) {
			return;
		}
		this.ctx.statusLine.setHookStatus(key, text);
		this.ctx.ui.requestRender();
	}

	/**
	 * Show a selector for hooks.
	 */
	showHookSelector(
		title: string,
		options: string[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		const { promise, finish, attachAbort } = this.#createHookDialogState(
			() => this.hideHookSelector(),
			dialogOptions?.signal,
		);
		const requestedTitleRows = dialogOptions?.scrollTitleRows;
		const baseMaxVisible = Math.max(4, Math.min(15, this.ctx.ui.terminal.rows - 12));
		const scrollOptionRows = Math.max(1, Math.min(baseMaxVisible, options.length));
		const maxVisible =
			requestedTitleRows === undefined ? baseMaxVisible : Math.min(15, Math.max(3, scrollOptionRows + 1));
		const listChromeRows = dialogOptions?.outline === true ? HOOK_SELECTOR_OUTLINE_ROWS : 0;
		// Reserve rows for the inline custom-input editor so opening it doesn't
		// push the scrollable title past the viewport into terminal scrollback.
		const inlineInputRows = dialogOptions?.customInput ? HOOK_SELECTOR_INLINE_INPUT_ROWS : 0;
		const availableTitleRows =
			this.ctx.ui.terminal.rows - scrollOptionRows - listChromeRows - inlineInputRows - HOOK_SELECTOR_CHROME_ROWS;
		const scrollTitleRows =
			requestedTitleRows === undefined ? undefined : Math.max(1, Math.min(requestedTitleRows, availableTitleRows));

		ringTerminalBell(classifyHookSelectorBellEvent(title));

		this.ctx.hookSelector = new HookSelectorComponent(
			title,
			options,
			option => {
				this.hideHookSelector();
				finish(option);
			},
			() => {
				this.hideHookSelector();
				finish(undefined);
			},
			{
				onLeft: dialogOptions?.onLeft
					? () => {
							this.hideHookSelector();
							dialogOptions.onLeft?.();
							finish(undefined);
						}
					: undefined,
				onRight: dialogOptions?.onRight
					? () => {
							this.hideHookSelector();
							dialogOptions.onRight?.();
							finish(undefined);
						}
					: undefined,
				onExternalEditor: dialogOptions?.onExternalEditor,
				helpText: dialogOptions?.helpText,
				initialIndex: dialogOptions?.initialIndex,
				timeout: dialogOptions?.timeout,
				onTimeout: dialogOptions?.onTimeout,
				tui: this.ctx.ui,
				// Share the main prompt editor's autocomplete provider so the
				// inline "Other (type your own)" editor supports `@` file links.
				autocompleteProvider: dialogOptions?.customInput ? this.ctx.editor.getAutocompleteProvider() : undefined,
				outline: dialogOptions?.outline,
				wrapFocused: dialogOptions?.wrapFocused,
				scrollTitleRows,
				maxVisible,
				customInput: dialogOptions?.customInput
					? {
							optionLabel: dialogOptions.customInput.optionLabel,
							onSubmit: text => {
								const optionLabel = dialogOptions.customInput?.optionLabel;
								this.hideHookSelector();
								dialogOptions.customInput?.onSubmit(text);
								finish(optionLabel);
							},
						}
					: undefined,
			},
		);
		// Detach (not dispose) the reusable editor before mounting the transient hook UI, so the
		// disposing clear() only tears down a prior transient — the editor is re-added intact on close.
		this.ctx.editorContainer.detachChild(this.ctx.editor);
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(this.ctx.hookSelector);
		this.ctx.ui.setFocus(this.ctx.hookSelector);
		this.ctx.ui.requestRender();
		attachAbort();
		return promise;
	}

	/**
	 * Hide the hook selector.
	 */
	hideHookSelector(): void {
		this.ctx.hookSelector?.dispose();
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(this.ctx.editor);
		this.ctx.hookSelector = undefined;
		this.ctx.ui.setFocus(this.ctx.editor);
		this.ctx.ui.requestRender();
	}

	/**
	 * Show a confirmation dialog for hooks.
	 */
	async showHookConfirm(title: string, message: string): Promise<boolean> {
		const result = await this.showHookSelector(`${title}\n${message}`, ["Yes", "No"]);
		return result === "Yes";
	}

	/**
	 * Show a text input for hooks.
	 */
	showHookInput(
		title: string,
		placeholder?: string,
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		const { promise, finish, attachAbort } = this.#createHookDialogState(
			() => this.hideHookInput(),
			dialogOptions?.signal,
		);
		this.ctx.hookInput = new HookInputComponent(
			title,
			placeholder,
			value => {
				this.hideHookInput();
				finish(value);
			},
			() => {
				this.hideHookInput();
				finish(undefined);
			},
			{
				timeout: dialogOptions?.timeout,
				onTimeout: dialogOptions?.onTimeout,
				tui: this.ctx.ui,
			},
		);
		// Detach (not dispose) the reusable editor before mounting the transient hook UI, so the
		// disposing clear() only tears down a prior transient — the editor is re-added intact on close.
		this.ctx.editorContainer.detachChild(this.ctx.editor);
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(this.ctx.hookInput);
		this.ctx.ui.setFocus(this.ctx.hookInput);
		this.ctx.ui.requestRender();
		attachAbort();
		return promise;
	}

	/**
	 * Hide the hook input.
	 */
	hideHookInput(): void {
		this.ctx.hookInput?.dispose();
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(this.ctx.editor);
		this.ctx.hookInput = undefined;
		this.ctx.ui.setFocus(this.ctx.editor);
		this.ctx.ui.requestRender();
	}

	/**
	 * Show a multi-line editor for hooks (with Ctrl+G support).
	 */
	showHookEditor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		const { promise, finish, attachAbort } = this.#createHookDialogState(
			() => this.hideHookEditor(),
			dialogOptions?.signal,
		);
		this.ctx.hookEditor = new HookEditorComponent(
			this.ctx.ui,
			title,
			prefill,
			value => {
				this.hideHookEditor();
				finish(value);
			},
			() => {
				this.hideHookEditor();
				finish(undefined);
			},
			editorOptions,
		);

		// Detach (not dispose) the reusable editor before mounting the transient hook UI, so the
		// disposing clear() only tears down a prior transient — the editor is re-added intact on close.
		this.ctx.editorContainer.detachChild(this.ctx.editor);
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(this.ctx.hookEditor);
		this.ctx.ui.setFocus(this.ctx.hookEditor);
		this.ctx.ui.requestRender();
		attachAbort();
		return promise;
	}

	/**
	 * Hide the hook editor.
	 */
	hideHookEditor(): void {
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(this.ctx.editor);
		this.ctx.hookEditor = undefined;
		this.ctx.ui.setFocus(this.ctx.editor);
		this.ctx.ui.requestRender();
	}

	/**
	 * Show a notification for hooks.
	 */
	showHookNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.ctx.showError(message);
		} else if (type === "warning") {
			this.ctx.showWarning(message);
		} else {
			this.ctx.showStatus(message);
		}
	}

	/**
	 * Show a custom component with keyboard focus.
	 */
	async showHookCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: { overlay?: boolean },
	): Promise<T> {
		const savedText = this.ctx.editor.getText();
		const keybindings = KeybindingsManager.inMemory();

		const { promise, resolve } = Promise.withResolvers<T>();
		let component: (Component & { dispose?(): void }) | undefined;
		let closed = false;

		const close = (result: T) => {
			if (closed) return;
			closed = true;
			this.#clearActiveHookCustom();
			if (!options?.overlay) {
				this.ctx.editorContainer.clear();
				this.ctx.editorContainer.addChild(this.ctx.editor);
				this.ctx.editor.setText(savedText);
			}
			this.ctx.ui.setFocus(this.ctx.editor);
			this.ctx.ui.requestRender();
			resolve(result);
		};

		this.#clearActiveHookCustom();
		Promise.try(() => factory(this.ctx.ui, theme, keybindings, close)).then(c => {
			if (closed) {
				c.dispose?.();
				return;
			}
			component = c;
			this.#activeHookCustomComponent = c;
			if (options?.overlay) {
				this.#activeHookCustomOverlay = this.ctx.ui.showOverlay(component, {
					anchor: "bottom-center",
					width: "100%",
					maxHeight: "100%",
					margin: 0,
				});
				return;
			}
			// Detach (not dispose) the reusable editor before mounting the transient hook UI, so the
			// disposing clear() only tears down a prior transient — the editor is re-added intact on close.
			this.ctx.editorContainer.detachChild(this.ctx.editor);
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(component);
			this.ctx.ui.setFocus(component);
			this.ctx.ui.requestRender();
		});
		return promise;
	}

	/**
	 * Show an extension error in the UI.
	 */
	addExtensionTerminalInputListener(handler: TerminalInputHandler): () => void {
		const unsubscribe = this.ctx.ui.addInputListener(handler);
		this.#extensionTerminalInputUnsubscribers.add(unsubscribe);
		return () => {
			unsubscribe();
			this.#extensionTerminalInputUnsubscribers.delete(unsubscribe);
		};
	}

	clearHookWidgets(): void {
		this.#clearActiveHookCustom();
		for (const widget of this.#hookWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.#hookWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.#hookWidgetsAbove.clear();
		this.#hookWidgetsBelow.clear();
		this.#rebuildHookWidgets();
	}

	clearExtensionTerminalInputListeners(): void {
		for (const unsubscribe of this.#extensionTerminalInputUnsubscribers) {
			unsubscribe();
		}
		this.#extensionTerminalInputUnsubscribers.clear();
	}

	showExtensionError(extensionPath: string, error: string): void {
		const errorText = new Text(theme.fg("error", `Extension "${extensionPath}" error: ${error}`), 1, 0);
		this.ctx.chatContainer.addChild(errorText);
		this.ctx.ui.requestRender();
	}
	async #handleInteractiveCompact(instructionsOrOptions: string | CompactOptions | undefined): Promise<void> {
		if (this.ctx.isBackgrounded) {
			await this.#compactSession(instructionsOrOptions);
			return;
		}
		await this.ctx.executeCompaction(instructionsOrOptions, false);
	}

	async #compactSession(instructionsOrOptions: string | CompactOptions | undefined): Promise<void> {
		const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
		const options =
			instructionsOrOptions && typeof instructionsOrOptions === "object" ? instructionsOrOptions : undefined;
		await this.ctx.session.compact(instructions, options);
	}

	async #updateSessionName(name: string): Promise<void> {
		await this.ctx.sessionManager.setSessionName(name, "user");
		setSessionTerminalTitle(this.ctx.sessionManager.getSessionName(), this.ctx.sessionManager.getCwd());
	}

	#sendExtensionUserMessage: SendUserMessageHandler = (content, options) => {
		this.ctx.session.sendUserMessage(content, options).catch((err: unknown) => {
			this.ctx.showError(`Extension sendUserMessage failed: ${err instanceof Error ? err.message : String(err)}`);
		});
	};

	#applyCustomMessageDisplay(wasStreaming: boolean, shouldDisplay: boolean | undefined): void {
		// For non-streaming cases with display=true, update UI
		// (streaming cases update via message_end event)
		if (!this.ctx.isBackgrounded && !wasStreaming && shouldDisplay) {
			this.ctx.rebuildChatFromMessages();
		}
	}

	#createHookDialogState(
		hide: () => void,
		signal: AbortSignal | undefined,
	): {
		promise: Promise<string | undefined>;
		finish: (value: string | undefined) => void;
		attachAbort: () => void;
	} {
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		let settled = false;
		const onAbort = () => {
			hide();
			if (!settled) {
				settled = true;
				resolve(undefined);
			}
		};
		const finish = (value: string | undefined) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			resolve(value);
		};
		const attachAbort = () => {
			if (!signal) return;
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		};
		return { promise, finish, attachAbort };
	}
}
