import * as z from "zod/v4";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { MemoryContract } from "./memory-contract";

export const MASTER_ORCHESTRATION_TOOL_NAMES = [
	"master_queue_list",
	"master_queue_enqueue",
	"master_queue_assign",
	"master_worker_create",
	"master_worker_observe",
	"master_worker_follow_up",
	"master_record_decision",
	"master_escalate",
	"master_claim_request",
	"master_memory_read",
	"master_memory_write",
] as const;

export type MasterOrchestrationToolName = (typeof MASTER_ORCHESTRATION_TOOL_NAMES)[number];
export type MasterToolPayload = unknown;

export interface MasterQueueListInput {
	readonly masterName: string;
	readonly limit?: number;
	readonly cursor?: string | null;
	readonly signal?: AbortSignal;
}

export interface MasterQueueEnqueueInput {
	readonly masterName: string;
	readonly idempotencyKey: string;
	readonly priority: "urgent_user" | "user" | "autonomous";
	readonly summary: string;
	readonly workdir?: string | null;
	readonly taskId?: string;
	readonly source: "master";
	readonly signal?: AbortSignal;
}

export interface MasterQueueAssignInput {
	readonly masterName: string;
	readonly leaseId: string;
	readonly signal?: AbortSignal;
}

export interface MasterQueueAdapter {
	list(input: MasterQueueListInput): Promise<MasterToolPayload>;
	enqueue(input: MasterQueueEnqueueInput): Promise<MasterToolPayload>;
	assign(input: MasterQueueAssignInput): Promise<MasterToolPayload>;
}

export interface MasterWorkerCreateInput {
	readonly masterName: string;
	readonly taskId?: string;
	readonly workdir: string;
	readonly prompt: string;
	readonly idempotencyKey: string;
	readonly signal?: AbortSignal;
}

export interface MasterWorkerObserveInput {
	readonly masterName: string;
	readonly workerSessionId: string;
	readonly action: "action_needed" | "context_update" | "turn_stream";
	readonly signal?: AbortSignal;
}

export interface MasterWorkerFollowUpInput {
	readonly masterName: string;
	readonly workerSessionId: string;
	readonly prompt: string;
	readonly idempotencyKey: string;
	readonly queue?: boolean;
	readonly force?: boolean;
	readonly signal?: AbortSignal;
}

export interface MasterWorkerAdapter {
	create(input: MasterWorkerCreateInput): Promise<MasterToolPayload>;
	observe(input: MasterWorkerObserveInput): Promise<MasterToolPayload>;
	followUp(input: MasterWorkerFollowUpInput): Promise<MasterToolPayload>;
}

export type MasterDecisionOutcome = "follow_up" | "escalated" | "assigned" | "completed" | "blocked";

export type MasterDecisionTrigger =
	| {
			readonly kind: "worker_action";
			readonly workerSessionId: string;
			readonly actionId: string;
			readonly actionKind: "ask" | "idle";
			readonly taskId: string | null;
	  }
	| { readonly kind: "task_dispatch"; readonly taskId: string }
	| { readonly kind: "worker_terminal"; readonly workerSessionId: string; readonly taskId: string }
	| { readonly kind: "daemon_recovery"; readonly recoveryId: string };

export interface MasterDoctrineEvidence {
	readonly revision: string;
	readonly sha256: string;
}

export interface MasterMemoryEvidence {
	readonly availability: "available" | "unavailable";
	readonly activityIds: readonly string[];
}

export interface MasterRecordDecisionInput {
	readonly masterName: string;
	readonly decisionId?: string;
	readonly trigger: MasterDecisionTrigger;
	readonly outcome: MasterDecisionOutcome;
	readonly reason: string;
	readonly doctrine: MasterDoctrineEvidence;
	readonly memory: MasterMemoryEvidence;
	readonly signal?: AbortSignal;
}

export interface MasterEscalateInput {
	readonly masterName: string;
	readonly decisionId?: string;
	readonly workerSessionId?: string;
	readonly taskId?: string;
	readonly reason: string;
	readonly presentation?: string;
	readonly trigger?: MasterDecisionTrigger;
	readonly doctrine?: MasterDoctrineEvidence;
	readonly memory?: MasterMemoryEvidence;
	readonly signal?: AbortSignal;
}

export interface MasterDecisionAdapter {
	record(input: MasterRecordDecisionInput): Promise<MasterToolPayload>;
	escalate(input: MasterEscalateInput): Promise<MasterToolPayload>;
}

export interface MasterClaimRequestInput {
	readonly masterName: string;
	readonly authorizationId: string;
	readonly signal?: AbortSignal;
}

export interface MasterClaimAdapter {
	request(input: MasterClaimRequestInput): Promise<MasterToolPayload>;
}

export interface MasterOrchestrationToolDependencies {
	readonly masterName: string;
	readonly queue: MasterQueueAdapter;
	readonly workers: MasterWorkerAdapter;
	readonly decisions: MasterDecisionAdapter;
	readonly claims: MasterClaimAdapter;
	readonly memory: MemoryContract;
	readonly catalog?: readonly string[];
}

export class MasterToolCatalogError extends Error {
	readonly code = "master_tool_catalog_invalid" as const;
	readonly missing: readonly string[];
	readonly extra: readonly string[];
	readonly duplicates: readonly string[];

	constructor(missing: readonly string[], extra: readonly string[], duplicates: readonly string[]) {
		const fragments: string[] = [];
		if (duplicates.length > 0) fragments.push(`duplicates=${duplicates.join(",")}`);
		if (missing.length > 0) fragments.push(`missing=${missing.join(",")}`);
		if (extra.length > 0) fragments.push(`extra=${extra.join(",")}`);
		super(`Master orchestration tool catalog is not exact: ${fragments.join("; ")}`);
		this.name = "MasterToolCatalogError";
		this.missing = [...missing];
		this.extra = [...extra];
		this.duplicates = [...duplicates];
	}
}

export class MasterToolDependencyError extends Error {
	readonly code = "master_tool_dependency_missing" as const;

	constructor(message: string) {
		super(message);
		this.name = "MasterToolDependencyError";
	}
}

export class MasterToolInputError extends Error {
	readonly code = "master_tool_input_invalid" as const;

	constructor(message: string) {
		super(message);
		this.name = "MasterToolInputError";
	}
}

function canonicalMasterName(value: unknown): value is string {
	return typeof value === "string" && /^[a-z][a-z0-9-]{0,62}$/.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCallable(value: unknown, name: string): boolean {
	return isObject(value) && typeof value[name] === "function";
}

function assertDependencies(value: MasterOrchestrationToolDependencies): void {
	if (!isObject(value)) throw new MasterToolDependencyError("Master tool dependencies are required.");
	if (!canonicalMasterName(value.masterName))
		throw new MasterToolDependencyError("masterName must match [a-z][a-z0-9-]{0,62}.");
	if (
		!hasCallable(value.queue, "list") ||
		!hasCallable(value.queue, "enqueue") ||
		!hasCallable(value.queue, "assign")
	) {
		throw new MasterToolDependencyError("Queue list, enqueue, and assign adapters are required.");
	}
	if (
		!hasCallable(value.workers, "create") ||
		!hasCallable(value.workers, "observe") ||
		!hasCallable(value.workers, "followUp")
	) {
		throw new MasterToolDependencyError("Worker create, observe, and follow-up adapters are required.");
	}
	if (!hasCallable(value.decisions, "record") || !hasCallable(value.decisions, "escalate")) {
		throw new MasterToolDependencyError("Decision record and escalation adapters are required.");
	}
	if (!hasCallable(value.claims, "request")) throw new MasterToolDependencyError("Claim request adapter is required.");
	if (!isObject(value.memory) || typeof value.memory.read !== "function" || typeof value.memory.write !== "function") {
		throw new MasterToolDependencyError("Memory read and write adapters are required.");
	}
}

function duplicateNames(names: readonly string[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) duplicates.add(name);
		seen.add(name);
	}
	return [...duplicates].sort();
}

export function assertMasterOrchestrationToolCatalog(names: readonly string[]): void {
	const duplicates = duplicateNames(names);
	const expected = new Set<string>(MASTER_ORCHESTRATION_TOOL_NAMES);
	const actual = new Set(names);
	const missing = [...expected].filter(name => !actual.has(name)).sort();
	const extra = [...actual].filter(name => !expected.has(name)).sort();
	if (
		duplicates.length > 0 ||
		missing.length > 0 ||
		extra.length > 0 ||
		names.length !== MASTER_ORCHESTRATION_TOOL_NAMES.length
	) {
		throw new MasterToolCatalogError(missing, extra, duplicates);
	}
}

export const assertExactMasterToolCatalog = assertMasterOrchestrationToolCatalog;
export const validateMasterOrchestrationToolCatalog = assertMasterOrchestrationToolCatalog;

const opaqueId = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[\x20-\x7e]+$/);
const nonEmptyText = z.string().min(1);
const positiveSafeInteger = z
	.number()
	.refine(value => Number.isSafeInteger(value) && value >= 1, "must be a positive safe integer");
const boundedPageSize = positiveSafeInteger.refine(value => value <= 50, "must be at most 50");
const taskId = opaqueId;
const workerSessionId = opaqueId;
const workdir = nonEmptyText;
const idempotencyKey = opaqueId;
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const queueListParameters = z
	.object({
		limit: boundedPageSize.optional(),
		cursor: z.union([opaqueId, z.null()]).optional(),
	})
	.strict();

const queueEnqueueParameters = z
	.object({
		idempotencyKey,
		priority: z.literal("autonomous"),
		summary: nonEmptyText,
		workdir: z.union([workdir, z.null()]).optional(),
		taskId: taskId.optional(),
	})
	.strict();

const queueAssignParameters = z.object({ leaseId: opaqueId }).strict();

const workerCreateParameters = z
	.object({
		taskId: taskId.optional(),
		workdir,
		prompt: nonEmptyText,
		idempotencyKey,
	})
	.strict();

const workerObserveParameters = z
	.object({
		workerSessionId,
		action: z.enum(["action_needed", "context_update", "turn_stream"]).optional(),
	})
	.strict();

const workerFollowUpParameters = z
	.object({
		workerSessionId,
		prompt: nonEmptyText,
		idempotencyKey,
		queue: z.boolean().optional(),
		force: z.boolean().optional(),
	})
	.strict();

const decisionTriggerParameters = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("worker_action"),
			workerSessionId,
			actionId: opaqueId,
			actionKind: z.enum(["ask", "idle"]),
			taskId: z.union([taskId, z.null()]),
		})
		.strict(),
	z.object({ kind: z.literal("task_dispatch"), taskId }).strict(),
	z.object({ kind: z.literal("worker_terminal"), workerSessionId, taskId }).strict(),
	z.object({ kind: z.literal("daemon_recovery"), recoveryId: opaqueId }).strict(),
]);

const doctrineEvidenceParameters = z.object({ revision: opaqueId, sha256 }).strict();
const memoryEvidenceParameters = z
	.object({
		availability: z.enum(["available", "unavailable"]),
		activityIds: z.array(opaqueId).max(32),
	})
	.strict();

const recordDecisionParameters = z
	.object({
		decisionId: opaqueId.optional(),
		trigger: decisionTriggerParameters,
		outcome: z.enum(["follow_up", "escalated", "assigned", "completed", "blocked"]),
		reason: nonEmptyText,
		doctrine: doctrineEvidenceParameters,
		memory: memoryEvidenceParameters,
	})
	.strict();

const escalateParameters = z
	.object({
		decisionId: opaqueId.optional(),
		workerSessionId: workerSessionId.optional(),
		taskId: taskId.optional(),
		reason: nonEmptyText,
		presentation: nonEmptyText.optional(),
		trigger: decisionTriggerParameters.optional(),
		doctrine: doctrineEvidenceParameters.optional(),
		memory: memoryEvidenceParameters.optional(),
	})
	.strict();

const claimRequestParameters = z.object({ authorizationId: opaqueId }).strict();

const memoryReadParameters = z
	.object({
		query: nonEmptyText,
		limit: positiveSafeInteger.refine(value => value <= 32, "must be at most 32").optional(),
		taskId: taskId.optional(),
		workerSessionId: workerSessionId.optional(),
	})
	.strict();

const memoryWriteParameters = z
	.object({
		content: nonEmptyText,
		tags: z.array(nonEmptyText).max(32).optional(),
		idempotencyKey,
		taskId: taskId.optional(),
		workerSessionId: workerSessionId.optional(),
		decisionId: opaqueId.optional(),
	})
	.strict();

export type MasterOrchestrationTool<TParams extends z.ZodType = z.ZodType> = CustomTool<TParams, unknown>;

function abortIfRequested(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

function encodePayload(value: unknown): string {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new MasterToolInputError("Adapter returned a non-serializable result.");
	return encoded;
}

function result(value: unknown): { content: [{ type: "text"; text: string }]; details: unknown } {
	return { content: [{ type: "text", text: encodePayload(value) }], details: value };
}

function withSignal<T extends object>(
	input: T,
	signal: AbortSignal | undefined,
): T & { readonly signal?: AbortSignal } {
	return signal === undefined ? input : { ...input, signal };
}

function defineTool<TParams extends z.ZodType>(
	name: MasterOrchestrationToolName,
	label: string,
	description: string,
	parameters: TParams,
	run: (params: z.infer<TParams>, signal: AbortSignal | undefined) => Promise<unknown>,
): MasterOrchestrationTool<TParams> {
	return {
		name,
		label,
		description,
		parameters,
		strict: true,
		concurrency: "exclusive",
		async execute(_toolCallId, params, _onUpdate, _context, signal) {
			abortIfRequested(signal);
			const parsed = parameters.parse(params);
			const payload = await run(parsed, signal);
			return result(payload);
		},
	};
}

export function createMasterOrchestrationTools(
	dependencies: MasterOrchestrationToolDependencies,
): MasterOrchestrationTool[] {
	assertDependencies(dependencies);
	if (dependencies.catalog !== undefined) assertMasterOrchestrationToolCatalog(dependencies.catalog);
	const masterName = dependencies.masterName;
	const tools: MasterOrchestrationTool[] = [
		defineTool(
			"master_queue_list",
			"List master queue",
			"List queued, leased, assigned, and terminal work for this master.",
			queueListParameters,
			async (params, signal) => {
				const input = params;
				return await dependencies.queue.list(withSignal({ masterName, ...input }, signal));
			},
		),
		defineTool(
			"master_queue_enqueue",
			"Enqueue master work",
			"Enqueue autonomous work for this master; user ingress remains outside the model tool surface.",
			queueEnqueueParameters,
			async (params, signal) => {
				const input = params;
				return await dependencies.queue.enqueue(
					withSignal({ masterName, source: "master" as const, ...input }, signal),
				);
			},
		),
		defineTool(
			"master_queue_assign",
			"Assign queued work",
			"Commit a reserved worker lease to its master-owned task.",
			queueAssignParameters,
			async (params, signal) => {
				const input = params;
				return await dependencies.queue.assign(withSignal({ masterName, ...input }, signal));
			},
		),
		defineTool(
			"master_worker_create",
			"Create worker",
			"Create and prompt a worker through the injected Coordinator gateway.",
			workerCreateParameters,
			async (params, signal) => {
				const input = params;
				return await dependencies.workers.create(withSignal({ masterName, ...input }, signal));
			},
		),
		defineTool(
			"master_worker_observe",
			"Observe worker",
			"Read worker SDK observations without granting generic write or provider capabilities.",
			workerObserveParameters,
			async (params, signal) => {
				const input = params;
				return await dependencies.workers.observe(
					withSignal(
						{ masterName, action: input.action ?? "action_needed", workerSessionId: input.workerSessionId },
						signal,
					),
				);
			},
		),
		defineTool(
			"master_worker_follow_up",
			"Follow up with worker",
			"Send a policy-approved follow-up through the injected worker adapter.",
			workerFollowUpParameters,
			async (params, signal) => {
				const input = params;
				return await dependencies.workers.followUp(withSignal({ masterName, ...input }, signal));
			},
		),
		defineTool(
			"master_record_decision",
			"Record decision",
			"Durably record the doctrine- and memory-supported decision before acting on it.",
			recordDecisionParameters,
			async (params, signal) => {
				const input = params;
				return await dependencies.decisions.record(withSignal({ masterName, ...input }, signal));
			},
		),
		defineTool(
			"master_escalate",
			"Escalate to user",
			"Publish an escalation through the injected decision/channel adapter after a decision is recorded.",
			escalateParameters,
			async (params, signal) => {
				const input = params;
				return await dependencies.decisions.escalate(withSignal({ masterName, ...input }, signal));
			},
		),
		defineTool(
			"master_claim_request",
			"Request worker claim",
			"Consume an opaque user-originated claim authorization; this tool never approves ownership.",
			claimRequestParameters,
			async (params, signal) => {
				const input = params;
				return await dependencies.claims.request(withSignal({ masterName, ...input }, signal));
			},
		),
		defineTool(
			"master_memory_read",
			"Read master memory",
			"Read global memory through the injected MemoryContract and retain its activity evidence.",
			memoryReadParameters,
			async (params, signal) => {
				const input = params;
				return await dependencies.memory.read(
					withSignal(
						{
							scope: "global" as const,
							query: input.query,
							limit: input.limit ?? 10,
							context: {
								masterName,
								...(input.taskId === undefined ? {} : { taskId: input.taskId }),
								...(input.workerSessionId === undefined ? {} : { workerSessionId: input.workerSessionId }),
							},
						},
						signal,
					),
				);
			},
		),
		defineTool(
			"master_memory_write",
			"Write master memory",
			"Write global memory through the injected MemoryContract with an explicit idempotency key.",
			memoryWriteParameters,
			async (params, signal) => {
				const input = params;
				return await dependencies.memory.write(
					withSignal(
						{
							scope: "global" as const,
							content: input.content,
							tags: input.tags ?? [],
							source: {
								masterName,
								...(input.taskId === undefined ? {} : { taskId: input.taskId }),
								...(input.workerSessionId === undefined ? {} : { workerSessionId: input.workerSessionId }),
								...(input.decisionId === undefined ? {} : { decisionId: input.decisionId }),
							},
							idempotencyKey: input.idempotencyKey,
						},
						signal,
					),
				);
			},
		),
	];
	assertMasterOrchestrationToolCatalog(tools.map(tool => tool.name));
	return tools;
}

export const createMasterTools = createMasterOrchestrationTools;
