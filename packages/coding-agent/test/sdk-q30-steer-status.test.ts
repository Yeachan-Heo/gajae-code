import { describe, expect, it } from "bun:test";
import { CursorRegistry, QueryHandlers, RevisionStore } from "../src/sdk/host/query/index.js";

function handlers(getSteerStatus?: (selector: { clientRef: string }) => unknown) {
	const store = new RevisionStore("s1");
	const cursors = new CursorRegistry("token", store);
	const surface = {
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
		...(getSteerStatus ? { getSteerStatus } : {}),
	};
	return new QueryHandlers(surface as never, "s1", store, cursors);
}

describe("Q31 turn.steer_status query handler", () => {
	it("normalizes the exact clientRef selector and returns durable status", async () => {
		const seen: unknown[] = [];
		const response = await handlers(selector => {
			seen.push(selector);
			return { clientRef: selector.clientRef, status: "accepted", acceptedAt: 10 };
		}).dispatch({ query: "turn.steer_status", input: { clientRef: "  steer-1 " }, connectionId: "c" });
		expect(response).toEqual({
			id: undefined,
			ok: true,
			result: { clientRef: "steer-1", status: "accepted", acceptedAt: 10 },
		});
		expect(seen).toEqual([{ clientRef: "steer-1" }]);
	});

	it("supports Q31 and returns unknown without dispatching work", async () => {
		const response = await handlers(selector => ({ clientRef: selector.clientRef, status: "unknown" })).dispatch({
			query: "Q31",
			input: { clientRef: "missing" },
			connectionId: "c",
		});
		expect(response).toMatchObject({ ok: true, result: { clientRef: "missing", status: "unknown" } });
	});

	it("rejects cursors, missing, blank, overlength, and extra selectors", async () => {
		const h = handlers(() => ({}));
		for (const input of [
			{},
			{ clientRef: "" },
			{ clientRef: "   " },
			{ clientRef: "x".repeat(129) },
			{ clientRef: "steer-1", extra: true },
		]) {
			const response = await h.dispatch({ query: "turn.steer_status", input, connectionId: "c" });
			expect(response).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		}
		const cursor = await h.dispatch({
			query: "turn.steer_status",
			input: { clientRef: "steer-1" },
			cursor: "cursor",
			connectionId: "c",
		});
		expect(cursor).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});

	it("fails closed when the session has no steer reconciliation surface", async () => {
		const response = await handlers().dispatch({
			query: "turn.steer_status",
			input: { clientRef: "steer-1" },
			connectionId: "c",
		});
		expect(response).toMatchObject({ ok: false, error: { code: "unavailable" } });
	});
});
