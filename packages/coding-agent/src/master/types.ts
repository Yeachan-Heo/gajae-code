export const MASTER_SCHEMA_VERSION = 1 as const;
export const MASTER_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_MAX_CONCURRENT_WORKERS = 3;
export const MAX_MASTER_NAME_BYTES = 63;

export type MasterProvider = "telegram" | "discord";

/** Presentation payload committed by the master before a provider worker performs I/O. */
export interface PresentationContent {
	text: string;
	workerSessionId: string | null;
	taskId: string | null;
	decisionId: string | null;
	memoryActivityId: string | null;
}

export interface ProviderEffectLeaseBase {
	effectId: string;
	intentId: string;
	leaseId: string;
	masterName: string;
	provider: MasterProvider;
	fence: number;
	nonce: string;
	expiresAt: string;
}

export type ProviderEffectLease =
	| (ProviderEffectLeaseBase & {
			kind: "provision_channel";
			operation: "create" | "reconcile" | "replace";
			channelName: string;
			previousRemoteChannelId: string | null;
	  })
	| (ProviderEffectLeaseBase & {
			kind: "present_event";
			eventId: string;
			bindingId: string;
			content: PresentationContent;
	  });

export type ProviderProvisionOutcome =
	| {
			effectKind: "provision_channel";
			status: "succeeded";
			remoteEffectId: string;
			remoteChannelId: string;
			reconciled: boolean;
	  }
	| {
			effectKind: "provision_channel";
			status: "retryable";
			code: "transport_unavailable" | "rate_limited" | "provider_busy";
			retryAfterMs: number | null;
			message: string;
	  }
	| { effectKind: "provision_channel"; status: "unknown"; code: "create_uncertain"; message: string }
	| {
			effectKind: "provision_channel";
			status: "terminal";
			code: "forum_topics_unsupported" | "permission_denied" | "provider_not_configured" | "channel_deleted";
			message: string;
	  };

export type ProviderPresentationOutcome =
	| {
			effectKind: "present_event";
			status: "succeeded";
			remoteEffectId: string;
			remoteMessageId: string;
			reconciled: boolean;
	  }
	| {
			effectKind: "present_event";
			status: "retryable";
			code: "transport_unavailable" | "rate_limited" | "provider_busy";
			retryAfterMs: number | null;
			message: string;
	  }
	| { effectKind: "present_event"; status: "unknown"; code: "post_uncertain"; message: string }
	| {
			effectKind: "present_event";
			status: "terminal";
			/**
			 * `post_unverifiable` means the provider accepted or may have accepted the
			 * post but exposes no way to correlate it. Retrying would duplicate a
			 * user-visible message, so the effect is blocked for explicit recovery
			 * instead of being re-leased.
			 */
			code: "permission_denied" | "channel_deleted" | "provider_not_configured" | "post_unverifiable";
			message: string;
	  };

export type ProviderEffectOutcome = ProviderProvisionOutcome | ProviderPresentationOutcome;

export interface ProviderWorkerLease {
	provider: MasterProvider;
	workerId: string;
	leaseId: string;
	expiresAt: string;
	state: "active" | "expired";
	createdAt: string;
	updatedAt: string;
}

export interface ProviderWorkerRegistrationInput {
	provider: MasterProvider;
	workerId: string;
	leaseId?: string;
	ttlMs?: number;
}

export interface ProviderWorkerRegistrationReceipt {
	provider: MasterProvider;
	workerId: string;
	leaseId: string;
	expiresAt: string;
	state: "registered" | "already_registered";
}

export interface ProviderEffectLeaseRecord {
	effectId: string;
	intentId: string;
	provider: MasterProvider;
	kind: "provision_channel" | "present_event";
	eventId: string | null;
	bindingId: string | null;
	leaseId: string;
	fence: number;
	nonce: string;
	workerId: string;
	workerLeaseId: string;
	retryAt: string | null;
	expiresAt: string;
	state: "leased" | "pending" | "blocked" | "reconciled";
	outcomeDigest: string | null;
	outcome: ProviderEffectOutcome | null;
}

export interface ProviderEffectLeaseInput {
	provider: MasterProvider;
	workerId?: string;
	workerLeaseId?: string;
}

export interface ProviderEffectResultInput {
	effectId: string;
	intentId: string;
	leaseId: string;
	provider: MasterProvider;
	fence: number;
	nonce: string;
	workerId?: string;
	workerLeaseId?: string;
	outcome: ProviderEffectOutcome;
}

export interface ProviderEffectResultReceipt {
	effectId: string;
	provider: MasterProvider;
	disposition: "recorded" | "already_recorded";
	nextState: "pending" | "blocked" | "reconciled";
	receiptCursor: number;
}

export interface CreateBindingIntentInput {
	provider?: MasterProvider;
	providers?: readonly MasterProvider[];
	channelName?: string;
	intentId?: string;
}

export interface BindingIntentReceipt {
	provider: MasterProvider;
	intentId: string;
	fence: number;
	state: "provisioning";
	channelName: string;
}

export interface ReconcileBindingInput {
	provider: MasterProvider;
	intentId: string;
	effectId: string;
	leaseId: string;
	fence: number;
	nonce: string;
	outcome: ProviderProvisionOutcome;
}

export interface ReconcileBindingReceipt {
	provider: MasterProvider;
	intentId: string;
	bindingId: string | null;
	remoteChannelId: string | null;
	state: ChannelBindingState;
	fence: number;
	idempotent: boolean;
}

export interface ProviderHealthChangedReceipt {
	providers: ProviderHealth;
	status: "idle" | "channel_blocked";
}
export type CapacityState = "within_limit" | "draining_over_capacity";
export type MasterOwner = { kind: "master"; masterName: string } | { kind: "user" };
export type TaskPriority = "urgent_user" | "user" | "autonomous";
export type TaskSource = "user" | "master";
export type TaskState = "queued" | "leased" | "assigned" | "completed" | "failed" | "retry_pending" | "blocked";
export type TerminalTaskState = "completed" | "failed" | "blocked";

export interface TaskSummary {
	taskId: string;
	logicalTaskId?: string;
	enqueueSeq: number;
	priority: TaskPriority;
	source: TaskSource;
	state: TaskState;
	attempt: number;
	summary: string;
	createdAt: string;
	updatedAt: string;
	workerSessionId: string | null;
}

export type TaskSummaryFor<S extends TaskState> = Omit<TaskSummary, "state"> & { state: S };

export interface TaskRecord extends TaskSummary {
	idempotencyKey: string;
	bodyDigest: string;
	leaseId: string | null;
	workdir: string | null;
}

export interface QueueStateSummary {
	queueRevision: number;
	pendingCount: number;
	activeWorkerCount: number;
	maxConcurrentWorkers: number;
	capacityState: CapacityState;
	userDispatchStreak: number;
}

export type QueueUpdatedPayload =
	| {
			action: "enqueued";
			cause: "user_ingress" | "master_autonomous";
			task: TaskSummaryFor<"queued">;
			queue: QueueStateSummary;
	  }
	| { action: "leased"; cause: "dispatcher"; task: TaskSummaryFor<"leased">; queue: QueueStateSummary }
	| { action: "assigned"; cause: "worker_owner_committed"; task: TaskSummaryFor<"assigned">; queue: QueueStateSummary }
	| { action: "completed"; cause: "worker_terminal"; task: TaskSummaryFor<"completed">; queue: QueueStateSummary }
	| {
			action: "failed";
			cause: "worker_terminal";
			task: TaskSummaryFor<"failed">;
			queue: QueueStateSummary;
			reason: string;
	  }
	| {
			action: "retry_scheduled";
			cause: "worker_terminal";
			task: TaskSummaryFor<"retry_pending">;
			queue: QueueStateSummary;
			reason: string;
	  }
	| {
			action: "blocked";
			cause: "authority" | "channel" | "coordinator";
			task: TaskSummaryFor<"blocked">;
			queue: QueueStateSummary;
			reason: string;
	  }
	| {
			action: "capacity_reconfigured";
			cause: "operator";
			previousMaxConcurrentWorkers: number;
			queue: QueueStateSummary;
	  };

export type OwnershipUpdatedPayload =
	| {
			action: "owner_assigned";
			cause: "worker_created" | "user_registered";
			workerSessionId: string;
			previousOwner: null;
			nextOwner: MasterOwner;
	  }
	| {
			action: "claim_requested";
			workerSessionId: string;
			claimId: string;
			authorizationId: string;
			requestedMasterName: string;
			previousOwner: MasterOwner;
			nextOwner: MasterOwner;
			expiresAt: string;
	  }
	| {
			action: "claim_approved";
			workerSessionId: string;
			claimId: string;
			approvalActorId: string;
			previousOwner: MasterOwner;
			nextOwner: { kind: "master"; masterName: string };
	  }
	| {
			action: "claim_rejected";
			workerSessionId: string;
			claimId: string;
			rejection: "expired" | "denied" | "authorization_invalid";
			previousOwner: MasterOwner;
			nextOwner: MasterOwner;
	  };

export type DecisionTrigger =
	| {
			kind: "worker_action";
			workerSessionId: string;
			actionId: string;
			actionKind: "ask" | "idle";
			taskId: string | null;
	  }
	| { kind: "task_dispatch"; taskId: string }
	| { kind: "worker_terminal"; workerSessionId: string; taskId: string }
	| { kind: "daemon_recovery"; recoveryId: string };

export interface DoctrineEvidence {
	revision: string;
	sha256: string;
}

export interface DecisionMemoryEvidence {
	availability: "available" | "unavailable";
	activityIds: readonly string[];
}

export interface DecisionLoggedPayload {
	decisionId: string;
	trigger: DecisionTrigger;
	outcome: "follow_up" | "escalated" | "assigned" | "completed" | "blocked";
	reason: string;
	doctrine: DoctrineEvidence;
	memory: DecisionMemoryEvidence;
}

export type MasterRuntimeStatus =
	| "starting"
	| "idle"
	| "busy"
	| "channel_blocked"
	| "authority_blocked"
	| "stopped"
	| "error";
export type MasterStatusReason =
	| "boot"
	| "no_active_provider"
	| "provider_degraded"
	| "provider_recovered"
	| "authority_changed"
	| "coordinator_unavailable"
	| "session_profile_rejected"
	| "recovered"
	| "operator_stop"
	| "internal_error";

export interface ProviderHealth {
	configuredProviders: readonly MasterProvider[];
	activeProviders: readonly MasterProvider[];
	degradedProviders: readonly MasterProvider[];
	operational: boolean;
}

export interface ProviderIngress {
	kind: "provider";
	provider: MasterProvider;
	channelId: string;
	messageId: string;
	actorId: string;
}

export interface LocalIngress {
	kind: "local";
	actorId: string;
	sourceId: string;
}

export type MasterIngress = ProviderIngress | LocalIngress;

export type ClaimAuthorizationState = "unused" | "consumed" | "expired";
export type OwnershipClaimStatus = "pending_approval" | "approved" | "expired" | "rejected";

export interface ClaimRequestAuthorization {
	authorizationId: string;
	workerSessionId: string;
	requestedMasterName: string;
	ingress: ProviderIngress;
	actorId: string;
	channelId: string;
	messageId: string;
	issuedAt: string;
	expiresAt: string;
	state: ClaimAuthorizationState;
}

export interface OwnershipClaim {
	claimId: string;
	authorizationId: string;
	workerSessionId: string;
	requestedMasterName: string;
	requestIngress: ProviderIngress;
	requestedAt: string;
	expiresAt: string;
	previousOwner: MasterOwner;
	status: OwnershipClaimStatus;
	approvalIngress: ProviderIngress | null;
	approvedAt: string | null;
}

export interface ClaimAuthorizationMintInput {
	workerSessionId: string;
	requestedMasterName: string;
	ingress: ProviderIngress;
	ttlMs?: number;
	expiresAt?: string;
	idempotencyKey?: string;
}

export interface ModelClaimRequestInput {
	authorizationId: string;
	workerSessionId: string;
	requestedMasterName: string;
	actorKind?: "model";
}

export interface ClaimApprovalInput {
	claimId: string;
	ingress: ProviderIngress;
	actorKind?: "user" | "model";
	authenticated?: boolean;
	idempotencyKey?: string;
}

export interface ClaimApprovalResult {
	claimId: string;
	status: "approved" | "already_approved";
	owner: { kind: "master"; masterName: string };
}

export interface DecisionRecordInput {
	decisionId?: string;
	trigger: DecisionTrigger;
	outcome: DecisionLoggedPayload["outcome"];
	reason: string;
	doctrine: DoctrineEvidence;
	memory: DecisionMemoryEvidence;
}

export interface EscalationInput {
	decisionId?: string;
	workerSessionId?: string;
	taskId?: string;
	reason: string;
	presentation?: string;
	trigger?: DecisionTrigger;
	doctrine?: DoctrineEvidence;
	memory?: DecisionMemoryEvidence;
}

export type MasterStatusPayload =
	| {
			transition: "state_changed";
			previousStatus: MasterRuntimeStatus;
			status: MasterRuntimeStatus;
			reason: MasterStatusReason | null;
			providers: ProviderHealth;
			memoryAvailability?: "available" | "unavailable";
	  }
	| {
			transition: "provider_health_changed";
			status: "idle" | "busy" | "channel_blocked";
			reason: "no_active_provider" | "provider_degraded" | "provider_recovered";
			providers: ProviderHealth;
	  }
	| {
			transition: "turn_started";
			status: "busy";
			turnId: string;
			triggerEventId: string;
			providers: ProviderHealth;
	  }
	| {
			transition: "turn_finished";
			status: "idle" | "channel_blocked" | "authority_blocked" | "error";
			turnId: string;
			result: "completed" | "failed";
			reason: MasterStatusReason | null;
			providers: ProviderHealth;
	  }
	| {
			transition: "recovered";
			status: MasterRuntimeStatus;
			recoveryId: string;
			reason: "recovered";
			providers: ProviderHealth;
	  };

export type ChannelBindingState = "provisioning" | "active" | "blocked" | "unknown" | "relocating";
export type ChannelUpdatedPayload =
	| {
			transition: "binding_intent_created";
			provider: MasterProvider;
			intentId: string;
			fence: number;
			state: "provisioning";
			channelName: string;
	  }
	| {
			transition: "binding_active";
			provider: MasterProvider;
			intentId: string;
			bindingId: string;
			remoteChannelId: string;
			fence: number;
			state: "active";
	  }
	| {
			transition: "binding_blocked";
			provider: MasterProvider;
			intentId: string;
			fence: number;
			state: "blocked" | "unknown";
			code: "provider_unavailable" | "create_uncertain" | "provider_terminal";
	  }
	| {
			transition: "provider_degraded";
			provider: MasterProvider;
			bindingId: string;
			state: "active";
			deliveryHealth: "degraded";
			activeProviderCount: number;
			degradedProviderCount: number;
			pendingPresentationCount: number;
			reason: "presentation_pending";
	  }
	| {
			transition: "provider_degraded";
			provider: MasterProvider;
			bindingId: string | null;
			state: "blocked" | "unknown";
			deliveryHealth: "degraded";
			activeProviderCount: number;
			degradedProviderCount: number;
			pendingPresentationCount: number;
			reason: "binding_unavailable";
	  }
	| {
			transition: "provider_recovered";
			provider: MasterProvider;
			bindingId: string;
			state: "active";
			deliveryHealth: "healthy";
			activeProviderCount: number;
			degradedProviderCount: number;
			replayPendingCount: 0;
	  }
	| {
			transition: "binding_relocated";
			provider: MasterProvider;
			intentId: string;
			previousBindingId: string;
			bindingId: string;
			remoteChannelId: string;
			fence: number;
			state: "active";
	  }
	| {
			transition: "presentation_pending";
			provider: MasterProvider;
			eventId: string;
			effectId: string;
			bindingId: string;
			fence: number;
			state: "active" | "blocked";
	  }
	| {
			transition: "presentation_reconciled";
			provider: MasterProvider;
			eventId: string;
			effectId: string;
			bindingId: string;
			remoteMessageId: string;
			fence: number;
			state: "active";
	  };

export interface MemoryActivity {
	activityId: string;
	operation: "read" | "write";
	scope: "global";
	masterName: string;
	taskId?: string;
	workerSessionId?: string;
	entryIds?: readonly string[];
	summary: string;
	occurredAt: string;
}

export interface MemoryActivityPayload {
	activity: MemoryActivity;
}

export type MasterEventFrame =
	| {
			protocolVersion: 1;
			seq: number;
			eventId: string;
			masterName: string;
			occurredAt: string;
			type: "queue_updated";
			payload: QueueUpdatedPayload;
	  }
	| {
			protocolVersion: 1;
			seq: number;
			eventId: string;
			masterName: string;
			occurredAt: string;
			type: "ownership_updated";
			payload: OwnershipUpdatedPayload;
	  }
	| {
			protocolVersion: 1;
			seq: number;
			eventId: string;
			masterName: string;
			occurredAt: string;
			type: "decision_logged";
			payload: DecisionLoggedPayload;
	  }
	| {
			protocolVersion: 1;
			seq: number;
			eventId: string;
			masterName: string;
			occurredAt: string;
			type: "memory_activity";
			payload: MemoryActivityPayload;
	  }
	| {
			protocolVersion: 1;
			seq: number;
			eventId: string;
			masterName: string;
			occurredAt: string;
			type: "master_status";
			payload: MasterStatusPayload;
	  }
	| {
			protocolVersion: 1;
			seq: number;
			eventId: string;
			masterName: string;
			occurredAt: string;
			type: "channel_updated";
			payload: ChannelUpdatedPayload;
	  };

export type PersistedMasterEvent = MasterEventFrame & { checksum: string };

export type EventDraft =
	| { type: "queue_updated"; payload: QueueUpdatedPayload }
	| { type: "ownership_updated"; payload: OwnershipUpdatedPayload }
	| { type: "decision_logged"; payload: DecisionLoggedPayload }
	| { type: "memory_activity"; payload: MemoryActivityPayload }
	| { type: "master_status"; payload: MasterStatusPayload }
	| { type: "channel_updated"; payload: ChannelUpdatedPayload };

export type WorkerLifecycleState = "owned_unprompted" | "prompt_pending" | "active" | "terminal" | "user_registered";
export type WorkerCreateIntentState =
	| "reserved"
	| "create_uncertain"
	| "created"
	| "prompt_pending"
	| "active"
	| "terminal";

export interface WorkerFollowUpIntent {
	idempotencyKey: string;
	promptDigest: string;
	state: "pending" | "delivered" | "uncertain";
	createdAt: string;
	updatedAt: string;
}

export interface WorkerCreateIntent {
	intentId: string;
	masterName: string;
	taskId: string;
	canonicalCwd: string;
	createIdempotencyKey: string;
	promptDigest: string;
	intendedOwner: { kind: "master"; masterName: string };
	state: WorkerCreateIntentState;
	promptIdempotencyKey: string | null;
	/**
	 * Coordinator turn proven by the last accepted prompt delivery. Observation is
	 * turn-scoped, so this must be durable: without it a restarted master cannot
	 * read the real worker turn and would fall back to a guessed action.
	 */
	promptTurnId: string | null;
	followUps: WorkerFollowUpIntent[];
	createdAt: string;
	updatedAt: string;
}

export interface WorkerObservation {
	observationId: string;
	sequence: number;
	occurredAt: string;
	event: unknown;
}

export interface WorkerLease {
	leaseId: string;
	workerSessionId: string | null;
	intentId: string;
	taskId: string;
	attempt: number;
	state: "leased" | "assigned" | "terminal";
	lifecycle: WorkerLifecycleState | null;
	promptIdempotencyKey: string | null;
	terminalState: TerminalTaskState | null;
	createdAt: string;
	updatedAt: string;
	terminalAt: string | null;
	quarantine: WorkerObservation[];
	observations: WorkerObservation[];
	nextObservationSequence: number;
}

export interface WorkerLifecycleReceipt {
	leaseId: string;
	intentId: string;
	taskId: string;
	workerSessionId: string | null;
	lifecycle: WorkerLifecycleState | null;
	promptIdempotencyKey: string | null;
	quarantined: readonly WorkerObservation[];
}

export interface WorkerCreateReceipt extends WorkerLifecycleReceipt {
	created: boolean;
}

export interface PromptPendingReceipt extends WorkerLifecycleReceipt {
	promptIdempotencyKey: string;
}

export interface PromptReconcileReceipt extends WorkerLifecycleReceipt {
	proven: boolean;
	drained: readonly WorkerObservation[];
}

export type WorkerObservationDisposition = "master" | "user" | "quarantined";

export interface WorkerObservationReceipt {
	workerSessionId: string;
	observationId: string;
	sequence: number;
	disposition: WorkerObservationDisposition;
	owner: MasterOwner;
	quarantineId: string | null;
	event: unknown;
}

export interface UserWorkerReceipt {
	workerSessionId: string;
	owner: { kind: "user" };
	lifecycle: "user_registered";
}

export interface MasterWorkersDocument {
	version: 1;
	schema_version: 1;
	kind: "master_workers";
	masterName: string;
	intents: WorkerCreateIntent[];
	workers: WorkerLease[];
}

export interface WorkerRegistrationInput {
	workerSessionId: string;
}

export interface WorkerCreateReconcileInput {
	intentId: string;
	workerSessionId?: string;
	sessionId?: string;
	response?: Record<string, unknown>;
	outcome?: "created" | "uncertain" | "unknown";
	status?: "created" | "uncertain" | "unknown";
}

export interface PromptPendingInput {
	leaseId?: string;
	intentId?: string;
	promptIdempotencyKey?: string;
}

export interface PromptReconcileInput {
	leaseId?: string;
	intentId?: string;
	promptIdempotencyKey?: string;
	proven: boolean;
	/** Coordinator turn id proven by this delivery, retained for later observation. */
	promptTurnId?: string;
}

export interface ObserveWorkerInput {
	workerSessionId: string;
	observationId?: string;
	event: unknown;
}

export interface WorkerOwnershipSummary {
	workerSessionId: string;
	owner: MasterOwner;
	lifecycle: WorkerLifecycleState;
	taskId: string | null;
}

export interface ChannelSnapshot {
	provider: MasterProvider;
	state: ChannelBindingState;
	intentId: string;
	bindingId: string | null;
	remoteChannelId: string | null;
	fence: number;
	pendingPresentationCount: number;
	deliveryHealth: "healthy" | "degraded";
}

export interface DecisionSummary {
	decisionId: string;
	outcome: "follow_up" | "escalated" | "assigned" | "completed" | "blocked";
	occurredAt: string;
	reason: string;
}

export interface MemorySnapshot {
	availability: "available" | "unavailable";
	latestActivity: MemoryActivity | null;
}

export interface MasterSnapshot {
	masterName: string;
	defaultWorkdir: string;
	status: MasterRuntimeStatus;
	statusSince: string;
	providerHealth: ProviderHealth;
	queue: QueueStateSummary;
	workerCount: number;
	workers: readonly WorkerOwnershipSummary[];
	workersTruncated: boolean;
	channels: readonly ChannelSnapshot[];
	recentDecisions: readonly DecisionSummary[];
	memory: MemorySnapshot;
}

export type MasterDomainSnapshot = MasterSnapshot;

export interface MasterRecord {
	version: 1;
	schema_version: 1;
	kind: "master_record";
	masterName: string;
	defaultWorkdir: string;
	maxConcurrentWorkers: number;
	capacityState: CapacityState;
	activeWorkerCount: number;
	queueRevision: number;
	userDispatchStreak: number;
	authorityFingerprint: string;
	createdAt: string;
	updatedAt: string;
}

export interface IdempotencyReceipt {
	idempotencyKey: string;
	bodyDigest: string;
	taskId: string;
	enqueueSeq: number;
	state: "queued";
}

export interface ReleaseReceipt {
	leaseId: string;
	taskId: string;
	workerSessionId: string | null;
	state: TerminalTaskState;
	activeWorkerCount: number;
	alreadyReleased: boolean;
}

export interface EnqueueReceipt {
	kind: "task";
	taskId: string;
	enqueueSeq: number;
	state: "queued";
	idempotent: boolean;
}

export interface LeaseReceipt {
	leaseId: string;
	intentId: string;
	taskId: string;
	workerSessionId: string | null;
	attempt: number;
	state: "leased";
	idempotent: boolean;
	canonicalCwd: string;
	createIdempotencyKey: string;
	promptDigest: string;
}

export interface MasterQueueDocument {
	version: 1;
	schema_version: 1;
	kind: "master_queue";
	masterName: string;
	queueRevision: number;
	nextEnqueueSeq: number;
	userDispatchStreak: number;
	activeWorkerCount: number;
	maxConcurrentWorkers: number;
	capacityState: CapacityState;
	tasks: TaskRecord[];
	idempotencyReceipts: Record<string, IdempotencyReceipt>;
	releaseReceipts: Record<string, ReleaseReceipt>;
}

export interface MasterOwnershipDocument {
	version: 1;
	schema_version: 1;
	kind: "master_ownership";
	masterName: string;
	owners: Record<string, MasterOwner>;
}

export interface MasterClaimsDocument {
	version: 1;
	schema_version: 1;
	kind: "master_claims";
	masterName: string;
	authorizations: Record<string, ClaimRequestAuthorization>;
	claims: Record<string, OwnershipClaim>;
	mintIdempotency: Record<string, { digest: string; authorizationId: string }>;
	approvalIdempotency: Record<string, { digest: string; result: ClaimApprovalResult }>;
}

export interface MasterChannelsDocument {
	version: 1;
	schema_version: 1;
	kind: "master_channels";
	masterName: string;
	channels: ChannelSnapshot[];
	configuredProviders: MasterProvider[];
	receiptCursors: Partial<Record<MasterProvider, number>>;
	workerLeases: ProviderWorkerLease[];
	effectLeases: ProviderEffectLeaseRecord[];
}

export interface PresentationOutboxRow {
	provider: MasterProvider;
	eventId: string;
	eventSeq: number;
	effectId: string;
	intentId: string;
	bindingId: string | null;
	fence: number;
	nonce: string;
	state: "pending" | "leased" | "reconciled" | "blocked";
	leaseId: string | null;
	leaseExpiresAt: string | null;
	workerId: string | null;
	workerLeaseId: string | null;
	retryAt: string | null;
	remoteEffectId: string | null;
	remoteMessageId: string | null;
	lastOutcomeDigest: string | null;
	lastOutcome: ProviderPresentationOutcome | null;
	content: PresentationContent;
	createdAt: string;
	updatedAt: string;
}

export interface MasterOutboxDocument {
	version: 1;
	schema_version: 1;
	kind: "master_presentation_outbox";
	masterName: string;
	rows: PresentationOutboxRow[];
}

export interface MasterStoreState {
	record: MasterRecord;
	queue: MasterQueueDocument;
	workers: MasterWorkersDocument;
	ownership: MasterOwnershipDocument;
	claims: MasterClaimsDocument;
	channels: MasterChannelsDocument;
	outbox: MasterOutboxDocument;
	events: PersistedMasterEvent[];
}

export interface MasterCommitManifest {
	version: 1;
	schema_version: 1;
	kind: "master_commit_manifest";
	masterName: string;
	generation: number;
	status: "pending" | "committed";
	state: MasterStoreState;
	event: PersistedMasterEvent | null;
}

export interface MasterDomainStoreOptions {
	masterName: string;
	configuredProviders?: readonly MasterProvider[];
	defaultWorkdir?: string;
	maxConcurrentWorkers?: number;
	authorityFingerprint?: string;
	expectedAuthorityFingerprint?: string;
	coordinatorAuthorityFingerprint?: string;
	configRootDir?: string;
	rootDir?: string;
	masterRootDir?: string;
	now?: () => Date;
}

export interface EnqueueTaskInput {
	ingress?: MasterIngress;
	idempotencyKey: string;
	priority: TaskPriority;
	source: TaskSource;
	summary: string;
	workdir?: string | null;
	taskId?: string;
}

export interface AdmitTaskInput {
	leaseId?: string;
	intentId?: string;
	canonicalCwd?: string;
	createIdempotencyKey?: string;
	promptDigest?: string;
}

export interface ReleaseWorkerInput {
	leaseId?: string;
	taskId?: string;
	workerSessionId?: string;
	state?: TerminalTaskState;
	reason?: string;
}

export interface ConfigureCapacityResult {
	previousMaxConcurrentWorkers: number;
	maxConcurrentWorkers: number;
	capacityState: CapacityState;
	activeWorkerCount: number;
}

export interface QueuePage {
	items: readonly TaskSummary[];
	nextCursor: string | null;
	queueRevision: number;
}

export interface MasterListItem {
	masterName: string;
	defaultWorkdir: string;
	maxConcurrentWorkers: number;
	capacityState: CapacityState;
	activeWorkerCount: number;
	updatedAt: string;
}

export class MasterStoreError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "MasterStoreError";
		this.code = code;
	}
}

export class MasterStoreCorruptionError extends MasterStoreError {
	constructor(message: string) {
		super("MASTER_STATE_CORRUPT", message);
		this.name = "MasterStoreCorruptionError";
	}
}

export class MasterStoreNotFoundError extends MasterStoreError {
	constructor(masterName: string) {
		super("MASTER_NOT_FOUND", `Master ${masterName} does not exist.`);
		this.name = "MasterStoreNotFoundError";
	}
}

export class MasterIdempotencyConflictError extends MasterStoreError {
	constructor(idempotencyKey: string) {
		super("IDEMPOTENCY_CONFLICT", `Idempotency key ${idempotencyKey} was reused with a different request.`);
		this.name = "MasterIdempotencyConflictError";
	}
}

export class MasterCapacityError extends MasterStoreError {
	constructor(message: string) {
		super("CAPACITY_UNAVAILABLE", message);
		this.name = "MasterCapacityError";
	}
}
