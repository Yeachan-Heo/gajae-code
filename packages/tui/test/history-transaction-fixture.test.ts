import { describe, expect, it } from "bun:test";
import {
	assertSafeSharedTransaction,
	getCsiEraseGuardFailure,
	HistoryRecordingTerminal,
	HistoryTransactionFixture,
	SHARED_TRANSACTION_OPERATIONS,
	TransactionFixtureError,
} from "../src/testing/history-transaction-fixture";

describe("history transaction fixture", () => {
	it("records tagged shared attempts with immutable pre/post snapshots", () => {
		const fixture = new HistoryTransactionFixture({
			domainId: "domain-1",
			state: { cpCount: 1, eventCount: 1, cursor: { row: 2, column: 3 } },
		});

		const record = fixture.record("primary", "hello", () => {
			fixture.updateState({ cpCount: 2, eventCount: 2, cursor: { row: 2, column: 8 } });
		});

		expect(record).toMatchObject({
			domainId: "domain-1",
			operation: "primary",
			bytes: "hello",
			outcome: "accepted",
		});
		expect(record.pre.cpCount).toBe(1);
		expect(record.post.cpCount).toBe(2);
		expect(fixture.attempts).toEqual([
			expect.objectContaining({
				ordinal: 1,
				classification: "shared",
				operation: "primary",
				outcome: "accepted",
			}),
		]);
		expect(fixture.successfulWrites).toEqual([
			expect.objectContaining({ ordinal: 1, classification: "shared", bytes: "hello" }),
		]);
		expect(Object.isFrozen(record.pre)).toBe(true);
		expect(Object.isFrozen(record.pre.cursor)).toBe(true);
		expect(Object.isFrozen(record.post)).toBe(true);
	});

	it("keeps rejected and failed writes observable without false success", () => {
		const fixture = new HistoryTransactionFixture();
		fixture.failOnAttempt(1);
		expect(() => fixture.record("primary", "payload")).toThrow("injected failure");
		expect(fixture.attempts[0]).toMatchObject({
			ordinal: 1,
			operation: "primary",
			outcome: "failed",
		});
		expect(fixture.successfulWrites).toHaveLength(0);
		expect(fixture.acceptedRecords).toHaveLength(0);
		expect(fixture.rejectedRecords).toHaveLength(1);

		expect(() => fixture.record("not-an-operation", "payload")).toThrow("unknown transaction operation");
		expect(fixture.attempts[1]).toMatchObject({
			ordinal: 2,
			classification: "shared",
			outcome: "rejected",
		});
	});

	it("rejects all complete and incomplete 7-bit and 8-bit erase candidates", () => {
		const erasePayloads = [
			"\x1b[J",
			"\x1b[0J",
			"\x1b[?2J",
			"\x1b[1;2K",
			"\x1b[?25;2$K",
			"\x9bJ",
			"\x9b?2J",
			"\x9b1;2K",
		];
		for (const bytes of erasePayloads) {
			const failure = getCsiEraseGuardFailure(bytes);
			expect(failure?.code).toBe("erase-sequence");
			expect(() => assertSafeSharedTransaction(bytes)).toThrow(TransactionFixtureError);
		}

		const incompletePayloads = ["\x1b", "\x1b[", "\x1b[?2", "\x1b[1;", "\x9b", "\x9b?2"];
		for (const bytes of incompletePayloads) {
			expect(getCsiEraseGuardFailure(bytes)?.code).toBe("incomplete-csi");
			expect(() => assertSafeSharedTransaction(bytes)).toThrow(TransactionFixtureError);
		}

		for (const bytes of ["\x1b[31m", "\x9b31m", "text\x1b[2C"]) {
			expect(() => assertSafeSharedTransaction(bytes)).not.toThrow();
		}
	});

	it("rejects unsafe payload before apply and before successful delivery", () => {
		const fixture = new HistoryTransactionFixture();
		let applied = false;
		expect(() => fixture.record("page", "before\x1b[?2", () => {
			applied = true;
		})).toThrow("incomplete");
		expect(applied).toBe(false);
		expect(fixture.successfulWrites).toHaveLength(0);
		expect(fixture.attempts[0]).toMatchObject({ outcome: "rejected", operation: "page" });
	});

	it("separates exempt output and preserves the prior shared record on overlay failure", () => {
		const fixture = new HistoryTransactionFixture({ domainId: "domain-overlay" });
		const shared = fixture.record("primary", "shared-bytes");
		fixture.failNext("exempt");
		expect(() => fixture.writeExempt("overlay-bytes")).toThrow("injected failure");

		expect(fixture.attempts).toHaveLength(2);
		expect(fixture.attempts[0]).toMatchObject({ classification: "shared", outcome: "accepted" });
		expect(fixture.attempts[1]).toMatchObject({ classification: "exempt", outcome: "failed" });
		expect(fixture.successfulWrites).toHaveLength(1);
		expect(fixture.successfulWrites[0].bytes).toBe("shared-bytes");
		expect(fixture.acceptedRecords).toEqual([shared]);
		expect(fixture.rejectedRecords).toHaveLength(0);
		expect(fixture.exemptPhysicalOutput).toMatchObject([
			{ bytes: "overlay-bytes", outcome: "failed" },
		]);
	});

	it("supports deterministic next-operation failure and retry", () => {
		const fixture = new HistoryTransactionFixture();
		fixture.failNext("ime");
		expect(() => fixture.record("primary", "first")).not.toThrow();
		expect(() => fixture.record("ime", "cursor")).toThrow("injected failure");
		expect(() => fixture.record("ime", "cursor-retry")).not.toThrow();
		expect(fixture.successfulWrites.map((write) => write.bytes)).toEqual(["first", "cursor-retry"]);
		expect(fixture.acceptedRecords.map((record) => record.operation)).toEqual(["primary", "ime"]);
	});

	it("exposes an untagged write as a rejected tagged-boundary attempt", () => {
		const terminal = new HistoryRecordingTerminal();
		expect(() => terminal.write("untagged")).toThrow("missing transaction operation tag");
		expect(terminal.attempts).toMatchObject([
			{ classification: "shared", operation: undefined, outcome: "rejected", bytes: "untagged" },
		]);
		expect(terminal.rejectedRecords).toHaveLength(1);
	});

	it("keeps the operation union closed", () => {
		expect(SHARED_TRANSACTION_OPERATIONS).toEqual([
			"primary",
			"ft-restore",
			"page",
			"page-entry-or-repaint",
			"follow",
			"ime",
		]);
	});
});
