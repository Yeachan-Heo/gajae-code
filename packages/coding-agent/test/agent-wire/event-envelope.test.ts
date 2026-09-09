import { describe, expect, it } from "bun:test";
import {
	AGENT_WIRE_EVENT_TYPES,
	AGENT_WIRE_PROTOCOL_VERSION,
	isAgentWireSessionEvent,
} from "../../src/modes/shared/agent-wire/event-contract";
import * as envelope from "../../src/modes/shared/agent-wire/event-envelope";
import {
	AgentWireFrameSequencer,
	agentSessionEventType,
	toAgentWireEventFrame,
} from "../../src/modes/shared/agent-wire/event-envelope";
import type { QueuedInputEvent } from "../../src/session/agent-session";
import { EVENT_FIXTURES } from "./fixtures";

describe("canonical agent-wire envelope", () => {
	it("excludes queued ownership events from wire admission and the event registry", () => {
		const queuedEvents: QueuedInputEvent[] = [
			{ type: "queued_input_admitted", submissionId: "q1", mode: "steer" },
			{
				type: "queued_input_consumed",
				submissionId: "q1",
				startsOwnRun: false,
				runId: "run-1",
				scope: { attemptId: "attempt-1", generation: 1, lineage: "main" },
			},
			{ type: "queued_input_removed", submissionId: "q1" },
			{
				type: "queued_input_terminal",
				submissionId: "q1",
				runId: "run-1",
				terminal: { type: "agent_end", messages: [], stopReason: "completed" },
			},
			{
				type: "queued_input_terminal",
				submissionId: "q1",
				runId: "run-1",
				terminal: { type: "agent_end", messages: [], stopReason: "cancelled" },
			},
		];
		for (const event of queuedEvents) {
			expect(isAgentWireSessionEvent(event)).toBe(false);
			expect(AGENT_WIRE_EVENT_TYPES).not.toContain(event.type);
		}
		for (const event of Object.values(EVENT_FIXTURES)) {
			expect(isAgentWireSessionEvent(event)).toBe(true);
		}
	});
	it("emits the exact pinned event frame shape", () => {
		const seq = new AgentWireFrameSequencer("sess-1");
		const frame = toAgentWireEventFrame(EVENT_FIXTURES.tool_execution_start, seq);
		expect(frame.type).toBe("event");
		expect(frame.protocol_version).toBe(AGENT_WIRE_PROTOCOL_VERSION);
		expect(frame.session_id).toBe("sess-1");
		expect(frame.seq).toBe(1);
		expect(typeof frame.frame_id).toBe("string");
		expect(frame.payload.event_type).toBe("tool_execution_start");
		expect(frame.payload.event).toBe(EVENT_FIXTURES.tool_execution_start);
		expect(Object.keys(frame).sort()).toEqual(
			["frame_id", "payload", "protocol_version", "seq", "session_id", "type"].sort(),
		);
	});

	it("assigns monotonic per-session seq starting at 1 with unique frame ids", () => {
		const seq = new AgentWireFrameSequencer("sess-2");
		const frames = AGENT_WIRE_EVENT_TYPES.map(type => toAgentWireEventFrame(EVENT_FIXTURES[type], seq));
		expect(frames.map(f => f.seq)).toEqual(AGENT_WIRE_EVENT_TYPES.map((_, i) => i + 1));
		expect(seq.lastSeq).toBe(AGENT_WIRE_EVENT_TYPES.length);
		expect(new Set(frames.map(f => f.frame_id)).size).toBe(frames.length);
	});

	it("resolves the wire event-type for every registered variant", () => {
		for (const type of AGENT_WIRE_EVENT_TYPES) {
			expect(agentSessionEventType(EVENT_FIXTURES[type])).toBe(type);
		}
	});

	it("does not retain the removed Bridge* compatibility aliases", () => {
		expect("BridgeFrameSequencer" in envelope).toBe(false);
		expect("toBridgeEventFrame" in envelope).toBe(false);
		expect("toBridgeWorkflowGateFrame" in envelope).toBe(false);
	});
});
