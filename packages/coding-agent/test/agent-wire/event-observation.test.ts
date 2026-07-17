import { describe, expect, it } from "bun:test";
import { AGENT_WIRE_EVENT_TYPES } from "../../src/modes/shared/agent-wire/event-contract";
import {
	observeAgentSessionEvent,
	observeAgentWireFrame,
	toAgentWireEventPayload,
} from "../../src/modes/shared/agent-wire/event-observation";
import { EVENT_FIXTURES, RAW_SECRET } from "./fixtures";

describe("agent-wire event observation", () => {
	it("has exactly one fixture per registered event type", () => {
		const fixtureTypes = Object.keys(EVENT_FIXTURES).sort();
		const registryTypes = [...AGENT_WIRE_EVENT_TYPES].sort();
		expect(fixtureTypes).toEqual(registryTypes);
	});

	it("observes every event type and stamps the eventType", () => {
		for (const type of AGENT_WIRE_EVENT_TYPES) {
			const event = EVENT_FIXTURES[type];
			const observation = observeAgentSessionEvent(event);
			if (!observation) throw new Error(`expected observation for ${type}`);
			expect(observation.eventType).toBe(type);
			expect(typeof observation.kind).toBe("string");
			expect(["info", "warn", "critical"]).toContain(observation.severity);
		}
	});

	it("never leaks raw content into bounded owner evidence", () => {
		for (const type of AGENT_WIRE_EVENT_TYPES) {
			const observation = observeAgentSessionEvent(EVENT_FIXTURES[type]);
			const serialized = JSON.stringify(observation?.evidence ?? {});
			expect(serialized).not.toContain(RAW_SECRET);
		}
	});

	it("marks lifecycle and tool boundary events as semantic (never coalesced)", () => {
		const semanticTypes = [
			"agent_start",
			"turn_start",
			"tool_execution_start",
			"tool_execution_end",
			"agent_end",
		] as const;
		for (const type of semanticTypes) {
			expect(observeAgentSessionEvent(EVENT_FIXTURES[type])?.semantic).toBe(true);
		}
	});

	it("coalesces high-frequency message/tool-update activity", () => {
		expect(observeAgentSessionEvent(EVENT_FIXTURES.message_update)?.coalesceKey).toBe("message:m1");
		expect(observeAgentSessionEvent(EVENT_FIXTURES.tool_execution_update)?.coalesceKey).toBe("tool:t1");
	});

	it("flags test-runner tool calls with the test-running signal", () => {
		const event = {
			type: "tool_execution_start" as const,
			toolCallId: "t9",
			toolName: "bash",
			args: { command: "bun test" },
		};
		expect(observeAgentSessionEvent(event as never)?.signal).toBe("test-running");
	});

	describe("non-event wire frames", () => {
		it("ignores ready and successful response frames", () => {
			expect(observeAgentWireFrame({ type: "ready" })).toBeNull();
			expect(observeAgentWireFrame({ type: "response", command: "prompt", success: true })).toBeNull();
		});

		it("observes failed responses with a bounded code", () => {
			const observation = observeAgentWireFrame({
				type: "response",
				command: "prompt",
				id: "r1",
				success: false,
				error: { code: "scope_denied" },
			});
			expect(observation?.signal).toBe("error");
			expect(observation?.evidence.code).toBe("scope_denied");
		});

		it("delegates event frames to the canonical event observer", () => {
			const frame = { type: "event", payload: toAgentWireEventPayload(EVENT_FIXTURES.tool_execution_start) };
			const observation = observeAgentWireFrame(frame as Record<string, unknown>);
			expect(observation?.eventType).toBe("tool_execution_start");
			expect(observation?.signal).toBe("tool-call");
		});

		it("observes extension, host-tool, host-uri, and workflow-gate frames", () => {
			expect(observeAgentWireFrame({ type: "extension_ui_request", id: "u1", method: "confirm" })?.kind).toBe(
				"rpc_extension_request",
			);
			expect(observeAgentWireFrame({ type: "host_tool_call", id: "h1", toolName: "echo" })?.signal).toBe(
				"tool-call",
			);
			expect(
				observeAgentWireFrame({ type: "host_uri_request", id: "u2", operation: "read", scheme: "db" })?.evidence
					.scheme,
			).toBe("db");
			const gate = observeAgentWireFrame({ type: "workflow_gate", gate_id: "g1", kind: "approval", stage: "pre" });
			expect(gate?.semantic).toBe(true);
			expect(gate?.evidence.gate_id).toBe("g1");
		});

		it("never leaks raw content from extension errors", () => {
			const observation = observeAgentWireFrame({
				type: "extension_error",
				extensionPath: "/x",
				event: "session_start",
				error: `${RAW_SECRET}`.repeat(50),
			});
			const code = String(observation?.evidence.code ?? "");
			expect(code.length).toBeLessThanOrEqual(200);
		});
	});
});
