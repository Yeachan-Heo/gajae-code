import * as z from "zod/v4";
import type { MasterEventFrame, MasterSnapshot, ProviderHealth, QueueStateSummary, TaskState } from "./types";

export type {
	CapacityState,
	ChannelBindingState,
	ChannelSnapshot,
	ChannelUpdatedPayload,
	DecisionLoggedPayload,
	DecisionMemoryEvidence,
	DecisionSummary,
	DecisionTrigger,
	DoctrineEvidence,
	EventDraft,
	MasterEventFrame,
	MasterOwner,
	MasterProvider,
	MasterRuntimeStatus,
	MasterSnapshot,
	MasterStatusPayload,
	MemoryActivity,
	MemoryActivityPayload,
	OwnershipUpdatedPayload,
	ProviderHealth,
	QueueStateSummary,
	QueueUpdatedPayload,
	TaskPriority,
	TaskSource,
	TaskState,
	TaskSummary,
	WorkerLifecycleState,
	WorkerOwnershipSummary,
} from "./types";

export const MASTER_PROTOCOL_VERSION = 1 as const;
export const MASTER_SCHEMA_VERSION = 1 as const;
export const MAX_MASTER_FRAME_BYTES = 262_144;
export const MASTER_MAX_FRAME_BYTES = MAX_MASTER_FRAME_BYTES;
export const MAX_OPAQUE_ID_BYTES = 128;
export const MAX_MASTER_NAME_BYTES = 63;
export const MAX_TASK_SUMMARY_BYTES = 1_024;
export const MAX_REASON_BYTES = 2_048;
export const MAX_PRESENTATION_TEXT_BYTES = 8_192;
export const MAX_CHANNEL_NAME_BYTES = 128;
export const MAX_WORKDIR_BYTES = 4_096;
export const MAX_USER_MESSAGE_BYTES = 16_384;
export const MAX_MEMORY_SUMMARY_BYTES = 1_024;
export const MAX_MEMORY_ENTRIES = 32;
export const MAX_SNAPSHOT_MASTERS = 64;
export const MAX_SNAPSHOT_WORKERS = 128;
export const MAX_SNAPSHOT_CHANNELS = 2;
export const MAX_SNAPSHOT_DECISIONS = 32;
export const MAX_PAGE_SIZE = 50;
export const MAX_RETRY_DELAY_MS = 86_400_000;

const textEncoder = new TextEncoder();
const printableAscii = /^[\x20-\x7e]+$/;
const canonicalMasterNamePattern = /^[a-z][a-z0-9-]*$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

function byteLength(value: string): number {
	return textEncoder.encode(value).byteLength;
}

function utf8String(min: number, max: number, label: string): z.ZodType<string> {
	return z.string().refine(value => {
		const bytes = byteLength(value);
		return bytes >= min && bytes <= max;
	}, `${label} must be ${min}..${max} UTF-8 bytes`);
}

function asciiString(min = 1, max = MAX_OPAQUE_ID_BYTES, label = "value"): z.ZodType<string> {
	return z
		.string()
		.refine(
			value => printableAscii.test(value) && byteLength(value) >= min && byteLength(value) <= max,
			`${label} must be printable ASCII ${min}..${max} bytes`,
		);
}

function nonNegativeSafeInteger(label: string): z.ZodType<number> {
	return z
		.number()
		.refine(value => Number.isSafeInteger(value) && value >= 0, `${label} must be a non-negative safe integer`);
}

function positiveSafeInteger(label: string): z.ZodType<number> {
	return z
		.number()
		.refine(value => Number.isSafeInteger(value) && value >= 1, `${label} must be a positive safe integer`);
}

function utcTimestamp(label = "timestamp"): z.ZodType<string> {
	return z.string().refine(value => {
		if (!value.endsWith("Z")) return false;
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) && value === new Date(parsed).toISOString();
	}, `${label} must be a canonical UTC ISO timestamp`);
}

const opaqueId = asciiString(1, MAX_OPAQUE_ID_BYTES, "opaque id");
const requestId = asciiString(1, MAX_OPAQUE_ID_BYTES, "request id");
const idempotencyKey = asciiString(1, MAX_OPAQUE_ID_BYTES, "idempotency key");
const nonce = asciiString(1, MAX_OPAQUE_ID_BYTES, "nonce");
const cursor = asciiString(1, MAX_OPAQUE_ID_BYTES, "cursor");
const channelId = asciiString(1, MAX_OPAQUE_ID_BYTES, "channel id");
const actorId = asciiString(1, MAX_OPAQUE_ID_BYTES, "actor id");
const masterName = z
	.string()
	.refine(
		value =>
			byteLength(value) >= 1 && byteLength(value) <= MAX_MASTER_NAME_BYTES && canonicalMasterNamePattern.test(value),
		"master name must match [a-z][a-z0-9-]{0,62}",
	);
const doctrineRevision = asciiString(1, MAX_OPAQUE_ID_BYTES, "doctrine revision");
const reasonText = utf8String(1, MAX_REASON_BYTES, "reason");
const shortReasonText = utf8String(1, MAX_TASK_SUMMARY_BYTES, "summary reason");
const presentationText = utf8String(1, MAX_PRESENTATION_TEXT_BYTES, "presentation text");
const workdirText = utf8String(1, MAX_WORKDIR_BYTES, "workdir");
const userMessageText = utf8String(1, MAX_USER_MESSAGE_BYTES, "user message");
const channelNameText = utf8String(1, MAX_CHANNEL_NAME_BYTES, "channel name");
const memorySummaryText = utf8String(1, MAX_MEMORY_SUMMARY_BYTES, "memory summary");
const sha256 = z
	.string()
	.refine(value => sha256Pattern.test(value), "sha256 must be 64 lowercase hexadecimal characters");
const optionalWorkdir = z.union([workdirText, z.null()]);
const optionalCursor = z.union([cursor, z.null()]);
const optionalOpaqueId = z.union([opaqueId, z.null()]);
const optionalRetryDelay = z.union([
	nonNegativeSafeInteger("retryAfterMs").refine(value => value <= MAX_RETRY_DELAY_MS, "retryAfterMs is too large"),
	z.null(),
]);

const providerEnum = z.enum(["telegram", "discord"]);
const providerArray = z
	.array(providerEnum)
	.max(2, "at most two providers are supported")
	.superRefine((values, context) => {
		if (new Set(values).size !== values.length)
			context.addIssue({ code: "custom", message: "provider arrays must be unique" });
	});

export const masterProviderSchema = providerEnum;
export const masterNameSchema = masterName;
export const opaqueIdSchema = opaqueId;
export const requestIdSchema = requestId;
export const idempotencyKeySchema = idempotencyKey;
export const timestampSchema = utcTimestamp();
export const doctrineDigestSchema = sha256;
export const retryDelaySchema = optionalRetryDelay;

const masterOwnerSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("master"), masterName }).strict(),
		z.object({ kind: z.literal("user") }).strict(),
	])
	.superRefine((value, context) => {
		if (value.kind === "master" && !masterName.safeParse(value.masterName).success)
			context.addIssue({ code: "custom", message: "owner masterName is invalid" });
	});
export const masterOwnerValidator = masterOwnerSchema;

function taskSummarySchemaForState(state: TaskState) {
	return z
		.object({
			taskId: opaqueId,
			enqueueSeq: positiveSafeInteger("enqueueSeq"),
			priority: z.enum(["urgent_user", "user", "autonomous"]),
			source: z.enum(["user", "master"]),
			state: z.literal(state),
			attempt: nonNegativeSafeInteger("attempt"),
			summary: shortReasonText,
			createdAt: utcTimestamp("createdAt"),
			updatedAt: utcTimestamp("updatedAt"),
			workerSessionId: optionalOpaqueId,
		})
		.strict()
		.superRefine((value, context) => {
			if (value.source === "master" && value.priority !== "autonomous")
				context.addIssue({
					code: "custom",
					path: ["priority"],
					message: "master tasks must use autonomous priority",
				});
			if (value.source === "user" && value.priority === "autonomous")
				context.addIssue({
					code: "custom",
					path: ["priority"],
					message: "user tasks cannot use autonomous priority",
				});
		});
}

export const taskSummarySchema = z
	.object({
		taskId: opaqueId,
		enqueueSeq: positiveSafeInteger("enqueueSeq"),
		priority: z.enum(["urgent_user", "user", "autonomous"]),
		source: z.enum(["user", "master"]),
		state: z.enum(["queued", "leased", "assigned", "completed", "failed", "retry_pending", "blocked"]),
		attempt: nonNegativeSafeInteger("attempt"),
		summary: shortReasonText,
		createdAt: utcTimestamp("createdAt"),
		updatedAt: utcTimestamp("updatedAt"),
		workerSessionId: optionalOpaqueId,
	})
	.strict()
	.superRefine((value, context) => {
		if (value.source === "master" && value.priority !== "autonomous")
			context.addIssue({ code: "custom", path: ["priority"], message: "master tasks must use autonomous priority" });
		if (value.source === "user" && value.priority === "autonomous")
			context.addIssue({ code: "custom", path: ["priority"], message: "user tasks cannot use autonomous priority" });
	});
export const taskSummarySchemaV1 = taskSummarySchema;

export const queueStateSummarySchema = z
	.object({
		queueRevision: nonNegativeSafeInteger("queueRevision"),
		pendingCount: nonNegativeSafeInteger("pendingCount"),
		activeWorkerCount: nonNegativeSafeInteger("activeWorkerCount"),
		maxConcurrentWorkers: positiveSafeInteger("maxConcurrentWorkers"),
		capacityState: z.enum(["within_limit", "draining_over_capacity"]),
		userDispatchStreak: nonNegativeSafeInteger("userDispatchStreak"),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.capacityState === "within_limit" && value.activeWorkerCount > value.maxConcurrentWorkers)
			context.addIssue({
				code: "custom",
				path: ["capacityState"],
				message: "within_limit cannot exceed maxConcurrentWorkers",
			});
		if (value.capacityState === "draining_over_capacity" && value.activeWorkerCount <= value.maxConcurrentWorkers)
			context.addIssue({
				code: "custom",
				path: ["capacityState"],
				message: "draining_over_capacity requires activeWorkerCount above maxConcurrentWorkers",
			});
	});
export const queueStateSummarySchemaV1 = queueStateSummarySchema;

const queueUpdatedPayloadSchemas = [
	z
		.object({
			action: z.literal("enqueued"),
			cause: z.enum(["user_ingress", "master_autonomous"]),
			task: taskSummarySchemaForState("queued"),
			queue: queueStateSummarySchema,
		})
		.strict(),
	z
		.object({
			action: z.literal("leased"),
			cause: z.literal("dispatcher"),
			task: taskSummarySchemaForState("leased"),
			queue: queueStateSummarySchema,
		})
		.strict(),
	z
		.object({
			action: z.literal("assigned"),
			cause: z.literal("worker_owner_committed"),
			task: taskSummarySchemaForState("assigned"),
			queue: queueStateSummarySchema,
		})
		.strict(),
	z
		.object({
			action: z.literal("completed"),
			cause: z.literal("worker_terminal"),
			task: taskSummarySchemaForState("completed"),
			queue: queueStateSummarySchema,
		})
		.strict(),
	z
		.object({
			action: z.literal("failed"),
			cause: z.literal("worker_terminal"),
			task: taskSummarySchemaForState("failed"),
			queue: queueStateSummarySchema,
			reason: reasonText,
		})
		.strict(),
	z
		.object({
			action: z.literal("retry_scheduled"),
			cause: z.literal("worker_terminal"),
			task: taskSummarySchemaForState("retry_pending"),
			queue: queueStateSummarySchema,
			reason: reasonText,
		})
		.strict(),
	z
		.object({
			action: z.literal("blocked"),
			cause: z.enum(["authority", "channel", "coordinator"]),
			task: taskSummarySchemaForState("blocked"),
			queue: queueStateSummarySchema,
			reason: reasonText,
		})
		.strict(),
	z
		.object({
			action: z.literal("capacity_reconfigured"),
			cause: z.literal("operator"),
			previousMaxConcurrentWorkers: positiveSafeInteger("previousMaxConcurrentWorkers"),
			queue: queueStateSummarySchema,
		})
		.strict(),
] as const;
export const queueUpdatedPayloadSchema = z.discriminatedUnion("action", queueUpdatedPayloadSchemas);

const ownershipUpdatedPayloadSchemas = [
	z
		.object({
			action: z.literal("owner_assigned"),
			cause: z.enum(["worker_created", "user_registered"]),
			workerSessionId: opaqueId,
			previousOwner: z.null(),
			nextOwner: masterOwnerSchema,
		})
		.strict(),
	z
		.object({
			action: z.literal("claim_requested"),
			workerSessionId: opaqueId,
			claimId: opaqueId,
			authorizationId: opaqueId,
			requestedMasterName: masterName,
			previousOwner: masterOwnerSchema,
			nextOwner: masterOwnerSchema,
			expiresAt: utcTimestamp("expiresAt"),
		})
		.strict(),
	z
		.object({
			action: z.literal("claim_approved"),
			workerSessionId: opaqueId,
			claimId: opaqueId,
			approvalActorId: actorId,
			previousOwner: masterOwnerSchema,
			nextOwner: z.object({ kind: z.literal("master"), masterName }).strict(),
		})
		.strict(),
	z
		.object({
			action: z.literal("claim_rejected"),
			workerSessionId: opaqueId,
			claimId: opaqueId,
			rejection: z.enum(["expired", "denied", "authorization_invalid"]),
			previousOwner: masterOwnerSchema,
			nextOwner: masterOwnerSchema,
		})
		.strict(),
] as const;
export const ownershipUpdatedPayloadSchema = z.discriminatedUnion("action", ownershipUpdatedPayloadSchemas);

const decisionTriggerSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("worker_action"),
			workerSessionId: opaqueId,
			actionId: opaqueId,
			actionKind: z.enum(["ask", "idle"]),
			taskId: optionalOpaqueId,
		})
		.strict(),
	z.object({ kind: z.literal("task_dispatch"), taskId: opaqueId }).strict(),
	z.object({ kind: z.literal("worker_terminal"), workerSessionId: opaqueId, taskId: opaqueId }).strict(),
	z.object({ kind: z.literal("daemon_recovery"), recoveryId: opaqueId }).strict(),
]);
export const decisionTriggerValidator = decisionTriggerSchema;

const doctrineEvidenceSchema = z.object({ revision: doctrineRevision, sha256 }).strict();
const decisionMemoryEvidenceSchema = z
	.object({
		availability: z.enum(["available", "unavailable"]),
		activityIds: z
			.array(opaqueId)
			.max(MAX_MEMORY_ENTRIES)
			.superRefine((values, context) => {
				if (new Set(values).size !== values.length)
					context.addIssue({ code: "custom", message: "activityIds must be unique" });
			}),
	})
	.strict();
const decisionLoggedPayloadSchema = z
	.object({
		decisionId: opaqueId,
		trigger: decisionTriggerSchema,
		outcome: z.enum(["follow_up", "escalated", "assigned", "completed", "blocked"]),
		reason: shortReasonText,
		doctrine: doctrineEvidenceSchema,
		memory: decisionMemoryEvidenceSchema,
	})
	.strict();
export const doctrineEvidenceValidator = doctrineEvidenceSchema;
export const decisionMemoryEvidenceValidator = decisionMemoryEvidenceSchema;
export const decisionLoggedPayloadSchemaV1 = decisionLoggedPayloadSchema;

export const providerHealthSchema = z
	.object({
		configuredProviders: providerArray,
		activeProviders: providerArray,
		degradedProviders: providerArray,
		operational: z.boolean(),
	})
	.strict()
	.superRefine((value, context) => {
		const configured = new Set(value.configuredProviders);
		for (const provider of value.activeProviders) {
			if (!configured.has(provider))
				context.addIssue({
					code: "custom",
					path: ["activeProviders"],
					message: "active provider must be configured",
				});
		}
		for (const provider of value.degradedProviders) {
			if (!configured.has(provider))
				context.addIssue({
					code: "custom",
					path: ["degradedProviders"],
					message: "degraded provider must be configured",
				});
		}
		if (value.operational !== value.activeProviders.length >= 1)
			context.addIssue({
				code: "custom",
				path: ["operational"],
				message: "operational must equal activeProviders.length >= 1",
			});
	});
export const providerHealthValidator = providerHealthSchema;

const masterStatusPayloadSchemas = [
	z
		.object({
			transition: z.literal("state_changed"),
			previousStatus: z.enum([
				"starting",
				"idle",
				"busy",
				"channel_blocked",
				"authority_blocked",
				"stopped",
				"error",
			]),
			status: z.enum(["starting", "idle", "busy", "channel_blocked", "authority_blocked", "stopped", "error"]),
			reason: z.union([
				z.enum([
					"boot",
					"no_active_provider",
					"provider_degraded",
					"provider_recovered",
					"authority_changed",
					"coordinator_unavailable",
					"session_profile_rejected",
					"recovered",
					"operator_stop",
					"internal_error",
				]),
				z.null(),
			]),
			providers: providerHealthSchema,
			memoryAvailability: z.enum(["available", "unavailable"]).optional(),
		})
		.strict(),
	z
		.object({
			transition: z.literal("provider_health_changed"),
			status: z.enum(["idle", "busy", "channel_blocked"]),
			reason: z.enum(["no_active_provider", "provider_degraded", "provider_recovered"]),
			providers: providerHealthSchema,
		})
		.strict(),
	z
		.object({
			transition: z.literal("turn_started"),
			status: z.literal("busy"),
			turnId: opaqueId,
			triggerEventId: opaqueId,
			providers: providerHealthSchema,
		})
		.strict(),
	z
		.object({
			transition: z.literal("turn_finished"),
			status: z.enum(["idle", "channel_blocked", "authority_blocked", "error"]),
			turnId: opaqueId,
			result: z.enum(["completed", "failed"]),
			reason: z.union([
				z.enum([
					"boot",
					"no_active_provider",
					"provider_degraded",
					"provider_recovered",
					"authority_changed",
					"coordinator_unavailable",
					"session_profile_rejected",
					"recovered",
					"operator_stop",
					"internal_error",
				]),
				z.null(),
			]),
			providers: providerHealthSchema,
		})
		.strict(),
	z
		.object({
			transition: z.literal("recovered"),
			status: z.enum(["starting", "idle", "busy", "channel_blocked", "authority_blocked", "stopped", "error"]),
			recoveryId: opaqueId,
			reason: z.literal("recovered"),
			providers: providerHealthSchema,
		})
		.strict(),
] as const;
export const masterStatusPayloadSchema = z.discriminatedUnion("transition", masterStatusPayloadSchemas);

const channelUpdatedPayloadSchemas = [
	z
		.object({
			transition: z.literal("binding_intent_created"),
			provider: providerEnum,
			intentId: opaqueId,
			fence: nonNegativeSafeInteger("fence"),
			state: z.literal("provisioning"),
			channelName: channelNameText,
		})
		.strict(),
	z
		.object({
			transition: z.literal("binding_active"),
			provider: providerEnum,
			intentId: opaqueId,
			bindingId: opaqueId,
			remoteChannelId: channelId,
			fence: nonNegativeSafeInteger("fence"),
			state: z.literal("active"),
		})
		.strict(),
	z
		.object({
			transition: z.literal("binding_blocked"),
			provider: providerEnum,
			intentId: opaqueId,
			fence: nonNegativeSafeInteger("fence"),
			state: z.enum(["blocked", "unknown"]),
			code: z.enum(["provider_unavailable", "create_uncertain", "provider_terminal"]),
		})
		.strict(),
	z
		.object({
			transition: z.literal("provider_degraded"),
			provider: providerEnum,
			bindingId: opaqueId,
			state: z.literal("active"),
			deliveryHealth: z.literal("degraded"),
			activeProviderCount: nonNegativeSafeInteger("activeProviderCount"),
			degradedProviderCount: nonNegativeSafeInteger("degradedProviderCount"),
			pendingPresentationCount: positiveSafeInteger("pendingPresentationCount"),
			reason: z.literal("presentation_pending"),
		})
		.strict(),
	z
		.object({
			transition: z.literal("provider_degraded"),
			provider: providerEnum,
			bindingId: optionalOpaqueId,
			state: z.enum(["blocked", "unknown"]),
			deliveryHealth: z.literal("degraded"),
			activeProviderCount: nonNegativeSafeInteger("activeProviderCount"),
			degradedProviderCount: nonNegativeSafeInteger("degradedProviderCount"),
			pendingPresentationCount: nonNegativeSafeInteger("pendingPresentationCount"),
			reason: z.literal("binding_unavailable"),
		})
		.strict(),
	z
		.object({
			transition: z.literal("provider_recovered"),
			provider: providerEnum,
			bindingId: opaqueId,
			state: z.literal("active"),
			deliveryHealth: z.literal("healthy"),
			activeProviderCount: nonNegativeSafeInteger("activeProviderCount"),
			degradedProviderCount: nonNegativeSafeInteger("degradedProviderCount"),
			replayPendingCount: z.literal(0),
		})
		.strict(),
	z
		.object({
			transition: z.literal("binding_relocated"),
			provider: providerEnum,
			intentId: opaqueId,
			previousBindingId: opaqueId,
			bindingId: opaqueId,
			remoteChannelId: channelId,
			fence: nonNegativeSafeInteger("fence"),
			state: z.literal("active"),
		})
		.strict(),
	z
		.object({
			transition: z.literal("presentation_pending"),
			provider: providerEnum,
			eventId: opaqueId,
			effectId: opaqueId,
			bindingId: opaqueId,
			fence: nonNegativeSafeInteger("fence"),
			state: z.enum(["active", "blocked"]),
		})
		.strict(),
	z
		.object({
			transition: z.literal("presentation_reconciled"),
			provider: providerEnum,
			eventId: opaqueId,
			effectId: opaqueId,
			bindingId: opaqueId,
			remoteMessageId: opaqueId,
			fence: nonNegativeSafeInteger("fence"),
			state: z.literal("active"),
		})
		.strict(),
] as const;
export const channelUpdatedPayloadSchema = z.union(channelUpdatedPayloadSchemas);

const memoryActivitySchema = z
	.object({
		activityId: opaqueId,
		operation: z.enum(["read", "write"]),
		scope: z.literal("global"),
		masterName,
		taskId: opaqueId.optional(),
		workerSessionId: opaqueId.optional(),
		entryIds: z
			.array(opaqueId)
			.max(MAX_MEMORY_ENTRIES)
			.superRefine((values, context) => {
				if (new Set(values).size !== values.length)
					context.addIssue({ code: "custom", message: "entryIds must be unique" });
			})
			.optional(),
		summary: memorySummaryText,
		occurredAt: utcTimestamp("occurredAt"),
	})
	.strict();
export const memoryActivityPayloadSchema = z.object({ activity: memoryActivitySchema }).strict();
export const memoryActivitySchemaV1 = memoryActivitySchema;

const eventBase = {
	protocolVersion: z.literal(MASTER_PROTOCOL_VERSION),
	seq: positiveSafeInteger("seq"),
	eventId: opaqueId,
	masterName,
	occurredAt: utcTimestamp("occurredAt"),
};
const masterEventFrameSchemas = [
	z.object({ ...eventBase, type: z.literal("queue_updated"), payload: queueUpdatedPayloadSchema }).strict(),
	z.object({ ...eventBase, type: z.literal("ownership_updated"), payload: ownershipUpdatedPayloadSchema }).strict(),
	z.object({ ...eventBase, type: z.literal("decision_logged"), payload: decisionLoggedPayloadSchema }).strict(),
	z.object({ ...eventBase, type: z.literal("memory_activity"), payload: memoryActivityPayloadSchema }).strict(),
	z.object({ ...eventBase, type: z.literal("master_status"), payload: masterStatusPayloadSchema }).strict(),
	z.object({ ...eventBase, type: z.literal("channel_updated"), payload: channelUpdatedPayloadSchema }).strict(),
] as const;
export const masterEventFrameSchema = z.discriminatedUnion("type", masterEventFrameSchemas);
export const persistedMasterEventSchema = z
	.object({
		...eventBase,
		type: z.enum([
			"queue_updated",
			"ownership_updated",
			"decision_logged",
			"memory_activity",
			"master_status",
			"channel_updated",
		]),
		payload: z.unknown(),
		checksum: sha256,
	})
	.strict();

const workerOwnershipSummarySchema = z
	.object({
		workerSessionId: opaqueId,
		owner: masterOwnerSchema,
		lifecycle: z.enum(["owned_unprompted", "prompt_pending", "active", "terminal", "user_registered"]),
		taskId: optionalOpaqueId,
	})
	.strict();
const channelSnapshotSchema = z
	.object({
		provider: providerEnum,
		state: z.enum(["provisioning", "active", "blocked", "unknown", "relocating"]),
		intentId: opaqueId,
		bindingId: optionalOpaqueId,
		remoteChannelId: optionalOpaqueId,
		fence: nonNegativeSafeInteger("fence"),
		pendingPresentationCount: nonNegativeSafeInteger("pendingPresentationCount"),
		deliveryHealth: z.enum(["healthy", "degraded"]),
	})
	.strict();
const decisionSummarySchema = z
	.object({
		decisionId: opaqueId,
		outcome: z.enum(["follow_up", "escalated", "assigned", "completed", "blocked"]),
		occurredAt: utcTimestamp("occurredAt"),
		reason: shortReasonText,
	})
	.strict();
const memorySnapshotSchema = z
	.object({
		availability: z.enum(["available", "unavailable"]),
		latestActivity: z.union([memoryActivitySchema, z.null()]),
	})
	.strict();
const masterSnapshotSchema = z
	.object({
		masterName,
		defaultWorkdir: workdirText,
		status: z.enum(["starting", "idle", "busy", "channel_blocked", "authority_blocked", "stopped", "error"]),
		statusSince: utcTimestamp("statusSince"),
		providerHealth: providerHealthSchema,
		queue: queueStateSummarySchema,
		workerCount: nonNegativeSafeInteger("workerCount"),
		workers: z.array(workerOwnershipSummarySchema).max(MAX_SNAPSHOT_WORKERS),
		workersTruncated: z.boolean(),
		channels: z.array(channelSnapshotSchema).max(MAX_SNAPSHOT_CHANNELS),
		recentDecisions: z.array(decisionSummarySchema).max(MAX_SNAPSHOT_DECISIONS),
		memory: memorySnapshotSchema,
	})
	.strict()
	.superRefine((value, context) => {
		if (!value.workersTruncated && value.workerCount !== value.workers.length)
			context.addIssue({
				code: "custom",
				path: ["workerCount"],
				message: "workerCount must match workers when workersTruncated is false",
			});
		if (value.workersTruncated && value.workerCount < value.workers.length)
			context.addIssue({
				code: "custom",
				path: ["workerCount"],
				message: "workerCount cannot be less than visible workers",
			});
		if (new Set(value.channels.map(channel => channel.provider)).size !== value.channels.length)
			context.addIssue({ code: "custom", path: ["channels"], message: "channels must contain unique providers" });
	});
export const masterSnapshotSchemaV1 = masterSnapshotSchema;
const masterSnapshotsSchema = z.array(masterSnapshotSchema).max(MAX_SNAPSHOT_MASTERS);

const providerIngressSchema = z
	.object({ kind: z.literal("provider"), provider: providerEnum, channelId, messageId: opaqueId, actorId })
	.strict();
const localIngressSchema = z.object({ kind: z.literal("local"), actorId, sourceId: opaqueId }).strict();
const userIngressSchema = z.discriminatedUnion("kind", [providerIngressSchema, localIngressSchema]);
export const providerIngressValidator = providerIngressSchema;
export const localIngressValidator = localIngressSchema;
export const userIngressSchemaV1 = userIngressSchema;

const presentationContentSchema = z
	.object({
		text: presentationText,
		workerSessionId: optionalOpaqueId,
		taskId: optionalOpaqueId,
		decisionId: optionalOpaqueId,
		memoryActivityId: optionalOpaqueId,
	})
	.strict();
const providerEffectLeaseBase = {
	effectId: opaqueId,
	intentId: opaqueId,
	leaseId: opaqueId,
	masterName,
	provider: providerEnum,
	fence: nonNegativeSafeInteger("fence"),
	nonce,
	expiresAt: utcTimestamp("expiresAt"),
};
export const providerEffectLeaseSchema = z.discriminatedUnion("kind", [
	z
		.object({
			...providerEffectLeaseBase,
			kind: z.literal("provision_channel"),
			operation: z.enum(["create", "reconcile", "replace"]),
			channelName: channelNameText,
			previousRemoteChannelId: optionalOpaqueId,
		})
		.strict(),
	z
		.object({
			...providerEffectLeaseBase,
			kind: z.literal("present_event"),
			eventId: opaqueId,
			bindingId: opaqueId,
			content: presentationContentSchema,
		})
		.strict(),
]);
export const providerEffectLeaseValidator = providerEffectLeaseSchema;

const providerProvisionOutcomeSchema = z.discriminatedUnion("status", [
	z
		.object({
			effectKind: z.literal("provision_channel"),
			status: z.literal("succeeded"),
			remoteEffectId: opaqueId,
			remoteChannelId: channelId,
			reconciled: z.boolean(),
		})
		.strict(),
	z
		.object({
			effectKind: z.literal("provision_channel"),
			status: z.literal("retryable"),
			code: z.enum(["transport_unavailable", "rate_limited", "provider_busy"]),
			retryAfterMs: optionalRetryDelay,
			message: reasonText,
		})
		.strict(),
	z
		.object({
			effectKind: z.literal("provision_channel"),
			status: z.literal("unknown"),
			code: z.literal("create_uncertain"),
			message: reasonText,
		})
		.strict(),
	z
		.object({
			effectKind: z.literal("provision_channel"),
			status: z.literal("terminal"),
			code: z.enum(["forum_topics_unsupported", "permission_denied", "provider_not_configured", "channel_deleted"]),
			message: reasonText,
		})
		.strict(),
]);
const providerPresentationOutcomeSchema = z.discriminatedUnion("status", [
	z
		.object({
			effectKind: z.literal("present_event"),
			status: z.literal("succeeded"),
			remoteEffectId: opaqueId,
			remoteMessageId: opaqueId,
			reconciled: z.boolean(),
		})
		.strict(),
	z
		.object({
			effectKind: z.literal("present_event"),
			status: z.literal("retryable"),
			code: z.enum(["transport_unavailable", "rate_limited", "provider_busy"]),
			retryAfterMs: optionalRetryDelay,
			message: reasonText,
		})
		.strict(),
	z
		.object({
			effectKind: z.literal("present_event"),
			status: z.literal("unknown"),
			code: z.literal("post_uncertain"),
			message: reasonText,
		})
		.strict(),
	z
		.object({
			effectKind: z.literal("present_event"),
			status: z.literal("terminal"),
			code: z.enum(["permission_denied", "channel_deleted", "provider_not_configured", "post_unverifiable"]),
			message: reasonText,
		})
		.strict(),
]);
export const providerProvisionOutcomeValidator = providerProvisionOutcomeSchema;
export const providerPresentationOutcomeValidator = providerPresentationOutcomeSchema;
const providerEffectOutcomeSchema = z.union([providerProvisionOutcomeSchema, providerPresentationOutcomeSchema]);

const taskIngressAckSchema = z
	.object({
		kind: z.literal("task"),
		taskId: opaqueId,
		enqueueSeq: positiveSafeInteger("enqueueSeq"),
		state: z.literal("queued"),
	})
	.strict();
const claimAuthorizationAckSchema = z
	.object({
		kind: z.literal("claim_authorization"),
		authorizationId: opaqueId,
		expiresAt: utcTimestamp("expiresAt"),
		state: z.literal("unused"),
	})
	.strict();
const claimApprovalAckSchema = z
	.object({
		kind: z.literal("claim"),
		claimId: opaqueId,
		status: z.enum(["approved", "already_approved"]),
		owner: z.object({ kind: z.literal("master"), masterName }).strict(),
	})
	.strict();
const providerWorkerHelloAckSchema = z
	.object({
		kind: z.literal("provider_worker"),
		provider: providerEnum,
		workerId: opaqueId,
		state: z.literal("registered"),
	})
	.strict();
const providerEffectResultAckSchema = z
	.object({
		kind: z.literal("provider_effect_result"),
		effectId: opaqueId,
		disposition: z.enum(["recorded", "already_recorded"]),
		nextState: z.enum(["pending", "blocked", "reconciled"]),
	})
	.strict();
const ackResultSchema = z.discriminatedUnion("kind", [
	taskIngressAckSchema,
	claimAuthorizationAckSchema,
	claimApprovalAckSchema,
	providerWorkerHelloAckSchema,
	providerEffectResultAckSchema,
]);
export const ackResultValidator = ackResultSchema;

const providerEffectResultFrameSchemas = [
	z
		.object({
			type: z.literal("provider_effect_result"),
			requestId,
			effectId: opaqueId,
			intentId: opaqueId,
			leaseId: opaqueId,
			fence: nonNegativeSafeInteger("fence"),
			nonce,
			effectKind: z.literal("provision_channel"),
			outcome: providerProvisionOutcomeSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("provider_effect_result"),
			requestId,
			effectId: opaqueId,
			intentId: opaqueId,
			leaseId: opaqueId,
			fence: nonNegativeSafeInteger("fence"),
			nonce,
			effectKind: z.literal("present_event"),
			outcome: providerPresentationOutcomeSchema,
		})
		.strict(),
] as const;
export const providerEffectResultFrameSchema = z.union(providerEffectResultFrameSchemas);
export const providerEffectResultValidator = providerEffectResultFrameSchema;

const masterClientFrameSchemas = [
	z
		.object({ type: z.literal("subscribe"), requestId, afterSeq: nonNegativeSafeInteger("afterSeq").optional() })
		.strict(),
	z.object({ type: z.literal("get_snapshot"), requestId }).strict(),
	z
		.object({
			type: z.literal("get_queue_page"),
			requestId,
			masterName,
			cursor: optionalCursor,
			limit: positiveSafeInteger("limit").refine(value => value <= MAX_PAGE_SIZE, "limit must be at most 50"),
		})
		.strict(),
	z
		.object({
			type: z.literal("master_user_message"),
			requestId,
			idempotencyKey,
			masterName,
			text: userMessageText,
			urgency: z.enum(["urgent_user", "user"]),
			workdir: optionalWorkdir,
			ingress: userIngressSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("claim_request"),
			requestId,
			idempotencyKey,
			masterName,
			workerSessionId: opaqueId,
			ingress: providerIngressSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("approve_claim"),
			requestId,
			idempotencyKey,
			claimId: opaqueId,
			ingress: providerIngressSchema,
		})
		.strict(),
	z
		.object({ type: z.literal("provider_worker_hello"), requestId, provider: providerEnum, workerId: opaqueId })
		.strict(),
	...providerEffectResultFrameSchemas,
	z.object({ type: z.literal("ping"), requestId, nonce }).strict(),
] as const;
export const masterClientFrameSchema = z.union(masterClientFrameSchemas);

const helloFrameSchema = z
	.object({
		type: z.literal("hello"),
		protocolVersion: z.literal(MASTER_PROTOCOL_VERSION),
		connectionId: opaqueId,
		capabilities: z.tuple([z.literal("master-sdk-v1")]),
	})
	.strict();
const masterSnapshotFrameSchema = z
	.object({
		type: z.literal("master_snapshot"),
		protocolVersion: z.literal(MASTER_PROTOCOL_VERSION),
		requestId,
		snapshotCutSeq: nonNegativeSafeInteger("snapshotCutSeq"),
		generatedAt: utcTimestamp("generatedAt"),
		masters: masterSnapshotsSchema,
	})
	.strict();
const subscriptionReadyFrameSchema = z
	.object({
		type: z.literal("subscription_ready"),
		requestId,
		mode: z.enum(["snapshot", "replay"]),
		highWaterSeq: nonNegativeSafeInteger("highWaterSeq"),
	})
	.strict();
const queuePageFrameSchema = z
	.object({
		type: z.literal("queue_page"),
		requestId,
		masterName,
		snapshotCutSeq: nonNegativeSafeInteger("snapshotCutSeq"),
		queueRevision: nonNegativeSafeInteger("queueRevision"),
		items: z.array(taskSummarySchema).max(MAX_PAGE_SIZE),
		nextCursor: optionalCursor,
	})
	.strict();
const masterAckFrameSchemas = [
	z
		.object({
			type: z.literal("ack"),
			requestId,
			operation: z.literal("master_user_message"),
			idempotencyKey,
			result: taskIngressAckSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("ack"),
			requestId,
			operation: z.literal("claim_request"),
			idempotencyKey,
			result: claimAuthorizationAckSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("ack"),
			requestId,
			operation: z.literal("approve_claim"),
			idempotencyKey,
			result: claimApprovalAckSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("ack"),
			requestId,
			operation: z.literal("provider_worker_hello"),
			result: providerWorkerHelloAckSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("ack"),
			requestId,
			operation: z.literal("provider_effect_result"),
			result: providerEffectResultAckSchema,
		})
		.strict(),
] as const;
export const masterAckFrameSchema = z.discriminatedUnion("operation", masterAckFrameSchemas);
const eventReplayResyncRequiredFrameSchema = z
	.object({
		type: z.literal("resync_required"),
		requestId,
		requestedAfterSeq: nonNegativeSafeInteger("requestedAfterSeq"),
		oldestAvailableSeq: nonNegativeSafeInteger("oldestAvailableSeq"),
		currentSeq: nonNegativeSafeInteger("currentSeq"),
		reason: z.enum(["replay_gap", "invalid_cursor"]),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.currentSeq < value.oldestAvailableSeq)
			context.addIssue({
				code: "custom",
				path: ["currentSeq"],
				message: "currentSeq must be at least oldestAvailableSeq",
			});
	});
const queuePageResyncRequiredFrameSchema = z
	.object({
		type: z.literal("queue_page_resync_required"),
		requestId,
		masterName,
		requestedCursor: cursor,
		currentSnapshotCutSeq: nonNegativeSafeInteger("currentSnapshotCutSeq"),
		currentQueueRevision: nonNegativeSafeInteger("currentQueueRevision"),
		reason: z.enum(["page_cursor_expired", "page_cursor_invalid", "page_revision_changed"]),
	})
	.strict();
const providerEffectFrameSchema = z
	.object({ type: z.literal("provider_effect"), effect: providerEffectLeaseSchema })
	.strict();
export const masterErrorCodes = [
	"unauthorized",
	"invalid_frame",
	"invalid_request",
	"unknown_master",
	"idempotency_conflict",
	"workdir_not_allowed",
	"channel_not_bound",
	"claim_authorization_invalid",
	"claim_authorization_expired",
	"claim_authorization_consumed",
	"claim_approval_forbidden",
	"claim_not_pending",
	"stale_effect_lease",
	"effect_result_conflict",
	"replay_gap",
	"server_unavailable",
] as const;
export type MasterErrorCode = (typeof masterErrorCodes)[number];
const masterErrorFrameSchema = z
	.object({
		type: z.literal("error"),
		requestId: z.union([requestId, z.null()]),
		code: z.enum(masterErrorCodes),
		message: reasonText,
	})
	.strict();
const pongFrameSchema = z.object({ type: z.literal("pong"), requestId, nonce }).strict();
const masterServerFrameSchemas = [
	helloFrameSchema,
	...masterEventFrameSchemas,
	masterSnapshotFrameSchema,
	subscriptionReadyFrameSchema,
	queuePageFrameSchema,
	...masterAckFrameSchemas,
	eventReplayResyncRequiredFrameSchema,
	queuePageResyncRequiredFrameSchema,
	providerEffectFrameSchema,
	masterErrorFrameSchema,
	pongFrameSchema,
] as const;
export const masterServerFrameSchema = z.union(masterServerFrameSchemas);

export type UserIngress = z.infer<typeof userIngressSchema>;
export type ProviderIngress = z.infer<typeof providerIngressSchema>;
export type LocalIngress = z.infer<typeof localIngressSchema>;
export type PresentationContent = z.infer<typeof presentationContentSchema>;
export type ProviderEffectLease = z.infer<typeof providerEffectLeaseSchema>;
export type ProviderProvisionOutcome = z.infer<typeof providerProvisionOutcomeSchema>;
export type ProviderPresentationOutcome = z.infer<typeof providerPresentationOutcomeSchema>;
export type ProviderEffectOutcome = z.infer<typeof providerEffectOutcomeSchema>;
export type TaskIngressAck = z.infer<typeof taskIngressAckSchema>;
export type ClaimAuthorizationAck = z.infer<typeof claimAuthorizationAckSchema>;
export type ClaimApprovalAck = z.infer<typeof claimApprovalAckSchema>;
export type ProviderWorkerHelloAck = z.infer<typeof providerWorkerHelloAckSchema>;
export type ProviderEffectResultAck = z.infer<typeof providerEffectResultAckSchema>;
export type AckResult = z.infer<typeof ackResultSchema>;
export type MasterClientFrame = z.infer<typeof masterClientFrameSchema>;
export type ProviderEffectResultFrame = z.infer<typeof providerEffectResultFrameSchema>;
export type MasterHelloFrame = z.infer<typeof helloFrameSchema>;
export type MasterSnapshotFrame = z.infer<typeof masterSnapshotFrameSchema>;
export type SubscriptionReadyFrame = z.infer<typeof subscriptionReadyFrameSchema>;
export type QueuePageFrame = z.infer<typeof queuePageFrameSchema>;
export type MasterAckFrame = z.infer<typeof masterAckFrameSchema>;
export type EventReplayResyncRequiredFrame = z.infer<typeof eventReplayResyncRequiredFrameSchema>;
export type QueuePageResyncRequiredFrame = z.infer<typeof queuePageResyncRequiredFrameSchema>;
export type ProviderEffectFrame = z.infer<typeof providerEffectFrameSchema>;
export type MasterErrorFrame = z.infer<typeof masterErrorFrameSchema>;
export type PongFrame = z.infer<typeof pongFrameSchema>;
export type MasterServerFrame = z.infer<typeof masterServerFrameSchema>;

export type MasterFrameDirection = "client" | "server";

export class MasterProtocolError extends Error {
	readonly code: "invalid_frame";
	constructor(message: string) {
		super(message);
		this.name = "MasterProtocolError";
		this.code = "invalid_frame";
	}
}

export function serializedMasterFrameByteLength(value: unknown): number {
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new MasterProtocolError("master frame is not serializable");
	}
	if (typeof serialized !== "string") throw new MasterProtocolError("master frame is not serializable");
	return byteLength(serialized);
}

export function assertMasterFrameSize(value: unknown): void {
	if (serializedMasterFrameByteLength(value) > MAX_MASTER_FRAME_BYTES)
		throw new MasterProtocolError("master frame exceeds 262144 UTF-8 bytes");
}

export function parseMasterClientFrame(value: unknown): MasterClientFrame {
	const result = masterClientFrameSchema.safeParse(value);
	if (!result.success) throw new MasterProtocolError("invalid master client frame");
	assertMasterFrameSize(result.data);
	return result.data;
}

export function parseMasterServerFrame(value: unknown): MasterServerFrame {
	const result = masterServerFrameSchema.safeParse(value);
	if (!result.success) throw new MasterProtocolError("invalid master server frame");
	assertMasterFrameSize(result.data);
	return result.data;
}

export function parseMasterJsonFrame(
	value: string,
	direction: MasterFrameDirection,
): MasterClientFrame | MasterServerFrame {
	if (byteLength(value) > MAX_MASTER_FRAME_BYTES)
		throw new MasterProtocolError("master frame exceeds 262144 UTF-8 bytes");
	let parsed: unknown;
	try {
		parsed = JSON.parse(value) as unknown;
	} catch {
		throw new MasterProtocolError("master frame is malformed JSON");
	}
	return direction === "client" ? parseMasterClientFrame(parsed) : parseMasterServerFrame(parsed);
}

export function serializeMasterFrame(
	value: MasterClientFrame | MasterServerFrame,
	direction?: MasterFrameDirection,
): string {
	if (direction === "client") parseMasterClientFrame(value);
	else if (direction === "server") parseMasterServerFrame(value);
	else {
		const client = masterClientFrameSchema.safeParse(value);
		if (!client.success) parseMasterServerFrame(value);
	}
	const serialized = JSON.stringify(value);
	if (typeof serialized !== "string") throw new MasterProtocolError("master frame is not serializable");
	if (byteLength(serialized) > MAX_MASTER_FRAME_BYTES)
		throw new MasterProtocolError("master frame exceeds 262144 UTF-8 bytes");
	return serialized;
}

export function safeParseMasterClientFrame(value: unknown) {
	return masterClientFrameSchema.safeParse(value);
}

export function safeParseMasterServerFrame(value: unknown) {
	return masterServerFrameSchema.safeParse(value);
}

export function isMasterEventFrame(value: unknown): value is MasterEventFrame {
	return masterEventFrameSchema.safeParse(value).success;
}

export function assertMasterEventFrame(value: unknown): asserts value is MasterEventFrame {
	if (!isMasterEventFrame(value)) throw new MasterProtocolError("invalid master event frame");
	assertMasterFrameSize(value);
}

export function assertQueueCapacityInvariant(summary: QueueStateSummary): void {
	queueStateSummarySchema.parse(summary);
}

export function assertProviderHealth(value: ProviderHealth): void {
	providerHealthSchema.parse(value);
}

export function assertSnapshot(value: MasterSnapshot): void {
	masterSnapshotSchema.parse(value);
}

export type ActiveLeaseState = "leased" | "assigned" | "terminal";
export type ActiveLeaseValue = ActiveLeaseState | { state: ActiveLeaseState };

export function assertExactActiveLeaseCount(
	activeWorkerCount: number,
	activeLeaseStates: readonly ActiveLeaseValue[],
): void {
	const computed = activeLeaseStates.filter(
		value => (typeof value === "string" ? value : value.state) !== "terminal",
	).length;
	if (activeWorkerCount !== computed) throw new MasterProtocolError("activeWorkerCount does not match active leases");
}

export const assertExactActiveWorkerCount = assertExactActiveLeaseCount;

export const parseMasterClient = parseMasterClientFrame;
export const parseMasterServer = parseMasterServerFrame;
export const encodeMasterFrame = serializeMasterFrame;
export const masterFrameSchema = masterServerFrameSchema;

export const providerHealthSchemaV1 = providerHealthSchema;
export const providerEffectLeaseSchemaV1 = providerEffectLeaseSchema;
export const providerEffectResultSchema = providerEffectResultFrameSchema;
export const masterAckFrameSchemaV1 = masterAckFrameSchema;
export const memoryActivityPayloadSchemaV1 = memoryActivityPayloadSchema;
export const MAX_FRAME_BYTES = MAX_MASTER_FRAME_BYTES;
export const MASTER_FRAME_BYTE_LIMIT = MAX_MASTER_FRAME_BYTES;

export function parseMasterFrame(
	value: string,
	direction: MasterFrameDirection,
): MasterClientFrame | MasterServerFrame {
	return parseMasterJsonFrame(value, direction);
}

export function assertMasterClientFrame(value: unknown): asserts value is MasterClientFrame {
	parseMasterClientFrame(value);
}

export function assertMasterServerFrame(value: unknown): asserts value is MasterServerFrame {
	parseMasterServerFrame(value);
}

export function isMasterClientFrame(value: unknown): value is MasterClientFrame {
	return masterClientFrameSchema.safeParse(value).success;
}

export function isMasterServerFrame(value: unknown): value is MasterServerFrame {
	return masterServerFrameSchema.safeParse(value).success;
}

export function assertProviderHealthOverlap(value: ProviderHealth, activeBindingDeliveryPending: boolean): void {
	const active = new Set(value.activeProviders);
	const degraded = new Set(value.degradedProviders);
	for (const provider of active) {
		if (degraded.has(provider) && !activeBindingDeliveryPending)
			throw new MasterProtocolError("provider health overlap requires active binding delivery degradation");
	}
}
export const sdkContractSchemas = {
	masterEventFrame: masterEventFrameSchema,
	masterClientFrame: masterClientFrameSchema,
	masterServerFrame: masterServerFrameSchema,
	providerHealth: providerHealthSchema,
	queueStateSummary: queueStateSummarySchema,
	masterSnapshot: masterSnapshotSchema,
	providerEffectLease: providerEffectLeaseSchema,
	providerEffectResult: providerEffectResultFrameSchema,
} as const;
