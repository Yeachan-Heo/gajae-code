import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { pythonBackend } from "@gajae-code/coding-agent/eval";
import { AgentRegistry } from "@gajae-code/coding-agent/registry/agent-registry";
import { createAgentSession, type ExtensionFactory, type WorkspaceTree } from "@gajae-code/coding-agent/sdk";
import { isSessionDisposalIncompleteError } from "@gajae-code/coding-agent/session/agent-session";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Snowflake } from "@gajae-code/utils";
import * as pythonExecutor from "../src/eval/py/executor";
import type { PythonKernel as PythonKernelInstance } from "../src/eval/py/kernel";
import * as pythonKernel from "../src/eval/py/kernel";
import { sessionIpykernelsDir } from "../src/gjc-runtime/session-layout";
import { PYTHON_TOOL_NAME } from "../src/tools/python";

const OK_EXECUTION = { status: "ok", cancelled: false, timedOut: false, stdinRequested: false } as const;

class FakeKernel {
	executeCalls: string[] = [];
	shutdownCalls = 0;
	alive = true;
	blockedCode: string | undefined;
	blockedExecution: Promise<typeof OK_EXECUTION> | undefined;
	blockedExecutionStarted: (() => void) | undefined;
	blockedExecutionReject: ((error: Error) => void) | undefined;
	abortBlockedExecution = true;

	isAlive(): boolean {
		return this.alive;
	}

	async execute(code: string, options?: { signal?: AbortSignal }): Promise<typeof OK_EXECUTION> {
		this.executeCalls.push(code);
		if (code === this.blockedCode && this.blockedExecution) {
			this.blockedExecutionStarted?.();
			if (!this.abortBlockedExecution || !options?.signal) {
				return await this.blockedExecution;
			}
			return await Promise.race([
				this.blockedExecution,
				new Promise<typeof OK_EXECUTION>((_, reject) => {
					const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
					if (options.signal?.aborted) {
						onAbort();
						return;
					}
					options.signal?.addEventListener("abort", onAbort, { once: true });
				}),
			]);
		}
		return OK_EXECUTION;
	}

	async ping(): Promise<boolean> {
		return this.alive;
	}

	shutdown = vi.fn(async () => {
		this.shutdownCalls += 1;
		this.alive = false;
		this.blockedExecutionReject?.(new Error("Kernel shut down during execution"));
		return { confirmed: true };
	});
}

const getModel = () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	return model;
};

const createTempProject = () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-agent-session-python-cleanup-${Snowflake.next()}-`));
	const cwd = path.join(tempDir, "project");
	fs.mkdirSync(cwd, { recursive: true });
	return { tempDir, cwd };
};

const emptyWorkspaceTree = (cwd: string): WorkspaceTree => ({
	rootPath: cwd,
	rendered: ".",
	truncated: false,
	totalLines: 1,
	agentsMdFiles: [],
});

const PYTHON_DISPOSE_WAIT_MS = 3_000;
const isPythonDisposeWaitDuration = (duration: unknown): duration is number =>
	typeof duration === "number" && duration >= PYTHON_DISPOSE_WAIT_MS - 1 && duration <= PYTHON_DISPOSE_WAIT_MS;
const mockLongPythonDisposeSleepsImmediate = () => {
	const realSleep = Bun.sleep.bind(Bun);
	return vi.spyOn(Bun, "sleep").mockImplementation((duration?: number | Date) => {
		if (isPythonDisposeWaitDuration(duration)) {
			return Promise.resolve();
		}
		return realSleep(duration ?? 0);
	});
};
const createSession = async (
	tempDir: string,
	cwd: string,
	options: { extensions?: ExtensionFactory[]; sessionManager?: SessionManager; toolNames?: string[] } = {},
) =>
	(
		await createAgentSession({
			cwd,
			agentDir: tempDir,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(cwd),
			settings: Settings.isolated({ "python.kernelMode": "session" }),
			model: getModel(),
			disableExtensionDiscovery: true,
			extensions: options.extensions,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			workspaceTree: emptyWorkspaceTree(cwd),
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: options.toolNames ?? ["eval"],
		})
	).session;

const createMockKernel = () => {
	let alive = true;
	return {
		execute: vi.fn(async () => {
			if (!alive) throw new Error("Expected mock kernel to be restarted after shutdown");
			return OK_EXECUTION;
		}),
		ping: vi.fn(async () => alive),
		isAlive: () => alive,
		shutdown: vi.fn(async () => {
			alive = false;
			return { confirmed: true };
		}),
	};
};

function toolText(result: AgentToolResult): string {
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

async function waitForProcessFile(filePath: string, timeoutMs = 10_000): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const file = Bun.file(filePath);
		if (await file.exists()) {
			const pid = Number((await file.text()).trim());
			if (Number.isSafeInteger(pid) && pid > 0 && isProcessAlive(pid)) return pid;
		}
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for a live Python process in ${filePath}`);
}

async function waitForProcessGone(pid: number, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return true;
		await Bun.sleep(25);
	}
	return !isProcessAlive(pid);
}

async function transcriptDirectories(cwd: string, sessionId: string): Promise<string[]> {
	const root = sessionIpykernelsDir(cwd, sessionId);
	const directories = new Set<string>();
	try {
		for await (const file of new Bun.Glob("*/transcript.jsonl").scan({ cwd: root })) {
			directories.add(path.dirname(file));
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return [...directories].sort();
}

async function transcriptRecords(
	cwd: string,
	sessionId: string,
	directory: string,
): Promise<Array<Record<string, unknown>>> {
	const raw = await Bun.file(path.join(sessionIpykernelsDir(cwd, sessionId), directory, "transcript.jsonl")).text();
	return raw
		.split(/\r?\n/)
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

async function transcriptBytes(cwd: string, sessionId: string, directory: string): Promise<Uint8Array> {
	return new Uint8Array(
		await Bun.file(path.join(sessionIpykernelsDir(cwd, sessionId), directory, "transcript.jsonl")).arrayBuffer(),
	);
}

describe("AgentSession python cleanup", () => {
	const tempDirs: string[] = [];
	let originalNullPrompt: string | undefined;

	beforeEach(() => {
		originalNullPrompt = Bun.env.NULL_PROMPT;
		Bun.env.NULL_PROMPT = "true";
	});

	afterEach(async () => {
		if (originalNullPrompt === undefined) {
			delete Bun.env.NULL_PROMPT;
		} else {
			Bun.env.NULL_PROMPT = originalNullPrompt;
		}
		originalNullPrompt = undefined;
		vi.restoreAllMocks();
		await pythonExecutor.disposeAllKernelSessions();
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not dispose unrelated Python owners when createAgentSession fails before session construction", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const unrelatedKernel = createMockKernel();
		const unrelatedCwd = path.join(tempDir, "unrelated-before");
		const throwingExtension: ExtensionFactory = () => {
			throw new Error("Extension init failed");
		};
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValueOnce(unrelatedKernel as unknown as PythonKernelInstance);

		await pythonExecutor.executePython("print('unrelated before')", {
			cwd: unrelatedCwd,
			sessionId: "unrelated-before-session",
			kernelMode: "session",
			kernelOwnerId: "other-owner",
		});

		await expect(
			createAgentSession({
				cwd,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(cwd),
				settings: Settings.isolated({ "python.kernelMode": "session" }),
				model: getModel(),
				disableExtensionDiscovery: true,
				extensions: [throwingExtension],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				toolNames: ["eval"],
				workspaceTree: emptyWorkspaceTree(cwd),
			}),
		).rejects.toThrow("Extension init failed");

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(unrelatedKernel.shutdown).not.toHaveBeenCalled();

		const replacementKernel = createMockKernel();
		startSpy.mockResolvedValueOnce(replacementKernel as unknown as PythonKernelInstance);
		await pythonExecutor.executePython("print('fresh warmup before')", {
			cwd,
			sessionId: `cwd:${cwd}`,
			kernelMode: "session",
			kernelOwnerId: "fresh-owner-before",
		});
		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(replacementKernel.execute).toHaveBeenCalledTimes(1);
		expect(replacementKernel.execute).toHaveBeenCalledTimes(1);

		await pythonExecutor.executePython("print('still alive before')", {
			cwd: unrelatedCwd,
			sessionId: "unrelated-before-session",
			kernelMode: "session",
			kernelOwnerId: "other-owner",
		});

		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(unrelatedKernel.execute).toHaveBeenCalledTimes(2);
	});

	it("joins held generation A cleanup and generation B process shutdown during SDK disposal", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const session = await createSession(tempDir, cwd, { toolNames: [PYTHON_TOOL_NAME] });
		const pythonTool = session.getToolByName(PYTHON_TOOL_NAME);
		expect(pythonTool).toBeDefined();
		if (!pythonTool) throw new Error("Expected the SDK Python tool");

		const sessionId = session.sessionManager.getSessionId();
		const pidFileA = path.join(tempDir, "python-generation-a.pid");
		const pidFileB = path.join(tempDir, "python-generation-b.pid");
		const codeA = `import os, time\nwith open(${JSON.stringify(pidFileA)}, "w") as pid_file:\n    pid_file.write(str(os.getpid()))\nprint("generation-a-held", flush=True)\ntime.sleep(30)`;
		const codeB = `import os\nwith open(${JSON.stringify(pidFileB)}, "w") as pid_file:\n    pid_file.write(str(os.getpid()))\nprint("generation-b-ready", flush=True)`;
		const realAvailability = pythonKernel.checkPythonKernelAvailability.bind(pythonKernel);
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockImplementation((...args) =>
			realAvailability(...args),
		);
		const realExecutePython = pythonExecutor.executePython.bind(pythonExecutor);
		let executorCalls = 0;
		vi.spyOn(pythonExecutor, "executePython").mockImplementation((...args) => {
			executorCalls += 1;
			return realExecutePython(...args);
		});
		const realStart = pythonKernel.PythonKernel.start.bind(pythonKernel.PythonKernel);
		const shutdownAStarted = Promise.withResolvers<void>();
		const shutdownBStarted = Promise.withResolvers<void>();
		const releaseShutdownA = Promise.withResolvers<void>();
		let firstKernel: pythonKernel.PythonKernel | undefined;
		let kernelStarts = 0;
		vi.spyOn(pythonKernel.PythonKernel, "start").mockImplementation(async options => {
			const kernel = await realStart(options);
			kernelStarts += 1;
			if (kernelStarts === 1) {
				firstKernel = kernel;
				const originalShutdown = kernel.shutdown.bind(kernel);
				kernel.shutdown = async shutdownOptions => {
					shutdownAStarted.resolve();
					await releaseShutdownA.promise;
					return await originalShutdown(shutdownOptions);
				};
			} else {
				const originalShutdown = kernel.shutdown.bind(kernel);
				kernel.shutdown = async shutdownOptions => {
					shutdownBStarted.resolve();
					return await originalShutdown(shutdownOptions);
				};
			}
			return kernel;
		});
		const executionA = pythonTool.execute("python-generation-a", { code: codeA });
		let executionB: Promise<AgentToolResult> | undefined;
		let clearSettled = false;
		let clearA: Promise<AgentToolResult> | undefined;
		let disposeSettled = false;
		let disposePromise: Promise<void> | undefined;
		let pidA: number | undefined;
		let pidB: number | undefined;
		let cleanupResults: PromiseSettledResult<unknown>[] = [];
		try {
			pidA = await waitForProcessFile(pidFileA);
			expect(isProcessAlive(pidA)).toBe(true);
			clearA = pythonTool.execute("python-clear-generation-a", { action: "clear" }).then(result => {
				clearSettled = true;
				return result;
			});
			await shutdownAStarted.promise;
			expect(firstKernel).toBeDefined();
			expect(isProcessAlive(pidA)).toBe(true);
			await Bun.sleep(0);
			expect(clearSettled).toBe(false);

			executionB = pythonTool.execute("python-generation-b", { code: codeB });
			const executionBStarted = executionB;
			const resultA = await executionA;
			expect(resultA.isError).toBeUndefined();
			const resultB = await executionBStarted;
			expect(resultB.isError).toBeUndefined();
			pidB = await waitForProcessFile(pidFileB);
			expect(isProcessAlive(pidB)).toBe(true);
			expect(session.sessionManager.getSessionId()).toBe(sessionId);
			const directories = await transcriptDirectories(cwd, sessionId);
			expect(directories).toHaveLength(2);
			const transcriptSnapshots = await Promise.all(
				directories.map(async directory => ({
					directory,
					bytes: await transcriptBytes(cwd, sessionId, directory),
					records: await transcriptRecords(cwd, sessionId, directory),
				})),
			);
			expect(transcriptSnapshots.flatMap(transcript => transcript.records)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ code: codeA, cancelled: true }),
					expect.objectContaining({ code: codeB, cancelled: false }),
				]),
			);

			disposePromise = session.dispose().then(() => {
				disposeSettled = true;
			});
			await shutdownBStarted.promise;
			expect(isProcessAlive(pidA)).toBe(true);
			expect(disposeSettled).toBe(false);
			expect(clearSettled).toBe(false);
			expect(kernelStarts).toBe(2);
			expect(executorCalls).toBe(2);

			releaseShutdownA.resolve();
			await disposePromise;
			expect(disposeSettled).toBe(true);
			expect(clearSettled).toBe(true);
			expect(await waitForProcessGone(pidA)).toBe(true);
			expect(await waitForProcessGone(pidB)).toBe(true);
			expect(toolText(resultA)).toContain("generation-a-held");
			expect(toolText(resultB)).toContain("generation-b-ready");
			await session.awaitDisposeCompletion();
			for (const transcript of transcriptSnapshots) {
				expect(await transcriptBytes(cwd, sessionId, transcript.directory)).toEqual(transcript.bytes);
			}
			await clearA;
		} finally {
			releaseShutdownA.resolve();
			if (!disposePromise) disposePromise = session.dispose().then(() => undefined);
			const disposeCleanup = (async (): Promise<void> => {
				let callerFailure: unknown;
				try {
					await disposePromise;
				} catch (error) {
					if (!isSessionDisposalIncompleteError(error)) callerFailure = error;
				}
				let completionFailure: unknown;
				try {
					await session.awaitDisposeCompletion();
				} catch (error) {
					completionFailure = error;
				}
				if (callerFailure !== undefined && completionFailure !== undefined) {
					throw new AggregateError([callerFailure, completionFailure], "SDK Python disposal failed.");
				}
				if (callerFailure !== undefined) throw callerFailure;
				if (completionFailure !== undefined) throw completionFailure;
			})();
			const processWaits = [
				...(pidA !== undefined ? [waitForProcessGone(pidA)] : []),
				...(pidB !== undefined ? [waitForProcessGone(pidB)] : []),
			];
			cleanupResults = await Promise.allSettled([
				disposeCleanup,
				executionA,
				...(executionB ? [executionB] : []),
				...(clearA ? [clearA] : []),
				...processWaits,
			]);
		}
		const cleanupFailures = cleanupResults.flatMap(result => (result.status === "rejected" ? [result.reason] : []));
		if (cleanupFailures.length === 1) throw cleanupFailures[0];
		if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, "SDK Python test cleanup failed.");
		const processResults = cleanupResults.slice(4);
		expect(processResults.every(result => result.status === "fulfilled" && result.value === true)).toBe(true);
	}, 30_000);

	it("does not dispose unrelated Python owners when createAgentSession fails after session construction", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const unrelatedKernel = createMockKernel();
		const unrelatedCwd = path.join(tempDir, "unrelated-after");
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValueOnce(unrelatedKernel as unknown as PythonKernelInstance);
		const throwingRegistry = new AgentRegistry();
		vi.spyOn(throwingRegistry, "register").mockImplementation(() => {
			throw new Error("Agent registry failed");
		});

		await pythonExecutor.executePython("print('unrelated after')", {
			cwd: unrelatedCwd,
			sessionId: "unrelated-after-session",
			kernelMode: "session",
			kernelOwnerId: "other-owner",
		});

		await expect(
			createAgentSession({
				cwd,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(cwd),
				settings: Settings.isolated({ "python.kernelMode": "session", "memory.backend": "local" }),
				model: getModel(),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				toolNames: ["eval"],
				workspaceTree: emptyWorkspaceTree(cwd),
				agentRegistry: throwingRegistry,
			}),
		).rejects.toThrow("Agent registry failed");

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(unrelatedKernel.shutdown).not.toHaveBeenCalled();

		const replacementKernel = createMockKernel();
		startSpy.mockResolvedValueOnce(replacementKernel as unknown as PythonKernelInstance);
		await pythonExecutor.executePython("print('fresh warmup after')", {
			cwd,
			sessionId: `cwd:${cwd}`,
			kernelMode: "session",
			kernelOwnerId: "fresh-owner-after",
		});
		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(replacementKernel.execute).toHaveBeenCalledTimes(1);
		expect(replacementKernel.execute).toHaveBeenCalledTimes(1);

		await pythonExecutor.executePython("print('still alive after')", {
			cwd: unrelatedCwd,
			sessionId: "unrelated-after-session",
			kernelMode: "session",
			kernelOwnerId: "other-owner",
		});

		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(unrelatedKernel.execute).toHaveBeenCalledTimes(2);
	});

	it("waits for active SDK session Python work before releasing a shared retained kernel", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const kernel = new FakeKernel();
		const blockedExecution = Promise.withResolvers<typeof OK_EXECUTION>();
		const blockedExecutionStarted = Promise.withResolvers<void>();
		let blockedExecutionSettled = false;
		blockedExecution.promise.then(
			() => {
				blockedExecutionSettled = true;
			},
			() => {
				blockedExecutionSettled = true;
			},
		);
		kernel.blockedCode = "print('first')";
		kernel.blockedExecution = blockedExecution.promise;
		kernel.blockedExecutionStarted = () => blockedExecutionStarted.resolve();
		kernel.blockedExecutionReject = error => blockedExecution.reject(error);
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValue(kernel as unknown as PythonKernelInstance);
		const firstSession = await createSession(tempDir, cwd);
		const secondSession = await createSession(tempDir, cwd);
		expect(startSpy).toHaveBeenCalledTimes(0);
		let firstDisposed = false;

		try {
			const firstExecution = firstSession.executePython("print('first')");
			let firstExecutionSettled = false;
			const observedFirstExecution = firstExecution.finally(() => {
				firstExecutionSettled = true;
			});
			await blockedExecutionStarted.promise;

			const disposeFirst = firstSession.dispose().then(() => {
				expect(blockedExecutionSettled).toBe(true);
				expect(firstExecutionSettled).toBe(true);
				firstDisposed = true;
			});
			await Bun.sleep(0);
			expect(firstDisposed).toBe(false);
			expect(blockedExecutionSettled).toBe(false);
			expect(firstExecutionSettled).toBe(false);

			const secondExecution = secondSession.executePython("print('second')");
			await Bun.sleep(0);

			expect(firstDisposed).toBe(false);
			expect(blockedExecutionSettled).toBe(false);
			expect(firstExecutionSettled).toBe(false);
			expect(kernel.shutdownCalls).toBe(0);

			blockedExecution.resolve(OK_EXECUTION);
			await Promise.all([observedFirstExecution, secondExecution, disposeFirst]);

			expect(startSpy).toHaveBeenCalledTimes(1);
			expect(kernel.shutdownCalls).toBe(0);
			expect(kernel.executeCalls).toEqual(["print('first')", "print('second')"]);

			await secondSession.executePython("print('third')");

			expect(startSpy).toHaveBeenCalledTimes(1);
			expect(kernel.executeCalls).toEqual(["print('first')", "print('second')", "print('third')"]);
		} finally {
			if (!firstDisposed) {
				await firstSession.dispose();
			}
			await secondSession.dispose();
		}

		expect(kernel.shutdownCalls).toBe(1);
	});
	it("aborts tracked eval execution during session dispose after warmup completes", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const blockedExecuteStarted = Promise.withResolvers<void>();
		const executeSpy = vi.spyOn(pythonExecutor, "executePython").mockImplementation(async (_code, options) => {
			const signal = options?.signal;
			if (!signal) {
				throw new Error("Expected abort signal");
			}
			blockedExecuteStarted.resolve();
			return await new Promise(resolve => {
				const onAbort = () =>
					resolve({
						output: "Command aborted",
						exitCode: undefined,
						cancelled: true,
						truncated: false,
						totalLines: 1,
						totalBytes: 15,
						outputLines: 1,
						outputBytes: 15,
						displayOutputs: [],
						stdinRequested: false,
					});
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			});
		});
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });

		const session = await createSession(tempDir, cwd);
		const EvalTool = session.getToolByName("eval");
		expect(EvalTool).toBeDefined();
		let toolExecutionSettled = false;
		const toolExecution = EvalTool!
			.execute("call-id", { cells: [{ language: "py", code: "print('tool')" }] }, undefined, undefined, undefined)
			.finally(() => {
				toolExecutionSettled = true;
			});
		await blockedExecuteStarted.promise;
		const sleepSpy = mockLongPythonDisposeSleepsImmediate();

		let disposed = false;
		const disposeSession = session.dispose().then(() => {
			disposed = true;
		});

		const [toolResult] = await Promise.all([toolExecution, disposeSession]);

		expect(sleepSpy.mock.calls.some(([duration]) => isPythonDisposeWaitDuration(duration))).toBe(true);

		expect(disposed).toBe(true);
		expect(toolExecutionSettled).toBe(true);
		expect(executeSpy).toHaveBeenCalledTimes(1);
		expect(toolResult.details?.isError).toBe(true);
		expect(toolResult.content).toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("Command aborted") }),
		);
	});

	it("retains kernel ownership cleanup until blocked Python work settles", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const kernel = new FakeKernel();
		const blockedExecution = Promise.withResolvers<typeof OK_EXECUTION>();
		const blockedExecutionStarted = Promise.withResolvers<void>();
		kernel.blockedCode = "print('blocked')";
		kernel.blockedExecution = blockedExecution.promise;
		kernel.blockedExecutionStarted = () => blockedExecutionStarted.resolve();
		kernel.abortBlockedExecution = false;

		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const sleepSpy = mockLongPythonDisposeSleepsImmediate();

		let kernelStarts = 0;
		vi.spyOn(pythonKernel.PythonKernel, "start").mockImplementation(async () => {
			kernelStarts += 1;
			return kernel as unknown as PythonKernelInstance;
		});

		const firstSession = await createSession(tempDir, cwd);
		const secondSession = await createSession(tempDir, cwd);

		let firstExecution: Promise<pythonExecutor.PythonResult> | undefined;
		let firstDisposeCaller: Promise<void> | undefined;
		let firstDisposeCompletion: Promise<void> | undefined;
		let secondDisposeCaller: Promise<void> | undefined;
		let secondDisposeCompletion: Promise<void> | undefined;
		let cleanupFailures: unknown[] = [];
		try {
			await secondSession.executePython("print('owner-b warmup')");
			firstExecution = firstSession.executePython("print('blocked')");
			await blockedExecutionStarted.promise;
			let firstExecutionSettled = false;
			void firstExecution.then(
				() => {
					firstExecutionSettled = true;
				},
				() => {
					firstExecutionSettled = true;
				},
			);

			let disposeRejectedAsIncomplete = false;
			firstDisposeCaller = firstSession.dispose().catch(error => {
				if (!isSessionDisposalIncompleteError(error)) throw error;
				disposeRejectedAsIncomplete = true;
			});
			await firstDisposeCaller;
			expect(sleepSpy.mock.calls.some(([duration]) => isPythonDisposeWaitDuration(duration))).toBe(true);
			expect(disposeRejectedAsIncomplete).toBe(true);
			expect(firstExecutionSettled).toBe(false);
			expect(kernel.shutdownCalls).toBe(0);
			expect(kernelStarts).toBe(1);

			blockedExecution.resolve(OK_EXECUTION);
			await expect(firstExecution).resolves.toMatchObject({
				cancelled: true,
				stdinRequested: false,
			});
			firstDisposeCompletion = firstSession.awaitDisposeCompletion();
			await firstDisposeCompletion;
			expect(firstExecutionSettled).toBe(true);
			expect(kernel.shutdownCalls).toBe(0);
			expect(kernelStarts).toBe(1);
			await secondSession.executePython("print('owner-b after detach')");
			expect(kernelStarts).toBe(1);
			expect(kernel.executeCalls).toEqual([
				"print('owner-b warmup')",
				"print('blocked')",
				"print('owner-b after detach')",
			]);
			secondDisposeCaller = secondSession.dispose();
			secondDisposeCompletion = secondSession.awaitDisposeCompletion();
			await Promise.all([firstDisposeCompletion, secondDisposeCaller, secondDisposeCompletion]);
			expect(kernel.shutdownCalls).toBe(1);
		} finally {
			blockedExecution.resolve(OK_EXECUTION);
			const completions = [
				...(firstExecution ? [firstExecution] : []),
				...(firstDisposeCaller ? [firstDisposeCaller] : []),
				...(secondDisposeCaller ? [secondDisposeCaller] : []),
				firstSession.awaitDisposeCompletion(),
				secondSession.awaitDisposeCompletion(),
			];
			const results = await Promise.allSettled(completions);
			cleanupFailures = results.flatMap(result => (result.status === "rejected" ? [result.reason] : []));
		}
		if (cleanupFailures.length === 1) throw cleanupFailures[0];
		if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, "Python owner cleanup test failed.");
	}, 30_000);

	it("rejects direct session Python starts once dispose begins", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const executeSpy = vi.spyOn(pythonExecutor, "executePython").mockResolvedValue({
			output: "late",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 4,
			outputLines: 1,
			outputBytes: 4,
			displayOutputs: [],
			stdinRequested: false,
		});

		const session = await createSession(tempDir, cwd);
		const disposeSession = session.dispose();
		await expect(session.executePython("print('late')")).rejects.toThrow(
			"Python execution is unavailable while session disposal is in progress",
		);
		await disposeSession;
		expect(executeSpy).not.toHaveBeenCalled();
	});

	it("rejects direct session Python starts after an async user_python hook yields during dispose", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const hookStarted = Promise.withResolvers<void>();
		const releaseHook = Promise.withResolvers<void>();
		const hookExtension: ExtensionFactory = api => {
			api.on("user_python", async () => {
				hookStarted.resolve();
				await releaseHook.promise;
				return undefined;
			});
		};
		const executeSpy = vi.spyOn(pythonExecutor, "executePython").mockResolvedValue({
			output: "late",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 4,
			outputLines: 1,
			outputBytes: 4,
			displayOutputs: [],
			stdinRequested: false,
		});

		const session = await createSession(tempDir, cwd, { extensions: [hookExtension] });
		const execution = session.executePython("print('late after hook')");
		await hookStarted.promise;
		let disposed = false;
		const disposeSession = session.dispose().then(() => {
			disposed = true;
		});
		await Bun.sleep(0);
		expect(disposed).toBe(false);
		releaseHook.resolve();
		await expect(execution).rejects.toThrow("Python execution is unavailable while session disposal is in progress");
		await disposeSession;
		expect(disposed).toBe(true);
		expect(executeSpy).not.toHaveBeenCalled();
	}, 10000);

	it("uses Python context captured before an async user_python hook", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const changedCwd = path.join(tempDir, "changed-project");
		fs.mkdirSync(changedCwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, tempDir);
		const changedSessionManager = SessionManager.create(changedCwd, tempDir);
		const sessionFile = sessionManager.getSessionFile();
		const changedSessionFile = changedSessionManager.getSessionFile();
		if (!sessionFile || !changedSessionFile) throw new Error("Expected persisted session files");
		await changedSessionManager.close();
		const hookStarted = Promise.withResolvers<void>();
		const releaseHook = Promise.withResolvers<void>();
		const hookExtension: ExtensionFactory = api => {
			api.on("user_python", async () => {
				hookStarted.resolve();
				await releaseHook.promise;
				return undefined;
			});
		};
		const session = await createSession(tempDir, cwd, { extensions: [hookExtension], sessionManager });
		let liveCwd = cwd;
		let liveSessionFile = sessionFile;
		vi.spyOn(sessionManager, "getCwd").mockImplementation(() => liveCwd);
		vi.spyOn(sessionManager, "getSessionFile").mockImplementation(() => liveSessionFile);
		const executeSpy = vi.spyOn(pythonExecutor, "executePython");

		const execution = session.executePython("print('captured context')");
		await hookStarted.promise;
		liveCwd = changedCwd;
		liveSessionFile = changedSessionFile;
		releaseHook.resolve();
		const result = await execution;

		expect(result.output).toContain("captured context");
		const dispatchedOptions = executeSpy.mock.calls[0]?.[1];
		expect(dispatchedOptions?.cwd).toBe(cwd);
		expect(dispatchedOptions?.sessionId).toBe(`session:${sessionFile}:cwd:${cwd}`);
		expect(typeof dispatchedOptions?.kernelOwnerId).toBe("string");
	}, 10000);

	it("rejects async user_python hook results after dispose begins", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const hookStarted = Promise.withResolvers<void>();
		const releaseHook = Promise.withResolvers<void>();
		const hookExtension: ExtensionFactory = api => {
			api.on("user_python", async () => {
				hookStarted.resolve();
				await releaseHook.promise;
				return {
					result: {
						output: "hooked late",
						exitCode: 0,
						cancelled: false,
						truncated: false,
						totalLines: 1,
						totalBytes: 11,
						outputLines: 1,
						outputBytes: 11,
						displayOutputs: [],
						stdinRequested: false,
					},
				};
			});
		};
		const executeSpy = vi.spyOn(pythonExecutor, "executePython").mockResolvedValue({
			output: "late",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 4,
			outputLines: 1,
			outputBytes: 4,
			displayOutputs: [],
			stdinRequested: false,
		});

		const session = await createSession(tempDir, cwd, { extensions: [hookExtension] });
		const execution = session.executePython("print('late hook result')");
		await hookStarted.promise;
		let disposed = false;
		const disposeSession = session.dispose().then(() => {
			disposed = true;
		});
		await Bun.sleep(0);
		expect(disposed).toBe(false);
		releaseHook.resolve();
		await expect(execution).rejects.toThrow("Python execution is unavailable while session disposal is in progress");
		await disposeSession;
		expect(disposed).toBe(true);
		expect(executeSpy).not.toHaveBeenCalled();
		expect(session.messages.some(message => message.role === "pythonExecution")).toBe(false);
	}, 10000);

	it("rejects eval starts once dispose begins", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const executeSpy = vi.spyOn(pythonExecutor, "executePython").mockResolvedValue({
			output: "late",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 4,
			outputLines: 1,
			outputBytes: 4,
			displayOutputs: [],
			stdinRequested: false,
		});

		const session = await createSession(tempDir, cwd);
		const EvalTool = session.getToolByName("eval");
		expect(EvalTool).toBeDefined();
		const disposeSession = session.dispose();
		await expect(
			EvalTool!.execute(
				"call-id",
				{ cells: [{ language: "py", code: "print('late')" }] },
				undefined,
				undefined,
				undefined,
			),
		).rejects.toThrow("Python execution is unavailable while session disposal is in progress");
		await disposeSession;
		expect(executeSpy).not.toHaveBeenCalled();
	});

	it("rejects eval starts that reach async preflight after dispose begins", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const executeSpy = vi.spyOn(pythonExecutor, "executePython").mockResolvedValue({
			output: "late",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 4,
			outputLines: 1,
			outputBytes: 4,
			displayOutputs: [],
			stdinRequested: false,
		});
		const artifactStarted = Promise.withResolvers<void>();
		const releaseArtifact = Promise.withResolvers<void>();
		const sessionManager = SessionManager.inMemory(cwd);
		vi.spyOn(sessionManager, "allocateArtifactPath").mockImplementation(async () => {
			artifactStarted.resolve();
			await releaseArtifact.promise;
			return {};
		});

		const session = await createSession(tempDir, cwd, { sessionManager });
		const EvalTool = session.getToolByName("eval");
		expect(EvalTool).toBeDefined();
		const execution = EvalTool!.execute(
			"call-id",
			{ cells: [{ language: "py", code: "print('late after artifact')" }] },
			undefined,
			undefined,
			undefined,
		);
		await artifactStarted.promise;
		const disposeSession = session.dispose();
		releaseArtifact.resolve();
		await expect(execution).rejects.toThrow("Python execution is unavailable while session disposal is in progress");
		await disposeSession;
		expect(executeSpy).not.toHaveBeenCalled();
	});

	it("cancels held eval availability before allocating output or dispatching Python", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const changedCwd = path.join(tempDir, "changed-project");
		fs.mkdirSync(changedCwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, tempDir);
		const changedSessionManager = SessionManager.create(changedCwd, tempDir);
		const sessionFile = sessionManager.getSessionFile();
		const changedSessionFile = changedSessionManager.getSessionFile();
		if (!sessionFile || !changedSessionFile) throw new Error("Expected persisted session files");
		await changedSessionManager.close();
		const preflightStarted = Promise.withResolvers<void>();
		const releasePreflight = Promise.withResolvers<void>();
		const checkAvailability = pythonBackend.isAvailable.bind(pythonBackend);
		let preflightContext:
			| {
					cwd: string;
					getSessionFile: () => string | null;
					getEvalKernelOwnerId?: () => string | null;
			  }
			| undefined;
		const availabilitySpy = vi.spyOn(pythonBackend, "isAvailable").mockImplementation(async activeSession => {
			preflightContext = activeSession;
			preflightStarted.resolve();
			await releasePreflight.promise;
			return await checkAvailability(activeSession);
		});
		const allocateArtifactSpy = vi.spyOn(sessionManager, "allocateArtifactPath");
		const dispatchSpy = vi.spyOn(pythonBackend, "execute");
		const session = await createSession(tempDir, cwd, { sessionManager });
		let liveCwd = cwd;
		let liveSessionFile = sessionFile;
		vi.spyOn(sessionManager, "getCwd").mockImplementation(() => liveCwd);
		vi.spyOn(sessionManager, "getSessionFile").mockImplementation(() => liveSessionFile);
		const EvalTool = session.getToolByName("eval");
		expect(EvalTool).toBeDefined();
		const caller = new AbortController();
		const execution = EvalTool!.execute(
			"call-id",
			{ cells: [{ language: "py", code: "print('must not dispatch')" }] },
			caller.signal,
			undefined,
			undefined,
		);

		await preflightStarted.promise;
		expect(session.isEvalRunning).toBe(true);
		liveCwd = changedCwd;
		liveSessionFile = changedSessionFile;
		caller.abort();
		releasePreflight.resolve();
		await expect(execution).rejects.toThrow("Operation aborted");

		expect(availabilitySpy).toHaveBeenCalledTimes(1);
		expect(preflightContext?.cwd).toBe(cwd);
		expect(preflightContext?.getSessionFile()).toBe(sessionFile);
		expect(typeof preflightContext?.getEvalKernelOwnerId?.()).toBe("string");
		expect(allocateArtifactSpy).not.toHaveBeenCalled();
		expect(dispatchSpy).not.toHaveBeenCalled();
		expect(session.isEvalRunning).toBe(false);
		await session.dispose();
	});

	it("aborts every active Python execution owned by the session during dispose", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const firstStarted = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const executePython = pythonExecutor.executePython;
		vi.spyOn(pythonExecutor, "executePython").mockImplementation((code, options) => {
			const execution = executePython(code, options);
			if (code === "print('second')") secondStarted.resolve();
			return execution;
		});
		const session = await createSession(tempDir, cwd);
		const firstExecution = session.executePython("import time; print('first', flush=True); time.sleep(30)", chunk => {
			if (chunk.includes("first")) firstStarted.resolve();
		});
		await firstStarted.promise;
		const secondExecution = session.executePython("print('second')");
		await secondStarted.promise;
		await session.dispose();
		const [firstResult, secondResult] = await Promise.all([firstExecution, secondExecution]);
		expect(firstResult.cancelled).toBe(true);
		expect(secondResult.cancelled).toBe(true);
		expect(secondResult.output).not.toContain("second");
		expect(session.isEvalRunning).toBe(false);
	}, 30_000);
});
