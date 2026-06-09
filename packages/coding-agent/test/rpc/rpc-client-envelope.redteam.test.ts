import { describe, expect, it } from "bun:test";
import { AGENT_WIRE_PROTOCOL_VERSION } from "../../src/modes/shared/agent-wire/event-contract";
import { AgentWireFrameSequencer, toAgentWireEventFrame } from "../../src/modes/shared/agent-wire/event-envelope";
import { EVENT_FIXTURES } from "../agent-wire/fixtures";

describe("rpc client event envelope wire contract", () => {
	it("round-trips produced frames through JSON without changing the pinned envelope shape", () => {
		const sequencer = new AgentWireFrameSequencer("rpc-redteam-session");
		const frame = toAgentWireEventFrame(EVENT_FIXTURES.tool_execution_start, sequencer);
		const roundTripped = JSON.parse(JSON.stringify(frame));

		expect(Object.keys(roundTripped).sort()).toEqual(
			["frame_id", "payload", "protocol_version", "seq", "session_id", "type"].sort(),
		);
		expect(Object.keys(roundTripped.payload).sort()).toEqual(["event", "event_type"].sort());
		expect(roundTripped).toMatchObject({
			type: "event",
			protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
			session_id: "rpc-redteam-session",
			seq: 1,
			payload: {
				event_type: "tool_execution_start",
				event: { type: "tool_execution_start", toolCallId: "t1", toolName: "bash" },
			},
		});
		expect(typeof roundTripped.frame_id).toBe("string");
		expect(roundTripped.payload.event.type).toBe("tool_execution_start");
	});

	it("does not expose a usable inner event from malformed event envelopes", () => {
		const malformed = { type: "event", payload: {} };
		const innerEvent = malformed.payload && "event" in malformed.payload ? malformed.payload.event : undefined;

		expect(innerEvent).toBeUndefined();
	});
});
