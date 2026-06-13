import { afterEach, describe, expect, it } from "bun:test";
import { shouldEmitRpcTitlesForTest } from "../../src/modes/rpc/rpc-mode";
import { AGENT_WIRE_EVENT_TYPES } from "../../src/modes/shared/agent-wire/event-contract";
import { AgentWireFrameSequencer, toAgentWireEventFrame } from "../../src/modes/shared/agent-wire/event-envelope";
import { EVENT_FIXTURES } from "../agent-wire/fixtures";

const ORIGINAL_GJC_RPC_EMIT_TITLE = process.env.GJC_RPC_EMIT_TITLE;
const ORIGINAL_PI_RPC_EMIT_TITLE = process.env.PI_RPC_EMIT_TITLE;

afterEach(() => {
	if (ORIGINAL_GJC_RPC_EMIT_TITLE === undefined) delete process.env.GJC_RPC_EMIT_TITLE;
	else process.env.GJC_RPC_EMIT_TITLE = ORIGINAL_GJC_RPC_EMIT_TITLE;
	if (ORIGINAL_PI_RPC_EMIT_TITLE === undefined) delete process.env.PI_RPC_EMIT_TITLE;
	else process.env.PI_RPC_EMIT_TITLE = ORIGINAL_PI_RPC_EMIT_TITLE;
});

/**
 * Producer contract for RPC mode (rpc-mode.ts): every AgentSessionEvent forwarded
 * to stdout MUST be wrapped in the canonical `event` envelope via
 * `toAgentWireEventFrame`. A regression to raw `output(event)` would emit a
 * top-level frame whose `type` is the event discriminant (e.g. "agent_start")
 * instead of "event" — these assertions lock that boundary so such a regression
 * is caught instead of silently tolerated by the consumer's flat fallback.
 */
describe("RPC emission contract: session events are always wrapped", () => {
	it("wraps every registered event type as a canonical event frame", () => {
		const seq = new AgentWireFrameSequencer("sess-rpc");
		for (const type of AGENT_WIRE_EVENT_TYPES) {
			const fixture = EVENT_FIXTURES[type];
			const frame = toAgentWireEventFrame(fixture, seq);
			// Top-level discriminant is the envelope marker, never the raw event type.
			expect(frame.type).toBe("event");
			expect(frame.type).not.toBe(type);
			expect(frame.payload.event_type).toBe(type);
			expect(frame.payload.event).toBe(fixture);
		}
	});

	it("a raw (unwrapped) session event is NOT a valid event frame", () => {
		// Documents that flat session events and wrapped frames are distinguishable:
		// a producer regression to raw events yields top-level type !== "event".
		for (const type of AGENT_WIRE_EVENT_TYPES) {
			const raw = EVENT_FIXTURES[type] as { type: string };
			expect(raw.type).not.toBe("event");
		}
	});
});

describe("RPC title emission flag", () => {
	it("prefers the documented GJC flag while preserving the legacy PI alias", () => {
		delete process.env.GJC_RPC_EMIT_TITLE;
		process.env.PI_RPC_EMIT_TITLE = "1";
		expect(shouldEmitRpcTitlesForTest()).toBe(true);

		process.env.GJC_RPC_EMIT_TITLE = "false";
		expect(shouldEmitRpcTitlesForTest()).toBe(false);

		process.env.GJC_RPC_EMIT_TITLE = "yes";
		expect(shouldEmitRpcTitlesForTest()).toBe(true);
	});
});
