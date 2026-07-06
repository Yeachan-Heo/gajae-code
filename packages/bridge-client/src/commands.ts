export const BRIDGE_CLIENT_COMMAND_TYPES = [
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"abort_and_prompt",
	"new_session",
	"get_state",
	"set_todos",
	"set_host_tools",
	"set_host_uri_schemes",
	"get_pending_workflow_gates",
	"set_capabilities",
	"workflow_gate_response",
	"set_model",
	"cycle_model",
	"get_available_models",
	"set_thinking_level",
	"cycle_thinking_level",
	"set_steering_mode",
	"set_follow_up_mode",
	"set_interrupt_mode",
	"compact",
	"set_auto_compaction",
	"set_auto_retry",
	"abort_retry",
	"bash",
	"abort_bash",
	"get_session_stats",
	"export_html",
	"switch_session",
	"branch",
	"get_branch_messages",
	"get_last_assistant_text",
	"set_session_name",
	"handoff",
	"get_messages",
	"get_login_providers",
	"login",
	"negotiate_unattended",
] as const;

export type BridgeClientCommandType = (typeof BRIDGE_CLIENT_COMMAND_TYPES)[number];

export type BridgeClientCommand<TType extends BridgeClientCommandType = BridgeClientCommandType> = {
	id?: string;
	type: TType;
} & Record<string, unknown>;

export interface BridgeCommandOptions {
	id?: string;
	idempotencyKey?: string;
}

export interface BridgeImageCommandOptions extends BridgeCommandOptions {
	images?: unknown[];
}

export interface BridgeCommandHelpers {
	prompt(
		sessionId: string,
		message: string,
		options?: BridgeImageCommandOptions & { streamingBehavior?: "steer" | "followUp" },
	): Promise<unknown>;
	steer(sessionId: string, message: string, options?: BridgeImageCommandOptions): Promise<unknown>;
	followUp(sessionId: string, message: string, options?: BridgeImageCommandOptions): Promise<unknown>;
	abort(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	abortAndPrompt(sessionId: string, message: string, options?: BridgeImageCommandOptions): Promise<unknown>;
	newSession(sessionId: string, options?: BridgeCommandOptions & { parentSession?: string }): Promise<unknown>;
	getState(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	setTodos(sessionId: string, phases: unknown[], options?: BridgeCommandOptions): Promise<unknown>;
	setHostTools(sessionId: string, tools: unknown[], options?: BridgeCommandOptions): Promise<unknown>;
	setHostUriSchemes(sessionId: string, schemes: unknown[], options?: BridgeCommandOptions): Promise<unknown>;
	getPendingWorkflowGates(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	setModel(sessionId: string, provider: string, modelId: string, options?: BridgeCommandOptions): Promise<unknown>;
	cycleModel(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	getAvailableModels(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	setThinkingLevel(sessionId: string, level: string, options?: BridgeCommandOptions): Promise<unknown>;
	cycleThinkingLevel(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	setSteeringMode(sessionId: string, mode: "all" | "one-at-a-time", options?: BridgeCommandOptions): Promise<unknown>;
	setFollowUpMode(sessionId: string, mode: "all" | "one-at-a-time", options?: BridgeCommandOptions): Promise<unknown>;
	setInterruptMode(sessionId: string, mode: "immediate" | "wait", options?: BridgeCommandOptions): Promise<unknown>;
	compact(sessionId: string, options?: BridgeCommandOptions & { customInstructions?: string }): Promise<unknown>;
	setAutoCompaction(sessionId: string, enabled: boolean, options?: BridgeCommandOptions): Promise<unknown>;
	setAutoRetry(sessionId: string, enabled: boolean, options?: BridgeCommandOptions): Promise<unknown>;
	abortRetry(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	bash(sessionId: string, command: string, options?: BridgeCommandOptions): Promise<unknown>;
	abortBash(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	getSessionStats(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	exportHtml(sessionId: string, options?: BridgeCommandOptions & { outputPath?: string }): Promise<unknown>;
	switchSession(sessionId: string, sessionPath: string, options?: BridgeCommandOptions): Promise<unknown>;
	branch(sessionId: string, entryId: string, options?: BridgeCommandOptions): Promise<unknown>;
	getBranchMessages(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	getLastAssistantText(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	setSessionName(sessionId: string, name: string, options?: BridgeCommandOptions): Promise<unknown>;
	handoff(sessionId: string, options?: BridgeCommandOptions & { customInstructions?: string }): Promise<unknown>;
	getMessages(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	getLoginProviders(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	login(sessionId: string, providerId: string, options?: BridgeCommandOptions): Promise<unknown>;
	respondGate(
		sessionId: string,
		gateId: string,
		ownerToken: string,
		answer: unknown,
		options?: BridgeCommandOptions,
	): Promise<unknown>;
}
