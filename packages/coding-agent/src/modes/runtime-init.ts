/**
 * Shared extension runtime wiring for non-interactive session callers.
 *
 * These callers initialize the extension runner with the same action handlers
 * that delegate to the {@link AgentSession}. Only error reporting, shutdown
 * behavior, and UI context differ between callers — those stay as
 * caller-supplied hooks.
 */
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { runExtensionCompact, runExtensionSetModel } from "../extensibility/extensions/compact-handler";
import { getSessionSlashCommands } from "../extensibility/extensions/get-commands-handler";
import type { ExtensionError, ExtensionUIContext } from "../extensibility/extensions/types";
import type { AgentSession } from "../session/agent-session";

import { parseThinkingLevel } from "../thinking";
import type { TodoPhase } from "../tools/todo-write";

/** Action name for an extension-originated send failure. */
export type ExtensionSendAction = "extension_send" | "extension_send_user";

export interface InitializeExtensionsOptions {
	/** Reports an error thrown by an extension-initiated send. */
	reportSendError: (action: ExtensionSendAction, error: Error) => void;
	/** Reports a runtime error surfaced through {@link ExtensionRunner.onError}. */
	reportRuntimeError: (error: ExtensionError) => void;
	/** Optional shutdown hook for caller-specific lifecycle signaling. */
	onShutdown?: () => void;
	/** Optional interactive UI context; omitted for headless callers. */
	uiContext?: ExtensionUIContext;
}

/**
 * Initialize the session's extension runner with the standard action set
 * shared by non-interactive modes, then emit `session_start`.
 *
 * No-op when the session was constructed without an extension runner.
 */
export async function initializeExtensions(session: AgentSession, options: InitializeExtensionsOptions): Promise<void> {
	const runner = session.extensionRunner;
	if (!runner) return;

	const { reportSendError, reportRuntimeError, onShutdown, uiContext } = options;
	const shutdown = onShutdown ?? (() => {});

	runner.initialize(
		// ExtensionActions
		{
			sendMessage: (message, sendOptions) => {
				session.sendCustomMessage(message, sendOptions).catch(e => {
					reportSendError("extension_send", e instanceof Error ? e : new Error(String(e)));
				});
			},
			sendUserMessage: (content, sendOptions) => {
				const send = session.sendUserMessage(content, sendOptions);
				void send.catch(e => {
					reportSendError("extension_send_user", e instanceof Error ? e : new Error(String(e)));
				});
				return send;
			},
			appendEntry: (customType, data) => {
				session.sessionManager.appendCustomEntry(customType, data);
			},
			setLabel: (targetId, label) => {
				session.sessionManager.appendLabelChange(targetId, label);
			},
			getActiveTools: () => session.getActiveToolNames(),
			getAllTools: () => session.getAllToolNames(),
			resolveTool: name => {
				const tool = session.getToolByName(name);
				return tool ? { safeSummary: tool.safeSummary, safeSummaryFields: tool.safeSummaryFields } : undefined;
			},
			setActiveTools: (toolNames: string[]) => session.setActiveToolsByName(toolNames),
			getCommands: () => getSessionSlashCommands(session),
			setModel: model => runExtensionSetModel(session, model),
			getThinkingLevel: () => session.thinkingLevel,
			setThinkingLevel: (level, persist) => session.setThinkingLevel(level, persist),
			getThinkingVisibility: () => session.getThinkingVisibility(),
			setThinkingVisibility: (visibility, persist) => session.setThinkingVisibility(visibility, persist),
			cycleThinkingLevel: () => session.cycleThinkingLevel(),
			setThinkingLevelForControl: (level, persist) => session.setThinkingLevelForControl(level, persist),
			setThinkingVisibilityForControl: (visibility, persist) =>
				session.setThinkingVisibilityForControl(visibility, persist),
			setModelTemporaryForControl: (model, expectedSessionId) =>
				session.setModelTemporaryForControl(model, expectedSessionId),
			fetchUsageReportsForControl: () => session.fetchUsageReportsForControl(),
			getThinkingScopeForControl: () => session.getThinkingScopeForControl(),
			getSessionName: () => session.sessionManager.getSessionName(),
			setSessionName: async name => {
				await session.sessionManager.setSessionName(name, "user");
			},
		},
		// ExtensionContextActions
		{
			getModel: () => session.model,
			isIdle: () => !session.isStreaming,
			abort: () => session.abort(),
			hasPendingMessages: () => session.queuedMessageCount > 0,
			getPendingMessageCounts: () => session.pendingMessageCounts,
			getTranscript: () => session.getTranscript(),
			getTranscriptBody: entryId => session.getTranscriptBody(entryId),
			getGoalState: () => session.getGoalModeState(),
			getTodoState: () => session.getTodoPhases(),
			getQueuedMessages: () => session.getQueuedMessageEntries(),
			getActiveTools: () => session.getActiveToolNames(),
			getAllTools: () => session.getAllToolNames(),
			resolveTool: name => {
				const tool = session.getToolByName(name);
				return tool ? { safeSummary: tool.safeSummary, safeSummaryFields: tool.safeSummaryFields } : undefined;
			},
			shutdown,
			getContextUsage: () => session.getContextUsage(),
			getSystemPrompt: () => session.systemPrompt,
			getWorkflowGate: () => session.getWorkflowGateEmitter(),
			compact: instructionsOrOptions => runExtensionCompact(session, instructionsOrOptions),
			clearContext: () => session.clearContext(),
			cycleModel: () => session.cycleModel(),
			cycleThinkingLevel: () => session.cycleThinkingLevel(),
			setQueueMode: (kind, mode) => {
				if (kind === "steering" && (mode === "all" || mode === "one-at-a-time")) {
					session.setSteeringMode(mode);
					return true;
				}
				if (kind === "follow_up" && (mode === "all" || mode === "one-at-a-time")) {
					session.setFollowUpMode(mode);
					return true;
				}
				if (kind === "interrupt" && (mode === "immediate" || mode === "wait")) {
					session.setInterruptMode(mode);
					return true;
				}
				return false;
			},
			invokeSkill: (name, args) => session.invokeSkill(name, args),
			setPlanMode: on => session.setSdkPlanMode(on),
			operateGoal: (op, objective) => session.operateGoal(op, objective),
			getSkillState: () => session.skills.map(skill => ({ name: skill.name, description: skill.description })),
			getConfigItems: () => session.getSdkConfigItems(),
			getBranchCandidates: () => session.sessionManager.getTree(),
			getExtensions: () => session.extensionRunner?.getExtensionPaths() ?? [],
			getArtifact: async id => {
				const artifactsDir = session.sessionManager.getArtifactsDir();
				if (!artifactsDir || !id) return undefined;
				const candidate = path.resolve(artifactsDir, id);
				const root = `${path.resolve(artifactsDir)}${path.sep}`;
				if (!candidate.startsWith(root))
					throw Object.assign(new Error("Artifact path escapes the session artifact directory."), {
						code: "invalid_input",
					});
				const file = Bun.file(candidate);
				return (await file.exists()) ? new Uint8Array(await file.arrayBuffer()) : undefined;
			},
			getArtifactRange: async (id, offset, length) => {
				const artifactsDir = session.sessionManager.getArtifactsDir();
				if (!artifactsDir || !id) return undefined;
				const candidate = path.resolve(artifactsDir, id);
				const root = `${path.resolve(artifactsDir)}${path.sep}`;
				if (!candidate.startsWith(root))
					throw Object.assign(new Error("Artifact path escapes the session artifact directory."), {
						code: "invalid_input",
					});
				const file = Bun.file(candidate);
				if (!(await file.exists())) return undefined;
				const start = Math.min(Math.max(0, offset), file.size);
				const end = Math.min(file.size, start + Math.max(0, length));
				return { bytes: new Uint8Array(await file.slice(start, end).arrayBuffer()), totalBytes: file.size };
			},
			getJobs: () => session.getAsyncJobSnapshot(),
			setSdkPermissionProvider: provider => session.setSdkPermissionProvider(provider),
			sdkControl: async (operation, input) => {
				switch (operation) {
					case "model.set": {
						const selector = typeof input.id === "string" ? input.id : "";
						const slashIndex = selector.indexOf("/");
						const model =
							slashIndex > 0
								? session.modelRegistry.find(selector.slice(0, slashIndex), selector.slice(slashIndex + 1))
								: undefined;
						const thinkingLevel =
							typeof input.thinkingLevel === "string" ? parseThinkingLevel(input.thinkingLevel) : undefined;
						if (!model || !thinkingLevel || thinkingLevel === ThinkingLevel.Inherit)
							throw Object.assign(new Error("model.set requires a valid model id and concrete thinkingLevel."), {
								code: "invalid_input",
							});
						return await session.setDefaultModelSelection(model, thinkingLevel);
					}
					case "todo.replace": {
						const phases = input.items;
						if (
							!Array.isArray(phases) ||
							!phases.every((phase: unknown) => {
								if (!phase || typeof phase !== "object") return false;
								const candidate = phase as { name?: unknown; tasks?: unknown };
								return (
									typeof candidate.name === "string" &&
									Array.isArray(candidate.tasks) &&
									candidate.tasks.every((task: unknown) => {
										if (!task || typeof task !== "object") return false;
										const item = task as { content?: unknown; status?: unknown };
										return (
											typeof item.content === "string" &&
											["pending", "in_progress", "completed", "abandoned"].includes(String(item.status))
										);
									})
								);
							})
						) {
							throw Object.assign(new Error("todo.replace requires TodoPhase items."), {
								code: "invalid_input",
							});
						}
						session.setTodoPhases(phases as TodoPhase[]);
						return { replaced: session.getTodoPhases() };
					}
					case "permission_mode.set": {
						const requested = input.mode;
						const mode =
							requested === "allow" || requested === "always-allow"
								? "allow"
								: requested === "deny" || requested === "always-deny"
									? "deny"
									: requested === "prompt"
										? "prompt"
										: undefined;
						if (!mode)
							throw Object.assign(new Error("permission_mode.set requires prompt, allow, or deny."), {
								code: "invalid_input",
							});
						session.setSdkPermissionMode(mode);
						return { changed: true, mode: session.sdkPermissionMode };
					}
					case "bash.execute": {
						if (typeof input.cmd !== "string" || input.cmd.trim() === "")
							throw Object.assign(new Error("bash.execute requires a command."), { code: "invalid_input" });
						const result = await session.executeBash(input.cmd, undefined, { excludeFromContext: true });
						return {
							exitCode: result.exitCode,
							cancelled: result.cancelled,
							output: result.output,
							truncated: result.truncated,
						};
					}
					case "bash.abort": {
						if (!session.isBashRunning) return { aborted: false };
						session.abortBash();
						return { aborted: true };
					}
					case "retry.last": {
						if (!(await session.retry()))
							throw Object.assign(new Error("There is no failed or interrupted turn to retry."), {
								code: "nothing_to_retry",
							});
						return { retried: true };
					}
					case "retry.now": {
						if (!session.isRetrying)
							throw Object.assign(new Error("No retry backoff is pending."), { code: "retry_not_pending" });
						session.retryNow();
						return { retried: true, immediate: true };
					}
					case "bash.background": {
						if (!session.requestForegroundBashBackground())
							throw Object.assign(
								new Error("The active bash command cannot be moved to a managed background job."),
								{ code: "not_foldable" },
							);
						return { backgrounded: true };
					}
					case "compaction.auto.set":
						session.setAutoCompactionEnabled(input.on === true);
						return { changed: true };
					case "retry.auto.set":
						session.setAutoRetryEnabled(input.on === true);
						return { changed: true };
					case "retry.abort":
						session.abortRetry();
						return { aborted: true };
					case "session.new":
						return { created: await session.newSession() };
					case "session.fork":
						return { session: await session.fork() };
					case "session.resume":
						return { resumed: await session.switchSession(String(input.id)) };
					case "session.close":
						await session.sessionManager.flush();
						return { closed: true };
					case "session.switch":
						return { switched: await session.switchSession(String(input.id)) };
					case "session.branch":
						try {
							return await session.branch(String(input.entryId));
						} catch (error) {
							throw Object.assign(
								new Error(error instanceof Error ? error.message : "Branch entry was not found."),
								{ code: "resource_gone" },
							);
						}
					case "session.rename":
						return { renamed: await session.setSessionName(String(input.name), "user") };
					case "session.handoff":
						try {
							return {
								handoff: await session.handoff(
									typeof input.instructions === "string" ? input.instructions : undefined,
								),
							};
						} catch (error) {
							throw Object.assign(
								new Error(
									error instanceof Error ? error.message : "Handoff is unavailable for the current state.",
								),
								{ code: "invalid_request" },
							);
						}
					case "session.export_html":
						try {
							return {
								path: await session.exportToHtml(typeof input.path === "string" ? input.path : undefined),
							};
						} catch (error) {
							throw Object.assign(
								new Error(
									error instanceof Error
										? error.message
										: "Session export is unavailable for the current state.",
								),
								{ code: "invalid_request" },
							);
						}
					case "runtime.reload":
						await session.reload();
						return { reloaded: true };
					case "service_tier.set":
						session.setServiceTier(input.tier as never);
						return { changed: true };
					case "queue.message.remove": {
						const removed = session.removeQueuedMessageForEditing(String(input.id));
						if (removed === undefined)
							throw Object.assign(new Error("Queued message was not found."), { code: "resource_gone" });
						return { removed };
					}
					case "queue.message.move": {
						const id = String(input.id);
						const moved =
							input.before !== undefined
								? session.moveQueuedMessageForEditing(id, "up")
								: session.moveQueuedMessageForEditing(id, "down");
						if (!moved)
							throw Object.assign(new Error("Queue position is invalid."), { code: "invalid_position" });
						return { moved };
					}
					case "queue.message.update": {
						const id = String(input.id);
						const old = session.removeQueuedMessageForEditing(id);
						const patch = input.patch as { text?: unknown };
						if (old === undefined || typeof patch?.text !== "string")
							throw Object.assign(new Error("Queued message update is invalid."), { code: "invalid_message" });
						await session.sendUserMessage(patch.text, {
							deliverAs: id.startsWith("steer:") ? "steer" : "followUp",
						});
						return { updated: true };
					}
					case "extension.set_enabled": {
						const id = String(input.id);
						const disabled = [...(session.settings.get("disabledExtensions") ?? [])];
						const on = input.on === true;
						const next = on ? disabled.filter(value => value !== id) : [...new Set([...disabled, id])];
						session.settings.set("disabledExtensions", next);
						return { changed: true, enabled: on };
					}
					case "session.delete":
						await session.sessionManager.dropSession(String(input.id));
						return { deleted: true };
					case "session.cwd.move":
						await session.sessionManager.moveTo(String(input.path));
						return { moved: true, cwd: session.sessionManager.getCwd() };
					default:
						throw Object.assign(new Error(`${operation} has no AgentSession implementation.`), {
							code: "unavailable",
						});
				}
			},
		},
		// ExtensionCommandContextActions — commands invokable via prompt("/command")
		{
			getContextUsage: () => session.getContextUsage(),
			waitForIdle: () => session.agent.waitForIdle(),
			newSession: async newOptions => {
				const success = await session.newSession({ parentSession: newOptions?.parentSession });
				if (success && newOptions?.setup) {
					await newOptions.setup(session.sessionManager);
				}
				return { cancelled: !success };
			},
			branch: async entryId => {
				const result = await session.branch(entryId);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, navOptions) => {
				const result = await session.navigateTree(targetId, { summarize: navOptions?.summarize });
				return { cancelled: result.cancelled };
			},
			switchSession: async sessionPath => {
				const success = await session.switchSession(sessionPath);
				return { cancelled: !success };
			},
			reload: async () => {
				await session.reload();
			},
			compact: instructionsOrOptions => runExtensionCompact(session, instructionsOrOptions),
		},
		uiContext,
	);

	runner.onError(reportRuntimeError);
	await runner.emit({ type: "session_start" });
}
