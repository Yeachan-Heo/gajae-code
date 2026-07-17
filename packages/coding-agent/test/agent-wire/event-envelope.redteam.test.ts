import { describe, expect, it } from "bun:test";
import { AGENT_WIRE_EVENT_TYPES, AGENT_WIRE_PROTOCOL_VERSION } from "../../src/modes/shared/agent-wire/event-contract";
import * as envelope from "../../src/modes/shared/agent-wire/event-envelope";
import {
	AgentWireFrameSequencer,
	agentSessionEventType,
	toAgentWireEventFrame,
} from "../../src/modes/shared/agent-wire/event-envelope";
import { EVENT_FIXTURES } from "./fixtures";

const PINNED_EVENT_FRAME_KEYS = ["frame_id", "payload", "protocol_version", "seq", "session_id", "type"];
const PINNED_EVENT_PAYLOAD_KEYS = ["event", "event_type"];
const PINNED_CORRELATED_FRAME_KEYS = [...PINNED_EVENT_FRAME_KEYS, "correlation_id"].sort();

function sortedKeys(value: object): string[] {
	return Object.keys(value).sort();
}

describe("canonical agent-wire envelope red-team", () => {
	it("keeps two sequencers independent with monotonic seq starting at 1", () => {
		const left = new AgentWireFrameSequencer("left-session");
		const right = new AgentWireFrameSequencer("right-session");

		const leftFirst = toAgentWireEventFrame(EVENT_FIXTURES.agent_start, left);
		const leftSecond = toAgentWireEventFrame(EVENT_FIXTURES.turn_start, left);
		const rightFirst = toAgentWireEventFrame(EVENT_FIXTURES.agent_start, right);
		const leftThird = toAgentWireEventFrame(EVENT_FIXTURES.turn_end, left);
		const rightSecond = toAgentWireEventFrame(EVENT_FIXTURES.turn_start, right);

		expect([leftFirst.seq, leftSecond.seq, leftThird.seq]).toEqual([1, 2, 3]);
		expect([rightFirst.seq, rightSecond.seq]).toEqual([1, 2]);
		expect(left.lastSeq).toBe(3);
		expect(right.lastSeq).toBe(2);
		expect(leftFirst.session_id).toBe("left-session");
		expect(rightFirst.session_id).toBe("right-session");
	});

	it("only emits correlation_id when one is explicitly passed", () => {
		const sequencer = new AgentWireFrameSequencer("correlation-session");

		const uncorrelated = sequencer.next("event", {
			event_type: "agent_start" as const,
			event: EVENT_FIXTURES.agent_start,
		});
		const correlated = sequencer.next(
			"event",
			{
				event_type: "turn_start" as const,
				event: EVENT_FIXTURES.turn_start,
			},
			"corr-123",
		);

		expect("correlation_id" in uncorrelated).toBe(false);
		expect(sortedKeys(uncorrelated)).toEqual(PINNED_EVENT_FRAME_KEYS);
		expect(correlated.correlation_id).toBe("corr-123");
		expect(sortedKeys(correlated)).toEqual(PINNED_CORRELATED_FRAME_KEYS);
	});

	it("emits exactly the pinned event-frame and payload keys for every registered event type", () => {
		const sequencer = new AgentWireFrameSequencer("shape-session");

		for (const type of AGENT_WIRE_EVENT_TYPES) {
			const frame = toAgentWireEventFrame(EVENT_FIXTURES[type], sequencer);

			expect(sortedKeys(frame), type).toEqual(PINNED_EVENT_FRAME_KEYS);
			expect(sortedKeys(frame.payload), type).toEqual(PINNED_EVENT_PAYLOAD_KEYS);
			expect(frame.type, type).toBe("event");
			expect(frame.protocol_version, type).toBe(AGENT_WIRE_PROTOCOL_VERSION);
			expect(frame.session_id, type).toBe("shape-session");
		}
	});

	it("generates unique frame_id values across many frames", () => {
		const sequencer = new AgentWireFrameSequencer("unique-session");
		const frames = Array.from({ length: 250 }, (_, index) => {
			const type = AGENT_WIRE_EVENT_TYPES[index % AGENT_WIRE_EVENT_TYPES.length];
			return toAgentWireEventFrame(EVENT_FIXTURES[type], sequencer);
		});

		expect(new Set(frames.map(frame => frame.frame_id)).size).toBe(frames.length);
		expect(frames.map(frame => frame.seq)).toEqual(frames.map((_, index) => index + 1));
	});

	it("does not resurrect the removed Bridge* compatibility aliases", () => {
		expect("BridgeFrameSequencer" in envelope).toBe(false);
		expect("toBridgeEventFrame" in envelope).toBe(false);

		const canonical = toAgentWireEventFrame(EVENT_FIXTURES.notice, new AgentWireFrameSequencer("alias-session"));
		expect(sortedKeys(canonical)).toEqual(PINNED_EVENT_FRAME_KEYS);
		expect(sortedKeys(canonical.payload)).toEqual(PINNED_EVENT_PAYLOAD_KEYS);
	});

	it("preserves payload event references and derives payload event_type for every registered event", () => {
		const sequencer = new AgentWireFrameSequencer("reference-session");

		for (const type of AGENT_WIRE_EVENT_TYPES) {
			const event = EVENT_FIXTURES[type];
			const frame = toAgentWireEventFrame(event, sequencer);

			expect(frame.payload.event, type).toBe(event);
			expect(frame.payload.event_type, type).toBe(agentSessionEventType(event));
			expect(frame.payload.event_type, type).toBe(type);
		}
	});
});
