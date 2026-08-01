import type { AgentMessage } from "@gajae-code/agent-core";
import type { ThreadItem } from "../../../vendor/codex-app-server-schema/stable/typescript/v2/ThreadItem";
import type { Turn } from "../../../vendor/codex-app-server-schema/stable/typescript/v2/Turn";
import type { AgentSessionEvent } from "../../session/agent-session";
import { AgentMessageReducer, type WireNotification } from "../items/agent-message-reducer";
import { stableValidators } from "../protocol-source/schema-validators.generated";
import type { SessionClient, TurnPolicyOverride } from "./child-bridge";
import type { ManagedThread, ThreadRuntimeManager } from "./thread-runtime-manager";
import {
	appendProjectionRecord,
	makeTurnCreatedRecord,
	makeTurnItemCompletedRecord,
	makeTurnTerminalRecord,
	ProjectionAppendError,
	ProjectionCorruptError,
	TurnProjectionReducer,
} from "./turn-projection";

export type TurnControllerState =
	| "submitting"
	| "accepted_unpublished"
	| "durable"
	| "responded"
	| "streaming"
	| "terminal"
	| "recovery_required";

export type TurnControllerErrorCode =
	| "busy"
	| "idempotency_conflict"
	| "internal"
	| "projection_corrupt"
	| "recovery_required"
	| "model_override"
	| "turn_policy";

export class TurnControllerError extends Error {
	readonly code: TurnControllerErrorCode;
	readonly cause: unknown;

	constructor(code: TurnControllerErrorCode, message: string, cause?: unknown) {
		super(message);
		this.name = "TurnControllerError";
		this.code = code;
		this.cause = cause;
	}
}

export interface TurnStartInput {
	readonly threadId: string;
	readonly params: Readonly<Record<string, unknown>>;
}

export interface TurnStartedNotification {
	readonly method: "turn/started";
	readonly params: { readonly threadId: string; readonly turn: Turn };
}

export interface TurnCompletedNotification {
	readonly method: "turn/completed";
	readonly params: { readonly threadId: string; readonly turn: Turn };
}

export interface TokenUsageBreakdown {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cachedInputTokens: number;
	readonly cacheWriteInputTokens: number;
	readonly reasoningOutputTokens: number;
	readonly totalTokens: number;
}

export interface ThreadTokenUsage {
	readonly last: TokenUsageBreakdown;
	readonly total: TokenUsageBreakdown;
	readonly modelContextWindow: number | null;
}

export interface TokenUsageNotification {
	readonly method: "thread/tokenUsage/updated";
	readonly params: { readonly threadId: string; readonly turnId: string; readonly tokenUsage: ThreadTokenUsage };
}

export type TurnControllerNotification =
	| WireNotification
	| TurnStartedNotification
	| TurnCompletedNotification
	| TokenUsageNotification;
export type TurnNotificationEmitter = (notification: TurnControllerNotification) => void | Promise<void>;
export type TurnClock = () => number;
export type TurnIdFactory = () => string;

export interface TurnStartHandle {
	readonly response: { readonly turn: Turn };
	readonly responseDelivered: () => Promise<void>;
	readonly rollbackUndelivered: () => Promise<void>;
}

export interface TurnControllerOptions {
	readonly manager: ThreadRuntimeManager;
	readonly emit: TurnNotificationEmitter;
	readonly clock?: TurnClock;
	readonly idFactory?: TurnIdFactory;
	/** Maximum number of correlated child frames retained behind response delivery. */
	readonly barrierCapacity?: number;
}

interface PromptAck {
	readonly commandId: string;
	readonly turnId: string;
	readonly replayToken?: string;
	/** Set when reconciliation proved the accepted prompt already terminalized as failed. */
	readonly reconciledFailure?: { readonly code: string; readonly message: string };
}

interface PromptStatus {
	readonly status: string;
	readonly commandId?: string;
	readonly turnId?: string;
	readonly clientRef?: string;
	readonly error?: { readonly code: string; readonly message: string };
}

type FailedLifecycle = {
	readonly type: "agent_failed";
	readonly messages: readonly AgentMessage[];
	readonly error?: unknown;
};

type ParsedLifecycle =
	| { readonly type: "agent_start" }
	| { readonly type: "agent_end"; readonly messages: readonly AgentMessage[]; readonly stopReason?: string }
	| FailedLifecycle;

interface ParsedFrame {
	readonly commandId: string;
	readonly turnId: string;
	readonly lifecycle: ParsedLifecycle | AgentSessionEvent;
}

type ActiveTurnState = TurnControllerState | "rolled_back";

interface ActiveTurn {
	readonly threadId: string;
	readonly client: SessionClient;
	readonly managed: ManagedThread;
	readonly turn: Turn;
	readonly clientRef: string;
	readonly startedAtMs: number;
	readonly reducer: AgentMessageReducer;
	readonly projection: TurnProjectionReducer;
	commandId?: string;
	childTurnId?: string;
	replayToken?: string;
	state: ActiveTurnState;
	bufferedFrames: ParsedFrame[];
	barrierDelivered: boolean;
	rolledBack: boolean;
	terminalCommitted: boolean;
	modelOverrideRestore?: () => Promise<void>;
	failure?: TurnControllerError;
	processingTail: Promise<void>;
	responseDeliveredPromise?: Promise<void>;
	rollbackPromise?: Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function operationError(value: unknown): { readonly code?: string; readonly message?: string } | undefined {
	if (!isRecord(value)) return undefined;
	const nested = isRecord(value.error) ? value.error : undefined;
	const code = nested?.code ?? value.code ?? value.errorKey;
	const message = nested?.message ?? value.message;
	if (typeof code !== "string" && typeof message !== "string") return undefined;
	return {
		...(typeof code === "string" ? { code } : {}),
		...(typeof message === "string" ? { message } : {}),
	};
}

function unwrapOperation(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	const result = value.result;
	return isRecord(result) ? result : value;
}

function classifyPreflightCode(value: unknown): TurnControllerErrorCode | undefined {
	const code = operationError(value)?.code;
	if (!code) return undefined;
	if (code === "busy" || code === "preflight_busy" || code === "already_running" || code === "turn_in_progress")
		return "busy";
	if (code === "idempotency_conflict" || code === "client_ref_conflict") return "idempotency_conflict";
	return undefined;
}
function isExplicitOperationFailure(value: unknown): boolean {
	const candidate = unwrapOperation(value);
	return candidate?.ok === false || candidate?.error !== undefined || candidate?.accepted === false;
}

function isUncertainAckFailure(value: unknown): boolean {
	if (value instanceof TurnControllerError && value.code === "recovery_required") return true;
	const code = operationError(value)?.code;
	if (
		code === "timeout" ||
		code === "request_timeout" ||
		code === "transport_timeout" ||
		code === "connection_closed" ||
		code === "network_error"
	)
		return true;
	if (value instanceof Error)
		return /timeout|timed out|connection|transport|uncertain|lost|closed/iu.test(value.message);
	return false;
}

function errorMessage(value: unknown, fallback: string): string {
	const operation = operationError(value);
	if (operation?.message) return operation.message;
	return value instanceof Error ? value.message : fallback;
}

function textFromInput(params: Readonly<Record<string, unknown>>): string | undefined {
	if (typeof params.text === "string" && params.text.trim().length > 0) return params.text;
	const input = params.input;
	if (Array.isArray(input)) {
		const textParts: string[] = [];
		for (const item of input) {
			if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
			textParts.push(item.text);
		}
		const text = textParts.join("");
		if (text.trim().length > 0) return text;
	}
	if (isRecord(input) && input.type === "text" && typeof input.text === "string" && input.text.trim().length > 0)
		return input.text;
	return undefined;
}

function turnModelOverride(params: Readonly<Record<string, unknown>>): string | undefined {
	const topLevel = params.model;
	const topLevelModel =
		topLevel === undefined || topLevel === null
			? undefined
			: nonEmptyString(topLevel)
				? topLevel
				: (() => {
						throw new TurnControllerError(
							"model_override",
							"Turn model override must be a non-empty model reference.",
						);
					})();
	const settings = collaborationSettings(params);
	const nestedModel = settings?.model;
	const nestedModelValue =
		nestedModel === undefined || nestedModel === null
			? undefined
			: nonEmptyString(nestedModel)
				? nestedModel
				: (() => {
						throw new TurnControllerError(
							"model_override",
							"Turn collaborationMode.settings.model must be a non-empty model reference.",
						);
					})();
	if (topLevelModel !== undefined && nestedModelValue !== undefined && topLevelModel !== nestedModelValue)
		throw new TurnControllerError("model_override", "Turn model and collaborationMode model overrides must match.");
	return topLevelModel ?? nestedModelValue;
}

function hasNonNullProperty(record: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(record, key) && record[key] !== undefined && record[key] !== null;
}

const supportedTurnReasoningEfforts = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function collaborationSettings(params: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
	const collaborationMode = params.collaborationMode;
	if (collaborationMode === undefined || collaborationMode === null) return undefined;
	if (!isRecord(collaborationMode))
		throw new TurnControllerError("turn_policy", "Turn collaborationMode must be an object.");
	if (
		Object.keys(collaborationMode).some(key => key !== "mode" && key !== "settings") ||
		(hasNonNullProperty(collaborationMode, "mode") && collaborationMode.mode !== "default")
	)
		throw new TurnControllerError("turn_policy", "Turn collaborationMode.mode is unsupported.");
	const settings = collaborationMode.settings;
	if (settings === undefined || settings === null) return undefined;
	if (!isRecord(settings))
		throw new TurnControllerError("turn_policy", "Turn collaborationMode.settings must be an object.");
	if (
		Object.keys(settings).some(
			key => key !== "model" && key !== "reasoning_effort" && key !== "developer_instructions",
		)
	)
		throw new TurnControllerError("turn_policy", "Turn collaborationMode.settings contains an unsupported field.");
	if (hasNonNullProperty(settings, "model") && !nonEmptyString(settings.model))
		throw new TurnControllerError(
			"model_override",
			"Turn collaborationMode.settings.model must be a non-empty model reference.",
		);
	if (
		hasNonNullProperty(settings, "developer_instructions") &&
		(typeof settings.developer_instructions !== "string" || settings.developer_instructions.trim().length === 0)
	)
		throw new TurnControllerError(
			"turn_policy",
			"Turn collaborationMode.settings.developer_instructions is unsupported.",
		);
	if (
		hasNonNullProperty(settings, "reasoning_effort") &&
		(typeof settings.reasoning_effort !== "string" || !supportedTurnReasoningEfforts.has(settings.reasoning_effort))
	)
		throw new TurnControllerError("turn_policy", "Turn collaborationMode.settings.reasoning_effort is unsupported.");
	return settings;
}

function turnPolicyOverride(params: Readonly<Record<string, unknown>>): TurnPolicyOverride | undefined {
	const policy: {
		approvalPolicy?: "never";
		sandboxPolicy?: { type: "dangerFullAccess" };
		developerInstructions?: string;
		reasoningEffort?: string;
	} = {};
	if (hasNonNullProperty(params, "approvalPolicy")) {
		if (params.approvalPolicy !== "never")
			throw new TurnControllerError("turn_policy", "Turn approvalPolicy is unsupported by the child runtime.");
		policy.approvalPolicy = "never";
	}
	if (hasNonNullProperty(params, "sandboxPolicy")) {
		const sandboxPolicy = params.sandboxPolicy;
		if (
			!isRecord(sandboxPolicy) ||
			Object.keys(sandboxPolicy).some(key => key !== "type") ||
			sandboxPolicy.type !== "dangerFullAccess"
		)
			throw new TurnControllerError("turn_policy", "Turn sandboxPolicy is unsupported by the child runtime.");
		policy.sandboxPolicy = { type: "dangerFullAccess" };
	}
	const settings = collaborationSettings(params);
	if (settings && hasNonNullProperty(settings, "developer_instructions"))
		policy.developerInstructions = settings.developer_instructions as string;
	if (settings && hasNonNullProperty(settings, "reasoning_effort"))
		policy.reasoningEffort = settings.reasoning_effort as string;
	return Object.keys(policy).length > 0 ? policy : undefined;
}

function identityFrom(record: Record<string, unknown>, field: "commandId" | "turnId"): string | undefined {
	const aliases = field === "commandId" ? ["commandId", "command_id"] : ["turnId", "turn_id"];
	let found: string | undefined;
	for (const alias of aliases) {
		if (!Object.hasOwn(record, alias)) continue;
		const value = record[alias];
		if (!nonEmptyString(value)) return undefined;
		if (found !== undefined && found !== value) return undefined;
		found = value;
	}
	return found;
}

/** Fold every supplied identity across envelope levels; disagreement is unusable, not a fallback. */
function corroboratedIdentity(
	levels: readonly (Record<string, unknown> | undefined)[],
	field: "commandId" | "turnId",
): string | undefined {
	let agreed: string | undefined;
	for (const level of levels) {
		if (!level) continue;
		const supplied = identityFrom(level, field);
		if (supplied === undefined) {
			// An alias present but unusable at this level poisons the whole frame.
			if (identitySupplied(level, field)) return undefined;
			continue;
		}
		if (agreed !== undefined && agreed !== supplied) return undefined;
		agreed = supplied;
	}
	return agreed;
}

function identitySupplied(record: Record<string, unknown>, field: "commandId" | "turnId"): boolean {
	const aliases = field === "commandId" ? ["commandId", "command_id"] : ["turnId", "turn_id"];
	return aliases.some(alias => Object.hasOwn(record, alias));
}

function eventRecordFromFrame(frame: Record<string, unknown>): Record<string, unknown> | undefined {
	if (frame.type === "agent_start" || frame.type === "agent_end" || frame.type === "agent_failed") return frame;
	if (frame.type !== "event") return undefined;
	const payload = isRecord(frame.payload) ? frame.payload : undefined;
	if (!payload) return undefined;
	const event = isRecord(payload.event) ? payload.event : undefined;
	return event;
}

function messagesFrom(value: unknown): readonly AgentMessage[] {
	if (!Array.isArray(value)) return [];
	return value as AgentMessage[];
}

function parseLifecycle(frame: Record<string, unknown>): ParsedFrame | undefined {
	const event = eventRecordFromFrame(frame);
	if (!event || typeof event.type !== "string") return undefined;
	const payload = isRecord(frame.payload) ? frame.payload : undefined;
	// Every envelope level that supplies an identity must agree. Precedence would let a frame
	// wrapped with the active mapping smuggle another child's lifecycle payload into this turn.
	const commandId = corroboratedIdentity([frame, payload, event], "commandId");
	const turnId = corroboratedIdentity([frame, payload, event], "turnId");
	if (!commandId || !turnId) return undefined;
	switch (event.type) {
		case "agent_start":
			return { commandId, turnId, lifecycle: { type: "agent_start" } };
		case "agent_end":
			return {
				commandId,
				turnId,
				lifecycle: {
					type: "agent_end",
					messages: messagesFrom(event.messages),
					...(typeof event.stopReason === "string" ? { stopReason: event.stopReason } : {}),
				},
			};
		case "agent_failed":
			return {
				commandId,
				turnId,
				lifecycle: {
					type: "agent_failed",
					messages: messagesFrom(event.messages),
					...(Object.hasOwn(event, "error") ? { error: event.error } : {}),
				},
			};
		case "message_start":
		case "message_update":
		case "message_end":
		case "turn_start":
		case "turn_end":
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end":
		case "auto_compaction_start":
		case "auto_compaction_end":
		case "auto_retry_start":
		case "auto_retry_end":
		case "model_fallback_switched":
		case "ttsr_triggered":
		case "todo_reminder":
		case "todo_auto_clear":
		case "irc_message":
		case "subagent_steer_message":
		case "notice":
		case "thinking_level_changed":
		case "goal_updated":
			return { commandId, turnId, lifecycle: event as unknown as AgentSessionEvent };
		default:
			return undefined;
	}
}

function promptAck(value: unknown): PromptAck | undefined {
	const candidate = unwrapOperation(value);
	if (candidate?.accepted !== true) return undefined;
	if (!nonEmptyString(candidate.commandId) || !nonEmptyString(candidate.turnId)) return undefined;
	if (candidate.replayToken !== undefined && !nonEmptyString(candidate.replayToken)) return undefined;
	return {
		commandId: candidate.commandId,
		turnId: candidate.turnId,
		...(candidate.replayToken === undefined ? {} : { replayToken: candidate.replayToken }),
	};
}

function promptStatus(value: unknown): PromptStatus | undefined {
	const candidate = unwrapOperation(value);
	if (candidate?.status === undefined || typeof candidate.status !== "string") return undefined;
	const commandId = candidate.commandId;
	const turnId = candidate.turnId;
	const error = isRecord(candidate.error) ? candidate.error : undefined;
	const errorCode = error && nonEmptyString(error.code) ? error.code : undefined;
	const errorText = error && nonEmptyString(error.message) ? error.message : undefined;
	return {
		status: candidate.status,
		...(commandId === undefined ? {} : { commandId: nonEmptyString(commandId) ? commandId : undefined }),
		...(turnId === undefined ? {} : { turnId: nonEmptyString(turnId) ? turnId : undefined }),
		// Presence-aware: an absent property stays absent (legacy replies omit it), but a present yet
		// invalid value must reach the fence as a conflict rather than collapsing to "not supplied".
		...(Object.hasOwn(candidate, "clientRef")
			? { clientRef: nonEmptyString(candidate.clientRef) ? candidate.clientRef.trim() : "" }
			: {}),
		...(errorCode !== undefined && errorText !== undefined ? { error: { code: errorCode, message: errorText } } : {}),
	};
}

function turnErrorFromFailure(error: unknown): { message: string; codexErrorInfo: null; additionalDetails: null } {
	return {
		message: errorMessage(error, "The child agent failed."),
		codexErrorInfo: null,
		additionalDetails: null,
	};
}

function validateResponse(response: { readonly turn: Turn }): void {
	const validator = stableValidators.clientRequestResults["turn/start"];
	if (!validator?.(response)) throw new TurnControllerError("internal", "Turn response failed the stable validator.");
}

function validateNotification(notification: TurnControllerNotification): void {
	const validator = stableValidators.serverNotificationParams[notification.method];
	if (!validator?.(notification.params))
		throw new TurnControllerError("internal", `${notification.method} notification failed the stable validator.`);
}

function numericUsage(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function usageNotification(
	threadId: string,
	turnId: string,
	messages: readonly AgentMessage[],
): TokenUsageNotification | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const candidate = messages[index];
		if (!isRecord(candidate) || candidate.role !== "assistant" || !isRecord(candidate.usage)) continue;
		const usage = candidate.usage;
		const inputTokens = numericUsage(usage.input);
		const outputTokens = numericUsage(usage.output);
		const cachedInputTokens = numericUsage(usage.cacheRead);
		const cacheWriteInputTokens = numericUsage(usage.cacheWrite);
		const reasoningOutputTokens = numericUsage(usage.reasoningTokens);
		const observedTotal = numericUsage(usage.totalTokens);
		const totalTokens =
			observedTotal > 0 ? observedTotal : inputTokens + outputTokens + cachedInputTokens + cacheWriteInputTokens;
		const breakdown: TokenUsageBreakdown = {
			inputTokens,
			outputTokens,
			cachedInputTokens,
			cacheWriteInputTokens,
			reasoningOutputTokens,
			totalTokens,
		};
		return {
			method: "thread/tokenUsage/updated",
			params: {
				threadId,
				turnId,
				tokenUsage: { last: breakdown, total: breakdown, modelContextWindow: null },
			},
		};
	}
	return undefined;
}

function initialTurn(turnId: string, clockMs: number): Turn {
	return {
		id: turnId,
		items: [],
		itemsView: "full",
		status: "inProgress",
		error: null,
		startedAt: Math.floor(clockMs / 1000),
		completedAt: null,
		durationMs: null,
	};
}

function cloneTurn(turn: Turn): Turn {
	return structuredClone(turn);
}

export class TurnController {
	readonly #manager: ThreadRuntimeManager;
	readonly #emit: TurnNotificationEmitter;
	readonly #clock: TurnClock;
	readonly #idFactory: TurnIdFactory;
	readonly #barrierCapacity: number;
	readonly #active = new Map<string, ActiveTurn>();
	readonly #lastStates = new Map<string, TurnControllerState>();

	constructor(options: TurnControllerOptions) {
		this.#manager = options.manager;
		this.#emit = options.emit;
		this.#clock = options.clock ?? (() => Date.now());
		this.#idFactory = options.idFactory ?? (() => Bun.randomUUIDv7());
		this.#barrierCapacity = options.barrierCapacity ?? 128;
		if (!Number.isSafeInteger(this.#barrierCapacity) || this.#barrierCapacity < 1)
			throw new Error("Turn barrier capacity must be a positive safe integer.");
	}

	getState(threadId: string): TurnControllerState | undefined {
		const active = this.#active.get(threadId);
		return active?.state === "rolled_back" ? undefined : (active?.state ?? this.#lastStates.get(threadId));
	}

	get activeTurnCount(): number {
		return this.#active.size;
	}

	/** The live Codex turn id for a thread, or undefined when no turn is genuinely running. */
	activeTurnId(threadId: string): string | undefined {
		const active = this.#active.get(threadId);
		if (!active || active.state === "terminal" || active.state === "rolled_back") return undefined;
		return active.turn.id;
	}

	/**
	 * Abort the live turn through the retained child's real `turn.abort` control operation.
	 * The turn settles through the existing frame path; this only issues the request.
	 */
	async interruptTurn(threadId: string, turnId: string): Promise<void> {
		const active = this.#requireLiveTurn(threadId, turnId);
		await active.client.control("turn.abort");
	}

	/**
	 * Steer the live turn through the retained child's real `turn.steer` control operation.
	 * `expectedTurnId` is an active-turn precondition, so a stale id never steers another turn.
	 */
	async steerTurn(threadId: string, expectedTurnId: string, text: string): Promise<string> {
		const active = this.#requireLiveTurn(threadId, expectedTurnId);
		await active.client.control("turn.steer", { text });
		return active.turn.id;
	}

	#requireLiveTurn(threadId: string, turnId: string): ActiveTurn {
		const active = this.#active.get(threadId);
		if (!active || active.state === "terminal" || active.state === "rolled_back")
			throw new TurnControllerError("internal", `Thread ${threadId} has no active turn.`);
		if (active.turn.id !== turnId)
			throw new TurnControllerError("idempotency_conflict", `Turn ${turnId} is not the active turn.`);
		return active;
	}

	acceptFrame(threadId: string, frame: Record<string, unknown>): void {
		const active = this.#active.get(threadId);
		if (active) this.#ingestFrame(active, frame);
	}

	async start(input: TurnStartInput): Promise<TurnStartHandle> {
		const managed = this.#manager.get(input.threadId);
		if (!managed?.client || managed.lifecycle !== "active")
			throw new TurnControllerError("internal", `Thread ${input.threadId} is not loaded.`);
		if (managed.activeTurn || this.#active.has(input.threadId)) {
			const active = this.#active.get(input.threadId);
			if (active?.state === "recovery_required")
				throw (
					active.failure ??
					new TurnControllerError("recovery_required", `Thread ${input.threadId} requires recovery.`)
				);
			throw new TurnControllerError("busy", `Thread ${input.threadId} already has an active turn.`);
		}
		const text = textFromInput(input.params);
		if (text === undefined) throw new TurnControllerError("internal", "Turn input must contain text-capable input.");
		const turnId = this.#idFactory();
		// Persist the app-server turn id alongside the child identities for recovery.
		if (!nonEmptyString(turnId)) throw new TurnControllerError("internal", "Turn id factory returned an empty id.");
		const requestedModel = turnModelOverride(input.params);
		const requestedPolicy = turnPolicyOverride(input.params);
		let modelOverrideRestore: (() => Promise<void>) | undefined;
		try {
			if (requestedModel !== undefined) {
				if (!managed.client.setModelForTurn)
					throw new TurnControllerError(
						"model_override",
						`Model override "${requestedModel}" cannot be honoured by this child runtime.`,
					);
				try {
					modelOverrideRestore = await managed.client.setModelForTurn(requestedModel);
				} catch (error) {
					if (error instanceof TurnControllerError) throw error;
					throw new TurnControllerError(
						"model_override",
						errorMessage(error, `Model override "${requestedModel}" could not be resolved.`),
						error,
					);
				}
			}
			if (
				requestedPolicy?.sandboxPolicy !== undefined &&
				managed.effectiveSettings !== undefined &&
				(!isRecord(managed.effectiveSettings.sandbox) ||
					managed.effectiveSettings.sandbox.type !== "dangerFullAccess")
			)
				throw new TurnControllerError(
					"turn_policy",
					"Turn sandboxPolicy dangerFullAccess does not match the child runtime's effective sandbox.",
				);
			if (requestedPolicy !== undefined) {
				if (!managed.client.setTurnPolicyForTurn)
					throw new TurnControllerError(
						"turn_policy",
						"Turn policy overrides cannot be honoured by this child runtime.",
					);
				const policyRestore = await managed.client.setTurnPolicyForTurn(requestedPolicy);
				const previousRestore = modelOverrideRestore;
				modelOverrideRestore = async () => {
					let failure: unknown;
					try {
						await policyRestore();
					} catch (error) {
						failure = error;
					}
					try {
						if (previousRestore) await previousRestore();
					} catch (error) {
						failure ??= error;
					}
					if (failure !== undefined) throw failure;
				};
			}
		} catch (error) {
			try {
				await modelOverrideRestore?.();
			} catch (restoreError) {
				throw new TurnControllerError(
					"recovery_required",
					errorMessage(restoreError, "A turn override could not be restored after setup failed."),
					restoreError,
				);
			}
			if (error instanceof TurnControllerError) throw error;
			throw new TurnControllerError(
				"turn_policy",
				errorMessage(error, "Turn policy overrides could not be applied."),
				error,
			);
		}
		const startedAtMs = this.#clock();
		const turn = initialTurn(turnId, startedAtMs);
		const projection = new TurnProjectionReducer();
		const active: ActiveTurn = {
			threadId: input.threadId,
			client: managed.client,
			managed,
			turn,
			clientRef: turnId,
			startedAtMs,
			reducer: new AgentMessageReducer({ threadId: input.threadId, turnId, clock: this.#clock }),
			projection,
			state: "submitting",
			bufferedFrames: [],
			barrierDelivered: false,
			rolledBack: false,
			terminalCommitted: false,
			processingTail: Promise.resolve(),
			modelOverrideRestore,
		};
		this.#active.set(input.threadId, active);
		this.#lastStates.set(input.threadId, "submitting");
		this.#manager.setActiveTurn(input.threadId, true);

		let ack: PromptAck | undefined;
		try {
			const response = await managed.client.control(
				"turn.prompt",
				{
					text,
					clientRef: active.clientRef,
					...(requestedPolicy?.developerInstructions
						? { developerInstructions: requestedPolicy.developerInstructions }
						: {}),
				},
				{ idempotencyKey: active.clientRef, confirm: true },
			);
			const preflightCode = classifyPreflightCode(response);
			if (preflightCode !== undefined)
				throw new TurnControllerError(preflightCode, errorMessage(response, `turn.prompt ${preflightCode}.`));
			if (isExplicitOperationFailure(response) && !isUncertainAckFailure(response))
				throw new TurnControllerError("internal", errorMessage(response, "turn.prompt failed before acceptance."));

			ack = promptAck(response);
			if (!ack) throw new TurnControllerError("recovery_required", "turn.prompt acknowledgement was uncertain.");
		} catch (error) {
			const preflightCode = classifyPreflightCode(error);
			if (preflightCode !== undefined) {
				await this.#discardBeforeAcceptance(active);
				throw new TurnControllerError(preflightCode, errorMessage(error, `turn.prompt ${preflightCode}.`), error);
			}
			// A definite rejection proves no child accepted the prompt and no mapping was persisted,
			// so the admission slot must be released instead of wedging the thread in recovery.
			if (!isUncertainAckFailure(error)) {
				await this.#discardBeforeAcceptance(active);
				throw new TurnControllerError("internal", errorMessage(error, "turn.prompt failed."), error);
			}
			const reconciled = await this.#reconcileLostAck(active);
			if (!reconciled)
				throw (
					active.failure ?? new TurnControllerError("recovery_required", "Prompt acceptance is unknown.", error)
				);
			ack = reconciled;
		}
		if (!ack) throw new TurnControllerError("recovery_required", "Prompt acceptance is unknown.");
		active.commandId = ack.commandId;
		active.childTurnId = ack.turnId;
		active.replayToken = ack.replayToken;
		active.state = "accepted_unpublished";
		try {
			const createdRecord = makeTurnCreatedRecord({
				turn: cloneTurn(turn),
				commandId: ack.commandId,
				turnId: ack.turnId,
				clientRef: active.clientRef,
				...(ack.replayToken === undefined ? {} : { replayToken: ack.replayToken }),
			});
			const receipt = await appendProjectionRecord(active.client, createdRecord);
			active.projection.apply(receipt.record);
			if (active.failure === undefined) active.state = "durable";
		} catch (error) {
			this.#markRecovery(active, this.#projectionFailure(error));
			throw active.failure;
		}
		if (active.failure !== undefined) throw active.failure;

		// Reconciliation proved this accepted prompt already terminalized as failed. Persist the failed
		// terminal before releasing the slot so resume can still reconstruct the turn, then report the
		// failure rather than a start handle no caller can drive.
		if (ack.reconciledFailure) {
			try {
				await this.#finish(active, "agent_failed", [], undefined, ack.reconciledFailure);
			} catch (error) {
				// `#finish` disposes after a committed terminal, so `active.failure` may already be unset.
				const classified = this.#asControllerError(error, "internal");
				this.#markRecovery(active, classified);
				throw active.failure ?? classified;
			}
			throw new TurnControllerError("internal", ack.reconciledFailure.message);
		}

		const response = { turn: cloneTurn(turn) } as const;
		try {
			validateResponse(response);
		} catch (error) {
			this.#markRecovery(active, this.#asControllerError(error, "internal"));
			throw active.failure;
		}
		return {
			response,
			responseDelivered: () => this.#deliverResponse(active),
			rollbackUndelivered: () => this.#rollbackUndelivered(active),
		};
	}

	#ingestFrame(active: ActiveTurn, frame: Record<string, unknown>): void {
		if (this.#active.get(active.threadId) !== active || active.rolledBack || active.state === "terminal") return;
		const parsed = parseLifecycle(frame);
		if (!parsed) return;
		if (active.commandId !== undefined && active.childTurnId !== undefined && !this.#matches(active, parsed)) return;
		if (!active.barrierDelivered) {
			if (active.bufferedFrames.length >= this.#barrierCapacity) {
				this.#markRecovery(
					active,
					new TurnControllerError("recovery_required", "Turn response barrier overflowed."),
				);
				return;
			}
			active.bufferedFrames.push(parsed);
			return;
		}
		active.processingTail = active.processingTail
			.then(() => this.#processFrame(active, parsed))
			.catch(error => {
				this.#markRecovery(active, this.#asControllerError(error, "internal"));
			});
	}

	#matches(active: ActiveTurn, frame: ParsedFrame): boolean {
		return active.commandId === frame.commandId && active.childTurnId === frame.turnId;
	}

	async #deliverResponse(active: ActiveTurn): Promise<void> {
		if (active.responseDeliveredPromise !== undefined) return await active.responseDeliveredPromise;
		active.responseDeliveredPromise = (async () => {
			if (active.rolledBack || active.state === "rolled_back") return;
			if (active.state === "recovery_required")
				throw active.failure ?? new TurnControllerError("recovery_required", "Turn cannot be delivered.");
			// Seed the single FIFO processing chain with turn/started plus the buffered frames in the
			// same synchronous step that opens the barrier. Any live frame that arrives while
			// turn/started is awaiting a slow subscriber then chains strictly after the buffered set,
			// so a later terminal can never overtake an earlier observed frame.
			const buffered = active.bufferedFrames.splice(0, active.bufferedFrames.length);
			const drain = active.processingTail.then(async () => {
				const started: TurnStartedNotification = {
					method: "turn/started",
					params: { threadId: active.threadId, turn: cloneTurn(active.turn) },
				};
				validateNotification(started);
				await this.#emit(started);
				for (const frame of buffered) {
					if (!this.#matches(active, frame)) continue;
					await this.#processFrame(active, frame);
				}
			});
			active.processingTail = drain.catch(() => {});
			active.barrierDelivered = true;
			active.state = "responded";
			try {
				await drain;
				await active.processingTail;
			} catch (error) {
				// A terminal frame in the drain disposes the turn, so `active.failure` may already be
				// cleared. Surface the classified original error rather than throwing `undefined`.
				const classified = this.#asControllerError(error, "internal");
				this.#markRecovery(active, classified);
				throw active.failure ?? classified;
			}
		})();
		return await active.responseDeliveredPromise;
	}

	async #rollbackUndelivered(active: ActiveTurn): Promise<void> {
		if (active.rollbackPromise !== undefined) return await active.rollbackPromise;
		active.rollbackPromise = (async () => {
			if (active.barrierDelivered || active.rolledBack || active.state === "terminal") return;
			this.#markRecovery(
				active,
				new TurnControllerError(
					"recovery_required",
					"Turn was accepted and persisted, but its response was not delivered.",
				),
			);
		})();
		return await active.rollbackPromise;
	}

	async #processFrame(active: ActiveTurn, frame: ParsedFrame): Promise<void> {
		if (active.rolledBack || active.state === "recovery_required" || active.state === "terminal") return;
		if (!this.#matches(active, frame)) return;
		const lifecycle = frame.lifecycle;
		if (lifecycle.type === "agent_start") {
			active.state = "streaming";
			return;
		}
		if (lifecycle.type === "agent_end") {
			await this.#finish(active, "agent_end", lifecycle.messages, lifecycle.stopReason, undefined);
			return;
		}
		if (lifecycle.type === "agent_failed") {
			await this.#finish(active, "agent_failed", lifecycle.messages, undefined, lifecycle.error);
			return;
		}
		const notifications = active.reducer.accept(lifecycle);
		active.state = "streaming";
		await this.#publishReducerNotifications(active, notifications);
	}

	async #publishReducerNotifications(active: ActiveTurn, notifications: readonly WireNotification[]): Promise<void> {
		for (const notification of notifications) {
			if (notification.method === "item/completed")
				await this.#persistCompletedItem(active, notification.params.item, notification.params.completedAtMs);

			validateNotification(notification);
			await this.#emit(notification);
		}
	}

	async #persistCompletedItem(active: ActiveTurn, item: ThreadItem, completedAtMs: number): Promise<void> {
		if (!active.commandId || !active.childTurnId)
			throw new TurnControllerError("recovery_required", "Completed item has no child mapping.");
		const order = active.projection.nextItemOrder(active.turn.id);
		const record = makeTurnItemCompletedRecord(
			{ turnId: active.turn.id, item, order, completedAtMs },
			{ commandId: active.commandId, turnId: active.childTurnId },
			active.turn.id,
		);
		const receipt = await appendProjectionRecord(active.client, record);
		active.projection.apply(receipt.record);
	}

	async #finish(
		active: ActiveTurn,
		kind: "agent_end" | "agent_failed",
		messages: readonly AgentMessage[],
		stopReason: string | undefined,
		failure: unknown,
	): Promise<void> {
		if (active.terminalCommitted || active.state === "terminal" || active.state === "recovery_required") return;
		const outcomeKind =
			kind === "agent_failed"
				? "failed"
				: stopReason === undefined || stopReason === "completed"
					? "completed"
					: "interrupted";
		const itemNotifications = active.reducer.completeTurn({ kind: outcomeKind, messages });
		await this.#publishReducerNotifications(active, itemNotifications);
		if (!active.commandId || !active.childTurnId)
			throw new TurnControllerError("recovery_required", "Terminal frame has no child mapping.");
		const now = this.#clock();
		const current = active.projection.snapshot(active.turn.id);
		const terminal: Turn = {
			...current,
			status: outcomeKind,
			error: outcomeKind === "failed" ? turnErrorFromFailure(failure) : null,
			completedAt: Math.floor(now / 1000),
			durationMs: Math.max(0, now - active.startedAtMs),
		};
		const terminalRecord = makeTurnTerminalRecord(
			{ turn: terminal },
			{ commandId: active.commandId, turnId: active.childTurnId },
		);
		const receipt = await appendProjectionRecord(active.client, terminalRecord);
		active.projection.apply(receipt.record);
		active.terminalCommitted = true;
		active.state = "terminal";
		this.#manager.setActiveTurn(active.threadId, false);
		// The terminal is durably committed, so notification delivery is best effort from here.
		// Dispose in `finally` so a rejecting subscriber cannot retain a phantom active turn and
		// permanently reject later turns as busy.
		try {
			// Lifecycle notifications belong strictly after the turn/start response crossed the wire.
			// A turn terminalized before its response exists (reconciled failure) must stay durable-only:
			// publishing turn/completed here would precede both turn/started and the error response.
			if (!active.barrierDelivered) return;
			const completed: TurnCompletedNotification = {
				method: "turn/completed",
				params: { threadId: active.threadId, turn: cloneTurn(terminal) },
			};
			validateNotification(completed);
			await this.#emit(completed);
			const usage = usageNotification(active.threadId, active.turn.id, messages);
			if (usage !== undefined) {
				validateNotification(usage);
				await this.#emit(usage);
			}
		} finally {
			try {
				await this.#restoreModelOverride(active);
			} finally {
				if ((active.state as string) !== "recovery_required") this.#disposeActive(active);
			}
		}
	}

	async #reconcileLostAck(active: ActiveTurn): Promise<PromptAck | undefined> {
		let raw: unknown;
		try {
			raw = await active.client.query("turn.prompt_status", { clientRef: active.clientRef });
		} catch (error) {
			this.#markRecovery(
				active,
				new TurnControllerError("recovery_required", "Prompt acknowledgement and reconciliation were lost.", error),
			);
			return undefined;
		}
		const status = promptStatus(raw);
		if (!status || status.status === "unknown") {
			this.#markRecovery(
				active,
				new TurnControllerError("recovery_required", "Prompt acceptance is unknown after reconciliation."),
			);
			return undefined;
		}
		// The lookup was keyed by our clientRef, so a returned ref naming a different prompt means the
		// response does not describe this turn. Never bind another prompt's child identities.
		if (status.clientRef !== undefined && status.clientRef !== active.clientRef) {
			this.#markRecovery(
				active,
				new TurnControllerError("recovery_required", "Prompt reconciliation returned a foreign clientRef."),
			);
			return undefined;
		}
		// A canonical Q26 `failed` status carries `acceptedAt`, so the prompt WAS accepted and then
		// terminalized. It is not proof of non-acceptance: bind the corroborated child identities and
		// carry the failure so the turn is materialized durably instead of vanishing from history.
		if (status.status === "failed") {
			if (nonEmptyString(status.commandId) && nonEmptyString(status.turnId))
				return {
					commandId: status.commandId,
					turnId: status.turnId,
					reconciledFailure: status.error ?? { code: "prompt_failed", message: "The child prompt failed." },
				};
			this.#markRecovery(
				active,
				new TurnControllerError("recovery_required", "Failed prompt reconciliation omitted child identities."),
			);
			return undefined;
		}
		if (
			(status.status === "accepted" ||
				status.status === "in_flight" ||
				status.status === "terminal_ok" ||
				status.status === "terminal") &&
			nonEmptyString(status.commandId) &&
			nonEmptyString(status.turnId)
		)
			return { commandId: status.commandId, turnId: status.turnId };
		this.#markRecovery(
			active,
			new TurnControllerError("recovery_required", "Prompt reconciliation returned malformed child identities."),
		);
		return undefined;
	}

	#projectionFailure(error: unknown): TurnControllerError {
		if (error instanceof ProjectionCorruptError)
			return new TurnControllerError("projection_corrupt", error.message, error);
		// A conflict is a conflict whether the projection helper classified it or the bridge client
		// threw it straight through; downgrading to recovery_required hides real data divergence.
		if (error instanceof ProjectionAppendError && error.code === "idempotency_conflict")
			return new TurnControllerError("idempotency_conflict", error.message, error);
		if (operationError(error)?.code === "idempotency_conflict")
			return new TurnControllerError("idempotency_conflict", errorMessage(error, "Projection conflict."), error);
		return new TurnControllerError("recovery_required", errorMessage(error, "Durable projection failed."), error);
	}

	#asControllerError(error: unknown, fallbackCode: TurnControllerErrorCode): TurnControllerError {
		if (error instanceof TurnControllerError) return error;
		if (error instanceof ProjectionCorruptError)
			return new TurnControllerError("projection_corrupt", error.message, error);
		if (error instanceof ProjectionAppendError)
			return new TurnControllerError(
				error.code === "idempotency_conflict" ? "idempotency_conflict" : "recovery_required",
				error.message,
				error,
			);
		return new TurnControllerError(fallbackCode, errorMessage(error, "Turn processing failed."), error);
	}

	#markRecovery(active: ActiveTurn, error: TurnControllerError): void {
		if (active.state === "terminal" || active.rolledBack) return;
		active.state = "recovery_required";
		active.failure ??= error;
		active.bufferedFrames.length = 0;
	}

	async #restoreModelOverride(active: ActiveTurn): Promise<void> {
		const restore = active.modelOverrideRestore;
		if (!restore) return;
		try {
			await restore();
			active.modelOverrideRestore = undefined;
		} catch (error) {
			const failure = new TurnControllerError(
				"recovery_required",
				errorMessage(error, "The per-turn override could not be restored."),
				error,
			);
			active.state = "recovery_required";
			active.failure ??= failure;
			active.bufferedFrames.length = 0;
			this.#lastStates.set(active.threadId, "recovery_required");
			this.#manager.setActiveTurn(active.threadId, true);
			throw failure;
		}
	}

	async #discardBeforeAcceptance(active: ActiveTurn): Promise<void> {
		try {
			await this.#restoreModelOverride(active);
		} catch (error) {
			throw error instanceof TurnControllerError
				? error
				: new TurnControllerError(
						"recovery_required",
						errorMessage(error, "Turn override restoration failed."),
						error,
					);
		}
		active.rolledBack = true;
		active.state = "rolled_back";
		this.#disposeActive(active);
	}

	#disposeActive(active: ActiveTurn): void {
		if (active.state !== "rolled_back") this.#lastStates.set(active.threadId, active.state);
		if (this.#active.get(active.threadId) === active) this.#active.delete(active.threadId);
		this.#manager.setActiveTurn(active.threadId, false);
	}
}
