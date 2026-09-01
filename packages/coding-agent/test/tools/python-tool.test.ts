import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@gajae-code/agent-core";
import { Settings } from "../../src/config/settings";
import * as pyExecutor from "../../src/eval/py/executor";
import { sessionIpykernelsDir } from "../../src/gjc-runtime/session-layout";
import { createSessionPythonTool, pythonKernelOwnerId } from "../../src/tools/python";

const KERNEL_TEST_TIMEOUT_MS = 35_000;
const PYTHON = Bun.which("python3") ?? Bun.which("python");
const HAS_PYTHON = PYTHON !== null;
const tempRoots: string[] = [];

type ToolCallParams = { action?: "execute" | "clear"; code?: string };

function textOf(result: AgentToolResult): string {
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

async function tempDir(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-python-tool-"));
	tempRoots.push(directory);
	return await fs.realpath(directory);
}

function createTool(cwd: string, sessionId: string): AgentTool {
	return createSessionPythonTool({
		cwd,
		settings: Settings.isolated(),
		getSessionId: () => sessionId,
		registerSessionCleanup: () => {},
	});
}

async function executeTool(tool: AgentTool, params: ToolCallParams): Promise<AgentToolResult> {
	return await tool.execute("python-tool-test", params);
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

function mockPythonResult(overrides: Partial<pyExecutor.PythonResult> = {}): pyExecutor.PythonResult {
	const output = overrides.output ?? "";
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

afterEach(async () => {
	await pyExecutor.disposeAllKernelSessions();
	vi.restoreAllMocks();
	await Promise.all(tempRoots.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe.skipIf(!HAS_PYTHON)("session Python tool real-kernel behavior", () => {
	it(
		"persists variables within one session",
		async () => {
			const cwd = await tempDir();
			const tool = createTool(cwd, "session-persistence");

			const assigned = await executeTool(tool, { code: "x = 1" });
			expect(assigned.isError).toBeUndefined();
			const printed = await executeTool(tool, { code: "print(x)" });
			expect(printed.isError).toBeUndefined();
			expect(textOf(printed)).toContain("1");
		},
		KERNEL_TEST_TIMEOUT_MS,
	);

	it(
		"isolates two concurrent sessions that execute against separate retained kernels",
		async () => {
			const cwd = await tempDir();
			const toolA = createTool(cwd, "session-a");
			const toolB = createTool(cwd, "session-b");
			await executeTool(toolA, { code: "x = 41" });

			const [sessionB, sessionA] = await Promise.all([
				executeTool(toolB, { code: "print('x' in globals())" }),
				executeTool(toolA, { code: "print(x)" }),
			]);

			expect(textOf(sessionB)).toContain("False");
			expect(textOf(sessionA)).toContain("41");
		},
		KERNEL_TEST_TIMEOUT_MS,
	);

	it(
		"starts a fresh session with a clean user namespace",
		async () => {
			const cwd = await tempDir();
			const first = createTool(cwd, "session-first");
			const fresh = createTool(cwd, "session-fresh");
			await executeTool(first, { code: "x = 41" });

			const result = await executeTool(fresh, { code: "print('x' in globals())" });
			expect(result.isError).toBeUndefined();
			expect(textOf(result)).toContain("False");
		},
		KERNEL_TEST_TIMEOUT_MS,
	);

	it(
		"runs the retained Python kernel from the session working directory",
		async () => {
			const cwd = await tempDir();
			const tool = createTool(cwd, "session-cwd");

			const result = await executeTool(tool, { code: "import os\nprint(os.getcwd())" });
			expect(result.isError).toBeUndefined();
			expect(textOf(result).trim()).toBe(cwd);
		},
		KERNEL_TEST_TIMEOUT_MS,
	);

	it(
		"clears exactly this session's retained kernel, starts clean, and rotates the transcript directory",
		async () => {
			const cwd = await tempDir();
			const sessionId = "session-clear";
			const tool = createTool(cwd, sessionId);
			const disposeSpy = vi.spyOn(pyExecutor, "disposeKernelSessionsByOwner");

			await executeTool(tool, { code: "old_value = 7" });
			const beforeClear = await transcriptDirectories(cwd, sessionId);
			expect(beforeClear).toHaveLength(1);
			await executeTool(tool, { action: "clear" });
			expect(disposeSpy).toHaveBeenCalledWith(pythonKernelOwnerId(sessionId));

			const fresh = await executeTool(tool, { code: "print('old_value' in globals())" });
			expect(fresh.isError).toBeUndefined();
			expect(textOf(fresh)).toContain("False");
			const afterClear = await transcriptDirectories(cwd, sessionId);
			expect(afterClear).toHaveLength(2);
			expect(afterClear.filter(directory => directory !== beforeClear[0])).toHaveLength(1);
		},
		KERNEL_TEST_TIMEOUT_MS,
	);

	it(
		"names real-kernel transcripts with the executor instance id observed from the retained kernel",
		async () => {
			const cwd = await tempDir();
			const sessionId = "session-instance-id";
			const ownerId = pythonKernelOwnerId(sessionId);
			const tool = createTool(cwd, sessionId);
			await executeTool(tool, { code: "value = 1" });
			const [directory] = await transcriptDirectories(cwd, sessionId);
			expect(directory).toMatch(/^\d{8}T\d{6}Z-[0-9a-f-]{36}$/);

			let observedInstanceId: string | undefined;
			await pyExecutor.executePython("pass", {
				cwd,
				sessionId: ownerId,
				kernelOwnerId: ownerId,
				kernelMode: "session",
				onKernelStart: id => {
					observedInstanceId = id;
				},
			});
			if (!observedInstanceId) throw new Error("Expected the retained executor to report an instance id");
			expect(directory).toEndWith(`-${observedInstanceId}`);
		},
		KERNEL_TEST_TIMEOUT_MS,
	);
});

describe("session Python tool unit contracts", () => {
	it("formats session kernel owner ids and rejects an execute without code", async () => {
		const cwd = await tempDir();
		const tool = createTool(cwd, "unit-session");

		expect(pythonKernelOwnerId("s1")).toBe("python:s1");
		const result = await executeTool(tool, { action: "execute" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe('Missing required "code" parameter for action "execute".');
	});

	it("persists truncated and cancelled execution flags in the transcript record", async () => {
		const cwd = await tempDir();
		const sessionId = "unit-flags";
		vi.spyOn(pyExecutor, "executePython").mockImplementation(async (_code, options) => {
			options?.onKernelStart?.("unit-kernel");
			return mockPythonResult({
				output: "truncated cancellation",
				exitCode: undefined,
				cancelled: true,
				truncated: true,
			});
		});
		const tool = createTool(cwd, sessionId);

		await executeTool(tool, { code: "long_running()" });
		const [directory] = await transcriptDirectories(cwd, sessionId);
		expect(directory).toMatch(/-unit-kernel$/);
		expect(await transcriptRecords(cwd, sessionId, directory!)).toEqual([
			expect.objectContaining({
				code: "long_running()",
				cancelled: true,
				truncated: true,
				exitCode: null,
			}),
		]);
	});

	it("resolves the session settings accessor at execution time", async () => {
		const cwd = await tempDir();
		const launchSettings = Settings.isolated();
		const liveSettings = Settings.isolated();
		const settingsSeen: unknown[] = [];
		vi.spyOn(pyExecutor, "executePython").mockImplementation(async (_code, options) => {
			settingsSeen.push(options?.settings);
			return mockPythonResult({ output: "live settings" });
		});
		const tool = createSessionPythonTool({
			cwd,
			settings: launchSettings,
			getSettings: () => liveSettings,
			getSessionId: () => "live-settings",
			registerSessionCleanup: () => {},
		});

		await executeTool(tool, { code: "print('settings')" });

		expect(settingsSeen).toEqual([liveSettings]);
	});
});
