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
import {
	parseSyntheticModelId,
	resolveSyntheticModelSelection,
	SYNTHETIC_PROVIDER_ID,
	syntheticNamespaceCollision,
} from "../sdk/model-profile-model";
import type { AgentSession } from "../session/agent-session";
import { bashBackgroundControlError } from "../session/fold-coordinator";
import { parseThinkingLevel } from "../thinking";
import type { TodoPhase } from "../tools/todo-write";

const BROKER_LIFECYCLE_OPERATIONS = new Set([
	"session.new",
	"session.fork",
	"session.resume",
	"session.close",
	"session.switch",
	"session.branch",
	"session.handoff",
	"session.delete",
]);

function prohibitBrokerLifecycleOperation(operation: string): never {
	throw Object.assign(new Error(`${operation} is available only through the Broker lifecycle service.`), {
		code: "operation_prohibited",
	});
}

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
			// Extension sends are INDEPENDENT producers, never continuations of the
			// current turn: the trusted adapter classifies them so a terminal abort
			// preserves them instead of dropping them as turn-owned work. Extensions
			// never supply this bit themselves.
			sendMessage: (message, sendOptions) => {
				session.sendCustomMessage(message, { ...sendOptions, origin: "external" }).catch(e => {
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
			setModelTemporaryForControl: (model, expectedSessionId, thinkingLevel) =>
				session.setModelTemporaryForControl(model, expectedSessionId, thinkingLevel),
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
			getCredentialSessionId: () => session.credentialSessionId,
			isIdle: () => !session.isStreaming,
			getActivePromptHandle: () => session.activePromptHandle,
			abort: () => session.abort(),
			abortPromptAndWait: (handle, abortOptions) => session.abortPromptAndWait(handle, abortOptions),
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
			setModelProfile: name => session.activateModelProfileForControl(name),
			setDefaultModelProfile: (name, options) => session.setDefaultModelProfileForControl(name, options),
			getActiveModelProfile: () => session.getActiveModelProfile(),
			withSdkControlMutation: body => session.withSdkControlMutation(body),
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
				if (kind === "tool_interrupt" && (mode === "abort_tools" || mode === "finish_tools")) {
					session.setToolInterruptPolicy(mode);
					return true;
				}
				return false;
			},
			invokeSkill: (name, args, options) => session.invokeSkill(name, args, options),
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
			onJobFold: listener => session.onJobFold(listener),
			onSessionEvent: listener => session.subscribe(listener),
			setSdkPermissionProvider: provider => session.setSdkPermissionProvider(provider),
			setSdkClientBridge: bridge => session.setClientBridge(bridge),
			sdkControl: async (operation, input) => {
				switch (operation) {
					case "model.set": {
						const selector = typeof input.id === "string" ? input.id : "";
						const rawThinkingLevel = typeof input.thinkingLevel === "string" ? input.thinkingLevel : undefined;
						const hasThinkingLevel = rawThinkingLevel !== undefined;
						const thinkingLevel =
							rawThinkingLevel === undefined ? undefined : parseThinkingLevel(rawThinkingLevel);
						if (parseSyntheticModelId(selector) !== undefined) {
							if (
								syntheticNamespaceCollision(
									session.modelRegistry.getAll?.() ?? [],
									session.modelRegistry.getConfiguredProviderIds?.() ?? [],
								)
							)
								throw Object.assign(
									new Error(
										`The ${SYNTHETIC_PROVIDER_ID} namespace is reserved; synthetic preset selection is disabled while a provider of the same name is configured.`,
									),
									{ code: "invalid_input" },
								);
							// An absent thinking level is allowed (matches the generic
							// model.set and the SDK contract); a supplied-but-unparseable or
							// non-"off" value is rejected, and the override is passed only
							// when the caller supplied it.
							if (
								hasThinkingLevel &&
								(thinkingLevel === undefined ||
									thinkingLevel === ThinkingLevel.Inherit ||
									thinkingLevel !== ThinkingLevel.Off)
							)
								throw Object.assign(
									new Error('model.set thinkingLevel for a synthetic profile must be "off".'),
									{ code: "invalid_input" },
								);
							const resolved = resolveSyntheticModelSelection(
								selector,
								session.modelRegistry.getModelProfiles(),
								session.modelRegistry.getError?.(),
							);
							await session.setDefaultModelProfileForControl(resolved.canonicalName, {
								persistDefault: false,
								...(hasThinkingLevel ? { thinkingLevelOverride: ThinkingLevel.Off } : {}),
							});
							return {
								provider: SYNTHETIC_PROVIDER_ID,
								modelId: resolved.canonicalName,
								thinkingLevel: session.thinkingLevel,
							};
						}
						const slashIndex = selector.indexOf("/");
						const model =
							slashIndex > 0
								? session.modelRegistry.find(selector.slice(0, slashIndex), selector.slice(slashIndex + 1))
								: undefined;
						if (!model || !thinkingLevel || thinkingLevel === ThinkingLevel.Inherit)
							throw Object.assign(new Error("model.set requires a valid model id and concrete thinkingLevel."), {
								code: "invalid_input",
							});
						// Internal host hooks (never public SDK fields): the bus surface runs
						// its Q13 config-shadow capture/reconcile inside this selection
						// admission so a concurrent config.patch cannot race the snapshot.
						return await session.setDefaultModelSelection(model, thinkingLevel, {
							...(typeof input.onBeforeMutation === "function"
								? { onBeforeMutation: input.onBeforeMutation as () => void }
								: {}),
							...(typeof input.onAfterMutation === "function"
								? { onAfterMutation: input.onAfterMutation as () => void }
								: {}),
						});
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
							signal: result.signal,
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
						const outcome = await session.requestForegroundBashBackgroundOutcome("sdk_control");
						if (outcome.status !== "folded") throw bashBackgroundControlError(outcome);
						return { backgrounded: true, jobId: outcome.jobId };
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
					case "session.rename":
						return { renamed: await session.setSessionName(String(input.name), "user") };
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
						if (!session.settings.canWriteDurableConfig()) {
							throw Object.assign(
								new Error(
									"Cannot change settings while config.yml has invalid YAML syntax. Repair config.yml and reload settings.",
								),
								{ code: "invalid_request" },
							);
						}
						try {
							session.settings.set("disabledExtensions", next);
						} catch (error) {
							if (!session.settings.canWriteDurableConfig()) {
								throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
									code: "invalid_request",
								});
							}
							throw error;
						}
						return { changed: true, enabled: on };
					}
					case "session.cwd.move":
						await session.sessionManager.moveTo(String(input.path));
						return { moved: true, cwd: session.sessionManager.getCwd() };
					default:
						if (BROKER_LIFECYCLE_OPERATIONS.has(operation)) prohibitBrokerLifecycleOperation(operation);
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
			newSession: async () => prohibitBrokerLifecycleOperation("session.new"),
			branch: async () => prohibitBrokerLifecycleOperation("session.branch"),
			navigateTree: async (targetId, navOptions) => {
				const result = await session.navigateTree(targetId, { summarize: navOptions?.summarize });
				return { cancelled: result.cancelled };
			},
			switchSession: async () => prohibitBrokerLifecycleOperation("session.switch"),
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
