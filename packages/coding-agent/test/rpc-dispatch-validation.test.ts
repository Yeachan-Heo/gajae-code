import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { RpcCommand } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import {
	dispatchRpcCommand,
	type RpcCommandDispatchContext,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/command-dispatch";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";

function ctx(session: Partial<AgentSession> = {}): RpcCommandDispatchContext {
	return {
		session: session as AgentSession,
		output: () => {},
		hostToolRegistry: { setTools: () => [] },
		hostUriRegistry: { setSchemes: () => [] },
		createUiContext: () => ({ notify: () => {} }),
	};
}

describe("dispatchRpcCommand validation + error correlation", () => {
	test("rejects an invalid thinking level with a correlated error (issue 02)", async () => {
		const res = await dispatchRpcCommand(
			{ id: "t1", type: "set_thinking_level", level: "BOGUS" } as unknown as RpcCommand,
			ctx(),
		);
		expect(res.success).toBe(false);
		expect(res.id).toBe("t1");
		expect(res.command).toBe("set_thinking_level");
	});

	test("rejects an invalid steering mode (issue 02)", async () => {
		const res = await dispatchRpcCommand(
			{ id: "s1", type: "set_steering_mode", mode: "BOGUS" } as unknown as RpcCommand,
			ctx(),
		);
		expect(res.success).toBe(false);
		expect(res.id).toBe("s1");
		expect(res.command).toBe("set_steering_mode");
	});

	test("rejects an invalid interrupt mode (issue 02)", async () => {
		const res = await dispatchRpcCommand(
			{ id: "i1", type: "set_interrupt_mode", mode: 123 } as unknown as RpcCommand,
			ctx(),
		);
		expect(res.success).toBe(false);
		expect(res.command).toBe("set_interrupt_mode");
	});

	test("applies a valid thinking level", async () => {
		let applied: unknown;
		const res = await dispatchRpcCommand(
			{ id: "t2", type: "set_thinking_level", level: ThinkingLevel.High },
			ctx({
				setThinkingLevel: ((level: unknown) => {
					applied = level;
				}) as AgentSession["setThinkingLevel"],
			}),
		);
		expect(res.success).toBe(true);
		expect(applied).toBe(ThinkingLevel.High);
	});

	test("a handler exception is correlated to the request id and real command, not 'parse' (issue 01)", async () => {
		// `set_session_name` with no `name` throws inside the handler (command.name.trim()).
		const res = await dispatchRpcCommand({ id: "n1", type: "set_session_name" } as unknown as RpcCommand, ctx());
		expect(res.success).toBe(false);
		expect(res.id).toBe("n1");
		expect(res.command).toBe("set_session_name");
		expect(res.command).not.toBe("parse");
	});

	test("an unknown command preserves the caller's request id (issue 01 default sub-case)", async () => {
		const res = await dispatchRpcCommand(
			{ id: "u1", type: "totally_unknown_command" } as unknown as RpcCommand,
			ctx(),
		);
		expect(res.success).toBe(false);
		expect(res.id).toBe("u1");
		expect(res.command).toBe("totally_unknown_command");
	});
});
