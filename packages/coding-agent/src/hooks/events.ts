/** Stable canonical names used to compare hook surfaces without replacing runtime event types. */
export const HookEventKind = {
	UserPromptSubmit: "user_prompt_submit",
	PreToolUse: "pre_tool_use",
	PostToolUse: "post_tool_use",
	Stop: "stop",
	SessionStart: "session_start",
	SessionShutdown: "session_shutdown",
} as const;

export type HookEventKind = (typeof HookEventKind)[keyof typeof HookEventKind];

export const HookAuthority = {
	Constrained: "constrained",
	Command: "command",
	InProcess: "in-process",
} as const;

export type HookAuthority = (typeof HookAuthority)[keyof typeof HookAuthority];

export const HookSourceConvention = {
	NativeGjc: "native-gjc",
	ClaudeCode: "claude-code",
	Codex: "codex",
	CodexManagedJson: "codex-managed-json",
	GjcPlugin: "gjc-plugin",
	InProcess: "in-process",
} as const;

export type HookSourceConvention = (typeof HookSourceConvention)[keyof typeof HookSourceConvention];

export interface HookEventSchemaContract {
	kind: HookEventKind;
	input: string;
	output: string;
}

/**
 * Canonical schema references. These point at existing runtime types; they are not a
 * second runtime event union and do not change payloads dispatched by the hook runners.
 */
export const HOOK_EVENT_SCHEMAS: Record<HookEventKind, HookEventSchemaContract> = {
	[HookEventKind.UserPromptSubmit]: {
		kind: HookEventKind.UserPromptSubmit,
		input: "BeforeAgentStartEvent { type, prompt, images?, systemPrompt } or provider-owned named-event payload",
		output: "BeforeAgentStartEventResult { message?, systemPrompt? } or provider-owned command output",
	},
	[HookEventKind.PreToolUse]: {
		kind: HookEventKind.PreToolUse,
		input: "ToolCallEvent { type, toolName, toolCallId, input }",
		output: "ToolCallEventResult { block?, reason? }",
	},
	[HookEventKind.PostToolUse]: {
		kind: HookEventKind.PostToolUse,
		input: "ToolResultEvent { type, toolName, toolCallId, input, content, details, isError }",
		output: "ToolResultEventResult { content?, details?, isError? }",
	},
	[HookEventKind.Stop]: {
		kind: HookEventKind.Stop,
		input: "AgentEndEvent for GJC in-process hooks, or provider-owned Stop payload",
		output: "void for GJC in-process hooks, or provider-owned command output",
	},
	[HookEventKind.SessionStart]: {
		kind: HookEventKind.SessionStart,
		input: "SessionStartEvent { type: session_start }",
		output: "void",
	},
	[HookEventKind.SessionShutdown]: {
		kind: HookEventKind.SessionShutdown,
		input: "SessionShutdownEvent { type: session_shutdown }",
		output: "void",
	},
};

export type HookOrdering = "sequential" | "external-runtime";
export type HookAwaitBehavior = "awaited" | "external-runtime";
export type HookErrorBehavior = "isolate" | "fail-closed" | "external-runtime";
export type HookProcessAuthority = "none" | "hook-api" | "command" | "ambient-host";
export type HookTrustRequirement = "not-enforced" | "provider-owned";
export type HookRedaction = "none" | "provider-owned";

export interface HookExecutionContract {
	kind: HookEventKind;
	runtimeEvent: string;
	authority: HookAuthority;
	awaitBehavior: HookAwaitBehavior;
	ordering: HookOrdering;
	canCancel: boolean;
	mutation: readonly string[];
	timeoutMs: number | null;
	errorBehavior: HookErrorBehavior;
	processAuthority: HookProcessAuthority;
	trustRequirement: HookTrustRequirement;
	redaction: HookRedaction;
	logging: string;
	semanticNotes: string;
}

const hookModulePre: HookExecutionContract = {
	kind: HookEventKind.PreToolUse,
	runtimeEvent: "tool_call",
	authority: HookAuthority.InProcess,
	awaitBehavior: "awaited",
	ordering: "sequential",
	canCancel: true,
	mutation: [],
	timeoutMs: null,
	errorBehavior: "fail-closed",
	processAuthority: "hook-api",
	trustRequirement: "not-enforced",
	redaction: "none",
	logging: "Extension errors expose the extension path, event name, error message, and stack to registered listeners.",
	semanticNotes:
		"The first blocking result stops later handlers. Directory hooks are imported modules, not shell scripts.",
};

const hookModulePost: HookExecutionContract = {
	kind: HookEventKind.PostToolUse,
	runtimeEvent: "tool_result",
	authority: HookAuthority.InProcess,
	awaitBehavior: "awaited",
	ordering: "sequential",
	canCancel: false,
	mutation: ["content", "details", "isError"],
	timeoutMs: 30_000,
	errorBehavior: "isolate",
	processAuthority: "hook-api",
	trustRequirement: "not-enforced",
	redaction: "none",
	logging: "Extension errors expose the extension path, event name, error message, and stack to registered listeners.",
	semanticNotes:
		"Handlers receive the prior handler's replacements; content, details, and isError changes are chained in registration order.",
};

const constrainedPre: HookExecutionContract = {
	...hookModulePre,
	authority: HookAuthority.Constrained,
	processAuthority: "ambient-host",
	semanticNotes:
		"The plugin API denies exec, messaging, commands, renderers, and session mutation, but the imported module is not a process sandbox and retains ambient Bun/host globals. A thrown pre-hook error blocks the tool.",
};

const constrainedPost: HookExecutionContract = {
	...hookModulePost,
	authority: HookAuthority.Constrained,
	timeoutMs: 30_000,
	processAuthority: "ambient-host",
	mutation: ["content", "details", "isError"],
	semanticNotes: "The constrained hook is adapted into ExtensionRunner; timeout and thrown errors are isolated.",
};

const constrainedLifecycle = (kind: HookEventKind, runtimeEvent: string): HookExecutionContract => ({
	kind,
	runtimeEvent,
	authority: HookAuthority.Constrained,
	awaitBehavior: "awaited",
	ordering: "sequential",
	canCancel: false,
	mutation: [],
	timeoutMs: 30_000,
	errorBehavior: "isolate",
	processAuthority: "ambient-host",
	trustRequirement: "not-enforced",
	redaction: "none",
	logging: "Extension errors expose the extension path, event name, error message, and stack to registered listeners.",
	semanticNotes:
		"The constrained GJC API remains denied, but the imported plugin module retains ambient host-process authority.",
});

const managedPrompt: HookExecutionContract = {
	kind: HookEventKind.UserPromptSubmit,
	runtimeEvent: "UserPromptSubmit",
	authority: HookAuthority.Command,
	awaitBehavior: "external-runtime",
	ordering: "external-runtime",
	canCancel: false,
	mutation: [],
	timeoutMs: null,
	errorBehavior: "external-runtime",
	processAuthority: "command",
	trustRequirement: "provider-owned",
	redaction: "provider-owned",
	logging: "Codex owns command invocation logging; GJC only installs and handles its managed command payload.",
	semanticNotes: "Normalization describes hooks.json configuration; GJC does not schedule this command itself.",
};

const managedStop: HookExecutionContract = {
	...managedPrompt,
	kind: HookEventKind.Stop,
	runtimeEvent: "Stop",
};

const inProcessPrompt: HookExecutionContract = {
	kind: HookEventKind.UserPromptSubmit,
	runtimeEvent: "before_agent_start",
	authority: HookAuthority.InProcess,
	awaitBehavior: "awaited",
	ordering: "sequential",
	canCancel: false,
	mutation: ["message", "systemPrompt"],
	timeoutMs: 30_000,
	errorBehavior: "isolate",
	processAuthority: "hook-api",
	trustRequirement: "not-enforced",
	redaction: "none",
	logging: "Extension errors expose the extension path, event name, error message, and stack to registered listeners.",
	semanticNotes: "This is a before-agent-start callback, not a byte-for-byte Claude/Codex UserPromptSubmit payload.",
};

const inProcessStop: HookExecutionContract = {
	kind: HookEventKind.Stop,
	runtimeEvent: "agent_end",
	authority: HookAuthority.InProcess,
	awaitBehavior: "awaited",
	ordering: "sequential",
	canCancel: false,
	mutation: [],
	timeoutMs: 30_000,
	errorBehavior: "isolate",
	processAuthority: "hook-api",
	trustRequirement: "not-enforced",
	redaction: "none",
	logging: "Extension errors expose the extension path, event name, error message, and stack to registered listeners.",
	semanticNotes:
		"agent_end is the loop-end equivalent. turn_end is per-turn and is intentionally not normalized to Stop.",
};

const lifecycle = (kind: HookEventKind, runtimeEvent: string): HookExecutionContract => ({
	kind,
	runtimeEvent,
	authority: HookAuthority.InProcess,
	awaitBehavior: "awaited",
	ordering: "sequential",
	canCancel: false,
	mutation: [],
	timeoutMs: 30_000,
	errorBehavior: "isolate",
	processAuthority: "hook-api",
	trustRequirement: "not-enforced",
	redaction: "none",
	logging: "Extension errors expose the extension path, event name, error message, and stack to registered listeners.",
	semanticNotes: "Dispatched by ExtensionRunner and awaited sequentially with the shared extension timeout.",
});

/** Per-convention execution truth. Missing entries are unsupported. */
export const CONVENTION_EVENT_CONTRACTS: Record<
	HookSourceConvention,
	Partial<Record<HookEventKind, HookExecutionContract>>
> = {
	[HookSourceConvention.NativeGjc]: {
		[HookEventKind.PreToolUse]: hookModulePre,
		[HookEventKind.PostToolUse]: hookModulePost,
	},
	[HookSourceConvention.ClaudeCode]: {
		[HookEventKind.PreToolUse]: hookModulePre,
		[HookEventKind.PostToolUse]: hookModulePost,
	},
	[HookSourceConvention.Codex]: {
		[HookEventKind.PreToolUse]: hookModulePre,
		[HookEventKind.PostToolUse]: hookModulePost,
	},
	[HookSourceConvention.CodexManagedJson]: {
		[HookEventKind.UserPromptSubmit]: managedPrompt,
		[HookEventKind.Stop]: managedStop,
	},
	[HookSourceConvention.GjcPlugin]: {
		[HookEventKind.PreToolUse]: constrainedPre,
		[HookEventKind.PostToolUse]: constrainedPost,
		[HookEventKind.SessionStart]: constrainedLifecycle(HookEventKind.SessionStart, "session_start"),
		[HookEventKind.SessionShutdown]: constrainedLifecycle(HookEventKind.SessionShutdown, "session_shutdown"),
	},
	[HookSourceConvention.InProcess]: {
		[HookEventKind.UserPromptSubmit]: inProcessPrompt,
		[HookEventKind.PreToolUse]: hookModulePre,
		[HookEventKind.PostToolUse]: hookModulePost,
		[HookEventKind.Stop]: inProcessStop,
		[HookEventKind.SessionStart]: lifecycle(HookEventKind.SessionStart, "session_start"),
		[HookEventKind.SessionShutdown]: lifecycle(HookEventKind.SessionShutdown, "session_shutdown"),
	},
};

export const EXTERNAL_EVENT_ALIASES: Readonly<Record<string, HookEventKind>> = {
	UserPromptSubmit: HookEventKind.UserPromptSubmit,
	Stop: HookEventKind.Stop,
	before_agent_start: HookEventKind.UserPromptSubmit,
	tool_call: HookEventKind.PreToolUse,
	tool_result: HookEventKind.PostToolUse,
	agent_end: HookEventKind.Stop,
	session_start: HookEventKind.SessionStart,
	session_shutdown: HookEventKind.SessionShutdown,
};
