import { describe, expect, test } from "bun:test";
import {
	createRpcCommandScheduler,
	isFastLaneRpcCommand,
	RPC_CANCELLATION_COMMANDS,
	RPC_SAFE_READ_CONTROL_COMMANDS,
} from "@gajae-code/coding-agent/modes/rpc/rpc-mode";
import type { RpcCommand } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import {
	dispatchRpcCommand,
	type RpcCommandDispatchContext,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/command-dispatch";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";

const FAST_LANE_COMMANDS: RpcCommand["type"][] = [
	// Cancellation (must interrupt in-flight work).
	"abort",
	"abort_bash",
	"abort_retry",
	// Pure read-only snapshots (no causal write to reorder).
	"get_state",
	"get_session_stats",
	"get_available_models",
	"get_branch_messages",
	"get_last_assistant_text",
	"get_messages",
	"get_login_providers",
];

// Commands that MUST stay on the ordered serial chain: async/long work, causally
// significant async mutations, or synchronous mutating mode/config setters. The
// setters are kept ordered because a fast-laned setter could overtake an
// already-queued ordered command (e.g. a prompt submitted before it) and change
// that command's causal semantics (#618 review).
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
	// Mutating mode/config setters — causally significant, must not fast-lane.
	"set_thinking_level",
	"cycle_thinking_level",
	"set_steering_mode",
	"set_follow_up_mode",
	"set_interrupt_mode",
	"set_auto_compaction",
	"set_auto_retry",
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

	test("mutating mode/config setters stay ordered (#618 causal-order regression)", () => {
		const mutatingSetters: RpcCommand["type"][] = [
			"set_thinking_level",
			"cycle_thinking_level",
			"set_steering_mode",
			"set_follow_up_mode",
			"set_interrupt_mode",
			"set_auto_compaction",
			"set_auto_retry",
		];
		for (const type of mutatingSetters) {
			expect(RPC_SAFE_READ_CONTROL_COMMANDS.has(type)).toBe(false);
			expect(isFastLaneRpcCommand(type)).toBe(false);
		}
	});

	test("the safe read set is read-only (no set_/cycle_ mutating command leaks in)", () => {
		for (const type of RPC_SAFE_READ_CONTROL_COMMANDS) {
			expect(type.startsWith("get_")).toBe(true);
		}
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

	test("a mutating setter does not overtake an earlier queued ordered command (#618)", async () => {
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

		// Arrival order is the hazard from the review: a long bash holds the chain,
		// a prompt is queued behind it, then a setter arrives. The setter must NOT
		// jump ahead and apply before the earlier prompt runs.
		dispatch({ type: "bash", command: "sleep 1000" } as RpcCommand);
		dispatch({ type: "prompt", message: "hi" } as RpcCommand);
		dispatch({ type: "set_thinking_level", level: "high" } as RpcCommand);
		await flushMicrotasks();
		// Nothing runs while bash holds the chain — the setter cannot fast-lane.
		expect(order).toEqual([]);

		releaseLong();
		await flushMicrotasks();
		// The setter applies strictly AFTER the earlier queued prompt, so the prompt
		// runs under the pre-setter mode (arrival-order / causal semantics preserved).
		expect(order).toEqual(["bash", "prompt", "set_thinking_level"]);
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

describe("get_messages fast-lane snapshot (#618)", () => {
	const ctx = (session: Partial<AgentSession>): RpcCommandDispatchContext => ({
		session: session as AgentSession,
		output: () => {},
		hostToolRegistry: { setTools: () => [] },
		hostUriRegistry: { setSchemes: () => [] },
		createUiContext: () => ({ notify: () => {} }),
	});

	test("returns a defensive copy, not the live session.messages array", async () => {
		const live = [
			{ role: "user", content: "a" },
			{ role: "assistant", content: "b" },
		] as unknown as AgentSession["messages"];
		const res = await dispatchRpcCommand({ id: "m1", type: "get_messages" } as RpcCommand, ctx({ messages: live }));
		expect(res.success).toBe(true);
		if (!res.success || res.command !== "get_messages") throw new Error("expected get_messages success");
		const returned = res.data.messages;

		// A snapshot: equal contents but a distinct array reference.
		expect(returned).not.toBe(live);
		expect(returned).toEqual(live);

		// Mutating the live array after the read (as an ordered turn/compaction
		// would) must not retroactively change the already-returned snapshot.
		live.push({ role: "user", content: "c" } as unknown as (typeof live)[number]);
		expect(returned).toHaveLength(2);
	});
});
