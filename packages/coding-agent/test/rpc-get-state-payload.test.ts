import { describe, expect, it } from "bun:test";
import type { RpcResponse, RpcSessionState } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import {
	dispatchRpcCommand,
	type RpcCommandDispatchContext,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/command-dispatch";
import { isRpcCommand } from "@gajae-code/coding-agent/modes/shared/agent-wire/command-validation";

const toolSchema = {
	type: "object",
	properties: {
		path: { type: "string" },
	},
};

function getStateData(response: RpcResponse): RpcSessionState {
	expect(response.success).toBe(true);
	if (!response.success || response.command !== "get_state") {
		throw new Error("Expected successful get_state response");
	}
	return response.data;
}

function dispatchContext(): RpcCommandDispatchContext {
	const session = {
		model: undefined,
		thinkingLevel: undefined,
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		interruptMode: "wait",
		sessionFile: "/tmp/gjc-test-session.jsonl",
		sessionId: "session-539",
		sessionName: "issue-539",
		autoCompactionEnabled: true,
		messages: [],
		queuedMessageCount: 0,
		getTodoPhases: () => [],
		getContextUsage: () => ({ tokens: 0, contextWindow: 200_000, percent: 0 }),
		systemPrompt: ["short system prompt"],
		agent: {
			state: {
				tools: [
					{
						name: "read",
						description: "Read files",
						parameters: toolSchema,
					},
				],
			},
		},
	} as unknown as RpcCommandDispatchContext["session"];

	return {
		session,
		output: () => undefined,
		hostToolRegistry: { setTools: () => [] },
		hostUriRegistry: { setSchemes: () => [] },
		createUiContext: () => ({ notify: () => undefined }),
	};
}

describe("RPC get_state payload", () => {
	it("omits static tool schemas and system prompt by default", async () => {
		const data = getStateData(await dispatchRpcCommand({ id: "default", type: "get_state" }, dispatchContext()));

		expect(Object.hasOwn(data, "dumpTools")).toBe(false);
		expect(Object.hasOwn(data, "systemPrompt")).toBe(false);
		expect(data.sessionId).toBe("session-539");
		expect(data.messageCount).toBe(0);
		expect(data.queuedMessageCount).toBe(0);
		expect(data.todoPhases).toEqual([]);
		expect(data.contextUsage).toEqual({ tokens: 0, contextWindow: 200_000, percent: 0 });
	});

	it("includes static fields only when requested", async () => {
		const data = getStateData(
			await dispatchRpcCommand(
				{ id: "full", type: "get_state", include: ["tools", "systemPrompt"] },
				dispatchContext(),
			),
		);

		expect(data.systemPrompt).toEqual(["short system prompt"]);
		expect(data.dumpTools).toEqual([{ name: "read", description: "Read files", parameters: toolSchema }]);
	});

	it("validates the bounded include surface", () => {
		expect(isRpcCommand({ type: "get_state" })).toBe(true);
		expect(isRpcCommand({ type: "get_state", include: ["tools", "dumpTools", "systemPrompt"] })).toBe(true);
		expect(isRpcCommand({ type: "get_state", include: ["messages"] })).toBe(false);
		expect(isRpcCommand({ type: "get_state", include: "tools" })).toBe(false);
	});
});
