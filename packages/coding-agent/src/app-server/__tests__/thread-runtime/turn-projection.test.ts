import { expect, test } from "bun:test";
import type { ThreadItem } from "../../../../vendor/codex-app-server-schema/stable/typescript/v2/ThreadItem";
import type { Turn } from "../../../../vendor/codex-app-server-schema/stable/typescript/v2/Turn";
import type { SessionClient, SessionRequestOptions } from "../../thread-runtime/child-bridge";
import type { ProjectionEnvelope, ProjectionRecord } from "../../thread-runtime/turn-projection";
import {
	appendProjectionRecord,
	makeTurnCreatedRecord,
	makeTurnItemCompletedRecord,
	makeTurnTerminalRecord,
	ProjectionCorruptError,
	readAndReconstructTurns,
	readProjectionRecords,
	reconstructTurnSnapshots,
	TurnProjectionReducer,
} from "../../thread-runtime/turn-projection";

const turn = (id: string, status: Turn["status"] = "inProgress", items: ThreadItem[] = []): Turn => ({
	id,
	items,
	itemsView: "full",
	status,
	error: status === "failed" ? { message: "failed", codexErrorInfo: null, additionalDetails: null } : null,
	startedAt: 10,
	completedAt: status === "inProgress" ? null : 11,
	durationMs: status === "inProgress" ? null : 1,
});

const item = (id: string, text: string): ThreadItem => ({
	type: "agentMessage",
	id,
	text,
	phase: null,
	memoryCitation: null,
});

const created = makeTurnCreatedRecord({
	turn: turn("app-turn"),
	commandId: "command-1",
	turnId: "child-turn-1",
	clientRef: "client-ref-1",
	replayToken: "replay-1",
});

const completed = makeTurnItemCompletedRecord(
	{ turnId: "app-turn", item: item("item-1", "hello"), order: 0 },
	{ commandId: "command-1", turnId: "child-turn-1" },
	"app-turn",
);

const terminal = makeTurnTerminalRecord(
	{ turn: turn("app-turn", "completed", [item("item-1", "hello")]) },
	{ commandId: "command-1", turnId: "child-turn-1" },
);

const revised = <P extends ProjectionEnvelope["payload"]>(
	record: ProjectionEnvelope<P>,
	revision: number,
): ProjectionRecord<P> => ({ ...record, revision });

test("projection reducer reconstructs one terminal Turn with stable ordered items", () => {
	const snapshots = reconstructTurnSnapshots([revised(created, 1), revised(completed, 2), revised(terminal, 3)]);
	expect(snapshots).toHaveLength(1);
	expect(snapshots[0]).toEqual(terminal.payload.turn);
	expect(snapshots[0]?.items).toEqual([item("item-1", "hello")]);
});

test("projection reducer accepts identical idempotent duplicates without duplicating items", () => {
	const reducer = new TurnProjectionReducer();
	reducer.apply(revised(created, 1));
	reducer.apply(revised(created, 1));
	reducer.apply(revised(completed, 2));
	reducer.apply(revised(completed, 2));
	expect(reducer.snapshots()).toHaveLength(1);
	expect(reducer.snapshot("app-turn").items).toHaveLength(1);
});

test("projection reducer fails closed for malformed ordering and missing prerequisites", () => {
	expect(() => reconstructTurnSnapshots([])).toThrow(ProjectionCorruptError);
	expect(() => reconstructTurnSnapshots([revised(completed, 1)])).toThrow("precedes its created turn");
	expect(() => reconstructTurnSnapshots([revised(created, 1), revised(completed, 3)])).toThrow("revision gap");
	expect(() =>
		reconstructTurnSnapshots([
			revised(created, 1),
			revised({ ...completed, payload: { ...completed.payload, order: 2 } }, 2),
		]),
	).toThrow("item order");
});

test("projection reducer rejects conflicting duplicate item, turn, and terminal data", () => {
	const conflictingItem = makeTurnItemCompletedRecord(
		{ turnId: "app-turn", item: item("item-1", "different"), order: 0 },
		{ commandId: "command-1", turnId: "child-turn-1" },
		"app-turn",
	);
	const conflictingTerminal = makeTurnTerminalRecord(
		{ turn: turn("app-turn", "failed", [item("item-1", "hello")]) },
		{ commandId: "command-1", turnId: "child-turn-1" },
	);
	const reducer = new TurnProjectionReducer();
	reducer.apply(revised(created, 1));
	reducer.apply(revised(completed, 2));
	expect(() => reducer.apply(revised(conflictingItem, 3))).toThrow("conflicts");
	reducer.apply(revised(terminal, 3));
	expect(() => reducer.apply(revised(conflictingTerminal, 4))).toThrow("conflicts");
});

test("projection reducer rejects terminal snapshots with open or unpersisted items", () => {
	const openTerminal = makeTurnTerminalRecord(
		{ turn: turn("app-turn", "completed", [item("item-open", "not persisted")]) },
		{ commandId: "command-1", turnId: "child-turn-1" },
	);
	const reducer = new TurnProjectionReducer();
	reducer.apply(revised(created, 1));
	expect(() => reducer.apply(revised(openTerminal, 2))).toThrow("open items");
});

test("projection controls use production append/read wrappers and contiguous revisions", async () => {
	const calls: Array<{ operation: string; input: Record<string, unknown>; options?: SessionRequestOptions }> = [];
	const envelopes = [created, completed, terminal];
	const client: SessionClient = {
		onFrame: () => () => {},
		onReconnect: () => () => {},
		onReconnectFailed: () => () => {},
		request: async () => ({}),
		query: async () => ({}),
		control: async (operation, input = {}, options) => {
			calls.push({ operation, input, options });
			if (operation === "projection.append") return { entryId: "projection-1", revision: 1 };
			if (operation === "projection.read")
				return {
					records: envelopes.map((envelope, index) => ({ entryId: `projection-${index + 1}`, envelope })),
					revision: 3,
				};
			return {};
		},
		close: async () => {},
	};

	const appended = await appendProjectionRecord(client, created);
	expect(appended.revision).toBe(1);
	expect(calls[0]).toEqual({
		operation: "projection.append",
		input: { envelope: created },
		options: { idempotencyKey: created.sourceKey, confirm: true },
	});
	const read = await readProjectionRecords(client, 0);
	expect(read.revision).toBe(3);
	expect(read.records.map(record => record.revision)).toEqual([1, 2, 3]);
	expect(await readAndReconstructTurns(client)).toEqual([terminal.payload.turn]);
});

test("projection read rejects gaps between the requested and returned revisions", async () => {
	const client: SessionClient = {
		onFrame: () => () => {},
		onReconnect: () => () => {},
		onReconnectFailed: () => () => {},
		request: async () => ({}),
		query: async () => ({}),
		control: async () => ({ records: [{ entryId: "projection-3", envelope: terminal }], revision: 3 }),
		close: async () => {},
	};
	await expect(readProjectionRecords(client, 1)).rejects.toThrow("non-contiguous revision range");
});

test("projection append preserves idempotency conflicts", async () => {
	const client: SessionClient = {
		onFrame: () => () => {},
		onReconnect: () => () => {},
		onReconnectFailed: () => () => {},
		request: async () => ({}),
		query: async () => ({}),
		control: async () => ({
			ok: false,
			error: { code: "idempotency_conflict", message: "source key conflict" },
		}),
		close: async () => {},
	};
	await expect(appendProjectionRecord(client, created)).rejects.toMatchObject({
		code: "idempotency_conflict",
	});
});
