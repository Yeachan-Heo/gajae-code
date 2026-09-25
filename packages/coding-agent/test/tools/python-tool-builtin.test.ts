import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool, type AgentToolResult } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai/core";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import * as pyExecutor from "@gajae-code/coding-agent/eval/py/executor";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import * as pythonTranscript from "../../src/gjc-runtime/python-transcript";
import { sessionIpykernelsArtifactsDir, sessionIpykernelsDir } from "../../src/gjc-runtime/session-layout";
import { BUILTIN_TOOL_DESCRIPTORS, createTools, type ToolSession } from "../../src/tools";
import { PYTHON_TOOL_NAME, pythonKernelOwnerId } from "../../src/tools/python";

const TEST_SESSION_ID = "test-session";

type ToolCallParams = { action?: "execute" | "clear"; code?: string };

function textOf(result: AgentToolResult): string {
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

function pythonResult(overrides: Partial<pyExecutor.PythonResult> = {}): pyExecutor.PythonResult {
	const output = overrides.output ?? "ok";
	return {
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		totalLines: output.length > 0 ? 1 : 0,
		totalBytes: output.length,
		outputLines: output.length > 0 ? 1 : 0,
		outputBytes: output.length,
		displayOutputs: [],
		stdinRequested: false,
		...overrides,
	};
}

function makeToolSession(options: {
	cwd: string;
	getSessionId?: () => string | null;
	registerSessionCleanup?: (cleanup: () => Promise<void> | void) => void;
}): ToolSession {
	const session: ToolSession = {
		cwd: options.cwd,
		hasUI: false,
		settings: Settings.isolated(),
		requireYieldTool: false,
		enableLsp: true,
		taskDepth: 0,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: options.getSessionId ?? (() => TEST_SESSION_ID),
	};
	if (options.registerSessionCleanup) {
		session.registerSessionCleanup = cleanup => {
			options.registerSessionCleanup?.(cleanup);
			return () => {};
		};
	}
	return session;
}

async function loadPythonTool(options: {
	cwd: string;
	getSessionId?: () => string | null;
	registerSessionCleanup?: (cleanup: () => Promise<void> | void) => void;
}): Promise<AgentTool> {
	const tool = await BUILTIN_TOOL_DESCRIPTORS[PYTHON_TOOL_NAME].load(makeToolSession(options));
	if (!tool) throw new Error("Expected the built-in Python tool to load");
	return tool;
}

async function executeTool(tool: AgentTool, params: ToolCallParams, signal?: AbortSignal): Promise<AgentToolResult> {
	return await tool.execute("python-test-call", params, signal);
}

async function transcriptDirectories(cwd: string, sessionId: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(sessionIpykernelsDir(cwd, sessionId), { withFileTypes: true });
		return entries
			.filter(entry => entry.isDirectory() && entry.name !== "artifacts")
			.map(entry => entry.name)
			.sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function transcriptRecords(
	cwd: string,
	sessionId: string,
	directory: string,
): Promise<Array<Record<string, unknown>>> {
	const raw = await fs.readFile(
		path.join(sessionIpykernelsDir(cwd, sessionId), directory, "transcript.jsonl"),
		"utf-8",
	);
	return raw
		.split(/\r?\n/)
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

async function createAgentSessionFixture(options: {
	cwd: string;
	toolRegistry: Map<string, AgentTool>;
}): Promise<{ session: AgentSession; sessionManager: SessionManager; cleanup: () => Promise<void> }> {
	const authStorage = await AuthStorage.create(path.join(options.cwd, "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled anthropic model to exist");
	const sessionManager = SessionManager.create(options.cwd, options.cwd);
	const agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated(),
		modelRegistry,
		toolRegistry: options.toolRegistry,
		discoveryMode: "all",
	});
	return {
		session,
		sessionManager,
		cleanup: async () => {
			await session.dispose();
			authStorage.close();
		},
	};
}

describe("builtin session Python tool", () => {
	const tempDirs: TempDir[] = [];
	const sessionCleanups: Array<() => Promise<void>> = [];

	function tempDir(): string {
		const dir = TempDir.createSync("@gjc-python-builtin-");
		tempDirs.push(dir);
		return dir.path();
	}

	afterEach(async () => {
		for (const cleanup of sessionCleanups.splice(0)) await cleanup();
		await pyExecutor.disposeAllKernelSessions();
		vi.restoreAllMocks();
		for (const dir of tempDirs.splice(0)) dir.removeSync();
	});

	it("registers as a discoverable, deferrable builtin without becoming default-active", async () => {
		const descriptor = BUILTIN_TOOL_DESCRIPTORS[PYTHON_TOOL_NAME];
		expect(descriptor.metadata.name).toBe(PYTHON_TOOL_NAME);
		expect(descriptor.metadata.loadMode).toBe("discoverable");
		expect(descriptor.metadata.deferrable).toBe(true);

		const cwd = tempDir();
		const tools = await createTools(makeToolSession({ cwd }));
		const facade = tools.find(tool => tool.name === PYTHON_TOOL_NAME);
		expect(facade).toBeDefined();
		expect(facade?.loadMode).toBe("discoverable");
		expect(facade?.deferrable).toBe(true);

		const fixture = await createAgentSessionFixture({
			cwd,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		});
		sessionCleanups.push(fixture.cleanup);
		expect(fixture.session.getAllToolNames()).toContain(PYTHON_TOOL_NAME);
		expect(fixture.session.getActiveToolNames()).not.toContain(PYTHON_TOOL_NAME);
	});

	it("uses the live session for the owner, cwd, retained mode, and stable artifacts directory", async () => {
		const cwd = tempDir();
		const executeSpy = vi.spyOn(pyExecutor, "executePython").mockImplementation(async (_code, options) => {
			options?.onKernelStart?.("k1");
			return pythonResult({ output: "first output" });
		});
		const disposeSpy = vi.spyOn(pyExecutor, "disposeKernelSessionsByOwner").mockResolvedValue(undefined);
		const tool = await loadPythonTool({ cwd });

		expect(await transcriptDirectories(cwd, TEST_SESSION_ID)).toEqual([]);
		const first = await executeTool(tool, { code: "x = 1" });
		expect(first.isError).toBeUndefined();
		expect(executeSpy).toHaveBeenCalledTimes(1);
		const firstOptions = executeSpy.mock.calls[0]?.[1];
		if (!firstOptions) throw new Error("Expected Python executor options");
		expect(firstOptions.sessionId).toBe(pythonKernelOwnerId(TEST_SESSION_ID));
		expect(firstOptions.kernelOwnerId).toBe(pythonKernelOwnerId(TEST_SESSION_ID));
		expect(firstOptions.sessionId).toBe(`python:${TEST_SESSION_ID}`);
		expect(firstOptions.cwd).toBe(cwd);
		expect(firstOptions.kernelMode).toBe("session");
		expect(firstOptions.runtimeOptions).toBeUndefined();
		expect(typeof firstOptions.onKernelStart).toBe("function");
		expect(firstOptions.artifactsDir).toBe(sessionIpykernelsArtifactsDir(cwd, TEST_SESSION_ID));

		await executeTool(tool, { action: "clear" });
		expect(disposeSpy).toHaveBeenCalledWith(pythonKernelOwnerId(TEST_SESSION_ID));
		await executeTool(tool, { code: "x = 2" });
		const secondOptions = executeSpy.mock.calls[1]?.[1];
		if (!secondOptions) throw new Error("Expected Python executor options after clear");
		expect(secondOptions.artifactsDir).toBe(sessionIpykernelsArtifactsDir(cwd, TEST_SESSION_ID));
	});

	it("records each executor callback lifetime in its own transcript directory", async () => {
		const cwd = tempDir();
		let kernelId = "k1";
		vi.spyOn(pyExecutor, "executePython").mockImplementation(async (_code, options) => {
			options?.onKernelStart?.(kernelId);
			return pythonResult({ output: kernelId });
		});
		vi.spyOn(pyExecutor, "disposeKernelSessionsByOwner").mockResolvedValue(undefined);
		const tool = await loadPythonTool({ cwd });

		await executeTool(tool, { code: "first" });
		const firstDirectories = await transcriptDirectories(cwd, TEST_SESSION_ID);
		expect(firstDirectories).toHaveLength(1);
		expect(firstDirectories[0]).toMatch(/^\d{8}T\d{6}Z-k1$/);
		const firstRecords = await transcriptRecords(cwd, TEST_SESSION_ID, firstDirectories[0]!);
		expect(firstRecords).toHaveLength(1);
		expect(Object.keys(firstRecords[0]!).sort()).toEqual([
			"cancelled",
			"code",
			"exitCode",
			"output",
			"timestamp",
			"truncated",
		]);
		expect(firstRecords).toEqual([
			expect.objectContaining({
				code: "first",
				output: "k1",
				exitCode: 0,
				cancelled: false,
				truncated: false,
			}),
		]);

		kernelId = "k2";
		await executeTool(tool, { code: "transparent replacement" });
		const afterReplacement = await transcriptDirectories(cwd, TEST_SESSION_ID);
		expect(afterReplacement).toHaveLength(2);
		expect(afterReplacement).toEqual(
			expect.arrayContaining([expect.stringMatching(/-k1$/), expect.stringMatching(/-k2$/)]),
		);

		await executeTool(tool, { action: "clear" });
		kernelId = "k3";
		await executeTool(tool, { code: "after clear" });
		const afterClear = await transcriptDirectories(cwd, TEST_SESSION_ID);
		expect(afterClear).toHaveLength(3);
		expect(afterClear).toEqual(expect.arrayContaining([expect.stringMatching(/-k3$/)]));
	});

	it("keeps throw-then-success records together when the executor reports the same retained kernel", async () => {
		const cwd = tempDir();
		let calls = 0;
		vi.spyOn(pyExecutor, "executePython").mockImplementation(async (_code, options) => {
			options?.onKernelStart?.("k1");
			calls += 1;
			if (calls === 1) throw new Error("kernel executed but failed");
			return pythonResult({ output: "recovered" });
		});
		const tool = await loadPythonTool({ cwd });

		const failed = await executeTool(tool, { code: "raise RuntimeError" });
		expect(failed.isError).toBe(true);
		expect(textOf(failed)).toContain("kernel executed but failed");
		const succeeded = await executeTool(tool, { code: "print('recovered')" });
		expect(succeeded.isError).toBeUndefined();

		const directories = await transcriptDirectories(cwd, TEST_SESSION_ID);
		expect(directories).toHaveLength(1);
		expect(directories[0]).toMatch(/^\d{8}T\d{6}Z-k1$/);
		expect(await transcriptRecords(cwd, TEST_SESSION_ID, directories[0]!)).toEqual([
			expect.objectContaining({
				code: "raise RuntimeError",
				output: "kernel executed but failed",
				exitCode: null,
				cancelled: false,
			}),
			expect.objectContaining({
				code: "print('recovered')",
				output: "recovered",
				exitCode: 0,
				cancelled: false,
			}),
		]);
	});

	it("records a cancelled executor result with its cancellation flag", async () => {
		const cwd = tempDir();
		vi.spyOn(pyExecutor, "executePython").mockResolvedValue(
			pythonResult({ output: "cancelled execution", exitCode: undefined, cancelled: true }),
		);
		const tool = await loadPythonTool({ cwd });

		await executeTool(tool, { code: "cancel" });
		const directories = await transcriptDirectories(cwd, TEST_SESSION_ID);
		expect(directories).toHaveLength(1);
		expect(await transcriptRecords(cwd, TEST_SESSION_ID, directories[0]!)).toEqual([
			expect.objectContaining({ cancelled: true, exitCode: null, output: "cancelled execution" }),
		]);
	});

	it("uses a tool-UUID fallback only before acquisition and rotates to the acquired kernel id", async () => {
		const cwd = tempDir();
		let calls = 0;
		vi.spyOn(pyExecutor, "executePython").mockImplementation(async (_code, options) => {
			calls += 1;
			if (calls === 1) throw new Error("kernel acquisition failed");
			options?.onKernelStart?.("k1");
			return pythonResult({ output: "started" });
		});
		const tool = await loadPythonTool({ cwd });

		const acquisitionFailure = await executeTool(tool, { code: "pre-acquisition failure" });
		expect(acquisitionFailure.isError).toBe(true);
		const beforeSuccess = await transcriptDirectories(cwd, TEST_SESSION_ID);
		expect(beforeSuccess).toHaveLength(1);
		expect(beforeSuccess[0]).toMatch(/^\d{8}T\d{6}Z-[0-9a-f-]{36}$/);
		expect(await transcriptRecords(cwd, TEST_SESSION_ID, beforeSuccess[0]!)).toEqual([
			expect.objectContaining({
				code: "pre-acquisition failure",
				output: "kernel acquisition failed",
				exitCode: null,
				cancelled: false,
			}),
		]);

		await executeTool(tool, { code: "after acquisition" });
		const afterSuccess = await transcriptDirectories(cwd, TEST_SESSION_ID);
		expect(afterSuccess).toHaveLength(2);
		expect(afterSuccess).toEqual(expect.arrayContaining([expect.stringMatching(/-k1$/)]));
	});

	it("does not create transcript records for invalid execute input, an unresolved session, or clear", async () => {
		const cwd = tempDir();
		const disposeSpy = vi.spyOn(pyExecutor, "disposeKernelSessionsByOwner").mockResolvedValue(undefined);
		const tool = await loadPythonTool({ cwd });
		const noCode = await executeTool(tool, { action: "execute" });
		expect(noCode.isError).toBe(true);
		expect(textOf(noCode)).toContain('Missing required "code"');

		const noSessionTool = await loadPythonTool({ cwd, getSessionId: () => null });
		const noSession = await executeTool(noSessionTool, { code: "x = 1" });
		expect(noSession.isError).toBe(true);
		expect(textOf(noSession)).toContain("requires a GJC session id");

		// The null-session contract binds clear too: actionable error, no owner
		// disposal, and no transcript state.
		const disposalsBeforeNullClear = disposeSpy.mock.calls.length;
		const noSessionClear = await executeTool(noSessionTool, { action: "clear" });
		expect(noSessionClear.isError).toBe(true);
		expect(textOf(noSessionClear)).toContain("requires a GJC session id");
		expect(disposeSpy.mock.calls.length).toBe(disposalsBeforeNullClear);

		const cleared = await executeTool(tool, { action: "clear" });
		expect(cleared.isError).toBeUndefined();
		expect(disposeSpy).toHaveBeenCalledWith(pythonKernelOwnerId(TEST_SESSION_ID));
		expect(await transcriptDirectories(cwd, TEST_SESSION_ID)).toEqual([]);
	});

	it("preserves execution output and appends a visible trailer when the transcript append fails", async () => {
		const cwd = tempDir();
		vi.spyOn(pyExecutor, "executePython").mockImplementation(async (_code, options) => {
			options?.onKernelStart?.("k1");
			return pythonResult({ output: "execution output" });
		});
		const appendSpy = vi.fn(async () => {
			throw new Error("simulated transcript disk failure");
		});
		vi.spyOn(pythonTranscript, "openPythonKernelTranscript").mockReturnValue({
			dir: "python-transcript-failure",
			kernelInstanceId: "kernel-transcript-failure",
			append: appendSpy,
		});
		const tool = await loadPythonTool({ cwd });

		const result = await executeTool(tool, { code: "print('output')" });
		expect(result.isError).toBeUndefined();
		expect(textOf(result)).toContain("execution output");
		expect(textOf(result)).toContain("[transcript append failed: simulated transcript disk failure]");
		expect(appendSpy).toHaveBeenCalled();
	});

	it("re-arms transition cleanup for each AgentSession identity and roots successor transcripts in its new session", async () => {
		const cwd = tempDir();
		let liveSession: AgentSession | undefined;
		let sessionManager: SessionManager | undefined;
		const tool = await loadPythonTool({
			cwd,
			getSessionId: () => sessionManager?.getSessionId() ?? null,
			registerSessionCleanup: cleanup => liveSession?.registerToolSessionTransitionCleanup(cleanup),
		});
		const fixture = await createAgentSessionFixture({ cwd, toolRegistry: new Map([[PYTHON_TOOL_NAME, tool]]) });
		liveSession = fixture.session;
		sessionManager = fixture.sessionManager;
		sessionCleanups.push(fixture.cleanup);
		const executeSpy = vi.spyOn(pyExecutor, "executePython").mockImplementation(async (_code, options) => {
			options?.onKernelStart?.("kernel-for-current-session");
			return pythonResult({ output: "ok" });
		});
		const disposeSpy = vi.spyOn(pyExecutor, "disposeKernelSessionsByOwner").mockResolvedValue(undefined);

		const predecessorId = sessionManager.getSessionId();
		await executeTool(tool, { code: "predecessor = True" });
		expect(await transcriptDirectories(cwd, predecessorId)).toHaveLength(1);

		await expect(liveSession.newSession()).resolves.toBe(true);
		expect(disposeSpy).toHaveBeenCalledWith(pythonKernelOwnerId(predecessorId));
		const successorId = sessionManager.getSessionId();
		expect(successorId).not.toBe(predecessorId);

		await executeTool(tool, { code: "successor = True" });
		const successorOptions = executeSpy.mock.calls[1]?.[1];
		if (!successorOptions) throw new Error("Expected successor Python options");
		expect(successorOptions.sessionId).toBe(pythonKernelOwnerId(successorId));
		expect(successorOptions.kernelOwnerId).toBe(pythonKernelOwnerId(successorId));
		expect(await transcriptDirectories(cwd, successorId)).toEqual([
			expect.stringMatching(/-kernel-for-current-session$/),
		]);

		await expect(liveSession.newSession()).resolves.toBe(true);
		expect(disposeSpy).toHaveBeenCalledWith(pythonKernelOwnerId(successorId));
	});
});
