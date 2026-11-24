import { prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import analyzeFilePrompt from "../../../commit/agentic/prompts/analyze-file.md" with { type: "text" };
import type { CommitAgentState } from "../../../commit/agentic/state";
import type { NumstatEntry } from "../../../commit/types";
import type { ModelRegistry } from "../../../config/model-registry";
import type { Settings } from "../../../config/settings";
import type { CustomTool, CustomToolContext } from "../../../extensibility/custom-tools/types";
import type { AuthStorage } from "../../../session/auth-storage";
import { TaskTool } from "../../../task";
import type { SessionTaskPool } from "../../../task/task-pool";
import type { TaskParams } from "../../../task/types";
import type { ToolSession } from "../../../tools";
import { getFilePriority } from "./git-file-diff";

// Context holder for the session's task pool during tool execution.
// Set by the agent when the session is initialized and used by analyze-files.
let sessionTaskPoolContext: SessionTaskPool | undefined;

export function setAnalyzeFilesTaskPoolContext(pool: SessionTaskPool | undefined): void {
	sessionTaskPoolContext = pool;
}

const analyzeFileSchema = z.object({
	files: z.array(z.string().describe("file path")).min(1),
	goal: z.string().describe("analysis focus").optional(),
});

const analyzeFileOutputSchema = {
	properties: {
		summary: { type: "string" },
		highlights: { elements: { type: "string" } },
		risks: { elements: { type: "string" } },
	},
};

function buildToolSession(
	ctx: CustomToolContext,
	options: {
		cwd: string;
		authStorage: AuthStorage;
		modelRegistry: ModelRegistry;
		settings: Settings;
		spawns: string;
	},
	getTaskPool?: () => SessionTaskPool | undefined,
): ToolSession {
	return {
		cwd: options.cwd,
		hasUI: false,
		getSessionFile: () => ctx.sessionManager.getSessionFile() ?? null,
		getSessionSpawns: () => options.spawns,
		getTaskPool,
		settings: options.settings,
		authStorage: options.authStorage,
		modelRegistry: options.modelRegistry,
	};
}

export function createAnalyzeFileTool(options: {
	cwd: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	spawns: string;
	state: CommitAgentState;
	getTaskPool?: () => SessionTaskPool | undefined;
}): CustomTool<typeof analyzeFileSchema> {
	return {
		name: "analyze_files",
		label: "Analyze Files",
		description: "Spawn quick_task agents to analyze files.",
		parameters: analyzeFileSchema,
		async execute(toolCallId, params, onUpdate, ctx, signal) {
			// Use the context-provided pool or fall back to options if provided
			const getTaskPool = options.getTaskPool || (() => sessionTaskPoolContext);
			const toolSession = buildToolSession(ctx, options, getTaskPool);
			const taskTool = await TaskTool.create(toolSession);
			const numstat = options.state.overview?.numstat ?? [];
			const tasks = params.files.map((file, index) => {
				const relatedFiles = formatRelatedFiles(params.files, file, numstat);
				const assignment = prompt.render(analyzeFilePrompt, {
					file,
					goal: params.goal,
					related_files: relatedFiles,
				});
				return {
					id: `AnalyzeFile${index + 1}`,
					description: `Analyze ${file}`,
					assignment,
				};
			});
			const taskParams: TaskParams = {
				agent: "quick_task",
				schema: JSON.stringify(analyzeFileOutputSchema),
				tasks,
			};
			return taskTool.execute(toolCallId, taskParams, signal, onUpdate);
		},
	};
}

function inferFileType(path: string): string {
	const priority = getFilePriority(path);
	const lowerPath = path.toLowerCase();

	if (priority === -100) return "binary file";
	if (priority === 10) return "test file";
	if (lowerPath.endsWith(".md") || lowerPath.endsWith(".txt")) return "documentation";
	if (
		lowerPath.endsWith(".json") ||
		lowerPath.endsWith(".yaml") ||
		lowerPath.endsWith(".yml") ||
		lowerPath.endsWith(".toml")
	)
		return "configuration";
	if (priority === 70) return "dependency manifest";
	if (priority === 80) return "script";
	if (priority === 100) return "implementation";

	return "source file";
}

function formatRelatedFiles(files: string[], currentFile: string, numstat: NumstatEntry[]): string | undefined {
	const others = files.filter(file => file !== currentFile);
	if (others.length === 0) return undefined;

	const numstatMap = new Map(numstat.map(entry => [entry.path, entry]));

	const lines = others.map(file => {
		const entry = numstatMap.get(file);
		const fileType = inferFileType(file);
		if (entry) {
			const lineCount = entry.additions + entry.deletions;
			return `- ${file} (${lineCount} lines): ${fileType}`;
		}
		return `- ${file}: ${fileType}`;
	});

	return `OTHER FILES IN THIS CHANGE:\n${lines.join("\n")}`;
}
