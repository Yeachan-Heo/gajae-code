/**
 * Shared agent-wire protocol primitives for GJC bridge surfaces.
 *
 * The canonical event/frame contract now lives in `event-contract.ts`. This
 * module re-exports it under the historical `Bridge*` names so existing RPC and
 * Bridge code keeps compiling while the adapters migrate to the canonical
 * `AgentWire*` names. See `.gjc/specs/deep-interview-reconcile-rpc-adapters.md`.
 */
import type {
	AgentWireEventFrame,
	AgentWireEventPayload,
	AgentWireEventType,
	AgentWireFrameEnvelope,
	AgentWireFrameType,
} from "./event-contract";
import { AGENT_WIRE_EVENT_TYPES, AGENT_WIRE_PROTOCOL_VERSION } from "./event-contract";

/** Wire protocol version. Bump on breaking envelope/semantic changes. */
export const BRIDGE_PROTOCOL_VERSION = AGENT_WIRE_PROTOCOL_VERSION;

/** The discriminant of every `AgentSessionEvent` the agent can emit. */
export type AgentSessionEventType = AgentWireEventType;

/** Every agent-session event type, derived from the exhaustive registry. */
export const AGENT_SESSION_EVENT_TYPES: readonly AgentSessionEventType[] = AGENT_WIRE_EVENT_TYPES;

/** Top-level frame categories carried over any bridge transport. */
export type BridgeFrameType = AgentWireFrameType;

/** Universal frame envelope. See {@link AgentWireFrameEnvelope}. */
export type BridgeFrameEnvelope<
	TType extends BridgeFrameType = BridgeFrameType,
	TPayload = unknown,
> = AgentWireFrameEnvelope<TType, TPayload>;

/** Payload carried by an `event` frame. See {@link AgentWireEventPayload}. */
export type BridgeEventPayload = AgentWireEventPayload;

/** An `AgentSessionEvent` serialized into a versioned wire frame. */
export type BridgeEventFrame = AgentWireEventFrame;

/** A `workflow_gate` event serialized into a versioned wire frame (#321). */
export type BridgeWorkflowGateFrame = BridgeFrameEnvelope<
	"workflow_gate",
	import("../../rpc/rpc-types").RpcWorkflowGate
>;
