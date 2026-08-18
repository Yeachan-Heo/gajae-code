import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendCrashEvent,
	type CrashOccurrenceEvent,
	computeCrashFingerprint,
	formatCrashEventLine,
	formatCrashRecordMarker,
	parseCrashEventLine,
} from "@gajae-code/utils";
import {
	applyCrashEvent,
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

function occurrence(fingerprint: string, recordId: string, at = NOW): CrashOccurrenceEvent {
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

function recoverableRecord(
	seed: number,
	message = `recovered crash ${seed}`,
	at = "2026-08-11T12:00:00.000Z",
): { fingerprint: string; recordId: string; text: string } {
	const id = recordId(seed);
	const headline = `Error: ${message}`;
	const stack = `${headline}\n    at recovered (packages/coding-agent/src/crash/recovery.ts:1:1)`;
	const fingerprint = computeCrashFingerprint(
		{ name: "Error", message, stack },
		{ installRoot: process.cwd() },
	).fingerprint;
	return {
		fingerprint,
		recordId: id,
		text:
			`${at} pid=1 [Uncaught Exception] ${headline}\n` +
			`${stack}\n${formatCrashRecordMarker(fingerprint, 1, id)}\n\n`,
	};
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

	it("deduplicates a replayed rotated journal containing more than the recent id window", async () => {
		const paths = await tempPaths();
		const rotated = `${paths.events}.compacting-replay`;
		for (let seed = 0; seed < 300; seed++)
			appendCrashEvent(occurrence(fingerprintFor(40), recordId(40_000 + seed)), rotated);
		const first = await compactCrashIndex({ paths, now: NOW });
		expect(first.signatures[fingerprintFor(40)]?.lifetimeCount).toBe(300);
		// Simulate publish-before-delete by recreating the exact rotated batch.
		const journal = Array.from({ length: 300 }, (_, seed) => occurrence(fingerprintFor(40), recordId(40_000 + seed)));
		for (const event of journal) appendCrashEvent(event, rotated);
		const replayed = await compactCrashIndex({ paths, now: NOW });
		expect(replayed.signatures[fingerprintFor(40)]?.lifetimeCount).toBe(300);
	});

	it("recovers a complete fingerprint-bound v1 record when its journal append was lost", async () => {
		const paths = await tempPaths();
		const recovered = recoverableRecord(200);
		await fs.writeFile(paths.crashLog, recovered.text);

		const index = await compactCrashIndex({ paths, now: NOW });
		expect(index.signatures[recovered.fingerprint]).toMatchObject({
			lifetimeCount: 1,
			retainedCount: 1,
			lastRecordId: recovered.recordId,
		});
		expect(index.signatures[recovered.fingerprint]?.reportedAt).toBeUndefined();
		expect(index.signatures[recovered.fingerprint]?.acknowledgedAt).toBeUndefined();
	});

	it("deduplicates every delayed journal event for more than 256 recovered records", async () => {
		const paths = await tempPaths();
		const records = Array.from({ length: 300 }, (_, seed) =>
			recoverableRecord(50_000 + seed, "delayed journal batch"),
		);
		await fs.writeFile(paths.crashLog, records.map(record => record.text).join(""));
		const recovered = await compactCrashIndex({ paths, now: NOW });
		expect(recovered.signatures[records[0]?.fingerprint ?? ""]?.lifetimeCount).toBe(300);
		for (const record of records)
			appendCrashEvent(occurrence(record.fingerprint, record.recordId, NOW), paths.events);
		const merged = await compactCrashIndex({ paths, now: NOW });
		expect(merged.signatures[records[0]?.fingerprint ?? ""]?.lifetimeCount).toBe(300);
	});

	it("deduplicates recovered record ids and keeps repeated compaction idempotent", async () => {
		const paths = await tempPaths();
		const recovered = recoverableRecord(201);
		await fs.writeFile(paths.crashLog, recovered.text + recovered.text);

		const first = await compactCrashIndex({ paths, now: NOW });
		const second = await compactCrashIndex({ paths, now: NOW });
		expect(first.signatures[recovered.fingerprint]?.lifetimeCount).toBe(1);
		expect(second.signatures[recovered.fingerprint]?.lifetimeCount).toBe(1);
		expect(second.signatures[recovered.fingerprint]?.retainedCount).toBe(1);
	});

	it("derives recovered first and last seen from out-of-order multi-process timestamps", async () => {
		const paths = await tempPaths();
		const newer = recoverableRecord(204, "out of order", "2026-08-11T13:00:00.000Z");
		const older = recoverableRecord(205, "out of order", "2026-08-11T11:00:00.000Z");
		expect(older.fingerprint).toBe(newer.fingerprint);
		await fs.writeFile(paths.crashLog, newer.text + older.text);

		const index = await compactCrashIndex({ paths, now: NOW });
		expect(index.signatures[newer.fingerprint]?.firstSeen).toBe(Date.parse("2026-08-11T11:00:00.000Z"));
		expect(index.signatures[newer.fingerprint]?.lastSeen).toBe(Date.parse("2026-08-11T13:00:00.000Z"));
		expect(parseCrashIndex(await fs.readFile(paths.index, "utf8"), NOW)).toBeDefined();
	});

	it("recovers from the log after compaction drained the journal and a later index is quarantined", async () => {
		const paths = await tempPaths();
		const recovered = recoverableRecord(202);
		appendCrashEvent(occurrence(recovered.fingerprint, recovered.recordId), paths.events);
		await fs.writeFile(paths.crashLog, recovered.text);
		await compactCrashIndex({ paths, now: NOW });
		await fs.writeFile(paths.index, "not-json");

		const rebuilt = await compactCrashIndex({ paths, now: NOW });
		expect(rebuilt.signatures[recovered.fingerprint]?.lifetimeCount).toBe(1);
		expect(rebuilt.signatures[recovered.fingerprint]?.retainedCount).toBe(1);
	});

	it("does not revive a reported signature after it is evicted", async () => {
		const paths = await tempPaths();
		const retired = recoverableRecord(203);
		await fs.writeFile(paths.crashLog, retired.text);
		appendCrashEvent(occurrence(retired.fingerprint, retired.recordId, NOW - 1_000_000), paths.events);
		for (let seed = 1; seed < CRASH_INDEX_MAX_SIGNATURES; seed++)
			appendCrashEvent(occurrence(fingerprintFor(seed), recordId(seed), NOW - seed), paths.events);
		await compactCrashIndex({ paths, now: NOW });
		await recordCrashStateEvent(
			{
				kind: "reported",
				fingerprint: retired.fingerprint,
				at: NOW,
				issueUrl: "https://github.com/Yeachan-Heo/gajae-code/issues/1",
			},
			{ paths, now: NOW },
		);
		appendCrashEvent(occurrence(fingerprintFor(9999), recordId(9999), NOW), paths.events);

		const evicted = await compactCrashIndex({ paths, now: NOW });
		expect(evicted.signatures[retired.fingerprint]).toBeUndefined();
		expect(evicted.retiredFingerprints).toContain(retired.fingerprint);
		const again = await compactCrashIndex({ paths, now: NOW });
		expect(again.signatures[retired.fingerprint]).toBeUndefined();
		await fs.writeFile(paths.index, "not-json");
		const rebuilt = await compactCrashIndex({ paths, now: NOW });
		expect(rebuilt.signatures[retired.fingerprint]).toBeUndefined();
		expect(rebuilt.retiredFingerprints).toContain(retired.fingerprint);
	});

	it("preserves retirement when the crash log exists but cannot be read as a regular file", async () => {
		const paths = await tempPaths();
		await fs.mkdir(paths.crashLog);
		await fs.writeFile(
			`${paths.index}.retired`,
			`${JSON.stringify({ version: 1, fingerprints: [fingerprintFor(204)] })}\n`,
		);
		const index = await compactCrashIndex({ paths, now: NOW });
		expect(index.retiredFingerprints).toContain(fingerprintFor(204));
	});

	it("fails closed when the retirement sidecar exists but is unreadable", async () => {
		const paths = await tempPaths();
		await fs.mkdir(`${paths.index}.retired`);
		await expect(compactCrashIndex({ paths, now: NOW })).rejects.toThrow("Crash retirement ledger is unreadable");
	});

	it("keeps latest journal record metadata by timestamp rather than append order", async () => {
		const paths = await tempPaths();
		appendCrashEvent({ ...occurrence(fingerprintFor(41), recordId(410), NOW), messageClass: "newest" }, paths.events);
		appendCrashEvent(
			{ ...occurrence(fingerprintFor(41), recordId(411), NOW - 1000), messageClass: "older" },
			paths.events,
		);
		const index = await compactCrashIndex({ paths, now: NOW });
		expect(index.signatures[fingerprintFor(41)]?.lastSeen).toBe(NOW);
		expect(index.signatures[fingerprintFor(41)]?.lastRecordId).toBe(recordId(410));
		expect(index.signatures[fingerprintFor(41)]?.messageClass).toBe("newest");
	});

	it("supersedes retirement when a new journal occurrence revives the signature", async () => {
		const paths = await tempPaths();
		const retired = recoverableRecord(206, "journal revival", "2026-08-11T11:00:00.000Z");
		await fs.writeFile(paths.crashLog, retired.text);
		appendCrashEvent(occurrence(retired.fingerprint, retired.recordId, NOW - 1_000_000), paths.events);
		for (let seed = 1; seed < CRASH_INDEX_MAX_SIGNATURES; seed++)
			appendCrashEvent(occurrence(fingerprintFor(seed), recordId(seed), NOW - seed), paths.events);
		await compactCrashIndex({ paths, now: NOW });
		await recordCrashStateEvent(
			{
				kind: "reported",
				fingerprint: retired.fingerprint,
				at: NOW,
				issueUrl: "https://github.com/Yeachan-Heo/gajae-code/issues/1",
			},
			{ paths, now: NOW },
		);
		appendCrashEvent(occurrence(fingerprintFor(9999), recordId(9999), NOW), paths.events);
		await compactCrashIndex({ paths, now: NOW });
		await recordCrashStateEvent(
			{ kind: "acknowledged", fingerprint: fingerprintFor(1), at: NOW },
			{ paths, now: NOW },
		);

		const revived = recoverableRecord(207, "journal revival", "2026-08-11T13:00:00.000Z");
		appendCrashEvent(occurrence(revived.fingerprint, revived.recordId, NOW), paths.events);
		await fs.writeFile(paths.crashLog, revived.text);
		const active = await compactCrashIndex({ paths, now: NOW });
		expect(active.signatures[revived.fingerprint]).toBeDefined();
		expect(active.retiredFingerprints).not.toContain(revived.fingerprint);
		await fs.writeFile(paths.index, "not-json");
		const rebuilt = await compactCrashIndex({ paths, now: NOW });
		expect(rebuilt.signatures[revived.fingerprint]).toBeDefined();
	});

	it("replayed revival clears a stale retirement sidecar before occurrence-id deduplication", async () => {
		const paths = await tempPaths();
		const revived = recoverableRecord(208, "interrupted revival", "2026-08-11T13:00:00.000Z");
		appendCrashEvent(occurrence(revived.fingerprint, revived.recordId, NOW), paths.events);
		await fs.writeFile(paths.crashLog, revived.text);
		const active = await compactCrashIndex({ paths, now: NOW });
		expect(active.signatures[revived.fingerprint]).toBeDefined();

		// Simulate a crash after the main index published the occurrence id but
		// before the retirement sidecar replacement removed its stale tombstone.
		await fs.writeFile(
			`${paths.index}.retired`,
			`${JSON.stringify({ version: 1, fingerprints: [revived.fingerprint] })}\n`,
		);
		appendCrashEvent(occurrence(revived.fingerprint, revived.recordId, NOW), paths.events);
		const replayed = await compactCrashIndex({ paths, now: NOW });
		expect(replayed.retiredFingerprints).not.toContain(revived.fingerprint);
		await fs.writeFile(paths.index, "not-json");
		const rebuilt = await compactCrashIndex({ paths, now: NOW });
		expect(rebuilt.signatures[revived.fingerprint]).toBeDefined();
	});

	it("prunes retired signatures with no retained record so sequential retirements never exhaust eviction", async () => {
		const paths = await tempPaths();
		for (let seed = 1; seed <= CRASH_INDEX_MAX_SIGNATURES; seed++)
			appendCrashEvent(occurrence(fingerprintFor(seed), recordId(seed), NOW - seed), paths.events);
		await compactCrashIndex({ paths, now: NOW });
		for (let seed = 1; seed <= CRASH_INDEX_MAX_SIGNATURES; seed++) {
			await recordCrashStateEvent(
				{ kind: "acknowledged", fingerprint: fingerprintFor(seed), at: NOW },
				{ paths, now: NOW },
			);
		}
		await fs.writeFile(paths.crashLog, "");
		for (let round = 0; round <= CRASH_INDEX_MAX_SIGNATURES; round++) {
			const fingerprint = fingerprintFor(900_000 + round);
			appendCrashEvent(occurrence(fingerprint, recordId(900_000 + round), NOW), paths.events);
			const evicted = await compactCrashIndex({ paths, now: NOW });
			expect(evicted.signatures[fingerprint]).toBeDefined();
			await recordCrashStateEvent({ kind: "acknowledged", fingerprint, at: NOW }, { paths, now: NOW });
		}
		const finalIndex = await compactCrashIndex({ paths, now: NOW });
		expect(finalIndex.retiredFingerprints.length).toBeLessThanOrEqual(1);
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

	it("does not count a duplicate retained record id twice for an existing signature", async () => {
		const paths = await tempPaths();
		appendCrashEvent(occurrence(fingerprintFor(30), recordId(30)), paths.events);
		appendCrashEvent(occurrence(fingerprintFor(30), recordId(31)), paths.events);
		const marker = formatCrashRecordMarker(fingerprintFor(30), 1, recordId(30));
		await fs.writeFile(
			paths.crashLog,
			`2026-08-11T12:00:00.000Z pid=1 [Uncaught Exception] Error: x\n${marker}\n\n` +
				`2026-08-11T12:00:00.000Z pid=1 [Uncaught Exception] Error: x\n${marker}\n\n`,
		);
		const index = await compactCrashIndex({ paths, now: NOW });
		expect(index.signatures[fingerprintFor(30)]?.lifetimeCount).toBe(2);
		expect(index.signatures[fingerprintFor(30)]?.retainedCount).toBe(1);
	});

	it("writes an index its own reader accepts when the log holds more records than the journal counted", async () => {
		const paths = await tempPaths();
		// A fatal whose journal append failed — or that spent the per-process latch —
		// still writes its crash-log record, so the log can name a signature more
		// times than the journal counted it.
		appendCrashEvent(occurrence(fingerprintFor(20), recordId(20)), paths.events);
		await fs.writeFile(
			paths.crashLog,
			`2026-08-11T12:00:00.000Z pid=1 [Uncaught Exception] Error: x\n${formatCrashRecordMarker(fingerprintFor(20), 1, recordId(20))}\n\n` +
				`2026-08-11T12:30:00.000Z pid=1 [Uncaught Exception] Error: x\n${formatCrashRecordMarker(fingerprintFor(20), 1, recordId(21))}\n\n` +
				`2026-08-11T13:00:00.000Z pid=1 [Uncaught Exception] Error: x\n${formatCrashRecordMarker(fingerprintFor(20), 1, recordId(22))}\n\n`,
		);
		const index = await compactCrashIndex({ paths, now: NOW });

		expect(index.signatures[fingerprintFor(20)]?.retainedCount).toBe(1);
		// `parseEntry` rejects a retained count above the lifetime count, so emitting
		// one quarantines the whole index — every signature in it — on the next read.
		expect(parseCrashIndex(await fs.readFile(paths.index, "utf8"), NOW)).toBeDefined();
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
		recentJournalDigests: [],
		recoveredRecordIds: [],
		retiredFingerprints: [],
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

describe("relayed crash events", () => {
	const fingerprint = fingerprintFor(70);
	const eventId = "0123456789abcdef0123456789abcdef";

	it("round-trips all relayed fields through the journal format", () => {
		const recordId = "1".repeat(16);
		const line = formatCrashEventLine({ kind: "relayed", fingerprint, at: NOW, eventId, recordId });

		expect(parseCrashEventLine(line)).toEqual({ kind: "relayed", fingerprint, at: NOW, eventId, recordId });
	});

	it.each([
		["wrong length", "0123456789abcdef0123456789abcde"],
		["uppercase hex", "0123456789ABCDEF0123456789ABCDEF"],
		["non-hex", "0123456789abcdef0123456789abcdeg"],
	])("rejects a relayed event id with %s", (_label, malformedEventId) => {
		const line = `${"gjc-crash-event.v1"} ${JSON.stringify({ k: "relayed", fp: fingerprint, at: NOW, e: malformedEventId })}\n`;

		expect(parseCrashEventLine(line)).toBeUndefined();
	});

	it("records relays monotonically for an existing signature", () => {
		const index = parseCrashIndex(
			JSON.stringify({
				version: 1,
				updatedAt: NOW,
				lastNudgedAt: 0,
				overflow: false,
				recentEventIds: [],
				signatures: {
					[fingerprint]: {
						fpv: 1,
						errorName: "Error",
						messageClass: "boom",
						lifetimeCount: 1,
						retainedCount: 0,
						firstSeen: NOW,
						lastSeen: NOW,
						lastRecordId: recordId(70),
					},
				},
			}),
			NOW,
		);
		expect(index).toBeDefined();
		if (!index) return;

		const relay = { kind: "relayed" as const, fingerprint, at: NOW, eventId, recordId: recordId(1) };
		expect(applyCrashEvent(index, relay, NOW)).toBe(true);
		expect(index.signatures[fingerprint]?.relayedAt).toBe(NOW);
		expect(applyCrashEvent(index, relay, NOW)).toBe(false);
		expect(applyCrashEvent(index, { ...relay, at: NOW - 1 }, NOW)).toBe(false);
		expect(index.signatures[fingerprint]?.relayedAt).toBe(NOW);
	});

	it("does not create a signature for an unknown relay", () => {
		const index = parseCrashIndex(
			JSON.stringify({
				version: 1,
				updatedAt: NOW,
				lastNudgedAt: 0,
				overflow: false,
				recentEventIds: [],
				signatures: {},
			}),
			NOW,
		);
		expect(index).toBeDefined();
		if (!index) return;

		expect(
			applyCrashEvent(index, { kind: "relayed", fingerprint, at: NOW, eventId, recordId: recordId(1) }, NOW),
		).toBe(false);
		expect(index.signatures[fingerprint]).toBeUndefined();
	});

	it("accepts relayedAt and rejects an out-of-range value in the index", () => {
		const entry = {
			fpv: 1,
			errorName: "Error",
			messageClass: "boom",
			lifetimeCount: 1,
			retainedCount: 0,
			firstSeen: NOW,
			lastSeen: NOW,
			lastRecordId: recordId(71),
			relayedAt: NOW,
		};
		const valid = {
			version: 1,
			updatedAt: NOW,
			lastNudgedAt: 0,
			overflow: false,
			recentEventIds: [],
			signatures: { [fingerprint]: entry },
		};

		expect(parseCrashIndex(JSON.stringify(valid), NOW)?.signatures[fingerprint]?.relayedAt).toBe(NOW);
		expect(
			parseCrashIndex(
				JSON.stringify({
					...valid,
					signatures: { [fingerprint]: { ...entry, relayedAt: NOW + 1e12 } },
				}),
				NOW,
			),
		).toBeUndefined();
	});
});
