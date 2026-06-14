import { describe, expect, test } from "bun:test";
import {
	createRpcCommandScheduler,
	isFastLaneRpcCommand,
	RPC_CANCELLATION_COMMANDS,
	RPC_SAFE_READ_CONTROL_COMMANDS,
} from "@gajae-code/coding-agent/modes/rpc/rpc-mode";
import type { RpcCommand } from "@gajae-code/coding-agent/modes/rpc/rpc-types";

const FAST_LANE_COMMANDS: RpcCommand["type"][] = [
	// Cancellation (must interrupt in-flight work).
	"abort",
	"abort_bash",
	"abort_retry",
	// Pure synchronous reads.
	"get_state",
	"get_session_stats",
	"get_available_models",
	"get_branch_messages",
	"get_last_assistant_text",
	"get_messages",
	"get_login_providers",
	// Synchronous control-flag setters.
	"set_thinking_level",
	"cycle_thinking_level",
	"set_steering_mode",
	"set_follow_up_mode",
	"set_interrupt_mode",
	"set_auto_compaction",
	"set_auto_retry",
];

// Commands that MUST stay on the ordered serial chain: async/long work or
// causally significant async mutations.
const ORDERED_COMMANDS: RpcCommand["type"][] = [
	"prompt",
	"steer",
	"follow_up",
	"abort_and_prompt",
	"new_session",
	"switch_session",
	"branch",
	"bash",
	"compact",
	"handoff",
	"login",
	"set_model",
	"cycle_model",
	"set_todos",
	"set_session_name",
	"set_host_tools",
	"set_host_uri_schemes",
	"export_html",
	"negotiate_unattended",
	"workflow_gate_response",
];

const flushMicrotasks = async (): Promise<void> => {
	for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("RPC fast-lane classification (#606, issue 13)", () => {
	test("every fast-lane command is recognized", () => {
		for (const type of FAST_LANE_COMMANDS) {
			expect(isFastLaneRpcCommand(type)).toBe(true);
		}
	});

	test("ordered commands never fast-lane (fail-safe default)", () => {
		for (const type of ORDERED_COMMANDS) {
			expect(isFastLaneRpcCommand(type)).toBe(false);
		}
	});

	test("the cancellation set is exactly the three abort commands", () => {
		expect([...RPC_CANCELLATION_COMMANDS].sort()).toEqual(["abort", "abort_bash", "abort_retry"]);
	});

	test("set_model / cycle_model / set_todos stay ordered (causal mutations)", () => {
		expect(RPC_SAFE_READ_CONTROL_COMMANDS.has("set_model")).toBe(false);
		expect(RPC_SAFE_READ_CONTROL_COMMANDS.has("cycle_model")).toBe(false);
		expect(RPC_SAFE_READ_CONTROL_COMMANDS.has("set_todos")).toBe(false);
	});

	test("classification is exhaustive — fast-lane and ordered partition every command type", () => {
		const all = new Set<RpcCommand["type"]>([...FAST_LANE_COMMANDS, ...ORDERED_COMMANDS]);
		// No command may appear in both lists.
		expect(FAST_LANE_COMMANDS.filter(t => ORDERED_COMMANDS.includes(t))).toEqual([]);
		// Guards against a new command type silently slipping through untested.
		expect(all.size).toBe(FAST_LANE_COMMANDS.length + ORDERED_COMMANDS.length);
	});
});

describe("createRpcCommandScheduler ordering behavior", () => {
	test("a fast-lane read does not head-of-line-block behind a long ordered command", async () => {
		const order: string[] = [];
		let releaseLong: () => void = () => {};
		const longRunning = new Promise<void>(resolve => {
			releaseLong = resolve;
		});
		const run = async (command: RpcCommand): Promise<void> => {
			if (command.type === "bash") {
				await longRunning;
				order.push("bash");
				return;
			}
			order.push(command.type);
		};
		const { dispatch } = createRpcCommandScheduler(run, () => {});

		dispatch({ type: "bash", command: "sleep 1000" } as RpcCommand);
		dispatch({ type: "get_state" } as RpcCommand);
		await flushMicrotasks();

		// get_state ran immediately while the long bash is still blocked.
		expect(order).toEqual(["get_state"]);

		releaseLong();
		await flushMicrotasks();
		expect(order).toEqual(["get_state", "bash"]);
	});

	test("ordered commands behind a long command preserve arrival order", async () => {
		const order: string[] = [];
		let releaseLong: () => void = () => {};
		const longRunning = new Promise<void>(resolve => {
			releaseLong = resolve;
		});
		const run = async (command: RpcCommand): Promise<void> => {
			if (command.type === "bash") {
				await longRunning;
				order.push("bash");
				return;
			}
			order.push(command.type);
		};
		const { dispatch } = createRpcCommandScheduler(run, () => {});

		dispatch({ type: "bash", command: "sleep 1000" } as RpcCommand);
		// set_model is an ordered mutation: it must wait for the in-flight bash.
		dispatch({ type: "set_model", provider: "p", modelId: "m" } as RpcCommand);
		await flushMicrotasks();
		expect(order).toEqual([]);

		releaseLong();
		await flushMicrotasks();
		expect(order).toEqual(["bash", "set_model"]);
	});

	test("every dispatched task is tracked for shutdown draining", async () => {
		const tracked: Promise<void>[] = [];
		const run = async (): Promise<void> => {};
		const { dispatch } = createRpcCommandScheduler(run, task => {
			tracked.push(task);
		});

		dispatch({ type: "get_state" } as RpcCommand); // fast-lane
		dispatch({ type: "bash", command: "x" } as RpcCommand); // ordered
		expect(tracked).toHaveLength(2);
		await Promise.allSettled(tracked);
	});
});
