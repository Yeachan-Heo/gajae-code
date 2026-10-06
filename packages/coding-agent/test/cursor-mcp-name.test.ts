import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@gajae-code/agent-core";
import { CursorExecHandlers } from "../src/cursor";
import { cursorMcpDispatchName } from "../src/cursor-mcp-name";

function fakeTool(name: string, calls: string[]): AgentTool {
	return {
		name,
		execute: async () => {
			calls.push(name);
			return { content: [{ type: "text", text: `${name} ran` }], details: {} };
		},
	} as unknown as AgentTool;
}

describe("cursorMcpDispatchName", () => {
	it("allows advertised session tools and refuses dedicated-channel names", () => {
		expect(cursorMcpDispatchName({ toolName: "eval" })).toBe("eval");
		expect(cursorMcpDispatchName({ toolName: "mcp__server_read" })).toBe("mcp__server_read");
		expect(cursorMcpDispatchName({ name: "edit" })).toBe("edit");
		expect(cursorMcpDispatchName({ toolName: "bash", name: "eval" })).toBeNull();
		expect(cursorMcpDispatchName({ toolName: "write" })).toBeNull();
		expect(cursorMcpDispatchName({ name: "delete" })).toBeNull();
		expect(cursorMcpDispatchName({ toolName: "todo_write" })).toBeNull();
		expect(cursorMcpDispatchName({})).toBeNull();
	});
});

describe("CursorExecHandlers.mcp", () => {
	it("runs eval from the MCP channel and does not run bash", async () => {
		const calls: string[] = [];
		const handlers = new CursorExecHandlers({
			cwd: "/tmp",
			tools: new Map<string, AgentTool>([
				["eval", fakeTool("eval", calls)],
				["bash", fakeTool("bash", calls)],
			]),
		});
		const ran = await handlers.mcp({
			name: "eval",
			providerIdentifier: "pi-agent",
			toolName: "eval",
			toolCallId: "call-eval",
			args: {},
			rawArgs: {},
		});
		expect(ran.isError).toBe(false);
		expect(ran.toolName).toBe("eval");
		expect(calls).toEqual(["eval"]);

		const refused = await handlers.mcp({
			name: "bash",
			providerIdentifier: "pi-agent",
			toolName: "bash",
			toolCallId: "call-bash",
			args: {},
			rawArgs: {},
		});
		expect(refused.isError).toBe(true);
		expect(calls).toEqual(["eval"]);
	});
});
