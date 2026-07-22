/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Discovers agent definitions from:
 *   - Bundled agents (shipped with gjc-coding-agent)
 *   - ~/.gjc/agent/agents/*.md (user-level)
 *   - .gjc/agents/*.md (project-level)
 *
 * Supports:
 *   - Single agent execution
 *   - Parallel execution with concurrency limits
 *   - Progress tracking via JSON events
 *   - Session artifacts for debugging
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import type { Model, Usage } from "@gajae-code/ai";
import { $pickenv, prompt, Snowflake } from "@gajae-code/utils";
import type { ToolSession } from "..";
import { AsyncJobManager, OwnerSubagentShutdownError, type ResumeRunner } from "../async";
import { resolveAgentModelPatterns } from "../config/model-resolver";
import type { Theme } from "../modes/theme/theme";
import planModeSubagentPrompt from "../prompts/system/plan-mode-subagent.md" with { type: "text" };
import taskDescriptionTemplate from "../prompts/tools/task.md" with { type: "text" };
import taskSummaryTemplate from "../prompts/tools/task-summary.md" with { type: "text" };
import type { ForkContextSeed } from "../session/agent-session";
import { formatBytes, formatDuration } from "../tools/render-utils";
import {
	type AgentDefinition,
	type AgentProgress,
	type ForkContextMode,
	type ForkContextPolicy,
	getTaskSchema,
	hasCompleteAggregateUsageCostBreakdown,
	type SingleResult,
	type TaskItem,
	type TaskParams,
	type TaskToolDetails,
	type TaskToolSchemaInstance,
} from "./types";

// Import review tools for side effects (registers subagent tool handlers)
import "../tools/review";
import { initializeLocalRoot, type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls";
import { generateCommitMessage } from "../utils/commit-message-generator";
import * as git from "../utils/git";
import { discoverAgents, filterVisibleAgents, getAgent } from "./discovery";
import { createManagedTaskPersistence, renderSubagentUserPrompt, runSubprocess } from "./executor";
import { adviseForkContextMode } from "./fork-context-advisory";
import { FORK_CONTEXT_TOKEN_BUDGET_BY_MODE } from "./fork-context-budget";
import { getTaskIdValidationError, validateAllocatedTaskId } from "./id";
import { AgentOutputManager } from "./output-manager";
import { mapWithConcurrencyLimit, Semaphore } from "./parallel";
import { assertNoRawTaskFields, buildTaskReceipt, buildTaskRoiSummary } from "./receipt";

import { renderResult, renderCall as renderTaskCall } from "./render";
import { reconcileSpawnRoi } from "./roi-reconciliation";
import { getTaskSimpleModeCapabilities, type TaskSimpleMode } from "./simple-mode";
import { DEFAULT_SPAWN_THRESHOLD, evaluateSpawnGate } from "./spawn-gate";
import {
	applyNestedPatches,
	captureBaseline,
	captureDeltaPatch,
	cleanupIsolation,
	cleanupTaskBranches,
	commitToBranch,
	ensureIsolation,
	getRepoRoot,
	type IsolationHandle,
	mergeTaskBranches,
	parseIsolationMode,
	type WorktreeBaseline,
} from "./worktree";

interface TaskResumeDescriptor {
	toolCallId: string;
	params: TaskParams;
	task: TaskItem & { id: string };
	sessionFile: string | null;
	forkContextSeed?: ForkContextSeed;
	agentSource: AgentDefinition["source"];
}

function isTaskResumeDescriptor(value: unknown): value is TaskResumeDescriptor {
	return typeof value === "object" && value !== null && "task" in value && "params" in value;
}
function renderTaskAssignment(assignment: string, simpleMode: TaskSimpleMode): string {
	return renderSubagentUserPrompt(assignment, simpleMode === "independent");
}
function createUsageTotals(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsageTotals(target: Usage, usage: Partial<Usage>): void {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	const cost =
		usage.cost ??
		({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		} satisfies Usage["cost"]);

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens += totalTokens;
	target.cost.input += cost.input;
	target.cost.output += cost.output;
	target.cost.cacheRead += cost.cacheRead;
	target.cost.cacheWrite += cost.cacheWrite;
	target.cost.total += cost.total;
}

function validateTaskIdsForScheduling(tasks: readonly TaskItem[]): string | undefined {
	const invalid: string[] = [];
	for (let i = 0; i < tasks.length; i++) {
		const error = getTaskIdValidationError(tasks[i]?.id);
		if (error) invalid.push(`index ${i}: ${error}`);
	}
	return invalid.length > 0 ? `Invalid task ids: ${invalid.join(" ")}` : undefined;
}

// Re-export types and utilities
export { loadBundledAgents as BUNDLED_AGENTS } from "./agents";
export { discoverCommands, expandCommand, getCommand } from "./commands";
export { discoverAgents, getAgent } from "./discovery";
export {
	isValidAllocatedTaskId,
	isValidTaskId,
	TASK_ID_DESCRIPTION,
	TASK_ID_PATTERN,
	validateAllocatedTaskId,
	validateTaskId,
} from "./id";
export { AgentOutputManager } from "./output-manager";
export type { TaskResultReceipt } from "./receipt";
export {
	assertNoRawTaskFields,
	buildTaskReceipt,
	buildTaskRoi,
	buildTaskRoiSummary,
	findRawTaskLeakKeys,
	sanitizeTaskToolDetails,
} from "./receipt";
export type {
	AgentDefinition,
	AgentProgress,
	SingleResult,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	TaskParams,
	TaskToolDetails,
} from "./types";
export {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	taskSchema,
} from "./types";

/**
 * Render the tool description from a cached agent list and current settings.
 */
function hasAvailableIrcTool(session: ToolSession): boolean {
	return session.settings.get("irc.enabled") === true && session.getToolByName?.("irc") !== undefined;
}

function renderDescription(
	agents: AgentDefinition[],
	maxConcurrency: number,
	isolationEnabled: boolean,
	asyncEnabled: boolean,
	disabledAgents: string[],
	simpleMode: TaskSimpleMode,
	ircEnabled: boolean,
	parentSpawns: string,
): string {
	const spawningDisabled = parentSpawns === "";
	let filteredAgents = filterVisibleAgents(agents);
	filteredAgents =
		disabledAgents.length > 0 ? filteredAgents.filter(a => !disabledAgents.includes(a.name)) : filteredAgents;
	if (spawningDisabled) {
		filteredAgents = [];
	} else if (parentSpawns !== "*") {
		const allowed = new Set(
			parentSpawns
				.split(",")
				.map(s => s.trim())
				.filter(Boolean),
		);
		filteredAgents = filteredAgents.filter(a => allowed.has(a.name));
	}
	const { contextEnabled, customSchemaEnabled } = getTaskSimpleModeCapabilities(simpleMode);
	return prompt.render(taskDescriptionTemplate, {
		agents: filteredAgents,
		spawningDisabled,
		MAX_CONCURRENCY: maxConcurrency,
		isolationEnabled,
		asyncEnabled,
		contextEnabled,
		customSchemaEnabled,
		ircEnabled,
		defaultMode: simpleMode === "default",
		schemaFreeMode: simpleMode === "schema-free",
		independentMode: simpleMode === "independent",
	});
}

function createTaskModeError(text: string): AgentToolResult<TaskToolDetails> {
	return {
		content: [{ type: "text", text }],
		details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
	};
}

function validateTaskModeParams(simpleMode: TaskSimpleMode, params: TaskParams): string | undefined {
	const { contextEnabled, customSchemaEnabled } = getTaskSimpleModeCapabilities(simpleMode);
	const disallowedFields: string[] = [];
	if (!contextEnabled && params.context !== undefined) {
		disallowedFields.push("context");
	}
	if (!customSchemaEnabled && params.schema !== undefined) {
		disallowedFields.push("schema");
	}
	if (!contextEnabled) {
		const inheritedTaskIds = (params.tasks ?? [])
			.filter(task => task.inheritContext !== undefined && task.inheritContext !== "none")
			.map(task => task.id);
		if (inheritedTaskIds.length > 0) {
			disallowedFields.push(`inheritContext for task(s) ${inheritedTaskIds.join(", ")}`);
		}
	}
	if (disallowedFields.length === 0) {
		return undefined;
	}

	if (simpleMode === "schema-free") {
		return "task.simple is set to schema-free, so the task tool does not accept `schema`. Remove it and rely on the selected agent definition or inherited session schema.";
	}

	if (disallowedFields.length === 1) {
		return `task.simple is set to independent, so the task tool does not accept ${disallowedFields[0].startsWith("inheritContext") ? disallowedFields[0] : `\`${disallowedFields[0]}\``}. Put everything the subagent needs inside each task assignment.`;
	}

	return `task.simple is set to independent, so the task tool does not accept ${disallowedFields.map(field => (field.startsWith("inheritContext") ? field : `\`${field}\``)).join(", ")}. Put all required background and output expectations inside each task assignment or the selected agent definition.`;
}

function getForkContextPolicy(agent: AgentDefinition): ForkContextPolicy {
	return agent.forkContext ?? "forbidden";
}
const FORK_CONTEXT_MODES = [
	"none",
	"receipt",
	"last-turn",
	"bounded",
	"full",
] as const satisfies readonly ForkContextMode[];
const FORK_CONTEXT_MODE_SET = new Set<unknown>(FORK_CONTEXT_MODES);
const FORK_CONTEXT_REQUEST_MODES = ["receipt", "last-turn", "bounded", "full"] as const satisfies readonly Exclude<
	ForkContextMode,
	"none"
>[];
const FORK_CONTEXT_REQUEST_MODE_SET = new Set<unknown>(FORK_CONTEXT_REQUEST_MODES);

function isValidForkContextMode(value: unknown): value is ForkContextMode {
	return FORK_CONTEXT_MODE_SET.has(value);
}

function requestsForkContext(
	task: Pick<TaskItem, "inheritContext">,
): task is TaskItem & { inheritContext: Exclude<ForkContextMode, "none"> } {
	return FORK_CONTEXT_REQUEST_MODE_SET.has(task.inheritContext);
}

function normalizeForkContextCap(value: number | undefined, fallback: number, maximum: number): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.min(maximum, Math.max(1, Math.trunc(value)));
}

function resolveForkSeedParamsForMode(
	mode: ForkContextMode,
	configuredMaxMessages: number | undefined,
	configuredMaxTokens: number,
	model: Model | undefined,
): { maxMessages: number; maxTokens: number; preserveLatestUser?: boolean } | undefined {
	const capMessages = (defaultMaxMessages: number): number =>
		normalizeForkContextCap(configuredMaxMessages, defaultMaxMessages, defaultMaxMessages);
	switch (mode) {
		case "none":
			return undefined;
		case "receipt":
			return { maxMessages: 1, maxTokens: FORK_CONTEXT_TOKEN_BUDGET_BY_MODE.receipt };
		case "last-turn":
			return {
				maxMessages: 2,
				maxTokens: FORK_CONTEXT_TOKEN_BUDGET_BY_MODE["last-turn"],
				preserveLatestUser: true,
			};
		case "bounded":
			return { maxMessages: capMessages(50), maxTokens: FORK_CONTEXT_TOKEN_BUDGET_BY_MODE.bounded };
		case "full":
			return { maxMessages: capMessages(500), maxTokens: resolveForkContextMaxTokens(configuredMaxTokens, model) };
		default:
			return undefined;
	}
}

function validateForkContextRequests(
	tasks: readonly TaskItem[],
	agent: AgentDefinition,
	forkContextEnabled: boolean,
): string | undefined {
	const invalidTaskIds = tasks
		.filter(task => task.inheritContext !== undefined && !isValidForkContextMode(task.inheritContext as unknown))
		.map(task => task.id);
	if (invalidTaskIds.length > 0) {
		return `Invalid inheritContext for task(s) ${invalidTaskIds.join(", ")}. Allowed modes: ${FORK_CONTEXT_MODES.join(", ")}.`;
	}
	const requested = tasks.filter(requestsForkContext);
	if (requested.length === 0) return undefined;
	const taskIds = requested.map(task => task.id).join(", ");
	if (!forkContextEnabled) {
		return `Cannot inherit parent context for task(s) ${taskIds}: task.forkContext.enabled is false.`;
	}
	if (getForkContextPolicy(agent) !== "allowed") {
		return `Cannot inherit parent context for task(s) ${taskIds}: agent '${agent.name}' does not declare forkContext: allowed.`;
	}
	return undefined;
}

export function resolveForkContextMaxTokens(configured: number, model: Model | undefined): number {
	const contextWindow = model?.contextWindow;
	const fallback =
		contextWindow && Number.isFinite(contextWindow) && contextWindow > 0
			? Math.max(1, Math.floor(contextWindow * 0.15))
			: 15_000;
	return normalizeForkContextCap(configured, fallback, Number.MAX_SAFE_INTEGER);
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Requires async initialization to discover available agents.
 * Use `TaskTool.create(session)` to instantiate.
 */
export class TaskTool implements AgentTool<TaskToolSchemaInstance, TaskToolDetails, Theme> {
	readonly name = "task";
	readonly label = "Task";
	readonly summary = "Spawn a subagent to complete a parallel task";
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly renderResult = renderResult;
	readonly #discoveredAgents: AgentDefinition[];
	readonly #blockedAgent: string | undefined;

	get parameters(): TaskToolSchemaInstance {
		const isolationEnabled = this.session.settings.get("task.isolation.mode") !== "none";
		return getTaskSchema({ isolationEnabled, simpleMode: this.#getTaskSimpleMode() });
	}

	renderCall(args: unknown, options: Parameters<typeof renderTaskCall>[1], theme: Theme) {
		return renderTaskCall(args as TaskParams, options, theme);
	}

	/** Dynamic description that reflects current disabled-agent settings */
	get description(): string {
		const disabledAgents = this.session.settings.get("task.disabledAgents") as string[];
		const maxConcurrency = this.session.settings.get("task.maxConcurrency");
		const isolationMode = this.session.settings.get("task.isolation.mode");
		return renderDescription(
			this.#discoveredAgents,
			maxConcurrency,
			isolationMode !== "none",
			true,
			disabledAgents,
			this.#getTaskSimpleMode(),
			hasAvailableIrcTool(this.session),
			this.session.getSessionSpawns() ?? "*",
		);
	}
	private constructor(
		private readonly session: ToolSession,
		discoveredAgents: AgentDefinition[],
	) {
		this.#blockedAgent = $pickenv("GJC_BLOCKED_AGENT", "PI_BLOCKED_AGENT");
		this.#discoveredAgents = discoveredAgents;
	}

	#getTaskSimpleMode(): TaskSimpleMode {
		return this.session.settings.get("task.simple");
	}

	/**
	 * Create a TaskTool instance with async agent discovery.
	 */
	static async create(session: ToolSession): Promise<TaskTool> {
		const { agents } = await discoverAgents(session.cwd);
		return new TaskTool(session, agents);
	}

	async execute(
		_toolCallId: string,
		rawParams: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const params = rawParams as TaskParams;
		const simpleMode = this.#getTaskSimpleMode();
		const validationError = validateTaskModeParams(simpleMode, params);
		if (validationError) {
			return createTaskModeError(validationError);
		}

		const taskItems = params.tasks ?? [];
		const taskIdValidationError = validateTaskIdsForScheduling(taskItems);
		if (taskIdValidationError) {
			return createTaskModeError(taskIdValidationError);
		}
		if (taskItems.length === 0) {
			return this.#executeSync(_toolCallId, params, signal, onUpdate);
		}
		const agent = getAgent(this.#discoveredAgents, params.agent);
		if (!agent) {
			const available =
				filterVisibleAgents(this.#discoveredAgents)
					.map(a => a.name)
					.join(", ") || "none";
			return {
				content: [{ type: "text", text: `Unknown agent "${params.agent}". Available: ${available}` }],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}

		const disabledAgents = this.session.settings.get("task.disabledAgents") as string[];
		if (disabledAgents.length > 0 && disabledAgents.includes(params.agent)) {
			const enabled = filterVisibleAgents(this.#discoveredAgents)
				.filter(a => !disabledAgents.includes(a.name))
				.map(a => a.name);
			return {
				content: [
					{
						type: "text",
						text: `Agent "${params.agent}" is disabled in settings. Enable it via /agents, or use a different agent type.${enabled.length > 0 ? ` Available: ${enabled.join(", ")}` : ""}`,
					},
				],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}

		const forkContextValidationError = validateForkContextRequests(
			taskItems,
			agent,
			this.session.settings.get("task.forkContext.enabled"),
		);
		if (forkContextValidationError) {
			return createTaskModeError(forkContextValidationError);
		}

		const batchGateDecision = evaluateSpawnGate({ childCount: taskItems.length, plan: params.spawnPlan });
		if (batchGateDecision.outcome === "rejected") {
			return {
				content: [
					{
						type: "text",
						text: `Task spawn gate rejected this batch: ${batchGateDecision.reason}. Batches with more than ${DEFAULT_SPAWN_THRESHOLD} tasks require spawnPlan fields: ${batchGateDecision.missingFields.join(", ")}.`,
					},
				],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}

		const manager = AsyncJobManager.instance();
		if (!manager) {
			return {
				content: [{ type: "text", text: "Subagent background execution is unavailable in this session." }],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}

		const outputManager =
			this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
		const uniqueIds = await outputManager.allocateBatch(taskItems.map(t => t.id));
		const fallbackAgentSource =
			this.#discoveredAgents.find(agent => agent.name === params.agent)?.source ?? "bundled";
		const progressByTaskId = new Map<string, AgentProgress>();
		for (let index = 0; index < taskItems.length; index++) {
			const taskItem = taskItems[index];
			const assignment = taskItem.assignment.trim();
			progressByTaskId.set(taskItem.id, {
				index,
				id: taskItem.id,
				agent: params.agent,
				agentSource: fallbackAgentSource,
				status: "pending",
				task: renderTaskAssignment(assignment, simpleMode),
				assignment,
				description: taskItem.description,
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
			});
		}

		const startedJobs: Array<{ jobId: string; taskId: string }> = [];
		const failedSchedules: string[] = [];
		let completedJobs = 0;
		let failedJobs = 0;

		const getProgressSnapshot = (): AgentProgress[] => {
			return Array.from(progressByTaskId.values())
				.sort((a, b) => a.index - b.index)
				.map(progress => structuredClone(progress));
		};

		const buildAsyncDetails = (state: "running" | "completed" | "failed", jobId: string): TaskToolDetails => ({
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: getProgressSnapshot(),
			async: { state, jobId, type: "task" },
		});

		const emitAsyncUpdate = (state: "running" | "completed" | "failed", text: string): void => {
			const primaryJobId = startedJobs[0]?.jobId ?? "task";
			onUpdate?.({
				content: [{ type: "text", text }],
				details: buildAsyncDetails(state, primaryJobId),
			});
		};

		const maxConcurrency = this.session.settings.get("task.maxConcurrency");
		let resumeRunner: ResumeRunner | undefined;
		if (typeof manager.setResumeRunner === "function") {
			resumeRunner = (_subagentId, message, resumeDescriptor) => {
				const descriptor = isTaskResumeDescriptor(resumeDescriptor?.data) ? resumeDescriptor.data : undefined;
				if (!descriptor) return undefined;
				const forkSeeds = descriptor.forkContextSeed
					? new Map([[descriptor.task.id, descriptor.forkContextSeed]])
					: undefined;
				return manager.register(
					"task",
					descriptor.task.id,
					async ({ signal: runSignal }) => {
						const result = await this.#executeSync(
							descriptor.toolCallId,
							{ ...descriptor.params, tasks: [descriptor.task] },
							runSignal,
							undefined,
							[descriptor.task.id],
							forkSeeds,
							{
								runMode: message ? "message" : "resume",
								resumeMessage: message,
								sessionFiles: new Map([[descriptor.task.id, descriptor.sessionFile]]),
								suppressRoiReconciliation: true,
							},
						);
						const finalText = result.content.find(part => part.type === "text")?.text ?? "(no output)";
						const singleResult = result.details?.results[0];
						if (singleResult?.paused) return { kind: "paused" };
						// A resumed subprocess that aborted or exited non-zero is a failed
						// resume, not a completed one. Throw the rendered failure summary
						// (finalText) so the leg is reported failed instead of being
						// returned as successful continuation.
						if (singleResult && ((singleResult.aborted ?? false) || singleResult.exitCode !== 0)) {
							throw new Error(finalText);
						}
						return finalText;
					},
					{
						id: `${descriptor.task.id}-resume-${Snowflake.next()}`,
						ownerId: this.session.getAgentId?.() ?? undefined,
						metadata: {
							subagent: {
								id: descriptor.task.id,
								agent: descriptor.params.agent,
								agentSource: descriptor.agentSource,
								description: descriptor.task.description,
								assignment: descriptor.task.assignment.trim(),
							},
						},
					},
				);
			};
			manager.setResumeRunner(resumeRunner);
		}
		const semaphore = new Semaphore(maxConcurrency);
		const buildForkContextSeedForTask = async (task: TaskItem): Promise<ForkContextSeed | undefined> => {
			if (!requestsForkContext(task)) return undefined;
			if (!this.session.buildForkContextSeed) {
				throw new Error("Current session cannot build fork-context seeds.");
			}
			const configuredMaxMessages = this.session.settings.has("task.forkContext.maxMessages")
				? this.session.settings.get("task.forkContext.maxMessages")
				: undefined;
			const configuredMaxTokens = this.session.settings.get("task.forkContext.maxTokens");
			const params = resolveForkSeedParamsForMode(
				task.inheritContext,
				configuredMaxMessages,
				configuredMaxTokens,
				this.session.model,
			);
			if (!params) return undefined;
			return await this.session.buildForkContextSeed({
				...params,
				signal,
			});
		};
		const frozenForkSeeds = new Map<string, ForkContextSeed>();
		const asyncParentArtifactManager = this.session.getArtifactManager?.() ?? undefined;
		const parentSessionFileForBatch = this.session.getSessionFile();
		const batchArtifactsDir = parentSessionFileForBatch ? parentSessionFileForBatch.slice(0, -6) : null;
		let externalTaskSessionsDir: string | undefined;
		if (!batchArtifactsDir) {
			const asyncLocalOptions: LocalProtocolOptions = {
				getArtifactsDir: this.session.getArtifactsDir ?? (() => null),
				isManagedDestination: this.session.isManagedSessionDestination,
				getSessionId: this.session.getSessionId ?? (() => null),
			};
			await initializeLocalRoot(asyncLocalOptions);
			externalTaskSessionsDir = resolveLocalUrlToPath("local://subagents/sessions", asyncLocalOptions);
			await fs.mkdir(externalTaskSessionsDir, { recursive: true, mode: 0o700 });
		}

		for (let i = 0; i < taskItems.length; i++) {
			const taskItem = taskItems[i];
			if (signal?.aborted) {
				failedSchedules.push(`${taskItem.id}: cancelled before scheduling`);
				const progress = progressByTaskId.get(taskItem.id);
				if (progress) {
					progress.status = "aborted";
				}
				continue;
			}

			const uniqueId = validateAllocatedTaskId(uniqueIds[i] ?? "");
			const frozenForkSeed = await buildForkContextSeedForTask(taskItem);
			if (signal?.aborted) {
				for (let skippedIndex = i; skippedIndex < taskItems.length; skippedIndex++) {
					const skippedTask = taskItems[skippedIndex]!;
					failedSchedules.push(`${skippedTask.id}: cancelled before scheduling`);
					const skippedProgress = progressByTaskId.get(skippedTask.id);
					if (skippedProgress) skippedProgress.status = "aborted";
				}
				break;
			}
			if (frozenForkSeed) frozenForkSeeds.set(uniqueId, frozenForkSeed);
			const singleParams: TaskParams = { ...params, tasks: [taskItem] };
			const label = uniqueId;
			try {
				const managedPersistence = asyncParentArtifactManager?.getManagedStore()
					? createManagedTaskPersistence(asyncParentArtifactManager, uniqueId)
					: undefined;
				const subtaskSessionFile = managedPersistence
					? null
					: path.join(batchArtifactsDir ?? externalTaskSessionsDir!, `${uniqueId}.jsonl`);
				const jobId = manager.register(
					"task",
					label,
					async ({ signal: runSignal, reportProgress }) => {
						const startedAt = Date.now();
						const progress = progressByTaskId.get(taskItem.id);
						await semaphore.acquire();
						if (runSignal.aborted) {
							semaphore.release();
							if (progress) {
								progress.status = "aborted";
							}
							throw new Error("Aborted before execution");
						}
						if (progress) {
							progress.status = "running";
						}
						await reportProgress(
							`Running background task ${taskItem.id}...`,
							buildAsyncDetails("running", startedJobs[0]?.jobId ?? label) as unknown as Record<string, unknown>,
						);
						try {
							const result = await this.#executeSync(
								_toolCallId,
								singleParams,
								runSignal,
								undefined,
								[uniqueId],
								frozenForkSeeds,
								{
									sessionFiles: new Map([[uniqueId, subtaskSessionFile]]),
									suppressRoiReconciliation: true,
								},
							);
							const finalText = result.content.find(part => part.type === "text")?.text ?? "(no output)";
							const singleResult = result.details?.results[0];
							if (progress) {
								progress.status = singleResult?.paused
									? "paused"
									: singleResult?.aborted
										? "aborted"
										: singleResult?.status === "completed"
											? "completed"
											: "failed";
								progress.durationMs = singleResult?.durationMs ?? Math.max(0, Date.now() - startedAt);
								progress.tokens = singleResult?.tokens ?? 0;
								progress.contextTokens = singleResult?.contextTokens;
								progress.contextWindow = singleResult?.contextWindow;
								progress.cost = singleResult?.usage?.cost.total ?? 0;
								progress.extractedToolData = undefined;
								progress.retryFailure = singleResult?.retryFailure
									? {
											attempt: singleResult.retryFailure.attempt,
											errorMessage: singleResult.retryFailure.errorSummary,
										}
									: undefined;
								progress.retryState = undefined;
							}
							completedJobs += 1;
							if (singleResult && ((singleResult.aborted ?? false) || singleResult.exitCode !== 0)) {
								failedJobs += 1;
							}
							const remaining = taskItems.length - completedJobs;
							const isDone = remaining === 0;
							await reportProgress(
								isDone
									? `Background task batch complete: ${completedJobs}/${taskItems.length} finished.`
									: `Background task batch progress: ${completedJobs}/${taskItems.length} finished (${remaining} running).`,
								buildAsyncDetails(
									isDone ? (failedJobs > 0 || failedSchedules.length > 0 ? "failed" : "completed") : "running",
									startedJobs[0]?.jobId ?? label,
								) as unknown as Record<string, unknown>,
							);
							if (isDone) {
								emitAsyncUpdate(
									failedJobs > 0 || failedSchedules.length > 0 ? "failed" : "completed",
									`Background task batch complete: ${completedJobs}/${taskItems.length} finished.`,
								);
							}
							if (singleResult?.paused) {
								return { kind: "paused" };
							}
							return finalText;
						} catch (error) {
							if (progress) {
								progress.status = "failed";
								progress.durationMs = Math.max(0, Date.now() - startedAt);
							}
							completedJobs += 1;
							failedJobs += 1;
							const remaining = taskItems.length - completedJobs;
							const isDone = remaining === 0;
							await reportProgress(
								isDone
									? `Background task batch complete with failures: ${failedJobs} failed.`
									: `Background task batch progress: ${completedJobs}/${taskItems.length} finished (${remaining} running).`,
								buildAsyncDetails(
									isDone ? "failed" : "running",
									startedJobs[0]?.jobId ?? label,
								) as unknown as Record<string, unknown>,
							);
							if (isDone) {
								emitAsyncUpdate(
									"failed",
									`Background task batch complete with failures: ${failedJobs} failed.`,
								);
							}
							throw error;
						} finally {
							semaphore.release();
						}
					},
					{
						id: label,
						ownerId: this.session.getAgentId?.() ?? undefined,
						metadata: {
							subagent: {
								id: uniqueId,
								agent: params.agent,
								agentSource: fallbackAgentSource,
								description: taskItem.description,
								assignment: taskItem.assignment.trim(),
							},
						},
						onProgress: (text, details) => {
							const progressDetails =
								(details as TaskToolDetails | undefined) ??
								buildAsyncDetails("running", startedJobs[0]?.jobId ?? label);
							onUpdate?.({ content: [{ type: "text", text }], details: progressDetails });
						},
					},
				);
				startedJobs.push({ jobId, taskId: taskItem.id });
				if (typeof manager.registerResumeDescriptor === "function") {
					manager.registerResumeDescriptor(
						{
							subagentId: uniqueId,
							ownerId: this.session.getAgentId?.() ?? undefined,
							data: {
								toolCallId: _toolCallId,
								params,
								task: { ...taskItem, id: uniqueId },
								sessionFile: subtaskSessionFile,
								forkContextSeed: frozenForkSeed,
								agentSource: fallbackAgentSource,
							} satisfies TaskResumeDescriptor,
						},
						resumeRunner,
					);
				}
				if (typeof manager.registerSubagentRecord === "function") {
					manager.registerSubagentRecord({
						subagentId: uniqueId,
						ownerId: this.session.getAgentId?.() ?? undefined,
						currentJobId: jobId,
						historicalJobIds: [],
						status: manager.getJob(jobId)?.status ?? "running",
						sessionFile: null,
						resumable: true,
					});
				}
			} catch (error) {
				const message =
					error instanceof OwnerSubagentShutdownError
						? error.message
						: error instanceof Error
							? error.message
							: String(error);
				failedSchedules.push(`${taskItem.id}: ${message}`);
				const progress = progressByTaskId.get(taskItem.id);
				if (progress) {
					progress.status = "failed";
				}
			}
		}

		if (startedJobs.length === 0) {
			const failureText = `Failed to start background task jobs: ${failedSchedules.join("; ")}`;
			return {
				content: [{ type: "text", text: failureText }],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}

		emitAsyncUpdate(
			"running",
			`Launching ${startedJobs.length} background ${startedJobs.length === 1 ? "task" : "tasks"}...`,
		);

		const scheduleFailureSummary =
			failedSchedules.length > 0
				? ` Failed to schedule ${failedSchedules.length} task${failedSchedules.length === 1 ? "" : "s"}.`
				: "";

		const ircEnabled = hasAvailableIrcTool(this.session);
		const taskIdByItemId = new Map<string, string>();
		for (let i = 0; i < taskItems.length; i++) {
			taskIdByItemId.set(taskItems[i].id, uniqueIds[i]);
		}
		const startedListing = startedJobs
			.map(({ taskId, jobId }) => {
				const id = taskIdByItemId.get(taskId) ?? taskId;
				const desc = progressByTaskId.get(taskId)?.description;
				const prefix = `- \`${id}\` (job \`${jobId}\`)`;
				return desc ? `${prefix} — ${desc}` : prefix;
			})
			.join("\n");
		const coordinationHint = ircEnabled
			? ` DM these ids via \`irc\` to coordinate while they run. Use \`subagent\` to list, inspect, or await with a timeout; a timeout only bounds your wait and is never a cancellation reason. Cancel only when the subagent has actually failed, gone off-track, or become unrecoverably wrong; \`job\` remains available for generic background jobs.`
			: ` Use \`subagent\` to list, inspect, or await with a timeout; a timeout only bounds your wait and is never a cancellation reason. Cancel only when the subagent has actually failed, gone off-track, or become unrecoverably wrong; \`job\` remains available for generic background jobs.`;

		return {
			content: [
				{
					type: "text",
					text: `Started ${startedJobs.length} background task job${startedJobs.length === 1 ? "" : "s"} using ${params.agent}.${scheduleFailureSummary} Results will be delivered when complete.\n${startedListing}\n${coordinationHint}`,
				},
			],
			details: {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 0,
				progress: getProgressSnapshot(),
				async: { state: "running", jobId: startedJobs[0].jobId, type: "task" },
			},
		};
	}

	async #executeSync(
		_toolCallId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		preAllocatedIds?: string[],
		prebuiltForkContextSeeds?: ReadonlyMap<string, ForkContextSeed>,
		executionOverrides?: {
			runMode?: "initial" | "resume" | "message";
			resumeMessage?: string;
			sessionFiles?: ReadonlyMap<string, string | null>;
			/**
			 * Set for per-child async runs: the spawnPlan is carried for gate
			 * consistency, but batch-level ROI reconciliation must not be computed
			 * against a single child's receipts.
			 */
			suppressRoiReconciliation?: boolean;
		},
	): Promise<AgentToolResult<TaskToolDetails>> {
		const startTime = Date.now();
		const { agents, projectAgentsDir } = await discoverAgents(this.session.cwd);
		const { agent: agentName, context, schema: outputSchema } = params;
		const simpleMode = this.#getTaskSimpleMode();
		const { contextEnabled, customSchemaEnabled } = getTaskSimpleModeCapabilities(simpleMode);
		const sharedContext = contextEnabled ? context?.trim() : undefined;
		const isolationMode = this.session.settings.get("task.isolation.mode");
		const isolationRequested = "isolated" in params ? params.isolated === true : false;
		const isIsolated = isolationMode !== "none" && isolationRequested;
		const mergeMode = this.session.settings.get("task.isolation.merge");
		const commitStyle = this.session.settings.get("task.isolation.commits");
		const maxConcurrency = this.session.settings.get("task.maxConcurrency");
		const taskDepth = this.session.taskDepth ?? 0;
		const subagentLspEnabled = (this.session.enableLsp ?? true) && this.session.settings.get("task.enableLsp");

		if (isolationMode === "none" && "isolated" in params) {
			return {
				content: [
					{
						type: "text",
						text: "Task isolation is disabled.",
					},
				],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		// Validate agent exists
		const agent = getAgent(agents, agentName);
		if (!agent) {
			const available =
				filterVisibleAgents(agents)
					.map(a => a.name)
					.join(", ") || "none";
			return {
				content: [
					{
						type: "text",
						text: `Unknown agent "${agentName}". Available: ${available}`,
					},
				],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		// Check if agent is disabled in settings
		const disabledAgents = this.session.settings.get("task.disabledAgents") as string[];
		if (disabledAgents.length > 0 && disabledAgents.includes(agentName)) {
			const enabled = filterVisibleAgents(agents)
				.filter(a => !disabledAgents.includes(a.name))
				.map(a => a.name);
			return {
				content: [
					{
						type: "text",
						text: `Agent "${agentName}" is disabled in settings. Enable it via /agents, or use a different agent type.${enabled.length > 0 ? ` Available: ${enabled.join(", ")}` : ""}`,
					},
				],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		const forkContextValidationError = validateForkContextRequests(
			params.tasks ?? [],
			agent,
			this.session.settings.get("task.forkContext.enabled"),
		);
		if (forkContextValidationError) {
			return createTaskModeError(forkContextValidationError);
		}

		const planModeState = this.session.getPlanModeState?.();
		const planModeTools = ["read", "search", "find", "lsp", "web_search"];
		const effectiveAgent: typeof agent = planModeState?.enabled
			? {
					...agent,
					systemPrompt: `${planModeSubagentPrompt}\n\n${agent.systemPrompt}`,
					tools: planModeTools,
					spawns: undefined,
				}
			: agent;

		// Apply per-agent model override from settings (highest priority)
		const agentModelOverrides = this.session.settings.get("task.agentModelOverrides");
		const settingsModelOverride = agentModelOverrides[agentName];
		const parentActiveModelPattern = this.session.getActiveModelString?.();
		const modelOverride = resolveAgentModelPatterns({
			settingsOverride: settingsModelOverride,
			agentModel: effectiveAgent.model,
			settings: this.session.settings,
			activeModelPattern: parentActiveModelPattern,
			fallbackModelPattern: this.session.getModelString?.(),
		});
		const thinkingLevelOverride = effectiveAgent.thinkingLevel;

		// Output schema priority: task call > agent frontmatter > inherited parent session.
		// task.simple can disable the task-call override while leaving agent/session schemas intact.
		const effectiveOutputSchema = customSchemaEnabled
			? (outputSchema ?? effectiveAgent.output ?? this.session.outputSchema)
			: (effectiveAgent.output ?? this.session.outputSchema);

		// Handle empty or missing tasks
		if (!params.tasks || params.tasks.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: contextEnabled
							? "No tasks provided. Use: { agent, context?, tasks: [{ id, description, assignment }, ...] }"
							: "No tasks provided. Use: { agent, tasks: [{ id, description, assignment }, ...] }",
					},
				],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		const tasks = params.tasks;
		const missingTaskIndexes: number[] = [];
		const idIndexes = new Map<string, number[]>();

		for (let i = 0; i < tasks.length; i++) {
			const id = tasks[i]?.id;
			if (typeof id !== "string" || id.trim() === "") {
				missingTaskIndexes.push(i);
				continue;
			}
			const normalizedId = id.toLowerCase();
			const indexes = idIndexes.get(normalizedId);
			if (indexes) {
				indexes.push(i);
			} else {
				idIndexes.set(normalizedId, [i]);
			}
		}

		const duplicateIds: Array<{ id: string; indexes: number[] }> = [];
		for (const [normalizedId, indexes] of idIndexes.entries()) {
			if (indexes.length > 1) {
				duplicateIds.push({
					id: tasks[indexes[0]]?.id ?? normalizedId,
					indexes,
				});
			}
		}

		if (missingTaskIndexes.length > 0 || duplicateIds.length > 0) {
			const problems: string[] = [];
			if (missingTaskIndexes.length > 0) {
				problems.push(`Missing task ids at indexes: ${missingTaskIndexes.join(", ")}`);
			}
			if (duplicateIds.length > 0) {
				const details = duplicateIds.map(entry => `${entry.id} (indexes ${entry.indexes.join(", ")})`).join("; ");
				problems.push(`Duplicate task ids detected (case-insensitive): ${details}`);
			}
			return {
				content: [{ type: "text", text: `Invalid tasks: ${problems.join(". ")}` }],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		const batchGateDecision = evaluateSpawnGate({ childCount: tasks.length, plan: params.spawnPlan });
		if (batchGateDecision.outcome === "rejected") {
			return {
				content: [
					{
						type: "text",
						text: `Task spawn gate rejected this batch: ${batchGateDecision.reason}. Batches with more than ${DEFAULT_SPAWN_THRESHOLD} tasks require spawnPlan fields: ${batchGateDecision.missingFields.join(", ")}.`,
					},
				],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: Date.now() - startTime,
				},
			};
		}

		let repoRoot: string | null = null;
		let baseline: WorktreeBaseline | null = null;
		if (isIsolated) {
			try {
				repoRoot = await getRepoRoot(this.session.cwd);
				baseline = await captureBaseline(repoRoot);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `Isolated task execution requires a git repository. ${message}`,
						},
					],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
					},
				};
			}
		}

		const preferredIsolationBackend = parseIsolationMode(isolationMode);

		// Derive artifacts directory
		const sessionFile = this.session.getSessionFile();
		const artifactsDir = sessionFile ? sessionFile.slice(0, -6) : null;
		const tempArtifactsDir = artifactsDir ? null : path.join(os.tmpdir(), `gjc-task-${Snowflake.next()}`);
		const effectiveArtifactsDir = artifactsDir || tempArtifactsDir!;

		// Share the parent session's local:// root with subagents so they read/write the same scratch space
		const localProtocolOptions: LocalProtocolOptions = {
			getArtifactsDir: this.session.getArtifactsDir ?? (() => null),
			isManagedDestination: this.session.isManagedSessionDestination,
			getSessionId: this.session.getSessionId ?? (() => null),
		};

		// Subagents adopt the parent's ArtifactManager so artifact IDs are unique
		// across the whole tree and outputs land flat in the parent's dir.
		const parentArtifactManager = this.session.getArtifactManager?.() ?? undefined;

		// Initialize progress tracking
		const progressMap = new Map<number, AgentProgress>();
		const isolatedPatchBytes = new Map<string, Buffer>();

		// Update callback
		const emitProgress = () => {
			const progress = Array.from(progressMap.values()).sort((a, b) => a.index - b.index);
			onUpdate?.({
				content: [{ type: "text", text: `Running ${params.tasks.length} agents...` }],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: Date.now() - startTime,
					progress,
				},
			});
		};

		try {
			// Check self-recursion prevention
			if (this.#blockedAgent && agentName === this.#blockedAgent) {
				return {
					content: [
						{
							type: "text",
							text: `Cannot spawn ${this.#blockedAgent} agent from within itself (recursion prevention). Use a different agent type.`,
						},
					],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
					},
				};
			}

			// Check spawn restrictions from parent
			const parentSpawns = this.session.getSessionSpawns() ?? "*";
			const allowedSpawns = parentSpawns.split(",").map(s => s.trim());
			const isSpawnAllowed = (): boolean => {
				if (parentSpawns === "") return false; // Empty = deny all
				if (parentSpawns === "*") return true; // Wildcard = allow all
				return allowedSpawns.includes(agentName);
			};

			if (!isSpawnAllowed()) {
				const allowed =
					parentSpawns === ""
						? "none (spawns disabled for this agent)"
						: filterVisibleAgents(agents)
								.filter(candidate => allowedSpawns.includes(candidate.name))
								.map(candidate => candidate.name)
								.join(", ") || "none";
				return {
					content: [{ type: "text", text: `Cannot spawn '${agentName}'. Allowed: ${allowed}` }],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
					},
				};
			}

			// Place fork-context handoff material in the session-scoped external local
			// root. Subagent prompts may expose this path to subprocesses, so it must
			// never carry managed transcript/artifact authority.
			const shouldWriteConversationContext = !hasAvailableIrcTool(this.session);
			const compactContext = shouldWriteConversationContext ? this.session.getCompactContext?.() : undefined;
			let contextFilePath: string | undefined;
			if (compactContext) {
				await initializeLocalRoot(localProtocolOptions);
				contextFilePath = resolveLocalUrlToPath("local://subagents/context.md", localProtocolOptions);
				await fs.mkdir(path.dirname(contextFilePath), { recursive: true, mode: 0o700 });
				await Bun.write(contextFilePath, compactContext);
			}

			// Build full prompts with context prepended
			// Allocate unique IDs across the session to prevent artifact collisions
			let uniqueIds: string[];
			if (preAllocatedIds && preAllocatedIds.length === tasks.length) {
				uniqueIds = preAllocatedIds;
			} else {
				const outputManager =
					this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
				uniqueIds = await outputManager.allocateBatch(tasks.map(t => t.id));
			}
			const tasksWithUniqueIds = tasks.map((t, i) => ({ ...t, id: validateAllocatedTaskId(uniqueIds[i] ?? "") }));

			const availableSkills = [...(this.session.skills ?? [])];
			// Resolve autoload skills from agent definition against available skills
			const resolvedAutoloadSkills =
				agent.autoloadSkills?.length && availableSkills.length > 0
					? agent.autoloadSkills
							.map(name => availableSkills.find(s => s.name === name))
							.filter((s): s is NonNullable<typeof s> => s !== undefined)
					: [];
			const contextFiles = this.session.contextFiles?.filter(
				file => path.basename(file.path).toLowerCase() !== "agents.md",
			);
			const promptTemplates = this.session.promptTemplates;

			// Initialize progress for all tasks
			for (let i = 0; i < tasksWithUniqueIds.length; i++) {
				const taskItem = tasksWithUniqueIds[i];
				const assignment = taskItem.assignment.trim();
				progressMap.set(i, {
					index: i,
					id: taskItem.id,
					agent: agentName,
					agentSource: agent.source,
					status: "pending",
					task: renderTaskAssignment(assignment, simpleMode),
					assignment,
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					tokens: 0,
					cost: 0,
					durationMs: 0,
					modelOverride,
					description: taskItem.description,
				});
			}
			emitProgress();

			const buildForkContextSeed = async (task: (typeof tasksWithUniqueIds)[number]) => {
				if (!requestsForkContext(task)) return undefined;
				if (!this.session.buildForkContextSeed) {
					throw new Error("Current session cannot build fork-context seeds.");
				}
				const configuredMaxMessages = this.session.settings.has("task.forkContext.maxMessages")
					? this.session.settings.get("task.forkContext.maxMessages")
					: undefined;
				const configuredMaxTokens = this.session.settings.get("task.forkContext.maxTokens");
				const params = resolveForkSeedParamsForMode(
					task.inheritContext,
					configuredMaxMessages,
					configuredMaxTokens,
					this.session.model,
				);
				if (!params) return undefined;
				return await this.session.buildForkContextSeed({
					...params,
					signal,
				});
			};

			const runTask = async (
				task: (typeof tasksWithUniqueIds)[number],
				index: number,
				overrides?: {
					runMode?: "initial" | "resume" | "message";
					resumeMessage?: string;
					sessionFile?: string | null;
				},
			) => {
				const forkContextSeed = prebuiltForkContextSeeds?.get(task.id) ?? (await buildForkContextSeed(task));
				const forkContext = requestsForkContext(task)
					? { mode: task.inheritContext, clonedTokens: forkContextSeed?.metadata.approximateTokens ?? 0 }
					: undefined;
				// Advisory-only recommendation (logged on the receipt); never overrides
				// the caller's explicit inheritContext mode.
				const advisory = adviseForkContextMode({
					assignment: task.assignment,
					context: sharedContext,
					explicitMode: task.inheritContext,
				});
				const forkContextAdvisory = {
					recommendedMode: advisory.recommendedMode,
					reasons: advisory.reasons,
				};
				const managedPersistence = parentArtifactManager?.getManagedStore()
					? createManagedTaskPersistence(parentArtifactManager, task.id)
					: undefined;
				const taskSessionFile = managedPersistence
					? null
					: (overrides?.sessionFile ?? executionOverrides?.sessionFiles?.get(task.id) ?? null);
				if (!isIsolated) {
					const result = await runSubprocess({
						cwd: this.session.cwd,
						agent: effectiveAgent,
						task: renderTaskAssignment(task.assignment, simpleMode),
						assignment: task.assignment.trim(),
						context: sharedContext,
						description: task.description,
						index,
						id: task.id,
						runMode: overrides?.runMode ?? executionOverrides?.runMode,
						resumeMessage: overrides?.resumeMessage ?? executionOverrides?.resumeMessage,
						subagentId: task.id,
						taskDepth,
						modelOverride,
						parentActiveModelPattern,
						parentSessionId: this.session.getSessionId?.() ?? undefined,
						thinkingLevel: thinkingLevelOverride,
						outputSchema: effectiveOutputSchema,
						sessionFile: taskSessionFile,
						persistArtifacts: !!artifactsDir,
						artifactsDir: effectiveArtifactsDir,
						managedPersistence,
						contextFile: contextFilePath,
						ircAvailable: hasAvailableIrcTool(this.session),
						enableLsp: subagentLspEnabled,
						signal,
						eventBus: this.session.eventBus,
						onProgress: progress => {
							progressMap.set(index, {
								...structuredClone(progress),
							});
							AsyncJobManager.instance()?.recordSubagentProgress(task.id, progress);
							emitProgress();
						},
						authStorage: this.session.authStorage,
						modelRegistry: this.session.modelRegistry,
						agentRegistry: this.session.agentRegistry,
						settings: this.session.settings,
						inheritedServiceTier: this.session.serviceTier,
						contextFiles,
						skills: availableSkills,
						autoloadSkills: resolvedAutoloadSkills,
						workspaceTree: this.session.workspaceTree,
						promptTemplates,
						localProtocolOptions,
						parentArtifactManager,
						parentHindsightSessionState: this.session.getHindsightSessionState?.(),
						parentTelemetry: this.session.getTelemetry?.(),
						forkContextSeed,
					});
					return { ...result, ...(forkContext ? { forkContext } : {}), forkContextAdvisory };
				}

				const taskStart = Date.now();
				let isolationHandle: IsolationHandle | undefined;
				try {
					if (!repoRoot || !baseline) {
						throw new Error("Isolated task execution not initialized.");
					}
					const taskBaseline = structuredClone(baseline);

					isolationHandle = await ensureIsolation(repoRoot, task.id, preferredIsolationBackend);
					const isolationDir = isolationHandle.mergedDir;

					const result = await runSubprocess({
						cwd: this.session.cwd,
						worktree: isolationDir,
						agent: effectiveAgent,
						task: renderTaskAssignment(task.assignment, simpleMode),
						assignment: task.assignment.trim(),
						context: sharedContext,
						description: task.description,
						index,
						id: task.id,
						runMode: overrides?.runMode ?? executionOverrides?.runMode,
						resumeMessage: overrides?.resumeMessage ?? executionOverrides?.resumeMessage,
						subagentId: task.id,
						taskDepth,
						modelOverride,
						parentActiveModelPattern,
						parentSessionId: this.session.getSessionId?.() ?? undefined,
						thinkingLevel: thinkingLevelOverride,
						outputSchema: effectiveOutputSchema,
						sessionFile: taskSessionFile,
						persistArtifacts: !!artifactsDir,
						artifactsDir: effectiveArtifactsDir,
						managedPersistence,
						contextFile: contextFilePath,
						ircAvailable: hasAvailableIrcTool(this.session),
						enableLsp: subagentLspEnabled,
						signal,
						eventBus: this.session.eventBus,
						onProgress: progress => {
							progressMap.set(index, {
								...structuredClone(progress),
							});
							AsyncJobManager.instance()?.recordSubagentProgress(task.id, progress);
							emitProgress();
						},
						authStorage: this.session.authStorage,
						modelRegistry: this.session.modelRegistry,
						agentRegistry: this.session.agentRegistry,
						settings: this.session.settings,
						inheritedServiceTier: this.session.serviceTier,
						contextFiles,
						skills: availableSkills,
						autoloadSkills: resolvedAutoloadSkills,
						workspaceTree: this.session.workspaceTree,
						promptTemplates,
						localProtocolOptions,
						parentArtifactManager,
						parentHindsightSessionState: this.session.getHindsightSessionState?.(),
						parentTelemetry: this.session.getTelemetry?.(),
						forkContextSeed,
					});
					const resultWithForkContext = {
						...result,
						...(forkContext ? { forkContext } : {}),
						forkContextAdvisory,
					};
					if (mergeMode === "branch" && resultWithForkContext.exitCode === 0) {
						try {
							const commitMsg =
								commitStyle === "ai" && this.session.modelRegistry
									? async (diff: string) => {
											return generateCommitMessage(
												diff,
												this.session.modelRegistry!,
												this.session.settings,
												this.session.getSessionId?.() ?? undefined,
											);
										}
									: undefined;
							const commitResult = await commitToBranch(
								isolationDir,
								taskBaseline,
								task.id,
								task.description,
								commitMsg,
							);
							const producedChanges = Boolean(commitResult?.branchName || commitResult?.nestedPatches.length);
							return {
								...resultWithForkContext,
								branchName: commitResult?.branchName,
								nestedPatches: commitResult?.nestedPatches,
								producedChanges,
							};
						} catch (mergeErr) {
							// Agent succeeded but branch commit failed — clean up stale branch
							const branchName = `gjc/task/${task.id}`;
							await git.branch.tryDelete(repoRoot, branchName);
							const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
							return { ...resultWithForkContext, error: `Merge failed: ${msg}` };
						}
					}
					if (resultWithForkContext.exitCode === 0) {
						try {
							const delta = await captureDeltaPatch(isolationDir, taskBaseline);
							await initializeLocalRoot(localProtocolOptions);
							const artifactId = validateAllocatedTaskId(task.id);
							const patchPath = resolveLocalUrlToPath(
								`local://subagents/${artifactId}.patch`,
								localProtocolOptions,
							);
							await fs.mkdir(path.dirname(patchPath), { recursive: true, mode: 0o700 });
							await Bun.write(patchPath, delta.rootPatch);
							isolatedPatchBytes.set(patchPath, Buffer.from(delta.rootPatch, "utf8"));
							const producedChanges = Boolean(delta.rootPatch.trim() || delta.nestedPatches.length);
							return {
								...resultWithForkContext,
								patchPath,
								nestedPatches: delta.nestedPatches,
								producedChanges,
							};
						} catch (patchErr) {
							const msg = patchErr instanceof Error ? patchErr.message : String(patchErr);
							return { ...resultWithForkContext, error: `Patch capture failed: ${msg}` };
						}
					}
					return resultWithForkContext;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const assignment = task.assignment.trim();
					return {
						index,
						id: task.id,
						agent: agent.name,
						agentSource: agent.source,
						task: renderTaskAssignment(assignment, simpleMode),
						assignment,
						description: task.description,
						exitCode: 1,
						output: "",
						stderr: message,
						truncated: false,
						durationMs: Date.now() - taskStart,
						tokens: 0,
						modelOverride,
						forkContext,
						error: message,
					};
				} finally {
					if (isolationHandle) {
						await cleanupIsolation(isolationHandle);
					}
				}
			};

			// Execute in parallel with concurrency limit
			const { results: partialResults, aborted } = await mapWithConcurrencyLimit(
				tasksWithUniqueIds,
				maxConcurrency,
				runTask,
				signal,
			);

			// Fill in skipped tasks (undefined entries from abort) with placeholder results
			const results: SingleResult[] = partialResults.map((result, index) => {
				if (result !== undefined) {
					return result;
				}
				const task = tasksWithUniqueIds[index];
				const assignment = task.assignment.trim();
				return {
					index,
					id: task.id,
					agent: agentName,
					agentSource: agent.source,
					task: renderTaskAssignment(assignment, simpleMode),
					assignment,
					description: task.description,
					exitCode: 1,
					output: "",
					stderr: "Skipped (cancelled before start)",
					truncated: false,
					durationMs: 0,
					tokens: 0,
					modelOverride,
					error: "Cancelled before start",
					aborted: true,
					abortReason: "Cancelled before start",
				};
			});
			if (!artifactsDir) {
				for (const result of results) {
					delete result.outputMeta;
					delete result.outputPath;
				}
			}

			const forkContextClonedTokens = results.reduce(
				(total, result) => total + (result.forkContext?.clonedTokens ?? 0),
				0,
			);

			// Aggregate usage from executor results (already accumulated incrementally)
			const aggregatedUsage = createUsageTotals();
			let hasAggregatedUsage = false;

			for (const result of results) {
				if (result.usage) {
					addUsageTotals(aggregatedUsage, result.usage);
					hasAggregatedUsage = true;
				}
			}

			const patchPaths: string[] = [];
			for (const result of results) {
				if (result.patchPath) {
					patchPaths.push(result.patchPath);
				}
			}

			let mergeSummary = "";
			let changesApplied: boolean | null = null;
			let hadAnyChanges = false;
			let mergedBranchesForNestedPatches: Set<string> | null = null;
			if (isIsolated && repoRoot) {
				try {
					if (mergeMode === "branch") {
						// Branch mode: merge task branches sequentially
						const branchEntries = results
							.filter(r => r.branchName && r.exitCode === 0 && !r.aborted)
							.map(r => ({ branchName: r.branchName!, taskId: r.id, description: r.description }));

						if (branchEntries.length === 0) {
							changesApplied = true;
							hadAnyChanges = false;
							mergeSummary = "\n\nNo changes to apply.";
						} else {
							const mergeResult = await mergeTaskBranches(repoRoot, branchEntries);
							mergedBranchesForNestedPatches = new Set(mergeResult.merged);
							changesApplied = mergeResult.failed.length === 0;
							hadAnyChanges = changesApplied && mergeResult.merged.length > 0;

							if (changesApplied) {
								mergeSummary = hadAnyChanges
									? `\n\nMerged ${mergeResult.merged.length} branch${mergeResult.merged.length === 1 ? "" : "es"}: ${mergeResult.merged.join(", ")}`
									: "\n\nNo changes to apply.";
							} else {
								const mergedPart =
									mergeResult.merged.length > 0 ? `Merged: ${mergeResult.merged.join(", ")}.\n` : "";
								const failedPart = `Failed: ${mergeResult.failed.join(", ")}.`;
								const conflictPart = mergeResult.conflict ? `\nConflict: ${mergeResult.conflict}` : "";
								mergeSummary = `\n\n<system-notification>Branch merge failed. ${mergedPart}${failedPart}${conflictPart}\nUnmerged branches remain for manual resolution.</system-notification>`;
							}
						}

						// Clean up merged branches (keep failed ones for manual resolution)
						const allBranches = branchEntries.map(b => b.branchName);
						if (changesApplied) {
							await cleanupTaskBranches(repoRoot, allBranches);
						}
					} else {
						// Patch mode: combine and apply patches
						const patchesInOrder = results.map(result => result.patchPath).filter(Boolean) as string[];
						const missingPatch = results.some(result => !result.patchPath);
						if (missingPatch) {
							changesApplied = false;
							hadAnyChanges = false;
						} else {
							const patchStats = patchesInOrder.map(patchPath => ({
								patchPath,
								size: isolatedPatchBytes.get(patchPath)?.byteLength ?? -1,
							}));
							if (patchStats.some(patch => patch.size < 0)) {
								throw new Error("Captured isolated patch bytes are unavailable");
							}
							const nonEmptyPatches = patchStats.filter(patch => patch.size > 0).map(patch => patch.patchPath);
							if (nonEmptyPatches.length === 0) {
								changesApplied = true;
								hadAnyChanges = false;
							} else {
								const patchTexts = nonEmptyPatches.map(patchPath =>
									isolatedPatchBytes.get(patchPath)!.toString("utf8"),
								);
								const combinedPatch = patchTexts
									.map(text => (text.endsWith("\n") ? text : `${text}\n`))
									.join("");
								if (!combinedPatch.trim()) {
									changesApplied = true;
									hadAnyChanges = false;
								} else {
									changesApplied = await git.patch.canApplyText(repoRoot, combinedPatch);
									if (changesApplied) {
										try {
											await git.patch.applyText(repoRoot, combinedPatch);
											hadAnyChanges = true;
										} catch {
											changesApplied = false;
											hadAnyChanges = false;
										}
									}
								}
							}
						}

						if (changesApplied) {
							mergeSummary = hadAnyChanges ? "\n\nApplied patches: yes" : "\n\nNo changes to apply.";
						} else {
							const notification =
								"<system-notification>Patches were not applied and must be handled manually.</system-notification>";
							const patchList =
								patchPaths.length > 0
									? `\n\nPatch artifacts: ${patchPaths.length} preserved for internal merge recovery.`
									: "";
							mergeSummary = `\n\n${notification}${patchList}`;
						}
					}
				} catch (mergeErr) {
					const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
					changesApplied = false;
					hadAnyChanges = false;
					mergeSummary = `\n\n<system-notification>Merge phase failed: ${msg}\nTask outputs are preserved but changes were not applied.</system-notification>`;
				}
			}

			// Apply nested repo patches (separate from parent git)
			if (isIsolated && repoRoot && (mergeMode === "branch" || changesApplied !== false)) {
				const allNestedPatches = results
					.filter(r => {
						if (!r.nestedPatches || r.nestedPatches.length === 0 || r.exitCode !== 0 || r.aborted) {
							return false;
						}
						if (mergeMode !== "branch") {
							return true;
						}
						if (!r.branchName || !mergedBranchesForNestedPatches) {
							return false;
						}
						return mergedBranchesForNestedPatches.has(r.branchName);
					})
					.flatMap(r => r.nestedPatches!);
				if (allNestedPatches.length > 0) {
					try {
						const commitMsg =
							commitStyle === "ai" && this.session.modelRegistry
								? async (diff: string) => {
										return generateCommitMessage(
											diff,
											this.session.modelRegistry!,
											this.session.settings,
											this.session.getSessionId?.() ?? undefined,
										);
									}
								: undefined;
						await applyNestedPatches(repoRoot, allNestedPatches, commitMsg);
					} catch {
						// Nested patch failures are non-fatal to the parent merge
						mergeSummary +=
							"\n\n<system-notification>Some nested repository patches failed to apply.</system-notification>";
					}
				}
			}

			// Build final output - match plugin format
			const cancelledCount = results.filter(r => r.aborted).length;
			const successCount = results.filter(r => r.exitCode === 0 && !r.error && !r.aborted).length;
			const totalDuration = Date.now() - startTime;

			const receipts = results.map(buildTaskReceipt);
			const roiSummary = buildTaskRoiSummary(receipts);
			const roiReconciliation = executionOverrides?.suppressRoiReconciliation
				? undefined
				: reconcileSpawnRoi(params.spawnPlan, receipts);
			const summaries = receipts.map(r => {
				const status = r.status === "merge_failed" ? "merge failed" : r.status;
				return {
					agent: r.agent,
					status,
					id: r.id,
					synopsis: r.preview,
					outputUri: r.outputRef?.uri,
					meta: r.outputRef
						? {
								lineCount: r.outputRef.lineCount,
								charSize: formatBytes(r.outputRef.sizeBytes),
							}
						: undefined,
				};
			});

			const summary = prompt.render(taskSummaryTemplate, {
				successCount,
				totalCount: results.length,
				cancelledCount,
				hasCancelledNote: aborted && cancelledCount > 0,
				duration: formatDuration(totalDuration),
				summaries,
				agentName,
				mergeSummary,
			});

			// Cleanup temp directory if used
			const shouldCleanupTempArtifacts =
				tempArtifactsDir && (!isIsolated || changesApplied === true || changesApplied === null);
			if (shouldCleanupTempArtifacts) {
				await fs.rm(tempArtifactsDir, { recursive: true, force: true });
			}

			const details: TaskToolDetails = {
				projectAgentsDir,
				results: receipts,
				totalDurationMs: totalDuration,
				usage: hasAggregatedUsage ? aggregatedUsage : undefined,
				usageCostBreakdownComplete:
					hasAggregatedUsage && hasCompleteAggregateUsageCostBreakdown(results) ? true : undefined,
				forkContextClonedTokens: forkContextClonedTokens > 0 ? forkContextClonedTokens : undefined,
				roiSummary,
				roiReconciliation,
			};
			assertNoRawTaskFields(details, "task.return.details");
			return {
				content: [{ type: "text", text: summary }],
				details,
			};
		} catch (err) {
			return {
				content: [{ type: "text", text: `Task execution failed: ${err}` }],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: Date.now() - startTime,
				},
			};
		}
	}
}
