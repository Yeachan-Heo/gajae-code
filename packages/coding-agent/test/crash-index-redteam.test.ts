import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendCrashEvent, type CrashEvent, formatCrashRecordMarker } from "@gajae-code/utils";
import {
	CRASH_INDEX_MAX_BYTES,
	CRASH_INDEX_MAX_SIGNATURES,
	type CrashStatePaths,
	compactCrashIndex,
	parseCrashIndex,
	readCrashIndex,
	recordCrashStateEvent,
} from "../src/crash/index-store";

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0);
const ISO = new Date(NOW).toISOString();

function fingerprintFor(seed: number): string {
	return seed.toString(16).padStart(32, "0");
}

function recordId(seed: number): string {
	return seed.toString(16).padStart(16, "0");
}

async function tempPaths(): Promise<CrashStatePaths> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-crash-redteam-"));
	return {
		index: path.join(dir, "gjc-crash-index.json"),
		events: path.join(dir, "gjc-crash-events.jsonl"),
		crashLog: path.join(dir, "gjc-crash.log"),
	};
}

function occurrence(fingerprint: string, id: string, messageClass = "shared topic authority unavailable"): CrashEvent {
	return {
		kind: "occurrence",
		fingerprint,
		fpv: 1,
		recordId: id,
		at: NOW,
		errorName: "Error",
		messageClass,
	};
}

function logRecord(seed: number, id: number, iso = ISO, message = "shared topic authority unavailable"): string {
	return (
		`${iso} pid=1 [Uncaught Exception] Error: ${message}\n` +
		`    at <anonymous> (telegram-daemon.ts:1:1)\n` +
		`${formatCrashRecordMarker(fingerprintFor(seed), 1, recordId(id))}\n\n`
	);
}

/**
 * Drive `count` report-and-evict cycles with every record kept in the crash log,
 * so eviction has no unretained victim to prefer and the dismissal list fills.
 */
async function fillDismissed(paths: CrashStatePaths, seedBase: number, count: number): Promise<void> {
	let next = seedBase;
	for (let i = 0; i < count; i++) {
		const seed = seedBase + i;
		await fs.appendFile(paths.crashLog, logRecord(seed, ++next), "utf8");
		appendCrashEvent(occurrence(fingerprintFor(seed), recordId(next)), paths.events);
		await compactCrashIndex({ paths, now: NOW });
		await recordCrashStateEvent(
			{ kind: "reported", fingerprint: fingerprintFor(seed), at: NOW, issueUrl: "https://example.invalid/x" },
			{ paths, now: NOW },
		);
	}
}

describe("crash index adoption — adversarial", () => {
	it("keeps a filed signature filed across far more evictions than the dismissal list holds", async () => {
		// Attack: `dismissed` is a bounded FIFO. File a signature, evict it, then run
		// enough further report-and-evict cycles to age its dismissal out while the
		// crash log still names its record. If the dismissal is dropped early,
		// adoption recreates the signature without the `reportedAt` that made it
		// evictable and the user is asked to file a crash they already filed.
		//
		// This reproduced before `pruneDismissed`: at 400 cycles the victim was
		// resurrected with `reportedAt: undefined`.
		const paths = await tempPaths();
		const victim = fingerprintFor(0x5eed);
		const cycles = 400;
		await fs.writeFile(paths.crashLog, logRecord(0x5eed, 1), "utf8");
		appendCrashEvent(occurrence(victim, recordId(1)), paths.events);
		await compactCrashIndex({ paths, now: NOW });
		await recordCrashStateEvent(
			{ kind: "reported", fingerprint: victim, at: NOW, issueUrl: "https://example.invalid/1" },
			{ paths, now: NOW },
		);

		// The log keeps naming every signature, so no dismissal can be pruned as
		// unreachable; only the cap can drop one.
		await fillDismissed(paths, 0x10000, cycles);
		expect(cycles).toBeGreaterThan(CRASH_INDEX_MAX_SIGNATURES);

		const index = await compactCrashIndex({ paths, now: NOW });
		// Either it is still tracked as filed, or it is dismissed. What it must never
		// be is present and unreported.
		expect(index.signatures[victim]?.reportedAt ?? index.dismissed.includes(victim)).toBeTruthy();
		expect(Buffer.byteLength(await fs.readFile(paths.index, "utf8"), "utf8")).toBeLessThanOrEqual(
			CRASH_INDEX_MAX_BYTES,
		);
	});

	it("evicts a signature the log no longer names before one it still names", async () => {
		// The bound is only sound because a dismissal that can never be acted on is
		// not created in the first place: a signature whose records have rotated away
		// cannot be adopted back, so it is the cheaper victim.
		const paths = await tempPaths();
		const retained = fingerprintFor(0x8888);
		await fs.writeFile(paths.crashLog, logRecord(0x8888, 31), "utf8");
		appendCrashEvent(occurrence(retained, recordId(31)), paths.events);
		await compactCrashIndex({ paths, now: NOW });
		await recordCrashStateEvent(
			{ kind: "reported", fingerprint: retained, at: NOW, issueUrl: "https://example.invalid/8" },
			{ paths, now: NOW },
		);

		// Signatures with no records in the log, pushing the index past capacity.
		let next = 100;
		for (let i = 0; i < CRASH_INDEX_MAX_SIGNATURES + 2; i++) {
			const fp = fingerprintFor(0x40000 + i);
			appendCrashEvent(occurrence(fp, recordId(++next)), paths.events);
			await compactCrashIndex({ paths, now: NOW });
			await recordCrashStateEvent(
				{ kind: "reported", fingerprint: fp, at: NOW, issueUrl: "https://example.invalid/z" },
				{ paths, now: NOW },
			);
		}

		const index = await readCrashIndex(paths);
		// The retained signature was not the victim, so it is still filed rather than
		// living on as a dismissal slot.
		expect(index.signatures[retained]?.reportedAt).toBeDefined();
		// And the dismissals that were created name records the log no longer holds,
		// so pruning has released them.
		expect(index.dismissed).toEqual([]);
	});

	it("releases a dismissal only once the crash log stops naming it", async () => {
		const paths = await tempPaths();
		await fillDismissed(paths, 0x60000, CRASH_INDEX_MAX_SIGNATURES + 8);
		const before = await readCrashIndex(paths);
		expect(before.dismissed.length).toBeGreaterThan(0);

		// Nothing changed, so nothing may be released.
		expect((await compactCrashIndex({ paths, now: NOW })).dismissed).toEqual(before.dismissed);

		// The log rotates; every dismissal it justified is released.
		await fs.writeFile(paths.crashLog, "", "utf8");
		expect((await compactCrashIndex({ paths, now: NOW })).dismissed).toEqual([]);
	});

	it("keeps every dismissal when the crash log cannot be read at all", async () => {
		// A missing log must read as "unknown", not as "names nothing": pruning on it
		// would discard the whole list on a transient read failure and re-offer every
		// crash it was protecting.
		const paths = await tempPaths();
		await fillDismissed(paths, 0x70000, CRASH_INDEX_MAX_SIGNATURES + 8);
		const before = await readCrashIndex(paths);
		expect(before.dismissed.length).toBeGreaterThan(0);

		await fs.rm(paths.crashLog);
		expect((await compactCrashIndex({ paths, now: NOW })).dismissed).toEqual(before.dismissed);
	});

	it("converges and stays parseable when eviction has to shrink an oversized index", async () => {
		// Attack: every eviction appends to `dismissed`, so the shrink loop
		// `while (oversized && evictOne())` grows one field while shrinking another.
		// A non-converging loop would hang or write a file its own parser rejects.
		const paths = await tempPaths();
		const long = "x".repeat(400);
		for (let i = 0; i < CRASH_INDEX_MAX_SIGNATURES; i++) {
			const fp = fingerprintFor(0x20000 + i);
			appendCrashEvent(occurrence(fp, recordId(1000 + i), long), paths.events);
		}
		await compactCrashIndex({ paths, now: NOW });
		for (let i = 0; i < CRASH_INDEX_MAX_SIGNATURES; i++)
			await recordCrashStateEvent(
				{
					kind: "reported",
					fingerprint: fingerprintFor(0x20000 + i),
					at: NOW,
					issueUrl: `https://example.invalid/${"u".repeat(200)}`,
				},
				{ paths, now: NOW },
			);

		const written = await fs.readFile(paths.index, "utf8");
		expect(Buffer.byteLength(written, "utf8")).toBeLessThanOrEqual(CRASH_INDEX_MAX_BYTES);
		expect(parseCrashIndex(written, NOW)).toBeDefined();
	});

	it("does not let a tail-truncated crash log fabricate a signature", async () => {
		// Attack: the log is read tail-first with a byte cap, so the first record in
		// the window is cut. A cut that leaves an identity line without its header
		// must not be adopted as a crash of its own.
		const paths = await tempPaths();
		const full = logRecord(0x3333, 3);
		const cut = full.slice(full.indexOf("\n") + 1); // header gone, marker intact
		await fs.writeFile(paths.crashLog, cut, "utf8");
		const index = await compactCrashIndex({ paths, now: NOW });
		expect(index.signatures[fingerprintFor(0x3333)]).toBeUndefined();
	});

	it("keeps an adopted record deduped after later occurrences overwrite lastRecordId", async () => {
		// Attack: `adoptedRecordId` is the only lasting dedupe for the adopted
		// record. Push enough later occurrences to overwrite `lastRecordId` and to
		// age the adopted id out of the 256-entry window, then replay the adopted
		// record's journal event. It must not be counted a second time.
		const paths = await tempPaths();
		const fp = fingerprintFor(0x4444);
		await fs.writeFile(paths.crashLog, logRecord(0x4444, 7), "utf8");
		const adopted = await compactCrashIndex({ paths, now: NOW });
		expect(adopted.signatures[fp]?.lifetimeCount).toBe(1);

		for (let i = 0; i < 300; i++) appendCrashEvent(occurrence(fp, recordId(5000 + i)), paths.events);
		const grown = await compactCrashIndex({ paths, now: NOW });
		expect(grown.signatures[fp]?.lifetimeCount).toBe(301);

		appendCrashEvent(occurrence(fp, recordId(7)), paths.events);
		const replayed = await compactCrashIndex({ paths, now: NOW });
		expect(replayed.signatures[fp]?.lifetimeCount).toBe(301);
	});

	it("survives an index round trip carrying adoptedRecordId", async () => {
		const paths = await tempPaths();
		await fs.writeFile(paths.crashLog, logRecord(0x5555, 9), "utf8");
		await compactCrashIndex({ paths, now: NOW });
		const reread = await readCrashIndex(paths);
		expect(reread.signatures[fingerprintFor(0x5555)]?.adoptedRecordId).toBe(recordId(9));
	});

	it("still counts a journaled crash whose fingerprint sits in the dismissal list", async () => {
		// Attack: `dismissed` blocks adoption. It must not block the journal, or a
		// signature that crashes again after being filed becomes uncountable.
		const paths = await tempPaths();
		const fp = fingerprintFor(0x6666);
		appendCrashEvent(occurrence(fp, recordId(11)), paths.events);
		await compactCrashIndex({ paths, now: NOW });
		await recordCrashStateEvent(
			{ kind: "reported", fingerprint: fp, at: NOW, issueUrl: "https://example.invalid/6" },
			{ paths, now: NOW },
		);
		for (let i = 0; i < CRASH_INDEX_MAX_SIGNATURES + 4; i++) {
			appendCrashEvent(occurrence(fingerprintFor(0x30000 + i), recordId(2000 + i)), paths.events);
			await compactCrashIndex({ paths, now: NOW });
			await recordCrashStateEvent(
				{
					kind: "reported",
					fingerprint: fingerprintFor(0x30000 + i),
					at: NOW,
					issueUrl: "https://example.invalid/y",
				},
				{ paths, now: NOW },
			);
		}
		expect((await readCrashIndex(paths)).signatures[fp]).toBeUndefined();

		appendCrashEvent(occurrence(fp, recordId(12)), paths.events);
		const after = await compactCrashIndex({ paths, now: NOW });
		expect(after.signatures[fp]?.lifetimeCount).toBe(1);
	});

	it("caps retained at the journaled lifetime when the log holds more records than the journal counted", async () => {
		const paths = await tempPaths();
		const fp = fingerprintFor(0x7777);
		appendCrashEvent(occurrence(fp, recordId(21)), paths.events);
		await compactCrashIndex({ paths, now: NOW });
		await fs.writeFile(paths.crashLog, logRecord(0x7777, 21) + logRecord(0x7777, 22) + logRecord(0x7777, 23), "utf8");
		const index = await compactCrashIndex({ paths, now: NOW });
		const entry = index.signatures[fp];
		expect(entry?.retainedCount).toBeLessThanOrEqual(entry?.lifetimeCount ?? 0);
		expect(parseCrashIndex(await fs.readFile(paths.index, "utf8"), NOW)).toBeDefined();
	});
});
