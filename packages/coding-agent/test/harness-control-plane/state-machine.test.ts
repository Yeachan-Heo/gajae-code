import { describe, expect, it } from "bun:test";
import {
	buildResponse,
	canTransition,
	isTerminal,
	nextAllowedActions,
} from "../../src/harness-control-plane/state-machine";
import { SESSION_SCHEMA_VERSION, type SessionHandle, type SessionState } from "../../src/harness-control-plane/types";

function fakeState(p: Partial<SessionState> = {}): SessionState {
	const now = "2026-06-02T00:00:00.000Z";
	return {
		schemaVersion: SESSION_SCHEMA_VERSION,
		sessionId: "h-test",
		lifecycle: "started",
		harness: "gajae-code",
		handle: { sessionId: "h-test", harness: "gajae-code", workspace: "." } as SessionHandle,
		retries: {},
		blockers: [],
		createdAt: now,
		updatedAt: now,
		...p,
	};
}

function findAction(actions: ReturnType<typeof nextAllowedActions>, verb: string) {
	const found = actions.find(a => a.verb === verb);
	if (!found) throw new Error(`missing action ${verb}`);
	return found;
}

describe("harness state machine", () => {
	it("submit is blocked with owner-not-live when no live owner (non-terminal)", () => {
		const actions = nextAllowedActions("started", false);
		const submit = findAction(actions, "submit");
		expect(submit.available).toBe(false);
		expect(submit.reason).toBe("owner-not-live");
	});

	it("submit is available only when a live owner is in a submit-ready lifecycle", () => {
		for (const lifecycle of ["started", "observing"] as const) {
			const submit = findAction(nextAllowedActions(lifecycle, true), "submit");
			expect(submit.available).toBe(true);
		}
	});

	it("submit is blocked while lifecycle is blocked even with a live owner", () => {
		const submit = findAction(nextAllowedActions("blocked", true), "submit");
		expect(submit.available).toBe(false);
		expect(submit.reason).toBe("lifecycle-blocked");
	});

	it("submit is blocked during non-idle lifecycle windows even with a live owner", () => {
		for (const lifecycle of ["submitted", "recovering", "validating", "finalizing"] as const) {
			const submit = findAction(nextAllowedActions(lifecycle, true), "submit");
			expect(submit.available).toBe(false);
			expect(submit.reason).toBe(`lifecycle-not-idle:${lifecycle}`);
		}
	});

	it("submit is blocked while the owner RPC is not idle", () => {
		const submit = findAction(
			nextAllowedActions("observing", true, { submitUnavailableReason: "rpc-not-idle" }),
			"submit",
		);
		expect(submit.available).toBe(false);
		expect(submit.reason).toBe("rpc-not-idle");
	});

	it("terminal lifecycles block submit/recover/validate/finalize", () => {
		for (const lifecycle of ["completed", "retired"] as const) {
			const actions = nextAllowedActions(lifecycle, true);
			for (const verb of ["submit", "recover", "validate", "finalize"]) {
				expect(findAction(actions, verb).available).toBe(false);
			}
			expect(isTerminal(lifecycle)).toBe(true);
		}
	});

	it("pure/read verbs are always available", () => {
		for (const lifecycle of ["new", "started", "completed", "retired", "blocked"] as const) {
			const actions = nextAllowedActions(lifecycle, false);
			for (const verb of ["observe", "classify", "events", "monitor"]) {
				expect(findAction(actions, verb).available).toBe(true);
			}
		}
	});

	it("recover handles a dead owner: available without a live owner when non-terminal", () => {
		expect(findAction(nextAllowedActions("blocked", false), "recover").available).toBe(true);
	});

	it("contract: buildResponse always carries {ok,state,evidence,nextAllowedActions}", () => {
		const res = buildResponse(fakeState(), false, { hello: "world" });
		expect(res.ok).toBe(true);
		expect(res.state.sessionId).toBe("h-test");
		expect(res.state.ownerLive).toBe(false);
		expect(res.evidence).toEqual({ hello: "world" });
		expect(Array.isArray(res.nextAllowedActions)).toBe(true);
		expect(res.nextAllowedActions.length).toBeGreaterThan(0);
	});

	it("transitions: valid moves allowed, invalid moves rejected", () => {
		expect(canTransition("new", "started")).toBe(true);
		expect(canTransition("finalizing", "completed")).toBe(true);
		expect(canTransition("completed", "started")).toBe(false);
		expect(canTransition("retired", "started")).toBe(false);
	});
});
