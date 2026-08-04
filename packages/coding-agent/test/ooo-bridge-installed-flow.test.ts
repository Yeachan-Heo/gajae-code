import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@gajae-code/agent-core";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { loadExtensions } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { InputController } from "../src/modes/controllers/input-controller";
import type { InteractiveModeContext } from "../src/modes/types";
import type { MCPServerConnection, MCPToolCallResult } from "../src/runtime-mcp";
import * as runtimeMcpModule from "../src/runtime-mcp";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

function result(text: string, meta: Record<string, unknown>): MCPToolCallResult {
	return {
		content: [{ type: "text", text }],
		_meta: meta,
	};
}

describe("installed ooo bridge flow", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.OUROBOROS_CLI;
		delete process.env.GJC_NO_TITLE;
	});

	it("renders the first question, correlates the next answer, and renders termination", async () => {
		process.env.OUROBOROS_CLI = "/opt/ouroboros/bin/ouroboros";
		const connection = { name: "ouroboros-ooo-bridge" } as MCPServerConnection;
		const connectSpy = vi.spyOn(runtimeMcpModule, "connectToServer").mockResolvedValue(connection);
		const callSpy = vi
			.spyOn(runtimeMcpModule, "callTool")
			.mockResolvedValueOnce(
				result("Session interview_e2e\n\nWhat platforms should the CLI support?", {
					session_id: "interview_e2e",
					phase: "start",
				}),
			)
			.mockResolvedValueOnce(
				result("Interview completed. Session ID: interview_e2e", {
					session_id: "interview_e2e",
					phase: "complete",
					completed: true,
				}),
			);
		const disconnectSpy = vi.spyOn(runtimeMcpModule, "disconnectServer").mockResolvedValue();
		const examplePath = path.resolve(import.meta.dirname, "../examples/extensions/ooo-bridge.ts");
		const loaded = await loadExtensions([examplePath], "/tmp/ooo-installed-flow");
		expect(loaded.errors).toEqual([]);
		expect(loaded.extensions).toHaveLength(1);
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			"/tmp/ooo-installed-flow",
			{} as never,
			{} as never,
		);
		const visibleMessages: AgentMessage[] = [];
		const editor = {} as InteractiveModeContext["editor"];
		const ctx = {
			session: {
				extensionRunner: runner,
				isStreaming: false,
				queuedMessageCount: 0,
			},
			pendingImages: [],
			hasActiveBtw: () => false,
			editor,
			addMessageToChat(message: AgentMessage) {
				visibleMessages.push(message);
				return [];
			},
			ui: { requestRender: vi.fn() },
		} as unknown as InteractiveModeContext;
		const controller = new InputController(ctx);
		const composer = { ownsComposer: false, editor };

		await controller.submitText("ooo interview Build a CLI", composer);
		expect(visibleMessages.at(-1)).toMatchObject({
			role: "custom",
			customType: "extension-input-result",
			content: "Session interview_e2e\n\nWhat platforms should the CLI support?",
			display: true,
		});

		await controller.submitText("Linux and macOS", composer);
		expect(visibleMessages.at(-1)).toMatchObject({
			role: "custom",
			customType: "extension-input-result",
			content: "Interview completed. Session ID: interview_e2e",
			display: true,
		});
		expect(callSpy.mock.calls.map(call => call[2])).toEqual([
			{ cwd: "/tmp/ooo-installed-flow", initial_context: "Build a CLI" },
			{ cwd: "/tmp/ooo-installed-flow", session_id: "interview_e2e", answer: "Linux and macOS" },
		]);
		expect(connectSpy).toHaveBeenCalledWith(
			"ouroboros-ooo-bridge",
			{
				type: "stdio",
				command: "/opt/ouroboros/bin/ouroboros",
				args: ["mcp", "serve", "--runtime", "gjc"],
				cwd: "/tmp/ooo-installed-flow",
			},
			{ signal: expect.any(AbortSignal) },
		);
		expect(disconnectSpy).toHaveBeenCalledWith(connection);
		expect(await runner.emitInput("ordinary prompt", undefined, "interactive")).toEqual({});
		expect(callSpy).toHaveBeenCalledTimes(2);
	});

	it("claims a second InputController submission while interview startup is pending", async () => {
		const connection = { name: "startup-overlap" } as MCPServerConnection;
		const startup = Promise.withResolvers<MCPToolCallResult>();
		const answer = Promise.withResolvers<MCPToolCallResult>();
		vi.spyOn(runtimeMcpModule, "connectToServer").mockResolvedValue(connection);
		const callSpy = vi
			.spyOn(runtimeMcpModule, "callTool")
			.mockImplementationOnce(() => startup.promise)
			.mockImplementationOnce(() => answer.promise);
		vi.spyOn(runtimeMcpModule, "disconnectServer").mockResolvedValue();
		const examplePath = path.resolve(import.meta.dirname, "../examples/extensions/ooo-bridge.ts");
		const loaded = await loadExtensions([examplePath], "/tmp/ooo-startup-overlap");
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			"/tmp/ooo-startup-overlap",
			{} as never,
			{} as never,
		);
		const editor = {} as InteractiveModeContext["editor"];
		const onInputCallback = vi.fn();
		const ctx = {
			session: { extensionRunner: runner, isStreaming: false, isCompacting: false, queuedMessageCount: 0 },
			pendingImages: [],
			hasActiveBtw: () => false,
			editor,
			addMessageToChat: vi.fn(() => []),
			flushPendingBashComponents: vi.fn(),
			onInputCallback,
			ui: { requestRender: vi.fn() },
		} as unknown as InteractiveModeContext;
		const controller = new InputController(ctx);
		const composer = { ownsComposer: false, editor };

		const firstSubmit = controller.submitText("ooo interview Slow startup", composer);
		await Bun.sleep(0);
		const secondSubmit = controller.submitText("Linux", composer);
		let secondSettled = false;
		void secondSubmit.then(() => {
			secondSettled = true;
		});
		await Bun.sleep(10);
		expect(callSpy).toHaveBeenCalledTimes(1);
		expect(secondSettled).toBe(false);
		expect(onInputCallback).not.toHaveBeenCalled();

		startup.resolve(
			result("Session interview_startup_overlap\n\nWhich platform?", {
				session_id: "interview_startup_overlap",
				phase: "start",
			}),
		);
		await firstSubmit;
		await Bun.sleep(0);
		expect(callSpy).toHaveBeenCalledTimes(2);
		expect(callSpy.mock.calls[1]?.[2]).toEqual({
			cwd: "/tmp/ooo-startup-overlap",
			session_id: "interview_startup_overlap",
			answer: "Linux",
		});

		answer.resolve(
			result("Interview completed. Session ID: interview_startup_overlap", {
				session_id: "interview_startup_overlap",
				phase: "complete",
				completed: true,
			}),
		);
		await secondSubmit;
		expect(onInputCallback).not.toHaveBeenCalled();
	});

	it("drops queued explicit starts across AgentSession switch and InputController clear resets", async () => {
		process.env.GJC_NO_TITLE = "1";
		const connection = { name: "session-controls" } as MCPServerConnection;
		vi.spyOn(runtimeMcpModule, "connectToServer").mockResolvedValue(connection);
		const pendingBeforeSwitch = Promise.withResolvers<MCPToolCallResult>();
		const pendingBeforeClear = Promise.withResolvers<MCPToolCallResult>();
		const callSpy = vi
			.spyOn(runtimeMcpModule, "callTool")
			.mockResolvedValueOnce(
				result("Session interview_before_new\n\nOld question?", {
					session_id: "interview_before_new",
					phase: "start",
				}),
			)
			.mockImplementationOnce(() => pendingBeforeSwitch.promise)
			.mockResolvedValueOnce(
				result("Session interview_before_clear\n\nAnother question?", {
					session_id: "interview_before_clear",
					phase: "start",
				}),
			)
			.mockImplementationOnce(() => pendingBeforeClear.promise);
		const disconnectSpy = vi.spyOn(runtimeMcpModule, "disconnectServer").mockResolvedValue();
		const examplePath = path.resolve(import.meta.dirname, "../examples/extensions/ooo-bridge.ts");
		const loaded = await loadExtensions([examplePath], "/tmp/ooo-session-controls");
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			"/tmp/ooo-session-controls",
			{} as never,
			{} as never,
		);
		const authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const sessionManager = SessionManager.inMemory("/tmp/ooo-session-controls");
		const settings = Settings.isolated();
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner: runner,
		});
		try {
			const editor = { setText: vi.fn(), addToHistory: vi.fn() } as unknown as InteractiveModeContext["editor"];
			const onInputCallback = vi.fn();
			const ctx = {
				session,
				sessionManager,
				settings,
				pendingImages: [],
				hasActiveBtw: () => false,
				editor,
				addMessageToChat: vi.fn(() => []),
				flushPendingBashComponents: vi.fn(),
				onInputCallback,
				handleClearCommand: () => session.newSession(),
				handleContextClearCommand: async () => {
					await session.clearContext();
				},
				startPendingSubmission: ({ text }: { text: string }) => ({ text, cancelled: false, started: false }),
				ui: { requestRender: vi.fn() },
			} as unknown as InteractiveModeContext;
			const controller = new InputController(ctx);
			const composer = { ownsComposer: false, editor };

			await controller.submitText("ooo interview Before new", composer);
			const answerBeforeSwitch = controller.submitText("pending answer before new", composer);
			await Bun.sleep(0);
			const queuedExplicitBeforeSwitch = controller.submitText("ooo interview queued before new", composer);
			await Bun.sleep(10);
			expect(callSpy).toHaveBeenCalledTimes(2);
			await session.newSession();
			pendingBeforeSwitch.resolve(
				result("Session interview_before_new\n\nStale successor question?", {
					session_id: "interview_before_new",
					phase: "answer",
				}),
			);
			await Promise.all([answerBeforeSwitch, queuedExplicitBeforeSwitch]);
			expect(callSpy).toHaveBeenCalledTimes(2);
			await controller.submitText("ordinary after new", composer);
			expect(onInputCallback).toHaveBeenCalledTimes(1);

			await controller.submitText("ooo interview Before clear", composer);
			const answerBeforeClear = controller.submitText("pending answer before clear", composer);
			await Bun.sleep(0);
			const queuedExplicitBeforeClear = controller.submitText("ooo interview queued before clear", composer);
			await Bun.sleep(10);
			expect(callSpy).toHaveBeenCalledTimes(4);
			await controller.submitText("/clear", composer);
			pendingBeforeClear.resolve(
				result("Session interview_before_clear\n\nStale clear question?", {
					session_id: "interview_before_clear",
					phase: "answer",
				}),
			);
			await Promise.all([answerBeforeClear, queuedExplicitBeforeClear]);
			expect(callSpy).toHaveBeenCalledTimes(4);
			await controller.submitText("ordinary after clear", composer);
			expect(onInputCallback).toHaveBeenCalledTimes(2);
			expect(disconnectSpy).toHaveBeenCalledTimes(2);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
		"loads the copied one-file extension from a compiled binary without peer node_modules",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-ooo-compiled-"));
			try {
				const extensionDir = path.join(root, "extensions", "ouroboros-ooo-bridge");
				const projectDir = path.join(root, "project");
				await fs.mkdir(extensionDir, { recursive: true });
				await fs.mkdir(projectDir, { recursive: true });
				const installedExtension = path.join(extensionDir, "index.ts");
				const examplePath = path.resolve(import.meta.dirname, "../examples/extensions/ooo-bridge.ts");
				await Bun.write(installedExtension, await Bun.file(examplePath).arrayBuffer());
				expect(await Bun.file(path.join(extensionDir, "node_modules")).exists()).toBe(false);

				const executable = path.join(root, "compiled-loader");
				const nativeName = "pi_natives.linux-x64-modern.node";
				const nativeSource = path.resolve(import.meta.dirname, `../../natives/native/${nativeName}`);
				await Bun.write(path.join(root, nativeName), await Bun.file(nativeSource).arrayBuffer());
				const fixture = path.resolve(import.meta.dirname, "fixtures/ooo-bridge-compiled-loader.ts");
				const compile = Bun.spawn(
					[process.execPath, "build", fixture, "--compile", "--external", "mupdf", "--outfile", executable],
					{
						cwd: path.resolve(import.meta.dirname, "../../.."),
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const [compileExit, compileStderr] = await Promise.all([
					compile.exited,
					new Response(compile.stderr).text(),
				]);
				expect(compileExit, compileStderr).toBe(0);

				const run = Bun.spawn([executable, installedExtension, projectDir], {
					cwd: projectDir,
					stdout: "pipe",
					stderr: "pipe",
				});
				const [runExit, stdout, stderr] = await Promise.all([
					run.exited,
					new Response(run.stdout).text(),
					new Response(run.stderr).text(),
				]);
				expect(runExit, stderr).toBe(0);
				expect(JSON.parse(stdout)).toEqual({
					errors: [],
					extensionCount: 1,
					handlerCount: 1,
					sessionSwitchHandlerCount: 1,
				});
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
		60_000,
	);
});
