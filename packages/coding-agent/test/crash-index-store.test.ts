import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendCrashEvent, type CrashEvent, formatCrashRecordMarker } from "@gajae-code/utils";
import {
	CRASH_INDEX_MAX_SIGNATURES,
	type CrashStatePaths,
	compactCrashIndex,
	listCrashSignatures,
	parseCrashIndex,
	readCrashIndex,
	recordCrashStateEvent,
} from "../src/crash/index-store";

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0);

function fingerprintFor(seed: number): string {
	return seed.toString(16).padStart(32, "0");
}

async function tempPaths(): Promise<CrashStatePaths> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-crash-index-"));
	return {
		index: path.join(dir, "gjc-crash-index.json"),
		events: path.join(dir, "gjc-crash-events.jsonl"),
		crashLog: path.join(dir, "gjc-crash.log"),
	};
}

function occurrence(fingerprint: string, recordId: string, at = NOW): CrashEvent {
	return {
		kind: "occurrence",
		fingerprint,
		fpv: 1,
		recordId,
		at,
		errorName: "Error",
		messageClass: "shared topic authority unavailable",
	};
}

function recordId(seed: number): string {
	return seed.toString(16).padStart(16, "0");
}

/** One identity-bearing crash-log record, exactly as `recordFatalCrash` writes it. */
function logRecord(seed: number, id: number, iso: string): string {
	return (
		`${iso} pid=1 [Uncaught Exception] Error: shared topic authority unavailable\n` +
		`    at <anonymous> (telegram-daemon.ts:1:1)\n` +
		`${formatCrashRecordMarker(fingerprintFor(seed), 1, recordId(id))}\n\n`
	);
}

describe("compactCrashIndex", () => {
	it("counts every journaled occurrence exactly once, including across repeated compactions", async () => {
		const paths = await tempPaths();
		for (let index = 0; index < 5; index++)
			appendCrashEvent(occurrence(fingerprintFor(1), recordId(index)), paths.events);
		await compactCrashIndex({ paths, now: NOW });
		for (let index = 5; index < 8; index++)
			appendCrashEvent(occurrence(fingerprintFor(1), recordId(index)), paths.events);
		const merged = await compactCrashIndex({ paths, now: NOW });

		expect(merged.signatures[fingerprintFor(1)]?.lifetimeCount).toBe(8);
		// Re-running with an empty journal must not change counts.
		const again = await compactCrashIndex({ paths, now: NOW });
		expect(again.signatures[fingerprintFor(1)]?.lifetimeCount).toBe(8);
	});

	it("produces exact counts under concurrent compactors", async () => {
		const paths = await tempPaths();
		const total = 24;
		for (let index = 0; index < total; index++)
			appendCrashEvent(occurrence(fingerprintFor(2), recordId(index)), paths.events);
		await Promise.all([
			compactCrashIndex({ paths, now: NOW }),
			compactCrashIndex({ paths, now: NOW }),
			compactCrashIndex({ paths, now: NOW }),
		]);
		const index = await compactCrashIndex({ paths, now: NOW });
		expect(index.signatures[fingerprintFor(2)]?.lifetimeCount).toBe(total);
	});

	it("tracks retained counts from the crash log separately from lifetime counts", async () => {
		const paths = await tempPaths();
		for (let index = 0; index < 4; index++)
			appendCrashEvent(occurrence(fingerprintFor(3), recordId(index)), paths.events);
		// The capped crash log only still holds the newest record.
		await fs.writeFile(
			paths.crashLog,
			`2026-08-11T12:00:00.000Z pid=1 [Uncaught Exception] Error: x\n${formatCrashRecordMarker(fingerprintFor(3), 1, recordId(3))}\n`,
		);
		const index = await compactCrashIndex({ paths, now: NOW });
		expect(index.signatures[fingerprintFor(3)]?.lifetimeCount).toBe(4);
		expect(index.signatures[fingerprintFor(3)]?.retainedCount).toBe(1);
	});

	it("recovers a signature from identity-bearing log records whose journal events were lost", async () => {
		const paths = await tempPaths();
		// The fatal journal latches after the first append, so a process that dies
		// twice writes two records and one event. Here both events are missing.
		await fs.writeFile(
			paths.crashLog,
			`${logRecord(20, 100, "2026-08-11T12:00:00.000Z")}${logRecord(20, 101, "2026-08-11T13:00:00.000Z")}`,
		);
		const index = await compactCrashIndex({ paths, now: NOW });

		// The journal stays the only thing that advances a count, so a recovered
		// signature reports the one adopted occurrence as a lower bound.
		const entry = index.signatures[fingerprintFor(20)];
		expect(entry).toBeDefined();
		expect(entry?.lifetimeCount).toBe(1);
		expect(entry?.retainedCount).toBe(1);
		expect(entry?.errorName).toBe("Error");
		expect(entry?.messageClass).toBe("shared topic authority unavailable");
		expect(entry?.firstSeen).toBe(Date.parse("2026-08-11T12:00:00.000Z"));
		expect(entry?.lastSeen).toBe(Date.parse("2026-08-11T13:00:00.000Z"));
		expect(entry?.lastRecordId).toBe(recordId(101));
	});

	it("never offers a record that carries no identity line", async () => {
		const paths = await tempPaths();
		await fs.writeFile(
			paths.crashLog,
			"2026-08-11T12:00:00.000Z pid=1 [Uncaught Exception] Error: legacy record\n\n",
		);
		const index = await compactCrashIndex({ paths, now: NOW });
		expect(Object.keys(index.signatures)).toHaveLength(0);
	});

	it("caps the retained count at the journaled lifetime so the written index survives its own parser", async () => {
		const paths = await tempPaths();
		appendCrashEvent(occurrence(fingerprintFor(21), recordId(200)), paths.events);
		await fs.writeFile(
			paths.crashLog,
			`${logRecord(21, 200, "2026-08-11T12:00:00.000Z")}${logRecord(21, 201, "2026-08-11T12:30:00.000Z")}` +
				logRecord(21, 202, "2026-08-11T13:00:00.000Z"),
		);
		const index = await compactCrashIndex({ paths, now: NOW });

		expect(index.signatures[fingerprintFor(21)]?.lifetimeCount).toBe(1);
		expect(index.signatures[fingerprintFor(21)]?.retainedCount).toBe(1);
		// A retained count above the lifetime count is rejected by `parseCrashIndex`,
		// so emitting one would quarantine the index on the next read.
		expect(parseCrashIndex(await fs.readFile(paths.index, "utf8"), NOW)).toBeDefined();
	});

	it("does not double count a recovered record when its journal event is merged later", async () => {
		const paths = await tempPaths();
		await fs.writeFile(paths.crashLog, logRecord(22, 300, "2026-08-11T12:00:00.000Z"));
		expect((await compactCrashIndex({ paths, now: NOW })).signatures[fingerprintFor(22)]?.lifetimeCount).toBe(1);

		appendCrashEvent(occurrence(fingerprintFor(22), recordId(300)), paths.events);
		const index = await compactCrashIndex({ paths, now: NOW });
		expect(index.signatures[fingerprintFor(22)]?.lifetimeCount).toBe(1);
	});

	it("adopts a record whose message carries control characters without quarantining the index", async () => {
		const paths = await tempPaths();
		await fs.writeFile(
			paths.crashLog,
			"2026-08-11T12:00:00.000Z pid=1 [Uncaught Exception] Error: spawn\u001b[31m failed\tretry\n" +
				`${formatCrashRecordMarker(fingerprintFor(23), 1, recordId(500))}\n\n`,
		);
		const index = await compactCrashIndex({ paths, now: NOW });

		expect(index.signatures[fingerprintFor(23)]?.messageClass).toBe("spawn [31m failed retry");
		expect(parseCrashIndex(await fs.readFile(paths.index, "utf8"), NOW)).toBeDefined();
	});

	it("keeps the occurrence dedupe window intact while adopting a log full of unseen signatures", async () => {
		const paths = await tempPaths();
		appendCrashEvent(occurrence(fingerprintFor(30), recordId(400)), paths.events);
		await compactCrashIndex({ paths, now: NOW });

		// Far more unseen signatures than the index can hold, so a per-record
		// adoption would flush the bounded dedupe window.
		let log = "";
		for (let seed = 1000; seed < 1300; seed++) log += logRecord(seed, seed, "2026-08-11T12:00:00.000Z");
		await fs.writeFile(paths.crashLog, log);
		await compactCrashIndex({ paths, now: NOW });

		// A re-merged journal line for an already-counted record must still dedupe.
		appendCrashEvent(occurrence(fingerprintFor(30), recordId(400)), paths.events);
		const index = await compactCrashIndex({ paths, now: NOW });
		expect(index.signatures[fingerprintFor(30)]?.lifetimeCount).toBe(1);
	});

	it("ignores bare identity lines that no record header frames", async () => {
		const paths = await tempPaths();
		appendCrashEvent(occurrence(fingerprintFor(24), recordId(600)), paths.events);
		let log = logRecord(24, 600, "2026-08-11T12:00:00.000Z");
		// A rewritten log can repeat an identity line without the record it claims;
		// reporting could never load those, so they must not count as crashes.
		for (let extra = 0; extra < 40; extra++)
			log += `${formatCrashRecordMarker(fingerprintFor(24), 1, recordId(601 + extra))}\n`;
		await fs.writeFile(paths.crashLog, log);
		const index = await compactCrashIndex({ paths, now: NOW });

		expect(index.signatures[fingerprintFor(24)]?.lifetimeCount).toBe(1);
		expect(index.signatures[fingerprintFor(24)]?.retainedCount).toBe(1);
	});

	it("refuses a record whose message only fits before JSON escaping", async () => {
		const paths = await tempPaths();
		await fs.writeFile(
			paths.crashLog,
			`2026-08-11T12:00:00.000Z pid=1 [Uncaught Exception] Error: ${'\\"'.repeat(256)}\n` +
				`${formatCrashRecordMarker(fingerprintFor(25), 1, recordId(700))}\n\n`,
		);
		const index = await compactCrashIndex({ paths, now: NOW });

		expect(index.signatures[fingerprintFor(25)]).toBeUndefined();
		expect(parseCrashIndex(await fs.readFile(paths.index, "utf8"), NOW)).toBeDefined();
	});

	it("falls back to an older record when the newest one cannot be adopted", async () => {
		const paths = await tempPaths();
		await fs.writeFile(
			paths.crashLog,
			logRecord(29, 1300, "2026-08-11T12:00:00.000Z") +
				`2026-08-11T13:00:00.000Z pid=1 [Uncaught Exception] Error: ${'\\"'.repeat(256)}\n` +
				`${formatCrashRecordMarker(fingerprintFor(29), 1, recordId(1301))}\n\n`,
		);
		const index = await compactCrashIndex({ paths, now: NOW });

		// The newest record of this signature is unusable; the older one still proves
		// the crash, so the signature must not be starved.
		expect(index.signatures[fingerprintFor(29)]?.lastRecordId).toBe(recordId(1300));
		expect(parseCrashIndex(await fs.readFile(paths.index, "utf8"), NOW)).toBeDefined();
	});

	it("adopts a signature whose journal event was refused while the index was full", async () => {
		const paths = await tempPaths();
		for (let seed = 1; seed <= CRASH_INDEX_MAX_SIGNATURES; seed++)
			appendCrashEvent(occurrence(fingerprintFor(seed), recordId(seed), NOW - seed * 1000), paths.events);
		await compactCrashIndex({ paths, now: NOW });

		// The event for an unseen signature is refused because nothing is evictable.
		appendCrashEvent(occurrence(fingerprintFor(3000), recordId(1400)), paths.events);
		await fs.writeFile(paths.crashLog, logRecord(3000, 1400, "2026-08-11T12:00:00.000Z"));
		expect((await compactCrashIndex({ paths, now: NOW })).signatures[fingerprintFor(3000)]).toBeUndefined();

		// Room appears. A refused occurrence was never counted, so its id must not
		// suppress the recovery its crash-log record still makes possible.
		await recordCrashStateEvent(
			{
				kind: "reported",
				fingerprint: fingerprintFor(5),
				at: NOW,
				issueUrl: "https://github.com/Yeachan-Heo/gajae-code/issues/1",
			},
			{ paths, now: NOW },
		);
		const index = await compactCrashIndex({ paths, now: NOW });
		expect(index.signatures[fingerprintFor(3000)]?.lifetimeCount).toBe(1);
	});

	it("does not displace a journaled occurrence id when a full index refuses an adoption", async () => {
		const paths = await tempPaths();
		// Fill the index with unreported signatures, which are never evictable.
		for (let seed = 1; seed <= CRASH_INDEX_MAX_SIGNATURES; seed++)
			appendCrashEvent(occurrence(fingerprintFor(seed), recordId(seed), NOW - seed * 1000), paths.events);
		await compactCrashIndex({ paths, now: NOW });

		await fs.writeFile(paths.crashLog, logRecord(2000, 800, "2026-08-11T12:00:00.000Z"));
		const refused = await compactCrashIndex({ paths, now: NOW });
		expect(refused.signatures[fingerprintFor(2000)]).toBeUndefined();
		expect(refused.recentEventIds).toContain(`${fingerprintFor(1)}:${recordId(1)}`);

		// The displaced id would otherwise be counted a second time here.
		appendCrashEvent(occurrence(fingerprintFor(1), recordId(1), NOW - 1000), paths.events);
		const index = await compactCrashIndex({ paths, now: NOW });
		expect(index.signatures[fingerprintFor(1)]?.lifetimeCount).toBe(1);
	});

	it("counts a record written after journal rotation exactly once for an existing signature", async () => {
		const paths = await tempPaths();
		appendCrashEvent(occurrence(fingerprintFor(26), recordId(1000)), paths.events);
		await fs.writeFile(paths.crashLog, logRecord(26, 1000, "2026-08-11T12:00:00.000Z"));
		expect((await compactCrashIndex({ paths, now: NOW })).signatures[fingerprintFor(26)]?.lifetimeCount).toBe(1);

		// A fatal lands its log record after the journal was rotated aside; its event
		// is only drained by the next compaction.
		await fs.appendFile(paths.crashLog, logRecord(26, 1001, "2026-08-11T12:05:00.000Z"));
		await compactCrashIndex({ paths, now: NOW });
		appendCrashEvent(occurrence(fingerprintFor(26), recordId(1001)), paths.events);

		const index = await compactCrashIndex({ paths, now: NOW });
		expect(index.signatures[fingerprintFor(26)]?.lifetimeCount).toBe(2);
	});

	it("counts a record id repeated under two fingerprints once per signature", async () => {
		const paths = await tempPaths();
		// A rewritten log can repeat one record id under two fingerprints. Neither may
		// be counted twice, and neither may suppress the other.
		await fs.writeFile(
			paths.crashLog,
			`${logRecord(27, 1200, "2026-08-11T12:00:00.000Z")}${logRecord(28, 1200, "2026-08-11T12:30:00.000Z")}`,
		);
		await compactCrashIndex({ paths, now: NOW });
		appendCrashEvent(occurrence(fingerprintFor(27), recordId(1200)), paths.events);
		const index = await compactCrashIndex({ paths, now: NOW });

		expect(index.signatures[fingerprintFor(27)]?.lifetimeCount).toBe(1);
		expect(index.signatures[fingerprintFor(28)]?.lifetimeCount).toBe(1);
		expect(parseCrashIndex(await fs.readFile(paths.index, "utf8"), NOW)).toBeDefined();
	});

	it("does not let a journaled id under one fingerprint suppress adoption under another", async () => {
		const paths = await tempPaths();
		const sharedId = recordId(1250);
		appendCrashEvent(occurrence(fingerprintFor(27), sharedId), paths.events);
		await fs.writeFile(paths.crashLog, logRecord(28, 1250, "2026-08-11T12:30:00.000Z"));

		const index = await compactCrashIndex({ paths, now: NOW });

		expect(index.signatures[fingerprintFor(27)]?.lifetimeCount).toBe(1);
		expect(index.signatures[fingerprintFor(28)]?.lifetimeCount).toBe(1);
	});

	it("dedupes retained record ids per fingerprint", async () => {
		const paths = await tempPaths();
		const sharedId = recordId(1251);
		appendCrashEvent(occurrence(fingerprintFor(27), sharedId), paths.events);
		appendCrashEvent(occurrence(fingerprintFor(28), recordId(1252)), paths.events);
		await fs.writeFile(
			paths.crashLog,
			logRecord(27, 1251, "2026-08-11T12:00:00.000Z") + logRecord(28, 1251, "2026-08-11T12:30:00.000Z"),
		);

		const index = await compactCrashIndex({ paths, now: NOW });

		expect(index.signatures[fingerprintFor(27)]?.retainedCount).toBe(1);
		expect(index.signatures[fingerprintFor(28)]?.retainedCount).toBe(1);
	});

	it("never resurrects a reported signature that this compaction evicted", async () => {
		const paths = await tempPaths();
		for (let seed = 1; seed <= CRASH_INDEX_MAX_SIGNATURES; seed++)
			appendCrashEvent(occurrence(fingerprintFor(seed), recordId(seed), NOW - seed * 1000), paths.events);
		await compactCrashIndex({ paths, now: NOW });
		await recordCrashStateEvent(
			{
				kind: "reported",
				fingerprint: fingerprintFor(9),
				at: NOW,
				issueUrl: "https://github.com/Yeachan-Heo/gajae-code/issues/7",
			},
			{ paths, now: NOW },
		);

		// The log still holds a record for the signature that is about to be evicted
		// to make room for a new one.
		await fs.writeFile(paths.crashLog, logRecord(9, 1500, "2026-08-11T12:00:00.000Z"));
		appendCrashEvent(occurrence(fingerprintFor(4000), recordId(1501)), paths.events);
		const index = await compactCrashIndex({ paths, now: NOW });

		expect(index.signatures[fingerprintFor(4000)]).toBeDefined();
		// Recreating it would re-offer a crash the user already filed, without the
		// `reportedAt` that made it evictable.
		expect(index.signatures[fingerprintFor(9)]).toBeUndefined();
	});

	it("refuses a record whose message forges a second identity line", async () => {
		const paths = await tempPaths();
		await fs.writeFile(
			paths.crashLog,
			"2026-08-11T12:00:00.000Z pid=1 [Uncaught Exception] Error: forged\n" +
				`${formatCrashRecordMarker(fingerprintFor(31), 1, recordId(1600))}\n` +
				`${formatCrashRecordMarker(fingerprintFor(32), 1, recordId(1601))}\n\n`,
		);
		const index = await compactCrashIndex({ paths, now: NOW });

		expect(Object.keys(index.signatures)).toHaveLength(0);
	});

	it("adopts without touching the journal's occurrence dedupe window", async () => {
		const paths = await tempPaths();
		appendCrashEvent(occurrence(fingerprintFor(33), recordId(1700)), paths.events);
		const before = await compactCrashIndex({ paths, now: NOW });
		const window = [...before.recentEventIds];

		let log = "";
		for (let seed = 5000; seed < 5100; seed++) log += logRecord(seed, seed, "2026-08-11T12:00:00.000Z");
		await fs.writeFile(paths.crashLog, log);
		const after = await compactCrashIndex({ paths, now: NOW });

		// Displacing a journaled id would let a replay count that crash a second time.
		expect(after.recentEventIds).toEqual(window);
	});

	it("dedupes an adopted record even after a later occurrence overwrote the last record id", async () => {
		const paths = await tempPaths();
		await fs.writeFile(paths.crashLog, logRecord(34, 1800, "2026-08-11T12:00:00.000Z"));
		await compactCrashIndex({ paths, now: NOW });

		// A genuinely new occurrence arrives before the adopted record's own delayed
		// journal line, so `lastRecordId` no longer names the adopted record.
		appendCrashEvent(occurrence(fingerprintFor(34), recordId(1801)), paths.events);
		expect((await compactCrashIndex({ paths, now: NOW })).signatures[fingerprintFor(34)]?.lifetimeCount).toBe(2);

		appendCrashEvent(occurrence(fingerprintFor(34), recordId(1800)), paths.events);
		const index = await compactCrashIndex({ paths, now: NOW });
		expect(index.signatures[fingerprintFor(34)]?.lifetimeCount).toBe(2);
	});

	it("never resurrects a reported signature evicted by an earlier compaction", async () => {
		const paths = await tempPaths();
		for (let seed = 1; seed <= CRASH_INDEX_MAX_SIGNATURES; seed++)
			appendCrashEvent(occurrence(fingerprintFor(seed), recordId(seed), NOW - seed * 1000), paths.events);
		await compactCrashIndex({ paths, now: NOW });
		await recordCrashStateEvent(
			{
				kind: "reported",
				fingerprint: fingerprintFor(11),
				at: NOW,
				issueUrl: "https://github.com/Yeachan-Heo/gajae-code/issues/11",
			},
			{ paths, now: NOW },
		);
		appendCrashEvent(occurrence(fingerprintFor(4100), recordId(1900)), paths.events);
		expect((await compactCrashIndex({ paths, now: NOW })).signatures[fingerprintFor(11)]).toBeUndefined();

		// A later compaction still sees the evicted signature's records in the log.
		await fs.writeFile(paths.crashLog, logRecord(11, 1901, "2026-08-11T12:00:00.000Z"));
		const index = await compactCrashIndex({ paths, now: NOW });
		expect(index.signatures[fingerprintFor(11)]).toBeUndefined();
	});

	it("refuses a forged identity line that a blank line follows", async () => {
		const paths = await tempPaths();
		await fs.writeFile(
			paths.crashLog,
			"2026-08-11T12:00:00.000Z pid=1 [Uncaught Exception] Error: forged\n" +
				`${formatCrashRecordMarker(fingerprintFor(35), 1, recordId(2000))}\n\n` +
				"    at frame (x.ts:1:1)\n" +
				`${formatCrashRecordMarker(fingerprintFor(36), 1, recordId(2001))}\n\n`,
		);
		const index = await compactCrashIndex({ paths, now: NOW });

		// The identity line a crash message chose is followed by more record text, so
		// it did not close a record and must not create a signature.
		expect(index.signatures[fingerprintFor(35)]).toBeUndefined();
	});

	it("never evicts an unreported signature and records an overflow marker instead", async () => {
		const paths = await tempPaths();
		for (let seed = 1; seed <= CRASH_INDEX_MAX_SIGNATURES; seed++)
			appendCrashEvent(occurrence(fingerprintFor(seed), recordId(seed), NOW - seed * 1000), paths.events);
		await compactCrashIndex({ paths, now: NOW });

		// One more distinct signature, plus a recurrence of an old, non-evicted one.
		appendCrashEvent(occurrence(fingerprintFor(9999), recordId(9999)), paths.events);
		appendCrashEvent(occurrence(fingerprintFor(7), recordId(7777)), paths.events);
		const index = await compactCrashIndex({ paths, now: NOW });

		expect(index.overflow).toBe(true);
		expect(Object.keys(index.signatures)).toHaveLength(CRASH_INDEX_MAX_SIGNATURES);
		expect(index.signatures[fingerprintFor(9999)]).toBeUndefined();
		expect(index.signatures[fingerprintFor(7)]?.lifetimeCount).toBe(2);
	});

	it("evicts a reported signature to make room for a new one", async () => {
		const paths = await tempPaths();
		for (let seed = 1; seed <= CRASH_INDEX_MAX_SIGNATURES; seed++)
			appendCrashEvent(occurrence(fingerprintFor(seed), recordId(seed), NOW - seed * 1000), paths.events);
		await compactCrashIndex({ paths, now: NOW });
		await recordCrashStateEvent(
			{
				kind: "reported",
				fingerprint: fingerprintFor(5),
				at: NOW,
				issueUrl: "https://github.com/Yeachan-Heo/gajae-code/issues/1",
			},
			{ paths, now: NOW },
		);

		appendCrashEvent(occurrence(fingerprintFor(9999), recordId(9999)), paths.events);
		const index = await compactCrashIndex({ paths, now: NOW });
		expect(index.signatures[fingerprintFor(9999)]).toBeDefined();
		expect(index.signatures[fingerprintFor(5)]).toBeUndefined();
		expect(index.overflow).toBe(false);
	});

	it("uses the production clock when no compaction time is injected", async () => {
		const paths = await tempPaths();
		const future = Date.now() + 2 * 24 * 60 * 60 * 1000;
		appendCrashEvent(occurrence(fingerprintFor(8), recordId(8), future - 1000), paths.events);
		const index = await recordCrashStateEvent(
			{ kind: "acknowledged", fingerprint: fingerprintFor(8), at: future },
			{ paths },
		);

		expect(index.signatures[fingerprintFor(8)]).toBeUndefined();
	});

	it("preserves an injected event time when the caller also injects compaction time", async () => {
		const paths = await tempPaths();
		const future = Date.now() + 2 * 24 * 60 * 60 * 1000;
		appendCrashEvent(occurrence(fingerprintFor(9), recordId(9), future - 1000), paths.events);
		const index = await recordCrashStateEvent(
			{ kind: "acknowledged", fingerprint: fingerprintFor(9), at: future },
			{ paths, now: future },
		);

		expect(index.signatures[fingerprintFor(9)]?.acknowledgedAt).toBe(future);
	});

	it("quarantines a hostile index and rebuilds from the journal", async () => {
		const paths = await tempPaths();
		await fs.mkdir(path.dirname(paths.index), { recursive: true });
		await fs.writeFile(
			paths.index,
			JSON.stringify({
				version: 1,
				updatedAt: NOW,
				lastNudgedAt: 0,
				overflow: false,
				recentEventIds: [],
				signatures: {
					[fingerprintFor(4)]: {
						fpv: 1,
						errorName: "Error",
						messageClass: "x",
						lifetimeCount: Number.MAX_SAFE_INTEGER,
						retainedCount: 0,
						firstSeen: NOW,
						lastSeen: NOW + 10 * 365 * 24 * 60 * 60 * 1000,
						lastRecordId: recordId(4),
					},
				},
			}),
		);
		appendCrashEvent(occurrence(fingerprintFor(4), recordId(1)), paths.events);
		const index = await compactCrashIndex({ paths, now: NOW });

		expect(index.signatures[fingerprintFor(4)]?.lifetimeCount).toBe(1);
		const siblings = await fs.readdir(path.dirname(paths.index));
		expect(siblings.some(name => name.includes(".corrupt-"))).toBe(true);
	});

	it("shares state across a symlinked agent dir, exactly like the crash log", async () => {
		const paths = await tempPaths();
		const linkDir = `${path.dirname(paths.index)}-link`;
		await fs.symlink(path.dirname(paths.index), linkDir, "dir");
		const linked: CrashStatePaths = {
			index: path.join(linkDir, path.basename(paths.index)),
			events: path.join(linkDir, path.basename(paths.events)),
			crashLog: path.join(linkDir, path.basename(paths.crashLog)),
		};
		appendCrashEvent(occurrence(fingerprintFor(6), recordId(1)), paths.events);
		appendCrashEvent(occurrence(fingerprintFor(6), recordId(2)), linked.events);
		const index = await compactCrashIndex({ paths: linked, now: NOW });
		expect(index.signatures[fingerprintFor(6)]?.lifetimeCount).toBe(2);
		expect((await readCrashIndex(paths)).signatures[fingerprintFor(6)]?.lifetimeCount).toBe(2);
	});
});

describe("parseCrashIndex", () => {
	const valid = {
		version: 1,
		updatedAt: NOW,
		lastNudgedAt: 0,
		overflow: false,
		recentEventIds: [recordId(1)],
		signatures: {
			[fingerprintFor(1)]: {
				fpv: 1,
				errorName: "Error",
				messageClass: "boom",
				lifetimeCount: 2,
				retainedCount: 1,
				firstSeen: NOW - 1000,
				lastSeen: NOW,
				lastRecordId: recordId(1),
			},
		},
	};

	it("accepts a well-formed index", () => {
		expect(parseCrashIndex(JSON.stringify(valid), NOW)?.signatures[fingerprintFor(1)]?.lifetimeCount).toBe(2);
	});

	it("accepts fingerprint-scoped occurrence ids while preserving legacy ids", () => {
		const scoped = {
			...valid,
			recentEventIds: [recordId(1), `${fingerprintFor(1)}:${recordId(2)}`],
		};
		expect(parseCrashIndex(JSON.stringify(scoped), NOW)?.recentEventIds).toEqual(scoped.recentEventIds);
	});

	it("does not let a legacy unscoped id suppress a different fingerprint", async () => {
		const paths = await tempPaths();
		const sharedId = recordId(3);
		await fs.writeFile(
			paths.index,
			JSON.stringify({
				...valid,
				recentEventIds: [sharedId],
			}),
		);
		await fs.writeFile(paths.crashLog, logRecord(2, 3, "2026-08-11T12:00:00.000Z"));

		const index = await compactCrashIndex({ paths, now: NOW });

		expect(index.signatures[fingerprintFor(2)]?.lifetimeCount).toBe(1);
	});

	it("does not let a legacy unscoped id suppress an existing different fingerprint", async () => {
		const paths = await tempPaths();
		const sharedId = recordId(4);
		await fs.writeFile(
			paths.index,
			JSON.stringify({
				...valid,
				recentEventIds: [sharedId],
				signatures: {
					...valid.signatures,
					[fingerprintFor(2)]: {
						...valid.signatures[fingerprintFor(1)],
						lastRecordId: recordId(5),
					},
				},
			}),
		);
		appendCrashEvent(occurrence(fingerprintFor(2), sharedId), paths.events);

		const index = await compactCrashIndex({ paths, now: NOW });

		expect(index.signatures[fingerprintFor(2)]?.lifetimeCount).toBe(3);
	});

	it.each([
		["unknown top-level key", { ...valid, extra: 1 }],
		[
			"unknown entry key",
			{ ...valid, signatures: { [fingerprintFor(1)]: { ...valid.signatures[fingerprintFor(1)], evil: 1 } } },
		],
		["bad fingerprint alphabet", { ...valid, signatures: { ZZZ: valid.signatures[fingerprintFor(1)] } }],
		[
			"future timestamp",
			{
				...valid,
				signatures: { [fingerprintFor(1)]: { ...valid.signatures[fingerprintFor(1)], lastSeen: NOW + 1e12 } },
			},
		],
		[
			"negative count",
			{
				...valid,
				signatures: { [fingerprintFor(1)]: { ...valid.signatures[fingerprintFor(1)], lifetimeCount: -1 } },
			},
		],
		[
			"retained above lifetime",
			{
				...valid,
				signatures: { [fingerprintFor(1)]: { ...valid.signatures[fingerprintFor(1)], retainedCount: 99 } },
			},
		],
		[
			"control characters",
			{
				...valid,
				signatures: { [fingerprintFor(1)]: { ...valid.signatures[fingerprintFor(1)], messageClass: "a\u0000b" } },
			},
		],
	])("rejects %s", (_label, hostile) => {
		expect(parseCrashIndex(JSON.stringify(hostile), NOW)).toBeUndefined();
	});

	it("refuses prototype-polluting keys", () => {
		const raw = `{"version":1,"updatedAt":${NOW},"lastNudgedAt":0,"overflow":false,"recentEventIds":[],"signatures":{},"__proto__":{"polluted":true}}`;
		const parsed = parseCrashIndex(raw, NOW);
		expect(parsed).toBeDefined();
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(Object.getPrototypeOf(parsed?.signatures ?? {})).toBeNull();
	});
});

describe("listCrashSignatures", () => {
	it("orders signatures newest-first", async () => {
		const paths = await tempPaths();
		appendCrashEvent(occurrence(fingerprintFor(10), recordId(1), NOW - 5000), paths.events);
		appendCrashEvent(occurrence(fingerprintFor(11), recordId(2), NOW), paths.events);
		const index = await compactCrashIndex({ paths, now: NOW });
		expect(listCrashSignatures(index).map(signature => signature.fingerprint)).toEqual([
			fingerprintFor(11),
			fingerprintFor(10),
		]);
	});
});
