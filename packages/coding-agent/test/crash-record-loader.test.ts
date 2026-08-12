import { describe, expect, it } from "bun:test";
import { formatCrashRecordMarker } from "@gajae-code/utils";
import { findLatestRecord, parseCrashRecords } from "../src/crash/record-loader";

const FP_A = "a".repeat(32);
const FP_B = "b".repeat(32);

function recordWithStackHeader(fingerprint: string, recordId: string, message: string): string {
	return (
		`2026-08-11T12:00:00.000Z pid=4242 [Uncaught Exception] Error: ${message}\n` +
		`Error: ${message}\n    at frame (x.ts:1:1)\n${formatCrashRecordMarker(fingerprint, 1, recordId)}\n\n`
	);
}

function record(fingerprint: string, recordId: string, message: string, body: string): string {
	return (
		`2026-08-11T12:00:00.000Z pid=4242 [Uncaught Exception] Error: ${message}\n` +
		`${body}\n${formatCrashRecordMarker(fingerprint, 1, recordId)}\n\n`
	);
}

describe("parseCrashRecords", () => {
	it("recovers identity-bearing records and ignores legacy ones", () => {
		const log =
			"2026-08-02T17:05:35.948Z pid=2557873 [Uncaught Exception] Error: legacy record with no identity\n    at x\n\n" +
			record(FP_A, "0123456789abcdef", "shared topic authority unavailable", "    at resolveTopic (topics.ts:1:1)");
		const records = parseCrashRecords(log);
		expect(records).toHaveLength(1);
		expect(records[0]?.fingerprint).toBe(FP_A);
		expect(records[0]?.headline).toBe("Error: shared topic authority unavailable");
		expect(records[0]?.body).toBe("    at resolveTopic (topics.ts:1:1)");
	});

	it("re-establishes boundaries so an interleaved neighbour cannot smear into the next record", () => {
		// The real corpus contains two crash headers merged onto one line under
		// concurrent writers; the record that follows must stay clean.
		const log =
			"2026-08-02T17:05:35.948Z pid=2557873 [Uncaught Exception] Error: ENOSPC 2026-08-02T17:05:35.948Z pid=1 [Uncaught Exception] Error: EIO\n" +
			"    at interleaved\n" +
			record(FP_B, "fedcba9876543210", "clean record", "    at clean (x.ts:1:1)");
		const records = parseCrashRecords(log);
		expect(records).toHaveLength(1);
		expect(records[0]?.body).toBe("    at clean (x.ts:1:1)");
		expect(records[0]?.body).not.toContain("interleaved");
	});

	it("returns the newest record for a fingerprint", () => {
		const log =
			record(FP_A, "1111111111111111", "first", "    at a") + record(FP_A, "2222222222222222", "second", "    at b");
		expect(findLatestRecord(log, FP_A)?.recordId).toBe("2222222222222222");
		expect(findLatestRecord(log, FP_B)).toBeUndefined();
	});

	it("drops the stack's duplicate headline so the rendered report says it once", () => {
		const records = parseCrashRecords(recordWithStackHeader(FP_A, "0123456789abcdef", "boom"));
		expect(records[0]?.headline).toBe("Error: boom");
		expect(records[0]?.body).toBe("    at frame (x.ts:1:1)");
	});

	it("ignores a forged marker that has no record header before it", () => {
		const log = `${formatCrashRecordMarker(FP_A, 1, "0123456789abcdef")}\n`;
		expect(parseCrashRecords(log)).toHaveLength(0);
	});
});
