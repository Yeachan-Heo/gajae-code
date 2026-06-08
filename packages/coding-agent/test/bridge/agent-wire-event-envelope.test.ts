import { describe, expect, it } from "bun:test";
import {
	agentSessionEventType,
	BridgeFrameSequencer,
	toBridgeEventFrame,
} from "../../src/modes/shared/agent-wire/event-envelope";
import { AGENT_SESSION_EVENT_TYPES, BRIDGE_PROTOCOL_VERSION } from "../../src/modes/shared/agent-wire/protocol";
import type { AgentSessionEvent } from "../../src/session/agent-session";

/** Minimal stand-in event whose only meaningful field is the discriminant. */
function eventOfType(type: AgentSessionEvent["type"]): AgentSessionEvent {
	return { type } as unknown as AgentSessionEvent;
}

describe("agent-wire event envelope", () => {
	it("enumerates every AgentSessionEvent variant exactly once", () => {
		const unique = new Set(AGENT_SESSION_EVENT_TYPES);
		expect(unique.size).toBe(AGENT_SESSION_EVENT_TYPES.length);
		// Spot-check representative members across both source unions.
		expect(unique.has("agent_start")).toBe(true);
		expect(unique.has("message_update")).toBe(true);
		expect(unique.has("tool_execution_end")).toBe(true);
		expect(unique.has("goal_updated")).toBe(true);
		expect(unique.has("irc_message")).toBe(true);
	});

	it("maps each event variant to its own wire type", () => {
		for (const type of AGENT_SESSION_EVENT_TYPES) {
			expect(agentSessionEventType(eventOfType(type))).toBe(type);
		}
	});

	it("wraps an event in a versioned, session-scoped frame", () => {
		const seq = new BridgeFrameSequencer("sess-1");
		const frame = toBridgeEventFrame(eventOfType("message_update"), seq);
		expect(frame.protocol_version).toBe(BRIDGE_PROTOCOL_VERSION);
		expect(frame.session_id).toBe("sess-1");
		expect(frame.type).toBe("event");
		expect(frame.seq).toBe(1);
		expect(typeof frame.frame_id).toBe("string");
		expect(frame.frame_id.length).toBeGreaterThan(0);
		expect(frame.payload.event_type).toBe("message_update");
		expect(frame.payload.event.type).toBe("message_update");
		expect(frame.correlation_id).toBeUndefined();
	});

	it("assigns monotonic seq and unique frame ids per session", () => {
		const seq = new BridgeFrameSequencer("sess-2");
		const frames = AGENT_SESSION_EVENT_TYPES.map(type => toBridgeEventFrame(eventOfType(type), seq));
		const seqs = frames.map(f => f.seq);
		expect(seqs).toEqual(AGENT_SESSION_EVENT_TYPES.map((_, i) => i + 1));
		expect(seq.lastSeq).toBe(AGENT_SESSION_EVENT_TYPES.length);
		const ids = new Set(frames.map(f => f.frame_id));
		expect(ids.size).toBe(frames.length);
		for (const frame of frames) {
			expect(frame.session_id).toBe("sess-2");
		}
	});

	it("threads correlation_id when provided", () => {
		const seq = new BridgeFrameSequencer("sess-3");
		const frame = seq.next("ui_request", { kind: "select" }, "corr-42");
		expect(frame.correlation_id).toBe("corr-42");
		expect(frame.type).toBe("ui_request");
		expect(frame.seq).toBe(1);
	});
});
