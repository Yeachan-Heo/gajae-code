import { describe, expect, it } from "bun:test";
import { AGENT_WIRE_EVENT_TYPES } from "../../src/modes/shared/agent-wire/event-contract";
import { observeAgentSessionEvent, observeRpcOutboundFrame } from "../../src/modes/shared/agent-wire/event-observation";
import { EVENT_FIXTURES } from "./fixtures";

const SECRET_MARKERS = [
	"RAW_SECRET_MUST_NOT_LEAK",
	"sk-live-redteam-secret",
	"BEGIN_ADVERSARIAL_PAYLOAD",
	"assistant-private-answer",
] as const;
const LONG_SECRET = `${SECRET_MARKERS.join("::")}::${"x".repeat(1_000)}`;

function event(value: Record<string, unknown>) {
	return value as never;
}

function evidenceText(observation: unknown): string {
	const evidence = (observation as { evidence?: unknown } | null)?.evidence ?? {};
	return JSON.stringify(evidence);
}

function assertNoThrowObservation(value: Record<string, unknown>) {
	let captured: ReturnType<typeof observeAgentSessionEvent> = null;
	expect(() => {
		captured = observeAgentSessionEvent(event(value));
	}).not.toThrow();
	const observation = captured as ReturnType<typeof observeAgentSessionEvent>;
	if (observation !== null) {
		expect(typeof observation.kind).toBe("string");
		expect(typeof observation.evidence).toBe("object");
	}
	return observation;
}

function assertBoundedAndRedacted(observation: unknown) {
	const serialized = evidenceText(observation);
	for (const marker of SECRET_MARKERS) {
		expect(serialized).not.toContain(marker);
	}

	const evidence = ((observation as { evidence?: Record<string, unknown> } | null)?.evidence ?? {}) as Record<
		string,
		unknown
	>;
	for (const [key, value] of Object.entries(evidence)) {
		if (key === "code" || key === "message") {
			expect(typeof value === "string" ? value.length : 0).toBeLessThanOrEqual(200);
		}
	}
}

describe("agent-wire event observation red-team", () => {
	it("does not throw for malformed or partial known events and returns bounded observations or null", () => {
		const malformedEvents = [
			{ type: "message_start" },
			{ type: "message_update", message: null, assistantMessageEvent: { type: "text_delta", delta: LONG_SECRET } },
			{ type: "message_end", message: "wrong-type" },
			{ type: "tool_execution_start", toolName: 42, args: null },
			{ type: "tool_execution_update", partialResult: { status: "running", output: LONG_SECRET } },
			{ type: "tool_execution_end", toolCallId: null, toolName: {}, result: LONG_SECRET, isError: "yes" },
			{ type: "auto_retry_start", attempt: "first", errorMessage: LONG_SECRET },
			{ type: "auto_retry_end", success: "true", attempt: null },
			{ type: "retry_fallback_applied", role: { text: LONG_SECRET } },
			{ type: "ttsr_triggered", rules: null },
			{ type: "notice", level: 17, message: LONG_SECRET, source: { raw: LONG_SECRET } },
			{ type: "goal_updated", goal: LONG_SECRET },
			{ type: "irc_message", message: { text: LONG_SECRET } },
			{ type: "not_a_registered_event", payload: LONG_SECRET },
		];

		for (const malformed of malformedEvents) {
			const observation = assertNoThrowObservation(malformed);
			assertBoundedAndRedacted(observation);
		}
	});

	it("redacts adversarial payloads from args, results, message deltas, notices, goals, and IRC", () => {
		const adversarialEvents = [
			{
				type: "message_update",
				message: { id: "m-red", role: "assistant", content: [{ type: "text", text: LONG_SECRET }] },
				assistantMessageEvent: { type: "text_delta", delta: LONG_SECRET },
			},
			{
				type: "tool_execution_start",
				toolCallId: "t-red-start",
				toolName: "bash",
				args: { command: `echo ${LONG_SECRET}`, nested: { secret: LONG_SECRET } },
			},
			{
				type: "tool_execution_update",
				toolCallId: "t-red-update",
				toolName: "bash",
				args: { command: `bun test ${LONG_SECRET}` },
				partialResult: { status: "running", output: LONG_SECRET, content: [{ text: LONG_SECRET }] },
			},
			{
				type: "tool_execution_end",
				toolCallId: "t-red-end",
				toolName: "bash",
				result: { status: "failed", output: LONG_SECRET, answer: LONG_SECRET },
				isError: false,
			},
			{ type: "notice", level: "error", message: LONG_SECRET, source: LONG_SECRET },
			{ type: "goal_updated", goal: { objective: LONG_SECRET, answer: LONG_SECRET } },
			{ type: "irc_message", message: { from: "peer", text: LONG_SECRET } },
		];

		for (const value of adversarialEvents) {
			const observation = assertNoThrowObservation(value);
			expect(observation).not.toBeNull();
			assertBoundedAndRedacted(observation);
		}
	});

	it("returns null without throwing for malformed or unknown outbound wire frames", () => {
		const frames = [
			{},
			{ type: null },
			{ type: 123, payload: LONG_SECRET },
			{ type: "unknown_frame", payload: LONG_SECRET },
			{ type: "event" },
			{ type: "event", payload: null },
			{ type: "event", payload: { event: null } },
			{ type: "event", payload: { event: LONG_SECRET } },
			{ type: "ready", payload: LONG_SECRET },
		];

		for (const frame of frames) {
			expect(() => observeRpcOutboundFrame(frame as Record<string, unknown>)).not.toThrow();
			expect(observeRpcOutboundFrame(frame as Record<string, unknown>)).toBeNull();
		}
	});

	it("bounds failed response object and string errors", () => {
		const objectError = observeRpcOutboundFrame({
			type: "response",
			command: `prompt ${LONG_SECRET}`,
			id: "r-object",
			success: false,
			error: { code: `scope_denied_${LONG_SECRET}`, message: LONG_SECRET },
		});
		expect(objectError?.signal).toBe("error");
		expect(String(objectError?.evidence.code ?? "").length).toBeLessThanOrEqual(200);
		assertBoundedAndRedacted(objectError);

		const stringError = observeRpcOutboundFrame({
			type: "response",
			command: "prompt",
			id: "r-string",
			success: false,
			error: LONG_SECRET,
		});
		expect(stringError?.signal).toBe("error");
		expect(String(stringError?.evidence.code ?? "").length).toBeLessThanOrEqual(200);
		assertBoundedAndRedacted(stringError);
	});

	it("observes every registered event type with a non-null bounded observation", () => {
		const fixtureTypes = Object.keys(EVENT_FIXTURES).sort();
		expect(fixtureTypes).toEqual([...AGENT_WIRE_EVENT_TYPES].sort());

		for (const type of AGENT_WIRE_EVENT_TYPES) {
			const observation = observeAgentSessionEvent(EVENT_FIXTURES[type]);
			expect(observation).not.toBeNull();
			expect(observation?.eventType).toBe(type);
			assertBoundedAndRedacted(observation);
		}
	});
});
