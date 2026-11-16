import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent, type AgentTool, type AgentToolResult } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import type { ClientBridge } from "@gajae-code/coding-agent/session/client-bridge";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { TempDir } from "@gajae-code/utils";
import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import * as z from "zod/v4";
import { disposeAllVmContexts, executeInVmContext, liveVmContextCount } from "../../src/eval/js/context-manager";
import { executeJs, type JsResult } from "../../src/eval/js/executor";
import { QuickJsCellRuntime } from "../../src/eval/js/quickjs/runtime";
import type { RuntimeHooks } from "../../src/eval/js/shared/runtime";
import type { JsDisplayOutput } from "../../src/eval/js/worker-protocol";
import { evalToolDescriptionForSession } from "../../src/tools/session-descriptions";

type ToolCall = { name: string; args: unknown };

function recordingTool(name: string, calls: ToolCall[], reply?: (args: unknown) => AgentToolResult): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: z.object({}),
		concurrency: "parallel",
		async execute(_toolCallId: string, args: unknown): Promise<AgentToolResult> {
			calls.push({ name, args });
			return reply?.(args) ?? { content: [{ type: "text", text: `${name} ok` }] };
		},
	} as unknown as AgentTool;
}

/** Prelude globals the sandbox adds on top of QuickJS intrinsics. Anything else is a leak. */
const SANDBOX_GLOBALS = [
	"__gjc_import__",
	"__gjc_set_final_expr__",
	"append",
	"console",
	"counter",
	"diff",
	"display",
	"env",
	"output",
	"print",
	"read",
	"sleep",
	"sort",
	"tool",
	"tree",
	"uniq",
	"write",
];

function json(result: JsResult): unknown {
	const outputs = result.displayOutputs.filter(
		(output): output is Extract<JsDisplayOutput, { type: "json" }> => output.type === "json",
	);
	expect(outputs).toHaveLength(1);
	return outputs[0].data;
}

describe("eval js quickjs sandbox", () => {
	let tempDir: TempDir;
	let calls: ToolCall[];
	let sessionKey: string;

	const settings = Settings.isolated({ "eval.jsRuntime": "quickjs" });
	const tools = new Map<string, AgentTool>();
	const makeSession = (): ToolSession => ({
		cwd: tempDir.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
		getToolByName: name => tools.get(name),
	});
	const run = (code: string, timeoutMs = 10_000): Promise<JsResult> =>
		executeJs(code, { sessionId: sessionKey, session: makeSession(), timeoutMs });

	beforeAll(() => {
		tempDir = TempDir.createSync("@js-quickjs-sandbox-");
	});

	afterEach(async () => {
		await disposeAllVmContexts();
		tools.clear();
		delete (Object.prototype as Record<string, unknown>).polluted;
	});

	afterAll(() => {
		tempDir.removeSync();
	});

	const fresh = (): void => {
		calls = [];
		sessionKey = `quickjs-${crypto.randomUUID()}`;
		tools.set("read", recordingTool("read", calls));
	};

	describe("escape attempts fail closed", () => {
		it("exposes no host capability globals", async () => {
			fresh();
			const result = await run(
				[
					"const names = ['fetch', 'Bun', 'require', 'process', 'module', 'global', 'Deno', 'WebAssembly',",
					"  'XMLHttpRequest', 'WebSocket', 'setTimeout', 'setInterval', 'queueMicrotask', 'Buffer',",
					"  '__gjc_helpers__', '__gjc_call_tool__', '__gjc_log__', '__gjc_display__', 'fs', 'createRequire'];",
					"return Object.fromEntries(names.map(name => [name, typeof globalThis[name]]));",
				].join("\n"),
			);
			expect(result.exitCode).toBe(0);
			const types = json(result) as Record<string, string>;
			expect(Object.entries(types).filter(([, type]) => type !== "undefined")).toEqual([]);
		});

		it("adds only the documented prelude globals to the QuickJS intrinsics", async () => {
			fresh();
			const module = await newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
			const bare = module.newContext();
			const names = bare.unwrapResult(bare.evalCode("Object.getOwnPropertyNames(globalThis)"));
			const intrinsics = bare.dump(names) as string[];
			names.dispose();
			bare.dispose();

			const result = await run("return Object.getOwnPropertyNames(globalThis);");
			expect(result.exitCode).toBe(0);
			const added = (json(result) as string[]).filter(name => !intrinsics.includes(name)).sort();
			expect(added).toEqual(SANDBOX_GLOBALS);
		});

		it("rejects static imports, rewritten dynamic imports, and native import()", async () => {
			fresh();
			const staticImport = await run("import fs from 'node:fs';\nfs.readFileSync('/etc/hostname', 'utf8');");
			expect(staticImport.exitCode).toBe(1);
			expect(staticImport.output).toContain('import of "node:fs" is not available in the QuickJS sandbox');

			const dynamicImport = await run("await import('node:child_process');");
			expect(dynamicImport.exitCode).toBe(1);
			expect(dynamicImport.output).toContain('import of "node:child_process" is not available');

			// Built through eval so the host-side import rewriter never sees it: QuickJS has no
			// module loader, so the native import() rejects.
			for (const code of [
				"await (0, eval)(\"import('node:fs')\");",
				"await Function(\"return import('node:fs')\")();",
			]) {
				const nativeImport = await run(code);
				expect(nativeImport.exitCode).toBe(1);
				expect(nativeImport.output).toMatch(/could not load module|no function filename for import\(\)/);
			}
			expect(calls).toEqual([]);
		});

		it("constructor chains only reach the guest realm", async () => {
			fresh();
			const result = await run(
				[
					"const viaTool = tool.read.constructor.constructor('return this')();",
					"const viaConsole = console.log.constructor.constructor('return this')();",
					"const viaSleep = sleep.constructor('return this')();",
					"const viaFinal = __gjc_set_final_expr__.constructor('return this')();",
					"const viaAsync = (async () => {}).constructor('return globalThis')();",
					"const probe = g => [typeof g.process, typeof g.Bun, typeof g.require, typeof g.fetch].join(',');",
					"return {",
					"  sameRealm: [viaTool, viaConsole, viaSleep, viaFinal].every(g => g === globalThis),",
					"  viaTool: probe(viaTool),",
					"  viaAsync: probe(await viaAsync),",
					"  functionReturn: typeof Function('try { return process } catch { return undefined }')(),",
					"};",
				].join("\n"),
			);
			expect(result.exitCode).toBe(0);
			expect(json(result)).toEqual({
				sameRealm: true,
				viaTool: "undefined,undefined,undefined,undefined",
				viaAsync: "undefined,undefined,undefined,undefined",
				functionReturn: "undefined",
			});
		});

		it("guest tampering with JSON, prototypes, and bridge globals cannot redirect tool calls or reach the host", async () => {
			fresh();
			const result = await run(
				[
					"const realTool = tool;",
					'JSON.stringify = () => \'{"path":"/etc/shadow"}\';',
					"JSON.parse = () => ({ forged: true });",
					"Object.prototype.polluted = 'guest';",
					"Array.prototype.map = () => { throw new Error('hijacked map'); };",
					"globalThis.__gjc_set_final_expr__ = () => { throw new Error('hijacked final'); };",
					"const replaced = Object.getOwnPropertyDescriptor(globalThis, '__gjc_set_final_expr__');",
					"const value = await realTool.read({ path: 'safe.txt' });",
					"({ value, writable: replaced.writable, configurable: replaced.configurable });",
				].join("\n"),
			);
			expect(result.exitCode).toBe(0);
			expect(calls).toEqual([{ name: "read", args: { path: "safe.txt", _i: "js prelude" } }]);
			expect(json(result)).toEqual({ value: "read ok", writable: false, configurable: false });
			expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		});

		it("__proto__ keys in tool arguments stay own data and never pollute the host", async () => {
			fresh();
			const result = await run(
				`await tool.read(JSON.parse('{"path":"x","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}'));`,
			);
			expect(result.exitCode).toBe(0);
			expect(({} as Record<string, unknown>).polluted).toBeUndefined();
			const args = calls[0]?.args as Record<string, unknown>;
			expect(Object.hasOwn(args, "__proto__")).toBe(true);
			expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
		});

		it("host error stacks do not cross into the guest", async () => {
			fresh();
			tools.set("bash", {
				...recordingTool("bash", calls),
				async execute(): Promise<AgentToolResult> {
					throw new Error("host failure");
				},
			} as unknown as AgentTool);
			const result = await run(
				"let caught;\ntry { await tool.bash({ command: 'true' }); } catch (e) { caught = { message: e.message, stack: '' + e.stack }; }\ncaught;",
			);
			expect(result.output).toBe("");
			expect(result.exitCode).toBe(0);
			const caught = json(result) as { message: string; stack: string };
			expect(caught.message).toBe("host failure");
			expect(caught.stack).not.toContain(import.meta.dir);
			expect(caught.stack).not.toContain("context-manager");
		});
	});

	describe("tool bridge", () => {
		it("routes tool.* through the session tool, emits status, and supports output()", async () => {
			fresh();
			tools.set(
				"read",
				recordingTool("read", calls, args => ({
					content: [{ type: "text", text: `body of ${(args as { path: string }).path}` }],
					details: { kind: "file" },
				})),
			);
			const result = await run(
				"return { direct: await tool.read({ path: 'a.txt' }), agent: await output('agent-7') };",
			);
			expect(result.exitCode).toBe(0);
			expect(calls.map(call => call.args)).toEqual([
				{ path: "a.txt", _i: "js prelude" },
				{ path: "agent://agent-7", _i: "js prelude" },
			]);
			expect(json(result)).toEqual({
				direct: { text: "body of a.txt", details: { kind: "file" } },
				agent: { text: "body of agent://agent-7", details: { kind: "file" } },
			});
			expect(result.displayOutputs.filter(output => output.type === "status")).toHaveLength(2);
		});

		it("respects session permission denial and allowance for tool.* calls", async () => {
			const tempSessionDir = TempDir.createSync("@js-quickjs-permission-");
			const requested: string[] = [];
			let decision: "allow_once" | "reject_once" = "reject_once";
			const bridge: ClientBridge = {
				capabilities: { requestPermission: true },
				async requestPermission(toolCall) {
					requested.push(toolCall.toolName);
					return { outcome: "selected", optionId: decision, kind: decision };
				},
			};
			const bashCalls: ToolCall[] = [];
			const bashTool = recordingTool("bash", bashCalls);
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
			const agentSession = new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: { model, systemPrompt: ["Test"], tools: [bashTool], messages: [] },
					convertToLlm,
					streamFn: () => new AssistantMessageEventStream(),
				}),
				sessionManager: SessionManager.inMemory(tempSessionDir.path()),
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: {
					withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
				} as never,
				toolRegistry: new Map([["bash", bashTool]]),
			});
			agentSession.setSdkPermissionMode("prompt");
			agentSession.setClientBridge(bridge);
			const toolSession: ToolSession = {
				cwd: tempSessionDir.path(),
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => null,
				settings,
				getToolByName: name => agentSession.getToolByName(name),
				getToolForExecution: name => agentSession.getToolForExecution(name),
			};
			const key = `quickjs-permission-${crypto.randomUUID()}`;
			try {
				const denied = await executeJs(
					"let verdict = 'ran';\ntry { await tool.bash({ command: 'echo pwned' }); } catch (e) { verdict = 'denied: ' + e.message; }\nverdict;",
					{ sessionId: key, session: toolSession, timeoutMs: 10_000 },
				);
				expect(denied.exitCode).toBe(0);
				expect(denied.output).toMatch(/^denied: [\s\S]*reject/i);
				expect(bashCalls).toEqual([]);

				decision = "allow_once";
				const allowed = await executeJs("await tool.bash({ command: 'echo ok' });", {
					sessionId: key,
					session: toolSession,
					timeoutMs: 10_000,
				});
				expect(allowed.exitCode).toBe(0);
				expect(allowed.output.trim()).toBe("bash ok");
				expect(bashCalls).toHaveLength(1);
				expect(requested).toEqual(["bash", "bash"]);
			} finally {
				await agentSession.dispose();
				tempSessionDir.removeSync();
			}
		});
	});

	describe("limits", () => {
		it("stops a synchronous infinite loop at the wall-time limit and keeps the context", async () => {
			fresh();
			await run("const survivor = 'kept';");
			const started = Date.now();
			const looped = await run("while (true) {}", 300);
			expect(looped.cancelled).toBe(true);
			expect(looped.output).toContain("Command timed out");
			// Stopped by the in-worker interrupt handler, well before the host backstop would kill it.
			expect(Date.now() - started).toBeLessThan(1_800);

			const after = await run("survivor;");
			expect(after.exitCode).toBe(0);
			expect(after.output.trim()).toBe("kept");
			expect(liveVmContextCount()).toBe(1);
		});

		it("stops runaway microtask chains and long sleeps at the wall-time limit", async () => {
			fresh();
			const jobs = await run("for (;;) await null;", 300);
			expect(jobs.cancelled).toBe(true);
			const started = Date.now();
			const slept = await run("await sleep(60_000);", 300);
			expect(slept.cancelled).toBe(true);
			expect(Date.now() - started).toBeLessThan(1_800);
			const after = await run("1 + 1");
			expect(after.output.trim()).toBe("2");
		});

		it("stops runaway allocation at the memory limit and keeps the context", async () => {
			fresh();
			await run("const survivor = 'kept';");
			const grown = await run("(() => { const chunks = []; for (;;) chunks.push(new Array(100_000).fill(1)); })()");
			expect(grown.exitCode).toBe(1);
			expect(grown.output).toContain("out of memory");
			const huge = await run("new ArrayBuffer(2 ** 30)");
			expect(huge.exitCode).toBe(1);

			const after = await run("survivor;");
			expect(after.exitCode).toBe(0);
			expect(after.output.trim()).toBe("kept");
			expect(liveVmContextCount()).toBe(1);
		});

		it("turns unbounded recursion into a guest error", async () => {
			fresh();
			const result = await run("(function f() { return f() + 1; })()");
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("InternalError: stack overflow");
			expect((await run("'alive'")).output.trim()).toBe("alive");
		});

		it("fails a cell awaiting a promise nothing can settle instead of hanging", async () => {
			fresh();
			const result = await run("await new Promise(() => {});");
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("can never settle");
		});
	});

	describe("prelude parity", () => {
		it("keeps cell bindings, final expressions, TypeScript stripping, and console formatting", async () => {
			fresh();
			await run("const base: number = 40;\ninterface Box { n: number }");
			const result = await run(
				"console.log('row', { a: 1, list: [1, 'two'], nested: { deep: true } }, new Map([['k', 2]]));\nbase + 2;",
			);
			expect(result.exitCode).toBe(0);
			expect(result.output).toBe(
				"row { a: 1, list: [ 1, 'two' ], nested: { deep: true } } Map(1) { 'k' => 2 }\n42\n",
			);
		});

		it("runs the pure text helpers with the same results and status events as the Bun prelude", async () => {
			const code = [
				"return {",
				"  sorted: sort('b\\na\\nc\\na', { unique: true }),",
				"  uniq: uniq('a\\na\\nb', { count: true }),",
				"  counted: counter(['x', 'y', 'x']),",
				"};",
			].join("\n");
			fresh();
			const quickjs = await run(code);
			const bun = await executeJs(code, {
				sessionId: `bun-${crypto.randomUUID()}`,
				session: { ...makeSession(), settings: Settings.isolated() },
				timeoutMs: 10_000,
			});
			expect(quickjs.exitCode).toBe(0);
			expect(bun.exitCode).toBe(0);
			expect(quickjs.displayOutputs).toEqual(bun.displayOutputs);
			expect(json(quickjs)).toEqual({
				sorted: "a\nb\nc",
				uniq: [
					[2, "a"],
					[1, "b"],
				],
				counted: [
					[2, "x"],
					[1, "y"],
				],
			});
		});

		it("renders display() values and images like the Bun runtime", async () => {
			fresh();
			const result = await run(
				[
					"display({ type: 'image', mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) });",
					"display({ answer: 42 });",
					"display('plain');",
				].join("\n"),
			);
			expect(result.exitCode).toBe(0);
			expect(result.displayOutputs).toEqual([
				{ type: "image", mimeType: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") },
				{ type: "json", data: { answer: 42 } },
			]);
			expect(result.output).toBe("plain\n");
		});

		it("host-access helpers are absent with an error naming the tool.* replacement", async () => {
			fresh();
			for (const [call, hint] of [
				["read('package.json')", "tool.read"],
				["write('x.txt', 'y')", "tool.write"],
				["env('HOME')", "no process environment"],
			] as const) {
				const result = await run(call);
				expect(result.exitCode).toBe(1);
				expect(result.output).toContain("is not available in the QuickJS sandbox");
				expect(result.output).toContain(hint);
			}
			expect(calls).toEqual([]);
		});
	});

	describe("runtime selection and disposal", () => {
		it("tells the model about the sandbox only when quickjs is selected", () => {
			const sandboxed = evalToolDescriptionForSession({ settings });
			expect(sandboxed).toContain("cells run in a QuickJS sandbox");
			expect(sandboxed).not.toContain("and the `Bun` global");
			const bun = evalToolDescriptionForSession({ settings: Settings.isolated() });
			expect(bun).toContain("and the `Bun` global");
			expect(bun).not.toContain("QuickJS");
		});

		it("replaces a Bun context when the session switches to QuickJS", async () => {
			const key = `switch-${crypto.randomUUID()}`;
			const base = { cwd: tempDir.path(), sessionId: key, sessionKey: key, filename: "cell.js" };
			const texts: string[] = [];
			const runState = { onText: (chunk: string) => texts.push(chunk) };
			const toolSession = { ...makeSession(), settings: Settings.isolated() };
			await executeInVmContext({
				...base,
				session: toolSession,
				runtime: "bun",
				code: "globalThis.fromBun = 1",
				runState,
			});
			await executeInVmContext({
				...base,
				session: toolSession,
				runtime: "quickjs",
				code: "[typeof fromBun, typeof Bun].join(',')",
				runState,
			});
			expect(texts).toEqual(["1\n", "undefined,undefined\n"]);
			expect(liveVmContextCount()).toBe(1);
		});

		it("disposes the runtime and context cleanly, including in-flight host promises", async () => {
			const texts: string[] = [];
			const toolCalled = Promise.withResolvers<void>();
			const hooks: RuntimeHooks = {
				onText: chunk => texts.push(chunk),
				onDisplay: () => {},
				callTool: () => {
					toolCalled.resolve();
					return Promise.withResolvers<unknown>().promise;
				},
			};
			const runtime = await QuickJsCellRuntime.create({ getHooks: () => hooks });
			await runtime.runCell("globalThis.kept = { nested: [1, 2] }; 'ran'", "a.js", undefined);
			const running = runtime.runCell("await tool.read({ path: 'never' });", "b.js", undefined);
			await toolCalled.promise;
			runtime.dispose();
			await expect(running).rejects.toThrow("QuickJS runtime is disposed");
			expect(runtime.alive).toBe(false);
			await expect(runtime.runCell("1", "c.js", undefined)).rejects.toThrow("QuickJS runtime is disposed");

			// Disposal freed everything (a leak aborts the shared wasm module), so a new runtime works.
			const next = await QuickJsCellRuntime.create({ getHooks: () => hooks });
			await next.runCell("typeof kept + ':' + 6 * 7", "d.js", undefined);
			expect(texts).toEqual(["ran\n", "undefined:42\n"]);
			next.dispose();
		});
	});
});
