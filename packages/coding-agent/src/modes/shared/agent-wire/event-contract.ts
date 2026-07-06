/**
 * Canonical agent-wire contract: the single transport-neutral source of truth
 * for AgentSession events and bounded owner observations.
 *
 * Two distinct consumer-facing shapes, deliberately NOT collapsed into one:
 * - `AgentWireEventPayload`: rich, full `AgentSessionEvent` for renderers
 *   (ACP SDK notifications, RPC/Bridge event frames).
 * - `AgentWireOwnerObservation`: bounded/redacted owner evidence for control
 *   planes (Harness). Never carries assistant text, message deltas, raw tool
 *   args, raw command output, raw tool results, answers, or oversize strings.
 *
 * The exhaustive `AGENT_SESSION_EVENT_TYPE_REGISTRY` lives here so that adding
 * an `AgentSessionEvent` variant fails typecheck until it is registered, and so
 * conformance tests can assert fixture coverage equals the registry exactly.
 */

import type { AssistantMessageEvent } from "@gajae-code/ai";
import type { AgentSessionEvent } from "../../../session/agent-session";

/** Wire protocol version. Bump on breaking envelope/semantic changes. */
export const AGENT_WIRE_PROTOCOL_VERSION = 2 as const;
export type AgentWireProtocolVersion = typeof AGENT_WIRE_PROTOCOL_VERSION;

/** The discriminant of every `AgentSessionEvent` the agent can emit. */
export type AgentWireEventType = AgentSessionEvent["type"];

/**
 * Compile-time exhaustive registry of every `AgentSessionEvent` variant. The
 * `Record<AgentWireEventType, true>` shape forces every member to be present:
 * a new union variant is a type error until added here, and a removed variant
 * is a type error until deleted.
 */
const AGENT_SESSION_EVENT_TYPE_REGISTRY: Record<AgentWireEventType, true> = {
	agent_start: true,
	agent_end: true,
	turn_start: true,
	turn_end: true,
	message_start: true,
	message_update: true,
	message_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
	auto_compaction_start: true,
	auto_compaction_end: true,
	auto_retry_start: true,
	auto_retry_end: true,
	retry_fallback_applied: true,
	retry_fallback_succeeded: true,
	ttsr_triggered: true,
	todo_reminder: true,
	todo_auto_clear: true,
	irc_message: true,
	subagent_steer_message: true,
	notice: true,
	thinking_level_changed: true,
	goal_updated: true,
};

/** Every agent-session event type, derived from the exhaustive registry. */
export const AGENT_WIRE_EVENT_TYPES: readonly AgentWireEventType[] = Object.keys(
	AGENT_SESSION_EVENT_TYPE_REGISTRY,
) as AgentWireEventType[];

/**
 * Rich event payload. Carries the full `AgentSessionEvent` so renderers (ACP,
 * RPC, Bridge) can present message content, tool args/results, todo state, etc.
 */
export interface AgentWireEventPayload {
	event_type: AgentWireEventType;
	event: AgentSessionEvent;
}
export type AgentWireCompactAssistantMessageEvent = AssistantMessageEvent extends infer TEvent
	? TEvent extends { type: string }
		? Omit<TEvent, "partial" | "message" | "error">
		: never
	: never;

export interface AgentWireCompactMessageUpdatePayload {
	event_type: "message_update";
	/** Compact RPC opt-in payload: delta-only update plus minimal routing metadata. */
	compact: true;
	message_id: string | null;
	content_index: number | null;
	assistantMessageEvent: AgentWireCompactAssistantMessageEvent;
	/** Full message checkpoint, snapshotted synchronously when this frame is enqueued. */
	checkpoint_message?: Extract<AgentSessionEvent, { type: "message_update" }>["message"];
	checkpoint_reason?: "periodic";
}

export type AgentWireEventFramePayload = AgentWireEventPayload | AgentWireCompactMessageUpdatePayload;

/**
 * Bounded observed-signal vocabulary surfaced to owner control planes. Mirrors
 * the Harness `ObservedSignal` set; the Harness type aliases this in a later
 * step so there is a single source of truth.
 */
export type AgentWireObservedSignal =
	| "SessionStart"
	| "prompt-accepted"
	| "tool-call"
	| "test-running"
	| "commit-created"
	| "completed"
	| "error"
	| "streaming"
	| "idle";

export type AgentWireSeverity = "info" | "warn" | "critical";

/**
 * Bounded, redacted owner observation. Evidence may include ids, names,
 * categories, statuses, cursors, timestamps, short codes, and bounded short
 * messages ONLY. It must never carry assistant text, message deltas, raw tool
 * args, raw command output, raw tool result content, answers, or oversize
 * strings.
 */
export interface AgentWireOwnerObservation {
	/** Set when this observation derives from an `AgentSessionEvent`. */
	eventType?: AgentWireEventType;
	/** Set when this observation derives from a non-event wire frame. */
	frameType?: string;
	/** Owner event kind (e.g. `rpc_tool_started`). */
	kind: string;
	/** Bounded observed signal, or null when the frame carries no signal. */
	signal: AgentWireObservedSignal | null;
	/** Bounded evidence — ids/names/statuses/cursors/timestamps/short codes only. */
	evidence: Record<string, unknown>;
	/** Severity for the emitted event. */
	severity: AgentWireSeverity;
	/** Never-drop observations: must be enqueued in order, never coalesced away. */
	semantic: boolean;
	/** Coalescing key for high-frequency non-semantic frames; null otherwise. */
	coalesceKey: string | null;
}

/** Top-level frame categories carried over any agent-wire transport. */
export type AgentWireFrameType =
	| "ready"
	| "event"
	| "response"
	| "ui_request"
	| "permission_request"
	| "host_tool_call"
	| "host_uri_request"
	| "reset"
	| "workflow_gate"
	| "error";

/**
 * Universal frame envelope. Every frame on every transport carries these
 * fields so clients can order (`seq`), resume (`seq` cursor), and correlate
 * request/response pairs (`correlation_id`).
 */
export interface AgentWireFrameEnvelope<TType extends AgentWireFrameType = AgentWireFrameType, TPayload = unknown> {
	protocol_version: AgentWireProtocolVersion;
	session_id: string;
	/** Monotonic per-session sequence number, starting at 1. */
	seq: number;
	/** Unique id for this frame. */
	frame_id: string;
	/** Ties a request frame to its response frame, when applicable. */
	correlation_id?: string;
	type: TType;
	payload: TPayload;
}

/** An `AgentSessionEvent` serialized into a versioned wire frame. */
export type AgentWireEventFrame = AgentWireFrameEnvelope<"event", AgentWireEventPayload>;
export type AgentWireCompactEventFrame = AgentWireFrameEnvelope<"event", AgentWireEventFramePayload>;
