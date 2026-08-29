import { randomUUID } from "node:crypto";
import * as path from "node:path";
import {
	type Agent,
	type AgentSideConnection,
	type AuthenticateRequest,
	type AuthenticateResponse,
	type AuthMethod,
	type AvailableCommand,
	type CancelNotification,
	type ClientCapabilities,
	type CloseSessionRequest,
	type CloseSessionResponse,
	type DeleteSessionRequest,
	type DeleteSessionResponse,
	type ForkSessionRequest,
	type ForkSessionResponse,
	type InitializeRequest,
	type InitializeResponse,
	type ListSessionsRequest,
	type ListSessionsResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	type NewSessionRequest,
	type NewSessionResponse,
	PROTOCOL_VERSION,
	type PromptRequest,
	type PromptResponse,
	RequestError,
	type ResumeSessionRequest,
	type ResumeSessionResponse,
	type SessionInfo,
	type SessionNotification,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
	type SetSessionModeRequest,
	type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import { getAgentDir, logger } from "@gajae-code/utils";
import packageJson from "../../../package.json" with { type: "json" };
import {
	ACP_SESSION_RECONNECT,
	type AcpProviderRegistration,
	type AcpReverseConnection,
	AcpSdkAdapter,
	AcpSdkAdapterError,
	acpMcpLaunchFailure,
} from "../../sdk/acp";
import { resolveAcpFinalText } from "../../sdk/acp/final-text";
import { ACP_MCP_LIFECYCLE_TIMEOUT_MS, type SessionLifecycleMcpServer } from "../../sdk/acp/mcp";
import { ensureBroker } from "../../sdk/broker/ensure";
import { readSdkBrokerDiscovery, SdkClient, SdkClientError } from "../../sdk/client";
import type { AbortScope } from "../../sdk/host/control/operations";
import { SYNTHETIC_PROVIDER_ID } from "../../sdk/model-profile-namespace";
import type { SdkPromptTerminalOutcome } from "../../sdk/prompt-status";
import { PromptActivity, type PromptWatchdogClock, systemPromptWatchdogClock } from "../../sdk/prompt-watchdog";
import { validateRequiredPromptText } from "../../sdk/protocol/adapter-validation";
import { type SessionAttachment, SessionRouter, type SessionRouterFrame } from "../../sdk/router";
import { SessionListTraversalError, sessionListPageFromResponse, traverseSessionList } from "../../sdk/session-list";
import { resolveAcpAbortScope } from "./abort-scope";
import {
	type AgentSessionEvent,
	buildToolCallStartUpdate,
	mapAgentSessionEventToAcpSessionUpdates,
	mapAgentWireEventPayloadToAcpSessionUpdates,
} from "./acp-event-mapper";
import { resolveAcpPermissionMode } from "./permission-mode";
import type { AcpStartupOptions } from "./startup-options";
import { ACP_TERMINAL_AUTH_FLAG } from "./terminal-auth";

const ACP_DEFAULT_MODE_ID = "default";
const ACP_PLAN_MODE_ID = "plan";
const MODE_CONFIG_ID = "mode";
const MODEL_CONFIG_ID = "model";
const MODEL_PRESET_CONFIG_KEY = "modelPreset";
const ACP_CUSTOM_MODEL_PRESET = "__custom__";
const THINKING_CONFIG_ID = "thinking";
const SESSION_PAGE_SIZE = 50;
const MAX_ACP_REPLAY_PAGES = 10_000;
/** Bounded retention of settled prompt correlations so late duplicates stay closed. */
const SETTLED_PROMPT_CORRELATION_RETENTION = 16;
/**
 * A cancelled prompt must still settle. The SDK acknowledges `turn.abort` before the
 * aborted run publishes its normalized terminal, and agent-owned async work that
 * outlives the turn can keep that terminal from ever arriving. A real terminal still
 * wins inside this grace; past it ACP's mandated `cancelled` stop reason is published,
 * so the client is never left holding a turn it cannot resolve or replace.
 * Injectable in tests, never a user setting.
 */
const CANCEL_SETTLEMENT_GRACE_MS = 5_000;
/**
 * Mirrors `REQUEST_FRAME_BYTES` in `crates/gjc-sdk/src/query.rs`: the SDK WebSocket
 * server sets `max_message_size`/`max_frame_size` to 256 KiB and closes the socket on
 * an oversize frame, so an over-limit prompt must be refused before it is sent.
 */
const MAX_PROMPT_FRAME_BYTES = 256 * 1024;
/**
 * `SdkClient` wraps every control request as `{type,operation,input,id}` with a UUID
 * `id` before it reaches the socket, so the prompt must be measured inside that
 * envelope. A canonical-length UUID keeps the measurement equal to the real frame.
 */
const PROMPT_FRAME_ID_PLACEHOLDER = "00000000-0000-4000-8000-000000000000";

type JsonObject = Record<string, unknown>;
interface PromptWaiter {
	acknowledged: boolean;
	/** True once turn.prompt / skill.invoke has been sent; cancel must not fake-settle after this. */
	dispatched: boolean;

	/** Highest inbound frame sequence already observed when the prompt was acknowledged. */
	boundary: number;
	correlation: PromptCorrelation;
	messageProgress?: { textEmitted: boolean; thoughtEmitted: boolean };
	emittedAssistantText: string;
	settled: boolean;
	terminal?: { outcome: SdkPromptTerminalOutcome; correlation: PromptCorrelation };
	/** Frames for an already-settled correlation held until acknowledgement resolves ownership. */
	deferredFrames: JsonObject[];
	/** Activity frames held until acknowledgement establishes exact prompt ownership. */
	deferredActivityFrames: JsonObject[];
	/** Clock reading of the last frame proven to belong to this prompt; watchdog silence baseline. */
	lastFrameAt: number;
	/** Type of that prompt-owned frame, reported when the watchdog expires. */
	lastFrameType: string;
	/** Cancels the armed inactivity watchdog; re-armed by prompt-owned frames. */
	cancelWatchdog?: () => void;
	/** What the host is observably doing — a tool running, a model call unanswered — and the bound that follows from it. */
	activity: PromptActivity;
	/** Coordinates a prompt-control rejection racing an acknowledged ACP cancellation. */
	cancelAttempt?: Promise<boolean>;
	/** Whether ANY overlapping cancel attempt for this prompt was acknowledged:
	 *  a later failed attempt must not erase an earlier success (review thread P2). */
	cancelAcknowledged?: boolean;
	/** In-flight cancel attempts for this prompt: cancellation intent must stay
	 *  set while any attempt can still acknowledge, so a failure only clears
	 *  the shared flag when no attempt remains pending (review thread P2). */
	pendingCancelAttempts?: number;
	/** Shared resolver for cancelAttempt: ANY successful attempt resolves it
	 *  immediately (no request-order serialization), and the LAST failing
	 *  attempt resolves false (review thread P2). */
	cancelAttemptResolve?: (acknowledged: boolean) => void;
	resolve: (response: PromptResponse) => void;
	reject: (error: Error) => void;
}

type PromptCorrelation = { commandId?: string; turnId?: string };

type BrokerConnection = { adapter: AcpSdkAdapter; client: SdkClient };
type PendingAttachment = { epoch: number; task: Promise<void> };

type SessionRecord = {
	cwd: string;
	adapter: AcpSdkAdapter;
	attachment: SessionAttachment;
	closeIdempotencyKey: string;
	unsubscribe: () => void;
	reconnectUnsubscribe: () => void;
	/** Per-session frame work queue; callbacks never race prompt ownership. */
	frameTail: Promise<void>;
	/** Monotonic at WebSocket ingress, before queued work begins. */
	inboundSequence: number;
	/** Updated at ingress so a prompt acknowledgement can distinguish a steer from a fresh turn. */
	busy: boolean;
	/** Start/update args retained because tool_execution_end does not carry them. */
	toolArgs: Map<string, unknown>;
	/** Message projection state for correlationless session-scoped assistant events. */
	sessionMessageProgress?: { textEmitted: boolean; thoughtEmitted: boolean };
	/** Actionable model-profile authentication failure detected before prompt dispatch. */
	connectionId?: string;
	/** Bounded set of correlations already settled; they stay closed for publication. */
	settledPromptCorrelations: PromptCorrelation[];
	authFailure?: string;
	/** Replayable startup notice captured before ACP bootstrap; emitted once after the session id is known. */
	routingInactiveNotice?: string;
	activePrompt?: PromptWaiter;
	/** Set by `session/cancel` so an in-flight prompt settles as `cancelled`, never as an error. */
	cancelRequested?: boolean;
};

function promptWaiterRetired(record: SessionRecord, waiter: PromptWaiter): boolean {
	return waiter.settled || record.activePrompt !== waiter;
}

type BrokerSession = {
	sessionId: string;
	locator?: { repo?: string };
	live?: boolean;
	endpointGeneration?: number;
	endpointMtimeMs?: number;
	title?: string;
	updatedAt?: string;
};

function parseAcpStartupOptions(value: unknown): AcpStartupOptions | undefined {
	const candidate = object(value);
	if (!candidate) return undefined;
	const modelId = typeof candidate.modelId === "string" ? candidate.modelId : undefined;
	const modelPreset = typeof candidate.modelPreset === "string" ? candidate.modelPreset : undefined;
	const thinkingLevel = typeof candidate.thinkingLevel === "string" ? candidate.thinkingLevel : undefined;
	return modelId || modelPreset || thinkingLevel
		? {
				...(modelId ? { modelId } : {}),
				...(modelPreset ? { modelPreset } : {}),
				...(thinkingLevel ? { thinkingLevel } : {}),
			}
		: undefined;
}

/** Tests inject a virtual clock so watchdog coverage never sleeps in real time. */
function parsePromptWatchdogClock(value: unknown): PromptWatchdogClock | undefined {
	const candidate = object(value);
	return typeof candidate?.now === "function" && typeof candidate.schedule === "function"
		? (candidate as unknown as PromptWatchdogClock)
		: undefined;
}

function object(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function isAcpUnavailableSlashCommand(text: string): boolean {
	return /^\/import-session(?:\s|:|$)/u.test(text);
}

async function collectAcpSessionList(
	request: (input: JsonObject) => Promise<unknown>,
	input: JsonObject = {},
): Promise<JsonObject> {
	try {
		const pages = await traverseSessionList(
			input,
			async pageInput => {
				const response = await request(pageInput);
				const envelope = object(response);
				if (envelope?.ok === false) {
					const failure = object(envelope.error);
					throw new AcpSdkAdapterError(
						typeof failure?.code === "string" ? failure.code : "broker_error",
						typeof failure?.message === "string" ? failure.message : "session.list failed",
					);
				}
				return response;
			},
			response => sessionListPageFromResponse(response),
		);
		const aggregate: JsonObject = {};
		const sessions: unknown[] = [];
		for (const { page } of pages) {
			for (const [key, value] of Object.entries(page)) {
				if (key !== "sessions" && key !== "continuationCursor") aggregate[key] = value;
			}
			sessions.push(...page.sessions);
		}
		return { ...aggregate, sessions };
	} catch (error) {
		if (error instanceof SessionListTraversalError) throw new AcpSdkAdapterError("protocol_error", error.message);
		throw error;
	}
}

function aggregateAcpFailure(code: string, message: string, failures: unknown[]): AcpSdkAdapterError {
	const aggregate = new AggregateError(failures, message);
	return Object.assign(new AcpSdkAdapterError(code, aggregate.message), {
		cause: aggregate,
		errors: aggregate.errors,
	});
}

/** Applies ACP's offset cursor after narrowing the broker listing to the requested cwd. */
export function paginateAcpSessions(
	listed: unknown[],
	cwd: string | undefined,
	offset: number,
	sessionMetadata: ReadonlyMap<string, { title?: string; updatedAt?: string }> = new Map(),
): ListSessionsResponse {
	const filtered = listed
		.map(value => object(value) as BrokerSession | undefined)
		.filter(
			(value): value is BrokerSession & { locator: { repo: string } } =>
				typeof value?.sessionId === "string" && typeof value.locator?.repo === "string",
		)
		.filter(value => !cwd || value.locator.repo === cwd);
	const sessions = filtered.slice(offset, offset + SESSION_PAGE_SIZE).map(value => {
		const metadata = sessionMetadata.get(value.sessionId);
		const updatedAt =
			typeof metadata?.updatedAt === "string"
				? metadata.updatedAt
				: typeof value.updatedAt === "string"
					? value.updatedAt
					: typeof value.endpointMtimeMs === "number" && Number.isFinite(value.endpointMtimeMs)
						? new Date(value.endpointMtimeMs).toISOString()
						: undefined;
		return {
			sessionId: value.sessionId,
			cwd: value.locator.repo,
			title:
				typeof metadata?.title === "string" && metadata.title
					? metadata.title
					: typeof value.title === "string" && value.title
						? value.title
						: value.sessionId,
			...(updatedAt ? { updatedAt } : {}),
		} satisfies SessionInfo;
	});
	return {
		sessions,
		nextCursor: offset + sessions.length < filtered.length ? String(offset + sessions.length) : undefined,
	};
}

function sessionId(value: unknown): string {
	const candidate = object(value);
	const result = object(candidate?.result) ?? candidate;
	if (typeof result?.sessionId !== "string" || !result.sessionId)
		throw new AcpSdkAdapterError("unavailable", "SDK lifecycle response omitted a session id.");
	return result.sessionId;
}

function pageItems(value: unknown): unknown[] {
	const response = object(value);
	const result = object(response?.result) ?? response;
	const page = object(result?.page);
	return Array.isArray(page?.items) ? page.items : [];
}

/** Build the ACP command palette from the shared builtins and live SDK skill state. */
export function acpAvailableCommandsFromSkills(query: unknown): AvailableCommand[] {
	const commands = new Map<string, AvailableCommand>();
	for (const item of pageItems(query)) {
		const skill = object(item);
		if (typeof skill?.name !== "string" || !skill.name) continue;
		const name = `skill:${skill.name}`;
		if (commands.has(name)) continue;
		commands.set(name, {
			name,
			description:
				typeof skill.description === "string" && skill.description
					? skill.description
					: `Run the ${skill.name} skill`,
			input: { hint: "[request]" },
		});
	}
	return [...commands.values()];
}

function hasCorrelation(correlation: PromptCorrelation): boolean {
	return correlation.commandId !== undefined || correlation.turnId !== undefined;
}
function correlationsMatch(expected: PromptCorrelation, actual: PromptCorrelation): boolean {
	return (
		hasCorrelation(actual) &&
		(expected.commandId === undefined || expected.commandId === actual.commandId) &&
		(expected.turnId === undefined || expected.turnId === actual.turnId)
	);
}

function hasCompleteCorrelation(correlation: PromptCorrelation): correlation is { commandId: string; turnId: string } {
	return (
		typeof correlation.commandId === "string" &&
		correlation.commandId.trim().length > 0 &&
		typeof correlation.turnId === "string" &&
		correlation.turnId.trim().length > 0
	);
}

function clearPromptWatchdog(waiter: PromptWaiter): void {
	waiter.cancelWatchdog?.();
	waiter.cancelWatchdog = undefined;
}

function describeCorrelation(correlation: PromptCorrelation): string {
	return `commandId=${correlation.commandId ?? "none"} turnId=${correlation.turnId ?? "none"}`;
}

function correlationsExactlyMatch(expected: PromptCorrelation, actual: PromptCorrelation): boolean {
	return (
		hasCompleteCorrelation(expected) &&
		hasCompleteCorrelation(actual) &&
		expected.commandId === actual.commandId &&
		expected.turnId === actual.turnId
	);
}

function promptAcknowledgement(value: unknown): PromptCorrelation | undefined {
	const candidate = object(value);
	if (
		!candidate ||
		candidate.ok === false ||
		candidate.error !== undefined ||
		(candidate.accepted !== undefined && candidate.accepted !== true)
	)
		return undefined;
	const payload = object(candidate.result) ?? candidate;
	if (payload.accepted !== true) return undefined;
	if (typeof payload.commandId !== "string" || payload.commandId.trim().length === 0) return undefined;
	if (typeof payload.turnId !== "string" || payload.turnId.trim().length === 0) return undefined;
	return { commandId: payload.commandId, turnId: payload.turnId };
}

/**
 * A `session/cancel` is acknowledged ONLY by a matching-scope C04 `stopped`
 * disposition (`{ok:true, turn:"stopped", selection: <requested scope>, ...}`)
 * or by the legacy `{aborted:true}` plain-abort ack from a broker that predates
 * terminal mode. The no-effect dispositions (`no_active_turn`, `no_effect`,
 * `no_store`) and `uncertain` explicitly provide NO proof the worker was
 * stopped — the agent turn may keep running and executing tools — so accepting
 * them would settle the ACP prompt as cancelled against a live worker (review
 * thread P1). `no_active_turn` can also be a requester-ownership no-op after an
 * SDK reconnect. Anything else means the SDK did not confirm the stop and the
 * client must see an error rather than a settled turn.
 */
function isAbortAcknowledged(value: unknown, scope: AbortScope): boolean {
	const candidate = object(value);
	const result = object(candidate?.result) ?? candidate;
	if (result === undefined) return false;
	if (result.aborted === true) return true;
	return result.ok === true && result.turn === "stopped" && result.selection === scope;
}
function strictCorrelationFrom(...values: unknown[]): PromptCorrelation | undefined {
	const correlation: PromptCorrelation = {};
	let malformed = false;
	for (const value of values) {
		const candidate = object(value);
		if (!candidate) continue;
		for (const [field, aliases] of [
			["commandId", ["commandId", "command_id"]],
			["turnId", ["turnId", "turn_id"]],
		] as const) {
			for (const alias of aliases) {
				if (!Object.hasOwn(candidate, alias)) continue;
				const identity = candidate[alias];
				if (typeof identity !== "string" || identity.trim().length === 0) {
					malformed = true;
					continue;
				}
				const previous = correlation[field];
				if (previous !== undefined && previous !== identity) malformed = true;
				correlation[field] = identity;
			}
		}
	}
	return malformed ? undefined : correlation;
}

function sdkFrameCorrelation(frame: JsonObject, event?: JsonObject): PromptCorrelation | undefined {
	return strictCorrelationFrom(frame, event);
}

/**
 * Conflicting envelope/event identities own no prompt and therefore cannot
 * refresh a watchdog or publish into either turn.
 */
function watchdogCorrelationFrom(frame: JsonObject, event?: JsonObject): PromptCorrelation {
	return strictCorrelationFrom(frame, event) ?? {};
}

function logDroppedPromptTerminal(
	sessionId: string,
	event: JsonObject,
	reason: "incomplete_correlation" | "correlation_mismatch",
	actual: PromptCorrelation,
	expected?: PromptCorrelation,
): void {
	logger.error("acp_prompt_terminal_dropped", {
		sessionId,
		terminalType: event.type,
		reason,
		...(actual.commandId ? { commandId: actual.commandId } : {}),
		...(actual.turnId ? { turnId: actual.turnId } : {}),
		...(expected?.commandId ? { expectedCommandId: expected.commandId } : {}),
		...(expected?.turnId ? { expectedTurnId: expected.turnId } : {}),
	});
}

function terminalOutcome(event: JsonObject): SdkPromptTerminalOutcome | undefined {
	const outcome = object(event.outcome);
	if (!outcome) return undefined;
	if (
		outcome.kind === "stopped" &&
		(outcome.reason === "end_turn" ||
			outcome.reason === "max_tokens" ||
			outcome.reason === "max_turn_requests" ||
			outcome.reason === "refusal" ||
			outcome.reason === "cancelled") &&
		(outcome.provenance === "agent" || outcome.provenance === "client_cancel")
	)
		return outcome as SdkPromptTerminalOutcome;
	if (
		outcome.kind === "failed" &&
		(outcome.code === "prompt_failed" || outcome.code === "prompt_deadline_exceeded") &&
		typeof outcome.message === "string" &&
		(outcome.provenance === "agent_failed" || outcome.provenance === "deadline")
	)
		return outcome as SdkPromptTerminalOutcome;
	return undefined;
}

export type TranscriptReplayBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/**
 * The production transcript query exposes durable `{ body, textSummary }`
 * entries, not an ACP-shaped `content` array. Historical session JSONL has no
 * recoverable image bytes, so replay exposes that boundary rather than
 * pretending images were restored.
 */
export interface TranscriptReplayContent {
	blocks: TranscriptReplayBlock[];
	images: { available: false; reason: "historical_transcript_images_unavailable" };
}

/** Machine-readable reason replay could not restore a transcript entry. */
export type TranscriptReplaySkipReason = "transcript_body_unavailable" | "transcript_tool_call_unavailable";

/**
 * Replay decides per entry. An entry whose production body is missing is not
 * replayable, and the caller reports that boundary instead of failing the whole
 * load; fabricating an empty body would replay a message that never existed.
 */
export type TranscriptReplayEntry =
	| { replayable: true; content: TranscriptReplayContent }
	| { replayable: false; reason: TranscriptReplaySkipReason };

export function transcriptReplayContent(entry: unknown): TranscriptReplayEntry {
	const record = object(entry);
	if (typeof record?.body !== "string") return { replayable: false, reason: "transcript_body_unavailable" };
	return {
		replayable: true,
		content: {
			blocks: record.body.length > 0 ? [{ type: "text", text: record.body }] : [],
			images: { available: false, reason: "historical_transcript_images_unavailable" },
		},
	};
}

/**
 * `transcript.list` answers an entry larger than one page with a body-less row
 * `{ id, error: { code: "item_too_large" }, continuations }`. Each continuation is a
 * `Q23` (`resource.body`) descriptor for one indexed string field of that entry, so
 * the row is a pointer to the largest message in the session rather than a broken
 * entry. Replay follows it instead of dropping the message.
 */
export interface TranscriptContinuation {
	query: string;
	resourceKind: string;
	resourceId: string;
	revision: string;
	itemId: string;
	field: string;
}

/** Fields replay consumes; `textSummary` and the rest stay unread so recovery costs one query per used field. */
const RECOVERABLE_TRANSCRIPT_FIELDS = ["role", "body", "content", "toolCallId", "toolName", "isError"] as const;

/** Stands in for a tool result whose transcript entry replay could not restore. */
const TRANSCRIPT_TOOL_RESULT_UNAVAILABLE = "The transcript entry holding this tool result could not be replayed.";

/** Stands in for a tool call the transcript never recorded a result for. */
const TRANSCRIPT_TOOL_CALL_UNRESOLVED = "The session transcript ends without a result for this tool call.";

/** Stands in for a tool call replay abandoned before it could read back a result. */
const TRANSCRIPT_REPLAY_INTERRUPTED = "Transcript replay stopped before this tool call reached a result.";

/**
 * The published tool calls a replay cleanup pass could not close, with the frame failures
 * that refused them. `#replaySession` reads `unclosedToolCallIds` to name every stranded
 * call in the `session/load` rejection, so a close that could not happen is reported to the
 * caller instead of being discarded with the session record.
 */
interface UnclosedReplayToolCalls {
	unclosedToolCallIds: string[];
	failures: unknown[];
}
function decodeTranscriptContinuation(field: string, body: string): unknown {
	if (field !== "content" && field !== "isError") return body;
	try {
		const value: unknown = JSON.parse(body);
		if (field === "content") return Array.isArray(value) ? value : undefined;
		return typeof value === "boolean" ? value : undefined;
	} catch {
		return undefined;
	}
}

export function transcriptContinuations(entry: unknown): TranscriptContinuation[] {
	const record = object(entry);
	if (!Array.isArray(record?.continuations)) return [];
	const descriptors: TranscriptContinuation[] = [];
	for (const value of record.continuations) {
		const candidate = object(value);
		if (
			typeof candidate?.query !== "string" ||
			typeof candidate.resourceKind !== "string" ||
			typeof candidate.resourceId !== "string" ||
			typeof candidate.revision !== "string" ||
			typeof candidate.itemId !== "string" ||
			typeof candidate.field !== "string"
		)
			continue;
		descriptors.push({
			query: candidate.query,
			resourceKind: candidate.resourceKind,
			resourceId: candidate.resourceId,
			revision: candidate.revision,
			itemId: candidate.itemId,
			field: candidate.field,
		});
	}
	return descriptors;
}

type ReceivedSdkEvent = {
	event: JsonObject;
	/** Event payload accepted by the ACP event mapper, when this is an agent-wire frame. */
	wirePayload?: JsonObject;
};

/**
 * Native session hosts emit `activity` directly; test-only/legacy adapters may
 * wrap agent-wire events in `{ type: "event", payload }`. Normalize both
 * without treating notification-specific frames as agent lifecycle truth.
 */
function receivedSdkEvent(frame: JsonObject): ReceivedSdkEvent | undefined {
	if (frame.type === "activity") return undefined;
	if (frame.type === "agent_start" || frame.type === "agent_end" || frame.type === "agent_failed")
		return { event: frame };
	if (frame.type !== "event") return undefined;
	const payload = object(frame.payload);
	if (!payload) return undefined;
	const replayPayload = object(payload.payload);
	const event = object(payload.event) ?? replayPayload ?? payload;
	if (typeof event.type !== "string") return undefined;
	return {
		event,
		...(object(payload.event) ? { wirePayload: payload } : {}),
	};
}

const ROUTER_PASSTHROUGH_FRAME_TYPES = new Set([
	"hello",
	"server_hello",
	"reverse_request",
	"reverse_response",
	"reverse_cancel",
	"reverse_request_cancel",
	"reverse_request_cancelled",
]);

function acpFrameFromRouted(frame: SessionRouterFrame): JsonObject {
	if (
		frame.body.type === "activity" ||
		frame.body.type === "agent_start" ||
		frame.body.type === "agent_end" ||
		frame.body.type === "agent_failed"
	)
		return frame.body;
	if (typeof frame.body.type === "string" && ROUTER_PASSTHROUGH_FRAME_TYPES.has(frame.body.type)) return frame.body;
	const connectionId = typeof frame.body.connectionId === "string" ? frame.body.connectionId : undefined;
	return {
		type: "event",
		...(frame.name === undefined ? {} : { kind: frame.name }),
		...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
		...(frame.commandId === undefined ? {} : { commandId: frame.commandId }),
		...(frame.turnId === undefined ? {} : { turnId: frame.turnId }),
		...(connectionId === undefined ? {} : { connectionId }),
		payload: frame.body,
	};
}

/**
 * Author of the message a `message_start`/`message_end` frame carries. The host echoes the
 * user prompt and every tool result back through the same events, so only `"assistant"`
 * proves a model call answered.
 */
function frameMessageRole(event: JsonObject | undefined): string | undefined {
	const role = object(event?.message)?.role;
	return typeof role === "string" ? role : undefined;
}

const ACP_CONFIG_OPTIONS = [
	{ id: MODEL_CONFIG_ID, name: "Model", category: "model", options: [] },
	{ id: THINKING_CONFIG_ID, name: "Thinking", category: "thought_level", options: [] },
	{
		id: "steeringMode",
		name: "Steering queue",
		options: [
			{ value: "all", name: "All" },
			{ value: "one-at-a-time", name: "One at a time" },
		],
	},
	{
		id: "followUpMode",
		name: "Follow-up queue",
		options: [
			{ value: "all", name: "All" },
			{ value: "one-at-a-time", name: "One at a time" },
		],
	},
	{
		id: "interruptMode",
		name: "Interrupt mode",
		options: [
			{ value: "immediate", name: "Immediate" },
			{ value: "wait", name: "Wait" },
		],
	},
] as const;

const ACP_CONFIG_CONTROL_OPERATIONS: Record<string, string> = {
	steeringMode: "queue.steering_mode.set",
	followUpMode: "queue.follow_up_mode.set",
	interruptMode: "queue.interrupt_mode.set",
};

function configValues(query: unknown): Map<string, string> {
	const values = new Map<string, string>();
	for (const item of pageItems(query)) {
		const record = object(item);
		if (!record) continue;
		if (typeof record.id === "string" && typeof record.value === "string") {
			values.set(record.id, record.value);
			continue;
		}
		for (const [id, value] of Object.entries(record)) {
			if (typeof value === "string") values.set(id, value);
		}
	}
	return values;
}

function modelPresetConfigOptions(query: unknown, current: string): { value: string; name: string }[] {
	const options = new Map<string, string>();
	for (const item of pageItems(query)) {
		const profile = object(item);
		if (!profile || typeof profile.id !== "string") continue;
		if (profile.available === false && profile.id !== current) continue;
		options.set(profile.id, typeof profile.displayName === "string" ? profile.displayName : profile.id);
	}
	if (current === ACP_CUSTOM_MODEL_PRESET) options.set(ACP_CUSTOM_MODEL_PRESET, "Custom (current model)");
	else if (!options.has(current)) options.set(current, current);
	return [...options].map(([value, name]) => ({ value, name }));
}

function modelConfigOptions(
	query: unknown,
	current: string | undefined,
	activeProviders?: ReadonlySet<string>,
): { value: string; name: string }[] {
	const options = new Map<string, string>();
	for (const item of pageItems(query)) {
		const model = object(item);
		if (!model || typeof model.provider !== "string" || typeof model.id !== "string") continue;
		// The reserved `gajae-code` namespace is a logical facade, not a real
		// active provider: the Q10 projection already availability-filters the
		// synthetic rows, so the Q29 provider filter must not drop them.
		if (
			activeProviders !== undefined &&
			model.provider !== SYNTHETIC_PROVIDER_ID &&
			!activeProviders.has(model.provider)
		)
			continue;
		const value = `${model.provider}/${model.id}`;
		options.set(value, typeof model.name === "string" ? model.name : value);
	}
	if (current && !options.has(current)) options.set(current, current);
	return [...options].map(([value, name]) => ({ value, name }));
}
const MAX_ACTIVE_PROVIDER_PAGES = 100;

/**
 * Unsupported-query compatibility fallback. Session hosts without
 * `providers.list/active` reject the unknown named query as either
 * `operation_not_session_owned` (host knows the registry but not the query)
 * or `invalid_request` (pre-Q29 host that predates the registry entry). Both
 * keep the full catalog authoritative on the first page; every other failure
 * mode fails closed so the active-provider contract is never silently
 * widened.
 */
function isUnsupportedQueryError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		((error as { code?: unknown }).code === "operation_not_session_owned" ||
			(error as { code?: unknown }).code === "invalid_request")
	);
}

function queryPage(query: unknown): { items?: unknown; complete?: unknown; continuationCursor?: unknown } | undefined {
	const response = object(query);
	const result = object(response?.result) ?? response;
	return object(result?.page);
}

/**
 * Collect every page of `providers.list/active` (Q29, GJC >= 0.12.8) and
 * return the providers with usable stored credentials or credentialless
 * connection kinds, mirroring the TUI model picker's
 * `modelRegistry.getAvailable()`. The openwebui-gjc-adapter applies the same
 * filter to `/v1/models`. Q29 pages are byte-bounded and can span multiple
 * pages when custom provider ids inflate the payload, so all pages are
 * consumed before the provider set is built. Returns undefined only when the
 * session host rejects the query with `operation_not_session_owned`; any
 * other query failure or malformed page is thrown.
 */
export async function collectActiveProviderIds(
	adapter: Pick<AcpSdkAdapter, "query">,
): Promise<ReadonlySet<string> | undefined> {
	const providers = new Set<string>();
	let cursor: string | undefined;
	for (let pageCount = 0; pageCount < MAX_ACTIVE_PROVIDER_PAGES; pageCount++) {
		let response: unknown;
		try {
			response = await adapter.query("providers.list/active", {}, cursor);
		} catch (error) {
			if (cursor === undefined && isUnsupportedQueryError(error)) return undefined;
			throw error;
		}
		const page = queryPage(response);
		if (!page) throw new AcpSdkAdapterError("protocol_error", "providers.list/active returned no page.");
		const items = page.items;
		if (!Array.isArray(items))
			throw new AcpSdkAdapterError("protocol_error", "providers.list/active returned a malformed page.");
		for (const item of items) {
			const record = object(item);
			if (!record || typeof record.provider !== "string") continue;
			const connectionKind = record.connectionKind;
			if (connectionKind === "credential" || connectionKind === "credentialless") providers.add(record.provider);
		}
		if (page.complete === true) return providers;
		if (typeof page.continuationCursor !== "string")
			throw new AcpSdkAdapterError(
				"protocol_error",
				"providers.list/active page is incomplete without a continuation cursor.",
			);
		cursor = page.continuationCursor;
	}
	throw new AcpSdkAdapterError("protocol_error", "providers.list/active exceeded the page budget.");
}
const MAX_MODEL_CATALOG_PAGES = 100;

/**
 * Validate one `models.list/current` response and return its page. The SDK pages
 * Q10 at a fixed byte target (256 KiB), which a fully configured catalog can
 * exceed, so every page shape failure fails closed instead of silently dropping
 * models the active-provider filter would need.
 */
interface ModelCatalogPage {
	items: unknown[];
	complete?: unknown;
	continuationCursor?: unknown;
}

function requireCatalogPage(response: unknown): ModelCatalogPage {
	const page = queryPage(response);
	if (!page) throw new AcpSdkAdapterError("protocol_error", "models.list/current returned no page.");
	if (!Array.isArray(page.items))
		throw new AcpSdkAdapterError("protocol_error", "models.list/current returned a malformed page.");
	return page as ModelCatalogPage;
}

async function collectModelCatalogContinuation(
	adapter: Pick<AcpSdkAdapter, "query">,
	firstPage: ModelCatalogPage,
): Promise<unknown[]> {
	if (firstPage.complete === true) return [];
	if (typeof firstPage.continuationCursor !== "string")
		throw new AcpSdkAdapterError(
			"protocol_error",
			"models.list/current page is incomplete without a continuation cursor.",
		);
	let cursor: string | undefined = firstPage.continuationCursor;
	const items: unknown[] = [];
	// Page 1 was already consumed by the caller, so the remaining budget is one shorter.
	for (let pageCount = 1; pageCount < MAX_MODEL_CATALOG_PAGES; pageCount++) {
		const response = await adapter.query("models.list/current", {}, cursor);
		const page = requireCatalogPage(response);
		items.push(...page.items);
		if (page.complete === true) return items;
		if (typeof page.continuationCursor !== "string")
			throw new AcpSdkAdapterError(
				"protocol_error",
				"models.list/current page is incomplete without a continuation cursor.",
			);
		cursor = page.continuationCursor;
	}
	throw new AcpSdkAdapterError("protocol_error", "models.list/current exceeded the page budget.");
}

/**
 * Collect the model catalog (Q10) and the active-provider set (Q29) under one
 * credential ordering. Assembling the first Q10 page is what finalizes host-side
 * credential state — expired or invalid OAuth credentials are refreshed or
 * disabled while that snapshot is built, and continuation pages replay the
 * frozen revision without further side effects — so Q29 must not start until
 * page 1 has resolved. Starting both together would let Q29 snapshot pre-refresh
 * credential state and mix catalog rows and provider availability from different
 * credential states. After page 1, the provider walk overlaps the remaining
 * catalog pages instead of adding its latency after them.
 */
export async function collectModelCatalogAndActiveProviders(
	adapter: Pick<AcpSdkAdapter, "query">,
): Promise<{ modelCatalog: unknown; activeProviders: ReadonlySet<string> | undefined }> {
	const firstResponse = await adapter.query("models.list/current");
	const firstPage = requireCatalogPage(firstResponse);
	const [remaining, activeProviders] = await Promise.all([
		collectModelCatalogContinuation(adapter, firstPage),
		collectActiveProviderIds(adapter),
	]);
	return {
		modelCatalog: { result: { page: { items: [...firstPage.items, ...remaining] } } },
		activeProviders,
	};
}

const THINKING_CONFIG_OPTIONS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(value => ({
	value,
	name: value,
}));

/** Maps live canonical SDK config and the selected model catalog into the ACP 1.2.1 session state surface. */
export function acpSessionStateFromConfig(
	query: unknown,
	modelCatalogQuery?: unknown,
	modelPreset?: string,
	activeProviders?: ReadonlySet<string>,
) {
	const values = configValues(query);
	const useModelPresets = modelPreset !== undefined;
	const currentModeId = values.get(MODE_CONFIG_ID) === ACP_PLAN_MODE_ID ? ACP_PLAN_MODE_ID : ACP_DEFAULT_MODE_ID;
	return {
		configOptions: [
			{
				id: MODE_CONFIG_ID,
				name: "Mode",
				category: "mode" as const,
				type: "select" as const,
				currentValue: currentModeId,
				options: [
					{ value: ACP_DEFAULT_MODE_ID, name: "Default" },
					{ value: ACP_PLAN_MODE_ID, name: "Plan" },
				],
			},
			...ACP_CONFIG_OPTIONS.flatMap(option => {
				const value =
					option.id === MODEL_CONFIG_ID && useModelPresets
						? (values.get(MODEL_PRESET_CONFIG_KEY) ?? ACP_CUSTOM_MODEL_PRESET)
						: values.get(option.id);
				if (value === undefined) return [];
				const options =
					option.id === MODEL_CONFIG_ID
						? useModelPresets
							? modelPresetConfigOptions(modelCatalogQuery, value)
							: modelConfigOptions(modelCatalogQuery, value, activeProviders)
						: option.id === THINKING_CONFIG_ID
							? THINKING_CONFIG_OPTIONS
							: [...option.options];
				return [
					{
						...option,
						...(option.id === MODEL_CONFIG_ID && useModelPresets ? { name: "Preset" } : {}),
						type: "select" as const,
						currentValue: value,
						options,
					},
				];
			}),
		],
		modes: {
			availableModes: [
				{ id: ACP_DEFAULT_MODE_ID, name: "Default" },
				{ id: ACP_PLAN_MODE_ID, name: "Plan" },
			],
			currentModeId,
		},
	};
}

/** Recognize a canonical ACP skill command only when it is the complete, single text prompt. */
export function acpSkillInvocation(blocks: PromptRequest["prompt"]): { name: string; args: string } | undefined {
	if (blocks.length !== 1 || blocks[0]?.type !== "text") return undefined;
	const match = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(blocks[0].text.trim());
	if (!match?.[1]) return undefined;
	return { name: match[1], args: match[2]?.trim() ?? "" };
}

/** Convert every ACP prompt block the agent advertises without silently discarding context. */
export function acpPromptPayload(blocks: PromptRequest["prompt"]): {
	text: string;
	images: Array<{ data: string; mimeType: string }>;
} {
	const text: string[] = [];
	const images: Array<{ data: string; mimeType: string }> = [];
	for (const block of blocks) {
		switch (block.type) {
			case "text":
				text.push(block.text);
				break;
			case "image":
				images.push({ data: block.data, mimeType: block.mimeType });
				break;
			case "resource_link":
				text.push(
					[
						`[Resource: ${block.name}]`,
						`URI: ${block.uri}`,
						...(block.title ? [`Title: ${block.title}`] : []),
						...(block.description ? [block.description] : []),
						...(block.mimeType ? [`MIME: ${block.mimeType}`] : []),
						...(typeof block.size === "number" ? [`Size: ${block.size}`] : []),
					].join("\n"),
				);
				break;
			case "resource": {
				const resource = block.resource;
				if ("text" in resource) {
					text.push(
						[
							`[Resource: ${resource.uri}]`,
							...(resource.mimeType ? [`MIME: ${resource.mimeType}`] : []),
							resource.text,
						].join("\n"),
					);
					break;
				}
				const mimeType = resource.mimeType ?? "application/octet-stream";
				if (!mimeType.startsWith("image/"))
					throw new AcpSdkAdapterError(
						"unsupported_content",
						`Unsupported embedded resource MIME type: ${mimeType}`,
					);
				images.push({ data: resource.blob, mimeType });
				break;
			}
			case "audio":
				throw new AcpSdkAdapterError("unsupported_content", "ACP audio prompts are not supported.");
			default:
				throw new AcpSdkAdapterError("unsupported_content", "Unsupported ACP prompt content.");
		}
	}
	if (text.length === 0 && images.length === 0)
		throw new AcpSdkAdapterError("invalid_input", "Prompt must not be empty.");
	return { text: text.join("\n"), images };
}

/**
 * `AcpSdkAdapterError.code` is an internal string, but the SDK only derives a
 * JSON-RPC code from a `RequestError`. Everything else collapses to an opaque
 * `-32603 Internal error`, which hides the reason and defeats client-side
 * recovery (an ACP client cannot see that it must authenticate). Map the codes
 * that have a defined ACP/JSON-RPC counterpart onto a real `RequestError`.
 */
export function acpRequestFailure(error: unknown): unknown {
	const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
	if (typeof code !== "string") return error;
	const message = error instanceof Error ? error.message : code;
	switch (code) {
		case "authentication_failed":
			return RequestError.authRequired({ code, details: message }, message);
		// `not_found` stays -32603 with its discriminator in `data`: ACP's
		// `resourceNotFound` (-32002) is a URI-addressed resource error, and an unknown
		// session id is not a resource URI. Pinned ACP core-v1 conformance also requires
		// -32603/-32000 for a prompt against an unknown session.
		case "invalid_input":
		case "unsupported":
		case "unsupported_content":
			return RequestError.invalidParams({ code, details: message }, message);
		default:
			// The remaining internal codes (conflict, unavailable, busy, …) have no ACP
			// counterpart and stay -32603. Keep the discriminator in `data` so a client can
			// branch on retry/reconnect instead of parsing an English message.
			return RequestError.internalError({ code, details: message }, message);
	}
}

/**
 * Registers the permission reverse channel whenever a form-less client needs
 * to answer selector asks. The permission mode (prompt vs allow) only gates
 * tool-authorization prompts via `permission_mode.set`; workflow questions
 * still need a channel, so form-less clients always get the permission
 * capability and the bus installs the permission-backed ask source on it.
 */
export function acpProviderRegistrations(
	capabilities: ClientCapabilities | undefined,
	env: NodeJS.ProcessEnv = process.env,
): AcpProviderRegistration[] {
	return [
		// `fs.readTextFile` and `fs.writeTextFile` are independently optional, so the
		// advertised methods travel with the lease instead of being inferred as both.
		...(capabilities?.fs?.readTextFile || capabilities?.fs?.writeTextFile
			? [
					{
						capability: "fs",
						definitions: [
							...(capabilities.fs.readTextFile ? [{ name: "fs.readTextFile" }] : []),
							...(capabilities.fs.writeTextFile ? [{ name: "fs.writeTextFile" }] : []),
						],
					},
				]
			: []),
		...(capabilities?.terminal ? [{ capability: "terminal", definitions: [] }] : []),
		...(resolveAcpPermissionMode(capabilities, env) === "prompt" || !capabilities?.elicitation?.form
			? [{ capability: "permission", definitions: [] }]
			: []),
		...(capabilities?.elicitation?.form ? [{ capability: "ui", definitions: [] }] : []),
	];
}

export function createAcpReverseConnection(connection: AgentSideConnection, sessionId: string): AcpReverseConnection {
	const methods: Record<string, string> = {
		request: "session/request_permission",
		"permission.request": "session/request_permission",
		"fs.readTextFile": "fs/read_text_file",
		"fs.writeTextFile": "fs/write_text_file",
		"terminal.create": "terminal/create",
		"ui.elicit": "elicitation/create",
	};
	return {
		request: async (
			method: string,
			params: JsonObject,
			options?: { cancellationSignal?: AbortSignal },
		): Promise<unknown> => {
			const name = methods[method];
			if (!name)
				throw new AcpSdkAdapterError("acp_reverse_unavailable", `ACP reverse method is unavailable: ${method}`);
			const rawRequest = (connection as unknown as Record<string, unknown>).request;
			if (typeof rawRequest !== "function")
				throw new AcpSdkAdapterError("acp_reverse_unavailable", "ACP reverse request surface is unavailable.");
			const result = await (
				rawRequest as (
					method: string,
					input: JsonObject,
					options?: { cancellationSignal?: AbortSignal },
				) => Promise<unknown>
			).call(connection, name, { ...params, sessionId }, options);
			// ACP clients answer `session/request_permission` with the spec-shaped
			// `RequestPermissionResponse` `{ outcome: { outcome, optionId } }`, while the
			// SDK permission-provider contract is the flat decision `{ outcome, optionId }`.
			// Normalize the outer wrapper (accepting the flat legacy shape as well) so
			// permission-gated tool calls resolve instead of failing as an invalid response.
			const response = object(result);
			if (name === "session/request_permission" && response) {
				const decision = object(response.outcome) ?? response;
				if (decision.outcome === "cancelled") return { outcome: "cancelled" };
				if (decision.outcome === "selected" && typeof decision.optionId === "string")
					return { outcome: "selected", optionId: decision.optionId };
			}
			return result;
		},
	};
}

/** Maps ACP permission handling to the session's canonical SDK policy. */
export async function applyAcpPermissionMode(
	adapter: Pick<AcpSdkAdapter, "control">,
	capabilities: ClientCapabilities | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const mode = resolveAcpPermissionMode(capabilities, env);
	await adapter.control("permission_mode.set", { mode: mode === "prompt" ? "prompt" : "allow" });
}

/** Applies CLI-provided ACP startup settings through SDK controls before session exposure. */
export async function applyAcpStartupOptions(
	adapter: Pick<AcpSdkAdapter, "setModel" | "control">,
	options: AcpStartupOptions | undefined,
): Promise<void> {
	if (options?.modelId) await adapter.setModel(options.modelId);
	if (options?.thinkingLevel) await adapter.control("thinking.set", { level: options.thinkingLevel });
}

/**
 * ACP is a pure SDK client. Session processes are created and resumed by the
 * broker, while all per-session operations use that session's authenticated SDK
 * endpoint. This class deliberately imports neither AgentSession nor any local
 * runtime host component.
 */
export class AcpAgent implements Agent {
	readonly #connection: AgentSideConnection;
	readonly #agentDir: string;
	readonly #router: SessionRouter;
	readonly #pendingRouterAdapters = new Map<string, AcpSdkAdapter>();
	readonly #pendingRouterFrames = new Map<string, Record<string, unknown>[]>();
	#routerStartPromise: Promise<void> | undefined;
	readonly #sessions = new Map<string, SessionRecord>();
	readonly #attaching = new Map<string, PendingAttachment>();
	readonly #resolvingExisting = new Map<string, PendingAttachment>();
	readonly #knownSessionCwds = new Map<string, string>();
	/**
	 * Sessions this connection actually owns, i.e. ones it created or attached to.
	 * Destructive lifecycle control gates on this set, never on `#knownSessionCwds`.
	 *
	 * `session/list` legitimately populates `#knownSessionCwds` for every session a
	 * shared broker reports, so treating that map as ownership let a second ACP
	 * connection enumerate another connection's sessions and then close or delete
	 * them. Knowing a session's cwd is not authority over its lifecycle.
	 */
	readonly #ownedSessionIds = new Set<string>();
	readonly #knownSessionMcpServers = new Map<string, SessionLifecycleMcpServer[]>();
	readonly #knownSessionMetadata = new Map<string, { title?: string; updatedAt?: string }>();
	readonly #pendingDeleteLocators = new Map<string, { cwd: string; path: string }>();
	readonly #pendingCloseIdempotencyKeys = new Map<string, string>();
	readonly #sessionEpochs = new Map<string, number>();
	readonly #tearingDown = new Map<string, number>();
	readonly #lifecycleOperations = new Map<string, Promise<void>>();
	#clientCapabilities: ClientCapabilities | undefined;
	#broker: Promise<BrokerConnection> | undefined;
	readonly #startupOptions: AcpStartupOptions | undefined;
	readonly #cancelSettlementGraceMs: number;
	readonly #promptWatchdogClock: PromptWatchdogClock;
	#disposed = false;
	#disposePromise: Promise<void> | undefined;

	constructor(
		connection: AgentSideConnection,
		options?:
			| {
					agentDir?: string;
					startupOptions?: AcpStartupOptions;
					cancelSettlementGraceMs?: number;
					promptWatchdogClock?: PromptWatchdogClock;
			  }
			| unknown,
	) {
		this.#connection = connection;
		const candidate = object(options);
		this.#agentDir = typeof candidate?.agentDir === "string" ? candidate.agentDir : getAgentDir();
		this.#router = new SessionRouter({
			agentDir: this.#agentDir,
			deps: {
				onAttachment: attachment => {
					const record = this.#sessions.get(attachment.sessionId);
					const adapter = record?.adapter ?? this.#pendingRouterAdapters.get(attachment.sessionId);
					if (!adapter) return;
					if (record) record.attachment = attachment;
					adapter.acceptAttachment(attachment);
				},
				onAttachmentReady: async attachment => {
					const record = this.#sessions.get(attachment.sessionId);
					const adapter = record?.adapter ?? this.#pendingRouterAdapters.get(attachment.sessionId);
					if (!adapter) return;
					if (record) record.attachment = attachment;
					await adapter.attachmentReady(attachment);
				},
				onFrame: (attachment, frame) => {
					const acpFrame = acpFrameFromRouted(frame);
					const adapter =
						this.#sessions.get(attachment.sessionId)?.adapter ??
						this.#pendingRouterAdapters.get(attachment.sessionId);
					if (adapter) adapter.acceptFrame(acpFrame);
					else this.#pendingRouterFrames.get(attachment.sessionId)?.push(acpFrame);
				},
				onSessionRemoved: attachment => {
					const adapter =
						this.#sessions.get(attachment.sessionId)?.adapter ??
						this.#pendingRouterAdapters.get(attachment.sessionId);
					adapter?.revokeAttachment(attachment);
				},
			},
		});
		this.#startupOptions = parseAcpStartupOptions(candidate?.startupOptions);
		this.#cancelSettlementGraceMs =
			typeof candidate?.cancelSettlementGraceMs === "number" &&
			Number.isSafeInteger(candidate.cancelSettlementGraceMs)
				? candidate.cancelSettlementGraceMs
				: CANCEL_SETTLEMENT_GRACE_MS;
		this.#promptWatchdogClock = parsePromptWatchdogClock(candidate?.promptWatchdogClock) ?? systemPromptWatchdogClock;
		queueMicrotask(() => {
			if (connection.signal.aborted) {
				this.#beginDispose();
			} else {
				connection.signal.addEventListener("abort", () => this.#beginDispose(), { once: true });
			}
		});
	}

	async initialize(params: InitializeRequest): Promise<InitializeResponse> {
		this.#clientCapabilities = params.clientCapabilities;
		const authMethods: AuthMethod[] = [
			{
				id: "agent",
				name: "Use existing local credentials",
				description: "Authenticate via the provider keys/OAuth state already configured under ~/.gjc.",
			},
		];
		if (params.clientCapabilities?.auth?.terminal === true) {
			authMethods.push({
				type: "terminal",
				id: "terminal",
				name: "Set up Gajae Code in terminal",
				description: "Launch the gjc TUI to add provider keys and select models.",
				args: [ACP_TERMINAL_AUTH_FLAG],
			});
		}
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentInfo: { name: "gajae-code", title: "Gajae Code", version: packageJson.version },
			authMethods,
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { embeddedContext: true, image: true },
				// Legacy MCP HTTP+SSE (spec 2024-11-05) is deprecated and not implemented: an
				// `sse` config is served by the Streamable HTTP transport (runtime-mcp/client.ts),
				// which never performs the `endpoint`-event handshake. Advertising it would
				// invite a client to hand us a server we cannot connect to. Locally configured
				// `sse` entries still resolve through createTransport, so they keep working.
				mcpCapabilities: { http: true },
				sessionCapabilities: {
					list: {},
					fork: {},
					resume: {},
					close: {},
					delete: {},
				},
			},
		};
	}

	async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
		const methods = this.#clientCapabilities?.auth?.terminal ? ["agent", "terminal"] : ["agent"];
		if (!methods.includes(params.methodId)) throw new Error(`Unknown ACP auth method: ${params.methodId}`);
		return {};
	}

	async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		const mcpServers = this.#mcpServers(params);
		this.#assertAbsoluteCwd(params.cwd);
		this.#assertNoAdditionalDirectories(params.additionalDirectories);
		const result = await this.#launchSessionWithMcp(
			"session.create",
			{
				cwd: params.cwd,
				target: { path: params.cwd },
				...(this.#startupOptions?.modelPreset ? { modelPreset: this.#startupOptions.modelPreset } : {}),
				...(mcpServers.length > 0 ? { mcpServers, readinessTimeoutMs: ACP_MCP_LIFECYCLE_TIMEOUT_MS } : {}),
			},
			randomUUID(),
			mcpServers,
		);
		const id = sessionId(result);
		this.#knownSessionCwds.set(id, params.cwd);
		this.#ownedSessionIds.add(id);
		this.#knownSessionMcpServers.set(id, mcpServers);
		try {
			await this.#attach(id, params.cwd, undefined, result);
			await applyAcpStartupOptions(this.#adapter(id), this.#startupOptions);
			const response = { sessionId: id, ...(await this.#sessionState(id, true)) };
			this.#scheduleBootstrap(id);
			return response;
		} catch (error) {
			await this.#discardNewSession(id);
			throw error;
		}
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		const mcpServers = this.#mcpServers(params);
		this.#assertAbsoluteCwd(params.cwd);
		this.#assertNoAdditionalDirectories(params.additionalDirectories);
		if (mcpServers.length > 0) this.#knownSessionMcpServers.set(params.sessionId, mcpServers);
		await this.#attachExisting(params.sessionId, params.cwd, mcpServers);
		await this.#replaySession(params.sessionId);
		const response = await this.#sessionState(params.sessionId);
		this.#scheduleBootstrap(params.sessionId);
		return response;
	}

	async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		const mcpServers = this.#mcpServers(params);
		this.#assertAbsoluteCwd(params.cwd);
		this.#assertNoAdditionalDirectories(params.additionalDirectories);
		if (mcpServers.length > 0) this.#knownSessionMcpServers.set(params.sessionId, mcpServers);
		await this.#attachExisting(params.sessionId, params.cwd, mcpServers);
		const response = await this.#sessionState(params.sessionId);
		this.#scheduleBootstrap(params.sessionId);
		return response;
	}

	async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
		const mcpServers = this.#mcpServers(params);
		this.#assertAbsoluteCwd(params.cwd);
		this.#assertNoAdditionalDirectories(params.additionalDirectories);
		const source = await this.#resolveSavedSession(params.sessionId, params.cwd);
		const result = await this.#launchSessionWithMcp(
			"session.fork",
			{
				cwd: params.cwd,
				sourceSessionId: params.sessionId,
				sourceSessionPath: source,
				target: { path: params.cwd },
				...(mcpServers.length > 0 ? { mcpServers, readinessTimeoutMs: ACP_MCP_LIFECYCLE_TIMEOUT_MS } : {}),
			},
			randomUUID(),
			mcpServers,
		);
		const id = sessionId(result);
		this.#knownSessionCwds.set(id, params.cwd);
		this.#ownedSessionIds.add(id);
		this.#knownSessionMcpServers.set(id, mcpServers);
		try {
			await this.#attach(id, params.cwd, undefined, result);
			const response = { sessionId: id, ...(await this.#sessionState(id)) };
			this.#scheduleBootstrap(id);
			return response;
		} catch (error) {
			await this.#discardNewSession(id);
			throw error;
		}
	}

	async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		if (params.cwd) this.#assertAbsoluteCwd(params.cwd);
		const adapter = await this.#brokerAdapter();
		const listing = await collectAcpSessionList(input => adapter.global("session.list", input));
		const listed = Array.isArray(listing.sessions) ? listing.sessions : [];

		if (params.cwd) {
			const discovered = new Set<string>();
			for (const session of listed) {
				const candidate = object(session) as BrokerSession | undefined;
				if (
					typeof candidate?.sessionId !== "string" ||
					typeof candidate.locator?.repo !== "string" ||
					path.resolve(candidate.locator.repo) !== path.resolve(params.cwd)
				)
					continue;
				if (discovered.has(candidate.sessionId))
					throw new AcpSdkAdapterError("conflict", `Broker returned duplicate session id: ${candidate.sessionId}`);
				discovered.add(candidate.sessionId);
				const knownCwd = this.#knownSessionCwds.get(candidate.sessionId);
				if (knownCwd && path.resolve(knownCwd) !== path.resolve(params.cwd))
					throw new AcpSdkAdapterError(
						"conflict",
						`ACP session ${candidate.sessionId} has conflicting cwd authority.`,
					);
				this.#knownSessionCwds.set(candidate.sessionId, params.cwd);
			}
		}
		return paginateAcpSessions(
			listed,
			params.cwd ?? undefined,
			this.#cursor(params.cursor),
			this.#knownSessionMetadata,
		);
	}

	closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
		const record = this.#sessions.get(params.sessionId);
		// ACP close has no cwd. Only connection-owned sessions may reach broker lifecycle control.
		if (!this.#ownedSessionIds.has(params.sessionId)) return Promise.resolve({});
		const cwd = record?.cwd ?? this.#knownSessionCwds.get(params.sessionId);
		if (!cwd) return Promise.resolve({});
		return this.#enqueueLifecycleOperation(params.sessionId, async () => {
			// A preceding delete in the same lifecycle chain already completed the terminal operation.
			if (!this.#ownedSessionIds.has(params.sessionId) && !this.#sessions.has(params.sessionId)) return {};
			return this.#closeOwnedSession(params.sessionId);
		});
	}

	async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
		const record = this.#sessions.get(params.sessionId);
		const pendingLocator = this.#pendingDeleteLocators.get(params.sessionId);
		// Capture authority before joining the lifecycle chain: an admitted delete must
		// remain authorized when a preceding close retires connection ownership.
		if (!this.#ownedSessionIds.has(params.sessionId) && pendingLocator === undefined) return {};
		const cwd = record?.cwd ?? this.#knownSessionCwds.get(params.sessionId) ?? pendingLocator?.cwd;
		return this.#enqueueLifecycleOperation(params.sessionId, async () => {
			// ACP's delete request has no cwd. Unknown ids remain the protocol no-op,
			// while the broker can reconstruct an authenticated pending locator from its durable ledger.
			if (!cwd) {
				await (await this.#brokerAdapter()).global(
					"session.delete",
					{ sessionId: params.sessionId },
					this.#lifecycleIdempotencyKey(params.sessionId, "session.delete"),
				);
				return {};
			}
			this.#beginTeardown(params.sessionId);
			try {
				// A preceding close in the lifecycle chain already completed process teardown.
				// Continue with durable deletion instead of re-closing an already-dead process.
				const teardownCompleted =
					!this.#ownedSessionIds.has(params.sessionId) && !this.#sessions.has(params.sessionId);
				if (!teardownCompleted) {
					// A retained delete locator proves the prior attempt already completed
					// connection/process teardown and reached durable artifact cleanup. Re-closing
					// that terminal session can only replace the authoritative cleanup_pending
					// result with unrelated close uncertainty, so retries resume deletion directly.
					await this.#teardownSession(
						params.sessionId,
						"deleted",
						pendingLocator === undefined || record !== undefined,
					);
				}
				let saved = pendingLocator?.cwd === cwd ? pendingLocator.path : undefined;
				if (!saved) {
					try {
						saved = await this.#resolveSavedSession(params.sessionId, cwd);
					} catch (error) {
						if (error instanceof AcpSdkAdapterError && error.code === "not_found") {
							this.#knownSessionCwds.delete(params.sessionId);
							this.#ownedSessionIds.delete(params.sessionId);
							this.#knownSessionMcpServers.delete(params.sessionId);
							this.#knownSessionMetadata.delete(params.sessionId);
							return {};
						}
						throw error;
					}
				}
				this.#pendingDeleteLocators.set(params.sessionId, { cwd, path: saved });
				await (await this.#brokerAdapter()).global(
					"session.delete",
					{ sessionId: params.sessionId, sessionPath: saved, cwd, target: { path: cwd } },
					this.#lifecycleIdempotencyKey(params.sessionId, "session.delete"),
				);
				this.#knownSessionCwds.delete(params.sessionId);
				this.#ownedSessionIds.delete(params.sessionId);
				this.#knownSessionMcpServers.delete(params.sessionId);
				this.#knownSessionMetadata.delete(params.sessionId);
				this.#pendingDeleteLocators.delete(params.sessionId);
				return {};
			} finally {
				this.#finishTeardown(params.sessionId);
			}
		});
	}

	async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
		if (params.modeId !== ACP_DEFAULT_MODE_ID && params.modeId !== ACP_PLAN_MODE_ID)
			throw new Error(`Unsupported ACP mode: ${params.modeId}`);
		if (params.modeId === ACP_PLAN_MODE_ID)
			throw new AcpSdkAdapterError(
				"unsupported",
				"ACP plan mode is not available because this ACP session has no host plan-mode lifecycle.",
			);
		await this.#publishSessionUpdate(params.sessionId, {
			sessionId: params.sessionId,
			update: { sessionUpdate: "current_mode_update", currentModeId: ACP_DEFAULT_MODE_ID },
		});
		return {};
	}

	async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		if (typeof params.value !== "string")
			throw new Error(`Unsupported boolean ACP config option: ${params.configId}`);
		switch (params.configId) {
			case MODE_CONFIG_ID:
				await this.setSessionMode({ sessionId: params.sessionId, modeId: params.value });
				break;
			case MODEL_CONFIG_ID:
				if (this.#startupOptions?.modelPreset === undefined) {
					await this.#adapter(params.sessionId).setModel(params.value);
				} else if (params.value !== ACP_CUSTOM_MODEL_PRESET) {
					await this.#adapter(params.sessionId).control("model.profile.set", { id: params.value });
				}
				break;
			case THINKING_CONFIG_ID:
				await this.#adapter(params.sessionId).control("thinking.set", { level: params.value });
				break;
			default: {
				const operation = ACP_CONFIG_CONTROL_OPERATIONS[params.configId];
				if (!operation) throw new Error(`Unknown ACP config option: ${params.configId}`);
				await this.#adapter(params.sessionId).control(operation, { mode: params.value });
			}
		}
		const state = await this.#sessionState(params.sessionId);
		await this.#publishSessionUpdate(params.sessionId, {
			sessionId: params.sessionId,
			update: { sessionUpdate: "config_option_update", configOptions: state.configOptions ?? [] },
		});
		return { configOptions: state.configOptions ?? [] };
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const record = this.#sessions.get(params.sessionId);
		if (!record) throw new AcpSdkAdapterError("not_found", `Unknown session, not found: ${params.sessionId}`);
		if (record.activePrompt) throw new AcpSdkAdapterError("conflict", "ACP session already has an active prompt.");
		if (record.authFailure) throw new AcpSdkAdapterError("authentication_failed", record.authFailure);
		const payload = acpPromptPayload(params.prompt);
		const skillInvocation = acpSkillInvocation(params.prompt);
		if (!skillInvocation) {
			const promptError = validateRequiredPromptText("turn.prompt", {
				text: payload.text,
				images: payload.images,
			});
			if (promptError) throw new AcpSdkAdapterError(promptError.code, promptError.message);
		}
		// A new turn starts uncancelled; a stale flag must never settle it as `cancelled`.
		record.cancelRequested = false;
		if (isAcpUnavailableSlashCommand(payload.text)) {
			await this.#publishSessionUpdate(
				params.sessionId,
				{
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "Slash command /import-session is unavailable over ACP." },
					},
				},
				record.adapter,
			);
			return { stopReason: "end_turn" };
		}
		// The SDK transport hard-caps a single request frame at 256 KiB and answers an
		// oversize frame by closing the socket (CloseCode::Size, crates/gjc-sdk/src/server.rs),
		// which surfaces to the client as an opaque `connection_closed` mid-turn. Reject
		// the prompt up front with a typed, actionable error instead of losing the session.
		// Measure the frame the server actually receives, not just the payload: SdkClient
		// wraps it as {type,operation,input,id} with a UUID id, so a prompt sized just
		// under the cap would still be killed by CloseCode::Size.
		const promptFrameBytes = Buffer.byteLength(
			JSON.stringify({
				type: "control_request",
				operation: skillInvocation ? "skill.invoke" : "turn.prompt",
				input: skillInvocation ?? { text: payload.text, images: payload.images },
				// AcpSdkAdapter.control passes `confirm: false` to SdkClient, which serializes
				// the field even though it is not part of the skill input payload.
				...(skillInvocation ? { confirm: false } : {}),
				id: PROMPT_FRAME_ID_PLACEHOLDER,
			}),
		);
		if (promptFrameBytes > MAX_PROMPT_FRAME_BYTES)
			throw new AcpSdkAdapterError(
				"invalid_input",
				`ACP prompt is ${Math.ceil(promptFrameBytes / 1024)} KiB, over the ${Math.floor(
					MAX_PROMPT_FRAME_BYTES / 1024,
				)} KiB transport limit. Attach a smaller or more compressed image.`,
			);
		const { promise: response, resolve, reject } = Promise.withResolvers<PromptResponse>();
		const waiter: PromptWaiter = {
			acknowledged: false,
			dispatched: false,
			boundary: record.inboundSequence,
			correlation: {},
			emittedAssistantText: "",
			settled: false,
			deferredFrames: [],
			deferredActivityFrames: [],
			lastFrameAt: this.#promptWatchdogClock.now(),
			lastFrameType: "prompt_dispatch",
			activity: new PromptActivity(),
			resolve,
			reject,
		};
		record.activePrompt = waiter;
		// The watchdog may reject this waiter while the SDK acknowledgement request is still
		// pending. Retain the original promise for the caller, but mark that delayed rejection
		// as observed until prompt() can resume and await it.
		void response.catch(() => undefined);
		try {
			await record.adapter.ensureProviders();
		} catch (error) {
			if (waiter.settled || record.cancelRequested || record.activePrompt !== waiter) {
				if (!waiter.settled) await this.#settleCancelledPrompt(params.sessionId, record, waiter);
				return await response;
			}
			if (record.activePrompt === waiter) record.activePrompt = undefined;
			throw error;
		}
		if (waiter.settled || record.cancelRequested || record.activePrompt !== waiter) {
			if (!waiter.settled) await this.#settleCancelledPrompt(params.sessionId, record, waiter);
			return await response;
		}

		// Silence has to be bounded from the moment the prompt owns the session: a host that
		// dies before it ever answers is exactly the failure that leaves the client running.
		this.#armPromptWatchdog(params.sessionId, record, waiter);
		// Echo the user's own message back as `user_message_chunk`. Clients render their
		// transcript from session/update, so without this a prompt's text and any attached
		// image never appear in the client UI — only the agent's reply does. Replay
		// (session/load) already emits these; a live turn must too, and the image blocks
		// must be published verbatim so attachments are visible, not just fed to the model.
		for (const block of params.prompt) {
			if (block.type !== "text" && block.type !== "image") continue;
			if (block.type === "text" && block.text.length === 0) continue;
			await this.#publishSessionUpdate(
				params.sessionId,
				{
					sessionId: params.sessionId,
					update: { sessionUpdate: "user_message_chunk", content: block },
				},
				record.adapter,
			);
		}
		waiter.dispatched = true;
		if (waiter.settled || record.cancelRequested || record.activePrompt !== waiter) {
			if (!waiter.settled) await this.#settleCancelledPrompt(params.sessionId, record, waiter);
			return await response;
		}

		const acknowledgementTask = (async (): Promise<PromptResponse> => {
			if (waiter.settled || record.activePrompt !== waiter) return await response;
			const acknowledgement = skillInvocation
				? await record.adapter.control("skill.invoke", skillInvocation)
				: await record.adapter.prompt({
						text: payload.text,
						...(payload.images.length ? { images: payload.images } : {}),
					});

			const acknowledgementCorrelation = promptAcknowledgement(acknowledgement);
			if (!acknowledgementCorrelation)
				throw new AcpSdkAdapterError(
					"invalid_prompt_acknowledgement",
					"SDK prompt acknowledgement must accept the prompt and include commandId and turnId.",
				);
			// Retain the acknowledgement ingress boundary with its complete correlation.
			waiter.boundary = record.inboundSequence;
			waiter.correlation = acknowledgementCorrelation;
			waiter.acknowledged = true;
			if (promptWaiterRetired(record, waiter)) {
				if (
					!record.settledPromptCorrelations.some(settled =>
						correlationsExactlyMatch(settled, acknowledgementCorrelation),
					)
				) {
					record.settledPromptCorrelations.push(acknowledgementCorrelation);
					while (record.settledPromptCorrelations.length > SETTLED_PROMPT_CORRELATION_RETENTION)
						record.settledPromptCorrelations.shift();
				}
				return await response;
			}
			// Frames held while ownership was unknown belong to this prompt only when the
			// acknowledgement proves their complete correlation matches exactly.
			const deferredActivityFrames = waiter.deferredActivityFrames.splice(0);
			let observedDeferredActivity = false;
			for (const deferredFrame of deferredActivityFrames) {
				const deferredEvent = receivedSdkEvent(deferredFrame)?.event;
				if (correlationsExactlyMatch(waiter.correlation, watchdogCorrelationFrom(deferredFrame, deferredEvent))) {
					this.#observePromptActivity(waiter, deferredFrame);
					observedDeferredActivity = true;
				}
			}
			if (observedDeferredActivity) this.#armPromptWatchdog(params.sessionId, record, waiter);
			const deferred = waiter.deferredFrames.splice(0);
			for (const deferredFrame of deferred) {
				const deferredEvent = receivedSdkEvent(deferredFrame)?.event;
				if (!deferredEvent) continue;
				const deferredCorrelation = sdkFrameCorrelation(deferredFrame, deferredEvent) ?? {};
				const deferredIsTerminal = deferredEvent.type === "agent_end" || deferredEvent.type === "agent_failed";
				if (!hasCompleteCorrelation(deferredCorrelation)) {
					if (deferredIsTerminal)
						logDroppedPromptTerminal(
							params.sessionId,
							deferredEvent,
							"incomplete_correlation",
							deferredCorrelation,
							waiter.correlation,
						);
					continue;
				}
				const matchesPrompt = correlationsExactlyMatch(waiter.correlation, deferredCorrelation);
				if (
					!matchesPrompt &&
					record.settledPromptCorrelations.some(settled => correlationsExactlyMatch(settled, deferredCorrelation))
				)
					continue;
				if (!matchesPrompt) {
					if (deferredIsTerminal)
						logDroppedPromptTerminal(
							params.sessionId,
							deferredEvent,
							"correlation_mismatch",
							deferredCorrelation,
							waiter.correlation,
						);
					continue;
				}
				const task = record.frameTail.then(
					async () => await this.#handleSdkFrame(params.sessionId, record.adapter, deferredFrame),
				);
				record.frameTail = task.catch(
					async error =>
						await this.#failSession(params.sessionId, record.adapter, this.#frameProcessingFailure(error)),
				);
			}
			this.#settlePrompt(record, waiter);
			return await response;
		})();
		// Settlement can win before the SDK answers `turn.prompt`; acknowledgement processing
		// must remain alive to tombstone its eventual correlation without holding the ACP caller.
		void acknowledgementTask.catch(() => undefined);
		try {
			return await Promise.race([response, acknowledgementTask]);
		} catch (error) {
			if (waiter.cancelAttempt && (await waiter.cancelAttempt) && waiter.settled) return await response;
			waiter.deferredFrames.length = 0;
			waiter.deferredActivityFrames.length = 0;
			clearPromptWatchdog(waiter);
			waiter.terminal = undefined;
			waiter.settled = true;
			if (record.activePrompt === waiter) record.activePrompt = undefined;
			// Keep a late terminal for this (cancelled) turn closed, exactly like the
			// other settlement paths, so an aborted run's trailing frame can never
			// publish over a later prompt that reuses the identity.
			if (hasCompleteCorrelation(waiter.correlation)) {
				record.settledPromptCorrelations.push(waiter.correlation);
				while (record.settledPromptCorrelations.length > SETTLED_PROMPT_CORRELATION_RETENTION)
					record.settledPromptCorrelations.shift();
			}
			// A prompt cancelled before the SDK acknowledged it still ends this turn by
			// client request, and ACP is explicit: "Agents MUST catch these errors and
			// return the semantically meaningful `cancelled` stop reason, so that Clients
			// can reliably confirm the cancellation." Surfacing the transport's `busy`
			// rejection instead would show the user a spurious error for their own cancel.
			if (record.cancelRequested) {
				record.cancelRequested = false;
				// The client's turn is settled by the return; the advisory idle publication
				// must not gate it and must still be attempted so the running phase is
				// released (gjcRunning:false) instead of spinning behind a settled cancel.
				void this.#publishPromptPhaseIdle(params.sessionId, record.adapter);
				return { stopReason: "cancelled" };
			}
			throw error;
		}
	}

	async cancel(params: CancelNotification): Promise<void> {
		const record = this.#sessions.get(params.sessionId);
		if (!record) throw new AcpSdkAdapterError("not_found", `Unknown session, not found: ${params.sessionId}`);
		// Record the client's intent before awaiting the SDK so a prompt that rejects
		// mid-cancel (e.g. preflight `busy`) can still settle as `cancelled`.
		record.cancelRequested = true;
		// C04 terminal abort: an external client cancel stops the current turn
		// (`scope:"turn"`, the default, matching the SDK `turn.abort` default and
		// other ACP clients' cancel behavior). A client that also wants exact owned
		// subagents and background tasks stopped opts in with
		// `_meta.gjc.abortScope: "owned"` (or `GJC_ACP_ABORT_SCOPE=owned`).
		const scope = resolveAcpAbortScope(params._meta, process.env);
		const waiter = record.activePrompt;
		if (waiter) {
			// Overlapping cancels must not lose an earlier successful
			// acknowledgement: ANY successful attempt resolves the shared
			// waiter promise IMMEDIATELY (aggregation, not request-order
			// serialization — an unanswered first attempt must not delay the
			// second attempt's acknowledged success, or a prompt rejection
			// awaiting cancelAttempt could hang past the grace bound; review
			// thread P2). The LAST failing attempt resolves false. In-flight
			// attempts are counted so a failure only clears the shared intent
			// when no earlier attempt can still acknowledge.
			waiter.pendingCancelAttempts = (waiter.pendingCancelAttempts ?? 0) + 1;
			if (!waiter.cancelAttemptResolve) {
				const deferred = Promise.withResolvers<boolean>();
				waiter.cancelAttempt = deferred.promise;
				waiter.cancelAttemptResolve = deferred.resolve;
			}
		}
		try {
			const acknowledgement = await record.adapter.cancel(scope);
			const result = object(object(acknowledgement)?.result) ?? object(acknowledgement);
			if (!isAbortAcknowledged(acknowledgement, scope))
				throw new AcpSdkAdapterError(
					"abort_unacknowledged",
					"SDK did not acknowledge cancellation of the active prompt.",
				);
			if (waiter) waiter.cancelAcknowledged = true;
			if (waiter && record.activePrompt !== waiter) {
				waiter.cancelAttemptResolve?.(true);
				return;
			}
			if (
				result?.disposition === "preflight_cancelled" &&
				waiter &&
				record.activePrompt === waiter &&
				!waiter.acknowledged &&
				!waiter.settled
			) {
				record.activePrompt = undefined;
				waiter.settled = true;
				waiter.deferredFrames.length = 0;
				waiter.terminal = undefined;
				waiter.resolve({ stopReason: "cancelled" });
				// Release the running phase for consistency with the resolved cancel; the
				// publication is advisory and must never gate the settlement above.
				void this.#publishPromptPhaseIdle(params.sessionId, record.adapter);
			} else {
				// The acknowledgement proves the run was aborted, not that its terminal was
				// published. Arm the bounded settlement so the turn cannot outlive the cancel.
				this.#scheduleCancelSettlement(params.sessionId, record);
			}
			waiter?.cancelAttemptResolve?.(true);
		} catch (error) {
			if (waiter && !waiter.dispatched) {
				await this.#settleCancelledPrompt(params.sessionId, record, waiter);
				waiter.cancelAttemptResolve?.(true);
				return;
			}
			if (!waiter) record.cancelRequested = false;
			// Only the LAST in-flight attempt resolves the shared promise false;
			// an earlier attempt may still acknowledge (review thread P2). After
			// every attempt of this wave failed, RE-ARM the aggregate: a later
			// cancellation wave must get a fresh resolver — a stale resolved-false
			// promise would let the prompt path observe the old failure
			// immediately and report cancelled while the retry is still pending
			// (review thread P2).
			// Only clear and re-arm the aggregate when the LAST in-flight
			// attempt fails AND the entire wave was unacknowledged: a
			// failing attempt that follows an acknowledged one must not
			// erase the already-resolved successful aggregate, or a later
			// cancel installs a fresh unresolved cancelAttempt that a
			// concurrent prompt-preflight rejection awaits past the grace
			// bound (review thread P2).
			if (waiter && (waiter.pendingCancelAttempts ?? 0) <= 1 && !waiter.cancelAcknowledged) {
				waiter.cancelAttemptResolve?.(false);
				waiter.cancelAttempt = undefined;
				waiter.cancelAttemptResolve = undefined;
			}
			throw error;
		} finally {
			if (waiter) {
				waiter.pendingCancelAttempts = Math.max(0, (waiter.pendingCancelAttempts ?? 1) - 1);
				if (waiter.pendingCancelAttempts === 0 && !waiter.cancelAcknowledged && record.activePrompt === waiter) {
					record.cancelRequested = false;
				}
			}
		}
	}

	/**
	 * `aborted: true` means the run is gone, so the pending prompt is already over even
	 * if no normalized terminal follows. Without this the waiter stays pending forever:
	 * the client's turn never resolves, its composer stays in the running phase, and
	 * every later `session/prompt` is refused with `conflict`.
	 */
	#scheduleCancelSettlement(id: string, record: SessionRecord): void {
		const waiter = record.activePrompt;
		if (!waiter || waiter.settled) return;
		setTimeout(() => {
			void this.#settleCancelledPrompt(id, record, waiter);
		}, this.#cancelSettlementGraceMs).unref?.();
	}

	async #settleCancelledPrompt(id: string, record: SessionRecord, waiter: PromptWaiter): Promise<void> {
		// The authoritative terminal wins whenever it arrives in time; this only runs
		// when nothing settled the prompt the client already asked to cancel.
		if (this.#sessions.get(id) !== record || record.activePrompt !== waiter || waiter.settled) return;
		record.activePrompt = undefined;
		clearPromptWatchdog(waiter);
		record.cancelRequested = false;
		waiter.settled = true;
		waiter.deferredFrames.length = 0;
		waiter.deferredActivityFrames.length = 0;
		waiter.terminal = undefined;
		// A late terminal for this turn must stay closed rather than publish over a
		// prompt the client has already been told is cancelled.
		if (hasCompleteCorrelation(waiter.correlation)) {
			record.settledPromptCorrelations.push(waiter.correlation);
			while (record.settledPromptCorrelations.length > SETTLED_PROMPT_CORRELATION_RETENTION)
				record.settledPromptCorrelations.shift();
		}
		// The client's turn ends with the resolution, not with the advisory idle update.
		// Publishing the phase transition first made a backpressured ACP transport hold
		// the settlement hostage: `sessionUpdate` awaits the stream write, a client that
		// stops reading (force-cancel in progress) blocks it, and `waiter.resolve` never
		// ran — the acknowledged cancel left the prompt pending forever, the client
		// force-cancelled, and the next prompt collided with the stale foreground turn.
		waiter.resolve({ stopReason: "cancelled" });
		void this.#publishPromptPhaseIdle(id, record.adapter);
	}

	async extMethod(method: string, params: JsonObject): Promise<JsonObject> {
		// An unrecognized extension method is a protocol failure, not an application
		// result: it must reach the client as JSON-RPC -32601 rather than a resolved
		// payload. Recognized `_gjc/*` methods keep their `{ok:false}` result contract.
		if (
			method !== "session/set_model" &&
			method !== "_gjc/sdk/global" &&
			method !== "_gjc/sdk/control" &&
			method !== "_gjc/sdk/query"
		)
			throw RequestError.methodNotFound(method);
		try {
			if (method === "session/set_model") {
				const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
				const modelId = typeof params.modelId === "string" ? params.modelId : undefined;
				if (!sessionId) throw new AcpSdkAdapterError("invalid_input", "sessionId is required.");
				if (!modelId) throw new AcpSdkAdapterError("invalid_input", "modelId is required.");
				await this.setSessionConfigOption({ sessionId, configId: MODEL_CONFIG_ID, value: modelId });
				return {};
			}
			if (method === "_gjc/sdk/global") {
				const result = await (await this.#brokerAdapter()).handle(method, params);
				return object(result) ?? {};
			}
			const id = typeof params.sessionId === "string" ? params.sessionId : undefined;
			if (!id) throw new AcpSdkAdapterError("invalid_input", "sessionId is required.");
			const result = await this.#adapter(id).handle(method, params);
			return object(result) ?? {};
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "internal";
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: { code, message } };
		}
	}

	async extNotification(_method: string, _params: JsonObject): Promise<void> {}
	get signal(): AbortSignal {
		return this.#connection.signal;
	}
	get closed(): Promise<void> {
		return this.#connection.closed;
	}

	#sessionEpoch(id: string): number {
		return this.#sessionEpochs.get(id) ?? 0;
	}

	#advanceSessionEpoch(id: string): void {
		this.#sessionEpochs.set(id, this.#sessionEpoch(id) + 1);
	}

	#assertSessionEpoch(id: string, epoch: number): void {
		if (this.#disposed || this.#tearingDown.has(id) || this.#sessionEpoch(id) !== epoch)
			throw new AcpSdkAdapterError("connection_closed", `ACP session ${id} was closed while attaching.`);
	}

	#beginTeardown(id: string): void {
		this.#tearingDown.set(id, (this.#tearingDown.get(id) ?? 0) + 1);
	}

	#finishTeardown(id: string): void {
		const remaining = (this.#tearingDown.get(id) ?? 1) - 1;
		if (remaining > 0) this.#tearingDown.set(id, remaining);
		else this.#tearingDown.delete(id);
	}

	#enqueueLifecycleOperation<T>(id: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.#lifecycleOperations.get(id) ?? Promise.resolve();
		const result = previous.catch(() => undefined).then(operation);
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		this.#lifecycleOperations.set(id, settled);
		void settled.finally(() => {
			if (this.#lifecycleOperations.get(id) === settled) this.#lifecycleOperations.delete(id);
		});
		return result;
	}

	#lifecycleIdempotencyKey(id: string, operation: "session.close" | "session.delete"): string {
		return `acp:${operation}:${id}`;
	}

	#isAlreadyGone(error: unknown): boolean {
		return (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			((error.code === "not_found" || error.code === "resource_gone") as boolean)
		);
	}

	#isDefinitiveBrokerResponse(error: unknown): boolean {
		// Response-derived client errors retain the broker error as details. Responses
		// that represent ongoing or ambiguous lifecycle work must keep their key.
		if (!(error instanceof SdkClientError)) return false;
		const details = object(error.details);
		if (details?.code !== error.code || details.message !== error.message) return false;
		return !["terminal_uncertain", "cleanup_pending", "broker_restarting", "unavailable"].includes(error.code);
	}

	async #ensureRouterReady(): Promise<void> {
		if (!this.#routerStartPromise) {
			let pending!: Promise<void>;
			pending = this.#router.start().catch(error => {
				if (this.#routerStartPromise === pending) this.#routerStartPromise = undefined;
				throw error;
			});
			this.#routerStartPromise = pending;
		}
		await this.#routerStartPromise;
	}

	async #attachExisting(id: string, cwd: string, mcpServers: SessionLifecycleMcpServer[] = []): Promise<void> {
		const epoch = this.#sessionEpoch(id);
		const attached = this.#sessions.get(id);
		if (attached) {
			if (path.resolve(attached.cwd) !== path.resolve(cwd))
				throw new AcpSdkAdapterError("conflict", `ACP session ${id} has conflicting cwd authority.`);
			// ACP clients replay their declared MCP servers when reconnecting. The live
			// session host remains authoritative for its immutable configuration, so
			// attachment must not reinterpret the replay as a mutation request.
			this.#pendingDeleteLocators.delete(id);
			await attached.adapter.ensureProviders();
			return;
		}
		const knownCwd = this.#knownSessionCwds.get(id);
		if (knownCwd && path.resolve(knownCwd) !== path.resolve(cwd))
			throw new AcpSdkAdapterError("conflict", `ACP session ${id} has conflicting cwd authority.`);
		const resolving = this.#resolvingExisting.get(id);
		if (resolving?.epoch === epoch) {
			await resolving.task;
			this.#assertSessionEpoch(id, epoch);
			const resolved = this.#sessions.get(id);
			if (!resolved) throw new AcpSdkAdapterError("unavailable", `ACP session ${id} did not attach.`);
			if (path.resolve(resolved.cwd) !== path.resolve(cwd))
				throw new AcpSdkAdapterError("conflict", `ACP session ${id} has conflicting cwd authority.`);
			return;
		}

		const task = this.#resolveExistingAttachment(id, cwd, epoch, mcpServers);
		const pending = { epoch, task };
		this.#resolvingExisting.set(id, pending);
		try {
			await task;
			this.#assertSessionEpoch(id, epoch);
		} finally {
			if (this.#resolvingExisting.get(id) === pending) this.#resolvingExisting.delete(id);
		}
	}

	async #resolveExistingAttachment(
		id: string,
		cwd: string,
		epoch: number,
		mcpServers: SessionLifecycleMcpServer[],
	): Promise<void> {
		this.#assertSessionEpoch(id, epoch);
		const indexed = await this.#scopedBrokerSession(id, cwd);
		this.#assertSessionEpoch(id, epoch);
		if (indexed?.live) {
			// A reconnect may repeat the client's MCP declaration. Attaching to the
			// existing endpoint preserves the live host's immutable configuration.
			await this.#attach(id, cwd, epoch);
			return;
		}

		const saved = await this.#resolveSavedSession(id, cwd);
		this.#assertSessionEpoch(id, epoch);
		const result = await this.#launchSessionWithMcp(
			"session.resume",
			{
				cwd,
				sessionId: id,
				sessionPath: saved,
				target: { path: cwd },
				...(mcpServers.length > 0 ? { mcpServers, readinessTimeoutMs: ACP_MCP_LIFECYCLE_TIMEOUT_MS } : {}),
			},
			randomUUID(),
			mcpServers,
		);
		this.#assertSessionEpoch(id, epoch);
		await this.#attach(id, cwd, epoch, result);
	}

	async #scopedBrokerSession(id: string, cwd: string): Promise<BrokerSession | undefined> {
		const adapter = await this.#brokerAdapter();
		const result = await collectAcpSessionList(input => adapter.global("session.list", input), { cwd });

		const matches: BrokerSession[] = [];
		for (const item of Array.isArray(result?.sessions) ? result.sessions : []) {
			const session = object(item) as BrokerSession | undefined;
			if (session?.sessionId !== id) continue;
			if (typeof session.locator?.repo !== "string" || path.resolve(session.locator.repo) !== path.resolve(cwd))
				throw new AcpSdkAdapterError("conflict", `Broker returned conflicting session scope for ${id}.`);
			matches.push(session);
		}
		if (matches.length > 1) throw new AcpSdkAdapterError("conflict", `Broker returned duplicate session id: ${id}`);
		return matches[0];
	}

	async #attach(id: string, cwd: string, epoch = this.#sessionEpoch(id), lifecycleResult?: unknown): Promise<void> {
		this.#assertSessionEpoch(id, epoch);
		const existing = this.#sessions.get(id);
		if (existing) {
			if (path.resolve(existing.cwd) !== path.resolve(cwd))
				throw new AcpSdkAdapterError("conflict", `ACP session ${id} has conflicting cwd authority.`);
			await existing.adapter.ensureProviders();
			return;
		}
		const attaching = this.#attaching.get(id);
		if (attaching?.epoch === epoch) {
			await attaching.task;
			this.#assertSessionEpoch(id, epoch);
			const attached = this.#sessions.get(id);
			if (!attached) throw new AcpSdkAdapterError("unavailable", `ACP session ${id} did not attach.`);
			if (path.resolve(attached.cwd) !== path.resolve(cwd))
				throw new AcpSdkAdapterError("conflict", `ACP session ${id} has conflicting cwd authority.`);
			return;
		}

		const task = this.#attachEndpoint(id, cwd, epoch, lifecycleResult);
		const pending = { epoch, task };
		this.#attaching.set(id, pending);
		try {
			await task;
			this.#assertSessionEpoch(id, epoch);
		} finally {
			if (this.#attaching.get(id) === pending) this.#attaching.delete(id);
		}
	}

	async #attachEndpoint(id: string, cwd: string, epoch: number, lifecycleResult?: unknown): Promise<void> {
		let adapter: AcpSdkAdapter | undefined;
		const bufferedFrames: Record<string, unknown>[] = [];
		const pendingAdapterFrames: Record<string, unknown>[] = [];
		let unsubscribePendingFrames = () => {};
		this.#pendingRouterFrames.set(id, bufferedFrames);
		try {
			await this.#ensureRouterReady();
			const attachment = lifecycleResult
				? await this.#router.adoptLifecycleResult(lifecycleResult, { sessionId: id, cwd })
				: this.#router.attachment(id);
			if (!attachment)
				throw new AcpSdkAdapterError("unavailable", `ACP session ${id} has no current Router attachment.`);
			let currentAttachment = this.#router.attachment(id);
			for (let attempt = 0; !currentAttachment && attempt < 40; attempt++) {
				await Bun.sleep(50);
				await this.#router.reconcile();
				currentAttachment = this.#router.attachment(id);
			}
			if (!currentAttachment)
				throw new AcpSdkAdapterError("unavailable", `ACP session ${id} lost exact Router authority.`);
			adapter = new AcpSdkAdapter({
				router: this.#router,
				attachment: currentAttachment,
				sessionId: id,
				connection: this.#reverseConnection(id),
				providers: this.#providers(),
			});
			unsubscribePendingFrames = adapter.onFrame(frame => pendingAdapterFrames.push(frame));
			this.#pendingRouterAdapters.set(id, adapter);
			await adapter.start();
			let capabilities: JsonObject | undefined;
			try {
				const response = object(await adapter.query("runtime.capabilities"));
				const result = object(response?.result) ?? response;
				// Q18 is a paged query surface: the capability object arrives as the single
				// page item, so fall back to the envelope only for direct-result hosts.
				capabilities = object(pageItems(result)[0]) ?? result;
			} catch {}
			if (capabilities?.promptTerminalOutcomeVersion !== 1)
				throw new AcpSdkAdapterError(
					"unavailable",
					"This ACP client requires a newer GJC SDK session; restart the session.",
				);
			this.#assertSessionEpoch(id, epoch);
			const exactAttachment = this.#router.attachment(id) ?? currentAttachment;
			if (!exactAttachment.isCurrent())
				throw new AcpSdkAdapterError("unavailable", `ACP session ${id} lost exact Router authority.`);
			const record: SessionRecord = {
				cwd,
				adapter,
				attachment: exactAttachment,
				closeIdempotencyKey: randomUUID(),
				unsubscribe: () => {},
				reconnectUnsubscribe: () => {},
				frameTail: Promise.resolve(),
				settledPromptCorrelations: [],
				inboundSequence: 0,
				connectionId: adapter.connectionId,
				busy: false,
				toolArgs: new Map(),
			};
			record.unsubscribe = adapter.onFrame(frame => this.#enqueueSdkFrame(id, adapter!, frame));
			record.reconnectUnsubscribe = adapter.onReconnectFailed(error =>
				this.#recoverSessionAfterTransportFailure(id, adapter!, error),
			);
			this.#sessions.set(id, record);
			unsubscribePendingFrames();
			for (const frame of bufferedFrames) adapter.acceptFrame(frame);
			for (const frame of pendingAdapterFrames) this.#enqueueSdkFrame(id, adapter, frame);
			this.#pendingRouterAdapters.delete(id);
			this.#pendingRouterFrames.delete(id);
			this.#knownSessionCwds.set(id, cwd);
			this.#ownedSessionIds.add(id);
			await applyAcpPermissionMode(adapter, this.#clientCapabilities);
			this.#assertSessionEpoch(id, epoch);
			// A successful attachment establishes a new live-owner epoch. Any locator
			// retained from an earlier cleanup_pending delete belongs to the terminal
			// owner and must not suppress remote close when this live session is deleted.
			this.#pendingDeleteLocators.delete(id);
			this.#pendingCloseIdempotencyKeys.delete(id);
		} catch (error) {
			unsubscribePendingFrames();
			this.#pendingRouterAdapters.delete(id);
			this.#pendingRouterFrames.delete(id);
			if (adapter && this.#sessions.get(id)?.adapter === adapter) {
				try {
					await this.#teardownSession(id, "attachment failed", false);
				} finally {
					this.#knownSessionCwds.delete(id);
					this.#ownedSessionIds.delete(id);
					this.#knownSessionMcpServers.delete(id);
				}
			} else if (adapter) {
				try {
					await adapter.close();
				} catch {}
				try {
					await this.#router.attachment(id)?.retire?.();
				} catch {}
			} else {
				try {
					await this.#router.attachment(id)?.retire?.();
				} catch {}
			}
			throw error;
		}
	}

	#recoverSessionAfterTransportFailure(id: string, adapter: AcpSdkAdapter, error: Error): void {
		const record = this.#sessions.get(id);
		if (!record || record.adapter !== adapter) return;
		if (
			error instanceof SdkClientError &&
			error.code !== "reconnect_exhausted" &&
			error.code !== "provider_rebind_failed"
		) {
			logger.warn(
				`ACP session ${id} transport failure is not recoverable (${error.code}); ignoring terminal recovery.`,
			);
			return;
		}
		if (!(error instanceof SdkClientError)) {
			logger.warn(`ACP session ${id} non-transport error reached reconnect handler; ignoring terminal recovery.`);
			return;
		}
		const detail = error.message || "SDK transport reconnect failed.";
		const terminal = new AcpSdkAdapterError("connection_closed", `ACP session transport was lost: ${detail}`);
		void this.#recoverSessionAfterTransportFailureAsync(id, adapter, record.cwd, terminal);
	}

	async #recoverSessionAfterTransportFailureAsync(
		id: string,
		adapter: AcpSdkAdapter,
		cwd: string,
		error: AcpSdkAdapterError,
	): Promise<void> {
		await this.#failSession(id, adapter, error);
		if (this.#disposed || this.#knownSessionCwds.get(id) !== cwd) return;
		const mcpServers = this.#knownSessionMcpServers.get(id) ?? [];
		try {
			await this.#attachExisting(id, cwd, mcpServers);
		} catch (attachError) {
			const detail = attachError instanceof Error ? attachError.message : String(attachError);
			logger.warn(`ACP session ${id} auto-reattach after transport loss failed: ${detail}`);
			try {
				await this.#connection.sessionUpdate({
					sessionId: id,
					update: {
						sessionUpdate: "session_info_update",
						_meta: { gjcRecoverFailed: true, gjcRecoverError: detail },
					},
				});
			} catch {}
		}
	}

	async #discardNewSession(id: string): Promise<void> {
		await this.#teardownSession(id, "discarded", true);
		this.#knownSessionCwds.delete(id);
		this.#ownedSessionIds.delete(id);
		this.#knownSessionMcpServers.delete(id);
		this.#knownSessionMetadata.delete(id);
	}

	async #closeOwnedSession(id: string): Promise<CloseSessionResponse> {
		this.#beginTeardown(id);
		try {
			const attaching = this.#attaching.get(id);
			// The record is published before permission initialization. Let a canceled
			// provisional attachment retire it before selecting the generation key.
			if (attaching) await Promise.allSettled([attaching.task]);
			await this.#teardownSession(id, "closed", true);
			this.#knownSessionCwds.delete(id);
			this.#ownedSessionIds.delete(id);
			this.#knownSessionMcpServers.delete(id);
			this.#knownSessionMetadata.delete(id);
			return {};
		} finally {
			this.#finishTeardown(id);
		}
	}

	/**
	 * All local session disposal follows one path: remove ownership and reject a
	 * waiting prompt before any awaited socket or broker work. A failed close is
	 * terminally uncertain, not a reason to leave a usable-looking ACP record.
	 */
	async #teardownSession(id: string, reason: string, closeRemote: boolean): Promise<void> {
		const record = this.#sessions.get(id);
		const ownershipBound = record !== undefined || this.#ownedSessionIds.has(id);
		this.#beginTeardown(id);
		try {
			this.#advanceSessionEpoch(id);
			if (record) {
				this.#sessions.delete(id);
				record.unsubscribe();
				record.reconnectUnsubscribe();
				const waiter = record.activePrompt;
				record.activePrompt = undefined;
				// `session/close` is the client asking to end its own work, so the pending turn
				// settles as `cancelled` rather than surfacing a spurious error. ACP: "Agents
				// MUST catch these errors and return the semantically meaningful `cancelled`
				// stop reason." Involuntary teardown (transport loss) still rejects.
				if (waiter && !waiter.settled) {
					clearPromptWatchdog(waiter);
					if (reason === "closed" || reason === "discarded") {
						waiter.settled = true;
						waiter.resolve({ stopReason: "cancelled" });
					} else {
						waiter.reject(new AcpSdkAdapterError("connection_closed", `ACP session was ${reason}.`));
					}
				}
			}

			const failures: unknown[] = [];
			if (closeRemote) {
				const closeIdempotencyKey =
					record?.closeIdempotencyKey ?? this.#pendingCloseIdempotencyKeys.get(id) ?? randomUUID();
				this.#pendingCloseIdempotencyKeys.set(id, closeIdempotencyKey);
				try {
					await (await this.#brokerAdapter()).global("session.close", { sessionId: id }, closeIdempotencyKey);
				} catch (error) {
					if (this.#isDefinitiveBrokerResponse(error)) this.#pendingCloseIdempotencyKeys.delete(id);
					if (!(ownershipBound && this.#isAlreadyGone(error))) failures.push(error);
				}
			}
			try {
				await record?.adapter.close();
			} catch (error) {
				failures.push(error);
			}
			try {
				await record?.attachment.retire?.();
			} catch (error) {
				failures.push(error);
			}
			if (failures.length > 0) {
				const detail = failures
					.map(failure => (failure instanceof Error ? failure.message : String(failure)))
					.join("; ");
				throw aggregateAcpFailure("terminal_uncertain", `ACP session cleanup is uncertain: ${detail}`, failures);
			}
			if (closeRemote) this.#pendingCloseIdempotencyKeys.delete(id);
		} finally {
			this.#finishTeardown(id);
		}
	}

	async #failSession(id: string, adapter: AcpSdkAdapter, error: AcpSdkAdapterError): Promise<void> {
		const record = this.#sessions.get(id);
		if (!record || record.adapter !== adapter) return;
		this.#advanceSessionEpoch(id);
		this.#sessions.delete(id);
		record.unsubscribe();
		record.reconnectUnsubscribe();
		const waiter = record.activePrompt;
		record.activePrompt = undefined;
		if (waiter) clearPromptWatchdog(waiter);
		waiter?.reject(error);
		try {
			await adapter.close();
		} catch {}
		try {
			await record.attachment.retire?.();
		} catch {}
	}

	async #brokerAdapter(): Promise<AcpSdkAdapter> {
		return (await this.#brokerConnection()).adapter;
	}

	async #brokerConnection(): Promise<BrokerConnection> {
		if (!this.#broker) {
			let pending!: Promise<BrokerConnection>;
			pending = (async () => {
				await ensureBroker({ agentDir: this.#agentDir });
				const discovery = await readSdkBrokerDiscovery(this.#agentDir);
				if (!discovery) throw new AcpSdkAdapterError("unavailable", "SDK broker discovery is unavailable.");
				const client = await SdkClient.connect(discovery.url, discovery.token, { ...ACP_SESSION_RECONNECT });
				const adapter = new AcpSdkAdapter({ client });
				adapter.onReconnectFailed(() => {
					if (this.#broker === pending) this.#broker = undefined;
					void adapter.close().catch(() => undefined);
				});
				await adapter.start();
				return { adapter, client };
			})();
			this.#broker = pending;
		}
		const pending = this.#broker;
		try {
			return await pending;
		} catch (error) {
			if (this.#broker === pending) this.#broker = undefined;
			throw error;
		}
	}

	#adapter(id: string): AcpSdkAdapter {
		const record = this.#sessions.get(id);
		if (!record) throw new AcpSdkAdapterError("not_found", `Unknown session, not found: ${id}`);
		return record.adapter;
	}

	async #resolveSavedSession(id: string, cwd: string): Promise<string> {
		const adapter = await this.#brokerAdapter();
		const result = await collectAcpSessionList(input => adapter.global("session.list", input), {
			resolveSessionId: id,
			cwd,
		});
		const saved = object(result?.savedSession);
		if (saved?.id !== id || typeof saved.path !== "string")
			throw new AcpSdkAdapterError("not_found", `Saved ACP session does not exist: ${id}`);
		return saved.path;
	}

	#providers(): AcpProviderRegistration[] {
		return acpProviderRegistrations(this.#clientCapabilities);
	}

	#reverseConnection(sessionId: string): AcpReverseConnection {
		return createAcpReverseConnection(this.#connection, sessionId);
	}

	#observeSessionActivity(record: SessionRecord, frame: JsonObject): void {
		if (frame.type === "activity") {
			if (frame.state === "busy") record.busy = true;
			else if (frame.state === "idle") record.busy = false;
			return;
		}
		const event = receivedSdkEvent(frame)?.event;
		if (event?.type === "agent_start") record.busy = true;
		else if (event?.type === "agent_end") record.busy = false;
	}

	#frameProcessingFailure(error: unknown): AcpSdkAdapterError {
		if (error instanceof AcpSdkAdapterError && error.code === "frame_processing_failed") return error;
		const detail = error instanceof Error ? error.message : String(error);
		return new AcpSdkAdapterError("frame_processing_failed", `ACP session frame processing failed: ${detail}`);
	}

	/**
	 * Bounds how long one prompt may stay silent. A session host that stops producing
	 * never publishes a terminal frame, and an ACP prompt only settles on a terminal, so
	 * without this bound `session/prompt` never returns and the client reports the turn as
	 * running forever behind a dead session.
	 */
	#armPromptWatchdog(id: string, record: SessionRecord, waiter: PromptWaiter): void {
		if (waiter.settled) return;
		waiter.cancelWatchdog?.();
		// No frame can still arrive once the transport is known to be gone, so waiting out
		// the full bound would only add dead time to an outcome that is already decided.
		const delayMs = this.#promptTransportGone(id, record) ? 0 : waiter.activity.inactivityBoundMs;
		waiter.cancelWatchdog = this.#promptWatchdogClock.schedule(() => {
			void this.#expirePromptWatchdog(id, record, waiter);
		}, delayMs);
	}

	/**
	 * A frame only restarts this prompt's watchdog after its complete correlation proves
	 * that it belongs to the prompt. Correlationless or foreign traffic still proves the
	 * session host process is alive, but not that it is making progress on this turn; using
	 * process liveness as turn liveness lets an otherwise healthy host keep a wedged prompt
	 * open forever. Matching frames retain the per-gap behavior for hosts demonstrably
	 * working on this turn, while pre-acknowledgement activity is replayed after ownership
	 * becomes known.
	 */
	#refreshPromptWatchdog(id: string, record: SessionRecord, frame: JsonObject): void {
		const waiter = record.activePrompt;
		if (!waiter || waiter.settled) return;
		const event = receivedSdkEvent(frame)?.event;
		const correlation = watchdogCorrelationFrom(frame, event);
		if (!waiter.acknowledged) {
			if (hasCorrelation(correlation)) waiter.deferredActivityFrames.push(frame);
			return;
		}
		if (!correlationsExactlyMatch(waiter.correlation, correlation)) return;
		this.#observePromptActivity(waiter, frame);
		this.#armPromptWatchdog(id, record, waiter);
	}

	#observePromptActivity(waiter: PromptWaiter, frame: JsonObject): void {
		const event = receivedSdkEvent(frame)?.event;
		waiter.lastFrameAt = this.#promptWatchdogClock.now();
		waiter.lastFrameType =
			typeof event?.type === "string" ? event.type : typeof frame.type === "string" ? frame.type : "unknown";
		waiter.activity.observe(
			typeof event?.type === "string" ? event.type : undefined,
			typeof event?.toolCallId === "string" ? event.toolCallId : undefined,
			frameMessageRole(event),
		);
	}

	/** Names why the prompt can be settled at once instead of waiting out the inactivity bound. */
	#promptTransportGone(id: string, record: SessionRecord): string | undefined {
		if (this.#disposed || this.#connection.signal.aborted) return "the ACP client connection is closed";
		if (this.#sessions.get(id) !== record) return "the SDK session host record was already discarded";
		return undefined;
	}

	/**
	 * Settles the ACP prompt only. The agent's own work is left alone: this reports that the
	 * turn can no longer be observed, it does not cancel or tear down the session.
	 */
	async #expirePromptWatchdog(id: string, record: SessionRecord, waiter: PromptWaiter): Promise<void> {
		if (record.activePrompt !== waiter || waiter.settled) return;
		const silenceMs = Math.max(0, this.#promptWatchdogClock.now() - waiter.lastFrameAt);
		const cause = this.#promptTransportGone(id, record) ?? "the SDK session host stopped producing frames";
		logger.error("acp_prompt_watchdog_expired", {
			sessionId: id,
			cause,
			silenceMs,
			lastFrameType: waiter.lastFrameType,
			inactivityBoundMs: waiter.activity.inactivityBoundMs,
			toolRunning: waiter.activity.running,
			awaitingModel: waiter.activity.awaitingModel,
			...(waiter.correlation.commandId ? { commandId: waiter.correlation.commandId } : {}),
			...(waiter.correlation.turnId ? { turnId: waiter.correlation.turnId } : {}),
		});
		await this.#rejectPrompt(
			record,
			id,
			waiter,
			new AcpSdkAdapterError(
				"prompt_abandoned",
				`ACP prompt was abandoned after ${Math.round(silenceMs / 1_000)}s of silence: ${cause}. Last frame was ` +
					`"${waiter.lastFrameType}" (${describeCorrelation(waiter.correlation)}). The turn was settled so the ` +
					`client stops waiting; the session still accepts the next prompt.`,
			),
		);
	}

	#enqueueSdkFrame(id: string, adapter: AcpSdkAdapter, frame: JsonObject): void {
		const record = this.#sessions.get(id);
		if (!record || record.adapter !== adapter) return;
		if (typeof frame.connectionId === "string") record.connectionId = frame.connectionId;
		// Ingress ordering is recorded before queued work begins.
		this.#observeSessionActivity(record, frame);
		// Correlation is checked at ingress before a prompt-owned frame may refresh the
		// watchdog, so queued processing cannot turn unrelated host traffic into turn liveness.
		this.#refreshPromptWatchdog(id, record, frame);
		++record.inboundSequence;
		const task = record.frameTail.then(async () => await this.#handleSdkFrame(id, adapter, frame));
		record.frameTail = task.catch(
			async error => await this.#failSession(id, adapter, this.#frameProcessingFailure(error)),
		);
	}

	async #handleSdkFrame(id: string, adapter: AcpSdkAdapter, frame: JsonObject): Promise<void> {
		const record = this.#sessions.get(id);
		if (!record || record.adapter !== adapter) return;
		if ((frame.type === "hello" || frame.type === "server_hello") && typeof frame.connectionId === "string") {
			const reconnected = record.connectionId !== undefined && record.connectionId !== frame.connectionId;
			record.connectionId = frame.connectionId;
			if (reconnected) {
				const waiter = record.activePrompt;
				if (waiter && !waiter.settled && !waiter.terminal) {
					record.activePrompt = undefined;
					clearPromptWatchdog(waiter);
					waiter.settled = true;
					if (hasCorrelation(waiter.correlation)) {
						record.settledPromptCorrelations.push(waiter.correlation);
						while (record.settledPromptCorrelations.length > SETTLED_PROMPT_CORRELATION_RETENTION)
							record.settledPromptCorrelations.shift();
					}
					waiter.reject(
						new AcpSdkAdapterError(
							"connection_closed",
							"The prompt owner connection was lost before completion.",
						),
					);
					// The turn is settled by the rejection; release the running phase
					// best-effort so a cancelled prompt is not left reporting working.
					void this.#publishPromptPhaseIdle(id, record.adapter);
				}
			}
			return;
		}
		const received = receivedSdkEvent(frame);
		if (!received) return;
		const { event, wirePayload } = received;
		const isTerminal = event.type === "agent_end";
		if (event.type === "notice" && event.source === "autorouting" && typeof event.message === "string") {
			record.routingInactiveNotice = event.message;
			return;
		}
		const derivedCorrelation = sdkFrameCorrelation(frame, event);
		const correlation = derivedCorrelation ?? {};
		const activePrompt = record.activePrompt;
		const outcome = isTerminal ? terminalOutcome(event) : undefined;
		const settledCorrelation = record.settledPromptCorrelations.some(settled =>
			correlationsMatch(settled, correlation),
		);
		if (isTerminal) {
			// Terminal ownership requires a complete identity. Unowned, partial, and
			// duplicate terminals are never allowed to publish or query anything.
			if (!activePrompt || activePrompt.settled) return;
			if (!hasCompleteCorrelation(correlation)) {
				logDroppedPromptTerminal(id, event, "incomplete_correlation", correlation, activePrompt.correlation);
				return;
			}
			if (!activePrompt.acknowledged) {
				// Hold the entire frame until the prompt acknowledgement proves ownership.
				activePrompt.deferredFrames.push(frame);
				return;
			}
			const matchesPrompt = correlationsExactlyMatch(activePrompt.correlation, correlation);
			if (settledCorrelation && !matchesPrompt) return;
			if (!matchesPrompt) {
				logDroppedPromptTerminal(id, event, "correlation_mismatch", correlation, activePrompt.correlation);
				return;
			}
			if (activePrompt.terminal) return;
			if (!outcome) {
				const detail =
					typeof (event as { error?: { message?: unknown } }).error?.message === "string"
						? (event as { error: { message: string } }).error.message
						: "the prompt terminal omitted a valid normalized outcome";
				await this.#rejectPrompt(
					record,
					id,
					activePrompt,
					new AcpSdkAdapterError("connection_closed", `ACP prompt terminal was invalid: ${detail}`),
				);
				return;
			}
			activePrompt.terminal = { outcome, correlation };
		}
		if (!isTerminal && derivedCorrelation === undefined) return;
		if (!isTerminal && hasCorrelation(correlation)) {
			if (!activePrompt || activePrompt.settled) return;
			if (!activePrompt.acknowledged) {
				activePrompt.deferredFrames.push(frame);
				return;
			}
			if (!correlationsExactlyMatch(activePrompt.correlation, correlation)) return;
		}
		if (settledCorrelation) {
			// Frames for an already-settled correlation stay closed until an active prompt
			// acknowledges the exact same identity.
			if (activePrompt && !activePrompt.settled && !activePrompt.acknowledged) {
				activePrompt.deferredFrames.push(frame);
				return;
			}
			if (!activePrompt || activePrompt.settled || !correlationsMatch(activePrompt.correlation, correlation)) return;
		}
		const promptOwner =
			activePrompt &&
			!activePrompt.settled &&
			activePrompt.acknowledged &&
			correlationsExactlyMatch(activePrompt.correlation, correlation)
				? activePrompt
				: undefined;
		const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
		if (
			toolCallId &&
			(event.type === "tool_execution_start" || event.type === "tool_execution_update") &&
			"args" in event
		) {
			record.toolArgs.set(toolCallId, event.args);
		}
		const mapperOptions = {
			cwd: record.cwd,
			getToolArgs: (id: string) => record.toolArgs.get(id),
			getMessageProgress: (message: unknown) => {
				if (!object(message)) return undefined;
				if (promptOwner) {
					promptOwner.messageProgress ??= { textEmitted: false, thoughtEmitted: false };
					return promptOwner.messageProgress;
				}
				record.sessionMessageProgress ??= { textEmitted: false, thoughtEmitted: false };
				return record.sessionMessageProgress;
			},
		};
		const notifications = wirePayload
			? mapAgentWireEventPayloadToAcpSessionUpdates(wirePayload as never, id, mapperOptions)
			: event.type === "agent_failed" && object(event.error)
				? mapAgentSessionEventToAcpSessionUpdates(event as unknown as AgentSessionEvent, id, mapperOptions)
				: [];
		for (const notification of notifications) {
			if (
				promptOwner &&
				notification.update.sessionUpdate === "agent_message_chunk" &&
				notification.update.content.type === "text"
			)
				promptOwner.emittedAssistantText += notification.update.content.text;
			await this.#publishSessionUpdate(id, notification, adapter);
		}
		if (toolCallId && event.type === "tool_execution_end") record.toolArgs.delete(toolCallId);
		if (event.type === "agent_start") {
			await this.#publishSessionUpdate(
				id,
				{
					sessionId: id,
					update: {
						sessionUpdate: "session_info_update",
						updatedAt: new Date().toISOString(),
						_meta: { gjcPhase: "working", running: true, gjcRunning: true },
					},
				},
				adapter,
			);
		}
		if (event.type === "message_end" && object(event.message)?.role === "assistant") {
			if (promptOwner) promptOwner.messageProgress = undefined;
			else record.sessionMessageProgress = undefined;
		}
		if (event.type === "agent_end") {
			const finalText = typeof event.finalText === "string" ? event.finalText : "";
			if (promptOwner && finalText) {
				const resolution = resolveAcpFinalText(promptOwner.emittedAssistantText, finalText);
				if (resolution.kind === "emit") {
					promptOwner.emittedAssistantText += resolution.text;
					await this.#publishSessionUpdate(
						id,
						{
							sessionId: id,
							update: {
								sessionUpdate: "agent_message_chunk",
								content: { type: "text", text: resolution.text },
								...(resolution.final.truncated ? { _meta: { gjcFinalTextTruncated: true } } : {}),
							},
						},
						adapter,
					);
				} else if (resolution.kind === "divergent") {
					logger.warn("acp_final_text_diverged", {
						sessionId: id,
						...(promptOwner.correlation.commandId ? { commandId: promptOwner.correlation.commandId } : {}),
						...(promptOwner.correlation.turnId ? { turnId: promptOwner.correlation.turnId } : {}),
						streamedLength: promptOwner.emittedAssistantText.length,
						finalLength: resolution.final.text.length,
					});
				}
			}
		}
		// The terminal frame is the turn's end, so it settles the prompt before anything
		// else is asked of the session host. `#emitEndOfTurnUpdates` queries `context.get`
		// and `session.metadata`, and a host that stops producing the moment it publishes
		// its terminal answers neither: sequencing settlement behind those advisory
		// queries is what left a finished turn reported as running until the inactivity
		// watchdog rescued it.
		if (activePrompt) this.#settlePrompt(record, activePrompt);
		// agent_failed is correlated diagnostic state while the run is still live.
		// Only the authoritative agent_end boundary may publish end-of-turn usage,
		// title, and idle integration updates.
		if (event.type === "agent_end") await this.#emitEndOfTurnUpdates(id, adapter);
	}

	async #rejectPrompt(
		record: SessionRecord,
		id: string,
		waiter: PromptWaiter,
		error: AcpSdkAdapterError,
	): Promise<void> {
		if (record.activePrompt !== waiter || waiter.settled) return;
		record.activePrompt = undefined;
		clearPromptWatchdog(waiter);
		waiter.settled = true;
		waiter.deferredFrames.length = 0;
		waiter.deferredActivityFrames.length = 0;
		waiter.terminal = undefined;
		if (hasCompleteCorrelation(waiter.correlation)) {
			record.settledPromptCorrelations.push(waiter.correlation);
			while (record.settledPromptCorrelations.length > SETTLED_PROMPT_CORRELATION_RETENTION)
				record.settledPromptCorrelations.shift();
		}
		// The turn is over even though it ended badly, so the client's running phase has
		// to be released. Rejection is the settlement; the advisory idle publication must
		// never gate it (a backpressured transport would otherwise hold the rejection
		// forever). Skipping the idle publish entirely is what left a client composer
		// spinning on a turn that already produced its terminal.
		waiter.reject(error);
		void this.#publishPromptPhaseIdle(id, record.adapter);
	}

	/**
	 * Publishes only the phase transition — no `context.get`/`session.metadata` queries —
	 * because an abnormal settlement has no trustworthy usage or title to report. Publish
	 * failures are swallowed: the turn is already settled, and escalating to session
	 * failure here would tear down a session the client can still use. Callers must
	 * settle the prompt BEFORE invoking this (or detach it with `void`): `sessionUpdate`
	 * awaits the transport write, so awaiting it ahead of resolution lets a backpressured
	 * client hold the settlement hostage.
	 */
	async #publishPromptPhaseIdle(id: string, adapter: AcpSdkAdapter): Promise<void> {
		const record = this.#sessions.get(id);
		if (!record || record.adapter !== adapter) return;
		try {
			await this.#connection.sessionUpdate({
				sessionId: id,
				update: {
					sessionUpdate: "session_info_update",
					_meta: { gjcPhase: "idle", running: false, gjcRunning: false },
				},
			});
		} catch {
			// The client transport is gone; there is no phase left to restore.
		}
	}

	#settlePrompt(record: SessionRecord, waiter: PromptWaiter): void {
		if (record.activePrompt !== waiter || waiter.settled || !waiter.acknowledged || !waiter.terminal) return;
		// A terminal captured before acknowledgement is only this prompt's terminal when the
		// eventual acknowledgement correlates with it; otherwise it belonged to an earlier prompt.
		if (!correlationsExactlyMatch(waiter.correlation, waiter.terminal.correlation)) {
			waiter.terminal = undefined;
			return;
		}
		record.activePrompt = undefined;
		clearPromptWatchdog(waiter);
		waiter.settled = true;
		if (hasCorrelation(waiter.correlation)) {
			record.settledPromptCorrelations.push(waiter.correlation);
			while (record.settledPromptCorrelations.length > SETTLED_PROMPT_CORRELATION_RETENTION)
				record.settledPromptCorrelations.shift();
		}
		const { outcome } = waiter.terminal;
		if (outcome.kind === "stopped") {
			waiter.resolve({ stopReason: outcome.reason });
			return;
		}
		waiter.reject(new AcpSdkAdapterError(outcome.code, outcome.message));
	}

	async #emitEndOfTurnUpdates(id: string, adapter: AcpSdkAdapter): Promise<void> {
		let usage: JsonObject | undefined;
		let title: string | undefined;
		try {
			const response = object(await adapter.query("context.get"));
			const result = object(response?.result) ?? response;
			usage = object(result?.usage);
		} catch {
			// Context usage is advisory ACP metadata; prompt completion remains authoritative.
		}
		try {
			const response = object(await adapter.query("session.metadata"));
			const result = object(response?.result) ?? response;
			const metadata = pageItems(result)[0];
			const item = object(metadata);
			if (typeof item?.name === "string" && item.name) title = item.name;
		} catch {
			// Session naming is advisory; prompt completion remains authoritative.
		}
		// The prompt settled before these queries were asked, so a host that answers late
		// must not report the session idle after the next turn has already started.
		if (this.#sessions.get(id)?.activePrompt) return;
		if (typeof usage?.tokens === "number" && typeof usage.contextWindow === "number") {
			await this.#publishSessionUpdate(
				id,
				{
					sessionId: id,
					update: {
						sessionUpdate: "usage_update",
						size: usage.contextWindow,
						used: usage.tokens,
					},
				},
				adapter,
			);
		}
		const updatedAt = new Date().toISOString();
		this.#knownSessionMetadata.set(id, { ...(title ? { title } : {}), updatedAt });
		await this.#publishSessionUpdate(
			id,
			{
				sessionId: id,
				update: {
					sessionUpdate: "session_info_update",
					...(title ? { title } : {}),
					updatedAt,
					_meta: { gjcPhase: "idle", running: false, gjcRunning: false },
				},
			},
			adapter,
		);
	}

	async #publishSessionUpdate(
		id: string,
		notification: SessionNotification,
		expectedAdapter?: AcpSdkAdapter,
	): Promise<void> {
		// A session that is gone has no update channel, so this is a drop and not a failure:
		// whoever owned the frame is the one that ended the session. Callers whose bookkeeping
		// assumes delivery have to end at the session too — see `#replaySession`.
		const record = this.#sessions.get(id);
		if (!record || (expectedAdapter && record.adapter !== expectedAdapter)) return;
		try {
			await this.#connection.sessionUpdate(notification);
		} catch (error) {
			const failure = this.#frameProcessingFailure(error);
			await this.#failSession(id, record.adapter, failure);
			throw failure;
		}
	}

	async #sessionState(
		id: string,
		rejectUnavailableStartupPreset = false,
	): Promise<Pick<NewSessionResponse, "configOptions" | "modes">> {
		const record = this.#sessions.get(id);
		if (!record) throw new AcpSdkAdapterError("not_found", `Unknown session, not found: ${id}`);
		const modelPreset = this.#startupOptions?.modelPreset;
		const [config, sessionCatalog] = await Promise.all([
			record.adapter.query("config.list/get"),
			modelPreset === undefined
				? collectModelCatalogAndActiveProviders(record.adapter)
				: record.adapter
						.query("models.profiles.list")
						.then((profiles): { modelCatalog: unknown; activeProviders: undefined } => ({
							modelCatalog: profiles,
							activeProviders: undefined,
						})),
		]);
		// The active-provider walk overlaps the catalog inside the batch above, but
		// only after the first models.list/current page has finalized host-side
		// credential state, so catalog rows and provider availability never mix
		// pre- and post-refresh credential snapshots. Only an older session host
		// that rejects `providers.list/active` with `operation_not_session_owned`
		// falls back to the full catalog; operational failures fail closed so the
		// active-provider contract is not silently widened.
		const modelCatalog = sessionCatalog.modelCatalog;
		const activeProviders = sessionCatalog.activeProviders;
		record.authFailure = undefined;
		if (modelPreset !== undefined) {
			const activePreset = configValues(config).get(MODEL_PRESET_CONFIG_KEY);
			const activeProfile = pageItems(modelCatalog)
				.map(item => object(item))
				.find(item => item?.id === activePreset);
			if (activePreset && activeProfile?.available === false) {
				record.authFailure =
					`Model preset "${activePreset}" has no usable provider credentials. ` +
					"Authenticate the required provider in Gajae Code or select an available preset before prompting.";
				if (rejectUnavailableStartupPreset && activePreset === modelPreset)
					throw new AcpSdkAdapterError("authentication_failed", record.authFailure);
			}
		}
		return acpSessionStateFromConfig(config, modelCatalog, modelPreset, activeProviders);
	}

	async #publishAvailableCommands(id: string, adapter: AcpSdkAdapter): Promise<void> {
		let skills: unknown;
		try {
			skills = await adapter.query("skill.list/state");
		} catch {
			// Builtins remain useful when an older SDK host cannot expose skill state.
		}
		await this.#publishSessionUpdate(
			id,
			{
				sessionId: id,
				update: {
					sessionUpdate: "available_commands_update",
					availableCommands: acpAvailableCommandsFromSkills(skills),
				},
			},
			adapter,
		);
	}

	/**
	 * Reassembles a body-less `item_too_large` entry from the `continuations` the
	 * producer already published, reading each field replay consumes through the same
	 * `resource.body` query the descriptor names. Partial recovery is retained so a
	 * failed body continuation cannot discard tool-call identity needed to close an
	 * already-published pending call.
	 */
	async #recoverTranscriptEntry(adapter: AcpSdkAdapter, entry: JsonObject): Promise<JsonObject> {
		const continuations = transcriptContinuations(entry);
		const recovered: JsonObject = { ...entry };
		for (const field of RECOVERABLE_TRANSCRIPT_FIELDS) {
			const continuation = continuations.find(candidate => candidate.field === field);
			if (!continuation) continue;
			const body = await this.#readContinuation(adapter, continuation);
			const value = body === undefined ? undefined : decodeTranscriptContinuation(field, body);
			// A row that advertises `isError` but will not yield it leaves the outcome
			// unproven, so replay reports failure rather than claiming a success it cannot
			// read back. A row that never advertised the field simply had no error flag.
			if (value === undefined) {
				if (field === "isError") recovered.isError = true;
				continue;
			}
			recovered[field] = value;
		}
		return recovered;
	}

	/** Follows one continuation to its end, joining every page of that field's bytes. */
	async #readContinuation(adapter: AcpSdkAdapter, continuation: TranscriptContinuation): Promise<string | undefined> {
		const chunks: string[] = [];
		let cursor: string | undefined;
		for (let pageCount = 0; pageCount < MAX_ACP_REPLAY_PAGES; pageCount++) {
			let response: JsonObject | undefined;
			try {
				response = object(
					await adapter.query(
						continuation.query,
						cursor
							? {}
							: {
									resourceKind: continuation.resourceKind,
									resourceId: continuation.resourceId,
									revision: continuation.revision,
									itemId: continuation.itemId,
									field: continuation.field,
								},
						cursor,
					),
				);
			} catch {
				// A continuation that cannot be read costs one entry, never the whole
				// `session/load`; the caller reports the boundary instead.
				return undefined;
			}
			const result = object(response?.result) ?? response;
			const page = object(result?.page);
			const chunk = object(Array.isArray(page?.items) ? page.items[0] : undefined);
			if (typeof chunk?.body !== "string") return undefined;
			chunks.push(chunk.body);
			cursor = typeof page?.continuationCursor === "string" ? page.continuationCursor : undefined;
			if (!cursor) return chunks.join("");
		}
		return undefined;
	}

	/**
	 * Publishes the terminal update for one replayed tool call and reports whether the client
	 * took it. A `toolResult` replay cannot use leaves its already-published `tool_call` at
	 * `status: "pending"` forever, so replay closes it with the same `tool_execution_end`
	 * shape a real result uses. Replay cannot know the outcome, so it reports failure rather
	 * than claiming a success it cannot prove.
	 *
	 * Publication runs straight off the connection instead of through
	 * {@link AcpAgent.#publishSessionUpdate}: that helper fails the session and deletes its
	 * record on the first rejected frame, which turns every later close into a silent no-op
	 * and would strand every call queued behind the first refusal. The direct path still
	 * checks session ownership before every frame so a concurrent `session/close` stops it.
	 */
	async #closeReplayToolCall(
		id: string,
		expectedAdapter: AcpSdkAdapter,
		cwd: string,
		toolCallId: string,
		tool: { name: string; args: unknown },
		reason: string,
	): Promise<AcpSdkAdapterError | undefined> {
		try {
			for (const notification of mapAgentSessionEventToAcpSessionUpdates(
				{
					type: "tool_execution_end",
					toolCallId,
					toolName: tool.name,
					result: { content: [{ type: "text", text: reason }] },
					isError: true,
				} as never,
				id,
				{ cwd, getToolArgs: () => tool.args },
			)) {
				const record = this.#sessions.get(id);
				if (!record || record.adapter !== expectedAdapter) return undefined;
				await this.#connection.sessionUpdate(notification);
			}
			return undefined;
		} catch (error) {
			return this.#frameProcessingFailure(error);
		}
	}

	/**
	 * Closes every tool call still open when replay stops, in a single pass, and hands back
	 * the ones the client refused.
	 *
	 * An entry leaves `replayTools` only once its close was accepted. Removing it on the
	 * attempt is what made a refused close disappear from the map before anything could name
	 * it, so the one call the report exists to surface was the one call it never mentioned.
	 */
	async #closeOpenReplayToolCalls(
		id: string,
		adapter: AcpSdkAdapter,
		cwd: string,
		replayTools: Map<string, { name: string; args: unknown }>,
		reason: string,
	): Promise<UnclosedReplayToolCalls> {
		const unclosed: UnclosedReplayToolCalls = { unclosedToolCallIds: [], failures: [] };
		for (const [toolCallId, tool] of [...replayTools]) {
			const failure = await this.#closeReplayToolCall(id, adapter, cwd, toolCallId, tool, reason);
			if (failure === undefined) {
				replayTools.delete(toolCallId);
				continue;
			}
			unclosed.unclosedToolCallIds.push(toolCallId);
			unclosed.failures.push(failure);
		}
		return unclosed;
	}

	async #replaySession(id: string): Promise<void> {
		const adapter = this.#adapter(id);
		const record = this.#sessions.get(id);
		if (!record) return;
		const replayTools = new Map<string, { name: string; args: unknown }>();
		let replayFailure: unknown;
		try {
			await this.#replayTranscriptPages(id, adapter, record, replayTools);
		} catch (error) {
			replayFailure = error;
		}
		// Every terminal below is addressed to this session, and `session/close`, a failed
		// session, or connection teardown can remove it mid-replay. That removal takes the
		// client's view of these calls with it: nothing is left to observe a `pending` one,
		// and a frame carrying a closed session id is one the client asked to stop receiving.
		// The obligation ends where the session ends; the next `session/load` replays the same
		// transcript rows from scratch. The boundary check avoids entering cleanup for an
		// already-closed session, while `#closeReplayToolCall` repeats the ownership check before
		// each direct publication so a close during cleanup stops the remaining frames without
		// restoring the failure side effects that used to silence calls behind a refused close.
		if (this.#sessions.get(id)?.adapter !== adapter) return;
		// The one boundary that closes replayed tool calls, covering every way the replay body
		// can end: normal return, early exit, or a `transcript.list` page that throws. Whatever
		// is still open was abandoned mid-replay, so it reaches a terminal status now instead of
		// spinning at `pending` for the life of the session.
		const unclosed = await this.#closeOpenReplayToolCalls(
			id,
			adapter,
			record.cwd,
			replayTools,
			replayFailure === undefined ? TRANSCRIPT_TOOL_CALL_UNRESOLVED : TRANSCRIPT_REPLAY_INTERRUPTED,
		);
		if (unclosed.unclosedToolCallIds.length === 0) {
			if (replayFailure !== undefined) throw replayFailure;
			return;
		}
		const cleanupFailure = aggregateAcpFailure(
			"frame_processing_failed",
			`ACP transcript replay could not close published tool calls: ${unclosed.unclosedToolCallIds.join(", ")}`,
			unclosed.failures,
		);
		// A client refusing this session's frames leaves no usable record behind, but teardown
		// runs only after every open call has been attempted and every refusal named above.
		await this.#failSession(id, adapter, cleanupFailure);
		if (replayFailure === undefined) throw cleanupFailure;
		// Both facts matter: what stopped replay, and which calls it left open. Reporting
		// only one is what kept a whole session's orphaned tool calls invisible.
		const detail = [replayFailure, cleanupFailure]
			.map(failure => (failure instanceof Error ? failure.message : String(failure)))
			.join("; ");
		throw aggregateAcpFailure(
			"frame_processing_failed",
			`ACP transcript replay failed and left published tool calls unclosed: ${detail}`,
			[replayFailure, cleanupFailure],
		);
	}

	/**
	 * Walks the transcript pages for {@link AcpAgent.#replaySession}. `replayTools` stays
	 * owned by the caller so every start this pass published is still closable once it
	 * exits, however it exits.
	 */
	async #replayTranscriptPages(
		id: string,
		adapter: AcpSdkAdapter,
		record: SessionRecord,
		replayTools: Map<string, { name: string; args: unknown }>,
	): Promise<void> {
		let cursor: string | undefined;
		let imageLimitationReported = false;
		let unreplayableEntries = 0;
		let unreplayableReason: TranscriptReplaySkipReason | undefined;
		for (let pageCount = 0; pageCount < MAX_ACP_REPLAY_PAGES; pageCount++) {
			const response = object(await adapter.query("transcript.list", {}, cursor));
			const result = object(response?.result) ?? response;
			const page = object(result?.page);
			for (const item of Array.isArray(page?.items) ? page.items : []) {
				const raw = object(item);
				if (!raw) continue;
				// A body-less row is usually an oversized message, not a malformed entry:
				// its `continuations` say exactly how to read it back, so replay follows
				// them instead of dropping the largest message in the session.
				const message = typeof raw.body === "string" ? raw : await this.#recoverTranscriptEntry(adapter, raw);
				const replay = transcriptReplayContent(message);
				if (!replay.replayable) {
					unreplayableEntries++;
					unreplayableReason ??= replay.reason;
					const unresolvedId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
					const unresolved = unresolvedId === undefined ? undefined : replayTools.get(unresolvedId);
					// The start keeps its place in `replayTools` until the close is accepted, so a
					// refused close is retried and named by the boundary instead of dropped here.
					if (unresolvedId !== undefined && unresolved) {
						const failure = await this.#closeReplayToolCall(
							id,
							adapter,
							record.cwd,
							unresolvedId,
							unresolved,
							TRANSCRIPT_TOOL_RESULT_UNAVAILABLE,
						);
						if (failure === undefined) replayTools.delete(unresolvedId);
					}
					continue;
				}
				const content = replay.content;
				if (!imageLimitationReported) {
					imageLimitationReported = true;
					await this.#publishSessionUpdate(
						id,
						{
							sessionId: id,
							update: {
								sessionUpdate: "session_info_update",
								_meta: { gjcTranscriptImageReplay: content.images },
							},
						},
						adapter,
					);
				}
				const messageId = typeof message.id === "string" ? message.id : undefined;
				const richContent = Array.isArray(message.content) ? message.content : undefined;
				if ((message.role === "user" || message.role === "assistant") && richContent) {
					for (const rawBlock of richContent) {
						const block = object(rawBlock);
						if (!block || typeof block.type !== "string") continue;
						if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
							await this.#publishSessionUpdate(
								id,
								{
									sessionId: id,
									update: {
										sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
										content: { type: "text", text: block.text },
										...(messageId ? { messageId } : {}),
									},
								},
								adapter,
							);
						} else if (
							message.role === "assistant" &&
							block.type === "thinking" &&
							typeof block.thinking === "string" &&
							block.thinking.length > 0
						) {
							await this.#publishSessionUpdate(
								id,
								{
									sessionId: id,
									update: {
										sessionUpdate: "agent_thought_chunk",
										content: { type: "text", text: block.thinking },
										...(messageId ? { messageId } : {}),
									},
								},
								adapter,
							);
						} else if (
							message.role === "assistant" &&
							block.type === "toolCall" &&
							typeof block.id === "string" &&
							typeof block.name === "string"
						) {
							const args = block.arguments ?? {};
							replayTools.set(block.id, { name: block.name, args });
							await this.#publishSessionUpdate(
								id,
								{
									sessionId: id,
									update: buildToolCallStartUpdate({
										toolCallId: block.id,
										toolName: block.name,
										args,
										cwd: record.cwd,
									}),
								},
								adapter,
							);
						}
					}
					continue;
				}
				if (message.role === "toolResult" && typeof message.toolCallId === "string") {
					const replayTool = replayTools.get(message.toolCallId);
					// Pairing outranks content: publishing a result whose `tool_call` start
					// never reached the client renders an update for a call it never saw begin.
					if (!replayTool) {
						unreplayableEntries++;
						unreplayableReason ??= "transcript_tool_call_unavailable";
						continue;
					}
					// The start already named the call, so a result row that lost its own name
					// falls back to it rather than dropping a result the client can still place.
					const toolName =
						typeof message.toolName === "string" && message.toolName ? message.toolName : replayTool.name;
					// A start with no usable name anywhere still has to reach a terminal status:
					// skipping it here is what left the call spinning at `pending` forever.
					if (!toolName) {
						unreplayableEntries++;
						unreplayableReason ??= "transcript_tool_call_unavailable";
						// The start keeps its place in `replayTools` until the close is accepted, so a
						// refused close is retried and named by the boundary instead of dropped here.
						const failure = await this.#closeReplayToolCall(
							id,
							adapter,
							record.cwd,
							message.toolCallId,
							replayTool,
							TRANSCRIPT_TOOL_RESULT_UNAVAILABLE,
						);
						if (failure === undefined) replayTools.delete(message.toolCallId);
						continue;
					}
					const resultContent = richContent
						?.map(object)
						.filter(
							(block): block is JsonObject =>
								block !== undefined && block.type === "text" && typeof block.text === "string",
						)
						.map(block => ({ type: "text" as const, text: String(block.text) }));
					for (const notification of mapAgentSessionEventToAcpSessionUpdates(
						{
							type: "tool_execution_end",
							toolCallId: message.toolCallId,
							toolName,
							result: { content: resultContent ?? content.blocks },
							isError: message.isError === true,
						} as never,
						id,
						{ cwd: record.cwd, getToolArgs: toolCallId => replayTools.get(toolCallId)?.args },
					)) {
						await this.#publishSessionUpdate(id, notification, adapter);
					}
					replayTools.delete(message.toolCallId);
					continue;
				}
				if (message.role !== "user" && message.role !== "assistant") continue;
				for (const block of content.blocks) {
					await this.#publishSessionUpdate(
						id,
						{
							sessionId: id,
							update: {
								sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
								content: block,
								...(messageId ? { messageId } : {}),
							},
						},
						adapter,
					);
				}
			}
			cursor = typeof page?.continuationCursor === "string" ? page.continuationCursor : undefined;
			if (cursor) continue;
			// Every start still parked here outlived its result row. `#replaySession` owns the
			// close at its single boundary, so this pass only accounts for them.
			if (replayTools.size > 0) {
				unreplayableEntries += replayTools.size;
				unreplayableReason ??= "transcript_tool_call_unavailable";
			}
			// An entry without its production body is skipped, never fatal: losing one
			// transcript row must not revoke `session/load` for the whole session.
			if (unreplayableReason)
				await this.#publishSessionUpdate(
					id,
					{
						sessionId: id,
						update: {
							sessionUpdate: "session_info_update",
							_meta: {
								gjcTranscriptReplaySkipped: { count: unreplayableEntries, reason: unreplayableReason },
							},
						},
					},
					adapter,
				);
			return;
		}
		throw new AcpSdkAdapterError("resource_exhausted", "ACP transcript replay exceeded the page limit.");
	}

	/**
	 * Bootstrap updates must reach the client only after the request that introduced the
	 * session has resolved. `session/new` and `session/resume` carry the sessionId in
	 * their response, so a `session/update` published first names a session the client
	 * has never seen and is dropped — which is how the skill list went missing in Paseo.
	 * The ACP session-setup sequence shows updates before the response only for
	 * `session/load`.
	 */
	#scheduleBootstrap(id: string): void {
		// A macrotask runs after the microtask that resolves this request and writes its
		// response, so the client always learns the sessionId first. Scheduling therefore
		// has to happen once the response payload is ready, not before the session-state
		// queries that produce it.
		setTimeout(() => {
			const record = this.#sessions.get(id);
			if (!record || this.#connection.signal.aborted) return;
			void (async () => {
				await this.#publishAvailableCommands(id, record.adapter);
				if (record.authFailure) {
					await this.#publishSessionUpdate(
						id,
						{
							sessionId: id,
							update: {
								sessionUpdate: "agent_thought_chunk",
								content: { type: "text", text: `[error:auth] ${record.authFailure}\n` },
							},
						},
						record.adapter,
					);
				}
				// Not consumed on publish: this mirrors authFailure's lifecycle, where a
				// later load/resume legitimately re-announces the condition. Clearing here
				// would also lose the warning outright if the publish below rejected, since
				// the enclosing bootstrap task swallows failures.
				if (record.routingInactiveNotice) {
					const message = record.routingInactiveNotice;
					await this.#publishSessionUpdate(
						id,
						{
							sessionId: id,
							update: {
								sessionUpdate: "agent_thought_chunk",
								content: { type: "text", text: `[warning:autorouting] ${message}\n` },
							},
						},
						record.adapter,
					);
				}
				await this.#publishSessionUpdate(
					id,
					{
						sessionId: id,
						update: {
							sessionUpdate: "session_info_update",
							_meta: { gjcPhase: "idle", running: false, gjcRunning: false },
						},
					},
					record.adapter,
				);
			})().catch(() => undefined);
		});
	}

	#cursor(cursor: string | null | undefined): number {
		if (!cursor) return 0;
		const value = Number.parseInt(cursor, 10);
		if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ACP session cursor: ${cursor}`);
		return value;
	}

	#assertAbsoluteCwd(cwd: string): void {
		if (!path.isAbsolute(cwd)) throw new Error(`ACP cwd must be an absolute path: ${cwd}`);
	}

	#assertNoAdditionalDirectories(directories: string[] | null | undefined): void {
		if (directories && directories.length > 0)
			throw new AcpSdkAdapterError("unsupported", "ACP additional directories are not supported.");
	}

	#mcpServers(params: { mcpServers?: unknown[] }): SessionLifecycleMcpServer[] {
		const servers = params.mcpServers ?? [];
		if (servers.length > 64)
			throw new AcpSdkAdapterError("unsupported", "ACP supports at most 64 MCP servers per session.");
		const result: SessionLifecycleMcpServer[] = [];
		const names = new Set<string>();
		for (const value of servers) {
			if (typeof value !== "object" || value === null || Array.isArray(value))
				throw new AcpSdkAdapterError("invalid_input", "ACP MCP server definitions must be objects.");
			const server = value as Record<string, unknown>;
			if (typeof server.name !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(server.name) || names.has(server.name))
				throw new AcpSdkAdapterError("invalid_input", "ACP MCP servers must have unique safe names.");
			names.add(server.name);
			if (server.type === "http" || server.type === "sse") {
				if (
					typeof server.url !== "string" ||
					server.url.length > 8_192 ||
					!Array.isArray(server.headers) ||
					server.headers.length > 100
				)
					throw new AcpSdkAdapterError("invalid_input", "ACP remote MCP servers require a valid URL and headers.");
				let parsedUrl: URL;
				try {
					parsedUrl = new URL(server.url);
				} catch {
					throw new AcpSdkAdapterError("invalid_input", "ACP MCP URL is invalid.");
				}
				if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")
					throw new AcpSdkAdapterError("invalid_input", "ACP MCP URLs must use HTTP or HTTPS.");
				const headers: Record<string, string> = {};
				for (const value of server.headers) {
					const header = object(value);
					if (
						typeof header?.name !== "string" ||
						header.name.length === 0 ||
						header.name.length > 256 ||
						header.name.includes("\r") ||
						header.name.includes("\n") ||
						typeof header.value !== "string" ||
						header.value.length > 8_192 ||
						header.value.includes("\r") ||
						header.value.includes("\n") ||
						Object.hasOwn(headers, header.name)
					)
						throw new AcpSdkAdapterError(
							"invalid_input",
							"ACP MCP headers must have unique valid names and values.",
						);
					headers[header.name] = header.value;
				}
				result.push({
					type: server.type,
					name: server.name,
					url: parsedUrl.toString(),
					...(Object.keys(headers).length > 0 ? { headers } : {}),
				});
				continue;
			}
			if (
				(server.type !== undefined && server.type !== "stdio") ||
				typeof server.command !== "string" ||
				server.command.length > 4_096 ||
				!path.isAbsolute(server.command) ||
				!Array.isArray(server.args) ||
				server.args.length > 100 ||
				!server.args.every(argument => typeof argument === "string" && argument.length <= 8_192) ||
				!Array.isArray(server.env) ||
				server.env.length > 100
			)
				throw new AcpSdkAdapterError(
					"invalid_input",
					"ACP stdio MCP servers require an absolute command and bounded arguments and environment variables.",
				);
			const env: Record<string, string> = {};
			for (const value of server.env) {
				const variable = object(value);
				if (
					typeof variable?.name !== "string" ||
					!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name) ||
					typeof variable.value !== "string" ||
					variable.value.length > 32_768 ||
					Object.hasOwn(env, variable.name)
				)
					throw new AcpSdkAdapterError(
						"invalid_input",
						"ACP MCP environment variables must have unique valid names and string values.",
					);
				env[variable.name] = variable.value;
			}
			result.push({
				name: server.name,
				command: server.command,
				args: server.args as string[],
				...(Object.keys(env).length > 0 ? { env } : {}),
			});
		}
		return result;
	}

	async #launchSessionWithMcp(
		operation: "session.create" | "session.fork" | "session.resume",
		input: JsonObject,
		idempotencyKey: string,
		mcpServers: SessionLifecycleMcpServer[],
	): Promise<unknown> {
		try {
			return await (await this.#brokerAdapter()).lifecycle(operation, input, idempotencyKey);
		} catch (error) {
			throw acpMcpLaunchFailure(error, mcpServers);
		}
	}

	#beginDispose(): void {
		if (this.#disposePromise) return;
		this.#disposePromise = this.#dispose();
		// AbortSignal listeners cannot return a promise to their caller. Retain the
		// aggregate cleanup result while attaching a rejection handler so disposal
		// never creates a detached unhandled rejection.
		void this.#disposePromise.catch(() => undefined);
	}

	async #dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		const failures: unknown[] = [];
		for (const id of [...this.#sessions.keys()]) {
			try {
				await this.#teardownSession(id, "connection closed", false);
			} catch (error) {
				failures.push(error);
			}
		}
		this.#attaching.clear();
		this.#resolvingExisting.clear();
		this.#knownSessionCwds.clear();
		this.#ownedSessionIds.clear();
		this.#knownSessionMcpServers.clear();
		this.#knownSessionMetadata.clear();
		this.#pendingDeleteLocators.clear();
		this.#pendingCloseIdempotencyKeys.clear();
		if (this.#lifecycleOperations.size === 0) this.#lifecycleOperations.clear();
		this.#tearingDown.clear();
		if (this.#broker) {
			const broker = this.#broker;
			this.#broker = undefined;
			try {
				await (await broker).adapter.close();
			} catch (error) {
				failures.push(error);
			}
		}
		this.#pendingRouterAdapters.clear();
		this.#pendingRouterFrames.clear();
		try {
			await this.#router.stop();
		} catch (error) {
			failures.push(error);
		}
		if (failures.length > 0) {
			const detail = failures
				.map(failure => (failure instanceof Error ? failure.message : String(failure)))
				.join("; ");
			throw aggregateAcpFailure("terminal_uncertain", `ACP connection cleanup is uncertain: ${detail}`, failures);
		}
	}
}
