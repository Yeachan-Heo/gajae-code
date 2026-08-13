import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { autoresearchKernelOwnerId } from "../../src/autoresearch/python-tool";
import {
	createMissionPythonTool,
	missionArtifactsDir,
	missionRlmSessionId,
	openMissionNotebook,
} from "../../src/autoresearch/session";
import { readNotebookDocument } from "../../src/edit/notebook";
import * as pyExecutor from "../../src/eval/py/executor";

const tempRoots: string[] = [];
const TEST_SESSION_ID = "test-session";
let previousGjcSessionId: string | undefined;

// State writes require an explicit session id. Pin one instead of inheriting the
// ambient GJC_SESSION_ID, which is set when the suite runs inside a live GJC
// session and absent on a clean runner -- that difference made these tests pass
// locally while failing in CI.
beforeAll(() => {
	previousGjcSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
});

afterAll(() => {
	if (previousGjcSessionId === undefined) {
		delete process.env.GJC_SESSION_ID;
	} else {
		process.env.GJC_SESSION_ID = previousGjcSessionId;
	}
});

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-autoresearch-session-"));
	tempRoots.push(dir);
	return dir;
}

function fakePythonResult(overrides: Partial<pyExecutor.PythonResult> = {}): pyExecutor.PythonResult {
	return {
		output: "42\n",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		totalLines: 1,
		totalBytes: 3,
		outputLines: 1,
		outputBytes: 3,
		displayOutputs: [],
		stdinRequested: false,
		...overrides,
	};
}

async function executeTool(
	tool: { execute(...args: unknown[]): Promise<unknown> },
	code: string,
): Promise<{ content: Array<{ type: string; text?: string }> }> {
	return (await tool.execute("test-call", { code }, undefined, undefined, undefined)) as {
		content: Array<{ type: string; text?: string }>;
	};
}

describe("autoresearch mission session wiring (kernel + notebook)", () => {
	it("derives a filesystem-safe rlm session id from the mission slug", () => {
		expect(missionRlmSessionId({ slug: "tokenizer-mission" })).toBe("tokenizer-mission");
		expect(missionRlmSessionId({ slug: "Mission.With.Dots" })).toBe("Mission-With-Dots");
		expect(() => missionRlmSessionId({ slug: "!!! " })).toThrow("stable artifact identity");
	});

	it("opens the mission notebook under the session autoresearch runs dir and persists cells", async () => {
		const root = await tempDir();
		const mission = { slug: "tokenizer-mission" };
		const { writer, paths } = await openMissionNotebook(root, mission);

		expect(path.basename(paths.notebookPath)).toBe("notebook.ipynb");
		expect(paths.notebookPath).toContain(path.join(".gjc"));
		expect(paths.notebookPath).toContain("autoresearch");
		expect(paths.notebookPath).toContain("runs");
		expect(missionArtifactsDir(root, mission)).toBe(path.join(paths.dir, "artifacts"));

		await writer.appendCode("x = 1", {
			output: "1",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			displayOutputs: [],
		});
		await writer.flush();

		const persisted = await readNotebookDocument(paths.notebookPath, paths.notebookPath);
		expect(persisted.cells).toHaveLength(1);
		expect(persisted.cells[0]!.cell_type).toBe("code");
		expect(JSON.stringify(persisted.cells[0]!.source)).toContain("x = 1");
	});

	it("resumes a persisted notebook when the mission is reopened", async () => {
		const root = await tempDir();
		const mission = { slug: "resume-mission" };
		const first = await openMissionNotebook(root, mission);
		await first.writer.appendCode("seed = 1", {
			output: "",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			displayOutputs: [],
		});
		await first.writer.flush();

		const second = await openMissionNotebook(root, mission);
		expect(second.writer.cellCount).toBe(1);
		await second.writer.appendCode("seed = 2", {
			output: "",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			displayOutputs: [],
		});
		await second.writer.flush();
		expect(second.writer.cellCount).toBe(2);
	});

	it("keeps identical mission slugs isolated across GJC sessions", async () => {
		const root = await tempDir();
		const mission = { slug: "same-mission" };
		const first = await openMissionNotebook(root, mission, "session-one");
		const second = await openMissionNotebook(root, mission, "session-two");
		expect(first.paths.dir).not.toBe(second.paths.dir);
		expect(missionArtifactsDir(root, mission, "session-one")).not.toBe(
			missionArtifactsDir(root, mission, "session-two"),
		);
		const executeSpy = vi.spyOn(pyExecutor, "executePython").mockResolvedValue(fakePythonResult());
		try {
			const firstTool = createMissionPythonTool({
				cwd: root,
				mission,
				artifactsDir: missionArtifactsDir(root, mission, "session-one"),
				notebook: first.writer,
				registerSessionCleanup: () => {},
				sessionId: "session-one",
			});
			const secondTool = createMissionPythonTool({
				cwd: root,
				mission,
				artifactsDir: missionArtifactsDir(root, mission, "session-two"),
				notebook: second.writer,
				registerSessionCleanup: () => {},
				sessionId: "session-two",
			});
			await executeTool(firstTool, "one = 1");
			await executeTool(secondTool, "two = 2");
			expect((executeSpy.mock.calls[0]![1] as pyExecutor.PythonExecutorOptions).kernelOwnerId).not.toBe(
				(executeSpy.mock.calls[1]![1] as pyExecutor.PythonExecutorOptions).kernelOwnerId,
			);
		} finally {
			executeSpy.mockRestore();
		}
	});

	it("binds the mission python tool to the mission slug as kernel owner and records every call as a notebook cell", async () => {
		const executeSpy = vi.spyOn(pyExecutor, "executePython").mockResolvedValue(fakePythonResult());
		try {
			const root = await tempDir();
			const mission = { slug: "cell-recording-mission" };
			const { writer, paths } = await openMissionNotebook(root, mission);
			const tool = createMissionPythonTool({
				cwd: root,
				mission,
				artifactsDir: missionArtifactsDir(root, mission),
				notebook: writer,
				registerSessionCleanup: () => {},
			});

			await executeTool(tool, "answer = 40 + 2");
			await executeTool(tool, "print(answer)");
			await writer.flush();

			// Kernel owner id is scoped by both the mission and GJC session, never the eval owner.
			expect(autoresearchKernelOwnerId(mission.slug)).toBe("autoresearch:cell-recording-mission");
			const options = executeSpy.mock.calls[0]![1] as pyExecutor.PythonExecutorOptions;
			expect(options.sessionId).toBe("autoresearch:test-session:cell-recording-mission");
			expect(options.kernelOwnerId).toBe("autoresearch:test-session:cell-recording-mission");
			expect(executeSpy).toHaveBeenCalledTimes(2);

			// Every executed call is recorded as a notebook cell.
			const persisted = await readNotebookDocument(paths.notebookPath, paths.notebookPath);
			expect(persisted.cells).toHaveLength(2);
			expect(persisted.cells[0]!.cell_type).toBe("code");
			expect(JSON.stringify(persisted.cells[0]!.source)).toContain("answer = 40 + 2");
			expect(JSON.stringify(persisted.cells[1]!.source)).toContain("print(answer)");
		} finally {
			executeSpy.mockRestore();
		}
	});

	it("refuses to run when no mission id can be resolved", async () => {
		const root = await tempDir();
		const { writer } = await openMissionNotebook(root, { slug: "no-mission" });
		const tool = createMissionPythonTool({
			cwd: root,
			mission: { slug: "no-mission" },
			artifactsDir: missionArtifactsDir(root, { slug: "no-mission" }),
			notebook: writer,
			registerSessionCleanup: () => {},
		});
		const executeSpy = vi.spyOn(pyExecutor, "executePython").mockResolvedValue(fakePythonResult());
		try {
			const callable = tool as unknown as {
				execute(
					toolCallId: string,
					params: { action: "execute"; code: string },
				): Promise<{ content: Array<{ type: string; text?: string }> }>;
			};
			const result = await callable.execute("test-call", { action: "execute", code: "print(1)" });
			const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
			expect(text).toContain("42");
			expect(executeSpy).toHaveBeenCalledTimes(1);
		} finally {
			executeSpy.mockRestore();
		}
	});
});
