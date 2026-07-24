import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { TuiTransactionObservation } from "@gajae-code/tui";
import { TuiTransactionHistory } from "../../src/debug/tui-transaction-history";

function observation(
	classification: TuiTransactionObservation["classification"],
	bytes = "hello",
	operation: TuiTransactionObservation["operation"] = "primary",
	outcome: TuiTransactionObservation["outcome"] = "accepted",
): TuiTransactionObservation {
	return { classification, bytes, operation, outcome };
}

describe("TuiTransactionHistory", () => {
	it("stores metadata for shared observations without retaining terminal bytes", () => {
		const history = new TuiTransactionHistory({ now: () => 1234 });
		const bytes = "héllo";

		history.record(observation("shared", bytes, "page", "failed"), "session-1");

		const snapshot = history.snapshot();
		expect(snapshot.records).toEqual([
			{
				sessionId: "session-1",
				sequence: 1,
				timestamp: 1234,
				operation: "page",
				outcome: "failed",
				byteLength: Buffer.byteLength(bytes, "utf8"),
				sha256: createHash("sha256").update(bytes, "utf8").digest("hex"),
			},
		]);
		expect(snapshot.records[0]).not.toHaveProperty("bytes");
	});

	it("ignores exempt observations", () => {
		const history = new TuiTransactionHistory();

		history.record(observation("exempt", "private overlay bytes"), "session-1");

		expect(history.snapshot()).toEqual({ records: [], droppedRecords: 0, totalSharedObservations: 0 });
	});

	it("evicts oldest records at the configured FIFO capacity", () => {
		let now = 10;
		const history = new TuiTransactionHistory({ capacity: 2, now: () => now++ });

		history.record(observation("shared", "one"), "session-1");
		history.record(observation("shared", "two"), "session-1");
		history.record(observation("shared", "three"), "session-1");

		const snapshot = history.snapshot();
		expect(snapshot.records.map(record => record.sequence)).toEqual([2, 3]);
		expect(snapshot.droppedRecords).toBe(1);
		expect(snapshot.totalSharedObservations).toBe(3);
	});

	it("returns immutable snapshots isolated from subsequent records", () => {
		const history = new TuiTransactionHistory();
		history.record(observation("shared"), "session-1");
		const snapshot = history.snapshot();

		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.records)).toBe(true);
		expect(Object.isFrozen(snapshot.records[0])).toBe(true);

		history.record(observation("shared", "later"), "session-1");
		expect(snapshot.records).toHaveLength(1);
		expect(history.snapshot().records).toHaveLength(2);
	});
});
