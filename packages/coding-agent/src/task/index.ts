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
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import type { Model, Usage } from "@gajae-code/ai/core";
import {
	AsyncJobManager,
	OwnerSubagentShutdownError,
	type ResumeRunner,
	type SubagentRunOutcome,
} from "@gajae-code/coding-agent/async";
import { $pickenv, prompt, Snowflake } from "@gajae-code/utils";
import type { ToolSession } from "..";
import { normalizeTierSelector, type RoutingOutcome, resolveTaskRouting } from "../config/autorouting";
import { AUTOROUTING_SELECTOR_MAX_LENGTH, type AutoroutingReasonCode } from "../config/autorouting-contract";
import { resolveProfileBindings } from "../config/model-profiles";
import { resolveAgentModelPatterns } from "../config/model-resolver";
import type { Theme } from "../modes/theme/theme";
import planModeSubagentPrompt from "../prompts/system/plan-mode-subagent.md" with { type: "text" };
import taskDescriptionTemplate from "../prompts/tools/task.md" with { type: "text" };
import taskSummaryTemplate from "../prompts/tools/task-summary.md" with { type: "text" };
import type { ForkContextSeed } from "../session/agent-session";
import { splitSelectorThinkingSuffix } from "../thinking";
import { formatBytes, formatDuration } from "../tools/render-utils";
import { escapeXmlAttribute } from "../utils/xml-escape";
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
	type TaskRoutingEvidence,
	type TaskToolDetails,
	type TaskToolSchemaInstance,
} from "./types";

// Import review tools for side effects (registers subagent tool handlers)
import "../tools/review";
import {
	assertExecutionRootMatchesRepositoryBinding,
	assertPathUnderRepositoryBinding,
	captureRepositoryBinding,
	publicRepositoryBinding,
	type RepositoryBinding,
	RepositoryBindingError,
	resolveTaskRepositoryBinding,
} from "../gjc-runtime/repository-binding";
import { initializeLocalRoot, type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls";
import { ArtifactManager } from "../session/artifacts";
import { registerOwnedIfLineaged } from "../session/terminal-abort";
import { generateCommitMessage } from "../utils/commit-message-generator";
import * as git from "../utils/git";
import { loadBundledAgents } from "./agents";
import { discoverAgents, filterVisibleAgents, getAgent } from "./discovery";
import {
	buildBoundedRoutingSkips,
	createManagedTaskPersistence,
	renderSubagentUserPrompt,
	runSubprocess,
} from "./executor";

import { adviseForkContextMode } from "./fork-context-advisory";
import { FORK_CONTEXT_TOKEN_BUDGET_BY_MODE } from "./fork-context-budget";
import { getTaskIdValidationError, validateAllocatedTaskId } from "./id";
import { AgentOutputManager } from "./output-manager";
import { mapWithConcurrencyLimit, Semaphore } from "./parallel";
import { assertNoRawTaskFields, buildTaskReceipt, buildTaskRoiSummary, type TaskResultReceipt } from "./receipt";
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
	serializeRecoveryPatchBundle,
	verifyNestedPatchesApplied,
	verifyRootPatchesApplied,
	type WorktreeBaseline,
} from "./worktree";

interface DuplicateIdentity {
	role: string;
	ownerId?: string;
	parentSession: string | null;
	repository: { root: string; relativeSubdir: string | null };
}

interface DuplicateDisposition {
	action: "warned" | "superseded";
	predecessorIds: string[];
}

interface TaskResumeDescriptor {
	toolCallId: string;
	params: TaskParams;
	task: TaskItem & { id: string };
	sessionFile: string | null;
	durableOutputAllowed?: boolean;
	forkContextSeed?: ForkContextSeed;
	agentSource: AgentDefinition["source"];
	repositoryBinding: RepositoryBinding;
	duplicateIdentity: DuplicateIdentity;
	duplicatePolicy: "warn" | "supersede";
	initialDisposition?: DuplicateDisposition;
	lastAdmissionFailure?: string;
}

function isTaskResumeDescriptor(value: unknown): value is TaskResumeDescriptor {
	return typeof value === "object" && value !== null && "task" in value && "params" in value;
}
function renderTaskAssignment(assignment: string, simpleMode: TaskSimpleMode): string {
	return renderSubagentUserPrompt(assignment, simpleMode === "independent");
}

export function subagentRunOutcomeFromSingleResult(
	finalText: string,
	singleResult:
		| (Pick<SingleResult, "aborted" | "exitCode" | "paused" | "setupFailure" | "localErrorSummary"> &
				Partial<Pick<TaskResultReceipt, "status">>)
		| undefined,
): string | SubagentRunOutcome {
	if (singleResult?.paused) return { kind: "paused" };
	if (!singleResult) return { kind: "failed", text: finalText };
	if (singleResult?.status && singleResult.status !== "completed") {
		return {
			kind: "failed",
			text: finalText,
			...(singleResult.setupFailure && !singleResult.aborted
				? { setupFailureSummary: singleResult.setupFailure.summary }
				: {}),
			...(singleResult.localErrorSummary && !singleResult.aborted
				? { localErrorSummary: singleResult.localErrorSummary }
				: {}),
		};
	}
	if (singleResult && ((singleResult.aborted ?? false) || singleResult.exitCode !== 0)) {
		return {
			kind: "failed",
			text: finalText,
			...(singleResult.setupFailure && !singleResult.aborted
				? { setupFailureSummary: singleResult.setupFailure.summary }
				: {}),
			...(singleResult.localErrorSummary && !singleResult.aborted
				? { localErrorSummary: singleResult.localErrorSummary }
				: {}),
		};
	}
	return finalText;
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

/**
 * Stamp/resolve repository authority for every task before agent discovery or spawn.
 * Omitted bindings inherit the session worktree; declared ones must match it.
 */
async function resolveTaskItemsWithRepositoryBindings(
	cwd: string,
	tasks: readonly TaskItem[],
): Promise<{ tasks: TaskItem[]; error?: string }> {
	const resolved: TaskItem[] = [];
	for (const task of tasks) {
		try {
			const binding = await resolveTaskRepositoryBinding(cwd, task.repositoryBinding);
			if (binding.relativeSubdir) assertPathUnderRepositoryBinding(binding, ".");
			resolved.push({ ...task, repositoryBinding: binding });
		} catch (error) {
			const id = task.id?.trim() ? task.id : "(missing-id)";
			if (error instanceof RepositoryBindingError)
				return { tasks: [], error: `Task "${id}" repository binding rejected: ${error.message}` };
			return {
				tasks: [],
				error: `Task "${id}" repository binding rejected: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
	return { tasks: resolved };
}

function duplicateIdentityForTask(
	task: TaskItem,
	role: string,
	ownerId: string | undefined,
	parentSession: string | null,
): DuplicateIdentity {
	const binding = task.repositoryBinding as RepositoryBinding;
	return {
		role: role.trim(),
		ownerId,
		parentSession,
		repository: { root: binding.commonDir ?? binding.worktreeRoot, relativeSubdir: binding.relativeSubdir ?? null },
	};
}

function duplicateIdentityKey(identity: DuplicateIdentity): string {
	return JSON.stringify([
		identity.role,
		identity.ownerId ?? null,
		identity.parentSession,
		identity.repository.root,
		identity.repository.relativeSubdir,
	]);
}

function repositoryBindingFromTask(task: TaskItem): RepositoryBinding | undefined {
	return task.repositoryBinding ? publicRepositoryBinding(task.repositoryBinding as RepositoryBinding) : undefined;
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
	autoroutingActive: boolean,
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
	const description = prompt.render(taskDescriptionTemplate, {
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
		autoroutingActive,
	});
	return description;
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

const ROUTING_SUMMARY_UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

function sanitizeRoutingSummaryValue(value: string): string {
	return value.normalize("NFKC").replace(ROUTING_SUMMARY_UNSAFE_RE, " ").slice(0, AUTOROUTING_SELECTOR_MAX_LENGTH);
}

export function findRoutingSnapshotModel(selector: string, routingSnapshot: readonly Model[]): Model | undefined {
	const slash = selector.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = selector.slice(0, slash).toLowerCase();
	const modelId = selector.slice(slash + 1);
	const providerMatches = routingSnapshot.filter(candidate => candidate.provider.toLowerCase() === provider);
	return (
		providerMatches.find(candidate => candidate.id === modelId) ??
		providerMatches.find(candidate => {
			const suffix = splitSelectorThinkingSuffix(modelId);
			return (
				suffix.invalidSuffix === undefined && suffix.thinkingLevel !== undefined && candidate.id === suffix.selector
			);
		})
	);
}

/**
 * Project routing evidence into the XML-attribute-safe display view consumed by
 * the task-summary template. The template runtime uses noEscape, so every
 * interpolated attribute value must be escaped here.
 */
export function projectRoutingForSummary(
	routing: TaskRoutingEvidence | undefined,
): { tier: string; effectiveModel: string; note: string } | undefined {
	if (!routing) return undefined;
	return {
		tier: escapeXmlAttribute(sanitizeRoutingSummaryValue(routing.tier)),
		effectiveModel: escapeXmlAttribute(
			sanitizeRoutingSummaryValue(routing.effectiveModel ?? routing.requestedSelector),
		),
		note: escapeXmlAttribute(sanitizeRoutingSummaryValue(routing.note ?? "")),
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════
interface SessionLifetimeArtifactsState {
	dir?: string;
	manager?: ArtifactManager;
	ensurePromise?: Promise<string | null>;
	outputPrefix: string;
	authorized: boolean;
	cleanupRegistered: boolean;
	originalGetArtifactsDir?: ToolSession["getArtifactsDir"];
	originalGetAuthorizedArtifactsDirs?: ToolSession["getAuthorizedArtifactsDirs"];
	originalGetArtifactManager?: ToolSession["getArtifactManager"];
	originalIsArtifactManagerAuthorized?: ToolSession["isArtifactManagerAuthorized"];
	originalAgentOutputManager?: AgentOutputManager;
	installedGetArtifactsDir?: ToolSession["getArtifactsDir"];
	installedGetAuthorizedArtifactsDirs?: ToolSession["getAuthorizedArtifactsDirs"];
	installedGetArtifactManager?: ToolSession["getArtifactManager"];
	installedIsArtifactManagerAuthorized?: ToolSession["isArtifactManagerAuthorized"];
	installedAgentOutputManager?: AgentOutputManager;
}

const sessionLifetimeArtifacts = new WeakMap<ToolSession, SessionLifetimeArtifactsState>();

function sessionLifetimeArtifactsState(session: ToolSession): SessionLifetimeArtifactsState {
	let state = sessionLifetimeArtifacts.get(session);
	if (!state) {
		state = {
			authorized: false,
			cleanupRegistered: false,
			outputPrefix: `0-Session${randomUUID().replaceAll("-", "")}`,
		};
		sessionLifetimeArtifacts.set(session, state);
	}
	return state;
}

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
	/**
	 * Session-lifetime durable artifact state is shared atomically by every
	 * TaskTool created for the same parent ToolSession.
	 */

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
			this.session.settings.getEffectiveAutorouting().active,
		);
	}
	readonly #sessionRepositoryBinding: RepositoryBinding;
	#testRunSubprocess: typeof runSubprocess | undefined;

	private constructor(
		private readonly session: ToolSession,
		discoveredAgents: AgentDefinition[],
		sessionRepositoryBinding: RepositoryBinding,
	) {
		this.#blockedAgent = $pickenv("GJC_BLOCKED_AGENT", "PI_BLOCKED_AGENT");
		this.#discoveredAgents = discoveredAgents;
		this.#sessionRepositoryBinding = sessionRepositoryBinding;
	}

	#runSubprocess(options: Parameters<typeof runSubprocess>[0]): Promise<SingleResult> {
		return (this.#testRunSubprocess ?? runSubprocess)(options);
	}

	#getTaskSimpleMode(): TaskSimpleMode {
		return this.session.settings.get("task.simple");
	}

	/**
	 * The artifact store shared by this whole agent tree, when the session proves
	 * the exact manager relationship. Path containment is not authority: an
	 * unrelated manager can choose a lexically nested root or session filename.
	 */
	#sharedArtifactStore(): { dir: string; manager: ArtifactManager } | null {
		const manager = this.session.getArtifactManager?.() ?? null;
		if (!manager || this.session.isArtifactManagerAuthorized?.(manager) !== true) return null;
		return { dir: path.resolve(manager.dir), manager };
	}

	/**
	 * Ensure a session-lifetime artifact directory when the parent has no session file.
	 * Returns null only when durable allocation fails (mkdir error) — callers must not
	 * advertise agent:// URIs without a successful allocation.
	 */
	async #ensureSessionLifetimeArtifacts(): Promise<{ dir: string; manager: ArtifactManager } | null> {
		const state = sessionLifetimeArtifactsState(this.session);
		if (state.authorized && state.dir && state.manager) return { dir: state.dir, manager: state.manager };
		if (this.session.ensureArtifactManager) {
			const manager = await this.session.ensureArtifactManager();
			if (manager && this.session.isArtifactManagerAuthorized?.(manager) === true) {
				const dir = path.resolve(manager.dir);
				state.dir = dir;
				state.manager = manager;
				if (!(await this.#authorizeSessionLifetimeArtifacts(state, dir, manager, false, false))) return null;
				return { dir, manager };
			}
		}

		const sessionArtifactsDir = this.session.getArtifactsDir?.() ?? null;
		if (sessionArtifactsDir) {
			const manager = new ArtifactManager(sessionArtifactsDir);
			state.dir = sessionArtifactsDir;
			state.manager = manager;
			if (!(await this.#authorizeSessionLifetimeArtifacts(state, sessionArtifactsDir, manager, false, true)))
				return null;
			return { dir: sessionArtifactsDir, manager };
		}
		if (!this.session.registerSessionCleanup) return null;

		state.ensurePromise ??= this.#allocateSessionLifetimeArtifacts(state);
		const dir = await state.ensurePromise;
		if (!dir || !state.manager) {
			state.ensurePromise = undefined;
			return null;
		}
		return { dir, manager: state.manager };
	}

	async #allocateSessionLifetimeArtifacts(state: SessionLifetimeArtifactsState): Promise<string | null> {
		let dir: string;
		try {
			dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-session-"));
		} catch {
			state.dir = undefined;
			state.manager = undefined;
			return null;
		}
		state.dir = dir;
		state.manager = new ArtifactManager(dir);
		if (!(await this.#authorizeSessionLifetimeArtifacts(state, dir, state.manager, true, true))) return null;
		return dir;
	}

	/**
	 * Expose the durable root on the parent ToolSession so subsequent parent-side
	 * tools and same-session descendants can resolve agent:// without registry-wide
	 * enumeration (#3302 scoped authorization).
	 */
	async #authorizeSessionLifetimeArtifacts(
		state: SessionLifetimeArtifactsState,
		dir: string,
		manager: ArtifactManager,
		owned: boolean,
		adoptIntoSessionOwner: boolean,
	): Promise<boolean> {
		if (state.authorized) return true;
		state.originalGetArtifactsDir = this.session.getArtifactsDir;
		state.originalGetAuthorizedArtifactsDirs = this.session.getAuthorizedArtifactsDirs;
		state.originalGetArtifactManager = this.session.getArtifactManager;
		state.originalIsArtifactManagerAuthorized = this.session.isArtifactManagerAuthorized;
		state.originalAgentOutputManager = this.session.agentOutputManager;

		state.installedGetArtifactsDir = () => state.originalGetArtifactsDir?.() ?? dir;
		state.installedGetAuthorizedArtifactsDirs = () => {
			const dirs: string[] = [];
			const add = (candidate: string | null | undefined) => {
				if (!candidate) return;
				const normalized = path.resolve(candidate);
				if (!dirs.includes(normalized)) dirs.push(normalized);
			};
			for (const authorized of state.originalGetAuthorizedArtifactsDirs?.() ?? []) add(authorized);
			add(dir);
			return dirs;
		};
		state.installedGetArtifactManager = () => manager;
		state.installedIsArtifactManagerAuthorized = candidate =>
			candidate === manager || state.originalIsArtifactManagerAuthorized?.(candidate) === true;
		if (owned || !this.session.agentOutputManager) {
			state.installedAgentOutputManager = new AgentOutputManager(() => this.session.getArtifactsDir?.() ?? null, {
				parentPrefix: owned ? state.outputPrefix : undefined,
				getAuthorizedArtifactsDirs: () => this.session.getAuthorizedArtifactsDirs?.() ?? [],
			});
		}

		let cleanupRan = false;
		const cleanup = async () => {
			cleanupRan = true;
			this.session.releaseArtifactManager?.(manager);
			if (this.session.getArtifactsDir === state.installedGetArtifactsDir)
				this.session.getArtifactsDir = state.originalGetArtifactsDir;
			if (this.session.getAuthorizedArtifactsDirs === state.installedGetAuthorizedArtifactsDirs)
				this.session.getAuthorizedArtifactsDirs = state.originalGetAuthorizedArtifactsDirs;
			if (this.session.getArtifactManager === state.installedGetArtifactManager)
				this.session.getArtifactManager = state.originalGetArtifactManager;
			if (this.session.isArtifactManagerAuthorized === state.installedIsArtifactManagerAuthorized)
				this.session.isArtifactManagerAuthorized = state.originalIsArtifactManagerAuthorized;
			if (this.session.agentOutputManager === state.installedAgentOutputManager)
				this.session.agentOutputManager = state.originalAgentOutputManager;
			sessionLifetimeArtifacts.delete(this.session);
			if (owned) await fs.rm(dir, { recursive: true, force: true });
		};
		const registerCleanup = this.session.registerSessionCleanup;
		if (!registerCleanup) {
			state.dir = undefined;
			state.manager = undefined;
			state.ensurePromise = undefined;
			sessionLifetimeArtifacts.delete(this.session);
			if (owned) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
			return false;
		}
		try {
			registerCleanup(cleanup);
		} catch {
			state.dir = undefined;
			state.manager = undefined;
			state.ensurePromise = undefined;
			sessionLifetimeArtifacts.delete(this.session);
			if (owned) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
			return false;
		}
		if (cleanupRan) return false;
		state.cleanupRegistered = true;
		if (adoptIntoSessionOwner && this.session.adoptArtifactManager) {
			try {
				this.session.adoptArtifactManager(manager);
			} catch {
				await cleanup();
				return false;
			}
			if (
				this.session.getArtifactManager?.() !== manager ||
				this.session.isArtifactManagerAuthorized?.(manager) !== true
			) {
				await cleanup();
				return false;
			}
		}

		state.authorized = true;
		this.session.getArtifactsDir = state.installedGetArtifactsDir;
		this.session.getAuthorizedArtifactsDirs = state.installedGetAuthorizedArtifactsDirs;
		this.session.getArtifactManager = state.installedGetArtifactManager;
		this.session.isArtifactManagerAuthorized = state.installedIsArtifactManagerAuthorized;
		if (state.installedAgentOutputManager) this.session.agentOutputManager = state.installedAgentOutputManager;
		return true;
	}

	/**
	 * Resolve the effective artifacts directory for this task batch.
	 *
	 * The session's ArtifactManager is authoritative when present: a subagent
	 * adopts its parent's manager, so honouring it keeps the whole agent tree on
	 * one artifact directory and one ID space instead of giving each nesting
	 * level a private store. Sessions without a manager fall back to the session
	 * artifacts path, then to the session-lifetime durable temp root.
	 */
	async #resolveEffectiveArtifactsDir(): Promise<{
		sessionArtifactsDir: string | null;
		durableArtifactsDir: string | null;
		effectiveArtifactsDir: string | undefined;
		parentArtifactManager: ArtifactManager | undefined;
	}> {
		const shared = this.#sharedArtifactStore();
		if (shared) {
			return {
				sessionArtifactsDir: shared.dir,
				durableArtifactsDir: null,
				effectiveArtifactsDir: shared.dir,
				parentArtifactManager: shared.manager,
			};
		}
		const sessionFile = this.session.getSessionFile();
		const sessionArtifactsDir = sessionFile ? sessionFile.slice(0, -6) : null;
		if (sessionArtifactsDir) {
			return {
				sessionArtifactsDir,
				durableArtifactsDir: null,
				effectiveArtifactsDir: sessionArtifactsDir,
				parentArtifactManager: undefined,
			};
		}
		const durable = await this.#ensureSessionLifetimeArtifacts();
		return {
			sessionArtifactsDir: null,
			durableArtifactsDir: durable?.dir ?? null,
			effectiveArtifactsDir: durable?.dir,
			parentArtifactManager: durable?.manager,
		};
	}

	/**
	 * Create a TaskTool instance.
	 * Repository authority is captured from session cwd *before* agent discovery so
	 * multi-repo workspaces fail closed prior to context/discovery (#2901).
	 */
	static async create(session: ToolSession, options?: { runSubprocess?: typeof runSubprocess }): Promise<TaskTool> {
		const sessionRepositoryBinding = await captureRepositoryBinding(session.cwd, { displayPath: session.cwd });
		await assertExecutionRootMatchesRepositoryBinding(session.cwd, sessionRepositoryBinding);
		const { agents } = await discoverAgents(session.cwd);
		const tool = new TaskTool(session, agents, publicRepositoryBinding(sessionRepositoryBinding));
		tool.#testRunSubprocess = options?.runSubprocess;
		return tool;
	}

	/** Create catalog metadata from bundled agents only, without ambient filesystem discovery. */
	static async createForToolCatalog(session: ToolSession): Promise<TaskTool> {
		const sessionRepositoryBinding = await captureRepositoryBinding(session.cwd, { displayPath: session.cwd });
		await assertExecutionRootMatchesRepositoryBinding(session.cwd, sessionRepositoryBinding);
		return new TaskTool(session, loadBundledAgents(), publicRepositoryBinding(sessionRepositoryBinding));
	}

	/**
	 * The session's ENDPOINT-owned AsyncJobManager, falling back to the
	 * process-global instance. Concurrent top-level sessions each register
	 * their manager under their endpoint (sdk/session.ts), so a task job
	 * created by THIS session must be registered, resumed, and reported
	 * through THIS session's manager — otherwise a scope:"owned" abort
	 * consults the endpoint manager and cannot cancel or prove the task, and
	 * its completion is delivered by the wrong session's callback (review
	 * thread P1).
	 */
	#resolveOwnedJobManager(): AsyncJobManager | undefined {
		const endpointId = this.session.getAsyncEndpointId?.() ?? this.session.getSessionId?.() ?? undefined;
		return (
			this.session.getAsyncJobManager?.() ?? AsyncJobManager.forEndpoint(endpointId) ?? AsyncJobManager.instance()
		);
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

		// Re-verify session authority before using any discovered agents or scheduling work.
		try {
			await assertExecutionRootMatchesRepositoryBinding(this.session.cwd, this.#sessionRepositoryBinding);
		} catch (error) {
			const message =
				error instanceof RepositoryBindingError
					? error.message
					: error instanceof Error
						? error.message
						: String(error);
			return createTaskModeError(`Session repository binding rejected before task discovery: ${message}`);
		}

		const rawTaskItems = params.tasks ?? [];
		const taskIdValidationError = validateTaskIdsForScheduling(rawTaskItems);
		if (taskIdValidationError) {
			return createTaskModeError(taskIdValidationError);
		}
		const bindingResolution = await resolveTaskItemsWithRepositoryBindings(this.session.cwd, rawTaskItems);
		if (bindingResolution.error) {
			return createTaskModeError(bindingResolution.error);
		}
		const taskItems = bindingResolution.tasks;
		const paramsWithBindings: TaskParams = { ...params, tasks: taskItems };
		if (taskItems.length === 0) {
			return this.#executeSync(_toolCallId, paramsWithBindings, signal, onUpdate);
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

		// The session's ENDPOINT-owned manager first: with concurrent top-level
		// sessions the process-global instance may belong to a different
		// session, and an endpoint-qualified owned registration recorded here
		// must live in the SAME manager the job actually runs in — otherwise a
		// scope:"owned" abort consults the endpoint manager, cannot cancel or
		// prove the task, and returns uncertainty while the task continues
		// (review thread P1).
		const manager = this.#resolveOwnedJobManager();
		if (!manager) {
			return {
				content: [{ type: "text", text: "Subagent background execution is unavailable in this session." }],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}

		// Prefer file-backed session artifacts; otherwise allocate a session-lifetime
		// durable root so detached outputs remain readable for the parent session.
		// Resolve before ID allocation so agentOutputManager can scan the durable root.
		const { effectiveArtifactsDir: batchArtifactsDir, parentArtifactManager: asyncParentArtifactManager } =
			await this.#resolveEffectiveArtifactsDir();
		let externalTaskSessionsDir: string | undefined;
		if (!batchArtifactsDir) {
			// Durable allocation failed: keep child session jsonl under local:// only.
			// Do not advertise agent:// URIs without durable output backing.
			const asyncLocalOptions: LocalProtocolOptions = {
				getArtifactsDir: this.session.getArtifactsDir ?? (() => null),
				isManagedDestination: this.session.isManagedSessionDestination,
				getSessionId: this.session.getSessionId ?? (() => null),
			};
			await initializeLocalRoot(asyncLocalOptions);
			externalTaskSessionsDir = resolveLocalUrlToPath("local://subagents/sessions", asyncLocalOptions);
			await fs.mkdir(externalTaskSessionsDir, { recursive: true, mode: 0o700 });
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
		const failedSchedules: Array<{
			task: TaskItem & { id: string };
			taskIndex: number;
			message: string;
			signalSkip: boolean;
			duplicateDisposition?: DuplicateDisposition;
		}> = [];
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
		const ownerId = this.session.getAgentId?.() ?? undefined;
		const parentSession = this.session.getSessionFile();
		const admitDuplicateLaunch = (
			subagentId: string,
			task: TaskItem,
			policy: "warn" | "supersede",
			selfSubagentId?: string,
		): { ok: boolean; disposition?: DuplicateDisposition; error?: string; identity: DuplicateIdentity } => {
			const identity = duplicateIdentityForTask(task, params.agent, ownerId, parentSession);
			const key = duplicateIdentityKey(identity);
			const predecessors = (manager.getSubagentRecords?.({ ownerId }) ?? [])
				.filter(record => {
					if (record.subagentId === selfSubagentId || record.subagentId === subagentId) return false;
					if (record.status !== "running" && record.status !== "paused" && record.status !== "queued")
						return false;
					return record.duplicateIdentity === key;
				})
				.sort(
					(a, b) =>
						(b.currentJobId ? (manager.getJob(b.currentJobId)?.startTime ?? 0) : 0) -
							(a.currentJobId ? (manager.getJob(a.currentJobId)?.startTime ?? 0) : 0) ||
						a.subagentId.localeCompare(b.subagentId),
				);
			if (predecessors.length === 0) return { ok: true, identity };
			if (policy === "warn")
				return {
					ok: true,
					identity,
					disposition: { action: "warned", predecessorIds: predecessors.map(record => record.subagentId) },
				};
			for (const predecessor of predecessors)
				if (!manager.cancelSubagent(predecessor.subagentId, { ownerId }))
					return { ok: false, identity, error: "duplicate_supersede_failed" };
			return {
				ok: true,
				identity,
				disposition: { action: "superseded", predecessorIds: predecessors.map(record => record.subagentId) },
			};
		};
		let resumeRunner: ResumeRunner | undefined;
		if (typeof manager.setResumeRunner === "function") {
			resumeRunner = (_subagentId, message, resumeDescriptor, resumeToolCallId) => {
				const descriptor = isTaskResumeDescriptor(resumeDescriptor?.data) ? resumeDescriptor.data : undefined;
				if (!descriptor) return undefined;
				const admission = (() => {
					const identity = descriptor.duplicateIdentity;
					const key = duplicateIdentityKey(identity);
					const predecessors = manager
						.getSubagentRecords({ ownerId })
						.filter(record => {
							if (
								record.subagentId === descriptor.task.id ||
								!["running", "paused", "queued"].includes(record.status)
							)
								return false;
							return record.duplicateIdentity === key;
						})
						.sort(
							(a, b) =>
								(b.currentJobId ? (manager.getJob(b.currentJobId)?.startTime ?? 0) : 0) -
									(a.currentJobId ? (manager.getJob(a.currentJobId)?.startTime ?? 0) : 0) ||
								a.subagentId.localeCompare(b.subagentId),
						);
					if (predecessors.length === 0) return { ok: true, identity };
					if (descriptor.duplicatePolicy === "warn")
						return {
							ok: true,
							identity,
							disposition: { action: "warned", predecessorIds: predecessors.map(record => record.subagentId) },
						};
					for (const predecessor of predecessors)
						if (!manager.cancelSubagent(predecessor.subagentId, { ownerId }))
							return { ok: false, identity, error: "duplicate_supersede_failed" };
					return {
						ok: true,
						identity,
						disposition: { action: "superseded", predecessorIds: predecessors.map(record => record.subagentId) },
					};
				})();
				if (!admission.ok) {
					descriptor.lastAdmissionFailure = admission.error;
					return undefined;
				}
				if (!descriptor) return undefined;
				const forkSeeds = descriptor.forkContextSeed
					? new Map([[descriptor.task.id, descriptor.forkContextSeed]])
					: undefined;
				const resumedTask = {
					...descriptor.task,
					repositoryBinding: descriptor.repositoryBinding,
					duplicate_policy: descriptor.duplicatePolicy,
				};
				const resumeJobId = manager.register(
					"task",
					descriptor.task.id,
					async ({ signal: runSignal }) => {
						const result = await this.#executeSync(
							descriptor.toolCallId,
							{ ...descriptor.params, tasks: [resumedTask] },
							runSignal,
							undefined,
							[descriptor.task.id],
							forkSeeds,
							{
								runMode: message ? "message" : "resume",
								resumeMessage: message,
								sessionFiles: new Map([[descriptor.task.id, descriptor.sessionFile]]),
								suppressRoiReconciliation: true,
								...(descriptor.durableOutputAllowed === true
									? {}
									: {
											persistence: {
												effectiveArtifactsDir: undefined,
												parentArtifactManager: undefined,
											},
										}),
							},
						);
						const finalText = result.content.find(part => part.type === "text")?.text ?? "(no output)";
						const rawSingleResult = result.details?.results[0];
						const singleResult = rawSingleResult
							? {
									...rawSingleResult,
									duplicateDisposition: (() => {
										const initial = descriptor.initialDisposition;
										const current = admission.disposition;
										if (!initial) return current;
										if (!current) return initial;
										return {
											action: current.action,
											predecessorIds: [...new Set([...initial.predecessorIds, ...current.predecessorIds])],
										};
									})(),
								}
							: rawSingleResult;
						return subagentRunOutcomeFromSingleResult(finalText, singleResult);
					},
					{
						id: `${descriptor.task.id}-resume-${Snowflake.next()}`,
						ownerId: this.session.getAgentId?.() ?? undefined,
						metadata: {
							subagent: {
								id: descriptor.task.id,
								agent: descriptor.params.agent,
								agentSource: descriptor.agentSource,
								duplicateIdentity: duplicateIdentityKey(descriptor.duplicateIdentity),
								duplicateDisposition: (admission.disposition?.action ??
									descriptor.initialDisposition?.action) as DuplicateDisposition["action"] | undefined,
								description: descriptor.task.description,
								assignment: descriptor.task.assignment.trim(),
							},
						},
					},
				);
				// Bind the resumed job to the CURRENT resume request's tool call
				// (the original launch id would attribute it to the OLD turn, so a
				// scope:"owned" abort of the resuming turn could miss it — review
				// thread P1).
				// The registration is ENDPOINT-qualified: concurrent sessions can
				// receive the same provider-local tool-call id, and an
				// endpoint-less resolve would take the FIRST matching binding —
				// registering B's task under A's endpoint/lineage (review P1).
				registerOwnedIfLineaged(
					manager,
					resumeToolCallId ?? descriptor.toolCallId,
					resumeJobId,
					this.session.getAsyncEndpointId?.() ?? this.session.getSessionId?.() ?? undefined,
				);
				return resumeJobId;
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

		for (let i = 0; i < taskItems.length; i++) {
			const taskItem = taskItems[i];
			if (signal?.aborted) {
				failedSchedules.push({
					task: taskItem as TaskItem & { id: string },
					taskIndex: i,
					message: "cancelled before scheduling",
					signalSkip: true,
				});
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
					failedSchedules.push({
						task: skippedTask as TaskItem & { id: string },
						taskIndex: skippedIndex,
						message: "cancelled before scheduling",
						signalSkip: true,
					});
					const skippedProgress = progressByTaskId.get(skippedTask.id);
					if (skippedProgress) skippedProgress.status = "aborted";
				}
				break;
			}
			if (frozenForkSeed) {
				frozenForkSeeds.set(uniqueId, frozenForkSeed);
				// The async callback may execute through a compatibility path that retains
				// the caller's task id instead of the allocated artifact id. Preserve the
				// same immutable seed under both identities so detached execution never
				// rebuilds context after dispatch.
				frozenForkSeeds.set(taskItem.id, frozenForkSeed);
			}
			const singleParams: TaskParams = { ...params, tasks: [taskItem] };
			const label = uniqueId;
			try {
				const managedPersistence = asyncParentArtifactManager?.getManagedStore()
					? createManagedTaskPersistence(asyncParentArtifactManager, uniqueId)
					: undefined;
				const subtaskSessionFile = managedPersistence
					? null
					: path.join(batchArtifactsDir ?? externalTaskSessionsDir!, `${uniqueId}.jsonl`);
				const admission = admitDuplicateLaunch(uniqueId, taskItem, taskItem.duplicate_policy ?? "warn");
				if (!admission.ok) {
					failedSchedules.push({
						task: taskItem as TaskItem & { id: string },
						taskIndex: i,
						message: admission.error ?? "duplicate_supersede_failed",
						signalSkip: false,
						duplicateDisposition: admission.disposition,
					});
					continue;
				}
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
									persistence: {
										effectiveArtifactsDir: batchArtifactsDir,
										parentArtifactManager: asyncParentArtifactManager,
									},
								},
							);
							const finalText = result.content.find(part => part.type === "text")?.text ?? "(no output)";
							const rawSingleResult = result.details?.results[0];
							const singleResult = rawSingleResult
								? {
										...rawSingleResult,
										duplicateDisposition: rawSingleResult.duplicateDisposition ?? admission.disposition,
									}
								: rawSingleResult;
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
								progress.setupFailure = singleResult?.setupFailure;
							}
							completedJobs += 1;
							if (singleResult?.status !== "completed") {
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
							return subagentRunOutcomeFromSingleResult(finalText, singleResult);
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
								duplicateIdentity: duplicateIdentityKey(admission.identity),
								duplicateDisposition: admission.disposition?.action,
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
				registerOwnedIfLineaged(
					manager,
					_toolCallId,
					jobId,
					this.session.getAsyncEndpointId?.() ?? this.session.getSessionId?.() ?? undefined,
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
								durableOutputAllowed: Boolean(batchArtifactsDir),
								forkContextSeed: frozenForkSeed,
								agentSource: fallbackAgentSource,
								repositoryBinding: taskItem.repositoryBinding as RepositoryBinding,
								duplicateIdentity: admission.identity,
								duplicatePolicy: taskItem.duplicate_policy ?? "warn",
								initialDisposition: admission.disposition,
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
						currentJobGeneration: manager.getJob(jobId)?.generation,
						historicalJobIds: [],
						status: manager.getJob(jobId)?.status ?? "running",
						sessionFile: subtaskSessionFile,
						resumable: true,
						duplicateIdentity: duplicateIdentityKey(admission.identity),
						duplicateDisposition: admission.disposition?.action,
					});
				}
			} catch (error) {
				const message =
					error instanceof OwnerSubagentShutdownError
						? error.message
						: error instanceof Error
							? error.message
							: String(error);
				failedSchedules.push({
					task: taskItem as TaskItem & { id: string },
					taskIndex: i,
					message,
					signalSkip: false,
				});
				const progress = progressByTaskId.get(taskItem.id);
				if (progress) {
					progress.status = "failed";
				}
			}
		}

		if (failedSchedules.length > 0) {
			completedJobs += failedSchedules.length;
			failedJobs += failedSchedules.length;
		}

		const scheduleFailureReceipts = failedSchedules
			.slice()
			.sort((a, b) => a.taskIndex - b.taskIndex)
			.map((entry, index) =>
				buildTaskReceipt({
					index,
					id: entry.task.id,
					agent: params.agent,
					agentSource: fallbackAgentSource,
					task: renderTaskAssignment(entry.task.assignment, simpleMode),
					assignment: entry.task.assignment,
					description: entry.task.description,
					status: "failed",
					exitCode: 1,
					aborted: entry.signalSkip ? true : undefined,
					abortReason: entry.signalSkip ? "Cancelled before start" : undefined,
					truncated: false,
					durationMs: 0,
					tokens: 0,
					output: "",
					stderr: entry.message,
					error: entry.message,
					duplicateDisposition: entry.duplicateDisposition,
				} as SingleResult),
			);
		if (startedJobs.length === 0) {
			const failureText = `Failed to start background task jobs: ${failedSchedules.map(entry => `${entry.task.id}: ${entry.message}`).join("; ")}`;
			return {
				content: [{ type: "text", text: failureText }],
				details: { projectAgentsDir: null, results: scheduleFailureReceipts, totalDurationMs: 0 },
			};
		}

		const asyncState = completedJobs === taskItems.length ? (failedJobs > 0 ? "failed" : "completed") : "running";
		emitAsyncUpdate(
			asyncState,
			asyncState === "running"
				? `Launching ${startedJobs.length} background ${startedJobs.length === 1 ? "task" : "tasks"}...`
				: asyncState === "completed"
					? `Background task batch complete: ${completedJobs}/${taskItems.length} finished.`
					: `Background task batch complete with failures: ${failedJobs} failed.`,
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
					text:
						asyncState === "running"
							? `Started ${startedJobs.length} background task job${startedJobs.length === 1 ? "" : "s"} using ${params.agent}.${scheduleFailureSummary} Results will be delivered when complete.\n${startedListing}\n${coordinationHint}`
							: `Background task batch ${asyncState}: ${completedJobs}/${taskItems.length} finished.${scheduleFailureSummary}\n${startedListing}`,
				},
			],
			details: {
				projectAgentsDir: null,
				results: scheduleFailureReceipts,
				totalDurationMs: 0,
				progress: getProgressSnapshot(),
				async: { state: asyncState, jobId: startedJobs[0].jobId, type: "task" },
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
			persistence?: {
				effectiveArtifactsDir: string | undefined;
				parentArtifactManager: ArtifactManager | undefined;
			};
			/**
			 * Set for per-child async runs: the spawnPlan is carried for gate
			 * consistency, but batch-level ROI reconciliation must not be computed
			 * against a single child's receipts.
			 */
			suppressRoiReconciliation?: boolean;
		},
	): Promise<AgentToolResult<TaskToolDetails>> {
		const startTime = Date.now();
		// Pre-discovery authority: session cwd must still match the capture from create().
		try {
			await assertExecutionRootMatchesRepositoryBinding(this.session.cwd, this.#sessionRepositoryBinding);
		} catch (error) {
			const message =
				error instanceof RepositoryBindingError
					? error.message
					: error instanceof Error
						? error.message
						: String(error);
			return createTaskModeError(`Session repository binding rejected before task discovery: ${message}`);
		}
		const bindingResolution = await resolveTaskItemsWithRepositoryBindings(this.session.cwd, params.tasks ?? []);
		if (bindingResolution.error) {
			return createTaskModeError(bindingResolution.error);
		}
		const boundParams: TaskParams = { ...params, tasks: bindingResolution.tasks };

		const { agents, projectAgentsDir } = await discoverAgents(this.session.cwd);
		const { agent: agentName, context, schema: outputSchema } = boundParams;
		const simpleMode = this.#getTaskSimpleMode();
		const { contextEnabled, customSchemaEnabled } = getTaskSimpleModeCapabilities(simpleMode);
		const sharedContext = contextEnabled ? context?.trim() : undefined;
		const isolationMode = this.session.settings.get("task.isolation.mode");
		const isolationRequested = "isolated" in boundParams ? boundParams.isolated === true : false;
		const isIsolated = isolationMode !== "none" && isolationRequested;
		const mergeMode = this.session.settings.get("task.isolation.merge");
		const commitStyle = this.session.settings.get("task.isolation.commits");
		const maxConcurrency = this.session.settings.get("task.maxConcurrency");
		const taskDepth = this.session.taskDepth ?? 0;
		const subagentLspEnabled = (this.session.enableLsp ?? true) && this.session.settings.get("task.enableLsp");

		if (isolationMode === "none" && "isolated" in boundParams) {
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
			boundParams.tasks ?? [],
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
		// A live active model profile claims persisted agent overrides: bare
		// profile aliases may re-resolve to an equivalent provider variant at
		// dispatch. Manual/direct sessions (no active profile) stay exact.
		const parentActiveModelProfile = (
			this.session as { getActiveModelProfile?: () => string | undefined }
		).getActiveModelProfile?.();
		const parentProfileDefinition = parentActiveModelProfile
			? this.session.modelRegistry?.getModelProfile?.(parentActiveModelProfile)
			: undefined;
		const parentOwnedModelProfile =
			parentProfileDefinition &&
			Object.hasOwn(resolveProfileBindings(parentProfileDefinition).agentModelOverrides, agentName)
				? parentActiveModelProfile
				: undefined;
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
		if (!boundParams.tasks || boundParams.tasks.length === 0) {
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

		const tasks = boundParams.tasks;
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

		// File-backed session artifacts, or a session-lifetime durable temp root for
		// in-memory parents. Never use a per-task temp dir that is deleted on return —
		// advertised agent:// URIs must remain readable for the parent session lifetime.
		const { effectiveArtifactsDir, parentArtifactManager } =
			executionOverrides?.persistence ?? (await this.#resolveEffectiveArtifactsDir());
		const hasDurableOutputBacking = Boolean(effectiveArtifactsDir);

		// Share the parent session's local:// root with subagents so they read/write the same scratch space
		const localProtocolOptions: LocalProtocolOptions = {
			getArtifactsDir: this.session.getArtifactsDir ?? (() => null),
			isManagedDestination: this.session.isManagedSessionDestination,
			getSessionId: this.session.getSessionId ?? (() => null),
		};

		// Subagents adopt the parent's ArtifactManager (including session-lifetime
		// durable managers) so artifact IDs are unique and agent:// resolves under
		// scoped authorization for the whole tree.

		// Initialize progress tracking
		const progressMap = new Map<number, AgentProgress>();
		const isolatedPatchBytes = new Map<string, Buffer>();

		// Update callback
		const emitProgress = () => {
			const progress = Array.from(progressMap.values()).sort((a, b) => a.index - b.index);
			onUpdate?.({
				content: [{ type: "text", text: `Running ${tasks.length} agents...` }],
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

			const effectiveAutorouting = this.session.settings.getEffectiveAutorouting();
			const registry = this.session.modelRegistry as
				| {
						getAvailable?: () => Model[];
						getAll?: () => Model[];
						getApiKey?: (model: Model, credentialSessionId?: string) => Promise<string | undefined>;
				  }
				| undefined;
			const routingSnapshot = registry?.getAll?.() ?? registry?.getAvailable?.();
			const routingByIndex = new Map<number, RoutingOutcome>();
			const routingCandidatesByIndex = new Map<number, string[]>();
			const routingSkipsByIndex = new Map<number, Array<{ selector: string; code: AutoroutingReasonCode }>>();
			for (let i = 0; i < tasksWithUniqueIds.length; i++) {
				const task = tasksWithUniqueIds[i];
				const outcome = routingSnapshot
					? resolveTaskRouting({
							effectiveAutorouting,
							requestedTier: task.tier,
							availableModels: routingSnapshot,
						})
					: effectiveAutorouting.active
						? {
								kind: "manual-fallback" as const,
								tier: task.tier ?? "balanced",
								requestedTier: task.tier,
								...(task.tier === undefined ? { defaultTierApplied: true as const } : {}),
								attemptedSelectorCount: 0,
								reason: "tier_unmatched" as const,
							}
						: { kind: "disabled" as const };

				routingByIndex.set(i, outcome);
				if (outcome.kind === "disabled" || !routingSnapshot || !effectiveAutorouting.active) continue;

				// Enumerate every configured selector before choosing a routed or manual
				// outcome. This keeps AC12 evidence complete even when every selector is
				// missing, malformed, or disabled.
				const configured = effectiveAutorouting.map[outcome.tier] ?? [];
				const candidates: string[] = [];
				const skips: Array<{ selector: string; code: AutoroutingReasonCode }> = [];
				const disabledProviders = new Set(
					this.session.settings.get("disabledProviders").map(provider => provider.toLowerCase()),
				);
				for (const selector of configured) {
					const slash = selector.indexOf("/");
					const provider = slash > 0 ? selector.slice(0, slash).toLowerCase() : "";
					// Disabled takes precedence over snapshot presence: a disabled provider
					// that is also absent must remain truthfully classified as disabled.
					if (disabledProviders.has(provider)) {
						skips.push({ selector, code: "provider_disabled" });
						continue;
					}
					const normalized = normalizeTierSelector(selector, routingSnapshot);
					if (!("pinned" in normalized)) {
						skips.push({
							selector,
							code: "rejected" in normalized ? "selector_not_provider_qualified" : "snapshot_missing",
						});
						continue;
					}
					candidates.push(normalized.pinned);
				}
				routingCandidatesByIndex.set(i, candidates);
				routingSkipsByIndex.set(i, skips);
			}
			const resolveAutoroutingCandidates = async (
				index: number,
			): Promise<{
				candidates: string[];
				skips: Array<{ selector: string; code: AutoroutingReasonCode }>;
				preflightErrors: Map<string, unknown>;
			}> => {
				const candidates = [...(routingCandidatesByIndex.get(index) ?? [])];
				const skips = [...(routingSkipsByIndex.get(index) ?? [])];
				const preflightErrors = new Map<string, unknown>();
				if (!registry?.getApiKey || !routingSnapshot) return { candidates, skips, preflightErrors };
				const authenticated: string[] = [];
				for (const selector of candidates) {
					const model = findRoutingSnapshotModel(selector, routingSnapshot);
					if (!model) {
						skips.push({ selector, code: "snapshot_missing" });
						continue;
					}
					try {
						const key = await registry.getApiKey(
							model,
							this.session.getCredentialSessionId?.() ?? this.session.getSessionId?.() ?? undefined,
						);
						if (key) authenticated.push(selector);
						else skips.push({ selector, code: "credential_unavailable" });
					} catch (error) {
						// Preserve the candidate for executor preflight, which records the
						// terminal lookup failure in the routing ledger.
						preflightErrors.set(selector, error);
						authenticated.push(selector);
					}
				}
				return { candidates: authenticated, skips, preflightErrors };
			};
			const effectivePatterns = (index: number): string | string[] => {
				const outcome = routingByIndex.get(index);
				return outcome?.kind === "routed" ? [outcome.pinnedSelector] : modelOverride;
			};
			const routeEvidenceForSynthetic = (outcome: RoutingOutcome | undefined): TaskRoutingEvidence | undefined => {
				if (!outcome || outcome.kind === "disabled") return undefined;
				return {
					tier: outcome.tier,
					requestedTier: outcome.requestedTier,
					defaultTierApplied: outcome.defaultTierApplied,
					requestedSelector: outcome.kind === "routed" ? outcome.pinnedSelector : "manual-model-chain",
					notExecuted: true,
					substitutions: [],
					manualFallbackReason: outcome.kind === "manual-fallback" ? outcome.reason : undefined,
					note: `${outcome.tier}; ${outcome.kind === "manual-fallback" ? outcome.reason : "not-executed"}`,
				};
			};

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
			const parentMcpManager = this.session.getMcpManager?.();
			// Exact-config tools-only managers belong to the top-level ACP session and cannot be reused by sub-sessions.
			const reusableParentMcpManager = parentMcpManager?.isToolsOnly() ? undefined : parentMcpManager;

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
					modelOverride: effectivePatterns(i),
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
				// The session's ENDPOINT-owned manager (resolved once per task so
				// model metadata and live handles land in the SAME manager the
				// job runs in — review thread P1).
				const manager = this.#resolveOwnedJobManager();
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

				const routingOutcome = routingByIndex.get(index);

				const routeEvidence = (
					outcome: RoutingOutcome | undefined,
					freshOnResume = false,
				): TaskRoutingEvidence | undefined => {
					if (!outcome || outcome.kind === "disabled") return undefined;
					const noteParts = [
						`${outcome.tier}${outcome.defaultTierApplied ? " (default)" : ""}`,
						outcome.kind === "manual-fallback" ? outcome.reason : undefined,
						freshOnResume ? "freshOnResume" : undefined,
					].filter((part): part is string => part !== undefined);
					return {
						tier: outcome.tier,
						requestedTier: outcome.requestedTier,
						defaultTierApplied: outcome.defaultTierApplied,
						requestedSelector: outcome.kind === "routed" ? outcome.pinnedSelector : "manual-model-chain",
						effectiveModel: outcome.kind === "routed" ? outcome.pinnedSelector : "manual-model-chain",
						substitutions: [],
						manualFallbackReason: outcome.kind === "manual-fallback" ? outcome.reason : undefined,
						freshOnResume: freshOnResume ? true : undefined,
						note: noteParts.join("; "),
					};
				};

				const effectiveRunMode = overrides?.runMode ?? executionOverrides?.runMode;
				const autoroutingInitial =
					routingOutcome?.kind === "routed" && (effectiveRunMode ?? "initial") === "initial";
				const autoroutingData =
					(effectiveRunMode ?? "initial") === "initial" && routingOutcome && routingOutcome.kind !== "disabled"
						? routingOutcome.kind === "routed"
							? await resolveAutoroutingCandidates(index)
							: {
									candidates: undefined,
									skips: [...(routingSkipsByIndex.get(index) ?? [])],
									preflightErrors: new Map(),
								}
						: { candidates: undefined, skips: undefined, preflightErrors: new Map() };
				const routingForRun = routeEvidence(
					routingOutcome,
					effectiveRunMode === "resume" || effectiveRunMode === "message",
				);
				if (routingForRun && autoroutingData.skips)
					Object.assign(routingForRun, buildBoundedRoutingSkips(autoroutingData.skips));
				const taskSessionFile = managedPersistence
					? null
					: (overrides?.sessionFile ?? executionOverrides?.sessionFiles?.get(task.id) ?? null);
				const taskRepositoryBinding = repositoryBindingFromTask(task) ?? this.#sessionRepositoryBinding;
				// Declared paths (relativeSubdir) must stay under the bound root before spawn.
				if (taskRepositoryBinding.relativeSubdir) {
					assertPathUnderRepositoryBinding(taskRepositoryBinding, ".");
				}
				if (!isIsolated) {
					await assertExecutionRootMatchesRepositoryBinding(this.session.cwd, taskRepositoryBinding);
					const result = await this.#runSubprocess({
						cwd: this.session.cwd,
						agent: effectiveAgent,
						task: renderTaskAssignment(task.assignment, simpleMode),
						assignment: task.assignment.trim(),
						executionMode: task.executionMode,
						context: sharedContext,
						description: task.description,
						index,
						id: task.id,
						runMode: effectiveRunMode,

						resumeMessage: overrides?.resumeMessage ?? executionOverrides?.resumeMessage,
						subagentId: task.id,
						asyncJobManager: manager,
						taskDepth,
						modelOverride: effectivePatterns(index),
						parentActiveModelPattern,
						parentActiveModelProfile: parentOwnedModelProfile,
						parentSessionId: this.session.getSessionId?.() ?? undefined,
						parentCredentialSessionId:
							this.session.getCredentialSessionId?.() ?? this.session.getSessionId?.() ?? undefined,
						thinkingLevel: thinkingLevelOverride,
						outputSchema: effectiveOutputSchema,
						sessionFile: taskSessionFile,
						persistArtifacts: hasDurableOutputBacking,
						artifactsDir: effectiveArtifactsDir,
						managedPersistence,
						contextFile: contextFilePath,
						ircAvailable: hasAvailableIrcTool(this.session),
						enableLsp: subagentLspEnabled,
						signal,
						eventBus: this.session.eventBus,
						routing: routingForRun,
						autoroutingCandidates: autoroutingInitial ? autoroutingData.candidates : undefined,
						autoroutingSkips: autoroutingInitial ? autoroutingData.skips : undefined,
						autoroutingPreflightErrors: autoroutingInitial ? autoroutingData.preflightErrors : undefined,
						autoroutingPreflight: autoroutingInitial,

						onProgress: progress => {
							progressMap.set(index, {
								...structuredClone(progress),
							});
							this.#resolveOwnedJobManager()?.recordSubagentProgress(task.id, progress);
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
						parentMcpManager: reusableParentMcpManager,
						forkContextSeed,
					});
					return {
						...result,
						...(forkContext ? { forkContext } : {}),
						forkContextAdvisory,
						repositoryBinding: publicRepositoryBinding(taskRepositoryBinding),
					};
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
					// Isolated worktrees must preserve the source repository identity (#2901).
					await assertExecutionRootMatchesRepositoryBinding(isolationDir, taskRepositoryBinding);

					const result = await this.#runSubprocess({
						cwd: this.session.cwd,
						worktree: isolationDir,
						agent: effectiveAgent,
						task: renderTaskAssignment(task.assignment, simpleMode),
						assignment: task.assignment.trim(),
						executionMode: task.executionMode,
						context: sharedContext,
						description: task.description,
						index,
						id: task.id,
						runMode: effectiveRunMode,

						resumeMessage: overrides?.resumeMessage ?? executionOverrides?.resumeMessage,
						subagentId: task.id,
						asyncJobManager: manager,
						taskDepth,
						modelOverride: effectivePatterns(index),
						parentActiveModelPattern,
						parentActiveModelProfile: parentOwnedModelProfile,
						parentSessionId: this.session.getSessionId?.() ?? undefined,
						parentCredentialSessionId:
							this.session.getCredentialSessionId?.() ?? this.session.getSessionId?.() ?? undefined,
						thinkingLevel: thinkingLevelOverride,
						outputSchema: effectiveOutputSchema,
						sessionFile: taskSessionFile,
						persistArtifacts: hasDurableOutputBacking,
						artifactsDir: effectiveArtifactsDir,
						managedPersistence,
						contextFile: contextFilePath,
						ircAvailable: hasAvailableIrcTool(this.session),
						enableLsp: subagentLspEnabled,
						signal,
						eventBus: this.session.eventBus,
						routing: routingForRun,
						autoroutingCandidates: autoroutingInitial ? autoroutingData.candidates : undefined,
						autoroutingSkips: autoroutingInitial ? autoroutingData.skips : undefined,
						autoroutingPreflightErrors: autoroutingInitial ? autoroutingData.preflightErrors : undefined,
						autoroutingPreflight: autoroutingInitial,
						onProgress: progress => {
							progressMap.set(index, {
								...structuredClone(progress),
							});
							this.#resolveOwnedJobManager()?.recordSubagentProgress(task.id, progress);
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
						parentMcpManager: reusableParentMcpManager,
						forkContextSeed,
					});
					let capturedResult = {
						...result,
						...(forkContext ? { forkContext } : {}),
						forkContextAdvisory,
						repositoryBinding: publicRepositoryBinding(taskRepositoryBinding),
					};
					const taskSucceeded =
						capturedResult.exitCode === 0 &&
						!capturedResult.error &&
						!capturedResult.aborted &&
						!capturedResult.paused;
					if (mergeMode === "branch" && taskSucceeded) {
						try {
							const commitMsg =
								commitStyle === "ai" && this.session.modelRegistry
									? async (diff: string) => {
											return generateCommitMessage(
												diff,
												this.session.modelRegistry!,
												this.session.settings,
												this.session.getCredentialSessionId?.() ??
													this.session.getSessionId?.() ??
													undefined,
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
							capturedResult = {
								...capturedResult,
								branchName: commitResult?.branchName,
								nestedPatches: commitResult?.nestedPatches,
								producedChanges,
							};
						} catch (mergeErr) {
							// Agent succeeded but branch commit failed — clean up stale branch
							const branchName = `gjc/task/${task.id}`;
							await git.branch.tryDelete(repoRoot, branchName);
							const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
							capturedResult = { ...capturedResult, error: `Merge failed: ${msg}` };
						}
					}
					try {
						const delta = await captureDeltaPatch(isolationDir, taskBaseline);
						await initializeLocalRoot(localProtocolOptions);
						const artifactId = validateAllocatedTaskId(task.id);
						const patchUri = `local://subagents/${artifactId}-${Snowflake.next()}.patch`;
						const patchPath = resolveLocalUrlToPath(patchUri, localProtocolOptions);
						const rootPatchBytes = Buffer.from(delta.rootPatch, "utf8");
						const recoveryBytes = Buffer.from(serializeRecoveryPatchBundle(delta), "utf8");
						await fs.mkdir(path.dirname(patchPath), { recursive: true, mode: 0o700 });
						await Bun.write(patchPath, recoveryBytes);
						isolatedPatchBytes.set(patchPath, rootPatchBytes);
						const producedChanges = Boolean(
							delta.rootPatch.trim() || delta.nestedPatches.length || delta.captureErrors?.length,
						);
						const recoveryRef =
							recoveryBytes.byteLength > 0
								? {
										uri: patchUri,
										sizeBytes: recoveryBytes.byteLength,
										sha256: createHash("sha256").update(recoveryBytes).digest("hex"),
										durability: "session" as const,
									}
								: undefined;
						const captureError = delta.captureErrors?.length
							? `Patch capture incomplete: ${delta.captureErrors.join("; ")}`
							: undefined;
						const resultError = captureError
							? `${capturedResult.error ? `${capturedResult.error}; ` : ""}${captureError}`
							: capturedResult.error;
						return {
							...capturedResult,
							...(resultError ? { error: resultError } : {}),
							patchPath,
							nestedPatches: delta.nestedPatches,
							producedChanges,
							recoveryRef,
						};
					} catch (patchErr) {
						const msg = patchErr instanceof Error ? patchErr.message : String(patchErr);
						const existingError = capturedResult.error ? `${capturedResult.error}; ` : "";
						return { ...capturedResult, error: `${existingError}Patch capture failed: ${msg}` };
					}
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
						modelOverride: effectivePatterns(index),
						routing: routeEvidenceForSynthetic(routingByIndex.get(index)),

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
					modelOverride: effectivePatterns(index),
					routing: routeEvidenceForSynthetic(routingByIndex.get(index)),
					error: "Cancelled before start",
					aborted: true,
					abortReason: "Cancelled before start",
				};
			});
			// Only advertise agent:// when outputs land on durable backing (file-backed
			// session artifacts or the session-lifetime durable temp root). Ephemeral
			// or failed allocation must not emit dead URIs (#3471 / #295).
			if (!hasDurableOutputBacking) {
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
			let rootPatchTexts: string[] = [];
			let mergedBranchesForNestedPatches: Set<string> | null = null;
			let mergePhaseFailed = false;
			const setRecoveryAvailable = (result: SingleResult): void => {
				if (!result.recoveryRef) return;
				result.persistence = {
					outcome: "recovery_available",
					ownerWorktreeApplied: false,
					recoveryRef: result.recoveryRef,
				};
			};
			if (isIsolated && repoRoot) {
				try {
					if (mergeMode === "branch") {
						// Branch mode: merge task branches sequentially
						const branchEntries = results
							.filter(r => r.branchName && r.exitCode === 0 && !r.error && !r.aborted && !r.paused)
							.map(r => ({ branchName: r.branchName!, taskId: r.id, description: r.description }));

						if (branchEntries.length === 0) {
							changesApplied = true;
							hadAnyChanges = false;
							mergeSummary = "\n\nNo changes to apply.";
						} else {
							const mergeResult = await mergeTaskBranches(repoRoot, branchEntries);
							mergedBranchesForNestedPatches = new Set(
								mergeResult.merged.filter(branchName => !mergeResult.failed.includes(branchName)),
							);
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

						for (const result of results) {
							const hasChanges = Boolean(
								result.branchName || result.nestedPatches?.length || result.recoveryRef,
							);
							if (!hasChanges) {
								if (result.exitCode === 0 && !result.error && !result.aborted && !result.paused) {
									result.persistence = { outcome: "no_changes", ownerWorktreeApplied: true };
								}
								continue;
							}
							if (
								result.branchName &&
								mergedBranchesForNestedPatches?.has(result.branchName) &&
								result.exitCode === 0 &&
								!result.error &&
								!result.aborted &&
								!result.paused
							) {
								result.persistence = {
									outcome: "applied",
									ownerWorktreeApplied: true,
									recoveryRef: result.recoveryRef,
								};
							} else {
								setRecoveryAvailable(result);
							}
						}

						// Clean up merged branches (keep failed ones for manual resolution)
						const allBranches = branchEntries.map(b => b.branchName);
						if (changesApplied) {
							await cleanupTaskBranches(repoRoot, allBranches);
						}
					} else {
						// Patch mode: combine and apply only successful task patches. Failed/interrupted patches remain recovery-only.
						const successfulPatchResults = results.filter(
							result => result.exitCode === 0 && !result.error && !result.aborted && !result.paused,
						);
						const patchesInOrder = successfulPatchResults
							.map(result => result.patchPath)
							.filter(Boolean) as string[];
						const missingPatch = successfulPatchResults.some(result => !result.patchPath);
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
								rootPatchTexts = nonEmptyPatches.map(patchPath =>
									isolatedPatchBytes.get(patchPath)!.toString("utf8"),
								);
								const combinedPatch = rootPatchTexts
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

						if (changesApplied && rootPatchTexts.length > 0 && baseline) {
							changesApplied = await verifyRootPatchesApplied(repoRoot, baseline, rootPatchTexts);
						}

						for (const result of results) {
							const patchBytes = result.patchPath ? isolatedPatchBytes.get(result.patchPath) : undefined;
							const hasChanges = Boolean(
								patchBytes?.toString("utf8").trim() ||
									(result.nestedPatches && result.nestedPatches.length > 0) ||
									result.recoveryRef,
							);
							if (!hasChanges) {
								if (result.exitCode === 0 && !result.error && !result.aborted && !result.paused) {
									result.persistence = {
										outcome: "no_changes",
										ownerWorktreeApplied: true,
									};
								}
								continue;
							}
							if (
								changesApplied &&
								patchBytes &&
								result.exitCode === 0 &&
								!result.error &&
								!result.aborted &&
								!result.paused
							) {
								result.persistence = {
									outcome: "applied",
									ownerWorktreeApplied: true,
									recoveryRef: result.recoveryRef,
								};
							} else {
								result.persistence = {
									outcome: "recovery_available",
									ownerWorktreeApplied: false,
									recoveryRef: result.recoveryRef,
								};
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
					mergePhaseFailed = true;
					for (const result of results) {
						if (result.producedChanges || result.recoveryRef || result.nestedPatches?.length) {
							setRecoveryAvailable(result);
						}
					}
					mergeSummary = `\n\n<system-notification>Merge phase failed: ${msg}\nTask outputs are preserved but changes were not applied.</system-notification>`;
				}
			}

			// Apply nested repo patches (separate from parent git)
			if (isIsolated && repoRoot && !mergePhaseFailed && (mergeMode === "branch" || changesApplied !== false)) {
				const allNestedPatches = results
					.filter(r => {
						if (
							!r.nestedPatches ||
							r.nestedPatches.length === 0 ||
							r.exitCode !== 0 ||
							r.error ||
							r.aborted ||
							r.paused
						) {
							return false;
						}
						if (mergeMode !== "branch") {
							return true;
						}
						if (!r.branchName) {
							return true;
						}
						if (!mergedBranchesForNestedPatches) {
							return false;
						}
						return mergedBranchesForNestedPatches.has(r.branchName);
					})
					.flatMap(r => r.nestedPatches!);
				if (allNestedPatches.length > 0) {
					try {
						await applyNestedPatches(repoRoot, allNestedPatches);
						if (!baseline || !(await verifyNestedPatchesApplied(repoRoot, baseline, allNestedPatches))) {
							throw new Error("Nested repository persistence proof failed");
						}
						for (const result of results) {
							const rootApplied =
								mergeMode !== "branch"
									? changesApplied !== false
									: !result.branchName || Boolean(mergedBranchesForNestedPatches?.has(result.branchName));
							if (
								result.nestedPatches?.length &&
								result.exitCode === 0 &&
								!result.error &&
								!result.aborted &&
								!result.paused &&
								rootApplied
							) {
								result.persistence = {
									outcome: "applied",
									ownerWorktreeApplied: true,
									recoveryRef: result.recoveryRef,
								};
							}
						}
					} catch {
						changesApplied = false;
						for (const result of results) {
							if (result.nestedPatches?.length) setRecoveryAvailable(result);
						}
						mergeSummary +=
							"\n\n<system-notification>Some nested repository patches failed to apply; affected tasks remain recovery-only.</system-notification>";
					}
				}
			}

			// Build final output - match plugin format
			const totalDuration = Date.now() - startTime;
			const receipts = results.map(buildTaskReceipt);
			const cancelledCount = receipts.filter(r => r.status === "aborted").length;
			const successCount = receipts.filter(r => r.status === "completed").length;
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
					routing: projectRoutingForSummary(r.routing),
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

			// Session-lifetime durable dirs must outlive this return so parent +
			// same-session descendants can resolve agent://. Do not rm them here.

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
