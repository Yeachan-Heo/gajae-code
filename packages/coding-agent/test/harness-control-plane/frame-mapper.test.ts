import { describe, expect, it } from "bun:test";
import { isTestRunnerTool, mapRpcFrame } from "../../src/harness-control-plane/frame-mapper";

describe("mapRpcFrame", () => {
	it("ignores ready/response and unknown frames (adapter handles those)", () => {
		expect(mapRpcFrame({ type: "ready" })).toBeNull();
		expect(mapRpcFrame({ type: "response", id: "x", success: true })).toBeNull();
		expect(mapRpcFrame({ type: "totally_unknown" })).toBeNull();
		expect(mapRpcFrame({})).toBeNull();
	});

	it("maps semantic lifecycle frames with never-drop flag", () => {
		expect(mapRpcFrame({ type: "agent_start" })).toMatchObject({
			kind: "rpc_agent_started",
			signal: "SessionStart",
			semantic: true,
		});
		expect(mapRpcFrame({ type: "agent_end" })).toMatchObject({
			kind: "rpc_agent_completed",
			signal: "completed",
			semantic: true,
		});
		expect(mapRpcFrame({ type: "agent_end", outcome: "aborted" })).toMatchObject({
			kind: "rpc_agent_failed",
			signal: "error",
			semantic: true,
			severity: "critical",
		});
		expect(mapRpcFrame({ type: "extension_error", error: "boom" })).toMatchObject({
			kind: "rpc_extension_error",
			signal: "error",
			semantic: true,
		});
	});

	it("maps tool execution to tool-call, and test runners to test-running", () => {
		const start = mapRpcFrame({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			command: "bun test foo",
		});
		expect(start).toMatchObject({ kind: "rpc_tool_started", signal: "test-running", semantic: true });
		const plain = mapRpcFrame({ type: "tool_execution_start", toolCallId: "t2", toolName: "read" });
		expect(plain).toMatchObject({ signal: "tool-call", semantic: true });
		const end = mapRpcFrame({ type: "tool_execution_end", toolCallId: "t2", toolName: "read", status: "ok" });
		expect(end).toMatchObject({ kind: "rpc_tool_ended", signal: "tool-call", semantic: true });
	});

	it("marks message_update + tool_execution_update as coalescible (non-semantic) with keys", () => {
		const m = mapRpcFrame({ type: "message_update", messageId: "m1" });
		expect(m).toMatchObject({ signal: null, semantic: false, coalesceKey: "message:m1" });
		const u = mapRpcFrame({ type: "tool_execution_update", toolCallId: "t9", status: "running" });
		expect(u).toMatchObject({ semantic: false, coalesceKey: "tool:t9" });
	});

	it("redacts: evidence carries no assistant text / message deltas / command output", () => {
		const m = mapRpcFrame({
			type: "message_update",
			messageId: "m1",
			delta: "secret assistant text",
			text: "more text",
		}) ?? { evidence: {} };
		const json = JSON.stringify(m.evidence);
		expect(json).not.toContain("secret assistant text");
		expect(json).not.toContain("more text");
		const t = mapRpcFrame({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			command: "echo SECRET",
			output: "SECRET OUTPUT",
			status: "ok",
		}) ?? { evidence: {} };
		const tj = JSON.stringify(t.evidence);
		expect(tj).not.toContain("SECRET OUTPUT");
		expect(tj).not.toContain("echo SECRET");
	});

	it("bounds extension_error message length", () => {
		const big = "x".repeat(5000);
		const e = mapRpcFrame({ type: "extension_error", error: big });
		expect(String((e?.evidence as Record<string, unknown>).code).length).toBeLessThanOrEqual(200);
	});

	it("isTestRunnerTool detects common runners", () => {
		expect(isTestRunnerTool("bash", "bun test x")).toBe(true);
		expect(isTestRunnerTool("bash", "vitest run")).toBe(true);
		expect(isTestRunnerTool("bash", "echo hi")).toBe(false);
		expect(isTestRunnerTool("read", "")).toBe(false);
	});
});
