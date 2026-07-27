import { expect, test } from "bun:test";
import {
	appendAppServerProjection,
	readAppServerProjections,
	validateAppServerProjectionEnvelope,
	type AppServerProjectionStore,
} from "../src/session/app-server-projection";
import { APP_SERVER_PROJECTION_CUSTOM_ENTRY_TYPE, SessionManager } from "../src/session/session-manager";
import { findOperation } from "../src/sdk/protocol/operation-registry";

function projectionStore(entries: Array<Record<string, unknown>>): AppServerProjectionStore {
	return {
		getEntries: () => entries as never,
		appendAppServerProjectionEntry: data => {
			const id = `entry-${entries.length + 1}`;
			entries.push({ id, type: "custom", customType: APP_SERVER_PROJECTION_CUSTOM_ENTRY_TYPE, data });
			return id;
		},
		flush: async () => {},
	};
}

test("app-server projection contract validates, persists ordinal cursors, and rejects conflicting idempotency keys", async () => {
	const entries: Array<Record<string, unknown>> = [];
	const store = projectionStore(entries);
	await expect(appendAppServerProjection(store, { sourceKey: "missing" })).rejects.toMatchObject({ code: "invalid_input" });
	const first = await appendAppServerProjection(store, {
		schemaVersion: 1,
		recordKind: "turn",
		sourceKey: "first",
		payload: { b: 2, a: 1 },
	});
	entries.push({ id: "unrelated", type: "custom", customType: "extension", data: {} });
	const reused = await appendAppServerProjection(store, {
		schemaVersion: 1,
		recordKind: "turn",
		sourceKey: "first",
		payload: { a: 1, b: 2 },
	});
	const second = await appendAppServerProjection(store, {
		schemaVersion: 1,
		recordKind: "turn",
		sourceKey: "second",
		payload: { ordinal: 2 },
	});
	expect(first.revision).toBe(1);
	expect(second.revision).toBe(2);
	expect(reused).toEqual({ entryId: first.entryId, revision: 1, reused: true });
	expect(readAppServerProjections(projectionStore(entries), 1)).toEqual({
		records: [{ entryId: second.entryId, envelope: { schemaVersion: 1, recordKind: "turn", sourceKey: "second", payload: { ordinal: 2 } } }],
		revision: 2,
	});
	expect(readAppServerProjections(store, 2).records).toEqual([]);
	expect(() => readAppServerProjections(store, -1)).toThrow(/afterRevision/);
	expect(() => validateAppServerProjectionEnvelope({ schemaVersion: 2 })).toThrow(/projection.append/);
});

test("projection persistence fails closed for malformed, duplicate, and non-monotonic reserved records", async () => {
	for (const data of [
		{ sourceKey: "forged", projectionOrdinal: "not-an-ordinal" },
		{ schemaVersion: 1, recordKind: "turn", sourceKey: "duplicate", payload: {}, projectionOrdinal: 1 },
		{ schemaVersion: 1, recordKind: "turn", sourceKey: "descending", payload: {}, projectionOrdinal: 0 },
	]) {
		const entries: Array<Record<string, unknown>> = [
			{ id: "first", type: "custom", customType: APP_SERVER_PROJECTION_CUSTOM_ENTRY_TYPE, data: { schemaVersion: 1, recordKind: "turn", sourceKey: "first", payload: {}, projectionOrdinal: 1 } },
			{ id: "corrupt", type: "custom", customType: APP_SERVER_PROJECTION_CUSTOM_ENTRY_TYPE, data },
		];
		const store = projectionStore(entries);
		expect(() => readAppServerProjections(store)).toThrow(/Persisted app-server projection/);
		await expect(appendAppServerProjection(store, { schemaVersion: 1, recordKind: "turn", sourceKey: "new", payload: {} })).rejects.toMatchObject({ code: "projection_corrupt" });
	}
});

test("reused projections flush before acknowledgement", async () => {
	const entries: Array<Record<string, unknown>> = [
		{ id: "entry-1", type: "custom", customType: APP_SERVER_PROJECTION_CUSTOM_ENTRY_TYPE, data: { schemaVersion: 1, recordKind: "turn", sourceKey: "first", payload: {}, projectionOrdinal: 1 } },
	];
	let flushes = 0;
	const store: AppServerProjectionStore = {
		getEntries: () => entries as never,
		appendAppServerProjectionEntry: () => "unexpected",
		flush: async () => {
			flushes++;
			if (flushes === 1) throw new Error("persistence failed");
		},
	};
	const envelope = { schemaVersion: 1, recordKind: "turn", sourceKey: "first", payload: {} };
	await expect(appendAppServerProjection(store, envelope)).rejects.toThrow("persistence failed");
	await expect(appendAppServerProjection(store, envelope)).resolves.toEqual({ entryId: "entry-1", revision: 1, reused: true });
});

test("generic custom entries cannot forge app-server projections", () => {
	const session = SessionManager.inMemory();
	expect(() => session.appendCustomEntry(APP_SERVER_PROJECTION_CUSTOM_ENTRY_TYPE, {})).toThrow(/reserved/);
});

test("projection operation inventory declares its typed errors", () => {
	expect(findOperation("control", "projection.append")?.errorCodes).toEqual([
		"invalid_input",
		"idempotency_conflict",
		"projection_corrupt",
	]);
	expect(findOperation("control", "projection.read")?.errorCodes).toEqual(["invalid_input", "projection_corrupt"]);
});
