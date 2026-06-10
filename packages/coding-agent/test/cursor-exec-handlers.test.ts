/**
 * Regression (#484): CursorExecHandlers native handlers must stay instance-safe
 * when invoked detached/unbound by the Cursor provider.
 *
 * The provider can destructure or rebind handler methods, e.g. `const read = handlers.read`,
 * and call them without the class instance. Before the constructor binding fix this threw:
 *   "undefined is not an object (evaluating 'this.#optionsForCall')"
 */
import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@gajae-code/agent";
import { CursorExecHandlers } from "../src/cursor";

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		execute: async (_toolCallId: string, args: Record<string, unknown>) => ({
			content: [{ type: "text" as const, text: `${name}:${JSON.stringify(args)}` }],
			details: {},
		}),
	} as unknown as AgentTool;
}

function makeHandlers(): CursorExecHandlers {
	const tools = new Map<string, AgentTool>([
		["read", makeTool("read")],
		["search", makeTool("search")],
		["bash", makeTool("bash")],
		["write", makeTool("write")],
		["lsp", makeTool("lsp")],
	]);
	return new CursorExecHandlers({ cwd: process.cwd(), tools } as never);
}

describe("CursorExecHandlers detached invocation (#484)", () => {
	it("read works when called detached without losing #optionsForCall", async () => {
		const handlers = makeHandlers();
		const read = handlers.read;
		const result = await read({ path: "/tmp/package.json", toolCallId: "c1" });
		expect(result.role).toBe("toolResult");
		expect(result.isError).toBeFalsy();
		expect(result.toolName).toBe("read");
	});

	it("a representative set of handlers all work detached", async () => {
		const handlers = makeHandlers();
		const { read, ls, grep, shell, write, diagnostics } = handlers;

		const calls = [
			read({ path: "/tmp/a.txt", toolCallId: "r" }),
			ls({ path: "/tmp", toolCallId: "l" }),
			grep({ pattern: "foo", path: "/tmp", toolCallId: "g" }),
			shell({ command: "echo hi", toolCallId: "s" }),
			write({ path: "/tmp/b.txt", fileText: "x", toolCallId: "w" }),
			diagnostics({ path: "/tmp/a.ts", toolCallId: "d" }),
		];

		const results = await Promise.all(calls);
		for (const result of results) {
			expect(result.role).toBe("toolResult");
			expect(result.isError).toBeFalsy();
		}
	});
});
