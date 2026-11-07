import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";
import {
	disposeAllVmContexts,
	disposeVmContextsByOwner,
	executeInVmContext,
	resetVmContext,
} from "../../src/eval/js/context-manager";
import { executeJs, type JsResult } from "../../src/eval/js/executor";
import * as runtimeModule from "../../src/eval/js/shared/runtime";
import { WorkerCore } from "../../src/eval/js/worker-core";
import type { WorkerInbound } from "../../src/eval/js/worker-protocol";

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

	it("retains abort-ignoring host calls across logical rejection and concurrent owner disposal", async () => {
		const owner = `retirement:${crypto.randomUUID()}`;
		const otherOwner = `other:${crypto.randomUUID()}`;
		const entered = Promise.withResolvers<AbortSignal | undefined>();
		const release = Promise.withResolvers<AgentToolResult>();
		const controller = new AbortController();
		const toolSession: ToolSession = {
			...session,
			getToolByName: name =>
				name === "read"
					? createTool("read", async (_id, _args, signal) => {
							entered.resolve(signal);
							return await release.promise;
						})
					: undefined,
		};
		const run = executeInVmContext({
			sessionKey: owner,
			ownerId: owner,
			sessionId: owner,
			cwd: session.cwd,
			session: toolSession,
			code: "await tool.read({ path: 'held' });",
			filename: "held.js",
			runState: { signal: controller.signal },
		});
		const rejected = run.catch((error: unknown) => error);
		const signal = await entered.promise;
		controller.abort(new Error("cancel held run"));
		expect(await rejected).toMatchObject({ message: "cancel held run" });
		expect(signal?.aborted).toBe(true);
		let completed = 0;
		const first = disposeVmContextsByOwner(owner).then(() => {
			completed++;
		});
		const second = disposeVmContextsByOwner(owner).then(() => {
			completed++;
		});
		try {
			await executeInVmContext({
				sessionKey: otherOwner,
				ownerId: otherOwner,
				sessionId: otherOwner,
				cwd: session.cwd,
				session,
				code: "1 + 1",
				filename: "other.js",
				runState: {},
			});
			await disposeVmContextsByOwner(otherOwner);
			expect(completed).toBe(0);
		} finally {
			release.resolve({ content: [{ type: "text", text: "finished" }] });
			await Promise.all([first, second]);
		}
		expect(completed).toBe(2);
	});

	it("adopts late worker construction after owner disposal without initializing the retired generation", async () => {
		const owner = `late:${crypto.randomUUID()}`;
		const terminate = vi.spyOn(Worker.prototype, "terminate");
		const run = executeInVmContext({
			sessionKey: owner,
			ownerId: owner,
			sessionId: owner,
			cwd: session.cwd,
			session,
			code: "throw new Error('must not run')",
			filename: "late.js",
			runState: {},
		});
		const rejected = run.catch((error: unknown) => error);
		// Allocation is queued, but its exact session is already owned and discoverable.
		await expect(disposeVmContextsByOwner(owner, { requireProvenShutdown: true })).rejects.toThrow("unproven");
		expect(await rejected).toMatchObject({ message: "JS context replaced during initialization" });
		expect(terminate).toHaveBeenCalledTimes(1);
		await expect(disposeVmContextsByOwner(owner, { requireProvenShutdown: true })).rejects.toThrow("unproven");
		expect(terminate).toHaveBeenCalledTimes(1);
		await disposeVmContextsByOwner(owner);
	});

	it("surfaces transport startup failure and retains the allocated worker's strict uncertainty", async () => {
		const owner = `startup-failure:${crypto.randomUUID()}`;
		vi.spyOn(Worker.prototype, "postMessage").mockImplementationOnce(() => {
			throw new Error("controlled transport setup failure");
		});
		await expect(
			executeInVmContext({
				sessionKey: owner,
				ownerId: owner,
				sessionId: owner,
				cwd: session.cwd,
				session,
				code: "1",
				filename: "startup-failure.js",
				runState: {},
			}),
		).rejects.toThrow("controlled transport setup failure");
		await expect(disposeVmContextsByOwner(owner, { requireProvenShutdown: true })).rejects.toThrow("unproven");
		await expect(disposeVmContextsByOwner(owner, { requireProvenShutdown: true })).rejects.toThrow("unproven");
		await disposeVmContextsByOwner(owner);
	});

	it("preserves strict shutdown uncertainty across reset and replacement generations", async () => {
		const owner = `generations:${crypto.randomUUID()}`;
		const options = {
			sessionKey: owner,
			ownerId: owner,
			sessionId: owner,
			cwd: session.cwd,
			session,
			code: "1",
			filename: "generation.js",
			runState: {},
		};
		await executeInVmContext(options);
		await resetVmContext(owner);
		await expect(disposeVmContextsByOwner(owner, { requireProvenShutdown: true })).rejects.toThrow("unproven");
		await executeInVmContext(options);
		await resetVmContext(owner);
		try {
			await disposeVmContextsByOwner(owner, { requireProvenShutdown: true });
			throw new Error("Strict cleanup incorrectly certified native shutdown");
		} catch (error) {
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors).toHaveLength(2);
		}
		await disposeVmContextsByOwner(owner);
		await disposeAllVmContexts();
		await expect(disposeVmContextsByOwner(owner, { requireProvenShutdown: true })).rejects.toThrow("unproven");
	});

	it("upgrades concurrent nonstrict disposal before abort-ignoring host work settles", async () => {
		const owner = `sticky:${crypto.randomUUID()}`;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<AgentToolResult>();
		const toolSession: ToolSession = {
			...session,
			getToolByName: name =>
				name === "read"
					? createTool("read", async () => {
							entered.resolve();
							return await release.promise;
						})
					: undefined,
		};
		const run = executeInVmContext({
			sessionKey: owner,
			ownerId: owner,
			sessionId: owner,
			cwd: session.cwd,
			session: toolSession,
			code: "await tool.read({ path: 'held' });",
			filename: "sticky.js",
			runState: {},
		});
		const rejected = run.catch((error: unknown) => error);
		await entered.promise;
		let settled = 0;
		const normal = disposeVmContextsByOwner(owner).finally(() => {
			settled++;
		});
		const strict = disposeVmContextsByOwner(owner, { requireProvenShutdown: true }).finally(() => {
			settled++;
		});
		const strictRejected = strict.catch((error: unknown) => error);
		expect(await rejected).toMatchObject({ message: "JS context disposed" });
		expect(settled).toBe(0);
		release.resolve({ content: [{ type: "text", text: "finished" }] });
		await normal;
		expect(await strictRejected).toMatchObject({ message: "JS context cleanup failed or shutdown is unproven" });
		expect(settled).toBe(2);
		await disposeVmContextsByOwner(owner);
		await disposeAllVmContexts();
		await expect(disposeVmContextsByOwner(owner, { requireProvenShutdown: true })).rejects.toThrow("unproven");
	});

	it("attempts transport close after closed notification fails and retains both failures", async () => {
		const sendFailure = new Error("closed notification failed");
		const closeFailure = new Error("transport close failed");
		const close = vi.fn(() => {
			throw closeFailure;
		});
		const core = new WorkerCore({
			onMessage: () => () => {},
			send: message => {
				if (message.type === "closed") throw sendFailure;
			},
			close,
		});
		const cleanup = core.dispose();
		await expect(cleanup).rejects.toThrow("retirement failed");
		expect(close).toHaveBeenCalledTimes(1);
		expect(core.dispose()).toBe(cleanup);
		try {
			await core.dispose();
			throw new Error("Cleanup failures were forgotten");
		} catch (error) {
			expect((error as AggregateError).errors).toEqual([sendFailure, closeFailure]);
		}
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("retains inline retirement failures across repeated disposal", async () => {
		const failure = new Error("controlled unsubscribe failure");
		const close = vi.fn();
		const core = new WorkerCore({
			onMessage: () => () => {
				throw failure;
			},
			send: () => {},
			close,
		});
		const cleanup = core.dispose();
		await expect(cleanup).rejects.toThrow("retirement failed");
		expect(core.dispose()).toBe(cleanup);
		try {
			await core.dispose();
			throw new Error("Cleanup failure was forgotten");
		} catch (error) {
			expect((error as AggregateError).errors).toEqual([failure]);
		}
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("joins inline evaluation after close instead of treating listener removal as completion", async () => {
		let receive: ((message: WorkerInbound) => void) | undefined;
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(
			runtimeModule as unknown as { JsRuntime: () => runtimeModule.JsRuntime },
			"JsRuntime",
		).mockImplementation(
			() =>
				({
					setCwd() {},
					async run() {
						started.resolve();
						await release.promise;
					},
					displayValue() {},
				}) as unknown as runtimeModule.JsRuntime,
		);
		const closed = vi.fn();
		const core = new WorkerCore({
			onMessage: handler => {
				receive = handler;
				return () => {
					receive = undefined;
				};
			},
			send: () => {},
			close: closed,
		});
		receive?.({
			type: "run",
			runId: "inline-held",
			code: "held evaluation",
			filename: "inline-held.js",
			snapshot: { cwd: session.cwd, sessionId: "inline-held" },
		});
		await started.promise;
		const cleanup = core.dispose();
		expect(core.dispose()).toBe(cleanup);
		expect(closed).not.toHaveBeenCalled();
		release.resolve();
		await cleanup;
		expect(closed).toHaveBeenCalledTimes(1);
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

	it("does not auto-display side-effect import rewrites", async () => {
		const result = await executeJs('import "node:path";', { sessionId, session, sessionFile });

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("");
		expect(result.displayOutputs).toEqual([]);
	});

	it("exposes the worker's real process object", async () => {
		const result = await executeJs(
			[
				"return {",
				"  version: process.version,",
				"  versionsNode: typeof process.versions.node,",
				"  platform: process.platform,",
				"  arch: process.arch,",
				"  hasEnv: 'env' in process,",
				"  hasExit: 'exit' in process,",
				"};",
			].join("\n"),
			{ sessionId, session, sessionFile },
		);

		expect(result.exitCode).toBe(0);
		expect(getJsonData(result)).toEqual({
			version: process.version,
			versionsNode: "string",
			platform: process.platform,
			arch: process.arch,
			hasEnv: true,
			hasExit: true,
		});
	});

	it("exposes common web globals and the raw Node fs module", async () => {
		const result = await executeJs(
			[
				"const uuid = crypto.randomUUID();",
				"const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('ok'));",
				"const base = __gjc_session__.cwd;",
				"fs.mkdirSync(base + '/nested', { recursive: true });",
				"fs.writeFileSync(base + '/nested/value.txt', 'hello');",
				"await fs.promises.copyFile(base + '/nested/value.txt', base + '/nested/copy.txt');",
				"const text = fs.readFileSync(base + '/nested/copy.txt', 'utf8');",
				"const bytes = await fs.promises.readFile(base + '/nested/copy.txt');",
				"const stat = fs.statSync(base + '/nested/copy.txt');",
				"const entries = fs.readdirSync(base + '/nested');",
				"const start = performance.now();",
				"return {",
				"  uuid: typeof uuid,",
				"  digestBytes: digest.byteLength,",
				"  text,",
				"  byteLength: bytes.byteLength,",
				"  isFile: stat.isFile(),",
				"  entries: entries.sort(),",
				"  hasConstants: typeof fs.constants.R_OK,",
				"  buffer: Buffer.from('ok').toString('hex'),",
				"  performance: typeof start,",
				"};",
			].join("\n"),
			{ sessionId, session, sessionFile },
		);

		expect(result.exitCode).toBe(0);
		expect(getJsonData(result)).toEqual({
			uuid: "string",
			digestBytes: 32,
			text: "hello",
			byteLength: 5,
			isFile: true,
			entries: ["copy.txt", "value.txt"],
			hasConstants: "number",
			buffer: "6f6b",
			performance: "number",
		});
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
				session,
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

	it("rejects protocol paths and directory reads from native read()", async () => {
		const protocolResult = await executeJs("await read('agent://demo');", {
			sessionId,
			session,
			sessionFile,
		});
		expect(protocolResult.exitCode).toBe(1);
		expect(protocolResult.output).toContain("Protocol paths are not supported");

		const directoryResult = await executeJs("await read('.');", {
			sessionId,
			session,
			sessionFile,
		});
		expect(directoryResult.exitCode).toBe(1);
		expect(directoryResult.output).toContain("Directory paths are not supported");
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
			session,
			sessionFile,
		});

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe('{\n  "name": "demo",\n  "enabled": true\n}');
	});

	it("awaits identifier promise final expressions before displaying", async () => {
		const result = await executeJs("const pending = read('config.json'); pending;", {
			sessionId,
			session,
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

	it('rewrites static `import { x } from "pkg"` to dynamic import', async () => {
		const result = await executeJs('import { join } from "node:path";\nreturn join("a", "b");', {
			sessionId,
			session,
			sessionFile,
		});
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe(path.join("a", "b"));
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
	it("falls back to text display when the final expression value is not structured-cloneable", async () => {
		const result = await executeJs("({ fn: () => 1 });", { sessionId, session, sessionFile });
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("[object Object]");
		// No JSON display because structuredClone fails on the embedded function.
		expect(result.displayOutputs.filter(o => o.type === "json")).toHaveLength(0);
	});

	it("cancels execution when the timeout expires", async () => {
		const result = await executeJs("await new Promise(() => {})", {
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
