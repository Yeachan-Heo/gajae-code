import type { AgentMessage } from "@gajae-code/agent-core";
import type { AssistantMessage, ImageContent, Message } from "@gajae-code/ai";
import { type Component, Spacer, Text, TruncatedText } from "@gajae-code/tui";
import { settings } from "../../config/settings";
import { resolveSubskillActivationForSkillInvocation } from "../../extensibility/gjc-plugins";
import { buildSkillPromptMessage, parseSkillInvocations } from "../../extensibility/skills";
import { AssistantMessageComponent } from "../../modes/components/assistant-message";
import { BashExecutionComponent } from "../../modes/components/bash-execution";
import { BranchSummaryMessageComponent } from "../../modes/components/branch-summary-message";
import { CompactionSummaryMessageComponent } from "../../modes/components/compaction-summary-message";
import { CustomMessageComponent } from "../../modes/components/custom-message";
import { DynamicBorder } from "../../modes/components/dynamic-border";
import { EvalExecutionComponent } from "../../modes/components/eval-execution";
import {
	ReadToolGroupComponent,
	readArgsHaveTarget,
	readArgsTargetInternalUrl,
} from "../../modes/components/read-tool-group";
import { SkillMessageComponent } from "../../modes/components/skill-message";
import { ToolExecutionComponent } from "../../modes/components/tool-execution";
import { UserMessageComponent } from "../../modes/components/user-message";
import { theme } from "../../modes/theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext } from "../../modes/types";
import {
	type CustomMessage,
	isSilentAbort,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "../../session/messages";
import type { SessionContext } from "../../session/session-manager";
import { formatBytes, formatDuration } from "../../tools/render-utils";
import { buildAbortDisplayMessage } from "./abort-message";

type TextBlock = { type: "text"; text: string };
interface RenderInitialMessagesOptions {
	preserveExistingChat?: boolean;
}

function cloneRenderArgs(args: Record<string, unknown>): Record<string, unknown> {
	try {
		return structuredClone(args);
	} catch {
		return { ...args };
	}
}

export function argsWithPartialJson(args: unknown, partialJson: unknown): unknown {
	if (typeof partialJson !== "string" || !args || typeof args !== "object" || Array.isArray(args)) return args;
	// Keep the transient streaming buffer on a renderer-only snapshot. The live
	// assistant message args are later validated/executed, so UI-only metadata or
	// renderer mutations must never share that object reference.
	const renderArgs = cloneRenderArgs(args as Record<string, unknown>);
	Object.defineProperty(renderArgs, "__partialJson", {
		value: partialJson,
		enumerable: false,
		configurable: true,
		writable: true,
	});
	return renderArgs;
}

type QueuedMessages = {
	steering: string[];
	followUp: string[];
};

export class UiHelpers {
	constructor(private ctx: InteractiveModeContext) {}

	/** Extract text content from a user message */
	getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((content): content is TextBlock => content.type === "text");
		return textBlocks.map(block => block.text).join("");
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	showStatus(message: string, options?: { dim?: boolean }): void {
		if (this.ctx.isBackgrounded) {
			return;
		}
		const children = this.ctx.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;
		const useDim = options?.dim ?? true;
		const rendered = useDim ? theme.fg("dim", message) : message;

		if (last && secondLast && last === this.ctx.lastStatusText && secondLast === this.ctx.lastStatusSpacer) {
			this.ctx.lastStatusText.setText(rendered);
			this.ctx.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(rendered, 1, 0);
		this.ctx.chatContainer.addChild(spacer);
		this.ctx.chatContainer.addChild(text);
		this.ctx.lastStatusSpacer = spacer;
		this.ctx.lastStatusText = text;
		this.ctx.ui.requestRender();
	}

	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): Component[] {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ctx.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(message.exitCode, message.cancelled, {
					truncation: message.meta?.truncation,
				});
				this.ctx.chatContainer.addChild(component);
				break;
			}
			case "pythonExecution": {
				const component = new EvalExecutionComponent(message.code, this.ctx.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(message.exitCode, message.cancelled, {
					truncation: message.meta?.truncation,
				});
				this.ctx.chatContainer.addChild(component);
				break;
			}
			case "hookMessage":
			case "custom": {
				if (message.display) {
					if (message.customType === "async-result") {
						const details = (
							message as CustomMessage<{
								jobId?: string;
								type?: "bash" | "task";
								label?: string;
								durationMs?: number;
								jobs?: Array<{
									jobId?: string;
									type?: "bash" | "task";
									label?: string;
									durationMs?: number;
								}>;
							}>
						).details;
						const jobs =
							details?.jobs && details.jobs.length > 0
								? details.jobs
								: [
										{
											jobId: details?.jobId,
											type: details?.type,
											label: details?.label,
											durationMs: details?.durationMs,
										},
									];
						for (const job of jobs) {
							const jobId = job.jobId ?? "unknown";
							const typeLabel = job.type ? `[${job.type}]` : "[job]";
							const duration = typeof job.durationMs === "number" ? formatDuration(job.durationMs) : undefined;
							const line = [
								theme.fg("success", `${theme.status.success} Background job completed`),
								theme.fg("dim", typeLabel),
								theme.fg("accent", jobId),
								duration ? theme.fg("dim", `(${duration})`) : undefined,
							]
								.filter(Boolean)
								.join(" ");
							this.ctx.chatContainer.addChild(new Text(line, 1, 0));
						}
						break;
					}
					if (message.customType === SKILL_PROMPT_MESSAGE_TYPE) {
						const component = new SkillMessageComponent(message as CustomMessage<SkillPromptDetails>);
						component.setExpanded(this.ctx.toolOutputExpanded);
						this.ctx.chatContainer.addChild(component);
						break;
					}
					if (
						message.customType === "irc:incoming" ||
						message.customType === "irc:autoreply" ||
						message.customType === "irc:relay"
					) {
						const details = (
							message as CustomMessage<{
								from?: string;
								to?: string;
								message?: string;
								reply?: string;
								body?: string;
								kind?: "message" | "reply";
							}>
						).details;
						let arrow: string;
						let body: string;
						if (message.customType === "irc:incoming") {
							const peer = details?.from ?? "?";
							body = details?.message ?? "";
							arrow = `⇦ ${peer}`;
						} else if (message.customType === "irc:autoreply") {
							const peer = details?.to ?? "?";
							body = details?.reply ?? "";
							arrow = `⇨ ${peer}`;
						} else {
							const from = details?.from ?? "?";
							const to = details?.to ?? "?";
							body = details?.body ?? "";
							arrow = `${from} ⇨ ${to}`;
						}
						const components: Component[] = [];
						const header = `${theme.fg("accent", `[IRC] ${arrow}`)}`;
						const headerComponent = new Text(header, 1, 0);
						this.ctx.chatContainer.addChild(headerComponent);
						components.push(headerComponent);
						if (body) {
							for (const line of body.split("\n")) {
								const lineComponent = new Text(theme.fg("muted", `  ${line}`), 0, 0);
								this.ctx.chatContainer.addChild(lineComponent);
								components.push(lineComponent);
							}
						}
						return components;
					}
					if (message.customType === "subagent:steer" || message.customType === "subagent:steer:relay") {
						const details = (
							message as CustomMessage<{
								from?: string;
								to?: string;
								body?: string;
								state?: string;
							}>
						).details;
						const components: Component[] = [];
						const header = `${theme.fg("accent", `[Steer ${details?.state ?? "queued"}] ${details?.from ?? "?"} ⇨ ${details?.to ?? "?"}`)}`;
						const headerComponent = new Text(header, 1, 0);
						this.ctx.chatContainer.addChild(headerComponent);
						components.push(headerComponent);
						if (details?.body) {
							for (const line of details.body.split("\n")) {
								const lineComponent = new Text(theme.fg("muted", `  ${line}`), 0, 0);
								this.ctx.chatContainer.addChild(lineComponent);
								components.push(lineComponent);
							}
						}
						return components;
					}
					const renderer = this.ctx.session.extensionRunner?.getMessageRenderer(message.customType);
					// Both HookMessage and CustomMessage have the same structure, cast for compatibility
					const component = new CustomMessageComponent(message as CustomMessage<unknown>, renderer);
					component.setExpanded(this.ctx.toolOutputExpanded);
					this.ctx.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				this.ctx.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message);
				component.setExpanded(this.ctx.toolOutputExpanded);
				this.ctx.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				this.ctx.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message);
				component.setExpanded(this.ctx.toolOutputExpanded);
				this.ctx.chatContainer.addChild(component);
				break;
			}
			case "fileMention": {
				// Render compact file mention display
				for (const file of message.files) {
					let suffix: string;
					if (file.skippedReason === "tooLarge") {
						const size = typeof file.byteSize === "number" ? formatBytes(file.byteSize) : "unknown size";
						suffix = `(skipped: ${size})`;
					} else {
						suffix = file.image
							? "(image)"
							: file.lineCount === undefined
								? "(unknown lines)"
								: `(${file.lineCount} lines)`;
					}
					const text = `${theme.fg("dim", `${theme.tree.last} `)}${theme.fg("muted", "Read")} ${theme.fg(
						"accent",
						file.path,
					)} ${theme.fg("dim", suffix)}`;
					this.ctx.chatContainer.addChild(new Text(text, 0, 0));
				}
				break;
			}
			case "user":
			case "developer": {
				const textContent = this.ctx.getUserMessageText(message);
				if (textContent) {
					const isSynthetic = message.role === "developer" ? true : (message.synthetic ?? false);
					const userComponent = new UserMessageComponent(textContent, isSynthetic);
					this.ctx.chatContainer.addChild(userComponent);
					if (options?.populateHistory && message.role === "user" && !isSynthetic) {
						this.ctx.editor.addToHistory(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const assistantComponent = new AssistantMessageComponent(message, this.ctx.hideThinkingBlock, () =>
					this.ctx.ui.requestRender(),
				);
				this.ctx.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				message satisfies never;
			}
		}
		return [];
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after compaction.
	 * @param sessionContext Session context to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	renderSessionContext(
		sessionContext: SessionContext,
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		// Preserved: message_start handler owns this lifecycle (see #783)
		this.ctx.pendingTools.clear();

		if (options.updateFooter) {
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
		}

		let readGroup: ReadToolGroupComponent | null = null;
		const readToolCallArgs = new Map<string, Record<string, unknown>>();
		const readToolCallAssistantComponents = new Map<string, AssistantMessageComponent>();
		const deferredMessages: AgentMessage[] = [];
		for (const message of sessionContext.messages) {
			// Defer compaction summaries so they render at the bottom (visible after scroll)
			if (message.role === "compactionSummary") {
				deferredMessages.push(message);
				continue;
			}
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				this.ctx.addMessageToChat(message);
				const lastChild = this.ctx.chatContainer.children[this.ctx.chatContainer.children.length - 1];
				const assistantComponent = lastChild instanceof AssistantMessageComponent ? lastChild : undefined;
				if (assistantComponent) {
					assistantComponent.setUsageInfo(message.usage);
				}
				readGroup = null;
				const isAbortedSilently = message.stopReason === "aborted" && isSilentAbort(message.errorMessage);
				const hasErrorStop =
					!isAbortedSilently && (message.stopReason === "aborted" || message.stopReason === "error");
				const errorMessage = hasErrorStop
					? message.stopReason === "aborted"
						? buildAbortDisplayMessage({
								errorMessage: message.errorMessage,
								retryAttempt: this.ctx.session.retryAttempt,
							})
						: message.errorMessage || "Error"
					: null;

				// Render tool call components
				for (const content of message.content) {
					if (content.type !== "toolCall") {
						continue;
					}

					if (
						content.name === "read" &&
						readArgsHaveTarget(content.arguments) &&
						!readArgsTargetInternalUrl(content.arguments)
					) {
						if (hasErrorStop && errorMessage) {
							if (!readGroup) {
								readGroup = new ReadToolGroupComponent({
									showContentPreview: this.ctx.settings.get("read.toolResultPreview"),
								});
								readGroup.setExpanded(this.ctx.toolOutputExpanded);
								this.ctx.chatContainer.addChild(readGroup);
							}
							readGroup.updateArgs(content.arguments, content.id);
							readGroup.updateResult(
								{ content: [{ type: "text", text: errorMessage }], isError: true },
								false,
								content.id,
							);
						} else {
							const normalizedArgs =
								content.arguments && typeof content.arguments === "object" && !Array.isArray(content.arguments)
									? (content.arguments as Record<string, unknown>)
									: {};
							readToolCallArgs.set(content.id, normalizedArgs);
							if (assistantComponent) {
								readToolCallAssistantComponents.set(content.id, assistantComponent);
							}
						}
						continue;
					}

					readGroup = null;
					const tool = this.ctx.session.getToolByName(content.name);
					const renderArgs = argsWithPartialJson(
						content.arguments,
						"partialJson" in content ? content.partialJson : undefined,
					);
					const component = new ToolExecutionComponent(
						content.name,
						renderArgs,
						{
							showImages: settings.get("terminal.showImages"),
							editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
							editAllowFuzzy: settings.get("edit.fuzzyMatch"),
							hashlineAutoDropPureInsertDuplicates: settings.get("edit.hashlineAutoDropPureInsertDuplicates"),
						},
						tool,
						this.ctx.ui,
						this.ctx.sessionManager.getCwd(),
						content.id,
					);
					component.setExpanded(this.ctx.toolOutputExpanded);
					this.ctx.chatContainer.addChild(component);

					if (hasErrorStop && errorMessage) {
						component.updateResult(
							{ content: [{ type: "text", text: errorMessage }], isError: true },
							false,
							content.id,
						);
					} else {
						this.ctx.pendingTools.set(content.id, component);
					}
				}
			} else if (message.role === "toolResult") {
				const pendingReadComponent = this.ctx.pendingTools.get(message.toolCallId);
				const isReadGroupResult =
					message.toolName === "read" &&
					(!pendingReadComponent || pendingReadComponent instanceof ReadToolGroupComponent);
				if (isReadGroupResult) {
					const assistantComponent = readToolCallAssistantComponents.get(message.toolCallId);
					const images: ImageContent[] = message.content.filter(
						(content): content is ImageContent => content.type === "image",
					);
					if (images.length > 0 && assistantComponent && settings.get("terminal.showImages")) {
						assistantComponent.setToolResultImages(message.toolCallId, images);
						const hasText = message.content.some(c => c.type === "text");
						if (!hasText) {
							readToolCallArgs.delete(message.toolCallId);
							readToolCallAssistantComponents.delete(message.toolCallId);
							continue;
						}
					}
					let component = this.ctx.pendingTools.get(message.toolCallId);
					if (!component) {
						if (!readGroup) {
							readGroup = new ReadToolGroupComponent({
								showContentPreview: this.ctx.settings.get("read.toolResultPreview"),
							});
							readGroup.setExpanded(this.ctx.toolOutputExpanded);
							this.ctx.chatContainer.addChild(readGroup);
						}
						const args = readToolCallArgs.get(message.toolCallId);
						if (args) {
							readGroup.updateArgs(args, message.toolCallId);
						}
						component = readGroup;
						this.ctx.pendingTools.set(message.toolCallId, readGroup);
					}
					component.updateResult(message, false, message.toolCallId);
					this.ctx.pendingTools.delete(message.toolCallId);
					readToolCallArgs.delete(message.toolCallId);
					readToolCallAssistantComponents.delete(message.toolCallId);
					continue;
				}

				// Match tool results to pending tool components
				const component = this.ctx.pendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message, false, message.toolCallId);
					this.ctx.pendingTools.delete(message.toolCallId);
				}
			} else {
				// All other messages use standard rendering
				this.ctx.addMessageToChat(message, options);
			}
		}

		// Render deferred messages (compaction summaries) at the bottom so they're visible
		for (const message of deferredMessages) {
			this.ctx.addMessageToChat(message, options);
		}

		this.ctx.pendingTools.clear();
		this.ctx.ui.requestRender();
	}

	renderInitialMessages(prebuiltContext?: SessionContext, options: RenderInitialMessagesOptions = {}): void {
		// This path is used to rebuild the visible chat transcript (e.g. after custom/debug UI).
		// Clear existing rendered chat first to avoid duplicating the full session in the container.
		const preservedChatChildren = options.preserveExistingChat ? this.ctx.chatContainer.children : undefined;
		this.ctx.chatContainer.clear();
		this.ctx.pendingMessagesContainer.clear();
		this.ctx.pendingBashComponents = [];
		this.ctx.pendingPythonComponents = [];

		// Reuse a pre-built context when available (e.g. from navigateTree) to avoid a second O(N) walk.
		const context = prebuiltContext ?? this.ctx.sessionManager.buildSessionContext();
		this.ctx.renderSessionContext(context, {
			updateFooter: true,
			populateHistory: true,
		});

		// Show compaction info if session was compacted
		const allEntries = this.ctx.sessionManager.getEntries();
		let compactionCount = 0;
		for (const entry of allEntries) {
			if (entry.type === "compaction") {
				compactionCount++;
			}
		}
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.ctx.showStatus(`Session compacted ${times}`);
		}
		if (preservedChatChildren && preservedChatChildren.length > 0) {
			for (const child of preservedChatChildren) {
				this.ctx.chatContainer.addChild(child);
			}
			this.ctx.ui.requestRender();
		}
	}

	clearEditor(): void {
		if (this.ctx.isBackgrounded) {
			return;
		}
		this.ctx.editor.setText("");
		this.ctx.pendingImages = [];
		this.ctx.ui.requestRender();
	}

	showError(errorMessage: string): void {
		if (this.ctx.isBackgrounded) {
			process.stderr.write(`Error: ${errorMessage}\n`);
			return;
		}
		this.ctx.chatContainer.addChild(new Spacer(1));
		this.ctx.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
		this.ctx.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		if (this.ctx.isBackgrounded) {
			process.stderr.write(`Warning: ${warningMessage}\n`);
			return;
		}
		this.ctx.chatContainer.addChild(new Spacer(1));
		this.ctx.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		this.ctx.ui.requestRender();
	}

	showNewVersionNotification(newVersion: string): void {
		this.ctx.chatContainer.addChild(new Spacer(1));
		this.ctx.chatContainer.addChild(new DynamicBorder(text => theme.fg("warning", text)));
		this.ctx.chatContainer.addChild(
			new Text(
				theme.bold(theme.fg("warning", "Update Available")) +
					"\n" +
					theme.fg("muted", `New version ${newVersion} is available. Run: `) +
					theme.fg("accent", "gjc update"),
				1,
				0,
			),
		);
		this.ctx.chatContainer.addChild(new DynamicBorder(text => theme.fg("warning", text)));
		this.ctx.ui.requestRender();
	}

	updatePendingMessagesDisplay(): void {
		this.ctx.pendingMessagesContainer.clear();
		const queuedMessages = this.ctx.session.getQueuedMessages() as QueuedMessages;

		const steeringMessages: Array<{ message: string; label: string }> = [];
		for (const message of queuedMessages.steering) {
			steeringMessages.push({ message, label: "Steer" });
		}
		for (const entry of this.ctx.compactionQueuedMessages as CompactionQueuedMessage[]) {
			if (entry.mode === "steer") {
				steeringMessages.push({ message: entry.text, label: "Steer" });
			}
		}

		const followUpMessages: Array<{ message: string; label: string }> = [];
		for (const message of queuedMessages.followUp) {
			followUpMessages.push({ message, label: "Queued" });
		}
		for (const entry of this.ctx.compactionQueuedMessages as CompactionQueuedMessage[]) {
			if (entry.mode === "followUp") {
				followUpMessages.push({ message: entry.text, label: "Queued" });
			}
		}

		const allMessages = [...steeringMessages, ...followUpMessages];
		if (allMessages.length > 0) {
			this.ctx.pendingMessagesContainer.addChild(new Spacer(1));
			for (const entry of allMessages) {
				const queuedText = theme.fg("dim", `${entry.label}: ${entry.message}`);
				this.ctx.pendingMessagesContainer.addChild(new TruncatedText(queuedText, 1, 0));
			}
			const dequeueKey = this.ctx.keybindings.getDisplayString("app.message.dequeue") || "Alt+Up/Alt+Down";
			const hintText = theme.fg("dim", `${theme.tree.hook} ${dequeueKey} to select/edit/reorder`);
			this.ctx.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
	}

	queueCompactionMessage(text: string, mode: "steer" | "followUp"): void {
		this.ctx.compactionQueuedMessages.push({ text, mode } as CompactionQueuedMessage);
		this.ctx.editor.addToHistory(text);
		this.ctx.editor.setText("");
		this.ctx.updatePendingMessagesDisplay();
		this.ctx.showStatus("Queued message for after compaction");
	}
	#hasSkillInvocations(text: string): boolean {
		return parseSkillInvocations(text, this.ctx.skillCommands ?? new Map()).length > 0;
	}

	#isCompactionCommandMessage(text: string): boolean {
		return this.#hasSkillInvocations(text) || this.isKnownSlashCommand(text);
	}

	async #deliverQueuedSkillMessage(message: CompactionQueuedMessage): Promise<boolean> {
		const invocations = parseSkillInvocations(message.text, this.ctx.skillCommands ?? new Map());
		if (invocations.length === 0) {
			return false;
		}

		for (let index = 0; index < invocations.length; index += 1) {
			const invocation = invocations[index];
			if (!invocation) continue;

			const activationResult = await resolveSubskillActivationForSkillInvocation({
				cwd: this.ctx.sessionManager.getCwd(),
				sessionId: this.ctx.session.sessionId,
				skillName: invocation.skill.name,
				args: invocation.args,
			});
			const built = await buildSkillPromptMessage(invocation.skill, activationResult.cleanedArgs, {
				subskillActivation: activationResult.activation,
				subskillActivationSet: activationResult.activeSubskillsToPersist,
				cwd: this.ctx.sessionManager.getCwd(),
				sessionId: this.ctx.session.sessionId,
			});
			const details: SkillPromptDetails = built.details;
			const displayText = `/${invocation.commandName}${activationResult.cleanedArgs ? ` ${activationResult.cleanedArgs}` : ""}`;

			if (this.ctx.session.isStreaming) {
				const tag = this.ctx.session.enqueueCustomMessageDisplay(displayText, message.mode);
				details.__pendingDisplayTag = tag;
			}

			const isLast = index === invocations.length - 1;
			if (!this.ctx.session.isStreaming && !isLast) {
				await this.ctx.session.sendCustomMessage({
					customType: SKILL_PROMPT_MESSAGE_TYPE,
					content: built.message,
					display: true,
					details,
					attribution: "user",
				});
				continue;
			}

			await this.ctx.session.promptCustomMessage(
				{
					customType: SKILL_PROMPT_MESSAGE_TYPE,
					content: built.message,
					display: true,
					details,
					attribution: "user",
				},
				{ streamingBehavior: message.mode },
			);
		}

		if (this.ctx.session.isStreaming) {
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.ui.requestRender();
		}

		return true;
	}
	async #deliverQueuedMessage(message: CompactionQueuedMessage): Promise<void> {
		if (await this.#deliverQueuedSkillMessage(message)) {
			return;
		}
		if (this.isKnownSlashCommand(message.text)) {
			await this.ctx.session.prompt(message.text);
			return;
		}
		await this.ctx.withLocalSubmission(message.text, () =>
			message.mode === "followUp" ? this.ctx.session.followUp(message.text) : this.ctx.session.steer(message.text),
		);
	}

	isKnownSlashCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		if (!commandName) return false;

		if (this.ctx.session.extensionRunner?.getCommand(commandName)) {
			return true;
		}

		for (const command of this.ctx.session.customCommands) {
			if (command.command.name === commandName) {
				return true;
			}
		}

		return this.ctx.fileSlashCommands.has(commandName);
	}

	async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.ctx.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...(this.ctx.compactionQueuedMessages as CompactionQueuedMessage[])];
		this.ctx.compactionQueuedMessages = [] as CompactionQueuedMessage[];
		this.ctx.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			this.ctx.session.clearQueue();
			this.ctx.compactionQueuedMessages = queuedMessages;
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.showError(
				`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		};

		try {
			if (options?.willRetry) {
				for (const message of queuedMessages) {
					await this.#deliverQueuedMessage(message);
				}
				this.ctx.updatePendingMessagesDisplay();
				return;
			}

			let firstPromptIndex = -1;
			for (let i = 0; i < queuedMessages.length; i++) {
				if (!this.#isCompactionCommandMessage(queuedMessages[i].text)) {
					firstPromptIndex = i;
					break;
				}
			}
			if (firstPromptIndex === -1) {
				for (const message of queuedMessages) {
					await this.#deliverQueuedMessage(message);
				}
				return;
			}

			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				// preCommands are all slash commands; #deliverQueuedMessage handles
				// that branch (no local-submission marking needed since slash
				// commands don't generate a matching user message_start).
				await this.#deliverQueuedMessage(message);
			}

			// Pass streamingBehavior so that if the session is still streaming when
			// compaction-end fires (race window between isStreaming flipping false and
			// the event landing here), prompt() routes the message into the steer/
			// follow-up queue instead of throwing AgentBusyError. When the session is
			// genuinely idle, streamingBehavior is ignored and a fresh prompt runs as
			// before. This keeps the steer preview honest: if delivery has to be
			// deferred, the message lands in the same queue every other consumer
			// (Alt+Up dequeue, post-stream drain) already drains, instead of being
			// stranded in compactionQueuedMessages with no drainer.
			//
			// firstPrompt is fire-and-forget — its rejection is funneled through
			// `restoreQueue` rather than rethrown, so we use the primitive
			// recordLocalSubmission and dispose manually in the catch.
			const disposeFirstPrompt = this.ctx.recordLocalSubmission(firstPrompt.text);
			const promptPromise = this.ctx.session
				.prompt(firstPrompt.text, {
					streamingBehavior: firstPrompt.mode === "followUp" ? "followUp" : "steer",
				})
				.catch((error: unknown) => {
					disposeFirstPrompt();
					restoreQueue(error);
				});

			for (const message of rest) {
				await this.#deliverQueuedMessage(message);
			}
			this.ctx.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	/** Move pending bash components from pending area to chat */
	flushPendingBashComponents(): void {
		// Move (detach, not dispose) the live execution components from the pending
		// area into the chat transcript — they are reused instances, so a disposing
		// removeChild() would tear them down before re-adding.
		for (const component of this.ctx.pendingBashComponents) {
			this.ctx.pendingMessagesContainer.detachChild(component);
			this.ctx.chatContainer.addChild(component);
		}
		this.ctx.pendingBashComponents = [];
		for (const component of this.ctx.pendingPythonComponents) {
			this.ctx.pendingMessagesContainer.detachChild(component);
			this.ctx.chatContainer.addChild(component);
		}
		this.ctx.pendingPythonComponents = [];
	}

	findLastAssistantMessage(): AssistantMessage | undefined {
		for (let i = this.ctx.session.messages.length - 1; i >= 0; i--) {
			const message = this.ctx.session.messages[i];
			if (message?.role === "assistant") {
				return message as AssistantMessage;
			}
		}
		return undefined;
	}

	extractAssistantText(message: AssistantMessage): string {
		let text = "";
		for (const content of message.content) {
			if (content.type === "text") {
				text += content.text;
			}
		}
		return text.trim();
	}
}
