import { describe, expect, it } from "bun:test";
import { mapAgentWireEventPayloadToAcpSessionUpdates } from "../src/modes/acp/acp-event-mapper";
import { AGENT_WIRE_EVENT_TYPES, AGENT_WIRE_PROTOCOL_VERSION } from "../src/modes/shared/agent-wire/event-contract";
import {
	AgentWireFrameSequencer,
	agentSessionEventType,
	toAgentWireEventFrame,
} from "../src/modes/shared/agent-wire/event-envelope";
import {
	observeAgentSessionEvent,
	observeRpcOutboundFrame,
	toAgentWireEventPayload,
} from "../src/modes/shared/agent-wire/event-observation";
import { EVENT_FIXTURES, RAW_SECRET } from "./agent-wire/fixtures";

/**
 * Single cross-adapter conformance matrix for the canonical agent-wire layer.
 * Every registered AgentSessionEvent type is projected through all four adapter
 * seams; non-event RPC frames and the ACP empty-output whitelist are covered too.
 * Per-adapter behavior is exercised in depth by the per-story suites; this is the
 * one place that proves coverage equals AGENT_WIRE_EVENT_TYPES exactly.
 */

/** Event types ACP intentionally does NOT represent as session updates. */
const ACP_EMPTY_WHITELIST = new Set([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"auto_retry_start",
	"auto_retry_end",
	"retry_fallback_applied",
	"retry_fallback_succeeded",
	"ttsr_triggered",
	"irc_message",
	"notice",
	"thinking_level_changed",
	"goal_updated",
]);

describe("agent-wire conformance matrix", () => {
	it("fixture coverage equals AGENT_WIRE_EVENT_TYPES exactly", () => {
		expect(Object.keys(EVENT_FIXTURES).sort()).toEqual([...AGENT_WIRE_EVENT_TYPES].sort());
	});

	describe("every event type projects through all four adapter seams", () => {
		for (const type of AGENT_WIRE_EVENT_TYPES) {
			it(`projects ${type}`, () => {
				const event = EVENT_FIXTURES[type];

				// RPC / Bridge: canonical pinned event frame.
				const seq = new AgentWireFrameSequencer("conf");
				const frame = toAgentWireEventFrame(event, seq);
				expect(frame.type).toBe("event");
				expect(frame.protocol_version).toBe(AGENT_WIRE_PROTOCOL_VERSION);
				expect(frame.seq).toBe(1);
				expect(frame.payload.event_type).toBe(type);
				expect(agentSessionEventType(event)).toBe(type);

				// Harness: bounded owner observation, never leaking raw content.
				const obs = observeAgentSessionEvent(event);
				expect(obs).not.toBeNull();
				expect(obs?.eventType).toBe(type);
				expect(JSON.stringify(obs?.evidence ?? {})).not.toContain(RAW_SECRET);

				// Harness via the RPC wire frame delegates to the same observation.
				const frameObs = observeRpcOutboundFrame(frame as unknown as Record<string, unknown>);
				expect(frameObs?.eventType).toBe(type);

				// ACP: whitelist -> []; otherwise a defined projection (may be empty for
				// conditional message events, but must not throw).
				const acp = mapAgentWireEventPayloadToAcpSessionUpdates(toAgentWireEventPayload(event), "sess");
				expect(Array.isArray(acp)).toBe(true);
				if (ACP_EMPTY_WHITELIST.has(type)) {
					expect(acp).toEqual([]);
				}
			});
		}
	});

	it("ACP produces session updates for the non-whitelisted event types", () => {
		for (const type of ["tool_execution_start", "tool_execution_end", "todo_reminder"] as const) {
			const acp = mapAgentWireEventPayloadToAcpSessionUpdates(toAgentWireEventPayload(EVENT_FIXTURES[type]), "sess");
			expect(acp.length).toBeGreaterThan(0);
		}
	});

	it("assigns Bridge/RPC monotonic per-session seq across all event types", () => {
		const seq = new AgentWireFrameSequencer("conf-seq");
		const frames = AGENT_WIRE_EVENT_TYPES.map(type => toAgentWireEventFrame(EVENT_FIXTURES[type], seq));
		expect(frames.map(f => f.seq)).toEqual(AGENT_WIRE_EVENT_TYPES.map((_, i) => i + 1));
		expect(new Set(frames.map(f => f.frame_id)).size).toBe(frames.length);
	});

	describe("non-event RPC frames map to bounded owner observations", () => {
		const cases: Array<[string, Record<string, unknown>, string | null]> = [
			["ready", { type: "ready" }, null],
			["response ok", { type: "response", command: "prompt", success: true }, null],
			[
				"response fail",
				{ type: "response", command: "prompt", id: "r1", success: false, error: { code: "scope_denied" } },
				"rpc_response_failed",
			],
			[
				"extension_ui_request",
				{ type: "extension_ui_request", id: "u1", method: "confirm" },
				"rpc_extension_request",
			],
			[
				"extension_error",
				{ type: "extension_error", extensionPath: "/x", event: "run", error: "boom" },
				"rpc_extension_error",
			],
			["host_tool_call", { type: "host_tool_call", id: "h1", toolName: "echo" }, "rpc_host_tool_call"],
			["host_tool_cancel", { type: "host_tool_cancel", id: "h1", toolName: "echo" }, "rpc_host_tool_cancel"],
			[
				"host_uri_request",
				{ type: "host_uri_request", id: "u2", operation: "read", scheme: "db" },
				"rpc_host_uri_request",
			],
			["host_uri_cancel", { type: "host_uri_cancel", id: "u2", operation: "read" }, "rpc_host_uri_cancel"],
			[
				"workflow_gate",
				{ type: "workflow_gate", gate_id: "g1", kind: "approval", stage: "pre" },
				"rpc_workflow_gate",
			],
		];
		for (const [name, frame, expectedKind] of cases) {
			it(`observes ${name}`, () => {
				const obs = observeRpcOutboundFrame(frame);
				if (expectedKind === null) {
					expect(obs).toBeNull();
				} else {
					expect(obs?.kind).toBe(expectedKind);
					expect(obs?.frameType).toBe(frame.type as string);
				}
			});
		}
	});
});
