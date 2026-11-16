import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { ReadTool } from "@gajae-code/coding-agent/tools/read";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { executeJs, type JsResult } from "../../src/eval/js/executor";

function createTool(
	name: string,
	execute: (toolCallId: string, args: unknown, signal?: AbortSignal) => Promise<AgentToolResult>,
): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: z.object({}),
		concurrency: "parallel",
		execute,
	} as unknown as AgentTool;
}

function getJsonData(result: JsResult): unknown {
	const jsonOutputs = result.displayOutputs.filter(
		(output): output is Extract<JsResult["displayOutputs"][number], { type: "json" }> => output.type === "json",
	);
	expect(jsonOutputs).toHaveLength(1);
	return jsonOutputs[0].data;
}

function getStatusEvents(result: JsResult) {
	return result.displayOutputs.filter(
		(output): output is Extract<JsResult["displayOutputs"][number], { type: "status" }> => output.type === "status",
	);
}

describe("executeJs", () => {
	let tempDir: TempDir;
	let session: ToolSession;
	let sessionFile: string;
	let sessionId: string;
	let readSession: ToolSession;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@js-executor-");
		sessionFile = path.join(tempDir.path(), "session.jsonl");
		sessionId = `session:${sessionFile}:cwd:${tempDir.path()}`;
		session = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => sessionFile,
			getSessionSpawns: () => null,
			settings: Settings.isolated(),
		};
		const readTool = new ReadTool({ ...session });
		readSession = {
			...session,
			getToolByName: name => (name === "read" ? (readTool as unknown as AgentTool) : undefined),
		};

		await Bun.write(
			path.join(tempDir.path(), "config.json"),
			JSON.stringify({ name: "demo", enabled: true }, null, 2),
		);
		await Bun.write(path.join(tempDir.path(), "config.yaml"), "name: demo\nenabled: true\n");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await disposeAllVmContexts();
		tempDir.removeSync();
	});

	it("persists bindings across calls and reset clears them", async () => {
		await executeJs("const answer = 2;", { sessionId, session, sessionFile });

		const persisted = await executeJs("return answer + 2;", { sessionId, session, sessionFile });
		expect(persisted.exitCode).toBe(0);
		expect(persisted.output.trim()).toBe("4");

		const resetResult = await executeJs("return typeof answer;", {
			sessionId,
			session,
			sessionFile,
			reset: true,
		});
		expect(resetResult.exitCode).toBe(0);
		expect(resetResult.output.trim()).toBe("undefined");
	});

	it("persists bindings from cells that contain nested returns", async () => {
		const first = await executeJs(
			[
				"const nestedReturnCarry = { value: 11 };",
				"const readCarry = () => {",
				"  return nestedReturnCarry.value;",
				"};",
				"readCarry();",
			].join("\n"),
			{ sessionId, session, sessionFile },
		);
		expect(first.exitCode).toBe(0);
		expect(first.output.trim()).toBe("11");

		const persisted = await executeJs("return nestedReturnCarry.value + 1;", { sessionId, session, sessionFile });
		expect(persisted.exitCode).toBe(0);
		expect(persisted.output.trim()).toBe("12");
	});

	it("persists bindings from cells that need the async wrapper", async () => {
		const awaited = await executeJs(
			"const { value: awaitedCarry } = await Promise.resolve({ value: 6 }); awaitedCarry;",
			{
				sessionId,
				session,
				sessionFile,
			},
		);
		expect(awaited.exitCode).toBe(0);
		expect(awaited.output.trim()).toBe("6");

		const returned = await executeJs("const returnedCarry = 7; return returnedCarry;", {
			sessionId,
			session,
			sessionFile,
		});
		expect(returned.exitCode).toBe(0);
		expect(returned.output.trim()).toBe("7");

		const persisted = await executeJs("return awaitedCarry * returnedCarry;", { sessionId, session, sessionFile });
		expect(persisted.exitCode).toBe(0);
		expect(persisted.output.trim()).toBe("42");
	});

	it("persists bindings when auto-displaying the final expression", async () => {
		const first = await executeJs("const inspected = 40; inspected + 2;", { sessionId, session, sessionFile });
		expect(first.exitCode).toBe(0);
		expect(first.output.trim()).toBe("42");

		const persisted = await executeJs("return inspected + 1;", { sessionId, session, sessionFile });
		expect(persisted.exitCode).toBe(0);
		expect(persisted.output.trim()).toBe("41");
	});

	it("does not expose the final expression marker as a global property", async () => {
		const result = await executeJs("const localOnly = 7; localOnly;", { sessionId, session, sessionFile });
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("7");

		const marker = await executeJs("return Object.hasOwn(globalThis, '__gjc_final_expr__');", {
			sessionId,
			session,
			sessionFile,
		});
		expect(marker.exitCode).toBe(0);
		expect(marker.output.trim()).toBe("false");

		const persisted = await executeJs("return localOnly;", { sessionId, session, sessionFile });
		expect(persisted.exitCode).toBe(0);
		expect(persisted.output.trim()).toBe("7");
	});

	it("ignores user-assigned final expression markers without a rewritten final expression", async () => {
		const result = await executeJs("globalThis.__gjc_final_expr__ = 'manual'; return 'actual';", {
			sessionId,
			session,
			sessionFile,
		});

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("actual");
	});

	it("captures promise-valued final expression before promise callbacks can mutate the marker", async () => {
		const result = await executeJs(
			"const pending = Promise.resolve(1).then(value => { globalThis.__gjc_final_expr__ = 999; return value; }); pending;",
			{ sessionId, session, sessionFile },
		);

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("1");
	});

	it("awaits rewritten thenable final expressions once", async () => {
		const result = await executeJs(
			[
				"globalThis.thenCalls = 0;",
				"const thenable = {",
				"  then(resolve) {",
				"    globalThis.thenCalls++;",
				"    resolve('done');",
				"  },",
				"};",
				"thenable;",
			].join("\n"),
			{ sessionId, session, sessionFile },
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("done");

		const calls = await executeJs("return globalThis.thenCalls;", { sessionId, session, sessionFile });
		expect(calls.exitCode).toBe(0);
		expect(calls.output.trim()).toBe("1");
	});

	it("rejects side-effect imports without auto-displaying anything", async () => {
		const result = await executeJs('import "node:path";', { sessionId, session, sessionFile });

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('import of "node:path" is not available in the QuickJS sandbox');
		expect(result.displayOutputs).toEqual([]);
	});

	it("reads files as text and supports offset/limit slicing", async () => {
		const result = await executeJs(
			[
				"const full = await read('config.json');",
				"const sliced = await read('config.json', { offset: 2, limit: 1 });",
				"return { isString: typeof full === 'string', full, sliced };",
			].join("\n"),
			{
				sessionId,
				session: readSession,
				sessionFile,
			},
		);

		expect(result.exitCode).toBe(0);
		expect(getStatusEvents(result)).toHaveLength(2);
		expect(getJsonData(result)).toEqual({
			isString: true,
			full: '{\n  "name": "demo",\n  "enabled": true\n}',
			sliced: '  "name": "demo",',
		});
	});

	it("routes output() through tool.read and keeps tool.* results normalized", async () => {
		const execute = vi.fn(async (_toolCallId: string, args: unknown): Promise<AgentToolResult> => {
			const record = args as { path: string };
			if (record.path.startsWith("agent://")) {
				return { content: [{ type: "text", text: "from-agent" }] };
			}
			return {
				content: [{ type: "text", text: "annotated" }],
				details: { path: record.path, kind: "tool-result" },
			};
		});
		const toolSession: ToolSession = {
			...session,
			getToolByName: name => (name === "read" ? createTool("read", execute) : undefined),
		};

		const result = await executeJs(
			"return { toolResult: await tool.read({ path: 'package.json' }), agentOutput: await output('agent-42') };",
			{
				sessionId,
				session: toolSession,
				sessionFile,
			},
		);

		expect(result.exitCode).toBe(0);
		expect(getStatusEvents(result)).toHaveLength(2);
		expect(getJsonData(result)).toEqual({
			toolResult: {
				text: "annotated",
				details: { path: "package.json", kind: "tool-result" },
				images: undefined,
			},
			agentOutput: "from-agent",
		});
		expect(execute).toHaveBeenCalledTimes(2);
		expect(execute.mock.calls[0]?.[1]).toEqual({ path: "package.json", _i: "js prelude" });
		expect(execute.mock.calls[1]?.[1]).toEqual({ path: "agent://agent-42", _i: "js prelude" });
	});

	it("auto-displays the final awaited expression result", async () => {
		const execute = vi.fn(
			async (): Promise<AgentToolResult> => ({
				content: [{ type: "text", text: "tool output" }],
				details: { kind: "tool-result" },
			}),
		);
		const toolSession: ToolSession = {
			...session,
			getToolByName: name => (name === "read" ? createTool("read", execute) : undefined),
		};

		const result = await executeJs("await tool.read({ path: 'package.json' });", {
			sessionId,
			session: toolSession,
			sessionFile,
		});

		expect(result.exitCode).toBe(0);
		expect(getJsonData(result)).toEqual({
			text: "tool output",
			details: { kind: "tool-result" },
			images: undefined,
		});
	});

	it("awaits promise-valued final expressions before displaying", async () => {
		const result = await executeJs("read('config.json');", {
			sessionId,
			session: readSession,
			sessionFile,
		});

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe('{\n  "name": "demo",\n  "enabled": true\n}');
	});

	it("awaits identifier promise final expressions before displaying", async () => {
		const result = await executeJs("const pending = read('config.json'); pending;", {
			sessionId,
			session: readSession,
			sessionFile,
		});

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe('{\n  "name": "demo",\n  "enabled": true\n}');
	});

	it("auto-displays returned objects as structured output", async () => {
		const result = await executeJs("return { answer: 42, nested: { ok: true } };", {
			sessionId,
			session,
			sessionFile,
		});

		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("");
		expect(result.displayOutputs).toEqual([{ type: "json", data: { answer: 42, nested: { ok: true } } }]);
	});

	it("strips TypeScript syntax before executing user code", async () => {
		const result = await executeJs(
			[
				"interface Pair { a: number; b: number }",
				"const make = (a: number, b: number): Pair => ({ a, b });",
				"const p = make(3, 4) as Pair;",
				"return p.a + p.b;",
			].join("\n"),
			{ sessionId, session, sessionFile },
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("7");
	});
	it("falls back to text display when the final expression value cannot be serialized", async () => {
		const result = await executeJs("const cyclic = { name: 'loop' }; cyclic.self = cyclic; cyclic;", {
			sessionId,
			session,
			sessionFile,
		});
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("[object Object]");
		// No JSON display because the cyclic value cannot cross the JSON bridge.
		expect(result.displayOutputs.filter(o => o.type === "json")).toHaveLength(0);
	});

	it("cancels execution when the timeout expires", async () => {
		const result = await executeJs("await sleep(60_000)", {
			sessionId,
			session,
			sessionFile,
			timeoutMs: 20,
		});

		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(result.output).toContain("Command timed out");
	});
});
