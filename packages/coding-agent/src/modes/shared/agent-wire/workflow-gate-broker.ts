/**
 * Durable workflow gate broker (#315).
 *
 * Owns gate identity and lifecycle for one run:
 *  - run-scoped, monotonic, stable gate ids
 *  - pending gate persisted BEFORE it is emitted
 *  - resolution persisted BEFORE the workflow is allowed to advance
 *  - response-body hash + idempotency-key rules (cached replay, conflict detection)
 *  - exactly-once advance + audit
 *
 * Persistence is injected via {@link GateStore}; the in-memory store is used in
 * tests, the file-backed store gives crash-durable behavior for real runs.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { AskSelectedAckOutcome } from "../../../tools";
import { classifyAskGateDisposition } from "./deep-interview-gate";
import { answerHashOf, canonicalJson, compileGateSchema, schemaHash, validateGateAnswer } from "./workflow-gate-schema";
import type {
	WorkflowGate,
	WorkflowGateContext,
	WorkflowGateDiagnostic,
	WorkflowGateKind,
	WorkflowGateOption,
	WorkflowGateQueryRecord,
	WorkflowGateResolution,
	WorkflowGateResponse,
	WorkflowGateValidationError,
	WorkflowStage,
} from "./workflow-gate-types";
import { RESERVED_WORKFLOW_STAGES, WORKFLOW_GATE_V1_STAGES } from "./workflow-gate-types";

export type PersistedSemanticDisposition = "commit" | "resolve_without_commit";
export type PersistedResolutionOrigin =
	| { kind: "generic"; channel: "sdk" | "other" }
	| { kind: "telegram_notification"; interactionActionId: string };

export type PersistedAckPolicy =
	| { kind: "none"; reason: "non_telegram" | "semantic_noncommit" | "legacy_unproven" }
	| {
			kind: "telegram_selected_v1";
			commitKey: string;
			actionId: string;
			state: "pending" | "attempt_started" | "delivered" | "failed" | "unknown";
			outcome?: AskSelectedAckOutcome;
			updatedAt: string;
	  };

export interface GateResolutionOptions {
	semanticDisposition?: PersistedSemanticDisposition;
	resolutionOrigin?: PersistedResolutionOrigin;
	ackPolicy?: PersistedAckPolicy;
	beforeAdvance?: () => Promise<void>;
}

export type WorkflowGateTerminalProof = "retired" | "already_terminal" | "not_published";

export interface WorkflowGateTerminalController {
	completeGateInteractions(gateId: string): WorkflowGateTerminalProof | Promise<WorkflowGateTerminalProof>;
	cancelGateInteractions(gateId: string, reason: string): void | Promise<void>;
}

export interface NotificationGateResolutionOptions {
	interactionActionId: string;
	replyReceiptId: string;
	answerJson: string;
	idempotencyKey?: string;
	requestSelectedAck(input: {
		replyReceiptId: string;
		actionId: string;
		commitKey: string;
		daemonDeadlineAt: number;
		hostTimeoutMs: number;
	}): Promise<AskSelectedAckOutcome>;
	resolveClaim(): void;
	closeClaimInvalid(reason: string): void;
}

export interface AskSelectedAckRecoveryParticipant {
	requestRecoveredAskSelectedAck(input: {
		sessionId: string;
		actionId: string;
		commitKey: string;
		deadlineAt: number;
		hostTimeoutMs: number;
	}): Promise<AskSelectedAckOutcome>;
}

/** SDK-native surface for emitting a workflow gate and awaiting its answer. */
export interface WorkflowGateEmitter {
	isUnattended(): boolean;
	emitGate(input: OpenGateInput): Promise<unknown>;
	onGateEmitted?(listener: (gate: WorkflowGate) => void): () => void;
	resolveGate?(response: WorkflowGateResponse): Promise<WorkflowGateResolution>;
	resolveGateFromNotification?(
		response: WorkflowGateResponse,
		options: NotificationGateResolutionOptions,
	): Promise<WorkflowGateResolution>;
	registerGateTerminalController?(controller: WorkflowGateTerminalController): () => void;
	/** Records the exact terminalization proof established by direct control preparation. */
	prepareTerminalization?(gateId: string, proof: WorkflowGateTerminalProof): boolean;
	/** Discards a prepared proof when the gate remains pending after a rejected direct response. */
	clearPreparedTerminalization?(gateId: string): void;
	listPendingGates?(): WorkflowGate[];
	listGateDiagnostics?(): WorkflowGateDiagnostic[];
	listWorkflowGateQueryRecords?(): WorkflowGateQueryRecord[];
	quarantineGate?(gateId: string): void;
	setAckRecoveryParticipant?(participant: AskSelectedAckRecoveryParticipant | null): void;
	/** Explicit host hook for same-process accepted-but-unadvanced recovery. */
	recoverAcceptedGates?(): Promise<string[]>;
	/** Reads a durable completed resolution before any presentation claim. */
	lookupCompletedResolution?(response: WorkflowGateResponse): WorkflowGateCompletedResolutionLookup;
	/** Supplies the active runtime turn captured immediately before a gate is opened. */
	setRuntimeTurnProvider?(provider: (() => string | undefined) | null): void;
	/** Permanently revoke all in-process continuation authority and reject their waiters. */
	fence?(): void;
	/** Temporarily make this emitter unavailable while a session transition is reversible. */
	suspend?(): void;
	resume?(): void;
}

/**
 * SDK-native workflow-gate emitter backed by a durable broker/store pair.
 *
 * Answers are resolved by the broker, so validation and idempotency have one
 * authority. Listeners replay durable pending gates when attached, allowing an
 * SDK host that starts after a gate was opened to discover it.
 */
export class BrokerWorkflowGateEmitter implements WorkflowGateEmitter {
	readonly #listeners = new Set<(gate: WorkflowGate) => void>();
	readonly #waiters = new Map<string, { resolve(answer: unknown): void; reject(error: Error): void }>();
	readonly #broker: WorkflowGateBroker;
	#terminalController: WorkflowGateTerminalController | undefined;
	#recoveryParticipant: AskSelectedAckRecoveryParticipant | undefined;
	#recoveryPromise: Promise<void> | undefined;
	readonly #participantReady = Promise.withResolvers<void>();
	#recoveryGraceTimer: NodeJS.Timeout | undefined;
	#recoveryGraceWake: (() => void) | undefined;
	#recoveryTimer: NodeJS.Timeout | undefined;
	#recoveryAttempts = 0;
	#fenced = false;
	#suspended = false;
	readonly #runId: string;
	readonly #store: GateStore;
	readonly #emitterHooks: Pick<BrokerHooks, "advance">;
	#runtimeTurnProvider: (() => string | undefined) | undefined;

	constructor(runId: string, store: GateStore, emitterHooks: Pick<BrokerHooks, "advance"> = {}) {
		this.#runId = runId;
		this.#store = store;
		this.#emitterHooks = emitterHooks;
		this.#broker = new WorkflowGateBroker(runId, store, {
			emit: gate => {
				for (const listener of this.#listeners) listener(gate);
			},
			advance: (gate, answer) => this.#emitterHooks.advance?.(gate, answer),
			completeAccepted: record => this.#completeAccepted(record),
			finalizeAccepted: record => this.#finalizeAccepted(record),
			terminalizeAccepted: record => this.#terminalizeAccepted(record),
		});
	}

	isUnattended(): boolean {
		return true;
	}
	setRuntimeTurnProvider(provider: (() => string | undefined) | null): void {
		this.#runtimeTurnProvider = provider ?? undefined;
	}

	emitGate(input: OpenGateInput): Promise<unknown> {
		if (this.#fenced || this.#suspended) return Promise.reject(new Error("workflow gate emitter is unavailable"));
		const waiter = Promise.withResolvers<unknown>();
		const gate = this.#broker.openGate(
			{
				...input,
				...(input.runtimeTurnId === undefined ? { runtimeTurnId: this.#runtimeTurnProvider?.() } : {}),
			},
			{
				activate: opened => this.#waiters.set(opened.gate_id, waiter),
				isLive: gateId => this.#waiters.has(gateId),
				release: gateId => {
					const activeWaiter = this.#waiters.get(gateId);
					if (!activeWaiter) return;
					this.#waiters.delete(gateId);
					activeWaiter.reject(new Error(`workflow gate ${gateId} continuation was fenced`));
				},
			},
		);
		// A listener may answer synchronously while the broker emits. The durable
		// record is the source of truth in that race; never strand its promise.
		const persisted = this.#store.get(gate.gate_id);
		return persisted?.status === "accepted" ? Promise.resolve(persisted.answer) : waiter.promise;
	}

	onGateEmitted(listener: (gate: WorkflowGate) => void): () => void {
		this.#listeners.add(listener);
		for (const gate of this.listPendingGates()) listener(gate);
		return () => this.#listeners.delete(listener);
	}

	resolveGate(response: WorkflowGateResponse): Promise<WorkflowGateResolution> {
		if (this.#fenced || this.#suspended)
			return Promise.reject(new WorkflowGateBrokerError("unknown_gate", `workflow gate emitter is unavailable`));
		return this.#broker.resolve(response).catch(error => {
			if (!this.#fenced && !this.#suspended) this.#scheduleRecovery();
			throw error;
		});
	}
	lookupCompletedResolution(response: WorkflowGateResponse): WorkflowGateCompletedResolutionLookup {
		return this.#broker.lookupCompletedResolution(response);
	}

	prepareTerminalization(gateId: string, proof: WorkflowGateTerminalProof): boolean {
		return this.#broker.prepareTerminalization(gateId, proof);
	}
	clearPreparedTerminalization(gateId: string): void {
		this.#broker.clearPreparedTerminalization(gateId);
	}

	listPendingGates(): WorkflowGate[] {
		return this.#suspended ? [] : this.#broker.listPendingGates();
	}

	listGateDiagnostics(): WorkflowGateDiagnostic[] {
		return this.#broker.listGateDiagnostics();
	}

	listWorkflowGateQueryRecords(): WorkflowGateQueryRecord[] {
		return this.#broker.listWorkflowGateQueryRecords();
	}

	suspend(): void {
		if (!this.#fenced) this.#suspended = true;
	}

	resume(): void {
		if (!this.#fenced) this.#suspended = false;
	}

	fence(): void {
		if (this.#fenced) return;
		this.#fenced = true;
		this.#suspended = false;
		this.#runtimeTurnProvider = undefined;
		if (this.#recoveryTimer) clearTimeout(this.#recoveryTimer);
		this.#recoveryTimer = undefined;
		if (this.#recoveryGraceTimer) clearTimeout(this.#recoveryGraceTimer);
		this.#recoveryGraceTimer = undefined;
		this.#recoveryGraceWake?.();
		this.#recoveryGraceWake = undefined;
		for (const [gateId, waiter] of this.#waiters) {
			this.#waiters.delete(gateId);
			waiter.reject(new Error(`workflow gate ${gateId} continuation was fenced`));
		}
		this.#broker.fenceContinuations();
	}

	quarantineGate(gateId: string): void {
		const waiter = this.#waiters.get(gateId);
		if (waiter) {
			this.#waiters.delete(gateId);
			waiter.reject(new Error(`workflow gate ${gateId} continuation was fenced`));
		}
		this.#broker.quarantineGate(gateId);
	}

	registerGateTerminalController(controller: WorkflowGateTerminalController): () => void {
		if (this.#terminalController && this.#terminalController !== controller)
			throw new Error("a workflow gate terminal controller is already registered");
		this.#terminalController = controller;
		return () => {
			if (this.#terminalController === controller) this.#terminalController = undefined;
		};
	}

	setAckRecoveryParticipant(participant: AskSelectedAckRecoveryParticipant | null): void {
		this.#recoveryParticipant = participant ?? undefined;
		if (participant) this.#participantReady.resolve();
		void this.#startRecoveryOnce();
	}
	async recoverAcceptedGates(): Promise<string[]> {
		const recovered = await this.#broker.recover();
		if (recovered.length > 0 || this.#broker.hasRecoverableAcceptedGate()) {
			this.#scheduleRecovery();
		} else {
			this.#recoveryAttempts = 0;
		}
		return recovered;
	}

	async resolveGateFromNotification(
		response: WorkflowGateResponse,
		options: NotificationGateResolutionOptions,
	): Promise<WorkflowGateResolution> {
		let claimSettled = false;
		const resolveClaim = () => {
			if (claimSettled) return;
			claimSettled = true;
			options.resolveClaim();
		};
		const closeClaimInvalid = (reason: string) => {
			if (claimSettled) return;
			claimSettled = true;
			options.closeClaimInvalid(reason);
		};
		try {
			JSON.parse(options.answerJson);
		} catch {
			closeClaimInvalid("invalid_structured_answer");
			return {
				gate_id: response.gate_id,
				status: "rejected",
				answer_hash: "",
				resolved_at: new Date().toISOString(),
				error: this.#broker.validationError(response.gate_id, "json_parse", "invalid structured answer"),
			};
		}
		let semanticDisposition: PersistedSemanticDisposition;
		try {
			semanticDisposition = this.#broker.classifyDisposition(response.gate_id, response.answer);
		} catch (error) {
			const message = error instanceof Error ? error.message : "invalid answer";
			closeClaimInvalid(message);
			return {
				gate_id: response.gate_id,
				status: "rejected",
				answer_hash: "",
				resolved_at: new Date().toISOString(),
				error: this.#broker.validationError(response.gate_id, "semantic_disposition", message),
			};
		}
		const commitKey = `${response.gate_id}:${options.idempotencyKey ?? options.replyReceiptId}`;
		const ackPolicy: PersistedAckPolicy =
			semanticDisposition === "commit"
				? {
						kind: "telegram_selected_v1",
						commitKey,
						actionId: options.interactionActionId,
						state: "pending",
						updatedAt: new Date().toISOString(),
					}
				: { kind: "none", reason: "semantic_noncommit" };
		try {
			const resolution = await this.#broker.resolve(response, {
				resolutionOrigin: { kind: "telegram_notification", interactionActionId: options.interactionActionId },
				ackPolicy,
				semanticDisposition,
				beforeAdvance: async () => {
					if (ackPolicy.kind === "telegram_selected_v1") {
						this.#broker.updateAckPolicy(response.gate_id, {
							...ackPolicy,
							state: "attempt_started",
							updatedAt: new Date().toISOString(),
						});
						let outcome: AskSelectedAckOutcome;
						try {
							outcome = await options.requestSelectedAck({
								replyReceiptId: options.replyReceiptId,
								actionId: options.interactionActionId,
								commitKey,
								daemonDeadlineAt: Date.now() + 8_000,
								hostTimeoutMs: 10_000,
							});
						} catch {
							outcome = { status: "unknown", reason: "host_timeout" };
						}
						this.#broker.updateAckPolicy(response.gate_id, {
							...ackPolicy,
							state: outcome.status,
							outcome,
							updatedAt: new Date().toISOString(),
						});
					}
					resolveClaim();
				},
			});
			if (resolution.status === "accepted") resolveClaim();
			else closeClaimInvalid(resolution.error?.code ?? "invalid_answer");
			return resolution;
		} catch (error) {
			closeClaimInvalid(error instanceof Error ? error.message : "invalid_answer");
			this.#scheduleRecovery();
			throw error;
		}
	}

	async #completeAccepted(record: PersistedGate): Promise<void> {
		const waiter = this.#waiters.get(record.gate.gate_id);
		if (!waiter) throw new Error(`workflow gate ${record.gate.gate_id} lost its continuation owner`);
		waiter.resolve(record.answer);
	}

	async #terminalizeAccepted(record: PersistedGate): Promise<WorkflowGateTerminalProof> {
		const controller = this.#terminalController;
		if (!controller) {
			this.quarantineGate(record.gate.gate_id);
			throw new Error(`workflow gate ${record.gate.gate_id} has no terminal controller`);
		}
		try {
			const proof = await controller.completeGateInteractions(record.gate.gate_id);
			if (proof !== "retired" && proof !== "already_terminal" && proof !== "not_published")
				throw new Error(`workflow gate ${record.gate.gate_id} terminalization returned no exact proof`);
			return proof;
		} catch (error) {
			try {
				await controller.cancelGateInteractions(
					record.gate.gate_id,
					"workflow gate presentation terminalization failed",
				);
			} finally {
				this.quarantineGate(record.gate.gate_id);
			}
			throw error;
		}
	}

	async #finalizeAccepted(record: PersistedGate): Promise<void> {
		const policy = record.ackPolicy;
		if (policy?.kind === "telegram_selected_v1" && policy.state === "pending") {
			let outcome: AskSelectedAckOutcome;
			const participant = this.#recoveryParticipant;
			if (!participant) outcome = { status: "failed", reason: "no_participant" };
			else {
				this.#broker.updateAckPolicy(record.gate.gate_id, {
					...policy,
					state: "attempt_started",
					updatedAt: new Date().toISOString(),
				});
				try {
					outcome = await participant.requestRecoveredAskSelectedAck({
						sessionId: this.#runId,
						actionId: policy.actionId,
						commitKey: policy.commitKey,
						deadlineAt: Date.now() + 8_000,
						hostTimeoutMs: 10_000,
					});
				} catch {
					outcome = { status: "unknown", reason: "host_timeout" };
				}
			}
			this.#broker.updateAckPolicy(record.gate.gate_id, {
				...policy,
				state: outcome.status,
				outcome,
				updatedAt: new Date().toISOString(),
			});
		}
		if (policy?.kind === "telegram_selected_v1" && policy.state === "attempt_started") {
			this.#broker.updateAckPolicy(record.gate.gate_id, {
				...policy,
				state: "unknown",
				outcome: { status: "unknown", reason: "shutdown" },
				updatedAt: new Date().toISOString(),
			});
		}
	}

	#scheduleRecovery(): void {
		if (this.#recoveryTimer || this.#recoveryAttempts >= 3) return;
		const delay = 50 * 2 ** this.#recoveryAttempts++;
		this.#recoveryTimer = setTimeout(() => {
			this.#recoveryTimer = undefined;
			void this.recoverAcceptedGates().catch(() => {
				this.#scheduleRecovery();
			});
		}, delay);
	}

	async #startRecoveryOnce(options: { participantGraceMs?: number } = {}): Promise<void> {
		if (this.#fenced) return;
		if (this.#recoveryPromise) return this.#recoveryPromise;
		this.#recoveryPromise = (async () => {
			if (!this.#recoveryParticipant) {
				const grace = Promise.withResolvers<void>();
				this.#recoveryGraceWake = grace.resolve;
				const graceMs = options.participantGraceMs ?? 2_000;
				this.#recoveryGraceTimer = setTimeout(grace.resolve, graceMs);
				await Promise.race([this.#participantReady.promise, grace.promise]);
				if (this.#recoveryGraceTimer) clearTimeout(this.#recoveryGraceTimer);
				this.#recoveryGraceTimer = undefined;
				this.#recoveryGraceWake = undefined;
			}
			if (!this.#fenced) await this.recoverAcceptedGates();
		})();
		return this.#recoveryPromise;
	}
}

export interface PersistedGate {
	gate: WorkflowGate;
	status: "pending" | "accepted" | "quarantined";
	ownerInstanceId?: string;
	idempotencyKey?: string;
	responseHash?: string;
	/** Raw accepted answer, retained so a same-process advance can be replayed. */
	answer?: unknown;
	resolution?: WorkflowGateResolution;
	advanced: boolean;
	/** Exact presentation terminalization completed before workflow advancement. */
	terminalized?: boolean;
	/** Exact presentation terminalization proof recorded before workflow advancement. */
	terminalProof?: WorkflowGateTerminalProof;
	semanticDisposition?: PersistedSemanticDisposition;
	resolutionOrigin?: PersistedResolutionOrigin;
	ackPolicy?: PersistedAckPolicy;
	lifecycle?: WorkflowGateDiagnostic["lifecycle"];
}

export interface GateStore {
	nextSeq(stage: WorkflowStage): number;
	put(record: PersistedGate): void;
	get(gateId: string): PersistedGate | undefined;
	/** Atomically quarantines records owned by a prior runtime before exposure. */
	beginRuntimeInstance(instanceId: string): void;
	/** All persisted gate records (used for same-process recovery and Q12). */
	list(): PersistedGate[];
}

export class MemoryGateStore implements GateStore {
	private counters = new Map<WorkflowStage, number>();
	private gates = new Map<string, PersistedGate>();
	private runtimeInstanceId: string | undefined;
	nextSeq(stage: WorkflowStage): number {
		const next = (this.counters.get(stage) ?? 0) + 1;
		this.counters.set(stage, next);
		return next;
	}
	put(record: PersistedGate): void {
		this.gates.set(record.gate.gate_id, structuredClone(record));
	}
	get(gateId: string): PersistedGate | undefined {
		const r = this.gates.get(gateId);
		return r ? structuredClone(r) : undefined;
	}
	beginRuntimeInstance(instanceId: string): void {
		if (this.runtimeInstanceId === instanceId) return;
		const priorInstanceId = this.runtimeInstanceId;
		const now = new Date().toISOString();
		for (const [gateId, record] of this.gates) {
			if (record.ownerInstanceId !== priorInstanceId) continue;
			if (record.status === "pending") {
				this.gates.set(gateId, {
					...record,
					status: "quarantined",
					lifecycle: { state: "quarantined", reason: "orphaned_after_process_restart", quarantinedAt: now },
				});
			} else if (record.status === "accepted" && !record.advanced) {
				this.gates.set(gateId, {
					...record,
					status: "quarantined",
					lifecycle: {
						state: "quarantined",
						reason: "accepted_unadvanced_after_process_restart",
						quarantinedAt: now,
					},
				});
			}
		}
		this.runtimeInstanceId = instanceId;
	}
	list(): PersistedGate[] {
		return [...this.gates.values()].map(r => structuredClone(r));
	}
}

interface FileState {
	version: 1;
	counters: Partial<Record<WorkflowStage, number>>;
	gates: Record<string, PersistedGate>;
	runtimeInstanceId?: string;
}

const FILE_GATE_STORE_VERSION = 1;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isIsoDate(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function invalidFileState(message: string): never {
	throw new Error(`invalid gate store at ${message}`);
}

function migrateVersionlessV0SemanticDisposition(
	value: unknown,
	filePath: string,
): PersistedSemanticDisposition | undefined {
	if (value === undefined) return undefined;
	if (value === "commit" || value === "resolve_without_commit") return value;
	invalidFileState(filePath);
}

function migrateVersionlessV0ResolutionOrigin(value: unknown, filePath: string): PersistedResolutionOrigin | undefined {
	if (value === undefined) return undefined;
	if (!isObject(value)) invalidFileState(filePath);
	if (value.kind === "telegram_notification" && isNonEmptyString(value.interactionActionId))
		return { kind: "telegram_notification", interactionActionId: value.interactionActionId };
	if (value.kind === "legacy_unknown") return { kind: "generic", channel: "other" };
	if (value.kind !== "generic" || typeof value.channel !== "string") invalidFileState(filePath);
	if (value.channel === "sdk" || value.channel === "other") return { kind: "generic", channel: value.channel };
	if (value.channel === "rpc") return { kind: "generic", channel: "sdk" };
	if (value.channel === "bridge") return { kind: "generic", channel: "other" };
	invalidFileState(filePath);
}

function migrateVersionlessV0AckPolicy(value: unknown, filePath: string): PersistedAckPolicy | undefined {
	if (value === undefined) return undefined;
	if (!isObject(value)) invalidFileState(filePath);
	if (
		value.kind === "none" &&
		(value.reason === "non_telegram" || value.reason === "semantic_noncommit" || value.reason === "legacy_unproven")
	)
		return { kind: "none", reason: value.reason };
	if (
		value.kind !== "telegram_selected_v1" ||
		!isNonEmptyString(value.commitKey) ||
		!isNonEmptyString(value.actionId) ||
		!isIsoDate(value.updatedAt) ||
		!(["pending", "attempt_started", "delivered", "failed", "unknown"] as const).includes(value.state as never)
	)
		invalidFileState(filePath);
	if (value.outcome === undefined)
		return {
			kind: "telegram_selected_v1",
			commitKey: value.commitKey,
			actionId: value.actionId,
			state: value.state as "pending" | "attempt_started" | "delivered" | "failed" | "unknown",
			updatedAt: value.updatedAt,
		};
	if (!isObject(value.outcome)) invalidFileState(filePath);
	if (
		value.outcome.status === "delivered" &&
		typeof value.outcome.messageId === "number" &&
		Number.isSafeInteger(value.outcome.messageId)
	)
		return {
			kind: "telegram_selected_v1",
			commitKey: value.commitKey,
			actionId: value.actionId,
			state: value.state as "pending" | "attempt_started" | "delivered" | "failed" | "unknown",
			outcome: { status: "delivered", messageId: value.outcome.messageId },
			updatedAt: value.updatedAt,
		};
	if (
		value.outcome.status === "failed" &&
		(
			[
				"unsupported",
				"no_participant",
				"ambiguous_participant",
				"route_missing",
				"expired",
				"cancelled",
				"telegram_rejected",
				"session_closed",
			] as const
		).includes(value.outcome.reason as never)
	)
		return {
			kind: "telegram_selected_v1",
			commitKey: value.commitKey,
			actionId: value.actionId,
			state: value.state as "pending" | "attempt_started" | "delivered" | "failed" | "unknown",
			outcome: {
				status: "failed",
				reason: value.outcome.reason as
					| "unsupported"
					| "no_participant"
					| "ambiguous_participant"
					| "route_missing"
					| "expired"
					| "cancelled"
					| "telegram_rejected"
					| "session_closed",
			},
			updatedAt: value.updatedAt,
		};
	if (
		value.outcome.status === "unknown" &&
		(["transport_ambiguous", "origin_disconnected", "host_timeout", "shutdown"] as const).includes(
			value.outcome.reason as never,
		)
	)
		return {
			kind: "telegram_selected_v1",
			commitKey: value.commitKey,
			actionId: value.actionId,
			state: value.state as "pending" | "attempt_started" | "delivered" | "failed" | "unknown",
			outcome: {
				status: "unknown",
				reason: value.outcome.reason as "transport_ambiguous" | "origin_disconnected" | "host_timeout" | "shutdown",
			},
			updatedAt: value.updatedAt,
		};
	invalidFileState(filePath);
}

function migrateVersionlessV0AcceptedRecord(legacy: Record<string, unknown>, filePath: string): PersistedGate {
	if (typeof legacy.advanced !== "boolean") invalidFileState(filePath);
	const semanticDisposition = migrateVersionlessV0SemanticDisposition(legacy.semanticDisposition, filePath);
	const resolutionOrigin = migrateVersionlessV0ResolutionOrigin(legacy.resolutionOrigin, filePath);
	const ackPolicy = migrateVersionlessV0AckPolicy(legacy.ackPolicy, filePath);
	return {
		...(legacy as unknown as PersistedGate),
		...(semanticDisposition === undefined ? {} : { semanticDisposition }),
		...(resolutionOrigin === undefined ? {} : { resolutionOrigin }),
		...(ackPolicy === undefined ? {} : { ackPolicy }),
	};
}

function migrateVersionlessV0(value: unknown, filePath: string): FileState {
	if (!isObject(value) || Object.hasOwn(value, "version")) invalidFileState(filePath);
	if (Object.keys(value).some(key => key !== "counters" && key !== "gates" && key !== "runtimeInstanceId"))
		invalidFileState(filePath);
	if (!isObject(value.counters) || !isObject(value.gates)) invalidFileState(filePath);
	const gates: Record<string, PersistedGate> = {};
	for (const [gateId, legacy] of Object.entries(value.gates)) {
		if (!isObject(legacy) || !isObject(legacy.gate) || legacy.ownerInstanceId !== undefined)
			invalidFileState(filePath);
		const status = legacy.status ?? "pending";
		if (status !== "pending" && status !== "accepted") invalidFileState(filePath);
		if (status === "pending") {
			gates[gateId] = {
				gate: legacy.gate as unknown as WorkflowGate,
				status: "quarantined",
				ownerInstanceId: "legacy-v0",
				advanced: false,
				lifecycle: {
					state: "quarantined",
					reason: "orphaned_after_process_restart",
					quarantinedAt: new Date().toISOString(),
				},
			};
			continue;
		}
		const accepted = migrateVersionlessV0AcceptedRecord(legacy, filePath);
		if (accepted.advanced) {
			gates[gateId] = { ...accepted, ownerInstanceId: "legacy-v0" };
			continue;
		}
		gates[gateId] = {
			...accepted,
			status: "quarantined",
			ownerInstanceId: "legacy-v0",
			advanced: false,
			lifecycle: {
				state: "quarantined",
				reason: "accepted_unadvanced_after_process_restart",
				quarantinedAt: new Date().toISOString(),
			},
		};
	}
	const migrated: FileState = {
		version: FILE_GATE_STORE_VERSION,
		counters: value.counters as Partial<Record<WorkflowStage, number>>,
		gates,
		...(value.runtimeInstanceId === undefined ? {} : { runtimeInstanceId: value.runtimeInstanceId as string }),
	};
	assertFileState(migrated, filePath);
	return migrated;
}

function assertFileState(value: unknown, filePath: string): asserts value is FileState {
	if (
		!isObject(value) ||
		value.version !== FILE_GATE_STORE_VERSION ||
		!isObject(value.counters) ||
		!isObject(value.gates)
	)
		invalidFileState(filePath);
	for (const [stage, counter] of Object.entries(value.counters)) {
		if (
			!WORKFLOW_GATE_V1_STAGES.includes(stage as WorkflowStage) ||
			typeof counter !== "number" ||
			!Number.isSafeInteger(counter) ||
			counter < 0
		)
			invalidFileState(filePath);
	}
	if (value.runtimeInstanceId !== undefined && !isNonEmptyString(value.runtimeInstanceId)) invalidFileState(filePath);
	for (const [gateId, record] of Object.entries(value.gates))
		assertPersistedGate(record, gateId, value.counters, filePath);
	for (const [gateId, record] of Object.entries(value.gates)) {
		if (
			!isObject(record) ||
			record.status !== "quarantined" ||
			!isObject(record.lifecycle) ||
			!isNonEmptyString(record.lifecycle.supersededByGateId)
		)
			continue;
		if (
			record.lifecycle.supersededByGateId === gateId ||
			!Object.hasOwn(value.gates, record.lifecycle.supersededByGateId)
		)
			invalidFileState(filePath);
	}
}

function assertPersistedGate(
	value: unknown,
	gateId: string,
	counters: Record<string, unknown>,
	filePath: string,
): asserts value is PersistedGate {
	if (
		!isObject(value) ||
		!isObject(value.gate) ||
		value.gate.gate_id !== gateId ||
		!isNonEmptyString(value.ownerInstanceId)
	)
		invalidFileState(filePath);
	const gate = value.gate;
	const stage = gate.stage as WorkflowStage;
	const schema = gate.schema as WorkflowGate["schema"];
	if (
		gate.type !== "workflow_gate" ||
		!isNonEmptyString(gate.gate_id) ||
		!WORKFLOW_GATE_V1_STAGES.includes(stage) ||
		!["question", "approval", "execution"].includes(gate.kind as string) ||
		!isObject(gate.schema) ||
		!isNonEmptyString(gate.schema_hash) ||
		!isObject(gate.context) ||
		!isIsoDate(gate.created_at) ||
		gate.required !== true
	)
		invalidFileState(filePath);
	if (gate.runtime_turn_id !== undefined && !isNonEmptyString(gate.runtime_turn_id)) invalidFileState(filePath);
	const id = new RegExp(`^wg_[A-Za-z0-9]+_${gate.stage}_(\\d{6,})$`).exec(gate.gate_id);
	if (
		!id ||
		typeof counters[stage] !== "number" ||
		Number(id[1]) > counters[stage] ||
		gate.schema_hash !== schemaHash(schema)
	)
		invalidFileState(filePath);
	try {
		compileGateSchema(schema);
	} catch {
		invalidFileState(filePath);
	}
	if (
		gate.options !== undefined &&
		(!Array.isArray(gate.options) ||
			gate.options.some(option => !isObject(option) || !isNonEmptyString(option.label)))
	)
		invalidFileState(filePath);
	if (value.status === "pending") {
		if (
			value.advanced !== false ||
			value.terminalized !== undefined ||
			value.terminalProof !== undefined ||
			value.lifecycle !== undefined ||
			value.resolution !== undefined ||
			value.answer !== undefined ||
			value.idempotencyKey !== undefined ||
			value.responseHash !== undefined ||
			value.semanticDisposition !== undefined ||
			value.resolutionOrigin !== undefined ||
			value.ackPolicy !== undefined
		)
			invalidFileState(filePath);
		return;
	}
	if (value.status === "accepted") {
		if (
			typeof value.advanced !== "boolean" ||
			(value.terminalized !== undefined && typeof value.terminalized !== "boolean") ||
			(value.terminalProof !== undefined &&
				value.terminalProof !== "retired" &&
				value.terminalProof !== "already_terminal" &&
				value.terminalProof !== "not_published") ||
			(value.terminalized === true && value.terminalProof === undefined) ||
			(value.terminalized !== true && value.terminalProof !== undefined) ||
			!Object.hasOwn(value, "answer") ||
			(value.idempotencyKey !== undefined && !isNonEmptyString(value.idempotencyKey)) ||
			!isNonEmptyString(value.responseHash) ||
			value.responseHash !== answerHashOf({ gate_id: gateId, answer: value.answer }) ||
			!isObject(value.resolution) ||
			value.resolution.gate_id !== gateId ||
			value.resolution.status !== "accepted" ||
			value.resolution.answer_hash !== answerHashOf(value.answer) ||
			!isIsoDate(value.resolution.resolved_at) ||
			value.resolution.error !== undefined ||
			value.lifecycle !== undefined
		)
			invalidFileState(filePath);
		return;
	}
	if (
		value.status !== "quarantined" ||
		value.advanced !== false ||
		!isObject(value.lifecycle) ||
		Object.keys(value.lifecycle).some(
			key => key !== "state" && key !== "reason" && key !== "quarantinedAt" && key !== "supersededByGateId",
		) ||
		value.lifecycle.state !== "quarantined" ||
		![
			"orphaned_after_process_restart",
			"accepted_unadvanced_after_process_restart",
			"continuation_owner_lost",
			"opened_without_continuation",
			"finalization_failed",
			"advance_failed",
		].includes(value.lifecycle.reason as string) ||
		!isIsoDate(value.lifecycle.quarantinedAt) ||
		(value.lifecycle.supersededByGateId !== undefined && !isNonEmptyString(value.lifecycle.supersededByGateId))
	)
		invalidFileState(filePath);
	const hasAcceptedState =
		Object.hasOwn(value, "answer") ||
		value.terminalized !== undefined ||
		value.terminalProof !== undefined ||
		value.idempotencyKey !== undefined ||
		value.responseHash !== undefined ||
		value.resolution !== undefined ||
		value.semanticDisposition !== undefined ||
		value.resolutionOrigin !== undefined ||
		value.ackPolicy !== undefined;
	if (value.lifecycle.reason === "accepted_unadvanced_after_process_restart" || hasAcceptedState) {
		if (
			!Object.hasOwn(value, "answer") ||
			(value.terminalized !== undefined && typeof value.terminalized !== "boolean") ||
			(value.terminalProof !== undefined &&
				value.terminalProof !== "retired" &&
				value.terminalProof !== "already_terminal" &&
				value.terminalProof !== "not_published") ||
			(value.terminalized === true && value.terminalProof === undefined) ||
			(value.terminalized !== true && value.terminalProof !== undefined) ||
			(value.idempotencyKey !== undefined && !isNonEmptyString(value.idempotencyKey)) ||
			!isNonEmptyString(value.responseHash) ||
			value.responseHash !== answerHashOf({ gate_id: gateId, answer: value.answer }) ||
			!isObject(value.resolution) ||
			value.resolution.gate_id !== gateId ||
			value.resolution.status !== "accepted" ||
			value.resolution.answer_hash !== answerHashOf(value.answer) ||
			!isIsoDate(value.resolution.resolved_at) ||
			value.resolution.error !== undefined
		)
			invalidFileState(filePath);
		return;
	}
	if (
		value.lifecycle.reason === "accepted_unadvanced_after_process_restart" ||
		value.lifecycle.reason === "finalization_failed" ||
		value.lifecycle.reason === "advance_failed"
	)
		invalidFileState(filePath);
}

export function isUnsupportedWindowsDirectorySyncError(
	error: unknown,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform !== "win32") return false;
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	// Bun reports EPERM when fsyncSync is applied to a Windows directory handle.
	return code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EPERM";
}

/** A write may have reached `rename` but not the directory fsync durability barrier. */
export class GateStoreWriteError extends Error {
	constructor(
		readonly certainty: "not_committed" | "uncertain",
		cause: unknown,
	) {
		super(`gate store write ${certainty}: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "GateStoreWriteError";
	}
}

/** Crash-durable JSON-file backed store. Writes the full state on every mutation. */
export class FileGateStore implements GateStore {
	private state: FileState;
	private certaintyUnknown = false;
	constructor(
		private readonly filePath: string,
		private readonly sync: (fd: number) => void = fsyncSync,
	) {
		// Load eagerly so a corrupt store fails closed at construction, but defer
		// directory creation to the first write so constructing a store under a
		// non-writable cwd (e.g. a session that never emits a gate) never throws.
		this.state = this.load();
	}
	private load(): FileState {
		let raw: string;
		try {
			raw = readFileSync(this.filePath, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT")
				return { version: FILE_GATE_STORE_VERSION, counters: {}, gates: {} };
			throw err;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
			if (isObject(parsed) && !Object.hasOwn(parsed, "version")) {
				const migrated = migrateVersionlessV0(parsed, this.filePath);
				// Persist the v1 envelope before beginRuntimeInstance can quarantine or
				// expose any record. This preserves all v0 records atomically.
				this.flushState(migrated);
				return migrated;
			}
			assertFileState(parsed, this.filePath);
			return parsed;
		} catch (err) {
			if (err instanceof GateStoreWriteError) throw err;
			// Fail closed: invalid state must not be exposed or mutated because it can
			// drop counters/gates and risk gate-id reuse.
			const quarantine = `${this.filePath}.corrupt-${Date.now()}`;
			try {
				renameSync(this.filePath, quarantine);
			} catch {
				/* best-effort quarantine */
			}
			throw new Error(
				`corrupt gate store at ${this.filePath} (quarantined to ${quarantine}): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	private flushState(next: FileState): void {
		mkdirSync(path.dirname(this.filePath), { recursive: true });
		const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
		let renamed = false;
		try {
			const fd = openSync(tmp, "w");
			try {
				writeFileSync(fd, JSON.stringify(next, null, 2));
				this.sync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(tmp, this.filePath);
			renamed = true;
			const parentFd = openSync(path.dirname(this.filePath), "r");
			try {
				try {
					this.sync(parentFd);
				} catch (error) {
					if (!isUnsupportedWindowsDirectorySyncError(error)) throw error;
				}
			} finally {
				closeSync(parentFd);
			}
		} catch (error) {
			if (renamed) {
				this.certaintyUnknown = true;
				try {
					this.state = this.load();
				} catch {
					// The original uncertain error is the authority; later operations fail closed.
				}
			}
			throw new GateStoreWriteError(renamed ? "uncertain" : "not_committed", error);
		}
	}
	private commit(next: FileState): void {
		this.flushState(next);
		this.state = next;
	}
	private reconcileCertainty(): void {
		if (!this.certaintyUnknown) return;
		this.state = this.load();
		this.certaintyUnknown = false;
	}
	nextSeq(stage: WorkflowStage): number {
		this.reconcileCertainty();
		const next = (this.state.counters[stage] ?? 0) + 1;
		const candidate = structuredClone(this.state);
		candidate.counters[stage] = next;
		this.commit(candidate);
		return next;
	}
	put(record: PersistedGate): void {
		this.reconcileCertainty();
		const candidate = structuredClone(this.state);
		candidate.gates[record.gate.gate_id] = structuredClone(record);
		this.commit(candidate);
	}
	get(gateId: string): PersistedGate | undefined {
		this.reconcileCertainty();
		const r = this.state.gates[gateId];
		return r ? structuredClone(r) : undefined;
	}
	beginRuntimeInstance(instanceId: string): void {
		this.reconcileCertainty();
		if (this.state.runtimeInstanceId === instanceId) return;
		const priorInstanceId = this.state.runtimeInstanceId;
		const next = structuredClone(this.state);
		const now = new Date().toISOString();
		for (const record of Object.values(next.gates)) {
			if (record.ownerInstanceId !== priorInstanceId) continue;
			if (record.status === "pending") {
				record.status = "quarantined";
				record.lifecycle = { state: "quarantined", reason: "orphaned_after_process_restart", quarantinedAt: now };
			} else if (record.status === "accepted" && !record.advanced) {
				record.status = "quarantined";
				record.lifecycle = {
					state: "quarantined",
					reason: "accepted_unadvanced_after_process_restart",
					quarantinedAt: now,
				};
			}
		}
		next.runtimeInstanceId = instanceId;
		this.commit(next);
	}
	list(): PersistedGate[] {
		this.reconcileCertainty();
		return Object.values(this.state.gates).map(r => structuredClone(r));
	}
}

export type GateAuditEvent =
	| { event: "gate_emitted"; gate_id: string; stage: WorkflowStage; kind: WorkflowGateKind }
	| { event: "gate_response_accepted"; gate_id: string; answer_hash: string }
	| { event: "gate_response_rejected"; gate_id: string; answer_hash: string }
	| { event: "gate_response_idempotent_replay"; gate_id: string }
	| { event: "gate_response_idempotency_conflict"; gate_id: string }
	| { event: "gate_response_already_resolved"; gate_id: string }
	| { event: "gate_response_unknown_gate"; gate_id: string }
	| { event: "gate_advance_recovered"; gate_id: string };

export interface BrokerHooks {
	/** Called once when a pending gate has been persisted and should be emitted. */
	emit?(gate: WorkflowGate): void;
	/**
	 * Invoked to advance the workflow after an accepted resolution is durably
	 * committed. MUST be idempotent keyed by `gate.gate_id`: `recover()` replays
	 * it for any gate left `accepted` but not `advanced` by a crash.
	 */
	advance?(gate: WorkflowGate, answer: unknown): void | Promise<void>;
	/** Runs after durable acceptance and before presentation terminalization, including crash recovery. */
	finalizeAccepted?(record: PersistedGate): Promise<void>;
	/**
	 * Terminalizes the exact presentation before `advance` can run and returns
	 * proof for the durable record. `not_published` explicitly proves that no
	 * presentation existed. On failure it MUST revoke authority or throw.
	 */
	terminalizeAccepted?(record: PersistedGate): WorkflowGateTerminalProof | Promise<WorkflowGateTerminalProof>;
	/** Runs only after a successful advance has been durably marked advanced. */
	completeAccepted?(record: PersistedGate): void | Promise<void>;
	/** Append-only audit sink. */
	audit?(event: GateAuditEvent): void;
}

/** Live in-process continuation authority for one emitted gate. */
export interface GateContinuation {
	activate(gate: WorkflowGate): void;
	isLive(gateId: string): boolean;
	release?(gateId: string): void;
	/** Explicitly declares that this direct continuation owns no presentation. */
	terminalProof?: "not_published";
}

export interface OpenGateInput {
	stage: WorkflowStage;
	kind: WorkflowGateKind;
	schema: WorkflowGate["schema"];
	options?: WorkflowGateOption[];
	context?: WorkflowGateContext;
	/** Optional diagnostic gate replaced by this newly persisted gate. */
	supersedesGateId?: string;
	/** Optional immutable runtime turn captured by the emitter before broker persistence. */
	runtimeTurnId?: string;
}

/** Durable resolution state used to safely replay direct control after presentation retirement. */
export type WorkflowGateCompletedResolutionLookup =
	| { kind: "none" }
	| { kind: "completed"; resolution: WorkflowGateResolution }
	| { kind: "accepted_incomplete" };

export class WorkflowGateBrokerError extends Error {
	constructor(
		readonly code:
			| "unknown_gate"
			| "already_resolved"
			| "idempotency_conflict"
			| "invalid_workflow_stage"
			| "invalid_runtime_turn",
		message: string,
	) {
		super(message);
		this.name = "WorkflowGateBrokerError";
	}
}

export class WorkflowGateBroker {
	private readonly recovering = new Set<string>();
	private readonly gateLocks = new Map<string, Promise<void>>();
	private readonly continuations = new Map<string, GateContinuation>();
	readonly #terminalProofs = new Map<string, WorkflowGateTerminalProof>();

	private async withGateLock<T>(gateId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.gateLocks.get(gateId) ?? Promise.resolve();
		const release = Promise.withResolvers<void>();
		const current = previous.then(() => release.promise);
		this.gateLocks.set(gateId, current);
		await previous;
		try {
			return await operation();
		} finally {
			release.resolve();
			if (this.gateLocks.get(gateId) === current) this.gateLocks.delete(gateId);
		}
	}

	constructor(
		private readonly runId: string,
		private readonly store: GateStore,
		private readonly hooks: BrokerHooks = {},
		private readonly instanceId = crypto.randomUUID(),
	) {
		this.store.beginRuntimeInstance(this.instanceId);
	}

	classifyDisposition(gateId: string, answer: unknown): PersistedSemanticDisposition {
		const record = this.store.get(gateId);
		if (!record) throw new WorkflowGateBrokerError("unknown_gate", `no pending gate ${gateId}`);
		return classifyAskGateDisposition(record.gate, answer);
	}
	validationError(gateId: string, keyword: string, message: string): WorkflowGateValidationError {
		const record = this.store.get(gateId);
		return {
			code: "invalid_workflow_gate_answer",
			gate_id: gateId,
			schema_hash: record ? schemaHash(record.gate.schema) : "",
			errors: [{ path: "$", keyword, message }],
		};
	}

	updateAckPolicy(gateId: string, ackPolicy: PersistedAckPolicy): void {
		const record = this.store.get(gateId);
		if (record?.status !== "accepted")
			throw new WorkflowGateBrokerError("unknown_gate", `no accepted gate ${gateId}`);
		this.store.put({ ...record, ackPolicy });
	}

	lookupCompletedResolution(response: WorkflowGateResponse): WorkflowGateCompletedResolutionLookup {
		const record = this.store.get(response.gate_id);
		if (!record) return { kind: "none" };
		const responseHash = answerHashOf({ gate_id: response.gate_id, answer: response.answer });
		if (record.status !== "accepted" && record.status !== "quarantined") return { kind: "none" };
		if (record.responseHash === undefined) return { kind: "none" };
		const sameBody = record.responseHash === responseHash;
		const sameKey = record.idempotencyKey === response.idempotency_key;
		if (response.idempotency_key !== undefined && sameKey && !sameBody)
			throw new WorkflowGateBrokerError(
				"idempotency_conflict",
				`idempotency_conflict: gate ${response.gate_id} resolved with a different body`,
			);
		if (response.idempotency_key !== undefined && sameKey && sameBody) {
			if (record.terminalized === true && record.advanced === true && record.resolution)
				return { kind: "completed", resolution: record.resolution };
			return { kind: "accepted_incomplete" };
		}
		throw new WorkflowGateBrokerError("already_resolved", `already_resolved: gate ${response.gate_id}`);
	}

	async #terminalize(record: PersistedGate): Promise<void> {
		const proof = this.#terminalProofs.get(record.gate.gate_id) ?? (await this.hooks.terminalizeAccepted?.(record));
		this.#terminalProofs.delete(record.gate.gate_id);
		if (proof !== "retired" && proof !== "already_terminal" && proof !== "not_published")
			throw new Error(`workflow gate ${record.gate.gate_id} has no terminalization proof`);
		const terminalized = this.store.get(record.gate.gate_id);
		if (terminalized?.status !== "accepted" || terminalized.advanced)
			throw new WorkflowGateBrokerError(
				"unknown_gate",
				`accepted gate ${record.gate.gate_id} disappeared before advance`,
			);
		this.store.put({ ...terminalized, terminalized: true, terminalProof: proof });
	}

	private runShort(): string {
		return this.runId.replace(/[^a-zA-Z0-9]/g, "").slice(-8) || "run";
	}

	private hasLiveContinuation(gateId: string): boolean {
		return this.continuations.get(gateId)?.isLive(gateId) === true;
	}

	hasRecoverableAcceptedGate(): boolean {
		return this.store
			.list()
			.some(
				record =>
					record.status === "accepted" &&
					!record.advanced &&
					record.ownerInstanceId === this.instanceId &&
					this.hasLiveContinuation(record.gate.gate_id),
			);
	}
	prepareTerminalization(gateId: string, proof: WorkflowGateTerminalProof): boolean {
		const record = this.store.get(gateId);
		if (
			record?.status !== "pending" ||
			record.ownerInstanceId !== this.instanceId ||
			!this.hasLiveContinuation(gateId)
		)
			return false;
		this.#terminalProofs.set(gateId, proof);
		return true;
	}
	clearPreparedTerminalization(gateId: string): void {
		this.#terminalProofs.delete(gateId);
	}

	/**
	 * Fences a gate after an uncertain control outcome by deliberately releasing
	 * this runtime's continuation authority. The durable diagnostic is retained
	 * for recovery; it is never republished as a pending gate.
	 */
	quarantineGate(gateId: string): void {
		this.loseContinuation(gateId);
	}

	/** Revoke every live continuation, including accepted-but-unadvanced recovery authority. */
	fenceContinuations(): void {
		for (const gateId of [...this.continuations.keys()]) this.loseContinuation(gateId);
	}

	/** Fence a cancelled/lost continuation before it can be exposed or advanced. */
	loseContinuation(gateId: string): void {
		const continuation = this.continuations.get(gateId);
		continuation?.release?.(gateId);
		this.continuations.delete(gateId);
		this.#terminalProofs.delete(gateId);
		const record = this.store.get(gateId);
		if (
			record?.ownerInstanceId !== this.instanceId ||
			record.status === "quarantined" ||
			(record.status === "accepted" && record.advanced)
		)
			return;
		this.store.put({
			...record,
			status: "quarantined",
			advanced: false,
			lifecycle: {
				state: "quarantined",
				reason: "continuation_owner_lost",
				quarantinedAt: new Date().toISOString(),
			},
		});
	}

	listPendingGates(): WorkflowGate[] {
		return this.store
			.list()
			.filter(
				record =>
					record.status === "pending" &&
					record.ownerInstanceId === this.instanceId &&
					this.hasLiveContinuation(record.gate.gate_id),
			)
			.sort(compareGates)
			.map(record => record.gate);
	}

	listGateDiagnostics(): WorkflowGateDiagnostic[] {
		return this.store
			.list()
			.filter(
				(
					record,
				): record is PersistedGate & { status: "quarantined"; lifecycle: WorkflowGateDiagnostic["lifecycle"] } =>
					record.status === "quarantined" && record.lifecycle !== undefined,
			)
			.sort(
				(left, right) =>
					left.lifecycle.quarantinedAt.localeCompare(right.lifecycle.quarantinedAt) ||
					left.gate.gate_id.localeCompare(right.gate.gate_id),
			)
			.map(record => ({
				...record.gate,
				id: `diagnostic:${record.gate.gate_id}`,
				tag: "quarantined",
				lifecycle: record.lifecycle,
			}));
	}

	listWorkflowGateQueryRecords(): WorkflowGateQueryRecord[] {
		const pending: WorkflowGateQueryRecord[] = this.store
			.list()
			.filter(
				record =>
					record.status === "pending" &&
					record.ownerInstanceId === this.instanceId &&
					this.hasLiveContinuation(record.gate.gate_id),
			)
			.sort(compareGates)
			.map(record => ({ ...record.gate, id: `pending:${record.gate.gate_id}`, tag: "pending" }));
		return [...pending, ...this.listGateDiagnostics()];
	}

	/** Open and emit a gate. The pending record is persisted BEFORE emission. */
	openGate(input: OpenGateInput, continuation?: GateContinuation): WorkflowGate {
		if (RESERVED_WORKFLOW_STAGES.includes(input.stage) || !WORKFLOW_GATE_V1_STAGES.includes(input.stage)) {
			throw new WorkflowGateBrokerError(
				"invalid_workflow_stage",
				`stage "${input.stage}" is not a v1 workflow stage`,
			);
		}
		if (input.runtimeTurnId !== undefined && !isNonEmptyString(input.runtimeTurnId))
			throw new WorkflowGateBrokerError("invalid_runtime_turn", "runtime turn id must be a nonempty string");
		// Asserts schema shape (throws WorkflowGateSchemaError on unsupported keywords).
		compileGateSchema(input.schema);
		const seq = this.store.nextSeq(input.stage).toString().padStart(6, "0");
		const gateId = `wg_${this.runShort()}_${input.stage}_${seq}`;
		const gate: WorkflowGate = {
			type: "workflow_gate",
			gate_id: gateId,
			stage: input.stage,
			kind: input.kind,
			schema: input.schema,
			schema_hash: schemaHash(input.schema),
			options: input.options,
			context: input.context ?? {},
			created_at: new Date().toISOString(),
			required: true,
			...(input.runtimeTurnId === undefined ? {} : { runtime_turn_id: input.runtimeTurnId }),
		};
		if (!continuation) {
			this.store.put({
				gate,
				status: "quarantined",
				ownerInstanceId: this.instanceId,
				advanced: false,
				lifecycle: {
					state: "quarantined",
					reason: "opened_without_continuation",
					quarantinedAt: new Date().toISOString(),
				},
			});
			return gate;
		}
		this.store.put({ gate, status: "pending", ownerInstanceId: this.instanceId, advanced: false });
		continuation.activate(gate);
		if (continuation.terminalProof === "not_published") this.#terminalProofs.set(gateId, "not_published");
		this.continuations.set(gateId, continuation);
		if (input.supersedesGateId) {
			const superseded = this.store.get(input.supersedesGateId);
			if (superseded?.status === "quarantined" && superseded.lifecycle) {
				this.store.put({ ...superseded, lifecycle: { ...superseded.lifecycle, supersededByGateId: gateId } });
			}
		}
		this.hooks.emit?.(gate);
		this.hooks.audit?.({ event: "gate_emitted", gate_id: gateId, stage: gate.stage, kind: gate.kind });
		return gate;
	}

	/**
	 * Resolve a gate with an answer. Validates against the advertised schema.
	 * Accepted answers are persisted first, then their presentation is terminalized,
	 * then the workflow advances and commits `advanced:true` exactly once. Invalid
	 * answers leave the gate pending (per #315 acceptance).
	 */
	async resolve(response: WorkflowGateResponse, options: GateResolutionOptions = {}): Promise<WorkflowGateResolution> {
		try {
			return await this.withGateLock(response.gate_id, () => this.resolveUnlocked(response, options));
		} catch (error) {
			if (error instanceof GateStoreWriteError && error.certainty === "uncertain") {
				try {
					this.quarantineGate(response.gate_id);
				} catch {
					// Continuation authority was still released; preserve the uncertain write error.
				}
			}
			throw error;
		}
	}

	private async resolveUnlocked(
		response: WorkflowGateResponse,
		options: GateResolutionOptions = {},
	): Promise<WorkflowGateResolution> {
		const record = this.store.get(response.gate_id);
		if (!record || record.status === "quarantined") {
			this.hooks.audit?.({ event: "gate_response_unknown_gate", gate_id: response.gate_id });
			throw new WorkflowGateBrokerError("unknown_gate", `no live pending gate ${response.gate_id}`);
		}
		const responseHash = answerHashOf({ gate_id: response.gate_id, answer: response.answer });
		if (record.status === "accepted") {
			const sameBody = record.responseHash === responseHash;
			const sameKey = record.idempotencyKey === response.idempotency_key;
			if (response.idempotency_key !== undefined && sameKey && sameBody) {
				this.hooks.audit?.({ event: "gate_response_idempotent_replay", gate_id: response.gate_id });
				return record.resolution as WorkflowGateResolution;
			}
			if (response.idempotency_key !== undefined && sameKey && !sameBody) {
				this.hooks.audit?.({ event: "gate_response_idempotency_conflict", gate_id: response.gate_id });
				throw new WorkflowGateBrokerError(
					"idempotency_conflict",
					`idempotency_conflict: gate ${response.gate_id} resolved with a different body`,
				);
			}
			this.hooks.audit?.({ event: "gate_response_already_resolved", gate_id: response.gate_id });
			throw new WorkflowGateBrokerError("already_resolved", `already_resolved: gate ${response.gate_id}`);
		}
		if (record.ownerInstanceId !== this.instanceId || !this.hasLiveContinuation(response.gate_id)) {
			this.hooks.audit?.({ event: "gate_response_unknown_gate", gate_id: response.gate_id });
			throw new WorkflowGateBrokerError("unknown_gate", `no live pending gate ${response.gate_id}`);
		}

		const compiled = compileGateSchema(record.gate.schema);
		const validationError = validateGateAnswer(compiled, response.gate_id, response.answer);
		const answerHash = answerHashOf(response.answer);
		if (validationError) {
			// Leave the gate pending so the agent can retry with a valid answer.
			this.hooks.audit?.({ event: "gate_response_rejected", gate_id: response.gate_id, answer_hash: answerHash });
			return {
				gate_id: response.gate_id,
				status: "rejected",
				answer_hash: answerHash,
				resolved_at: new Date().toISOString(),
				error: validationError,
			};
		}

		const semanticDisposition =
			options.semanticDisposition ?? classifyAskGateDisposition(record.gate, response.answer);
		const resolutionOrigin = options.resolutionOrigin ?? { kind: "generic", channel: "sdk" as const };
		const ackPolicy =
			options.ackPolicy ??
			({ kind: "none", reason: semanticDisposition === "commit" ? "non_telegram" : "semantic_noncommit" } as const);

		const resolution: WorkflowGateResolution = {
			gate_id: response.gate_id,
			status: "accepted",
			answer_hash: answerHash,
			resolved_at: new Date().toISOString(),
		};
		// Persist resolution BEFORE advancing the workflow (exactly-once advance).
		// `answer` is retained so a crash before the advanced:true write can be
		// recovered via recover().
		this.store.put({
			gate: record.gate,
			status: "accepted",
			ownerInstanceId: record.ownerInstanceId,
			idempotencyKey: response.idempotency_key,
			responseHash,
			answer: response.answer,
			resolution,
			advanced: false,
			terminalized: false,
			semanticDisposition,
			resolutionOrigin,
			ackPolicy,
		});
		this.hooks.audit?.({ event: "gate_response_accepted", gate_id: response.gate_id, answer_hash: answerHash });
		await options.beforeAdvance?.();
		await this.hooks.finalizeAccepted?.(this.store.get(response.gate_id) as PersistedGate);
		const finalized = this.store.get(response.gate_id);
		if (finalized?.status !== "accepted") {
			throw new WorkflowGateBrokerError(
				"unknown_gate",
				`accepted gate ${response.gate_id} disappeared before terminalization`,
			);
		}
		if (finalized.advanced) return finalized.resolution ?? resolution;
		if (!finalized.terminalized) await this.#terminalize(finalized);
		const terminalized = this.store.get(response.gate_id);
		if (terminalized?.status !== "accepted" || terminalized.advanced) {
			throw new WorkflowGateBrokerError(
				"unknown_gate",
				`accepted gate ${response.gate_id} disappeared before advance`,
			);
		}
		if (!this.hooks.advance || !this.hasLiveContinuation(response.gate_id)) {
			throw new WorkflowGateBrokerError("unknown_gate", `no live continuation for gate ${response.gate_id}`);
		}
		await this.hooks.advance(terminalized.gate, terminalized.answer);
		const latest = this.store.get(response.gate_id);
		if (latest?.status !== "accepted" || !this.hasLiveContinuation(response.gate_id))
			throw new WorkflowGateBrokerError(
				"unknown_gate",
				`accepted gate ${response.gate_id} lost its continuation before advance completed`,
			);
		this.store.put({ ...latest, advanced: true });
		await this.hooks.completeAccepted?.(this.store.get(response.gate_id) as PersistedGate);
		this.continuations.get(response.gate_id)?.release?.(response.gate_id);
		this.continuations.delete(response.gate_id);
		return resolution;
	}

	/**
	 * Recover any gate left `accepted` but not `advanced` by a crash between the
	 * durable accept and the advanced commit. Replays `advance` (which must be
	 * idempotent) exactly once per gate and marks it advanced. Returns the ids
	 * that were recovered.
	 */
	async recover(): Promise<string[]> {
		const recovered: string[] = [];
		for (const listed of this.store.list()) {
			if (
				listed.status !== "accepted" ||
				listed.advanced ||
				listed.ownerInstanceId !== this.instanceId ||
				!this.hasLiveContinuation(listed.gate.gate_id) ||
				this.recovering.has(listed.gate.gate_id)
			)
				continue;
			this.recovering.add(listed.gate.gate_id);
			try {
				await this.withGateLock(listed.gate.gate_id, async () => {
					const rec = this.store.get(listed.gate.gate_id);
					if (rec?.status !== "accepted" || rec.advanced) return;
					await this.hooks.finalizeAccepted?.(rec);
					const finalized = this.store.get(listed.gate.gate_id);
					if (
						finalized?.status !== "accepted" ||
						finalized.advanced ||
						!this.hasLiveContinuation(listed.gate.gate_id)
					)
						return;
					if (!finalized.terminalized) await this.#terminalize(finalized);
					const terminalized = this.store.get(listed.gate.gate_id);
					if (
						terminalized?.status !== "accepted" ||
						terminalized.advanced ||
						!this.hooks.advance ||
						!this.hasLiveContinuation(listed.gate.gate_id)
					)
						return;
					await this.hooks.advance(terminalized.gate, terminalized.answer);
					const latest = this.store.get(listed.gate.gate_id);
					if (latest?.status !== "accepted" || latest.advanced || !this.hasLiveContinuation(listed.gate.gate_id))
						return;
					this.store.put({ ...latest, advanced: true });
					await this.hooks.completeAccepted?.(this.store.get(latest.gate.gate_id) as PersistedGate);
					this.continuations.get(latest.gate.gate_id)?.release?.(latest.gate.gate_id);
					this.continuations.delete(latest.gate.gate_id);
					this.hooks.audit?.({ event: "gate_advance_recovered", gate_id: latest.gate.gate_id });
					recovered.push(latest.gate.gate_id);
				});
			} finally {
				this.recovering.delete(listed.gate.gate_id);
			}
		}
		return recovered;
	}

	/** Canonical serialization helper (exposed for callers/tests). */
	static canonical(value: unknown): string {
		return canonicalJson(value);
	}
}

function compareGates(left: PersistedGate, right: PersistedGate): number {
	return (
		left.gate.created_at.localeCompare(right.gate.created_at) || left.gate.gate_id.localeCompare(right.gate.gate_id)
	);
}
