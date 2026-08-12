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
