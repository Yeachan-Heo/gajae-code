/**
 * Coarse bridge authorization scopes for RPC commands.
 *
 * The v1 bridge exposes a network-reachable control surface, so every
 * `RpcCommand` must be assigned to one coarse scope before any REST handler can
 * dispatch it. The registry is intentionally typed as `Record<RpcCommandType,
 * BridgeCommandScope>` so adding a new RPC command without a scope is a compile
 * failure.
 */
import type { RpcCommand } from "../../rpc/rpc-types";

export type RpcCommandType = RpcCommand["type"];

export type BridgeCommandScope =
	| "prompt"
	| "control"
	| "bash"
	| "export"
	| "session"
	| "model"
	| "message:read"
	| "host_tools"
	| "host_uri"
	| "admin";
export const BRIDGE_COMMAND_SCOPES: readonly BridgeCommandScope[] = [
	"prompt",
	"control",
	"bash",
	"export",
	"session",
	"model",
	"message:read",
	"host_tools",
	"host_uri",
	"admin",
];

const RPC_COMMAND_SCOPE_REGISTRY: Record<RpcCommandType, BridgeCommandScope> = {
	prompt: "prompt",
	steer: "prompt",
	follow_up: "prompt",
	abort: "prompt",
	abort_and_prompt: "prompt",
	new_session: "session",
	get_state: "message:read",
	set_todos: "control",
	set_host_tools: "host_tools",
	set_host_uri_schemes: "host_uri",
	get_pending_workflow_gates: "message:read",
	set_model: "model",
	cycle_model: "model",
	get_available_models: "model",
	set_thinking_level: "model",
	cycle_thinking_level: "model",
	set_steering_mode: "control",
	set_follow_up_mode: "control",
	set_interrupt_mode: "control",
	compact: "control",
	set_auto_compaction: "control",
	set_auto_retry: "control",
	abort_retry: "control",
	bash: "bash",
	abort_bash: "bash",
	get_session_stats: "message:read",
	export_html: "export",
	switch_session: "session",
	branch: "session",
	get_branch_messages: "session",
	get_last_assistant_text: "message:read",
	set_session_name: "session",
	handoff: "admin",
	get_messages: "message:read",
	get_login_providers: "admin",
	login: "admin",
	negotiate_unattended: "control",
	workflow_gate_response: "control",
};

export const RPC_COMMAND_TYPES: readonly RpcCommandType[] = Object.keys(RPC_COMMAND_SCOPE_REGISTRY) as RpcCommandType[];
export function isRpcCommandType(value: unknown): value is RpcCommandType {
	return typeof value === "string" && value in RPC_COMMAND_SCOPE_REGISTRY;
}

export const MANDATORY_FLOOR_COMMAND_SCOPES: readonly BridgeCommandScope[] = ["prompt"];

export function scopeForRpcCommand(type: RpcCommandType): BridgeCommandScope {
	return RPC_COMMAND_SCOPE_REGISTRY[type];
}

export function isRpcCommandAllowed(type: RpcCommandType, scopes: ReadonlySet<BridgeCommandScope>): boolean {
	return scopes.has(scopeForRpcCommand(type));
}
