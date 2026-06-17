import { describe, expect, it } from "bun:test";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types";
import {
	type BridgeCommandScope,
	isRpcCommandAllowed,
	MANDATORY_FLOOR_COMMAND_SCOPES,
	RPC_COMMAND_TYPES,
	scopeForRpcCommand,
} from "../../src/modes/shared/agent-wire/scopes";

const EXPECTED_RPC_COMMAND_TYPES: readonly RpcCommand["type"][] = [
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
	"workflow_gate_response",
];

describe("agent-wire RPC command scopes", () => {
	it("enumerates every RpcCommand variant exactly once", () => {
		expect(new Set(RPC_COMMAND_TYPES)).toEqual(new Set(EXPECTED_RPC_COMMAND_TYPES));
		expect(RPC_COMMAND_TYPES.length).toBe(EXPECTED_RPC_COMMAND_TYPES.length);
	});

	it("keeps the mandatory compliance floor to prompt control only", () => {
		expect(MANDATORY_FLOOR_COMMAND_SCOPES).toEqual(["prompt"]);
		const floor = new Set<BridgeCommandScope>(MANDATORY_FLOOR_COMMAND_SCOPES);
		for (const type of ["prompt", "steer", "follow_up", "abort", "abort_and_prompt"] as const) {
			expect(isRpcCommandAllowed(type, floor)).toBe(true);
		}
	});

	it("denies sensitive command groups to a floor token", () => {
		const floor = new Set<BridgeCommandScope>(MANDATORY_FLOOR_COMMAND_SCOPES);
		const sensitive: readonly RpcCommand["type"][] = [
			"bash",
			"abort_bash",
			"export_html",
			"new_session",
			"switch_session",
			"branch",
			"set_model",
			"cycle_model",
			"get_messages",
			"get_state",
			"get_login_providers",
			"login",
			"handoff",
			"set_host_tools",
			"set_host_uri_schemes",
		];
		for (const type of sensitive) {
			expect(isRpcCommandAllowed(type, floor)).toBe(false);
		}
	});

	it("maps each command family to the planned coarse scope", () => {
		expect(scopeForRpcCommand("bash")).toBe("bash");
		expect(scopeForRpcCommand("export_html")).toBe("export");
		expect(scopeForRpcCommand("switch_session")).toBe("session");
		expect(scopeForRpcCommand("set_model")).toBe("model");
		expect(scopeForRpcCommand("get_messages")).toBe("message:read");
		expect(scopeForRpcCommand("set_todos")).toBe("control");
		expect(scopeForRpcCommand("set_host_tools")).toBe("host_tools");
		expect(scopeForRpcCommand("set_host_uri_schemes")).toBe("host_uri");
		expect(scopeForRpcCommand("handoff")).toBe("admin");
	});
});
