import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@gajae-code/agent-core";
import { loadExtensions } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { InputController } from "../src/modes/controllers/input-controller";
import type { InteractiveModeContext } from "../src/modes/types";
import type { MCPServerConnection, MCPToolCallResult } from "../src/runtime-mcp";
import * as runtimeMcpModule from "../src/runtime-mcp";

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
				expect(JSON.parse(stdout)).toEqual({ errors: [], extensionCount: 1, handlerCount: 1 });
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
		60_000,
	);
});
