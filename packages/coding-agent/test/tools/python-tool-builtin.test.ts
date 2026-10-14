import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool, type AgentToolResult } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai/core";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession, isSessionDisposalIncompleteError } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import * as pyExecutor from "../../src/eval/py/executor";
import * as pythonKernel from "../../src/eval/py/kernel";
import { sessionIpykernelsArtifactsDir, sessionIpykernelsDir } from "../../src/gjc-runtime/session-layout";
import { BUILTIN_TOOL_DESCRIPTORS, createTools, type ToolSession } from "../../src/tools";
import { PYTHON_TOOL_NAME, pythonKernelOwnerId } from "../../src/tools/python";

const TEST_SESSION_ID = "test-session";

type ToolCallParams = { action?: "execute" | "clear"; code?: string };

interface AgentSessionFixture {
	session: AgentSession;
	sessionManager: SessionManager;
	cleanup: () => Promise<void>;
}

interface PythonToolSessionFixture extends AgentSessionFixture {
	pythonTool: AgentTool;
}

function textOf(result: AgentToolResult): string {
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessGone(pid: number, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return true;
		await Bun.sleep(25);
	}
	return !isProcessAlive(pid);
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
	getCwd?: () => string;
	getSessionFile?: () => string | null;
	getSessionId?: () => string | null;
	settings?: Settings;
	registerSessionCleanup?: (cleanup: () => Promise<void> | void) => (() => void) | undefined;
	assertEvalExecutionAllowed?: () => void;
	trackEvalExecution?: ToolSession["trackEvalExecution"];
}): ToolSession {
	const session: ToolSession = {
		get cwd() {
			return options.getCwd?.() ?? options.cwd;
		},
		hasUI: false,
		settings: options.settings ?? Settings.isolated(),
		requireYieldTool: false,
		enableLsp: true,
		taskDepth: 0,
		getSessionFile: options.getSessionFile ?? (() => null),
		getSessionSpawns: () => null,
		getSessionId: options.getSessionId ?? (() => TEST_SESSION_ID),
	};
	if (options.assertEvalExecutionAllowed) session.assertEvalExecutionAllowed = options.assertEvalExecutionAllowed;
	if (options.trackEvalExecution) session.trackEvalExecution = options.trackEvalExecution;
	if (options.registerSessionCleanup) {
		session.registerSessionCleanup = cleanup => {
			return options.registerSessionCleanup?.(cleanup) ?? (() => {});
		};
	}
	return session;
}

async function loadPythonTool(options: {
	cwd: string;
	getCwd?: () => string;
	getSessionFile?: () => string | null;
	getSessionId?: () => string | null;
	settings?: Settings;
	registerSessionCleanup?: (cleanup: () => Promise<void> | void) => (() => void) | undefined;
	assertEvalExecutionAllowed?: () => void;
	trackEvalExecution?: ToolSession["trackEvalExecution"];
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
	sessionManager?: SessionManager;
	settings?: Settings;
}): Promise<AgentSessionFixture> {
	const authStorage = await AuthStorage.create(path.join(options.cwd, "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled anthropic model to exist");
	const sessionManager = options.sessionManager ?? SessionManager.create(options.cwd, options.cwd);
	const agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: options.settings ?? Settings.isolated(),
		modelRegistry,
		toolRegistry: options.toolRegistry,
		discoveryMode: "all",
	});
	return {
		session,
		sessionManager,
		cleanup: async () => {
			try {
				await session.dispose();
			} catch (error) {
				if (!isSessionDisposalIncompleteError(error)) throw error;
			}
			await session.awaitDisposeCompletion();
			authStorage.close();
		},
	};
}

async function createPythonToolSessionFixture(options: {
	cwd: string;
	getCwd: () => string;
	getSessionFile: () => string | null;
	getSessionId: () => string | null;
	settings: Settings;
	sessionManager?: SessionManager;
}): Promise<PythonToolSessionFixture> {
	let fixture: AgentSessionFixture | undefined;
	const toolSession = makeToolSession({
		cwd: options.cwd,
		getCwd: options.getCwd,
		getSessionFile: options.getSessionFile,
		getSessionId: options.getSessionId,
		settings: options.settings,
	});
	toolSession.registerSessionCleanup = cleanup => {
		if (!fixture) throw new Error("Python cleanup was registered before SDK session construction");
		return fixture.session.registerToolSessionTransitionCleanup(cleanup);
	};
	toolSession.assertEvalExecutionAllowed = () => {
		if (!fixture) throw new Error("Python execution was admitted before SDK session construction");
		fixture.session.assertEvalExecutionAllowed();
	};
	toolSession.trackEvalExecution = (execution, abortController) => {
		if (!fixture) throw new Error("Python execution was tracked before SDK session construction");
		return fixture.session.trackEvalExecution(execution, abortController);
	};
	const tools = await createTools(toolSession);
	const pythonTool = tools.find(tool => tool.name === PYTHON_TOOL_NAME);
	if (!pythonTool) throw new Error("Expected Python tool to be created");
	fixture = await createAgentSessionFixture({
		cwd: options.cwd,
		toolRegistry: new Map([[PYTHON_TOOL_NAME, pythonTool]]),
		sessionManager: options.sessionManager,
		settings: options.settings,
	});
	return { ...fixture, pythonTool };
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

	it("enrolls the original invocation before reentrant registered cleanup and clear", async () => {
		const cwd = tempDir();
		const foreignSessionId = "foreign-python-test-session";
		const appendStarted = {
			[TEST_SESSION_ID]: Promise.withResolvers<void>(),
			[foreignSessionId]: Promise.withResolvers<void>(),
		};
		const releaseAppend = {
			[TEST_SESSION_ID]: Promise.withResolvers<void>(),
			[foreignSessionId]: Promise.withResolvers<void>(),
		};
		let sessionFixture: AgentSessionFixture | undefined;
		let registeredCleanup: (() => Promise<void> | void) | undefined;
		let pythonTool: AgentTool | undefined;
		let reenterCleanupFromTracker = false;
		let cleanupFromTrackerSettled = false;
		let clearFromTrackerSettled = false;
		let foreignExecutionSettled = false;
		let foreignClearSettled = false;
		let originalExecutionSettled = false;
		let trackingWrapperSettled = false;
		let cleanupFromTracker: Promise<void> | undefined;
		let clearFromTracker: Promise<AgentToolResult> | undefined;
		let foreignClear: Promise<AgentToolResult> | undefined;
		const releaseTrackingWrapper = Promise.withResolvers<void>();

		const assertExecutionAllowed = (): void => {
			if (!sessionFixture) throw new Error("Python execution was admitted before SDK session construction");
			sessionFixture.session.assertEvalExecutionAllowed();
		};
		const trackExecution: NonNullable<ToolSession["trackEvalExecution"]> = (execution, abortController) => {
			if (!sessionFixture) throw new Error("Python execution was tracked before SDK session construction");
			const holdTrackingWrapper = reenterCleanupFromTracker;
			if (holdTrackingWrapper) {
				reenterCleanupFromTracker = false;
				const cleanup = registeredCleanup;
				if (!cleanup) throw new Error("Expected the Python generation cleanup to be registered before tracking");
				const activeTool = pythonTool;
				if (!activeTool) throw new Error("Expected the built-in Python tool to be loaded before tracking");
				clearFromTracker = activeTool.execute("python-reentrant-clear", { action: "clear" }).then(result => {
					clearFromTrackerSettled = true;
					return result;
				});
				cleanupFromTracker = Promise.resolve(cleanup()).then(() => {
					cleanupFromTrackerSettled = true;
				});
			}
			const trackedExecution = sessionFixture.session.trackEvalExecution(execution, abortController);
			if (!holdTrackingWrapper) return trackedExecution;
			return trackedExecution.then(async result => {
				await releaseTrackingWrapper.promise;
				trackingWrapperSettled = true;
				return result;
			});
		};
		const registerCleanup = (cleanup: () => Promise<void> | void): (() => void) => {
			if (!sessionFixture) throw new Error("Python cleanup was registered before SDK session construction");
			registeredCleanup = cleanup;
			return sessionFixture.session.registerToolSessionTransitionCleanup(cleanup);
		};

		const tool = await loadPythonTool({
			cwd,
			getSessionId: () => TEST_SESSION_ID,
			registerSessionCleanup: registerCleanup,
			assertEvalExecutionAllowed: assertExecutionAllowed,
			trackEvalExecution: trackExecution,
		});
		pythonTool = tool;
		const foreignTool = await loadPythonTool({
			cwd,
			getSessionId: () => foreignSessionId,
			registerSessionCleanup: cleanup => {
				if (!sessionFixture) throw new Error("Python cleanup was registered before SDK session construction");
				return sessionFixture.session.registerToolSessionTransitionCleanup(cleanup);
			},
			assertEvalExecutionAllowed: assertExecutionAllowed,
			trackEvalExecution: trackExecution,
		});
		sessionFixture = await createAgentSessionFixture({ cwd, toolRegistry: new Map([[PYTHON_TOOL_NAME, tool]]) });
		sessionCleanups.push(sessionFixture.cleanup);

		const realAppendFile = fs.appendFile.bind(fs);
		vi.spyOn(fs, "appendFile").mockImplementation(async (filePath, data, options) => {
			const result = await realAppendFile(filePath, data, options);
			const targetSessionId = ([TEST_SESSION_ID, foreignSessionId] as const).find(
				sessionId =>
					String(filePath).startsWith(sessionIpykernelsDir(cwd, sessionId)) &&
					String(filePath).endsWith("transcript.jsonl"),
			);
			if (targetSessionId === undefined) return result;
			appendStarted[targetSessionId].resolve();
			await releaseAppend[targetSessionId].promise;
			return result;
		});

		try {
			const foreignExecution = foreignTool
				.execute("python-foreign-invocation", { code: "print('foreign invocation')" })
				.then(result => {
					foreignExecutionSettled = true;
					return result;
				});
			await appendStarted[foreignSessionId].promise;

			reenterCleanupFromTracker = true;
			const originalExecution = tool
				.execute("python-reentrant-execution", {
					code: "print('invocation retired by its tracker')",
				})
				.then(result => {
					originalExecutionSettled = true;
					return result;
				});
			await appendStarted[TEST_SESSION_ID].promise;
			expect(cleanupFromTrackerSettled).toBe(false);
			expect(clearFromTrackerSettled).toBe(false);
			expect(foreignExecutionSettled).toBe(false);
			expect(cleanupFromTracker).toBeDefined();
			expect(clearFromTracker).toBeDefined();
			expect(
				await transcriptRecords(cwd, TEST_SESSION_ID, (await transcriptDirectories(cwd, TEST_SESSION_ID))[0]!),
			).toEqual(
				expect.arrayContaining([expect.objectContaining({ code: "print('invocation retired by its tracker')" })]),
			);

			releaseAppend[TEST_SESSION_ID].resolve();
			await cleanupFromTracker;
			const clearResult = await clearFromTracker;
			expect(originalExecutionSettled).toBe(false);
			expect(trackingWrapperSettled).toBe(false);
			releaseTrackingWrapper.resolve();
			const originalResult = await originalExecution;
			expect(originalResult.content.length).toBeGreaterThan(0);
			expect(clearResult?.isError).toBeUndefined();
			expect(cleanupFromTrackerSettled).toBe(true);
			expect(clearFromTrackerSettled).toBe(true);
			expect(trackingWrapperSettled).toBe(true);
			expect(foreignExecutionSettled).toBe(false);

			foreignClear = foreignTool.execute("python-foreign-clear", { action: "clear" }).then(result => {
				foreignClearSettled = true;
				return result;
			});
			await Bun.sleep(0);
			expect(foreignClearSettled).toBe(false);
			releaseAppend[foreignSessionId].resolve();
			const foreignResult = await foreignExecution;
			const foreignClearResult = await foreignClear;
			expect(textOf(foreignResult)).toContain("foreign invocation");
			expect(foreignClearResult.isError).toBeUndefined();

			const successor = await tool.execute("python-reentrant-successor", {
				code: "print('healthy successor')",
			});
			expect(successor.isError).toBeUndefined();
			expect(textOf(successor)).toContain("healthy successor");
		} finally {
			// Only release test gates here so an execution/assertion error is not replaced by cleanup.
			releaseTrackingWrapper.resolve();
			releaseAppend[TEST_SESSION_ID].resolve();
			releaseAppend[foreignSessionId].resolve();
		}
	}, 30_000);

	it("retires an invocation when the tracking callback re-enters cleanup and throws", async () => {
		const cwd = tempDir();
		let registeredCleanup: (() => Promise<void> | void) | undefined;
		let cleanupFromTracker: Promise<void> | undefined;
		const executeSpy = vi.spyOn(pyExecutor, "executePython");
		const disposeSpy = vi.spyOn(pyExecutor, "disposeKernelSessionsByOwner").mockResolvedValue(undefined);
		const tool = await loadPythonTool({
			cwd,
			registerSessionCleanup: cleanup => {
				registeredCleanup = cleanup;
			},
			trackEvalExecution: () => {
				if (!registeredCleanup) throw new Error("Expected the Python generation cleanup to be registered");
				cleanupFromTracker = Promise.resolve(registeredCleanup());
				throw new Error("tracking callback failed");
			},
		});

		await expect(executeTool(tool, { code: "print('must not execute')" })).rejects.toThrow(
			"tracking callback failed",
		);
		if (!cleanupFromTracker) throw new Error("Expected tracker cleanup to start");
		await cleanupFromTracker;
		expect(executeSpy).not.toHaveBeenCalled();
		expect(disposeSpy).toHaveBeenCalledWith(pythonKernelOwnerId(TEST_SESSION_ID));
	});

	it("captures live cwd and session metadata before preflight and tracks through transcript append", async () => {
		const cwdA = tempDir();
		const cwdB = tempDir();
		const settings = Settings.isolated();
		const availabilityStarted = Promise.withResolvers<void>();
		const releaseAvailability = Promise.withResolvers<void>();
		const kernelStarted = Promise.withResolvers<void>();
		const shutdownStarted = Promise.withResolvers<void>();
		const shutdownCompleted = Promise.withResolvers<void>();
		const releaseShutdown = Promise.withResolvers<void>();
		const appendStarted = Promise.withResolvers<void>();
		const releaseAppend = Promise.withResolvers<void>();
		const managerA = SessionManager.create(cwdA, cwdA);
		const managerB = SessionManager.create(cwdB, cwdB);
		let activeManager = managerA;
		let clearSettled = false;
		let observedKernelStartId: string | undefined;
		const realAvailability = pythonKernel.checkPythonKernelAvailability.bind(pythonKernel);
		let holdAvailability = true;
		const availabilitySpy = vi
			.spyOn(pythonKernel, "checkPythonKernelAvailability")
			.mockImplementation(async (...args) => {
				if (holdAvailability) {
					holdAvailability = false;
					availabilityStarted.resolve();
					await releaseAvailability.promise;
				}
				return await realAvailability(...args);
			});
		const realStart = pythonKernel.PythonKernel.start.bind(pythonKernel.PythonKernel);
		vi.spyOn(pythonKernel.PythonKernel, "start").mockImplementation(async options => {
			const kernel = await realStart(options);
			const originalShutdown = kernel.shutdown.bind(kernel);
			kernel.shutdown = async shutdownOptions => {
				shutdownStarted.resolve();
				await releaseShutdown.promise;
				try {
					return await originalShutdown(shutdownOptions);
				} finally {
					shutdownCompleted.resolve();
				}
			};
			kernelStarted.resolve();
			return kernel;
		});
		const realExecute = pyExecutor.executePython.bind(pyExecutor);
		const executeSpy = vi.spyOn(pyExecutor, "executePython").mockImplementation((code, options) => {
			const originalOnKernelStart = options?.onKernelStart;
			return realExecute(code, {
				...options,
				onKernelStart: kernelInstanceId => {
					observedKernelStartId = kernelInstanceId;
					originalOnKernelStart?.(kernelInstanceId);
				},
			});
		});
		const realAppendFile = fs.appendFile.bind(fs);
		vi.spyOn(fs, "appendFile").mockImplementation(async (filePath, data, options) => {
			const result = await realAppendFile(filePath, data, options);
			if (
				String(filePath).startsWith(sessionIpykernelsDir(cwdA, managerA.getSessionId())) &&
				String(filePath).endsWith("transcript.jsonl")
			) {
				appendStarted.resolve();
				await releaseAppend.promise;
			}
			return result;
		});
		let sessionForCleanup: PythonToolSessionFixture | undefined;
		let executionForCleanup: Promise<AgentToolResult> | undefined;
		let clear: Promise<AgentToolResult> | undefined;
		let transition: Promise<boolean> | undefined;
		let transitionSettled = false;
		let cleanupResults: PromiseSettledResult<unknown>[] = [];
		try {
			const session = await createPythonToolSessionFixture({
				cwd: cwdA,
				getCwd: () => activeManager.getCwd(),
				getSessionFile: () => activeManager.getSessionFile() ?? null,
				getSessionId: () => activeManager.getSessionId(),
				settings,
				sessionManager: managerA,
			});
			sessionForCleanup = session;
			const sessionFileA = managerA.getSessionFile();
			const sessionIdA = managerA.getSessionId();
			if (!sessionFileA) throw new Error("Expected an actual SDK session file");
			const pidFile = path.join(cwdA, "python-captured.pid");
			const executionCode = `import os\nwith open(${JSON.stringify(pidFile)}, "w") as pid_file:\n    pid_file.write(str(os.getpid()))\nprint(os.getpid())`;
			const execution = session.pythonTool.execute("python-captured-call", { code: executionCode });
			executionForCleanup = execution;
			await availabilityStarted.promise;
			expect(session.session.isEvalRunning).toBe(true);
			activeManager = managerB;
			releaseAvailability.resolve();
			await kernelStarted.promise;
			await appendStarted.promise;
			expect(session.session.isEvalRunning).toBe(true);
			const observedPid = Number((await Bun.file(pidFile).text()).trim());
			expect(Number.isSafeInteger(observedPid) && observedPid > 0).toBe(true);
			expect(isProcessAlive(observedPid)).toBe(true);

			activeManager = managerA;
			clear = session.pythonTool.execute("python-captured-clear", { action: "clear" }).then(result => {
				clearSettled = true;
				return result;
			});
			await shutdownStarted.promise;
			await Bun.sleep(0);
			expect(clearSettled).toBe(false);

			const options = executeSpy.mock.calls[0]?.[1];
			if (!options) throw new Error("Expected captured Python executor options");
			expect(availabilitySpy).toHaveBeenCalled();
			expect(options.cwd).toBe(cwdA);
			expect(options.sessionFile).toBe(sessionFileA);
			expect(options.sessionId).toBe(pythonKernelOwnerId(sessionIdA));
			expect(options.settings).toBe(settings);
			expect(options.artifactsDir).toBe(sessionIpykernelsArtifactsDir(cwdA, sessionIdA));
			expect(observedKernelStartId).toBeString();
			const directories = await transcriptDirectories(cwdA, sessionIdA);
			expect(directories).toHaveLength(1);
			expect(directories[0]).toEndWith(`-${observedKernelStartId}`);
			const transcriptPath = path.join(sessionIpykernelsDir(cwdA, sessionIdA), directories[0]!, "transcript.jsonl");
			const transcriptBytesWhileAppendHeld = new Uint8Array(await Bun.file(transcriptPath).arrayBuffer());
			expect(await transcriptDirectories(cwdB, sessionIdA)).toEqual([]);
			expect(await transcriptDirectories(cwdB, managerB.getSessionId())).toEqual([]);
			expect(await transcriptRecords(cwdA, sessionIdA, directories[0]!)).toEqual([
				expect.objectContaining({ code: executionCode, output: expect.stringContaining(String(observedPid)) }),
			]);
			expect(clearSettled).toBe(false);
			releaseShutdown.resolve();
			await shutdownCompleted.promise;
			expect(await waitForProcessGone(observedPid)).toBe(true);
			expect(clearSettled).toBe(false);
			expect(session.session.isEvalRunning).toBe(true);
			transition = session.session.newSession().then(result => {
				transitionSettled = true;
				return result;
			});
			await Bun.sleep(0);
			expect(transitionSettled).toBe(false);
			expect(session.session.isEvalRunning).toBe(true);
			releaseAppend.resolve();
			const result = await execution;
			expect(result.isError).toBeUndefined();
			expect(textOf(result)).toContain(String(observedPid));
			expect(session.session.isEvalRunning).toBe(false);
			const cleared = await clear;
			expect(cleared.isError).toBeUndefined();
			await expect(transition).resolves.toBe(true);
			await Bun.sleep(0);
			expect(clearSettled).toBe(true);
			expect(transitionSettled).toBe(true);
			expect(session.session.isEvalRunning).toBe(false);
			expect(new Uint8Array(await Bun.file(transcriptPath).arrayBuffer())).toEqual(transcriptBytesWhileAppendHeld);
		} finally {
			releaseAvailability.resolve();
			releaseShutdown.resolve();
			releaseAppend.resolve();
			const cleanupTasks: Promise<unknown>[] = [sessionForCleanup ? sessionForCleanup.cleanup() : managerA.close()];
			if (executionForCleanup) cleanupTasks.push(executionForCleanup);
			if (clear) cleanupTasks.push(clear);
			if (transition) cleanupTasks.push(transition);
			cleanupTasks.push(managerB.close());
			cleanupResults = await Promise.allSettled(cleanupTasks);
		}
		const cleanupFailures = cleanupResults.flatMap(result => (result.status === "rejected" ? [result.reason] : []));
		if (cleanupFailures.length === 1) throw cleanupFailures[0];
		if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, "Python test cleanup failed.");
	}, 30_000);

	it("clears and recreates a real Python generation under the actual session lifecycle", async () => {
		const cwd = tempDir();
		const settings = Settings.isolated();
		const sessionManager = SessionManager.create(cwd, cwd);
		const session = await createPythonToolSessionFixture({
			cwd,
			getCwd: () => sessionManager.getCwd(),
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionId: () => sessionManager.getSessionId(),
			settings,
			sessionManager,
		});
		const sessionId = sessionManager.getSessionId();
		let pidA: number | undefined;
		let pidB: number | undefined;
		let disposed = false;
		let cleanupResults: PromiseSettledResult<unknown>[] = [];
		try {
			const resultA = await session.pythonTool.execute("python-generation-a", {
				code: "import os\ngeneration_a_marker = True\nprint(os.getpid())",
			});
			expect(resultA.isError).toBeUndefined();
			pidA = Number(textOf(resultA).match(/\b\d+\b/)?.[0]);
			expect(Number.isSafeInteger(pidA) && pidA > 0).toBe(true);
			expect(isProcessAlive(pidA)).toBe(true);

			const directoriesA = await transcriptDirectories(cwd, sessionId);
			expect(directoriesA).toHaveLength(1);
			const bytesA = new Uint8Array(
				await Bun.file(
					path.join(sessionIpykernelsDir(cwd, sessionId), directoriesA[0]!, "transcript.jsonl"),
				).arrayBuffer(),
			);

			const clearResult = await session.pythonTool.execute("python-generation-clear", { action: "clear" });
			expect(clearResult.isError).toBeUndefined();
			expect(await waitForProcessGone(pidA)).toBe(true);
			expect(session.session.isEvalRunning).toBe(false);

			const resultB = await session.pythonTool.execute("python-generation-b", {
				code: "import os\nprint(os.getpid())\nprint('generation_a_marker' in globals())",
			});
			expect(resultB.isError).toBeUndefined();
			pidB = Number(textOf(resultB).match(/\b\d+\b/)?.[0]);
			expect(Number.isSafeInteger(pidB) && pidB > 0).toBe(true);
			expect(isProcessAlive(pidB)).toBe(true);
			expect(textOf(resultB)).toContain("False");

			const directoriesB = await transcriptDirectories(cwd, sessionId);
			expect(directoriesB).toHaveLength(2);
			const transcriptBDirectory = directoriesB.find(directory => directory !== directoriesA[0]);
			if (!transcriptBDirectory) throw new Error("Expected a fresh transcript directory after clear");
			const pathA = path.join(sessionIpykernelsDir(cwd, sessionId), directoriesA[0]!, "transcript.jsonl");
			const pathB = path.join(sessionIpykernelsDir(cwd, sessionId), transcriptBDirectory, "transcript.jsonl");
			const bytesB = new Uint8Array(await Bun.file(pathB).arrayBuffer());
			await session.cleanup();
			disposed = true;
			expect(await waitForProcessGone(pidB)).toBe(true);
			expect(new Uint8Array(await Bun.file(pathA).arrayBuffer())).toEqual(bytesA);
			expect(new Uint8Array(await Bun.file(pathB).arrayBuffer())).toEqual(bytesB);
		} finally {
			cleanupResults = await Promise.allSettled([
				...(!disposed ? [session.cleanup()] : []),
				...(pidA !== undefined ? [waitForProcessGone(pidA)] : []),
				...(pidB !== undefined ? [waitForProcessGone(pidB)] : []),
			]);
		}
		const cleanupFailures = cleanupResults.flatMap(result => (result.status === "rejected" ? [result.reason] : []));
		if (cleanupFailures.length === 1) throw cleanupFailures[0];
		if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, "Python test cleanup failed.");
		const processResults = cleanupResults.slice(disposed ? 0 : 1);
		expect(processResults.every(result => result.status === "fulfilled" && result.value === true)).toBe(true);
	}, 30_000);

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
		const appendSpy = vi.spyOn(fs, "appendFile").mockImplementation(async filePath => {
			if (String(filePath).endsWith("transcript.jsonl")) throw new Error("simulated transcript disk failure");
			return undefined;
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
