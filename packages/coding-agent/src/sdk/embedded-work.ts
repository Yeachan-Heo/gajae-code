import type { RunSettlementProof } from "@gajae-code/agent-core";
import type {
	AgentSession,
	ExternalAdmissionTarget,
	ExternalStopAdmissionLease,
	QueuedInputCancelResult,
} from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";
import { ExtensionInteractionError, type ExtensionInteractionService } from "./extension-interaction";
import {
	type JobObservation,
	JobObservationError,
	type JobObservationSnapshot,
	type WorkSettlementResult,
} from "./job-observation";
import type { CreateAgentSessionResult } from "./session";

/** Trusted local captures, not renderer-selected session, owner or manager handles. */
export interface EmbeddedWorkSource {
	readonly result: CreateAgentSessionResult;
	readonly asyncJobs?: "none";
	readonly interaction?: {
		readonly service: ExtensionInteractionService;
		readonly connectionId: string;
		readonly ownership: "owned" | "borrowed";
	};
}

export type EmbeddedWorkTarget =
	| { kind: "queued_input"; id: string }
	| { kind: "active_run"; id: string }
	| { kind: "request"; id: string }
	| { kind: "job"; id: string; generation: string }
	| { kind: "task"; id: string; generation: string }
	| { kind: "schedule"; id: string; createdAt: number }
	| { kind: "workflow"; id: string; workflowKind: "skill" | "gate" };

export interface EmbeddedQueuedInput {
	readonly id: string;
	readonly editId: string;
	readonly submissionId?: string;
	readonly text: string;
	readonly delivery: "steer" | "followUp";
}

export interface EmbeddedQueuedWork {
	readonly binding: ExternalAdmissionTarget;
	readonly inputs: readonly EmbeddedQueuedInput[];
}

export type EmbeddedWorkAvailability<T> =
	| { status: "available"; value: T }
	| { status: "unavailable"; reason: string }
	| { status: "not_applicable"; reason: string };

export interface EmbeddedWorkBlocker {
	readonly kind: EmbeddedWorkTarget["kind"] | "hidden_context" | "unavailable";
	readonly id: string;
	readonly reason: string;
	readonly target?: EmbeddedWorkTarget;
}

export interface EmbeddedOwnedWork extends EmbeddedQueuedWork {
	readonly activeRunId: string | undefined;
	readonly pendingRequests: EmbeddedWorkAvailability<readonly string[]>;
	readonly jobs: EmbeddedWorkAvailability<JobObservationSnapshot>;
	readonly workflows: EmbeddedWorkAvailability<readonly EmbeddedWorkTarget[]>;
	readonly blockers: readonly EmbeddedWorkBlocker[];
}

/** Per-work consent only. The native registry separately authorizes TERM; this is not a TI. */
export interface EmbeddedWorkConsent {
	/** The actual inventory object returned locally, not a deserialized/forged copy. */
	readonly inventory: EmbeddedOwnedWork;
	readonly targets: readonly EmbeddedWorkTarget[];
	readonly timeoutMs?: number;
}

export interface EmbeddedWorkCancelResult {
	readonly target: EmbeddedWorkTarget;
	readonly status: "removed" | "already_executing" | "cancelled" | "settled" | "pending" | "unknown" | "rejected";
	readonly reason?: string;
	readonly settlement?: WorkSettlementResult;
	readonly runProof?: RunSettlementProof;
}

export interface EmbeddedWorkCancellation {
	readonly status: "applied" | "rejected";
	readonly reason?: string;
	readonly results: readonly EmbeddedWorkCancelResult[];
	readonly remaining: EmbeddedOwnedWork;
}

interface CapturedInventory {
	result: CreateAgentSessionResult;
	session: AgentSession;
	manager: SessionManager;
	binding: ExternalAdmissionTarget;
	observation: JobObservation | undefined;
	service: ExtensionInteractionService | undefined;
	connectionId: string | undefined;
	ownership: "owned" | "borrowed" | undefined;
	interactionRevision: number | undefined;
	targets: Map<string, EmbeddedWorkTarget>;
	inputs: Map<string, EmbeddedQueuedInput>;
}

const inventories = new WeakMap<EmbeddedOwnedWork, CapturedInventory>();

function targetKey(target: EmbeddedWorkTarget): string {
	switch (target.kind) {
		case "job":
		case "task":
			return JSON.stringify([target.kind, target.id, target.generation]);
		case "schedule":
			return JSON.stringify([target.kind, target.id, target.createdAt]);
		case "workflow":
			return JSON.stringify([target.kind, target.id, target.workflowKind]);
		default:
			return JSON.stringify([target.kind, target.id]);
	}
}

/** User drafts only: hidden reminders are neither counted nor silently removed. */
export function getEmbeddedQueuedWork(source: EmbeddedWorkSource): EmbeddedQueuedWork {
	const session = source.result.session;
	return {
		binding: session.externalAdmissionTarget,
		inputs: session.getQueuedMessageEntries().map(entry => ({
			id: entry.submissionId ?? entry.id,
			editId: entry.id,
			submissionId: entry.submissionId,
			text: entry.text,
			delivery: entry.mode,
		})),
	};
}

/** Read-only inventory: no hydration, abort, close, initialization or disposal. */
export function getEmbeddedOwnedWork(source: EmbeddedWorkSource): EmbeddedOwnedWork {
	const result = source.result;
	const session = result.session;
	const queued = getEmbeddedQueuedWork(source);
	const blockers: EmbeddedWorkBlocker[] = [];
	const targets = new Map<string, EmbeddedWorkTarget>();
	const add = (target: EmbeddedWorkTarget, reason: string): void => {
		targets.set(targetKey(target), target);
		blockers.push({ kind: target.kind, id: target.id, target, reason });
	};
	for (const input of queued.inputs) add({ kind: "queued_input", id: input.id }, "queued");
	const activeRunId = session.activeLogicalRunId;
	if (activeRunId) add({ kind: "active_run", id: activeRunId }, "active");
	const counts = session.pendingMessageCounts;
	if (counts.nextTurn > 0)
		blockers.push({ kind: "hidden_context", id: session.sessionId, reason: "hidden_next_turn_context" });

	let observation: JobObservation | undefined;
	let jobs: EmbeddedWorkAvailability<JobObservationSnapshot>;
	try {
		observation = result.jobObservation;
		jobs = observation
			? { status: "available", value: observation.getSnapshot() }
			: source.asyncJobs === "none"
				? { status: "not_applicable", reason: "no_async_job_manager" }
				: { status: "unavailable", reason: "job_observation_unavailable" };
	} catch (error) {
		jobs = {
			status: "unavailable",
			reason: error instanceof JobObservationError ? error.code : "job_observation_failed",
		};
	}
	if (jobs.status === "unavailable") blockers.push({ kind: "unavailable", id: "jobs", reason: jobs.reason });
	else if (jobs.status === "available") {
		for (const job of jobs.value.jobs) {
			if (job.status === "running" || job.status === "paused" || job.deliveryState !== "delivered")
				add(
					{ kind: "job", id: job.id, generation: job.generation },
					job.deliveryState === "failed-visible" ? "delivery_failed" : "runner_or_delivery_pending",
				);
		}
		for (const job of jobs.value.unsettledJobs) {
			const target: EmbeddedWorkTarget = { kind: "job", ...job };
			if (!targets.has(targetKey(target))) add(target, "physical_runner_unsettled");
		}
		for (const task of jobs.value.tasks) {
			if (task.status === "running" || task.status === "queued" || task.status === "paused")
				add({ kind: "task", ...task.target }, task.status);
		}
		for (const cron of jobs.value.crons)
			add({ kind: "schedule", id: cron.id, createdAt: cron.createdAt }, cron.firing ? "firing" : "scheduled");
		for (const cron of jobs.value.unsettledCrons) add({ kind: "schedule", ...cron }, "delivery_pending_after_delete");
		for (const dead of jobs.value.deadLettered ?? []) {
			const target: EmbeddedWorkTarget = { kind: "job", id: dead.jobId, generation: dead.generation };
			if (!targets.has(targetKey(target))) add(target, "delivery_failed");
		}
	}

	const interaction = source.interaction;
	let pendingRequests: EmbeddedWorkAvailability<readonly string[]>;
	if (!interaction) pendingRequests = { status: "unavailable", reason: "interaction_service_unavailable" };
	else {
		const state = interaction.service.snapshot();
		pendingRequests =
			state.sessionId === session.sessionId && !state.disposed
				? { status: "available", value: state.pending.map(request => request.requestId) }
				: { status: "unavailable", reason: state.disposed ? "interaction_disposed" : "wrong_session" };
		if (pendingRequests.status === "available")
			for (const id of pendingRequests.value)
				add({ kind: "request", id }, interaction.ownership === "owned" ? "pending" : "borrowed_control");
	}
	if (pendingRequests.status === "unavailable")
		blockers.push({ kind: "unavailable", id: "requests", reason: pendingRequests.reason });

	const workflowTargets: EmbeddedWorkTarget[] = [];
	const activeWorkflow = session.getEffectiveActiveWorkflowSkillState();
	if (activeWorkflow)
		workflowTargets.push({
			kind: "workflow",
			workflowKind: "skill",
			id: `${activeWorkflow.sessionId}:${activeWorkflow.skill}`,
		});
	const emitter = session.getWorkflowGateEmitter();
	let workflows: EmbeddedWorkAvailability<readonly EmbeddedWorkTarget[]>;
	if (emitter && !emitter.listPendingGates)
		workflows = { status: "unavailable", reason: "workflow_gate_inventory_unavailable" };
	else {
		try {
			for (const gate of emitter?.listPendingGates?.() ?? [])
				workflowTargets.push({ kind: "workflow", workflowKind: "gate", id: gate.gate_id });
			workflows = { status: "available", value: workflowTargets };
		} catch {
			workflows = { status: "unavailable", reason: "workflow_gate_inventory_failed" };
		}
	}
	for (const workflow of workflowTargets) add(workflow, "workflow_cancel_join_unavailable");
	if (workflows.status === "unavailable")
		blockers.push({ kind: "unavailable", id: "workflows", reason: workflows.reason });
	const inventory: EmbeddedOwnedWork = { ...queued, activeRunId, pendingRequests, jobs, workflows, blockers };
	inventories.set(inventory, {
		result,
		session,
		manager: session.sessionManager,
		binding: { ...queued.binding },
		observation,
		service: interaction?.service,
		connectionId: interaction?.connectionId,
		ownership: interaction?.ownership,
		interactionRevision: interaction?.service.snapshot().revision,
		targets: new Map([...targets].map(([key, target]) => [key, { ...target }])),
		inputs: new Map(queued.inputs.map(input => [input.id, { ...input }])),
	});
	return inventory;
}

function assertCurrent(source: EmbeddedWorkSource, captured: CapturedInventory): void {
	const result = source.result;
	const session = result.session;
	const current = session.externalAdmissionTarget;
	const lifecycle = session.sessionLifecycle;
	if (
		result !== captured.result ||
		session !== captured.session ||
		session.sessionManager !== captured.manager ||
		current.sessionId !== captured.binding.sessionId ||
		current.generation !== captured.binding.generation ||
		current.identityGeneration !== captured.binding.identityGeneration ||
		lifecycle.disposed ||
		lifecycle.transitioning ||
		result.jobObservation !== captured.observation ||
		source.interaction?.service !== captured.service ||
		source.interaction?.connectionId !== captured.connectionId ||
		source.interaction?.ownership !== captured.ownership
	)
		throw new Error("stale_inventory");
	if (captured.service) {
		const interaction = captured.service.snapshot();
		if (
			interaction.sessionId !== captured.binding.sessionId ||
			interaction.disposed ||
			!interaction.connected ||
			interaction.revision !== captured.interactionRevision
		)
			throw new Error("stale_connection");
	}
}

/** Scoped admission only. Nested holders release independently; default inventory never acquires it. */
export function acquireEmbeddedStopAdmission(source: EmbeddedWorkSource): ExternalStopAdmissionLease {
	const session = source.result.session;
	return session.acquireExternalStopAdmission(session.externalAdmissionTarget);
}

/** Execute only named capabilities after validating the complete consent, queues before exact run abort. */
export async function cancelEmbeddedOwnedWork(
	source: EmbeddedWorkSource,
	consent?: EmbeddedWorkConsent,
): Promise<EmbeddedWorkCancellation> {
	const results: EmbeddedWorkCancelResult[] = [];
	const rejected = (reason: string): EmbeddedWorkCancellation => ({
		status: "rejected",
		reason,
		results,
		remaining: getEmbeddedOwnedWork(source),
	});
	if (!consent) return rejected("consent_required");
	const inventory = consent.inventory;
	const captured = inventories.get(inventory);
	if (!captured) return rejected("invalid_inventory");
	let targets: EmbeddedWorkTarget[];
	let timeoutMs: number;
	try {
		targets = structuredClone([...consent.targets]);
		timeoutMs = consent.timeoutMs ?? 1_000;
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return rejected("invalid_timeout");
		assertCurrent(source, captured);
		const live = getEmbeddedOwnedWork(source);
		const liveTargets = new Map(
			live.blockers.flatMap(blocker =>
				blocker.target ? [[targetKey(blocker.target), blocker.target] as const] : [],
			),
		);
		const seen = new Set<string>();
		for (const target of targets) {
			const key = targetKey(target);
			if (seen.has(key) || !captured.targets.has(key)) return rejected("invalid_target");
			seen.add(key);
			if (target.kind === "workflow") return rejected("workflow_cancel_join_unavailable");
			if (target.kind === "active_run" && captured.session.activeLogicalRunId !== target.id)
				return rejected("stale_run");
			if (target.kind === "job" || target.kind === "task" || target.kind === "schedule") {
				if (!captured.observation || !liveTargets.has(key)) return rejected("stale_work");
				if (
					target.kind === "task" &&
					live.jobs.status === "available" &&
					!live.jobs.value.tasks.find(task => task.id === target.id)?.capabilities.cancel
				)
					return rejected("insufficient_capability");
				if (
					target.kind === "schedule" &&
					live.jobs.status === "available" &&
					!live.jobs.value.crons.some(cron => cron.id === target.id && cron.createdAt === target.createdAt)
				)
					return rejected("schedule_delivery_only");
			}
			if (target.kind === "request") {
				if (!captured.service || captured.ownership !== "owned" || !captured.connectionId)
					return rejected("borrowed_or_unavailable_control");
				captured.service.validateAddress({
					sessionId: captured.binding.sessionId,
					connectionId: captured.connectionId,
					requestId: target.id,
				});
			}
		}
		assertCurrent(source, captured);
	} catch (error) {
		return rejected(
			error instanceof ExtensionInteractionError
				? error.code
				: error instanceof Error
					? error.message
					: "invalid_consent",
		);
	}
	const priority = { queued_input: 0, request: 1, schedule: 2, task: 3, job: 4, active_run: 5, workflow: 6 };
	targets.sort((a, b) => priority[a.kind] - priority[b.kind]);
	for (const target of targets) {
		try {
			assertCurrent(source, captured);
			switch (target.kind) {
				case "queued_input": {
					const input = captured.inputs.get(target.id)!;
					const status: QueuedInputCancelResult = input.submissionId
						? captured.session.cancelQueuedInputSubmission(input.submissionId)
						: captured.session.cancelQueuedMessage(input.editId);
					const stillQueued = captured.session
						.getQueuedMessageEntries()
						.some(
							entry =>
								entry.id === input.editId ||
								(input.submissionId !== undefined && entry.submissionId === input.submissionId),
						);
					results.push({ target, status: status === "removed" && stillQueued ? "unknown" : status });
					break;
				}
				case "request":
					captured.service!.cancel({
						sessionId: captured.binding.sessionId,
						connectionId: captured.connectionId!,
						requestId: target.id,
					});
					captured.interactionRevision = captured.service!.snapshot().revision;
					results.push({ target, status: "cancelled" });
					break;
				case "job":
				case "task":
				case "schedule": {
					const observation = captured.observation!;
					const settlement =
						target.kind === "job"
							? await observation.cancelJobAndWait(target, timeoutMs)
							: target.kind === "task"
								? await observation.cancelTaskAndWait(target, timeoutMs)
								: await observation.deleteCronAndWait(target, timeoutMs);
					results.push({ target, status: settlement.status, settlement });
					break;
				}
				case "active_run": {
					const abortRunId = target.id;
					if (captured.session.activeLogicalRunId !== abortRunId) {
						results.push({ target, status: "rejected", reason: "stale_run" });
						break;
					}
					const runProof = await captured.session.abortPromptAndWait(abortRunId, {
						graceMs: timeoutMs,
						abortRunId,
					});
					results.push({ target, status: runProof.status === "settled" ? "settled" : "pending", runProof });
					break;
				}
				case "workflow":
					break; // Refused during whole-consent prevalidation.
			}
		} catch (error) {
			results.push({
				target,
				status: "rejected",
				reason:
					error instanceof JobObservationError || error instanceof ExtensionInteractionError
						? error.code
						: error instanceof Error
							? error.message
							: "control_failed",
			});
			break;
		}
	}
	return { status: "applied", results, remaining: getEmbeddedOwnedWork(source) };
}
