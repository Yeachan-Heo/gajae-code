import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@gajae-code/agent-core";
import { formatSessionDumpText, SessionManager } from "@gajae-code/coding-agent";
import { TempDir } from "@gajae-code/utils";
import { generateReport } from "../src/report";
import { buildBenchmarkResult, type TaskRunResult, writeConversationDump } from "../src/runner";
import type { EditTask } from "../src/tasks";

const tempDirs: TempDir[] = [];

async function createTempDir(prefix: string): Promise<TempDir> {
	const dir = await TempDir.create(prefix);
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map(async dir => {
			await dir.remove();
		}),
	);
});

function createTask(id: string): EditTask {
	return {
		id,
		name: id,
		prompt: `Fix ${id}`,
		files: [`${id}.ts`],
		inputDir: "/tmp/input",
		expectedDir: "/tmp/expected",
	};
}

function createRun(runIndex: number, success: boolean): TaskRunResult {
	return {
		runIndex,
		success,
		patchApplied: success,
		verificationPassed: success,
		tokens: { input: 12, output: 8, total: 20 },
		duration: 100,
		toolCalls: {
			read: 1,
			edit: 1,
			write: 0,
			editSuccesses: success ? 1 : 0,
			editFailures: success ? 0 : 1,
			editWarnings: 0,
			editAutocorrects: 0,
			totalInputChars: 50,
		},
		editFailures: [],
		editWarnings: [],
		editAutocorrectCount: 0,
	};
}

describe("buildBenchmarkResult", () => {
	it("summarizes completed runs without requiring every scheduled run to finish", () => {
		const completedTask = createTask("completed");
		const pendingTask = createTask("pending");
		const resultsByTask = new Map([[completedTask.id, [createRun(0, true)]]]);

		const result = buildBenchmarkResult({
			tasks: [completedTask, pendingTask],
			config: {
				provider: "anthropic",
				model: "claude",
				runsPerTask: 2,
				timeout: 1000,
				taskConcurrency: 1,
			},
			resultsByTask,
			startTime: "2026-04-28T00:00:00.000Z",
			endTime: "2026-04-28T00:00:01.000Z",
		});

		expect(result.summary.totalTasks).toBe(2);
		expect(result.summary.totalRuns).toBe(1);
		expect(result.summary.successfulRuns).toBe(1);
		expect(result.tasks.find(task => task.id === "pending")?.runs).toEqual([]);
		expect(result.startTime).toBe("2026-04-28T00:00:00.000Z");
		expect(result.endTime).toBe("2026-04-28T00:00:01.000Z");
	});

	it("can generate a report before any run completes", () => {
		const result = buildBenchmarkResult({
			tasks: [createTask("pending")],
			config: {
				provider: "anthropic",
				model: "claude",
				runsPerTask: 2,
				timeout: 1000,
				taskConcurrency: 1,
			},
			resultsByTask: new Map(),
			startTime: "2026-04-28T00:00:00.000Z",
			endTime: "2026-04-28T00:00:01.000Z",
		});

		expect(result.summary.totalRuns).toBe(0);
		expect(generateReport(result)).toContain("| Total Runs | 0 |");
	});

	it("renders atom input args directly in edit error patch blocks", () => {
		const task = createTask("atom");
		const titleExpression = "$" + "{title}";
		const input = [
			"---orcid.ts",
			"276ka=    if (works.length > 0) {",
			"277fo=      for (const title of works) {",
			`278hu=        md += \`- ${titleExpression}\\n\`;`,
			"279he=      }",
			"280nd=    } else {",
			"281he=      md += 'No works available.\\n';",
			"282rd=    }",
		].join("\n");
		const failedRun: TaskRunResult = {
			...createRun(0, false),
			editFailures: [{ toolCallId: "edit-1", args: { input }, error: "No changes made" }],
		};
		const result = buildBenchmarkResult({
			tasks: [task],
			config: {
				provider: "anthropic",
				model: "claude",
				runsPerTask: 1,
				timeout: 1000,
				taskConcurrency: 1,
				editVariant: "atom",
			},
			resultsByTask: new Map([[task.id, [failedRun]]]),
			startTime: "2026-04-28T00:00:00.000Z",
			endTime: "2026-04-28T00:00:01.000Z",
		});

		const report = generateReport(result);
		expect(report).toContain(`\`\`\`diff\n${input}\n\`\`\``);
		expect(report).not.toContain('"input":');
	});

	it("summarizes edit failure categories including range-continuation", () => {
		const task = createTask("range");
		const input = "1aa..3cc=first\nsecond";
		const failedRun: TaskRunResult = {
			...createRun(0, false),
			editFailures: [
				{
					toolCallId: "edit-1",
					args: { input },
					error: "Diff line 2: unrecognized op.",
					category: "range-continuation",
				},
			],
		};
		const result = buildBenchmarkResult({
			tasks: [task],
			config: {
				provider: "anthropic",
				model: "claude",
				runsPerTask: 1,
				timeout: 1000,
				taskConcurrency: 1,
				editVariant: "atom",
			},
			resultsByTask: new Map([[task.id, [failedRun]]]),
			startTime: "2026-04-28T00:00:00.000Z",
			endTime: "2026-04-28T00:00:01.000Z",
		});

		expect(result.summary.editFailureCategories["range-continuation"]).toBe(1);
		const report = generateReport(result);
		expect(report).toContain("| range-continuation | 1 | 100.0% |");
		expect(report).toContain("- Category: range-continuation");
	});
});

describe("writeConversationDump", () => {
	it("writes benchmark conversations as session dumps and copies artifacts", async () => {
		const sourceRoot = await createTempDir("@typescript-edit-benchmark-source-");
		const dumpRoot = await createTempDir("@typescript-edit-benchmark-dump-");
		const sourceWorkDir = sourceRoot.join("worktree");
		const sourceSessionDir = sourceRoot.join("sessions");
		await fs.mkdir(sourceWorkDir, { recursive: true });
		await fs.mkdir(sourceSessionDir, { recursive: true });

		const sourceSession = SessionManager.create(sourceWorkDir, sourceSessionDir);
		const userMessage: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "Fix the failing benchmark." }],
			attribution: "user",
			timestamp: Date.now(),
		};
		sourceSession.appendMessage(userMessage);
		await sourceSession.ensureOnDisk();
		const artifactId = await sourceSession.saveArtifact("artifact contents", "read");
		await sourceSession.flush();
		// Artifact access is fenced once the manager starts closing, so capture the
		// dump inputs first and close the source session afterwards — the runner
		// disposes its client only after snapshotting the same fields.

		const sourceSessionFile = sourceSession.getSessionFile();
		if (!sourceSessionFile || !artifactId) {
			throw new Error("Test fixture failed to create source session dump");
		}
		const sourceArtifactPath = await sourceSession.getArtifactPath(artifactId);
		if (!sourceArtifactPath) {
			throw new Error("Test fixture failed to resolve source artifact path");
		}
		await sourceSession.close();

		const dumpPath = await writeConversationDump({
			dumpDir: dumpRoot.absolute(),
			taskId: "task/weird",
			runIndex: 0,
			snapshot: {
				messages: [userMessage],
				sourceSessionFile,
			},
		});

		expect(dumpPath).toBe(path.join(dumpRoot.absolute(), "task_weird", "run-1.md"));

		const dumpText = await Bun.file(dumpPath).text();
		const expectedBody = formatSessionDumpText({ messages: [userMessage] });
		expect(dumpText.trim()).toBe(expectedBody.trim());

		const copiedArtifactPath = path.join(dumpPath.slice(0, -3), path.basename(sourceArtifactPath));
		expect(await Bun.file(copiedArtifactPath).text()).toBe("artifact contents");
	});
});
