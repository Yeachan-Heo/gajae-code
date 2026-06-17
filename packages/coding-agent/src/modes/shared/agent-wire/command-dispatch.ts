import type { AgentTool } from "@gajae-code/agent-core";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { getOAuthProviders } from "@gajae-code/ai/utils/oauth";
import { Snowflake } from "@gajae-code/utils";
import type { ExtensionUIContext } from "../../../extensibility/extensions";
import type { AgentSession } from "../../../session/agent-session";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcHostToolDefinition,
	RpcHostUriSchemeDefinition,
	RpcResponse,
	RpcSessionState,
	RpcUnattendedAccepted,
	RpcUnattendedDeclaration,
	RpcWorkflowGateResolution,
	RpcWorkflowGateResponse,
} from "../../rpc/rpc-types";
import { rpcError, rpcSuccess } from "./responses";
import {
	ActionDeniedError,
	ScopeDeniedError,
	UnattendedBudgetExceededError,
	UnattendedNegotiationError,
} from "./unattended-run-controller";
import { WorkflowGateBrokerError } from "./workflow-gate-broker";

export type RpcCommandDispatchOutput = (obj: RpcResponse | RpcExtensionUIRequest | object) => void;

export interface RpcHostToolRegistry {
	setTools(tools: RpcHostToolDefinition[]): AgentTool[];
}

export interface RpcHostUriRegistry {
	setSchemes(schemes: RpcHostUriSchemeDefinition[]): string[];
}

/**
 * Optional unattended control plane wired into RPC dispatch (#318/#319/#323).
 * When present, `negotiate_unattended` and `workflow_gate_response` route here
 * instead of falling through to the unknown-command path.
 */
export interface RpcUnattendedControlPlane {
	/** Enter unattended mode (fail-closed); throws an Error on refusal. */
	negotiate(declaration: RpcUnattendedDeclaration): RpcUnattendedAccepted;
	/** Resolve a pending workflow gate with the agent's answer. */
	resolveGate(response: RpcWorkflowGateResponse): Promise<RpcWorkflowGateResolution>;
	/** List unresolved durable workflow gates for reconnect replay. */
	listPendingGates?(): import("../../rpc/rpc-types").RpcWorkflowGate[];
	isUnattended?(): boolean;
	preflightCommand?(command: RpcCommand): void;
	reconcileUsage?(phase?: string): void;
}

export interface RpcCommandDispatchContext {
	session: AgentSession;
	output: RpcCommandDispatchOutput;
	hostToolRegistry: RpcHostToolRegistry;
	hostUriRegistry: RpcHostUriRegistry;
	createUiContext: () => Pick<ExtensionUIContext, "notify">;
	unattendedControlPlane?: RpcUnattendedControlPlane;
}

export function normalizeHostToolDefinitions(tools: RpcHostToolDefinition[]): RpcHostToolDefinition[] {
	return tools.map((tool, index) => {
		const name = typeof tool.name === "string" ? tool.name.trim() : "";
		if (!name) {
			throw new Error(`Host tool at index ${index} must provide a non-empty name`);
		}
		const description = typeof tool.description === "string" ? tool.description.trim() : "";
		if (!description) {
			throw new Error(`Host tool "${name}" must provide a non-empty description`);
		}
		if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
			throw new Error(`Host tool "${name}" must provide a JSON Schema object`);
		}
		const label = typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : name;
		return {
			name,
			label,
			description,
			parameters: tool.parameters,
			hidden: tool.hidden === true,
		};
	});
}

function serializeRpcDispatchError(err: unknown): string | object {
	if (
		err instanceof ScopeDeniedError ||
		err instanceof ActionDeniedError ||
		err instanceof UnattendedBudgetExceededError
	) {
		return err.payload;
	}
	if (err instanceof UnattendedNegotiationError) {
		return { code: err.code, message: err.message };
	}
	if (err instanceof WorkflowGateBrokerError) {
		return { code: err.code, message: err.message };
	}
	return err instanceof Error ? err.message : String(err);
}

export async function dispatchRpcCommand(
	command: RpcCommand,
	context: RpcCommandDispatchContext,
): Promise<RpcResponse> {
	const { session, output, hostToolRegistry, hostUriRegistry, createUiContext, unattendedControlPlane } = context;
	const id = command.id;
	const typedError = (cmd: string, err: unknown): RpcResponse => rpcError(id, cmd, serializeRpcDispatchError(err));
	const preflight = (): RpcResponse | undefined => {
		if (!unattendedControlPlane?.isUnattended?.() || command.type === "negotiate_unattended") return undefined;
		try {
			unattendedControlPlane.preflightCommand?.(command);
			return undefined;
		} catch (err) {
			return typedError(command.type, err);
		}
	};
	const reconcile = (phase = `${command.type} post-dispatch`): RpcResponse | undefined => {
		if (!unattendedControlPlane?.isUnattended?.()) return undefined;
		try {
			unattendedControlPlane.reconcileUsage?.(phase);
			return undefined;
		} catch (err) {
			return typedError(command.type, err);
		}
	};
	const denied = preflight();
	if (denied) return denied;

	try {
		switch (command.type) {
			case "prompt": {
				session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
					})
					.catch(e => output(rpcError(id, "prompt", serializeRpcDispatchError(e))));
				return reconcile() ?? rpcSuccess(id, "prompt");
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return rpcSuccess(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return rpcSuccess(id, "follow_up");
			}

			case "abort": {
				await session.abort();
				return rpcSuccess(id, "abort");
			}

			case "abort_and_prompt": {
				await session.abort();
				session
					.prompt(command.message, { images: command.images })
					.catch(e => output(rpcError(id, "abort_and_prompt", e.message)));
				return rpcSuccess(id, "abort_and_prompt");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const cancelled = !(await session.newSession(options));
				return rpcSuccess(id, "new_session", { cancelled });
			}

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					interruptMode: session.interruptMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					queuedMessageCount: session.queuedMessageCount,
					todoPhases: session.getTodoPhases(),
					contextUsage: session.getContextUsage(),
				};
				const include = new Set(command.include ?? []);
				if (include.has("systemPrompt")) {
					state.systemPrompt = session.systemPrompt;
				}
				if (include.has("tools") || include.has("dumpTools")) {
					state.dumpTools = session.agent.state.tools.map(tool => ({
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
					}));
				}
				return rpcSuccess(id, "get_state", state);
			}

			case "set_todos": {
				session.setTodoPhases(command.phases);
				return rpcSuccess(id, "set_todos", { todoPhases: session.getTodoPhases() });
			}

			case "set_host_tools": {
				const tools = normalizeHostToolDefinitions(command.tools);
				const rpcTools = hostToolRegistry.setTools(tools);
				await session.refreshRpcHostTools(rpcTools);
				return rpcSuccess(id, "set_host_tools", { toolNames: tools.map(tool => tool.name) });
			}

			case "get_pending_workflow_gates": {
				const gates = unattendedControlPlane?.listPendingGates?.() ?? [];
				return rpcSuccess(id, "get_pending_workflow_gates", { gates });
			}

			case "set_host_uri_schemes": {
				try {
					const schemes = hostUriRegistry.setSchemes(command.schemes);
					return rpcSuccess(id, "set_host_uri_schemes", { schemes });
				} catch (err) {
					return rpcError(id, "set_host_uri_schemes", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_model": {
				const models = session.getAvailableModels();
				const model = models.find(m => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return rpcError(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return rpcSuccess(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return rpcSuccess(id, "cycle_model", null);
				}
				return rpcSuccess(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = session.getAvailableModels();
				return rpcSuccess(id, "get_available_models", { models });
			}

			case "set_thinking_level": {
				if (!(Object.values(ThinkingLevel) as string[]).includes(command.level as string)) {
					return rpcError(id, "set_thinking_level", `Invalid thinking level: ${String(command.level)}`);
				}
				session.setThinkingLevel(command.level);
				return rpcSuccess(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return rpcSuccess(id, "cycle_thinking_level", null);
				}
				return rpcSuccess(id, "cycle_thinking_level", { level });
			}

			case "set_steering_mode": {
				if ((command.mode as string) !== "all" && (command.mode as string) !== "one-at-a-time") {
					return rpcError(id, "set_steering_mode", `Invalid steering mode: ${String(command.mode)}`);
				}
				session.setSteeringMode(command.mode);
				return rpcSuccess(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				if ((command.mode as string) !== "all" && (command.mode as string) !== "one-at-a-time") {
					return rpcError(id, "set_follow_up_mode", `Invalid follow-up mode: ${String(command.mode)}`);
				}
				session.setFollowUpMode(command.mode);
				return rpcSuccess(id, "set_follow_up_mode");
			}

			case "set_interrupt_mode": {
				if ((command.mode as string) !== "immediate" && (command.mode as string) !== "wait") {
					return rpcError(id, "set_interrupt_mode", `Invalid interrupt mode: ${String(command.mode)}`);
				}
				session.setInterruptMode(command.mode);
				return rpcSuccess(id, "set_interrupt_mode");
			}

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return rpcSuccess(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return rpcSuccess(id, "set_auto_compaction");
			}

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return rpcSuccess(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return rpcSuccess(id, "abort_retry");
			}

			case "bash": {
				const result = await session.executeBash(command.command);
				return reconcile() ?? rpcSuccess(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return rpcSuccess(id, "abort_bash");
			}

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return rpcSuccess(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return rpcSuccess(id, "export_html", { path });
			}

			case "switch_session": {
				const cancelled = !(await session.switchSession(command.sessionPath));
				return rpcSuccess(id, "switch_session", { cancelled });
			}

			case "branch": {
				const result = await session.branch(command.entryId);
				return rpcSuccess(id, "branch", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "get_branch_messages": {
				const messages = session.getUserMessagesForBranching();
				return rpcSuccess(id, "get_branch_messages", { messages });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return rpcSuccess(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return rpcError(id, "set_session_name", "Session name cannot be empty");
				}
				const applied = await session.setSessionName(name, "user");
				if (!applied) {
					return rpcError(id, "set_session_name", "Session name cannot be empty");
				}
				return rpcSuccess(id, "set_session_name");
			}

			case "handoff": {
				const result = await session.handoff(command.customInstructions);
				return rpcSuccess(id, "handoff", result ? { savedPath: result.savedPath } : null);
			}

			case "get_messages": {
				// Fast-lane read: snapshot the live array so a concurrent ordered
				// turn/compaction mutating session.messages in place cannot make this
				// response serialize a half-rewritten array (#606, issue 13).
				return rpcSuccess(id, "get_messages", { messages: [...session.messages] });
			}

			case "get_login_providers": {
				const providers = getOAuthProviders().map(provider => ({
					id: provider.id,
					name: provider.name,
					available: provider.available,
					authenticated: session.modelRegistry.authStorage.hasAuth(provider.id),
				}));
				return rpcSuccess(id, "get_login_providers", { providers });
			}

			case "login": {
				const knownProvider = getOAuthProviders().find(p => p.id === command.providerId);
				if (!knownProvider) {
					return rpcError(id, "login", `Unknown OAuth provider: ${command.providerId}`);
				}
				const uiCtx = createUiContext();
				let authEmitted = false;
				try {
					await session.modelRegistry.authStorage.login(command.providerId, {
						onAuth: info => {
							authEmitted = true;
							output({
								type: "extension_ui_request",
								id: Snowflake.next() as string,
								method: "open_url",
								url: info.url,
								instructions: info.instructions,
							} as RpcExtensionUIRequest);
						},
						onProgress: message => {
							uiCtx.notify(message, "info");
						},
						onPrompt: () => {
							if (!authEmitted) {
								return Promise.reject(
									new Error(
										`Provider '${command.providerId}' requires interactive prompts ` +
											"which are not supported in RPC mode. Use the terminal UI to log in.",
									),
								);
							}
							return new Promise<string>(() => {});
						},
					});
					await session.modelRegistry.refresh();
					return rpcSuccess(id, "login", { providerId: command.providerId });
				} catch (err: unknown) {
					return rpcError(id, "login", err instanceof Error ? err.message : String(err));
				}
			}

			case "negotiate_unattended": {
				if (!unattendedControlPlane) {
					return rpcError(id, "negotiate_unattended", "unattended mode is not available on this session");
				}
				try {
					const accepted = unattendedControlPlane.negotiate(command.declaration);
					return rpcSuccess(id, "negotiate_unattended", accepted);
				} catch (err) {
					return typedError("negotiate_unattended", err);
				}
			}

			case "workflow_gate_response": {
				if (!unattendedControlPlane) {
					return rpcError(id, "workflow_gate_response", "workflow gates are not available on this session");
				}
				try {
					const resolution = await unattendedControlPlane.resolveGate({
						gate_id: command.gate_id,
						answer: command.answer,
						idempotency_key: command.idempotency_key,
					});
					return rpcSuccess(id, "workflow_gate_response", resolution);
				} catch (err) {
					return typedError("workflow_gate_response", err);
				}
			}

			default: {
				const unknownCommand = command as { type: string };
				return rpcError(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	} catch (err) {
		return rpcError(id, command.type, serializeRpcDispatchError(err));
	}
}
