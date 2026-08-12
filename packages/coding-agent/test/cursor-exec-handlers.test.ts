/**
 * Regression (#484): CursorExecHandlers native handlers must stay instance-safe
 * when invoked detached/unbound by the Cursor provider.
 *
 * The provider can destructure or rebind handler methods, e.g. `const read = handlers.read`,
 * and call them without the class instance. Before the constructor binding fix this threw:
 *   "undefined is not an object (evaluating 'this.#optionsForCall')"
 */
import { describe, expect, it } from "bun:test";
import { create } from "@bufbuild/protobuf";
import type { AgentEvent, AgentTool } from "@gajae-code/agent-core";
import { dispatchedToolIdentity } from "@gajae-code/agent-core";
import {
	DeleteArgsSchema,
	DiagnosticsArgsSchema,
	GrepArgsSchema,
	LsArgsSchema,
	ReadArgsSchema,
	ShellArgsSchema,
	WriteArgsSchema,
} from "@gajae-code/ai/providers/cursor/gen/agent_pb";
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
		const result = await read(create(ReadArgsSchema, { path: "/tmp/package.json", toolCallId: "c1" }));
		expect(result.role).toBe("toolResult");
		expect(result.isError).toBeFalsy();
		expect(result.toolName).toBe("read");
	});

	it("a representative set of handlers all work detached", async () => {
		const handlers = makeHandlers();
		const { read, ls, grep, shell, write, diagnostics } = handlers;

		const calls = [
			read(create(ReadArgsSchema, { path: "/tmp/a.txt", toolCallId: "r" })),
			ls(create(LsArgsSchema, { path: "/tmp", toolCallId: "l" })),
			grep(create(GrepArgsSchema, { pattern: "foo", path: "/tmp", toolCallId: "g" })),
			shell(create(ShellArgsSchema, { command: "echo hi", toolCallId: "s" })),
			write(create(WriteArgsSchema, { path: "/tmp/b.txt", fileText: "x", toolCallId: "w" })),
			diagnostics(create(DiagnosticsArgsSchema, { path: "/tmp/a.ts", toolCallId: "d" })),
		];

		const results = await Promise.all(calls);
		for (const result of results) {
			expect(result.role).toBe("toolResult");
			expect(result.isError).toBeFalsy();
		}
	});
});

describe("CursorExecHandlers grep empty pattern guard (#501)", () => {
	function makeRecordingHandlers(
		searchCalls: Array<Record<string, unknown>>,
		findCalls: Array<Record<string, unknown>> = [],
	): CursorExecHandlers {
		const searchTool = {
			name: "search",
			label: "search",
			execute: async (_toolCallId: string, args: Record<string, unknown>) => {
				searchCalls.push(args);
				return { content: [{ type: "text" as const, text: "ok" }], details: {} };
			},
		} as unknown as AgentTool;
		const findTool = {
			name: "find",
			label: "find",
			execute: async (_toolCallId: string, args: Record<string, unknown>) => {
				findCalls.push(args);
				return { content: [{ type: "text" as const, text: "ok" }], details: {} };
			},
		} as unknown as AgentTool;
		const tools = new Map<string, AgentTool>([
			["search", searchTool],
			["find", findTool],
		]);
		return new CursorExecHandlers({ cwd: process.cwd(), tools } as never);
	}

	it("empty pattern does not call search and returns an actionable error", async () => {
		const searchCalls: Array<Record<string, unknown>> = [];
		const handlers = makeRecordingHandlers(searchCalls);
		const result = await handlers.grep(create(GrepArgsSchema, { pattern: "", path: "/tmp", toolCallId: "g" }));
		expect(searchCalls.length).toBe(0);
		expect(result.role).toBe("toolResult");
		expect(result.isError).toBe(true);
		expect(result.toolName).toBe("search");
		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("must not be empty");
	});

	it("whitespace-only pattern does not call search and returns an actionable error", async () => {
		const searchCalls: Array<Record<string, unknown>> = [];
		const handlers = makeRecordingHandlers(searchCalls);
		const result = await handlers.grep(create(GrepArgsSchema, { pattern: "   ", path: "/tmp", toolCallId: "g" }));
		expect(searchCalls.length).toBe(0);
		expect(result.isError).toBe(true);
	});

	it("empty pattern with a glob is treated as native Glob and routes to find", async () => {
		const searchCalls: Array<Record<string, unknown>> = [];
		const findCalls: Array<Record<string, unknown>> = [];
		const handlers = makeRecordingHandlers(searchCalls, findCalls);
		const result = await handlers.grep(
			create(GrepArgsSchema, { pattern: "", path: "/tmp", glob: "**/*.ts", toolCallId: "g" }),
		);
		expect(searchCalls.length).toBe(0);
		expect(findCalls).toEqual([{ paths: ["/tmp/**/*.ts"] }]);
		expect(result.role).toBe("toolResult");
		expect(result.isError).toBeFalsy();
		expect(result.toolName).toBe("find");
	});

	it("non-empty pattern calls search with the same searchPath behavior", async () => {
		const searchCalls: Array<Record<string, unknown>> = [];
		const handlers = makeRecordingHandlers(searchCalls);
		const result = await handlers.grep(create(GrepArgsSchema, { pattern: "foo", path: "/tmp", toolCallId: "g" }));
		expect(searchCalls.length).toBe(1);
		expect(searchCalls[0]).toMatchObject({ pattern: "foo", paths: ["/tmp"] });
		expect(result.isError).toBeFalsy();
	});

	it("preserves glob/path behavior for non-empty patterns", async () => {
		const searchCalls: Array<Record<string, unknown>> = [];
		const handlers = makeRecordingHandlers(searchCalls);
		await handlers.grep(create(GrepArgsSchema, { pattern: "foo", path: "/tmp", glob: "*.ts", toolCallId: "g" }));
		expect(searchCalls[0]).toMatchObject({ paths: ["/tmp/*.ts"] });
	});
});

describe("CursorExecHandlers shell timeout unit conversion", () => {
	function makeShellRecordingHandlers(bashCalls: Array<Record<string, unknown>>): CursorExecHandlers {
		const bashTool = {
			name: "bash",
			label: "bash",
			execute: async (_toolCallId: string, args: Record<string, unknown>) => {
				bashCalls.push(args);
				return { content: [{ type: "text" as const, text: "ok" }], details: {} };
			},
		} as unknown as AgentTool;
		const tools = new Map<string, AgentTool>([["bash", bashTool]]);
		return new CursorExecHandlers({ cwd: process.cwd(), tools } as never);
	}

	it("converts wire milliseconds to bash seconds (block_until_ms: 30000 → 30s, not 30000s)", async () => {
		const bashCalls: Array<Record<string, unknown>> = [];
		const handlers = makeShellRecordingHandlers(bashCalls);
		await handlers.shell(create(ShellArgsSchema, { command: "echo hi", timeout: 30000, toolCallId: "s" }));
		expect(bashCalls[0]).toMatchObject({ command: "echo hi", timeout: 30 });
	});

	it("omits the timeout when unset or zero", async () => {
		const bashCalls: Array<Record<string, unknown>> = [];
		const handlers = makeShellRecordingHandlers(bashCalls);
		await handlers.shell(create(ShellArgsSchema, { command: "echo hi", toolCallId: "s" }));
		expect(bashCalls[0]?.timeout).toBeUndefined();
	});

	it("rounds sub-second timeouts up to 1s instead of dropping them", async () => {
		const bashCalls: Array<Record<string, unknown>> = [];
		const handlers = makeShellRecordingHandlers(bashCalls);
		await handlers.shell(create(ShellArgsSchema, { command: "echo hi", timeout: 500, toolCallId: "s" }));
		expect(bashCalls[0]).toMatchObject({ timeout: 1 });
	});
});

describe("CursorExecHandlers dispatched tool identity", () => {
	it("binds the exact tool object generic execution selected, not a same-named registry entry", async () => {
		const selected = makeTool("read");
		const impostor = makeTool("read");
		const tools = new Map<string, AgentTool>([["read", selected]]);
		const events: AgentEvent[] = [];
		const handlers = new CursorExecHandlers({
			cwd: process.cwd(),
			tools,
			emitEvent: (event: AgentEvent) => events.push(event),
		} as never);

		await handlers.read(create(ReadArgsSchema, { path: "/tmp/a.txt", toolCallId: "c1" }));

		const start = events.find(event => event.type === "tool_execution_start");
		expect(start).toBeDefined();
		expect(dispatchedToolIdentity(start as object)).toBe(selected);
		expect(dispatchedToolIdentity(start as object)).not.toBe(impostor);
	});

	it("leaves a synthetic operation that executes no AgentTool unbound", async () => {
		const events: AgentEvent[] = [];
		const handlers = new CursorExecHandlers({
			cwd: process.cwd(),
			tools: new Map<string, AgentTool>(),
			emitEvent: (event: AgentEvent) => events.push(event),
		} as never);

		await handlers.delete(
			create(DeleteArgsSchema, { path: "/tmp/gjc-cursor-identity-missing.txt", toolCallId: "d1" }),
		);

		const start = events.find(event => event.type === "tool_execution_start");
		expect(start).toBeDefined();
		expect(dispatchedToolIdentity(start as object)).toBeUndefined();
	});
});
