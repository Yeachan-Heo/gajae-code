/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */
import type { AgentMessage, AgentToolResult, ThinkingLevel } from "@gajae-code/agent-core";
import type { CompactionResult } from "@gajae-code/agent-core/compaction";
import type { Effort, ImageContent, Model } from "@gajae-code/ai";
import type { BashResult } from "../../exec/bash-executor";
import type { ContextUsage } from "../../extensibility/extensions/types";
import type { SessionStats } from "../../session/agent-session";
import type { TodoPhase } from "../../tools/todo-write";

export type RpcGetStateInclude = "tools" | "dumpTools" | "systemPrompt";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "abort_and_prompt"; message: string; images?: ImageContent[] }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_state"; include?: RpcGetStateInclude[] }
	| { id?: string; type: "set_todos"; phases: TodoPhase[] }
	| { id?: string; type: "set_host_tools"; tools: RpcHostToolDefinition[] }
	| { id?: string; type: "set_host_uri_schemes"; schemes: RpcHostUriSchemeDefinition[] }
	| { id?: string; type: "get_pending_workflow_gates" }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_interrupt_mode"; mode: "immediate" | "wait" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "branch"; entryId: string }
	| { id?: string; type: "get_branch_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "handoff"; customInstructions?: string }

	// Messages
	| { id?: string; type: "get_messages" }

	// Login
	| { id?: string; type: "get_login_providers" }
	| { id?: string; type: "login"; providerId: string }

	// Unattended control plane (#318/#319 declaration handled here at #315 contract level)
	| { id?: string; type: "negotiate_unattended"; declaration: RpcUnattendedDeclaration }

	// Workflow gate answer (inbound response to a workflow_gate event)
	| ({ id?: string; type: "workflow_gate_response" } & RpcWorkflowGateResponse);

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model;
	thinkingLevel: ThinkingLevel | undefined;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	queuedMessageCount: number;
	todoPhases: TodoPhase[];
	/** Optional static system prompt blocks. Omitted by default; request with get_state include ["systemPrompt"]. */
	systemPrompt?: string[];
	/** Optional static tool schemas. Omitted by default; request with get_state include ["tools"]. */
	dumpTools?: Array<{ name: string; description: string; parameters: unknown }>;
	/** Current context window usage. Null tokens/percent when unknown (e.g. right after compaction). */
	contextUsage?: ContextUsage;
}

export interface RpcHandoffResult {
	savedPath?: string;
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "abort_and_prompt"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| { id?: string; type: "response"; command: "set_todos"; success: true; data: { todoPhases: TodoPhase[] } }
	| { id?: string; type: "response"; command: "set_host_tools"; success: true; data: { toolNames: string[] } }
	| { id?: string; type: "response"; command: "set_host_uri_schemes"; success: true; data: { schemes: string[] } }
	| {
			id?: string;
			type: "response";
			command: "get_pending_workflow_gates";
			success: true;
			data: { gates: RpcWorkflowGate[] };
	  }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model; thinkingLevel: ThinkingLevel | undefined; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model[] };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: Effort } | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }
	| { id?: string; type: "response"; command: "set_interrupt_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "branch"; success: true; data: { text: string; cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_branch_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }
	| { id?: string; type: "response"; command: "handoff"; success: true; data: RpcHandoffResult | null }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// Login
	| {
			id?: string;
			type: "response";
			command: "get_login_providers";
			success: true;
			data: { providers: Array<{ id: string; name: string; available: boolean; authenticated: boolean }> };
	  }
	| { id?: string; type: "response"; command: "login"; success: true; data: { providerId: string } }

	// Unattended + workflow gates
	| { id?: string; type: "response"; command: "negotiate_unattended"; success: true; data: RpcUnattendedAccepted }
	| {
			id?: string;
			type: "response";
			command: "workflow_gate_response";
			success: true;
			data: RpcWorkflowGateResolution;
	  }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string | object };

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "editor";
			title: string;
			prefill?: string;
			promptStyle?: boolean;
	  }
	| { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	| { type: "extension_ui_request"; id: string; method: "open_url"; url: string; instructions?: string };

// ============================================================================
// Host Tool Frames (bidirectional)
// ============================================================================

export interface RpcHostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
}

/** Emitted by the RPC server when it needs the host to execute a registered tool. */
export interface RpcHostToolCallRequest {
	type: "host_tool_call";
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

/** Emitted by the RPC server when a pending host tool call should be aborted. */
export interface RpcHostToolCancelRequest {
	type: "host_tool_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to stream partial tool updates back to the RPC server. */
export interface RpcHostToolUpdate {
	type: "host_tool_update";
	id: string;
	partialResult: AgentToolResult<unknown>;
}

/** Sent by the host to complete a pending tool call. */
export interface RpcHostToolResult {
	type: "host_tool_result";
	id: string;
	result: AgentToolResult<unknown>;
	isError?: boolean;
}

// ============================================================================
// Host URI Frames (bidirectional)
// ============================================================================

export interface RpcHostUriSchemeDefinition {
	/** URL scheme without trailing `://` (e.g. `db`, `notion`). */
	scheme: string;
	/** Optional human-readable description for logs/diagnostics. */
	description?: string;
	/** When true, the write tool is allowed to dispatch writes to this scheme. */
	writable?: boolean;
	/** When true, downstream callers suppress hashline anchors for resolved content. */
	immutable?: boolean;
}

export type RpcHostUriOperation = "read" | "write";

/** Emitted by the RPC server when it needs the host to satisfy a URI operation. */
export interface RpcHostUriRequest {
	type: "host_uri_request";
	id: string;
	operation: RpcHostUriOperation;
	url: string;
	/** Present for write operations. */
	content?: string;
}

/** Emitted by the RPC server when a pending URI request should be aborted. */
export interface RpcHostUriCancelRequest {
	type: "host_uri_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to complete a pending URI request. */
export interface RpcHostUriResult {
	type: "host_uri_result";
	id: string;
	/**
	 * Required for successful `read` results. Ignored for `write` success.
	 * Set on errors when a textual explanation accompanies `isError`.
	 */
	content?: string;
	/** Defaults to `text/plain` when omitted. */
	contentType?: "text/markdown" | "application/json" | "text/plain";
	/** Optional resolution notes propagated to the read tool. */
	notes?: string[];
	/** Overrides the scheme-level `immutable` flag for this single resolution. */
	immutable?: boolean;
	/** When true, surface the result content as an error to the caller. */
	isError?: boolean;
	/** Optional error message; preferred over `content` for error surfacing. */
	error?: string;
}

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];

// ============================================================================
// Workflow Gate Contract (#315)
// ============================================================================

/**
 * Lifecycle stages that emit machine-addressable gates. v1 is single-agent;
 * `team` parallel execution over RPC is deferred, so it is intentionally absent
 * from this union. Gate construction rejects any other stage value.
 */
export type RpcWorkflowStage = "deep-interview" | "ralplan" | "ultragoal";

/** Reserved stage names that are explicitly not part of the v1 contract. */
export const RESERVED_WORKFLOW_STAGES: readonly string[] = ["team"];

export type RpcWorkflowGateKind = "question" | "approval" | "execution";

/**
 * The documented JSON Schema 2020-12 subset supported by the gate validator.
 * Schemas containing any keyword outside this shape are rejected at gate
 * construction time so the server never advertises a schema it cannot validate.
 */
export interface RpcJsonSchema {
	type?: "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";
	enum?: unknown[];
	const?: unknown;
	properties?: Record<string, RpcJsonSchema>;
	required?: string[];
	additionalProperties?: boolean | RpcJsonSchema;
	items?: RpcJsonSchema;
	minLength?: number;
	maxLength?: number;
	minItems?: number;
	maxItems?: number;
	uniqueItems?: boolean;
	minimum?: number;
	maximum?: number;
	title?: string;
	description?: string;
	oneOf?: RpcJsonSchema[];
	anyOf?: RpcJsonSchema[];
}

export interface RpcWorkflowGateOption {
	value: unknown;
	label: string;
	description?: string;
}

export interface RpcWorkflowGateContext {
	title?: string;
	plan?: string;
	source?: string;
	prompt?: string;
	summary?: string;
	stage_state?: Record<string, unknown>;
	artifact_refs?: Array<{ kind: string; path?: string; sha256?: string }>;
	language?: string;
}

/** Outbound event: a machine-addressable workflow gate awaiting an answer. */
export interface RpcWorkflowGate {
	type: "workflow_gate";
	/** Run-scoped, monotonic, stable id (e.g. `wg_<run>_<stage>_000001`). */
	gate_id: string;
	stage: RpcWorkflowStage;
	kind: RpcWorkflowGateKind;
	schema: RpcJsonSchema;
	/** Canonical hash of `schema`; advertised hash must equal server validation hash. */
	schema_hash: string;
	options?: RpcWorkflowGateOption[];
	context: RpcWorkflowGateContext;
	created_at: string;
	required: true;
}

/** Inbound: the agent's answer to a workflow gate. */
export interface RpcWorkflowGateResponse {
	gate_id: string;
	answer: unknown;
	/** Optional idempotency key; same key + body returns the cached resolution. */
	idempotency_key?: string;
}

/** Outcome of resolving a gate, surfaced back to the answering client. */
export interface RpcWorkflowGateResolution {
	gate_id: string;
	status: "accepted" | "rejected";
	answer_hash: string;
	resolved_at: string;
	/** Present only when `status === "rejected"`. */
	error?: RpcWorkflowGateValidationError;
}

/** Typed error shape for schema validation failures (#315 acceptance). */
export interface RpcWorkflowGateValidationError {
	code: "invalid_workflow_gate_answer";
	gate_id: string;
	schema_hash: string;
	errors: Array<{ path: string; keyword: string; message: string; expected?: unknown }>;
}

// ============================================================================
// Unattended Declaration Contract (#318/#319 — declared at #315 boundary)
// ============================================================================

export interface RpcUnattendedBudget {
	max_tokens: number;
	max_tool_calls: number;
	max_wall_time_ms: number;
	max_cost_usd: number;
}

export interface RpcUnattendedDeclaration {
	/** Identity of the operating external agent, recorded in the audit trail. */
	actor: string;
	budget: RpcUnattendedBudget;
	/** Coarse command scopes the agent may use (maps to BridgeCommandScope). */
	scopes: string[];
	/** Action classes the agent is allowed to perform (default-deny otherwise). */
	action_allowlist: string[];
}

export interface RpcUnattendedAccepted {
	run_id: string;
	actor: string;
	budget: RpcUnattendedBudget;
	scopes: string[];
	action_allowlist: string[];
	accepted_at: string;
}

export type RpcBudgetMetric = "tokens" | "tool_calls" | "wall_time" | "cost";

/** Typed payload emitted when a declared budget cap is breached (#318). */
export interface RpcBudgetExceeded {
	code: "budget_exceeded";
	metric: RpcBudgetMetric;
	limit: number;
	observed: number;
	/** The accounting phase that detected the breach. */
	phase: string;
	run_id: string;
	session_id?: string;
	/** `aborting` = breach detected, async abort initiated; settled status follows in audit. */
	abort_status: "aborting" | "aborted" | "abort_failed";
}

export type RpcUnattendedRefusalCode =
	| "unattended_not_negotiated"
	| "incomplete_budget"
	| "unsupported_budget_metric"
	| "invalid_unattended_declaration"
	| "unattended_aborted";

/** Typed refusal emitted when unattended mode cannot start or continue (fail-closed). */
export interface RpcUnattendedRefused {
	code: RpcUnattendedRefusalCode;
	message: string;
}

// ============================================================================
// Unattended Action Authorization Contract (#319)
// ============================================================================

/** v1 action taxonomy: every authorized operation maps to one of these classes. */
export type RpcUnattendedActionClass =
	| "command.prompt"
	| "command.control"
	| "command.bash"
	| "command.export"
	| "command.session"
	| "command.model"
	| "command.message_read"
	| "command.host_tools"
	| "command.host_uri"
	| "command.admin"
	| "bash.readonly"
	| "bash.mutating"
	| "bash.destructive"
	| "git.force_push"
	| "file.delete"
	| "file.write"
	| "host_tool.invoke"
	| "host_uri.read"
	| "host_uri.write"
	| "auth.login";

/** Typed error when a command's coarse scope is not in the declared allowlist. */
export interface RpcScopeDenied {
	code: "scope_denied";
	scope: string;
	command?: string;
	run_id: string;
	session_id?: string;
	/** Always true: enforcement happens before the side effect runs. */
	pre_side_effect: true;
}

/** Typed error when an action class is not in the declared allowlist (default-deny). */
export interface RpcActionDenied {
	code: "action_denied";
	action: string;
	command?: string;
	run_id: string;
	session_id?: string;
	pre_side_effect: true;
}
