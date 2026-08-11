import { describe, expect, it } from "bun:test";
import { isCheckpointRecord, type SdkCheckpointRecord } from "../src/sdk/host/query/handlers.js";
import {
	CURSOR_TTL_MS,
	CursorRegistry,
	QueryHandlers,
	RevisionStore,
	verifyCursor,
} from "../src/sdk/host/query/index.js";

interface CheckpointResult {
	checkpointToken: string;
	checkpoint: SdkCheckpointRecord;
	revisionId: string;
	issuedAt: number;
	expiresAt: number;
}

const entries = (count: number): unknown[] =>
	Array.from({ length: count }, (_, index) => ({ id: `e${index}`, role: "user", body: `entry-${index}` }));

const largeEntries = (count: number): unknown[] =>
	Array.from({ length: count }, (_, index) => ({
		id: `e${index}`,
		role: "user",
		body: `entry-${index}-${"x".repeat(20_000)}`,
	}));

function surface(transcript: unknown[], watermark?: SdkCheckpointRecord) {
	return {
		getTranscriptEntries: () => transcript,
		getContextSnapshot: () => ({}),
		getGoalState: () => [],
		getTodoState: () => [],
		getDiff: () => [],
		getUsage: () => ({}),
		getModels: () => [],
		getSkillState: () => [],
		getActiveProviders: () => [],
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
		// Q30 atomic capture: entries + event-ring watermark in one synchronous
		// call (C9); absent for surfaces that publish no durable checkpoint.
		...(watermark === undefined ? {} : { getCheckpointSnapshot: () => ({ entries: transcript, watermark }) }),
	};
}

function harness(transcript: unknown[], watermark?: SdkCheckpointRecord, now?: () => number) {
	const store = new RevisionStore("s1", now);
	const cursors = new CursorRegistry("token", store, now);
	return {
		store,
		cursors,
		handlers: new QueryHandlers(surface(transcript, watermark), "s1", store, cursors),
	};
}

function pageOf(response: unknown): { items: unknown[]; complete: boolean; cursor?: string } {
	const page = (response as { page?: unknown } | undefined)?.page;
	if (!page || typeof page !== "object") return { items: [], complete: true };
	const record = page as { items?: unknown; complete?: unknown; continuationCursor?: unknown };
	return {
		items: Array.isArray(record.items) ? record.items : [],
		complete: record.complete === true,
		cursor: typeof record.continuationCursor === "string" ? record.continuationCursor : undefined,
	};
}

describe("SDK session.checkpoint (Q30) replay authority", () => {
	it("mints a signed, pinned checkpoint cursor with TTL/issued/expires metadata", async () => {
		const { handlers } = harness(entries(4));
		const response = await handlers.dispatch({ query: "session.checkpoint", id: "q30", connectionId: "c" });
		expect(response.ok).toBe(true);
		const result = response.result as CheckpointResult;
		// Head degrades to the live transcript count when the host publishes no
		// atomic checkpoint snapshot.
		expect(result.checkpoint).toEqual({ revision: 4, generation: 0, seq: 0 });
		expect(result.revisionId).toBe("1");
		expect(result.issuedAt).toEqual(expect.any(Number));
		expect(result.expiresAt - result.issuedAt).toBe(CURSOR_TTL_MS);

		// The checkpointToken IS the signed cursor: verifiable with the session
		// token, pinned to the exact transcript:default revision, carrying the
		// watermark and TTL metadata inside the signed envelope.
		const envelope = verifyCursor(result.checkpointToken, "token");
		expect(envelope).toBeDefined();
		expect(envelope).toMatchObject({
			sessionId: "s1",
			resource: "transcript",
			revision: "1",
			direction: "forward",
			position: { offset: 0, selector: { queryId: "Q01" } },
			highWatermark: { revision: 4, generation: 0, seq: 0 },
		});
		expect(envelope?.issuedAt).toBe(result.issuedAt);
		expect(envelope?.expiresAt).toBe(result.expiresAt);
	});

	it("replays exactly the pinned snapshot revision (append-during-checkpoint excluded)", async () => {
		const transcript = entries(4);
		const { handlers } = harness(transcript);
		const checkpoint = (await handlers.dispatch({ query: "session.checkpoint", connectionId: "c" }))
			.result as CheckpointResult;

		// The live transcript mutates after the grant; replay must read the
		// pinned snapshot, never a fresh unlocked revision.
		transcript.push({ id: "e4", role: "user", body: "entry-4" });
		const replay = await handlers.dispatch({
			query: "transcript.list",
			cursor: checkpoint.checkpointToken,
			connectionId: "c",
		});
		expect(replay).toMatchObject({ ok: true, page: { items: entries(4), complete: true, revision: "1" } });
	});

	it("consumes a saved checkpointToken directly on Q01 (resume) without re-minting", async () => {
		const transcript = entries(3);
		const { handlers } = harness(transcript);
		const checkpoint = (await handlers.dispatch({ query: "session.checkpoint", connectionId: "c" }))
			.result as CheckpointResult;
		transcript.push({ id: "e3", role: "user", body: "entry-3" });
		const resume = await handlers.dispatch({
			query: "transcript.list",
			input: { checkpointToken: checkpoint.checkpointToken },
			connectionId: "c",
		});
		expect(resume).toMatchObject({ ok: true, page: { items: entries(3), complete: true } });
	});

	it("does not alias duplicate grants for the same checkpoint", async () => {
		const { handlers } = harness(entries(3));
		const first = (await handlers.dispatch({ query: "session.checkpoint", connectionId: "c" }))
			.result as CheckpointResult;
		const second = (await handlers.dispatch({ query: "session.checkpoint", connectionId: "c" }))
			.result as CheckpointResult;
		expect(first.checkpointToken).not.toBe(second.checkpointToken);

		const firstReplay = await handlers.dispatch({
			query: "transcript.list",
			cursor: first.checkpointToken,
			connectionId: "c",
		});
		const secondReplay = await handlers.dispatch({
			query: "transcript.list",
			cursor: second.checkpointToken,
			connectionId: "c",
		});
		expect(firstReplay).toMatchObject({ ok: true, page: { complete: true } });
		expect(secondReplay).toMatchObject({ ok: true, page: { complete: true } });
	});

	it("keeps the checkpoint connection-owned: a new connection must reissue, never echo", async () => {
		const { handlers } = harness(entries(2));
		const first = (await handlers.dispatch({ query: "session.checkpoint", connectionId: "c1" }))
			.result as CheckpointResult;
		expect(
			await handlers.dispatch({
				query: "transcript.list",
				cursor: first.checkpointToken,
				connectionId: "c1",
			}),
		).toMatchObject({ ok: true, page: { complete: true } });
		// The same token is refused on another connection (cursor_expired), then
		// Q30 exchanges the signed claim into a fresh connection-owned grant.
		expect(
			await handlers.dispatch({
				query: "transcript.list",
				cursor: first.checkpointToken,
				connectionId: "c2",
			}),
		).toMatchObject({ ok: false, error: { code: "cursor_expired", restartQuery: true } });
		const second = (
			await handlers.dispatch({
				query: "session.checkpoint",
				input: { checkpointToken: first.checkpointToken },
				connectionId: "c2",
			})
		).result as CheckpointResult;
		expect(second.checkpointToken).not.toBe(first.checkpointToken);
		expect(second.revisionId).toBe(first.revisionId);
		expect(
			await handlers.dispatch({
				query: "transcript.list",
				cursor: second.checkpointToken,
				connectionId: "c2",
			}),
		).toMatchObject({ ok: true, page: { complete: true } });
	});

	it("rejects a tampered signed cursor (the pinned position cannot be rewound)", async () => {
		const { handlers } = harness(entries(4));
		const checkpoint = (await handlers.dispatch({ query: "session.checkpoint", connectionId: "c" }))
			.result as CheckpointResult;
		// Rewriting the pinned offset inside the signed envelope invalidates the
		// MAC, so a client can never replay before the checkpoint position.
		const forged = checkpoint.checkpointToken.replace('"offset":0', '"offset":9');
		expect(forged).not.toBe(checkpoint.checkpointToken);
		expect(verifyCursor(forged, "token")).toBeUndefined();
		const replay = await handlers.dispatch({
			query: "transcript.list",
			cursor: forged,
			connectionId: "c",
		});
		expect(replay).toMatchObject({ ok: false, error: { code: "invalid_cursor" } });
	});

	it("rejects empty, whitespace, and non-string checkpointToken inputs", async () => {
		const { handlers } = harness(entries(2));
		for (const bad of ["", "   ", 42, null]) {
			const response = await handlers.dispatch({
				query: "transcript.list",
				input: { checkpointToken: bad },
				connectionId: "c",
			});
			expect(response, `token=${String(bad)}`).toMatchObject({ ok: false, error: { code: "invalid_input" } });
		}
	});

	it("rejects checkpointToken on every query except transcript.list and session.checkpoint", async () => {
		const { handlers } = harness(entries(2));
		for (const query of ["transcript.body", "resource.body", "context.get", "todo.list"]) {
			const response = await handlers.dispatch({
				query,
				input: { checkpointToken: "signed-cursor" },
				connectionId: "c",
			});
			expect(response, query).toMatchObject({ ok: false, error: { code: "invalid_input" } });
		}
	});

	it("enforces checkpointToken and cursor mutual exclusion on Q01", async () => {
		const { handlers } = harness(entries(2));
		const both = await handlers.dispatch({
			query: "transcript.list",
			input: { checkpointToken: "signed-cursor" },
			cursor: "continuation",
			connectionId: "c",
		});
		expect(both).toMatchObject({ ok: false, error: { code: "invalid_input" } });
	});

	it("rejects empty top-level cursors instead of silently dropping them", async () => {
		const { handlers } = harness(entries(2));
		const response = await handlers.dispatch({ query: "transcript.list", cursor: "", connectionId: "c" });
		expect(response).toMatchObject({ ok: false, error: { code: "invalid_input" } });
	});

	it("rejects any input or cursor on Q30 itself (request shape per contract)", async () => {
		const { handlers } = harness(entries(2));
		const withInput = await handlers.dispatch({
			query: "session.checkpoint",
			input: { foo: 1 },
			connectionId: "c",
		});
		expect(withInput).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		const withCursor = await handlers.dispatch({
			query: "session.checkpoint",
			cursor: "not-a-cursor",
			connectionId: "c",
		});
		expect(withCursor).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});

	it("captures the exact event-ring watermark atomically with the snapshot", async () => {
		const watermark: SdkCheckpointRecord = { revision: 4, generation: 3, seq: 42 };
		const { handlers } = harness(entries(4), watermark);
		const checkpoint = (await handlers.dispatch({ query: "session.checkpoint", connectionId: "c" }))
			.result as CheckpointResult;
		expect(checkpoint.checkpoint).toEqual(watermark);
		const envelope = verifyCursor(checkpoint.checkpointToken, "token");
		expect(envelope?.highWatermark).toEqual(watermark);
	});

	it("honors the cursor TTL for checkpoint tokens and reissues after expiry", async () => {
		let now = 1_000;
		const store = new RevisionStore("s1", () => now);
		const cursors = new CursorRegistry("token", store, () => now);
		const handlers = new QueryHandlers(surface(entries(2)), "s1", store, cursors);
		const checkpoint = (await handlers.dispatch({ query: "session.checkpoint", connectionId: "c" }))
			.result as CheckpointResult;
		expect(checkpoint.issuedAt).toBe(1_000);
		expect(checkpoint.expiresAt).toBe(1_000 + CURSOR_TTL_MS);
		now += CURSOR_TTL_MS + 1;
		const replay = await handlers.dispatch({
			query: "transcript.list",
			cursor: checkpoint.checkpointToken,
			connectionId: "c",
		});
		expect(replay).toMatchObject({ ok: false, error: { code: "cursor_expired", restartQuery: true } });
		const reissued = (await handlers.dispatch({ query: "session.checkpoint", connectionId: "c" }))
			.result as CheckpointResult;
		expect(reissued.checkpointToken).not.toBe(checkpoint.checkpointToken);
		expect(
			await handlers.dispatch({
				query: "transcript.list",
				cursor: reissued.checkpointToken,
				connectionId: "c",
			}),
		).toMatchObject({ ok: true, page: { complete: true } });
	});

	it("keeps the checkpoint revision pinned through append churn (eviction resistance)", async () => {
		const transcript = entries(1);
		const { handlers } = harness(transcript);
		const checkpoint = (await handlers.dispatch({ query: "session.checkpoint", connectionId: "c" }))
			.result as CheckpointResult;
		// Nine further revisions on transcript:default would evict an unpinned
		// first revision (MAX_REVISIONS_PER_RESOURCE=8), but the pinned
		// checkpoint revision must survive and stay replayable.
		for (let index = 0; index < 9; index++) {
			transcript.push({ id: `churn-${index}`, role: "user", body: `churn-${index}` });
			await handlers.dispatch({ query: "transcript.list", connectionId: "c" });
		}
		const replay = await handlers.dispatch({
			query: "transcript.list",
			cursor: checkpoint.checkpointToken,
			connectionId: "c",
		});
		expect(replay).toMatchObject({ ok: true, page: { items: entries(1), complete: true } });
	});

	it("paginates the pinned snapshot with continuation cursors", async () => {
		const { handlers } = harness(largeEntries(20));
		const checkpoint = (await handlers.dispatch({ query: "session.checkpoint", connectionId: "c" }))
			.result as CheckpointResult;
		const first = pageOf(
			await handlers.dispatch({
				query: "transcript.list",
				cursor: checkpoint.checkpointToken,
				connectionId: "c",
			}),
		);
		expect(first.complete).toBe(false);
		expect(first.cursor).toBeDefined();
		const second = pageOf(
			await handlers.dispatch({
				query: "transcript.list",
				cursor: first.cursor,
				connectionId: "c",
			}),
		);
		expect(second.complete).toBe(true);
		expect([...first.items, ...second.items]).toHaveLength(20);
		expect(second.items[0]).toMatchObject({ id: `e${first.items.length}` });
	});

	it("honors the per-connection cursor budget", async () => {
		const { handlers } = harness(entries(1));
		for (let index = 0; index < 32; index++) {
			const response = await handlers.dispatch({ query: "session.checkpoint", connectionId: "c" });
			expect(response.ok, `grant ${index + 1}`).toBe(true);
		}
		const exceeded = await handlers.dispatch({ query: "session.checkpoint", connectionId: "c" });
		expect(exceeded).toMatchObject({ ok: false, error: { code: "snapshot_capacity_exceeded" } });
	});

	it("enforces installed-query authority for session.checkpoint", async () => {
		const store = new RevisionStore("s1");
		const query = new QueryHandlers(
			{ ...surface(entries(2)), installedQueries: new Set(["transcript.list"]) },
			"s1",
			store,
			new CursorRegistry("token", store),
		);
		const rejected = await query.dispatch({ query: "session.checkpoint", connectionId: "c" });
		expect(rejected).toMatchObject({
			ok: false,
			error: { code: "operation_not_session_owned" },
		});
		const advertised = new QueryHandlers(
			{ ...surface(entries(2)), installedQueries: new Set(["transcript.list", "session.checkpoint"]) },
			"s1",
			store,
			new CursorRegistry("token", store),
		);
		expect(await advertised.dispatch({ query: "session.checkpoint", connectionId: "c" })).toMatchObject({
			ok: true,
		});
	});

	it("validates checkpoint records strictly", () => {
		expect(isCheckpointRecord({ revision: 4, generation: 2, seq: 40 })).toBe(true);
		expect(isCheckpointRecord({ revision: -1, generation: 0, seq: 0 })).toBe(false);
		expect(isCheckpointRecord({ revision: 1, generation: 0 })).toBe(false);
		expect(isCheckpointRecord({ revision: 1, generation: 0, seq: 0, extra: 1 })).toBe(false);
		expect(isCheckpointRecord({ revision: 1.5, generation: 0, seq: 0 })).toBe(false);
	});
});
