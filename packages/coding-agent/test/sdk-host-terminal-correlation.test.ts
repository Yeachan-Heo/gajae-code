import { describe, expect, test } from "bun:test";
import { terminalStoppedOutcome } from "../src/sdk/host/session-runtime";

/**
 * The SDK-only host publishes the lifecycle boundary that settles an externally
 * submitted prompt. An ACP client matches that terminal against the correlation
 * it was acknowledged under and requires a normalized outcome, so a boundary
 * missing either field leaves the client reporting `working` forever even though
 * the turn finished. Measured against Paseo 0.6.1 attached to a live interactive
 * session: the bare `{ type, sessionId }` frame was dropped as
 * `incomplete_correlation`, then as an omitted normalized outcome.
 */
describe("terminalStoppedOutcome", () => {
	test("a completed run stops the turn on the agent's own authority", () => {
		expect(terminalStoppedOutcome("completed", undefined)).toEqual({
			kind: "stopped",
			reason: "end_turn",
			provenance: "agent",
		});
	});

	test("an absent stop reason is treated as a normal end, not an error", () => {
		expect(terminalStoppedOutcome(undefined, undefined)).toEqual({
			kind: "stopped",
			reason: "end_turn",
			provenance: "agent",
		});
	});

	test("a suspended run still ends the turn rather than reporting a cancel", () => {
		expect(terminalStoppedOutcome("paused", undefined)).toEqual({
			kind: "stopped",
			reason: "end_turn",
			provenance: "agent",
		});
	});

	test("an explicit cancel is attributed to the client that asked for it", () => {
		expect(terminalStoppedOutcome("cancelled", undefined)).toEqual({
			kind: "stopped",
			reason: "cancelled",
			provenance: "client_cancel",
		});
	});

	test("an aborted maintenance checkpoint is the one maintenance path that ends the run", () => {
		expect(terminalStoppedOutcome("maintenance", "aborted")).toEqual({
			kind: "stopped",
			reason: "cancelled",
			provenance: "client_cancel",
		});
	});

	test("every result satisfies the ACP terminal-outcome contract", () => {
		// Mirrors the acceptance predicate in modes/acp/acp-agent.ts `terminalOutcome`:
		// a shape outside it is discarded and the prompt never settles.
		const stopReasons = ["completed", "paused", "cancelled", "maintenance", undefined] as const;
		const maintenance = [undefined, "aborted", "compacted", "checkpointed"];
		for (const stopReason of stopReasons) {
			for (const outcomeName of maintenance) {
				const outcome = terminalStoppedOutcome(stopReason, outcomeName);
				expect(outcome.kind).toBe("stopped");
				expect(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]).toContain(outcome.reason);
				expect(["agent", "client_cancel"]).toContain(outcome.provenance);
			}
		}
	});
});
