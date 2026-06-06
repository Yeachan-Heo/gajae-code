/**
 * Shared agent-wire protocol primitives for GJC bridge surfaces.
 *
 * This module is the transport-agnostic, versioned frame contract that the
 * RPC mode and the (in-progress) `--mode bridge` wiring site both build on.
 * It carries the SEMANTIC agent surface — events, responses, and UI/permission
 * requests — never pixels. See `.gjc/specs/deep-interview-gjc-backend-bridge.md`
 * and `.gjc/plans/ralplan/gjc-backend-bridge/pending-approval.md`.
 */
import type { AgentSessionEvent } from "../../../session/agent-session";

/** Wire protocol version. Bump on breaking envelope/semantic changes. */
export const BRIDGE_PROTOCOL_VERSION = 1 as const;

/** The discriminant of every `AgentSessionEvent` the agent can emit. */
export type AgentSessionEventType = AgentSessionEvent["type"];

/**
 * Compile-time exhaustive registry of every `AgentSessionEvent` variant.
 *
 * Adding a new variant to `AgentSessionEvent` without registering it here is a
 * type error. This keeps the bridge wire surface in lockstep with the agent
 * event union — the "event/element drift → silent incompleteness" mitigation
 * from the plan's pre-mortem.
 */
const AGENT_SESSION_EVENT_TYPE_REGISTRY: Record<AgentSessionEventType, true> = {
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
	notice: true,
	thinking_level_changed: true,
	goal_updated: true,
};

/** Every agent-session event type, derived from the exhaustive registry. */
export const AGENT_SESSION_EVENT_TYPES: readonly AgentSessionEventType[] = Object.keys(
	AGENT_SESSION_EVENT_TYPE_REGISTRY,
) as AgentSessionEventType[];

/** Top-level frame categories carried over any bridge transport. */
export type BridgeFrameType =
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
 * request/response pairs (`correlation_id`). `session_id` is present from v1
 * even though v1 runs one session per process, so in-process multiplexing is
 * an additive, non-breaking change later.
 */
export interface BridgeFrameEnvelope<TType extends BridgeFrameType = BridgeFrameType, TPayload = unknown> {
	protocol_version: typeof BRIDGE_PROTOCOL_VERSION;
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

/** Payload carried by an `event` frame. */
export interface BridgeEventPayload {
	event_type: AgentSessionEventType;
	event: AgentSessionEvent;
}

/** An `AgentSessionEvent` serialized into a versioned wire frame. */
export type BridgeEventFrame = BridgeFrameEnvelope<"event", BridgeEventPayload>;

/** A `workflow_gate` event serialized into a versioned wire frame (#321). */
export type BridgeWorkflowGateFrame = BridgeFrameEnvelope<
	"workflow_gate",
	import("../../rpc/rpc-types").RpcWorkflowGate
>;
