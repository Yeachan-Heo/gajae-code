import type { RpcCommand } from "../../rpc/rpc-types";
import { isRpcCommandType } from "./scopes";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function optionalArray(value: unknown): boolean {
	return value === undefined || Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): boolean {
	return typeof value[key] === "string";
}

const THINKING_LEVELS = new Set(["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const TODO_STATUSES = new Set(["pending", "in_progress", "completed", "abandoned"]);

function optionalBoolean(value: unknown): boolean {
	return value === undefined || typeof value === "boolean";
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

const GET_STATE_INCLUDES = new Set(["tools", "dumpTools", "systemPrompt"]);

function optionalGetStateInclude(value: unknown): boolean {
	return (
		value === undefined ||
		(Array.isArray(value) && value.every(item => typeof item === "string" && GET_STATE_INCLUDES.has(item)))
	);
}

function todoPhase(value: unknown): boolean {
	if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.tasks)) return false;
	return value.tasks.every(
		task =>
			isRecord(task) &&
			typeof task.content === "string" &&
			typeof task.status === "string" &&
			TODO_STATUSES.has(task.status) &&
			(task.notes === undefined || stringArray(task.notes)),
	);
}

function hostToolDefinition(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.name === "string" &&
		typeof value.description === "string" &&
		isRecord(value.parameters) &&
		optionalString(value.label) &&
		optionalBoolean(value.hidden)
	);
}

function hostUriScheme(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.scheme === "string" &&
		optionalString(value.description) &&
		optionalBoolean(value.writable) &&
		optionalBoolean(value.immutable)
	);
}

function unattendedBudget(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.max_tokens === "number" &&
		typeof value.max_tool_calls === "number" &&
		typeof value.max_wall_time_ms === "number" &&
		typeof value.max_cost_usd === "number"
	);
}

function unattendedDeclaration(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.actor === "string" &&
		unattendedBudget(value.budget) &&
		stringArray(value.scopes) &&
		stringArray(value.action_allowlist)
	);
}

export function isRpcCommand(value: unknown): value is RpcCommand {
	if (!isRecord(value) || !optionalString(value.id) || !isRpcCommandType(value.type)) return false;
	switch (value.type) {
		case "prompt":
			return (
				stringField(value, "message") &&
				optionalArray(value.images) &&
				(value.streamingBehavior === undefined ||
					value.streamingBehavior === "steer" ||
					value.streamingBehavior === "followUp")
			);
		case "steer":
		case "follow_up":
			return stringField(value, "message") && optionalArray(value.images);
		case "abort":
			return true;
		case "get_state":
			return optionalGetStateInclude(value.include);
		case "cycle_model":
		case "get_available_models":
		case "cycle_thinking_level":
		case "abort_retry":
		case "abort_bash":
		case "get_session_stats":
		case "get_branch_messages":
		case "get_last_assistant_text":
		case "get_messages":
		case "get_login_providers":
		case "get_pending_workflow_gates":
			return true;
		case "abort_and_prompt":
			return stringField(value, "message") && optionalArray(value.images);
		case "new_session":
			return optionalString(value.parentSession);
		case "set_todos":
			return Array.isArray(value.phases) && value.phases.every(todoPhase);
		case "set_host_tools":
			return Array.isArray(value.tools) && value.tools.every(hostToolDefinition);
		case "set_host_uri_schemes":
			return Array.isArray(value.schemes) && value.schemes.every(hostUriScheme);
		case "set_capabilities":
			return (
				Array.isArray(value.capabilities) && value.capabilities.every(capability => typeof capability === "string")
			);
		case "set_model":
			return stringField(value, "provider") && stringField(value, "modelId");
		case "set_thinking_level":
			return typeof value.level === "string" && THINKING_LEVELS.has(value.level);
		case "set_steering_mode":
			return value.mode === "all" || value.mode === "one-at-a-time";
		case "set_follow_up_mode":
			return value.mode === "all" || value.mode === "one-at-a-time";
		case "set_interrupt_mode":
			return value.mode === "immediate" || value.mode === "wait";
		case "compact":
			return optionalString(value.customInstructions);
		case "set_auto_compaction":
		case "set_auto_retry":
			return typeof value.enabled === "boolean";
		case "bash":
			return stringField(value, "command");
		case "export_html":
			return optionalString(value.outputPath);
		case "switch_session":
			return stringField(value, "sessionPath");
		case "branch":
			return stringField(value, "entryId");
		case "set_session_name":
			return stringField(value, "name");
		case "handoff":
			return optionalString(value.customInstructions);
		case "login":
			return stringField(value, "providerId");
		case "negotiate_unattended":
			return unattendedDeclaration(value.declaration);
		case "workflow_gate_response":
			return stringField(value, "gate_id") && "answer" in value && optionalString(value.idempotency_key);
	}
}
