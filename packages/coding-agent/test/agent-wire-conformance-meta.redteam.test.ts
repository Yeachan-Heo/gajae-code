import { describe, expect, it } from "bun:test";
import { AGENT_WIRE_EVENT_TYPES, AGENT_WIRE_PROTOCOL_VERSION } from "../src/modes/shared/agent-wire/event-contract";
import { AgentWireFrameSequencer, toAgentWireEventFrame } from "../src/modes/shared/agent-wire/event-envelope";
import { observeAgentSessionEvent } from "../src/modes/shared/agent-wire/event-observation";
import { EVENT_FIXTURES, RAW_SECRET } from "./agent-wire/fixtures";

const PINNED_EVENT_FRAME_KEYS = ["frame_id", "payload", "protocol_version", "seq", "session_id", "type"];
const PINNED_EVENT_PAYLOAD_KEYS = ["event", "event_type"];

function expectFixtureCoverageEqualsRegistry(fixtures: Record<string, unknown>) {
	expect(Object.keys(fixtures).sort()).toEqual([...AGENT_WIRE_EVENT_TYPES].sort());
}

function expectOwnerObservationRedacted(observation: { evidence?: unknown } | null | undefined) {
	expect(JSON.stringify(observation?.evidence ?? {})).not.toContain(RAW_SECRET);
}

function expectPinnedEventFrameShape(frame: Record<string, unknown>) {
	expect(Object.keys(frame).sort()).toEqual(PINNED_EVENT_FRAME_KEYS);
	expect(Object.keys(frame.payload as Record<string, unknown>).sort()).toEqual(PINNED_EVENT_PAYLOAD_KEYS);
	expect(frame.type).toBe("event");
	expect(frame.protocol_version).toBe(AGENT_WIRE_PROTOCOL_VERSION);
}

describe("agent-wire conformance matrix meta red-team", () => {
	it("fixture coverage assertion passes on the real matrix and catches a missing event type", () => {
		expect(() => expectFixtureCoverageEqualsRegistry(EVENT_FIXTURES)).not.toThrow();

		const [omittedType] = AGENT_WIRE_EVENT_TYPES;
		const deliberatelyBrokenFixtures = { ...EVENT_FIXTURES };
		delete deliberatelyBrokenFixtures[omittedType];

		expect(() => expectFixtureCoverageEqualsRegistry(deliberatelyBrokenFixtures)).toThrow();
	});

	it("owner-observation redaction assertion passes on canonical observations and catches leaked raw evidence", () => {
		const canonicalObservation = observeAgentSessionEvent(EVENT_FIXTURES.tool_execution_end);
		expect(canonicalObservation).not.toBeNull();
		expect(() => expectOwnerObservationRedacted(canonicalObservation)).not.toThrow();

		const deliberatelyLeakyObservation = {
			...canonicalObservation,
			evidence: { stdout: `unredacted ${RAW_SECRET}` },
		};

		expect(() => expectOwnerObservationRedacted(deliberatelyLeakyObservation)).toThrow();
	});

	it("event-frame shape assertion passes on canonical frames and catches missing pinned keys", () => {
		const canonicalFrame = toAgentWireEventFrame(
			EVENT_FIXTURES.agent_start,
			new AgentWireFrameSequencer("meta-redteam"),
		);
		expect(() => expectPinnedEventFrameShape(canonicalFrame as unknown as Record<string, unknown>)).not.toThrow();

		const deliberatelyBrokenFrame = { ...canonicalFrame };
		delete (deliberatelyBrokenFrame as Partial<typeof canonicalFrame>).session_id;

		expect(() => expectPinnedEventFrameShape(deliberatelyBrokenFrame)).toThrow();
	});
});
