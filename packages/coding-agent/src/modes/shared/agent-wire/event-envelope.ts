/**
 * Serialize `AgentSessionEvent`s into versioned agent-wire frames.
 *
 * The mapping is intentionally exhaustive: `agentSessionEventType` switches over
 * every variant of the event union and calls `assertNever` in the default arm,
 * so a newly added event variant fails to compile until it is handled here.
 *
 * The canonical sequencer + frame builders live here; the historical `Bridge*`
 * names are retained as thin aliases for callers that have not yet migrated.
 */
import { randomUUID } from "node:crypto";
import type { AgentSessionEvent } from "../../../session/agent-session";
import {
	AGENT_WIRE_PROTOCOL_VERSION,
	type AgentWireEventFrame,
	type AgentWireEventPayload,
	type AgentWireEventType,
	type AgentWireFrameEnvelope,
	type AgentWireFrameType,
} from "./event-contract";

function assertNever(value: never): never {
	throw new Error(`Unhandled AgentSessionEvent variant: ${JSON.stringify(value)}`);
}

/**
 * Resolve the stable wire event-type for an `AgentSessionEvent`.
 *
 * Exhaustive over the union; adding a variant without a case is a type error.
 */
export function agentSessionEventType(event: AgentSessionEvent): AgentWireEventType {
	switch (event.type) {
		case "agent_start":
		case "agent_end":
		case "turn_start":
		case "turn_end":
		case "message_start":
		case "message_update":
		case "message_end":
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end":
		case "auto_compaction_start":
		case "auto_compaction_end":
		case "auto_retry_start":
		case "auto_retry_end":
		case "retry_fallback_applied":
		case "retry_fallback_succeeded":
		case "ttsr_triggered":
		case "todo_reminder":
		case "todo_auto_clear":
		case "irc_message":
		case "subagent_steer_message":
		case "notice":
		case "thinking_level_changed":
		case "goal_updated":
			return event.type;
		default:
			return assertNever(event);
	}
}

/**
 * Per-session monotonic frame builder. One instance per active session; `seq`
 * starts at 1 and increments per frame so clients can order and resume.
 */
export class AgentWireFrameSequencer {
	readonly #sessionId: string;
	#seq = 0;

	constructor(sessionId: string) {
		this.#sessionId = sessionId;
	}

	/** The session id stamped onto every frame this sequencer produces. */
	get sessionId(): string {
		return this.#sessionId;
	}

	/** The seq assigned to the most recently produced frame (0 before any). */
	get lastSeq(): number {
		return this.#seq;
	}

	/** Build the next envelope of the given type with a fresh seq + frame id. */
	next<TType extends AgentWireFrameType, TPayload>(
		type: TType,
		payload: TPayload,
		correlationId?: string,
	): AgentWireFrameEnvelope<TType, TPayload> {
		this.#seq += 1;
		const frame: AgentWireFrameEnvelope<TType, TPayload> = {
			protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
			session_id: this.#sessionId,
			seq: this.#seq,
			frame_id: randomUUID(),
			type,
			payload,
		};
		if (correlationId !== undefined) {
			frame.correlation_id = correlationId;
		}
		return frame;
	}
}

/** Back-compat alias for {@link AgentWireFrameSequencer}. */
export const BridgeFrameSequencer = AgentWireFrameSequencer;
export type BridgeFrameSequencer = AgentWireFrameSequencer;

/** Serialize a single `AgentSessionEvent` into a canonical `event` wire frame. */
export function toAgentWireEventFrame(
	event: AgentSessionEvent,
	sequencer: AgentWireFrameSequencer,
): AgentWireEventFrame {
	return sequencer.next("event", {
		event_type: agentSessionEventType(event),
		event,
	});
}

/** Build the rich event payload (renderer-facing) for an `AgentSessionEvent`. */
export function toAgentWireEventPayload(event: AgentSessionEvent): AgentWireEventPayload {
	return { event_type: agentSessionEventType(event), event };
}

/** Back-compat alias for {@link toAgentWireEventFrame}. */
export const toBridgeEventFrame = toAgentWireEventFrame;

/**
 * Serialize a `workflow_gate` event into a sequenced wire frame (#321). The
 * gate_id is stamped as the correlation id so the answer (posted to the
 * ui-responses endpoint) can be matched, and the monotonic `seq` gives replay
 * while `frame_id` + gate_id give idempotency.
 */
export function toBridgeWorkflowGateFrame(
	gate: import("../../rpc/rpc-types").RpcWorkflowGate,
	sequencer: AgentWireFrameSequencer,
): import("./protocol").BridgeWorkflowGateFrame {
	return sequencer.next("workflow_gate", gate, gate.gate_id);
}
