import { describe, expect, it } from "bun:test";
import {
	createPromptReconciliation,
	PROMPT_RECONCILIATION_ACTIVE_CAPACITY,
	PROMPT_RECONCILIATION_TERMINAL_CAPACITY,
	PROMPT_RECONCILIATION_TERMINAL_TTL_MS,
	sanitizePromptFailure,
} from "../src/sdk/bus/prompt-reconciliation";
import { CursorRegistry, QueryHandlers, RevisionStore } from "../src/sdk/host/query/index.js";

const correlation = (n = 1) => ({ commandId: `command-${n}`, turnId: `turn-${n}` });

function clocked(start = 1_000_000) {
	let now = start;
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("prompt reconciliation record", () => {
	it("tracks accepted -> in_flight -> terminal_ok with timestamps, reconciled by pair and clientRef", () => {
		const clock = clocked();
		const rec = createPromptReconciliation({ now: clock.now });
		rec.noteAccepted(correlation(), "ref-1");
		expect(rec.lookup({ commandId: "command-1", turnId: "turn-1" })).toEqual({
			status: "accepted",
			commandId: "command-1",
			turnId: "turn-1",
			clientRef: "ref-1",
			acceptedAt: clock.now(),
		});
		rec.noteTransition(correlation(), { type: "agent_start" });
		expect(rec.lookup({ clientRef: "ref-1" })).toEqual({
			status: "in_flight",
			commandId: "command-1",
			turnId: "turn-1",
			clientRef: "ref-1",
			acceptedAt: clock.now(),
			startedAt: clock.now(),
		});
		rec.noteTransition(correlation(), { type: "agent_end" });
		expect(rec.lookup({ commandId: "command-1", turnId: "turn-1" })).toEqual({
			status: "terminal_ok",
			commandId: "command-1",
			turnId: "turn-1",
			clientRef: "ref-1",
			acceptedAt: clock.now(),
			startedAt: clock.now(),
			terminalAt: clock.now(),
		});
	});

	it("records failed with bounded sanitized error metadata and first terminal wins", () => {
		const rec = createPromptReconciliation();
		rec.noteAccepted(correlation());
		rec.noteTransition(correlation(), {
			type: "agent_failed",
			error: Object.assign(new Error(`line one\nline two\t${"x".repeat(600)}`), { code: "provider_down" }),
		});
		// A duplicate/conflicting terminal transition is a no-op.
		rec.noteTransition(correlation(), { type: "agent_end" });
		const result = rec.lookup({ commandId: "command-1", turnId: "turn-1" });
		expect(result.status).toBe("failed");
		if (result.status !== "failed") throw new Error("expected failed");
		expect(result.error.code).toBe("provider_down");
		expect(result.error.message).not.toMatch(/[\t\r\n]/);
		expect(result.error.message.length).toBeLessThanOrEqual(512);
		expect(result.terminalAt).toBeGreaterThan(0);
	});

	it("retains only a safe-token code and never exposes arbitrary failure text", () => {
		for (const error of [
			undefined,
			new Error("prompt text /home/alice/private bearer sk-secret https://user:pass@example.com?q=token"),
			Object.assign(new Error("provider payload"), { code: `bad code! ${"x".repeat(100)}` }),
		]) {
			expect(sanitizePromptFailure(error)).toEqual({ code: "internal", message: "Prompt submission failed." });
		}
		expect(sanitizePromptFailure(Object.assign(new Error("boom"), { code: "ok_code-1.2" }))).toEqual({
			code: "ok_code-1.2",
			message: "Prompt submission failed.",
		});
	});

	it("reports unknown for a wrong commandId/turnId pair even when the commandId exists", () => {
		const rec = createPromptReconciliation();
		rec.noteAccepted(correlation());
		expect(rec.lookup({ commandId: "command-1", turnId: "turn-other" })).toEqual({ status: "unknown" });
		expect(rec.lookup({ commandId: "command-other", turnId: "turn-1" })).toEqual({ status: "unknown" });
	});

	it("reports unknown after session-runtime restart", () => {
		const beforeRestart = createPromptReconciliation();
		beforeRestart.noteAccepted(correlation(), "restart-ref");
		expect(beforeRestart.lookup({ clientRef: "restart-ref" })).toMatchObject({ status: "accepted" });
		const afterRestart = createPromptReconciliation();
		expect(afterRestart.lookup({ clientRef: "restart-ref" })).toEqual({ status: "unknown" });
		expect(afterRestart.lookup(correlation())).toEqual({ status: "unknown" });
	});

	it("never ages an active record into terminal", () => {
		const clock = clocked();
		const rec = createPromptReconciliation({ now: clock.now });
		rec.noteAccepted(correlation(), "ref-1");
		rec.noteTransition(correlation(), { type: "agent_start" });
		clock.advance(PROMPT_RECONCILIATION_TERMINAL_TTL_MS * 10);
		expect(rec.lookup({ clientRef: "ref-1" })).toMatchObject({ status: "in_flight" });
		expect(() => rec.admit("ref-1")).toThrowError(/never reuse a clientRef/);
	});

	it("evicts terminal records after the documented TTL and releases the clientRef", () => {
		const clock = clocked();
		const rec = createPromptReconciliation({ now: clock.now });
		rec.noteAccepted(correlation(), "ref-1");
		rec.noteTransition(correlation(), { type: "agent_start" });
		rec.noteTransition(correlation(), { type: "agent_end" });
		expect(rec.lookup({ clientRef: "ref-1" })).toMatchObject({ status: "terminal_ok" });
		clock.advance(PROMPT_RECONCILIATION_TERMINAL_TTL_MS);
		// Admission itself enforces cleanup; no preceding lookup is required.
		expect(() => rec.admit("ref-1")).not.toThrow();
		expect(rec.lookup({ clientRef: "ref-1" })).toEqual({ status: "unknown" });
		expect(rec.lookup({ commandId: "command-1", turnId: "turn-1" })).toEqual({ status: "unknown" });
	});

	it("rejects a retained duplicate clientRef before execution", () => {
		const rec = createPromptReconciliation();
		rec.admit("ref-1");
		rec.noteAccepted(correlation(), "ref-1");
		let code: string | undefined;
		try {
			rec.admit("ref-1");
		} catch (error) {
			code = (error as { code?: string }).code;
		}
		expect(code).toBe("client_ref_conflict");
		expect(() => rec.admit("ref-2")).not.toThrow();
	});

	it("rejects new submissions at active capacity without falsifying state", () => {
		const rec = createPromptReconciliation();
		for (let n = 1; n <= PROMPT_RECONCILIATION_ACTIVE_CAPACITY; n++) rec.noteAccepted(correlation(n));
		let code: string | undefined;
		try {
			rec.admit();
		} catch (error) {
			code = (error as { code?: string }).code;
		}
		expect(code).toBe("reconciliation_capacity");
		expect(rec.lookup({ commandId: "command-1", turnId: "turn-1" })).toMatchObject({ status: "accepted" });
		rec.noteTransition(correlation(1), { type: "agent_end" });
		expect(() => rec.admit()).not.toThrow();
	});

	it("bounds terminal retention by capacity, evicting oldest terminal records first", () => {
		const clock = clocked();
		const rec = createPromptReconciliation({ now: clock.now });
		for (let n = 1; n <= PROMPT_RECONCILIATION_TERMINAL_CAPACITY + 1; n++) {
			rec.noteAccepted(correlation(n));
			rec.noteTransition(correlation(n), { type: "agent_end" });
			clock.advance(1);
		}
		expect(rec.lookup({ commandId: "command-1", turnId: "turn-1" })).toEqual({ status: "unknown" });
		expect(
			rec.lookup({
				commandId: `command-${PROMPT_RECONCILIATION_TERMINAL_CAPACITY + 1}`,
				turnId: `turn-${PROMPT_RECONCILIATION_TERMINAL_CAPACITY + 1}`,
			}),
		).toMatchObject({ status: "terminal_ok" });
	});

	it("evicts terminal capacity by terminalAt order, not acceptance order", () => {
		const clock = clocked();
		const rec = createPromptReconciliation({ now: clock.now });
		// An early acceptance stays active while later records fill terminal capacity.
		rec.noteAccepted({ commandId: "command-early", turnId: "turn-early" }, "ref-early");
		for (let n = 1; n <= PROMPT_RECONCILIATION_TERMINAL_CAPACITY; n++) {
			rec.noteAccepted(correlation(n));
			rec.noteTransition(correlation(n), { type: "agent_end" });
			clock.advance(1);
		}
		// The early record terminates LAST (newest terminalAt), so capacity eviction
		// must drop the oldest terminal record, not the newly terminal one.
		rec.noteTransition({ commandId: "command-early", turnId: "turn-early" }, { type: "agent_end" });
		expect(rec.lookup({ clientRef: "ref-early" })).toMatchObject({ status: "terminal_ok" });
		expect(rec.lookup({ commandId: "command-1", turnId: "turn-1" })).toEqual({ status: "unknown" });
	});

	it("holds admission reservations across overlapping preflights until acceptance or release", () => {
		const rec = createPromptReconciliation();
		rec.admit("ref-1");
		// An overlapping preflight with the same ref conflicts BEFORE any acceptance.
		expect(() => rec.admit("ref-1")).toThrowError(/never reuse a clientRef/);
		// Rejected/cancelled preflight: the reservation is released and the ref is free.
		rec.releaseAdmission("ref-1");
		expect(() => rec.admit("ref-1")).not.toThrow();
		// Acceptance transitions the reservation into a retained record.
		rec.noteAccepted(correlation(), "ref-1");
		expect(() => rec.admit("ref-1")).toThrowError(/never reuse a clientRef/);
		expect(rec.lookup({ clientRef: "ref-1" })).toMatchObject({ status: "accepted" });
	});

	it("counts reserved admission slots against active capacity", () => {
		const rec = createPromptReconciliation();
		for (let n = 1; n <= PROMPT_RECONCILIATION_ACTIVE_CAPACITY; n++) rec.admit();
		let code: string | undefined;
		try {
			rec.admit();
		} catch (error) {
			code = (error as { code?: string }).code;
		}
		expect(code).toBe("reconciliation_capacity");
		rec.releaseAdmission();
		expect(() => rec.admit()).not.toThrow();
	});

	it("keeps reservation accounting exactly-once under duplicate transitions", () => {
		const rec = createPromptReconciliation();
		rec.admit("ref-a");
		rec.admit("ref-b");
		rec.releaseAdmission("ref-a");
		// A stale duplicate release is a no-op: ref-b remains reserved and counted.
		rec.releaseAdmission("ref-a");
		expect(() => rec.admit("ref-b")).toThrowError(/never reuse a clientRef/);
		for (let n = 1; n <= PROMPT_RECONCILIATION_ACTIVE_CAPACITY - 1; n++) rec.admit();
		// ref-b's reservation plus 127 fresh admissions fill capacity exactly.
		expect(() => rec.admit()).toThrowError(/Too many active/);
	});

	it("consumes only one reservation on duplicate acceptance", () => {
		const rec = createPromptReconciliation();
		rec.admit("ref-x");
		rec.noteAccepted(correlation(1), "ref-x");
		// A duplicate acceptance is a no-op for reservation accounting.
		rec.noteAccepted(correlation(1), "ref-x");
		rec.admit("ref-y");
		rec.releaseAdmission("ref-y");
		// One active record plus 127 fresh admissions fill capacity exactly.
		for (let n = 1; n <= PROMPT_RECONCILIATION_ACTIVE_CAPACITY - 1; n++) rec.admit();
		expect(() => rec.admit()).toThrowError(/Too many active/);
	});
});

function surface(getPromptStatus?: (selector: { commandId?: string; turnId?: string; clientRef?: string }) => unknown) {
	return {
		getTranscriptEntries: () => [],
		getContextSnapshot: () => ({}),
		getGoalState: () => [],
		getTodoState: () => [],
		getDiff: () => [],
		getUsage: () => ({}),
		getModels: () => [],
		getSkillState: () => [],
		getGates: () => [],
		getConfigItems: () => [],
		getSessionMetadata: () => ({}),
		getStats: () => ({}),
		getBranchCandidates: () => [],
		getLastAssistant: () => ({}),
		getCapabilities: () => ({}),
		getAuthProviders: () => [],
		getTools: () => [],
		getQueueMessages: () => [],
		getExtensions: () => [],
		getJobs: () => [],
		...(getPromptStatus ? { getPromptStatus } : {}),
	};
}

function handlers(
	getPromptStatus?: (selector: { commandId?: string; turnId?: string; clientRef?: string }) => unknown,
) {
	const store = new RevisionStore("s1");
	const cursors = new CursorRegistry("token", store);
	return new QueryHandlers(surface(getPromptStatus) as never, "s1", store, cursors);
}

describe("Q26 turn.prompt_status query handler", () => {
	it("resolves by commandId/turnId pair and returns the surface result", async () => {
		const seen: unknown[] = [];
		const h = handlers(selector => {
			seen.push(selector);
			return { status: "in_flight", commandId: "c1", turnId: "t1", acceptedAt: 1, startedAt: 2 };
		});
		const response = await h.dispatch({
			query: "turn.prompt_status",
			input: { commandId: "c1", turnId: "t1" },
			connectionId: "c",
		});
		expect(response).toMatchObject({ ok: true, result: { status: "in_flight" } });
		expect(seen).toEqual([{ commandId: "c1", turnId: "t1" }]);
	});

	it("resolves by clientRef and by the Q26 numeric alias", async () => {
		const seen: unknown[] = [];
		const h = handlers(selector => {
			seen.push(selector);
			return { status: "accepted", commandId: "c1", turnId: "t1", clientRef: "ref-1", acceptedAt: 1 };
		});
		const response = await h.dispatch({ query: "Q26", input: { clientRef: "ref-1" }, connectionId: "c" });
		expect(response).toMatchObject({ ok: true, result: { status: "accepted", clientRef: "ref-1" } });
		expect(seen).toEqual([{ clientRef: "ref-1" }]);
	});

	it("normalizes a padded clientRef selector before lookup", async () => {
		const seen: unknown[] = [];
		const h = handlers(selector => {
			seen.push(selector);
			return { status: "accepted", commandId: "c1", turnId: "t1", clientRef: "ref-1", acceptedAt: 1 };
		});
		const response = await h.dispatch({
			query: "turn.prompt_status",
			input: { clientRef: "  ref-1 " },
			connectionId: "c",
		});
		expect(response.ok).toBe(true);
		expect(seen).toEqual([{ clientRef: "ref-1" }]);
	});

	it("rejects a partial commandId/turnId pair", async () => {
		const h = handlers(() => ({}));
		for (const input of [{ commandId: "c1" }, { turnId: "t1" }]) {
			const response = await h.dispatch({ query: "turn.prompt_status", input, connectionId: "c" });
			expect(response).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		}
	});

	it("rejects combined, missing, blank, overlength, and extra-field selectors", async () => {
		const h = handlers(() => ({}));
		const cases = [
			{ commandId: "c1", turnId: "t1", clientRef: "ref-1" },
			{},
			{ clientRef: "" },
			{ clientRef: "   " },
			{ clientRef: "x".repeat(129) },
			{ clientRef: "ref-1", extra: "nope" },
			{ commandId: "c1", turnId: "t1", bogus: 1 },
		];
		for (const input of cases) {
			const response = await h.dispatch({ query: "turn.prompt_status", input, connectionId: "c" });
			expect(response).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		}
	});

	it("prohibits cursors on the keyed lookup", async () => {
		const h = handlers(() => ({}));
		const response = await h.dispatch({
			query: "turn.prompt_status",
			input: { clientRef: "ref-1" },
			cursor: "any-cursor",
			connectionId: "c",
		});
		expect(response).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});

	it("gates on installedQueries", async () => {
		const store = new RevisionStore("s1");
		const cursors = new CursorRegistry("token", store);
		const restricted = {
			...surface(() => ({})),
			installedQueries: new Set(["models.list/current"]),
		};
		const h = new QueryHandlers(restricted as never, "s1", store, cursors);
		const response = await h.dispatch({ query: "turn.prompt_status", input: { clientRef: "r" }, connectionId: "c" });
		expect(response).toMatchObject({ ok: false, error: { code: "operation_not_session_owned" } });
	});
});
